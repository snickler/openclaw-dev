#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Iterable


def run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    executable = shutil.which(args[0])
    if executable is None and sys.platform.startswith("win"):
        executable = shutil.which(f"{args[0]}.cmd") or shutil.which(f"{args[0]}.exe")
    if executable is None:
        raise FileNotFoundError(args[0])
    completed = subprocess.run(
        [executable, *args[1:]],
        text=True,
        capture_output=True,
        encoding="utf-8",
    )
    if check and completed.returncode != 0:
        stdout = (completed.stdout or "").strip()
        stderr = (completed.stderr or "").strip()
        detail = "\n".join(part for part in (stdout, stderr) if part)
        raise RuntimeError(detail or f"command failed: {' '.join(args)}")
    return completed


def load_json_output(raw: str):
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty json output")
    for index, ch in enumerate(text):
        if ch not in "[{":
            continue
        candidate = text[index:]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise ValueError(f"unable to locate json payload in output: {text[:200]}")


def azd_get_value(key: str) -> str:
    completed = run(["azd", "env", "get-value", key], check=False)
    if completed.returncode != 0:
        return ""
    value = (completed.stdout or "").strip()
    if value.startswith("ERROR:"):
        return ""
    return value


def azd_set_value(key: str, value: str) -> None:
    run(["azd", "env", "set", key, value])


def parse_selector(labels: Iterable[str]) -> str:
    parsed = []
    for label in labels:
        item = label.strip()
        if not item or "=" not in item:
            raise ValueError(f"invalid --selector-label value: {label!r}")
        parsed.append(item)
    if not parsed:
        raise ValueError("at least one --selector-label is required")
    return ",".join(parsed)


def get_openai_base_url() -> str:
    endpoint = azd_get_value("AZURE_OPENAI_ENDPOINT").rstrip("/")
    if not endpoint:
        raise RuntimeError("AZURE_OPENAI_ENDPOINT is missing. Run 'devclaw up' first.")
    return f"{endpoint}/openai/v1/"


def get_openai_resource_id() -> str:
    resource_id = azd_get_value("AZURE_OPENAI_RESOURCE_ID").strip()
    if resource_id:
        return resource_id

    endpoint = azd_get_value("AZURE_OPENAI_ENDPOINT").rstrip("/")
    if not endpoint:
        raise RuntimeError("AZURE_OPENAI_ENDPOINT is missing. Run 'devclaw up' first.")

    resource_group = azd_get_value("AZURE_RESOURCE_GROUP").strip()
    args = ["az", "cognitiveservices", "account", "list", "-o", "json"]
    if resource_group:
        args.extend(["--resource-group", resource_group])

    completed = run(args)
    payload = load_json_output(completed.stdout)
    accounts = payload if isinstance(payload, list) else []
    for account in accounts:
        if not isinstance(account, dict):
            continue
        properties = account.get("properties") or {}
        account_endpoint = str(properties.get("endpoint") or "").rstrip("/")
        if account_endpoint != endpoint:
            continue
        resource_id = str(account.get("id") or "").strip()
        if resource_id:
            return resource_id

    raise RuntimeError(f"Unable to resolve Azure OpenAI resource ID for endpoint: {endpoint}")


def get_browser_auth_settings() -> dict[str, str]:
    settings = {
        "client_id": azd_get_value("BROWSER_AUTH_CLIENT_ID"),
        "tenant_id": azd_get_value("BROWSER_AUTH_TENANT_ID"),
        "session_secret": azd_get_value("BROWSER_AUTH_SESSION_SECRET"),
        "allowed_users": azd_get_value("BROWSER_AUTH_ALLOWED_USERS"),
        "allowed_object_ids": azd_get_value("BROWSER_AUTH_ALLOWED_OBJECT_IDS"),
    }
    missing = [name for name in ("client_id", "tenant_id", "session_secret") if not settings[name]]
    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(
            f"Sandbox browser auth is not provisioned ({joined}). "
            "Run 'devclaw up' in sandbox mode first."
        )
    if not settings["allowed_users"] and not settings["allowed_object_ids"]:
        raise RuntimeError(
            "Sandbox browser auth allowlist is empty. "
            "Set BROWSER_AUTH_ALLOWED_USERS and/or BROWSER_AUTH_ALLOWED_OBJECT_IDS."
        )
    return settings


