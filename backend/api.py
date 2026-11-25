"""Small local-only HTTP API for real OpenFOAM jobs (Python standard library)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

try:
    from .openfoam.runner import run_naca0012
except ImportError:
    from openfoam.runner import run_naca0012

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "backend" / "runs"
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
SOLVER_LOCK = threading.Lock()


def runtime_status() -> dict[str, Any]:
    docker = shutil.which("docker")
    if docker:
        try:
            check = subprocess.run([docker, "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True, timeout=5)
            if check.returncode == 0:
                return {"available": True, "runtime": "docker", "version": check.stdout.strip(), "message": "Docker is ready for the OpenFOAM 11 NACA 0012 case."}
        except (OSError, subprocess.TimeoutExpired):
            pass

    if shutil.which("simpleFoam") and os.environ.get("FOAM_TUTORIALS"):
        return {"available": True, "runtime": "native", "version": os.environ.get("WM_PROJECT_VERSION", "unknown"), "message": "Native OpenFOAM is ready."}
    return {"available": False, "runtime": None, "version": None, "message": "OpenFOAM runtime unavailable. Install and start Docker Desktop, then pull the OpenFOAM 11 image; see README."}


def finish_job(job_id: str, status: str, message: str, **values: Any) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job.update(status=status, message=message, updatedAt=time.time(), **values)


def execute_job(job_id: str, angle: float, speed: float, density: float, viscosity: float) -> None:
    with SOLVER_LOCK:
        finish_job(job_id, "Running", "Preparing the official OpenFOAM 2D NACA 0012 case…")
        case_dir = RUNS / job_id / "case"
        try:
            outcome = run_naca0012(case_dir, angle, speed, density, viscosity)
            if outcome["converged"]:
                finish_job(job_id, "Completed", "OpenFOAM finished and passed the residual and force-stability checks.", **outcome)
            else:
                finish_job(job_id, "Failed", outcome["convergenceMessage"], **outcome)
        except Exception as exc:  # A solver failure is reported, never replaced with illustrative numbers.
            finish_job(job_id, "Failed", str(exc), error=str(exc))


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "WindlyLabAPI/1.0"

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/api/health":
            self._json(200, {"api": "ready", "solver": runtime_status()})
            return
        if self.path.startswith("/api/jobs/"):
            job_id = self.path.removeprefix("/api/jobs/").split("?", 1)[0]
            with JOBS_LOCK:
                job = deepcopy(JOBS.get(job_id))
            if job:
                self._json(200, job)
            else:
                self._json(404, {"error": "Unknown solver job."})
            return
        self._json(404, {"error": "Route not found."})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path != "/api/solve":
            self._json(404, {"error": "Route not found."})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size > 16_384:
                raise ValueError("Request body is too large.")
            payload = json.loads(self.rfile.read(size) or b"{}")
            angle = float(payload.get("angleOfAttackDeg", 4))
            speed = float(payload.get("airspeedMps", 30))
            density = float(payload.get("densityKgM3", 1.225))
            viscosity = float(payload.get("dynamicViscosityPaS", 1.81e-5))
            if not (-5 <= angle <= 20):
                raise ValueError("Angle of attack must be between -5° and 20°.")
            if not (1 <= speed <= 100):
                raise ValueError("Airspeed must be between 1 and 100 m/s.")
            if not (0.2 <= density <= 2.5):
                raise ValueError("Air density must be between 0.2 and 2.5 kg/m³.")
            if not (5e-6 <= viscosity <= 5e-4):
                raise ValueError("Dynamic viscosity must be between 5e-6 and 5e-4 Pa·s.")
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            self._json(400, {"error": str(exc)})
            return

        runtime = runtime_status()
        if not runtime["available"]:
            self._json(503, {"error": runtime["message"]})
            return

        job_id = uuid.uuid4().hex
        job = {"id": job_id, "status": "Queued", "message": "Waiting for the local solver…", "createdAt": time.time(), "updatedAt": time.time(), "parameters": {"airfoil": "NACA 0012", "dimension": "2D", "angleOfAttackDeg": angle, "airspeedMps": speed, "densityKgM3": density, "dynamicViscosityPaS": viscosity, "solver": "OpenFOAM simpleFoam"}}
        RUNS.mkdir(parents=True, exist_ok=True)
        (RUNS / job_id / "case").mkdir(parents=True, exist_ok=True)
        with JOBS_LOCK:
            JOBS[job_id] = job
        threading.Thread(target=execute_job, args=(job_id, angle, speed, density, viscosity), daemon=True).start()
        self._json(202, job)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[windlylab-api] {self.address_string()} - {format % args}")


def main() -> None:
    host = os.environ.get("WINDLYLAB_API_HOST", "127.0.0.1")
    port = int(os.environ.get("WINDLYLAB_API_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), ApiHandler)
    print(f"WindlyLab API listening at http://{host}:{port} (OpenFOAM jobs only; no synthetic fallback)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
