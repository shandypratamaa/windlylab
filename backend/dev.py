"""Launch the Vite frontend and local CFD API together; Ctrl-C stops both."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
children: list[subprocess.Popen[bytes]] = []


def stop(_signum: int | None = None, _frame: object | None = None) -> None:
    for child in children:
        if child.poll() is None:
            child.terminate()
    deadline = time.time() + 5
    for child in children:
        if child.poll() is None:
            try:
                child.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                child.kill()


def main() -> int:
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    env = os.environ.copy()
    children.append(subprocess.Popen([sys.executable, "backend/api.py"], cwd=ROOT, env=env))
    children.append(subprocess.Popen(["npm", "run", "dev", "--", "--host", "127.0.0.1"], cwd=ROOT, env=env))
    print("WindlyLab frontend and API started. Open the Vite URL; press Ctrl-C to stop both services.", flush=True)
    try:
        while True:
            failed = next((child for child in children if child.poll() is not None), None)
            if failed:
                return int(failed.returncode or 0)
            time.sleep(0.5)
    except KeyboardInterrupt:
        return 130
    finally:
        stop()


if __name__ == "__main__":
    raise SystemExit(main())