def get_github_cli_env() -> dict[str, str]:
    token = (os.environ.get("SANDBOX_GITHUB_COPILOT_PAT") or azd_get_value("SANDBOX_GITHUB_COPILOT_PAT")).strip()
    if not token:
        return {}
    if not token.startswith("github_pat_"):
        raise RuntimeError("SANDBOX_GITHUB_COPILOT_PAT must be a fine-grained GitHub PAT (github_pat_...).")
    return {
        "GH_TOKEN": token,
        "GITHUB_TOKEN": token,
        "GH_PROMPT_DISABLED": "1",
    }


def has_github_copilot_credential() -> bool:
    credential_id = (
        os.environ.get("SANDBOX_GITHUB_COPILOT_CREDENTIAL_ID")
        or azd_get_value("SANDBOX_GITHUB_COPILOT_CREDENTIAL_ID")
    ).strip()
    return bool(credential_id)


def get_existing_sandbox(group: str, selector: str):
    completed = run(
        ["aca", "sandbox", "get", "--group", group, "-l", selector, "-o", "json"],
        check=False,
    )
    if completed.returncode != 0:
        return None
    output = (completed.stdout or "").strip()
    if not output:
        return None
    try:
        return load_json_output(output)
    except ValueError:
        return None


def get_sandbox_group_principal_id(group: str) -> str:
    completed = run(["aca", "sandboxgroup", "identity", "show", "--group", group, "-o", "json"])
    payload = load_json_output(completed.stdout)
    if not isinstance(payload, dict):
        raise RuntimeError("unexpected sandbox group identity payload")
    principal_id = str(payload.get("principalId") or "").strip()
    if not principal_id:
        raise RuntimeError("sandbox group managed identity principalId is missing")
    return principal_id


def ensure_role_assignment(principal_id: str, scope: str, role_name: str) -> None:
    completed = run(
        [
            "az",
            "role",
            "assignment",
            "list",
            "--assignee-object-id",
            principal_id,
            "--scope",
            scope,
            "--query",
            f"[?roleDefinitionName=='{role_name}'].id | [0]",
            "-o",
            "tsv",
        ],
        check=False,
    )
    if completed.returncode == 0 and (completed.stdout or "").strip():
        print(f"[sandbox runtime] Azure OpenAI RBAC already present: {role_name}")
        return

    print(f"[sandbox runtime] Granting Azure OpenAI RBAC: {role_name}")
    create = run(
        [
            "az",
            "role",
            "assignment",
            "create",
            "--assignee-object-id",
            principal_id,
            "--assignee-principal-type",
            "ServicePrincipal",
            "--role",
            role_name,
            "--scope",
            scope,
            "-o",
            "none",
        ],
        check=False,
    )
    if create.returncode == 0:
        return

    detail = "\n".join(part for part in ((create.stdout or "").strip(), (create.stderr or "").strip()) if part)
    if "RoleAssignmentExists" in detail:
        return
    raise RuntimeError(detail or f"failed to grant Azure OpenAI RBAC: {role_name}")


def ensure_openai_access(group: str) -> None:
    principal_id = get_sandbox_group_principal_id(group)
    scope = get_openai_resource_id()
    for role_name in ("Cognitive Services User", "Cognitive Services OpenAI User"):
        ensure_role_assignment(principal_id, scope, role_name)
    print("[sandbox runtime] Azure OpenAI role assignments requested. Propagation can take a few minutes.")


def confirm_replace(existing: dict, selector: str) -> bool:
    sandbox_id = existing.get("id", "<unknown>")
    print("[sandbox runtime] An existing sandbox runtime already matches this selector.")
    print(f"[sandbox runtime] Selector: {selector}")
    print(f"[sandbox runtime] Sandbox ID: {sandbox_id}")
    print("[sandbox runtime] Replacing it deletes only that sandbox runtime and its public endpoint.")
    print("[sandbox runtime] Disk images, Azure OpenAI, the resource group, and Entra app registrations stay.")
    if not sys.stdin.isatty():
        print("[sandbox runtime] Refusing to replace an existing sandbox without an interactive confirmation prompt.")
        return False
    reply = input("Replace the existing sandbox now? [y/N]: ").strip().lower()
    return reply == "y"


