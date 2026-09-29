#!/usr/bin/env python3
"""Controlled bubblewrap smoke test using only temporary fixtures.

Not an AI runner, security audit, or proof that all P-052 controls are implemented.
No project/user files are mounted. No external network is contacted.
"""
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile


def main():
    binary = shutil.which("bwrap")
    if not binary:
        print(json.dumps({"status": "unavailable", "reason": "bubblewrap_not_installed"}))
        return
    with tempfile.TemporaryDirectory(prefix="tig-isolation-") as tmp, socket.socket() as host:
        base = Path(tmp)
        work = base / "work"
        work.mkdir()
        sentinel = base / "outside-fixture.txt"
        sentinel.write_text("synthetic fixture, not user data")
        host.bind(("127.0.0.1", 0))
        host.listen(1)
        port = host.getsockname()[1]
        code = '''import json, pathlib, resource, socket, sys
resource.setrlimit(resource.RLIMIT_AS, (128*1024*1024,128*1024*1024))
pathlib.Path('/work/result.txt').write_text('ok')
checks={'workspace_writable':True,'outside_fixture_hidden':not pathlib.Path(sys.argv[1]).exists()}
s=socket.socket(); s.settimeout(1)
checks['host_loopback_unreachable']=s.connect_ex(('127.0.0.1',int(sys.argv[2]))) != 0
s.close()
try:
    allocation=bytearray(256*1024*1024)
    checks['address_space_limit']=False
except MemoryError:
    checks['address_space_limit']=True
print(json.dumps(checks))
'''
        command = [binary, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
                   "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
                   "--symlink", "usr/lib", "/lib"]
        if Path("/lib64").exists():
            command += ["--ro-bind", "/lib64", "/lib64"]
        command += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
                    "--bind", str(work), "/work", "--chdir", "/work",
                    "/usr/bin/python3", "-c", code, str(sentinel), str(port)]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        except subprocess.TimeoutExpired:
            print(json.dumps({"status": "timeout"}))
            return
        if result.returncode:
            # Controlled command only; keep diagnostics constrained to recognized failures.
            error = result.stderr.lower()
            reason = "namespace_permission_denied" if "operation not permitted" in error or "permission denied" in error else "sandbox_start_failed"
            print(json.dumps({"status": "unavailable", "exit_code": result.returncode, "reason": reason}))
            return
        checks = json.loads(result.stdout)
        checks["output_persisted"] = (work / "result.txt").read_text() == "ok"
        print(json.dumps({"status": "smoke_passed" if all(checks.values()) else "smoke_failed", "checks": checks}, indent=2))


if __name__ == "__main__":
    main()
