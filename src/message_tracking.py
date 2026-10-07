import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

import azure.functions as func
from azure.core.exceptions import AzureError

# Codes are ordered by confirmed progress, not by assumed time spent in a stage.
STAGES = (
    "Not observed", "Sent to Service Bus", "Ingestion received",
    "Validation failed; awaiting recovery", "Requeued message received",
    "Requeued message rejected; awaiting recovery", "Output saved",
)
RECORD_ID = re.compile(r"^([a-f0-9]{32})-(\d{8})$")
EVENT_STAGES = {"received": 2, "rejected": 3, "requeued": 4, "requeue_rejected": 5}


def enabled() -> bool:
    return os.environ.get("MESSAGE_FLOW_TRACKING_ENABLED", "false").lower() == "true"


def identity(message: func.ServiceBusMessage):
    message_id = str(message.message_id or "")
    record_id = message_id.removeprefix("repair-").removeprefix("retry-")
    match = RECORD_ID.fullmatch(record_id)
    if not match or str(message.correlation_id or "") != match[1] or int(match[2]) >= 5000:
        return None
    return match[1], int(match[2]), message_id.startswith("repair-")


def event(message: func.ServiceBusMessage, stage: str):
    if not enabled():
        return None
    record = identity(message)
    if record is None:
        return None
    run_id, index, repaired = record
    if stage == "received" and repaired:
        stage = "requeued"
    elif stage == "rejected" and repaired:
        stage = "requeue_rejected"
    timestamp = datetime.now(timezone.utc).isoformat()
    name = f"flow/{run_id}/{index:08d}/{stage}/{uuid.uuid4().hex}.json"
    body = {
        "stage": stage, "observed_at": timestamp,
        "message_id": str(message.message_id),
        "delivery_count": message.delivery_count,
    }
    return name, json.dumps(body)


async def record_event(storage, message: func.ServiceBusMessage, stage: str) -> None:
    entry = event(message, stage)
    if entry is None:
        return
    try:
        await storage.get_blob_client("demo-runs", entry[0]).upload_blob(
            entry[1], overwrite=False, retry_total=1, connection_timeout=5, read_timeout=5,
        )
    except AzureError:
        # Observability failures must not change Service Bus settlement or requeue data.
        logging.exception("message_tracking_write_failed stage=%s message_id=%s", stage, message.message_id)