def delete_existing_sandbox(group: str, selector: str) -> None:
    print("[sandbox runtime] Deleting existing sandbox runtime...")
    run(["aca", "sandbox", "delete", "--group", group, "-l", selector, "--yes"])


def create_sandbox(
    group: str,
    region: str,
    selector_labels: list[str],
    disk_name: str,
    disk_id: str,
    credentials: list[str],
    public_port: int,
    entrypoint: str,
    openai_base_url: str,
    browser_auth: dict[str, str],
    github_cli_env: dict[str, str],
) -> None:
    create_args = [
        "aca",
        "sandbox",
        "create",
        "--group",
        group,
        "--entrypoint",
        "sh -lc 'tail -f /dev/null'",
        "--env",
        f"OPENAI_BASE_URL={openai_base_url}",
        "--env",
        "AZURE_OPENAI_AUTH=managed-identity",
        "--env",
        f"SANDBOX_REGION={region}",
        "--env",
        f"OPENCLAW_PUBLIC_PORT={public_port}",
        "--env",
        "BROWSER_AUTH_MODE=entra-oidc-proxy",
        "--env",
        f"BROWSER_AUTH_CLIENT_ID={browser_auth['client_id']}",
        "--env",
        f"BROWSER_AUTH_TENANT_ID={browser_auth['tenant_id']}",
        "--env",
        f"BROWSER_AUTH_SESSION_SECRET={browser_auth['session_secret']}",
    ]
    if browser_auth["allowed_users"]:
        create_args.extend(["--env", f"BROWSER_AUTH_ALLOWED_USERS={browser_auth['allowed_users']}"])
    if browser_auth["allowed_object_ids"]:
        create_args.extend(["--env", f"BROWSER_AUTH_ALLOWED_OBJECT_IDS={browser_auth['allowed_object_ids']}"])
    for key, value in github_cli_env.items():
        create_args.extend(["--env", f"{key}={value}"])
    if disk_id:
        create_args.extend(["--disk-id", disk_id])
    else:
        create_args.extend(["--disk", disk_name])
    for credential in credentials:
        create_args.extend(["--credential", credential])
    for label in selector_labels:
        create_args.extend(["--label", label])
    print("[sandbox runtime] Creating sandbox runtime with in-sandbox OIDC auth...")
    run(create_args)


def add_anonymous_port(group: str, selector: str, public_port: int) -> None:
    print(f"[sandbox runtime] Exposing public port {public_port} anonymously at the platform layer...")
    run([
        "aca",
        "sandbox",
        "port",
        "add",
        "--group",
        group,
        "-l",
        selector,
        "--port",
        str(public_port),
        "--anonymous",
    ])


def bootstrap_runtime(group: str, selector: str) -> None:
    print("[sandbox runtime] Bootstrapping OpenClaw inside the sandbox...")
    command = (
        "sh -lc 'if ps -ef | grep -E "
        "'\"'\"'[g]ateway-proxy\\.mjs|[o]penclaw gateway'\"'\"'"
        " >/dev/null 2>&1; then "
        "echo "
        "'\"'\"'[sandbox runtime] OpenClaw runtime is already running'\"'\"'"
        "; else nohup /opt/entrypoint.sh >/proc/1/fd/1 2>/proc/1/fd/2 </dev/null & fi'"
    )
    exec_args = [
        "aca",
        "sandbox",
        "exec",
        "--group",
        group,
        "-l",
        selector,
        "--command",
        command,
    ]
    last_detail = ""
    for attempt in range(1, 7):
        completed = run(exec_args, check=False)
        if completed.returncode == 0:
            return
        last_detail = "\n".join(
            part for part in ((completed.stdout or "").strip(), (completed.stderr or "").strip()) if part
        )
        if "GlobalSandboxNotRunning" not in last_detail and "not in Running state" not in last_detail:
            break
        run(["aca", "sandbox", "resume", "--group", group, "-l", selector], check=False)
        print(f"[sandbox runtime] Sandbox is still resuming; retrying bootstrap ({attempt}/6)...")
        time.sleep(5)
    raise RuntimeError(last_detail or "failed to bootstrap sandbox runtime")


