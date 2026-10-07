import argparse
import json
import random
import time
import uuid
from pathlib import Path

from azure.identity import DefaultAzureCredential
from azure.servicebus import ServiceBusClient, ServiceBusMessage


def main() -> None:
    parser = argparse.ArgumentParser(description="Send a 1,000-record ingestion demo with a few malformed records.")
    parser.add_argument("--namespace", required=True, help="Full *.servicebus.windows.net hostname")
    parser.add_argument("--count", type=int, default=1000)
    parser.add_argument("--malformed-count", type=int, default=5)
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")
    if not 0 <= args.malformed_count <= min(25, args.count):
        parser.error("--malformed-count must be between 0 and min(25, count)")
    samples = json.loads((Path(__file__).resolve().parents[1] / "samples/messages.json").read_text())
    run = uuid.uuid4().hex[:12]
    malformed = set(random.sample(range(args.count), args.malformed_count))
    started = time.monotonic()
    with DefaultAzureCredential() as credential:
        with ServiceBusClient(args.namespace, credential, uamqp_transport=True) as client:
            with client.get_queue_sender("data-ingestion") as sender:
                batch = sender.create_message_batch()
                for index in range(args.count):
                    # Keep each batch on one partition, without pinning the whole run.
                    if index > 0 and index % 100 == 0:
                        sender.send_messages(batch)
                        batch = sender.create_message_batch()
                    body = dict(samples[1 if index in malformed else 0])
                    identifier = f"{run}-{index:08d}"
                    body["recordId" if "recordId" in body else "record_id"] = identifier
                    message = ServiceBusMessage(
                        json.dumps(body), message_id=identifier,
                        correlation_id=run, content_type="application/json",
                        partition_key=f"{run}-{index // 100}",
                    )
                    try:
                        batch.add_message(message)
                    except ValueError:
                        sender.send_messages(batch)
                        batch = sender.create_message_batch()
                        batch.add_message(message)
                if len(batch):
                    sender.send_messages(batch)
    print(f"Run ID: {run}")
    print(f"Sent {args.count} records: {args.count - args.malformed_count} valid, {args.malformed_count} malformed.")
    if malformed:
        print("Malformed record IDs: " + ", ".join(f"{run}-{index:08d}" for index in sorted(malformed)))
    print(f"Producer duration: {time.monotonic() - started:.1f}s (not ingestion throughput).")


if __name__ == "__main__":
    main()
