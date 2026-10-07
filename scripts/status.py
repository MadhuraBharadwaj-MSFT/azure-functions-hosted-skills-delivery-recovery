import argparse
from datetime import datetime, timezone

from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient


def main() -> None:
    parser = argparse.ArgumentParser(description="Count this run's persisted output records without calling a model.")
    parser.add_argument("--storage-account", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--expected", type=int, default=1000)
    args = parser.parse_args()
    with DefaultAzureCredential() as credential:
        with BlobServiceClient(
            f"https://{args.storage_account}.blob.core.windows.net", credential,
        ) as client:
            blobs = [
                blob
                for blob in client.get_container_client("processed-data").list_blobs()
                if blob.name.rsplit("/", 1)[-1].startswith(f"{args.run_id}-")
            ]
    print(f"{datetime.now(timezone.utc).isoformat()}  Output records: {len(blobs)}/{args.expected}")
    if len(blobs) > 1:
        times = [b.creation_time for b in blobs]
        seconds = (max(times) - min(times)).total_seconds()
        if seconds > 0:
            print(f"Observed output window: {seconds:.1f}s, {(len(blobs) - 1) / seconds:.1f} records/s")
            print("Time between first and last output, including any automatic recovery; not an ingestion throughput benchmark.")


if __name__ == "__main__":
    main()