def get_sandbox(group: str, selector: str) -> dict:
    completed = run(["aca", "sandbox", "get", "--group", group, "-l", selector, "-o", "json"])
    payload = load_json_output(completed.stdout)
    if not isinstance(payload, dict):
        raise RuntimeError("unexpected sandbox payload")
    return payload


def get_public_base_url(group: str, selector: str, region: str, public_port: int, sandbox_id: str) -> tuple[str, dict | None]:
    completed = run(
        ["aca", "sandbox", "port", "list", "--group", group, "-l", selector, "-o", "json"],
        check=False,
    )
    default_url = f"https://{sandbox_id}--{public_port}.{region}.adcproxy.io"
    if completed.returncode != 0 or not (completed.stdout or "").strip():
        return default_url, None
    payload = load_json_output(completed.stdout)
    items = payload if isinstance(payload, list) else [payload]
    for item in items:
        if not isinstance(item, dict):
            continue
        if int(item.get("port", 0) or 0) != public_port:
            continue
        url = str(item.get("url") or item.get("endpoint") or "").rstrip("/")
        if url:
            return url, item
    return default_url, None


def update_redirect_uri(client_id: str, redirect_uri: str) -> None:
    completed = run(
        ["az", "ad", "app", "show", "--id", client_id, "--query", "web.redirectUris", "-o", "json"],
        check=False,
    )
    existing_uris: list[str] = []
    if completed.returncode == 0 and (completed.stdout or "").strip():
        payload = load_json_output(completed.stdout)
        if isinstance(payload, list):
            existing_uris = [str(item) for item in payload if isinstance(item, str) and item.strip()]
    merged = []
    for uri in [*existing_uris, redirect_uri]:
        if uri not in merged:
            merged.append(uri)
    print(f"[sandbox runtime] Ensuring Entra redirect URI exists: {redirect_uri}")
    run(["az", "ad", "app", "update", "--id", client_id, "--web-redirect-uris", *merged])


def wait_for_health(public_base_url: str, timeout_seconds: int) -> None:
    deadline = time.time() + timeout_seconds
    health_url = f"{public_base_url}/healthz"
    print(f"[sandbox runtime] Waiting for health endpoint: {health_url}")
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=10) as response:
                if response.status == 200:
                    print("[sandbox runtime] Health endpoint is ready.")
                    return
        except Exception:
            pass
        time.sleep(5)
    raise RuntimeError(f"health endpoint never became ready: {health_url}")


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe_without_redirect(url: str) -> tuple[int, dict[str, str]]:
    opener = urllib.request.build_opener(NoRedirectHandler)
    request = urllib.request.Request(url, headers={"Accept": "text/html"})
    try:
        with opener.open(request, timeout=15) as response:
            headers = {k: v for k, v in response.headers.items()}
            return response.status, headers
    except urllib.error.HTTPError as exc:
        headers = {k: v for k, v in exc.headers.items()}
        return exc.code, headers


