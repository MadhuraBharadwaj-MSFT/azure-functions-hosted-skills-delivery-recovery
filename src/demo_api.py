import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import random
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path

import azure.functions as func
from azurefunctions.extensions.http.fastapi import JSONResponse, Request
from azure.core.exceptions import AzureError, HttpResponseError, ResourceExistsError, ResourceNotFoundError
from azure.identity.aio import DefaultAzureCredential
from azure.servicebus import ServiceBusMessage
from azure.servicebus.aio import ServiceBusClient
from azure.storage.blob import ContentSettings
from azure.storage.blob.aio import BlobLeaseClient, BlobServiceClient
from jsonschema import Draft202012Validator
from message_tracking import EVENT_STAGES, STAGES, enabled as tracking_enabled

bp = func.Blueprint()
schema = Draft202012Validator(json.loads(Path(__file__).with_name("record-schema.json").read_text()))
RUN_ID = re.compile(r"^[a-f0-9]{32}$")
RUN_LIFETIME = timedelta(minutes=20)
SEND_TIMEOUT_SECONDS = 25


@lru_cache
def storage() -> BlobServiceClient:
    return BlobServiceClient(os.environ["DATA_STORAGE_BLOB_URL"], credential=DefaultAzureCredential())


def response(data: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(
        data, status_code=status,
        headers={"Cache-Control": "no-store"},
    )


def authorized(req: Request) -> bool:
    # The linked SWA backend's platform authentication verifies the proxy token.
    # Never expose this header-based check without that platform authentication.
    encoded = req.headers.get("x-ms-client-principal", "")
    try:
        principal = json.loads(base64.b64decode(encoded, validate=True))
    except (ValueError, binascii.Error, UnicodeDecodeError):
        logging.warning("demo_access_denied reason=%s", "invalid_principal" if encoded else "missing_principal")
        return False
    owner_id = os.environ.get("DEMO_OWNER_ID", "")
    if not isinstance(principal, dict):
        logging.warning("demo_access_denied reason=principal_not_object")
        return False
    # userDetails is display data and can be masked even when userId is unchanged.
    checks = {
        "owner_configured": bool(owner_id),
        "provider_matches": principal.get("identityProvider") == "aad",
        "id_matches": principal.get("userId") == owner_id,
    }
    if not all(checks.values()):
        logging.warning(
            "demo_access_denied checks=%s swa_format=%s claims_format=%s",
            json.dumps(checks), "userId" in principal, isinstance(principal.get("claims"), list),
        )
        return False
    return True


def manifest_blob(run_id: str):
    return storage().get_blob_client("demo-runs", f"{run_id}.json")


async def read_manifest(run_id: str) -> dict:
    return json.loads(await (await manifest_blob(run_id).download_blob()).readall())


async def write_manifest(run: dict, **kwargs) -> None:
    await manifest_blob(run["id"]).upload_blob(
        json.dumps(run, allow_nan=False), content_settings=ContentSettings(content_type="application/json"), **kwargs,
    )


def make_run(payload: dict) -> dict:
    run_id = payload.get("request_id", "")
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise ValueError("A request_id containing 32 lowercase hexadecimal characters is required.")
    mode = payload.get("mode")
    if mode not in ("single", "batch"):
        raise ValueError("Choose single or batch mode.")
    record = None
    source = "partner-feed"
    if mode == "single":
        record = payload.get("record")
        if not isinstance(record, dict):
            raise ValueError("The message must be a JSON object.")
        id_fields = [key for key in ("record_id", "recordId") if key in record]
        if len(id_fields) != 1:
            raise ValueError("Include exactly one record_id or recordId field. Its value is replaced with a fresh ID.")
        record = dict(record)
        record[id_fields[0]] = f"{run_id}-00000000"
        raw_source = record.get("source")
        if not isinstance(raw_source, str) or not 1 <= len(raw_source) <= 80 or not re.search(r"[A-Za-z0-9]", raw_source):
            raise ValueError("source must be 1-80 characters and contain a letter or digit.")
        source = re.sub(r"[^a-z0-9]+", "-", raw_source.lower()).strip("-")
    total = 1000 if mode == "batch" else 1
    bad_indices = sorted(random.sample(range(total), 5)) if mode == "batch" else ([0] if not schema.is_valid(record) else [])
    return {
        "id": run_id, "mode": mode, "total": total, "bad_indices": bad_indices,
        "source": source, "record": record,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dispatch_state": "pending", "sent": 0,
        "tracking_enabled": tracking_enabled(),
        "request_hash": hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest(),
    }


def record_at(run: dict, index: int) -> dict:
    if run["mode"] == "single":
        return run["record"]
    return {
        "recordId" if index in run["bad_indices"] else "record_id": f"{run['id']}-{index:08d}",
        "source": " Partner Feed ",
        "value": "21.5" if index in run["bad_indices"] else 21.5,
    }


async def progress(run: dict) -> dict:
    created = datetime.fromisoformat(run["created_at"])
    now = datetime.now(timezone.utc)
    # A live run lasts 20 minutes; include the next UTC day for midnight requeues.
    dates = {created.strftime("%Y/%m/%d"), (created + RUN_LIFETIME).strftime("%Y/%m/%d")}
    container = storage().get_container_client("processed-data")
    outputs = {}
    output_times = {}
    for day in sorted(dates):
        prefix = f"{run['source']}/{day}/{run['id']}-"
        async for blob in container.list_blobs(name_starts_with=prefix):
            record_id = blob.name.rsplit("/", 1)[-1].removesuffix(".json")
            suffix = record_id.removeprefix(run["id"] + "-")
            if re.fullmatch(r"\d{8}", suffix) and int(suffix) < run["total"]:
                outputs[record_id] = blob.name
                output_times[record_id] = blob.creation_time
    bad_ids = {f"{run['id']}-{index:08d}" for index in run["bad_indices"]}
    example_index = run["bad_indices"][0] if run["bad_indices"] else 0
    example_id = f"{run['id']}-{example_index:08d}"
    output = None
    if example_id in outputs:
        output = json.loads(await (await container.download_blob(outputs[example_id])).readall())
    complete = len(outputs) == run["total"]
    tracking = await flow_progress(run, outputs)
    return {
        "id": run["id"], "mode": run["mode"], "total": run["total"],
        "processed": len(outputs), "malformed": len(bad_ids), "recovered": len(bad_ids.intersection(outputs)),
        "created_at": run["created_at"], "dispatch_state": run["dispatch_state"], "sent": run["sent"],
        "dispatch_error": run.get("dispatch_error"),
        "complete": complete, "expired": now - created > RUN_LIFETIME,
        "completed_at": max(output_times.values()).isoformat() if complete else None,
        "tracking": tracking,
        "example": {"id": example_id, "input": record_at(run, example_index), "output": output},
    }


async def flow_progress(run: dict, outputs: dict) -> dict:
    states = [1 if index < run["sent"] else 0 for index in range(run["total"])]
    observations = [0] * run["total"]
    failure = None
    available = run.get("tracking_enabled", False)
    if available:
        try:
            async for blob in storage().get_container_client("demo-runs").list_blobs(
                name_starts_with=f"flow/{run['id']}/",
            ):
                parts = blob.name.split("/")
                if len(parts) != 5 or not re.fullmatch(r"\d{8}", parts[2]):
                    continue
                index = int(parts[2])
                code = EVENT_STAGES.get(parts[3])
                if index < run["total"] and code is not None:
                    states[index] = max(states[index], code)
                    observations[index] |= 1 << code
        except AzureError:
            logging.exception("message_tracking_read_failed run_id=%s", run["id"])
            failure = "Stage tracking could not be read. Only dispatch and output are confirmed."
            states = [1 if index < run["sent"] else 0 for index in range(run["total"])]
            observations = [0] * run["total"]
    for index in range(run["total"]):
        if f"{run['id']}-{index:08d}" in outputs:
            states[index] = 6
            observations[index] |= 1 << 6
    return {
        "enabled": available, "error": failure, "states": states, "stages": STAGES,
        "observations": observations,
        "bad_indices": run["bad_indices"], "observed_at": datetime.now(timezone.utc).isoformat(),
    }


@bp.route(route="demo/runs", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
async def submit_demo(req: Request) -> JSONResponse:
    if not authorized(req):
        return response({"error": "Sign in with the configured Microsoft demo-owner account."}, 403)
    if req.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        return response({"error": "Use application/json."}, 415)
    body = await req.body()
    if len(body) > 8192:
        return response({"error": "The request must be at most 8 KB."}, 413)
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("The request must be a JSON object.")
        run = make_run(payload)
    except (ValueError, TypeError) as exc:
        return response({"error": str(exc)}, 400)
    active = storage().get_blob_client("demo-runs", "active.json")
    try:
        await active.upload_blob("{}", overwrite=False)
    except ResourceExistsError:
        pass
    try:
        lease = await active.acquire_lease(lease_duration=60)
    except HttpResponseError as exc:
        if exc.status_code == 409:
            return response({"error": "Another submission is in progress. Retry in a few seconds."}, 409)
        raise
    try:
        try:
            existing = await read_manifest(run["id"])
        except ResourceNotFoundError:
            existing = None
        if existing:
            if existing["request_hash"] != run["request_hash"]:
                return response({"error": "This request ID was already used for different input."}, 409)
            if datetime.now(timezone.utc) - datetime.fromisoformat(existing["created_at"]) > RUN_LIFETIME:
                return response({"error": "This submission has expired. Start a new run."}, 410)
            run = existing
        else:
            current = json.loads(await (await active.download_blob()).readall())
            if current.get("id"):
                previous = await progress(await read_manifest(current["id"]))
                if not previous["complete"] and not previous["expired"]:
                    return response({"error": "A demo is already active. Follow that run before sending another.",
                                     "active_run_id": current["id"]}, 409)
            await write_manifest(run, overwrite=False)
            await active.upload_blob(json.dumps({"id": run["id"]}), overwrite=True, lease=lease)
        try:
            await send_run(run, lease)
        except (AzureError, ValueError, TimeoutError):
            return response({
                "error": "Sending to Service Bus did not finish. Retry the same submission to resume safely.",
                "id": run["id"],
            }, 503)
        return response({"id": run["id"]}, 202)
    finally:
        await lease.release()


async def send_run(run: dict, lease: BlobLeaseClient) -> None:
    if run["dispatch_state"] == "submitted":
        return
    run_id = run["id"]
    run.update(dispatch_state="sending")
    run.pop("dispatch_error", None)
    try:
        async with asyncio.timeout(SEND_TIMEOUT_SECONDS):
            await write_manifest(run, overwrite=True)
            if run["sent"] == run["total"]:
                run["dispatch_state"] = "submitted"
                await write_manifest(run, overwrite=True)
                return
            async with DefaultAzureCredential() as credential, ServiceBusClient(
                os.environ["ServiceBusConnection__fullyQualifiedNamespace"], credential,
                uamqp_transport=True,
            ) as client:
                async with client.get_queue_sender(os.environ["INGESTION_QUEUE"]) as sender:
                    for start in range(run["sent"], run["total"], 100):
                        await lease.renew()
                        batch = await sender.create_message_batch()
                        for index in range(start, min(start + 100, run["total"])):
                            batch.add_message(ServiceBusMessage(
                                json.dumps(record_at(run, index), allow_nan=False),
                                message_id=f"{run_id}-{index:08d}", correlation_id=run_id,
                                partition_key=f"{run_id}-{start // 100}", content_type="application/json",
                            ))
                        await sender.send_messages(batch)
                        run["sent"] = start + len(batch)
                        await write_manifest(run, overwrite=True)
            run["dispatch_state"] = "submitted"
            await write_manifest(run, overwrite=True)
    except (AzureError, ValueError, TimeoutError):
        logging.exception("demo_send_failed run_id=%s", run_id)
        run.update(dispatch_state="failed", dispatch_error="Sending to Service Bus did not finish. Retry the same submission.")
        await write_manifest(run, overwrite=True)
        raise


@bp.route(route="demo/runs/{run_id}", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
async def demo_status(req: Request) -> JSONResponse:
    if not authorized(req):
        return response({"error": "Sign in with the configured Microsoft demo-owner account."}, 403)
    run_id = req.path_params.get("run_id", "")
    if not RUN_ID.fullmatch(run_id):
        return response({"error": "Invalid run ID."}, 400)
    try:
        run = await read_manifest(run_id)
    except ResourceNotFoundError:
        return response({"error": "Run not found."}, 404)
    return response(await progress(run))


@bp.route(route="demo/access", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
async def demo_access(req: Request) -> JSONResponse:
    if not authorized(req):
        return response({"error": "Sign in with the configured Microsoft demo-owner account."}, 403)
    return response({"allowed": True})


@bp.route(route="demo/runs/{run_id}/records/{index}", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
async def demo_record(req: Request) -> JSONResponse:
    if not authorized(req):
        return response({"error": "Sign in with the configured Microsoft demo-owner account."}, 403)
    run_id = req.path_params.get("run_id", "")
    index_text = req.path_params.get("index", "")
    if not RUN_ID.fullmatch(run_id) or not re.fullmatch(r"\d{1,4}", index_text):
        return response({"error": "Invalid record identifier."}, 400)
    try:
        run = await read_manifest(run_id)
    except ResourceNotFoundError:
        return response({"error": "Run not found."}, 404)
    index = int(index_text)
    if index >= run["total"]:
        return response({"error": "Record not found in this run."}, 404)
    events = []
    truncated = False
    try:
        async for blob in storage().get_container_client("demo-runs").list_blobs(
            name_starts_with=f"flow/{run_id}/{index:08d}/",
        ):
            if len(events) == 100:
                truncated = True
                break
            events.append(json.loads(await (await storage().get_blob_client("demo-runs", blob.name).download_blob()).readall()))
        events.sort(key=lambda item: item["observed_at"])
        created = datetime.fromisoformat(run["created_at"])
        dates = {created.strftime("%Y/%m/%d"), (created + RUN_LIFETIME).strftime("%Y/%m/%d")}
        for day in sorted(dates):
            path = f"{run['source']}/{day}/{run_id}-{index:08d}.json"
            try:
                output = await storage().get_blob_client("processed-data", path).get_blob_properties()
            except ResourceNotFoundError:
                continue
            events.append({"stage": "output_saved", "observed_at": output.creation_time.isoformat()})
    except AzureError:
        logging.exception("message_tracking_history_failed run_id=%s index=%s", run_id, index)
        return response({"error": "Record history is temporarily unavailable."}, 503)
    return response({
        "id": f"{run_id}-{index:08d}", "input": record_at(run, index),
        "events": events, "truncated": truncated,
    })
