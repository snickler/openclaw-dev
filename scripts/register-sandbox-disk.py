#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

AZ_CLI = shutil.which("az") or shutil.which("az.cmd") or "az"
ACA_CLI = shutil.which("aca") or shutil.which("aca.exe") or "aca"
AAD_ACR_USERNAME = "00000000-0000-0000-0000-000000000000"
TRANSIENT_PATTERNS = (
    "retry policy expired",
    "network issue",
    "timed out",
    "timeout",
    "temporarily unavailable",
    "connection reset",
    "gateway timeout",
    "service unavailable",
)
AUTH_PATTERNS = (
    "registryauthfailed",
    "authentication failed when pulling container image",
    "unauthorized",
    "401",
)


def eprint(*args):
    print(*args, file=sys.stderr)


def run_cmd(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "").strip())
    return proc.stdout.strip()


def parse_json_from_output(output):
    lines = [line for line in output.splitlines() if line.strip() and not line.startswith("WARNING:")]
    payload = "\n".join(lines).strip()
    if not payload:
        return {}
    return json.loads(payload)


def run_az(args):
    return run_cmd([AZ_CLI, *args])


def run_aca(args):
    return run_cmd([ACA_CLI, *args])


def list_disks(subscription, resource_group, sandbox_group, region):
    out = run_aca(
        [
            "sandboxgroup",
            "disk",
            "list",
            "--group",
            sandbox_group,
            "--subscription",
            subscription,
            "--resource-group",
            resource_group,
            "--region",
            region,
            "-o",
            "json",
        ]
    )
    data = parse_json_from_output(out)
    return data if isinstance(data, list) else []


def find_disk(disks, disk_name, image):
    matches = []
    for disk in disks:
        labels = disk.get("labels") or {}
        if labels.get("name") != disk_name:
            continue
        base = ((disk.get("image") or {}).get("base") or "").lower()
        if image and base != image.lower():
            continue
        matches.append(disk)
    if not matches:
        return None
    matches.sort(key=lambda d: ((d.get("status") or {}).get("updatedAt") or ""))
    return matches[-1]


def create_disk(subscription, resource_group, sandbox_group, region, disk_name, image, labels, username, token):
    cmd = [
        ACA_CLI,
        "sandboxgroup",
        "disk",
        "create",
        "--group",
        sandbox_group,
        "--name",
        disk_name,
        "--image",
        image,
        "--subscription",
        subscription,
        "--resource-group",
        resource_group,
        "--region",
        region,
        "-o",
        "json",
    ]
    for key, value in labels.items():
        cmd.extend(["--label", f"{key}={value}"])
    if username and token:
        cmd.extend(["--username", username, "--token", token])
    out = run_cmd(cmd)
    return parse_json_from_output(out)


def get_acr_credentials(image, explicit_username, explicit_token):
    if explicit_username and explicit_token:
        return explicit_username, explicit_token
    registry = image.split("/", 1)[0].lower()
    if not registry.endswith(".azurecr.io"):
        return explicit_username, explicit_token
    acr_name = registry.split(".", 1)[0]
    login_out = run_az(["acr", "login", "-n", acr_name, "--expose-token", "-o", "json"])
    payload = parse_json_from_output(login_out)
    access_token = payload.get("accessToken")
    if not access_token:
        raise RuntimeError(f"Unable to acquire ACR token for registry '{acr_name}'")
    return explicit_username or AAD_ACR_USERNAME, access_token


def is_transient_error(message):
    msg = (message or "").lower()
    return any(part in msg for part in TRANSIENT_PATTERNS)


def is_auth_error(message):
    msg = (message or "").lower()
    return any(part in msg for part in AUTH_PATTERNS)


def is_acr_image(image):
    registry = image.split("/", 1)[0].lower()
    return registry.endswith(".azurecr.io")