def main() -> int:
    parser = argparse.ArgumentParser(description="Create or replace the ACA sandbox runtime for OpenClaw")
    parser.add_argument("--group", required=True, help="Sandbox group name")
    parser.add_argument("--region", required=True, help="Sandbox region")
    parser.add_argument("--selector-label", action="append", required=True, help="Label selector entry (repeatable key=value)")
    parser.add_argument("--disk-name", default="", help="Sandbox disk name")
    parser.add_argument("--disk-id", default="", help="Sandbox disk resource ID")
    parser.add_argument("--credential", action="append", default=[], help="Sandbox credential id to attach")
    parser.add_argument("--entrypoint", default="sh -lc 'tail -f /dev/null'", help="Sandbox keepalive entrypoint used before explicit runtime bootstrap")
    parser.add_argument("--public-port", type=int, default=18789, help="Public port to expose")
    parser.add_argument("--browser-auth-callback-path", default="/oidc/callback", help="Browser auth callback path")
    parser.add_argument("--health-timeout-seconds", type=int, default=180, help="Health probe timeout")
    parser.add_argument("--bootstrap-only", action="store_true", help="Only resume/bootstrap an existing sandbox runtime")
    args = parser.parse_args()

    selector = parse_selector(args.selector_label)

    if args.bootstrap_only:
        sandbox = get_sandbox(args.group, selector)
        if str(sandbox.get("state") or "").lower() != "running":
            print("[sandbox runtime] Resuming stopped sandbox runtime...")
            run(["aca", "sandbox", "resume", "--group", args.group, "-l", selector])
        bootstrap_runtime(args.group, selector)
        sandbox = get_sandbox(args.group, selector)
        sandbox_id = str(sandbox.get("id") or "").strip()
        public_base_url = azd_get_value("PUBLIC_BASE_URL").strip()
        if not public_base_url and sandbox_id:
            public_base_url, _ = get_public_base_url(args.group, selector, args.region, args.public_port, sandbox_id)
        if public_base_url:
            wait_for_health(public_base_url.rstrip("/"), args.health_timeout_seconds)
        return 0

    if not args.disk_id and not args.disk_name:
        raise RuntimeError("Either --disk-id or --disk-name is required")

    openai_base_url = get_openai_base_url()
    browser_auth = get_browser_auth_settings()
    github_cli_env = get_github_cli_env()
    ensure_openai_access(args.group)

    if github_cli_env:
        print("[sandbox runtime] GitHub CLI auto-auth enabled via GH_TOKEN/GITHUB_TOKEN from SANDBOX_GITHUB_COPILOT_PAT.")
    elif has_github_copilot_credential():
        print("[sandbox runtime] GitHub Copilot credential is attached, but current ACA Sandbox custom-image credential surface does not expose it inside the runtime.")
        print("[sandbox runtime] No GitHub-specific env var, file, or mount was detected in the current custom-image sandbox path.")
        print("[sandbox runtime] To auto-auth gh or GitHub-token-based MCP servers in custom images, keep SANDBOX_GITHUB_COPILOT_PAT set locally when you run 'devclaw sandbox build'.")

    existing = get_existing_sandbox(args.group, selector)
    if existing:
        if not confirm_replace(existing, selector):
            return 1
        delete_existing_sandbox(args.group, selector)

    create_sandbox(
        group=args.group,
        region=args.region,
        selector_labels=args.selector_label,
        disk_name=args.disk_name,
        disk_id=args.disk_id,
        credentials=args.credential,
        public_port=args.public_port,
        entrypoint=args.entrypoint,
        openai_base_url=openai_base_url,
        browser_auth=browser_auth,
        github_cli_env=github_cli_env,
    )
    add_anonymous_port(args.group, selector, args.public_port)
    bootstrap_runtime(args.group, selector)

    sandbox = get_sandbox(args.group, selector)
    sandbox_id = str(sandbox.get("id") or "").strip()
    if not sandbox_id:
        raise RuntimeError("sandbox id missing after create")

    public_base_url, port_info = get_public_base_url(args.group, selector, args.region, args.public_port, sandbox_id)
    azd_set_value("PUBLIC_BASE_URL", public_base_url)
    azd_set_value("BROWSER_AUTH_MODE", "entra-oidc-proxy")
    redirect_uri = f"{public_base_url.rstrip('/')}{args.browser_auth_callback_path}"
    update_redirect_uri(browser_auth["client_id"], redirect_uri)

    wait_for_health(public_base_url, args.health_timeout_seconds)

    root_status, root_headers = probe_without_redirect(public_base_url)
    login_status, login_headers = probe_without_redirect(f"{public_base_url.rstrip('/')}/oidc/login")

    print(f"[sandbox runtime] Public base URL: {public_base_url}")
    if port_info is not None:
        anonymous = bool((port_info.get("auth") or {}).get("anonymous"))
        print(f"[sandbox runtime] Platform port auth anonymous: {anonymous}")
    print(f"[sandbox runtime] Root probe: {root_status} -> {root_headers.get('Location', '')}")
    print(f"[sandbox runtime] Login probe: {login_status} -> {login_headers.get('Location', '')}")

    if root_status not in (301, 302, 303, 307, 308):
        raise RuntimeError(f"expected root probe redirect, got {root_status}")
    if not root_headers.get("Location", "").startswith("/oidc/login"):
        raise RuntimeError("root probe did not redirect to the in-app OIDC login path")
    if login_status not in (301, 302, 303, 307, 308):
        raise RuntimeError(f"expected login probe redirect, got {login_status}")
    if "login.microsoftonline.com" not in login_headers.get("Location", ""):
        raise RuntimeError("login probe did not redirect to Microsoft Entra")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[sandbox runtime] ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
