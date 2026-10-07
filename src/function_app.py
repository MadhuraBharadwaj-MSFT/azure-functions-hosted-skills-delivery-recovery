import json
import logging
import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import azure.functions as func
from azure.core.exceptions import ResourceExistsError
from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob import ContentSettings
from azure.storage.blob.aio import BlobServiceClient
from azure_functions_agents import create_function_app
from jsonschema import Draft202012Validator, ValidationError
from demo_api import bp as demo_blueprint
from message_tracking import record_event
from mcp_transport import configure_mcp_transport

configure_mcp_transport(Path(__file__).parent)
app = create_function_app(app_root=Path(__file__).parent)
app.register_functions(demo_blueprint)
schema = Draft202012Validator(json.loads(Path(__file__).with_name("record-schema.json").read_text()))


@lru_cache
def storage() -> BlobServiceClient:
    return BlobServiceClient(
        os.environ["DATA_STORAGE_BLOB_URL"], credential=DefaultAzureCredential(),
    )


# The existing function: deterministic code, no model calls.
@app.service_bus_queue_trigger(
    arg_name="message", queue_name="%INGESTION_QUEUE%", connection="ServiceBusConnection",
)
async def ingest(message: func.ServiceBusMessage) -> None:
    await record_event(storage(), message, "received")
    try:
        record = json.loads(message.get_body())
        schema.validate(record)
    except (ValueError, ValidationError):
        await record_event(storage(), message, "rejected")
        raise
    record["source"] = re.sub(r"[^a-z0-9]+", "-", record["source"].lower()).strip("-")
    record["ingested_at"] = datetime.now(timezone.utc).isoformat()
    record["schema_version"] = 1
    # Enqueue time keeps the partition stable if a delivery retries after midnight.
    partition = message.enqueued_time_utc.astimezone(timezone.utc).strftime("%Y/%m/%d")
    blob_name = f"{record['source']}/{partition}/{record['record_id']}.json"
    blob = storage().get_blob_client("processed-data", blob_name)
    try:
        await blob.upload_blob(
            json.dumps(record, allow_nan=False),
            overwrite=False,
            content_settings=ContentSettings(content_type="application/json"),
        )
    except ResourceExistsError:
        logging.info("Record already ingested: %s", record["record_id"])
        return
    logging.info("ingestion_completed record_id=%s", record["record_id"])
