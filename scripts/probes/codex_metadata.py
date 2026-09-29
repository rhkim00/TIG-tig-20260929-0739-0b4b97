#!/usr/bin/env python3
"""Probe installed protocol and, optionally, official account metadata.

No inference, thread reads, login, or credential-file reads. Raw account/error
responses are never printed or stored. --account uses existing official auth.
"""
import argparse
import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def schema_probe(binary):
    with tempfile.TemporaryDirectory(prefix="tig-schema-") as out:
        proc = subprocess.run(
            [binary, "app-server", "generate-json-schema", "--out", out],
            capture_output=True, timeout=30,
        )
        if proc.returncode:
            return {"status": "failed", "exit_code": proc.returncode}
        files = list(Path(out).rglob("*.json"))
        names = [p.name for p in files]
        methods, plans = set(), set()
        def walk(value, key=""):
            if isinstance(value, dict):
                if key == "method":
                    methods.update(x for x in value.get("enum", []) if isinstance(x, str))
                    if isinstance(value.get("const"), str):
                        methods.add(value["const"])
                if key in ("PlanType", "ChatGptPlanType"):
                    plans.update(x for x in value.get("enum", []) if isinstance(x, str))
                for k, v in value.items():
                    walk(v, k)
            elif isinstance(value, list):
                for item in value:
                    walk(item, key)
        for path in files:
            walk(json.loads(path.read_text()))
        return {
            "status": "ok", "schema_file_count": len(files),
            "account_read_schema": any("GetAccountResponse" in x for x in names),
            "rate_limits_schema": any("GetAccountRateLimitsResponse" in x for x in names),
            "methods": sorted(m for m in methods if m in {
                "account/read", "account/rateLimits/read", "account/usage/read", "model/list"}),
            "plan_enum": sorted(plans),
        }


def account_projection(result):
    account = result.get("account")
    if not isinstance(account, dict):
        return {"status": "ok", "account_present": False}
    # Do not disclose identity, credentials, plan value, account ids, or raw keys.
    return {"status": "ok", "account_present": True,
            "chatgpt_account": account.get("type") == "chatgpt",
            "plan_field_present": isinstance(account.get("planType"), str),
            "identity_omitted": True}


def limits_projection(result):
    buckets = result.get("rateLimitsByLimitId")
    items = list(buckets.values()) if isinstance(buckets, dict) else []
    if not items and isinstance(result.get("rateLimits"), dict):
        items = [result["rateLimits"]]
    windows = []
    for bucket in items:
        if not isinstance(bucket, dict):
            continue
        for name in ("primary", "secondary"):
            window = bucket.get(name)
            if isinstance(window, dict):
                windows.append({"usage_field_present": isinstance(window.get("usedPercent"), (int, float)),
                                "window_field_present": isinstance(window.get("windowDurationMins"), (int, float)),
                                "reset_field_present": isinstance(window.get("resetsAt"), (int, float))})
    return {"status": "ok", "bucket_count": len(items), "windows": windows,
            "values_and_identity_omitted": True}


async def account_probe(binary):
    with tempfile.TemporaryDirectory(prefix="tig-account-probe-") as cwd:
        proc = await asyncio.create_subprocess_exec(
            binary, "app-server", "--listen", "stdio://",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, cwd=cwd,
        )
        async def send(message):
            proc.stdin.write((json.dumps(message) + "\n").encode())
            await proc.stdin.drain()
        async def rpc(method, ident, params):
            await send({"method": method, "id": ident, "params": params})
            for _ in range(256):
                line = await proc.stdout.readline()
                if not line:
                    return {"error": {"code": "PROCESS_EXIT"}}
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if message.get("id") == ident and ("result" in message or "error" in message):
                    return message
                # Refuse any unsolicited server request; never grant permissions.
                if "id" in message and "method" in message:
                    await send({"id": message["id"], "error": {"code": -32601, "message": "Probe does not support server requests"}})
            return {"error": {"code": "MESSAGE_LIMIT"}}
        output = {}
        try:
            init = await asyncio.wait_for(rpc("initialize", 1, {
                "clientInfo": {"name": "tokenisgold_metadata_probe", "version": "0.1.0"}}), 20)
            if "error" in init:
                return {"initialize": {"status": "failed"}}
            output["initialize"] = {"status": "ok"}
            await send({"method": "initialized", "params": {}})
            for ident, method, params, projection in [
                (2, "account/read", {"refreshToken": False}, account_projection),
                (3, "account/rateLimits/read", {}, limits_projection),
            ]:
                response = await asyncio.wait_for(rpc(method, ident, params), 20)
                if "error" in response:
                    code = response["error"].get("code")
                    output[method] = {"status": "failed", "error_code": code if isinstance(code, int) else "UNAVAILABLE"}
                else:
                    output[method] = projection(response.get("result") or {})
        except (asyncio.TimeoutError, BrokenPipeError, ConnectionResetError):
            output["transport"] = {"status": "timeout_or_closed"}
        finally:
            if proc.returncode is None:
                proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
        return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", action="store_true", help="Use official read-only account/rate-limit methods; no inference")
    args = parser.parse_args()
    binary = shutil.which("codex")
    if not binary:
        print(json.dumps({"codex": "not_installed"}))
        return
    version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=10)
    output = {"codex_version": version.stdout.strip(), "schema": schema_probe(binary)}
    if args.account:
        output["official_metadata"] = asyncio.run(account_probe(binary))
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
