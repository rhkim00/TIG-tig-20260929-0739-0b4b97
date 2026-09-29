"""Drive the installed CLI in a real PTY; fixtures replace only external services."""
import errno
import json
import os
import pty
import re
import select
import signal
import subprocess
import sys
import time

spec = json.loads(open(sys.argv[1], encoding="utf-8").read())
master, slave = pty.openpty()
child = subprocess.Popen(spec["command"], stdin=slave, stdout=slave, stderr=slave,
                         cwd=spec["cwd"], start_new_session=True)
os.close(slave)
output = ""
pending = ""
index = 0
deadline = time.monotonic() + 45
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536).decode("utf-8", errors="replace")
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output += data
            pending += data
            plain = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", pending)
            if index < len(spec["steps"]):
                step = spec["steps"][index]
                # Wait until readline's input marker is displayed, not just the label.
                if step["expect"] in plain and "❯" in plain.split(step["expect"], 1)[1]:
                    os.write(master, step["send"].encode())
                    index += 1
                    pending = ""
        if child.poll() is not None:
            break
    if child.poll() is None:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass  # still waiting on a prompt: report the transcript below
    if child.returncode != 0 or index != len(spec["steps"]):
        raise RuntimeError(f"CLI exit={child.returncode}; answered={index}/{len(spec['steps'])}\n{output}")
    print(output)
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
    os.close(master)