def poll_ready(subscription, resource_group, sandbox_group, region, disk_name, image, timeout_seconds, poll_seconds):
    deadline = time.time() + timeout_seconds
    while True:
        disk = find_disk(list_disks(subscription, resource_group, sandbox_group, region), disk_name, image)
        if disk:
            state = ((disk.get("status") or {}).get("state") or "").lower()
            if state == "ready":
                return disk
            if state == "failed":
                raise RuntimeError(json.dumps(disk, indent=2))
        if time.time() >= deadline:
            raise RuntimeError(f"Timed out waiting for disk '{disk_name}' ({image}) to become Ready")
        time.sleep(poll_seconds)


def main():
    parser = argparse.ArgumentParser(description="Register an ACA Sandbox disk image from an OCI container image")
    parser.add_argument("--subscription", default=os.environ.get("AZURE_SUBSCRIPTION_ID", ""))
    parser.add_argument("--resource-group", required=True)
    parser.add_argument("--sandbox-group", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--disk-name", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--metadata-path", default="")
    parser.add_argument("--label", action="append", default=[], help="key=value label (repeatable)")
    parser.add_argument("--registry-username", default="")
    parser.add_argument("--registry-token", default="")
    parser.add_argument("--max-attempts", type=int, default=4)
    parser.add_argument("--ready-timeout", type=int, default=5400)
    parser.add_argument("--poll-seconds", type=int, default=15)
    args = parser.parse_args()

    if not args.subscription:
        raise SystemExit("Missing --subscription (or AZURE_SUBSCRIPTION_ID)")

    root = Path(__file__).resolve().parent.parent
    output_dir = root / "_local" / "sandbox"
    output_dir.mkdir(parents=True, exist_ok=True)

    labels = {"name": args.disk_name}
    for item in args.label:
        if "=" not in item:
            raise SystemExit(f"Invalid label '{item}'. Expected key=value.")
        key, value = item.split("=", 1)
        labels[key] = value

    run_az(["account", "set", "--subscription", args.subscription])
    username, token = get_acr_credentials(args.image, args.registry_username, args.registry_token)

    disk = find_disk(
        list_disks(args.subscription, args.resource_group, args.sandbox_group, args.region),
        args.disk_name,
        args.image,
    )

    if not disk:
        last_error = None
        for attempt in range(1, max(args.max_attempts, 1) + 1):
            try:
                disk = create_disk(
                    args.subscription,
                    args.resource_group,
                    args.sandbox_group,
                    args.region,
                    args.disk_name,
                    args.image,
                    labels,
                    username,
                    token,
                )
                break
            except Exception as exc:
                last_error = str(exc)
                if is_auth_error(last_error) and is_acr_image(args.image):
                    eprint("[register-sandbox-disk] Refreshing ACR token after registry auth failure...")
                    username, token = get_acr_credentials(args.image, args.registry_username, args.registry_token)
                    continue
                if not is_transient_error(last_error) or attempt >= args.max_attempts:
                    raise RuntimeError(last_error) from exc
                eprint(f"[register-sandbox-disk] Attempt {attempt} failed: {last_error}")
                eprint("[register-sandbox-disk] Retrying by checking existing disk state...")
                disk = find_disk(
                    list_disks(args.subscription, args.resource_group, args.sandbox_group, args.region),
                    args.disk_name,
                    args.image,
                )
                if disk:
                    break
                time.sleep(min(15 * attempt, 60))

    disk = poll_ready(
        args.subscription,
        args.resource_group,
        args.sandbox_group,
        args.region,
        args.disk_name,
        args.image,
        timeout_seconds=args.ready_timeout,
        poll_seconds=max(args.poll_seconds, 5),
    )

    metadata = {
        "name": args.disk_name,
        "id": disk.get("id", ""),
        "resource_group": args.resource_group,
        "sandbox_group": args.sandbox_group,
        "region": args.region,
        "source_image": args.image,
        "labels": labels,
        "status": disk.get("status", {}),
        "size_in_mb": disk.get("sizeInMB"),
        "created_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    metadata_path = Path(args.metadata_path) if args.metadata_path else output_dir / "disk-image-metadata.json"
    if not metadata_path.is_absolute():
        metadata_path = (root / metadata_path).resolve()
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        eprint(str(exc))
        raise SystemExit(1)
