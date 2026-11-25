"""Run and post-process the OpenFOAM Foundation NACA 0012 tutorial case."""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from .prepare_case import prepare

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
IMAGE = os.environ.get("WINDLYLAB_OPENFOAM_IMAGE", "openfoam/openfoam11-graphical-apps")
PLATFORM = os.environ.get("WINDLYLAB_OPENFOAM_PLATFORM", "linux/amd64")


def _run(command: list[str], *, timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"OpenFOAM command timed out after {timeout // 60} minutes: {' '.join(command[:4])}") from exc


def _run_logged(command: list[str], cwd: Path, log_path: Path, timeout: int = 1800) -> None:
    with log_path.open("w", encoding="utf-8") as log:
        try:
            process = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"OpenFOAM command timed out after {timeout // 60} minutes. See {log_path}.") from exc
    if process.returncode:
        tail = "\n".join(log_path.read_text(errors="replace").splitlines()[-35:])
        raise RuntimeError(f"OpenFOAM exited with code {process.returncode}. Last log lines:\n{tail}")


def _docker_base(docker: str) -> list[str]:
    return [docker, "run", "--rm", "--platform", PLATFORM]


def _docker_prepare(docker: str, case_dir: Path, angle: float, speed: float, density: float, dynamic_viscosity: float) -> None:
    project_mount = f"{BACKEND}:/windlylab/backend:ro"
    case_mount = f"{case_dir}:/windlylab/run"
    script = (
        "set -e; source /opt/openfoam11/etc/bashrc; "
        "python3 /windlylab/backend/openfoam/prepare_case.py "
        '"$FOAM_TUTORIALS/incompressible/simpleFoam/airFoil2D" '
        f"/windlylab/run --angle {angle:.8g} --speed {speed:.8g} --density {density:.8g} --dynamic-viscosity {dynamic_viscosity:.8g}"
    )
    result = _run(_docker_base(docker) + ["-v", project_mount, "-v", case_mount, IMAGE, "bash", "-lc", script], timeout=300)
    if result.returncode:
        raise RuntimeError(f"Could not prepare the OpenFOAM tutorial case. Verify the OpenFOAM image and tutorial path.\n{result.stderr[-3000:]}")


def _docker_solve(docker: str, case_dir: Path) -> None:
    script = "set -e; source /opt/openfoam11/etc/bashrc; simpleFoam > log.simpleFoam 2>&1; postProcess -func writeCellCentres -latestTime >> log.simpleFoam 2>&1"
    result = _run(_docker_base(docker) + ["-v", f"{case_dir}:/case", "-w", "/case", IMAGE, "bash", "-lc", script], timeout=1800)
    if result.returncode:
        log = case_dir / "log.simpleFoam"
        detail = "\n".join(log.read_text(errors="replace").splitlines()[-35:]) if log.exists() else result.stderr[-3000:]
        raise RuntimeError(f"OpenFOAM solver/post-processing failed (exit {result.returncode}).\n{detail}")


def _native_solve(case_dir: Path, angle: float, speed: float, density: float, dynamic_viscosity: float) -> None:
    tutorials = os.environ.get("FOAM_TUTORIALS")
    if not tutorials:
        raise RuntimeError("FOAM_TUTORIALS is not set in the native OpenFOAM environment.")
    template = Path(tutorials) / "incompressible/simpleFoam/airFoil2D"
    prepare(template, case_dir, angle, speed, density, dynamic_viscosity)
    _run_logged(["simpleFoam"], case_dir, case_dir / "log.simpleFoam")
    _run_logged(["postProcess", "-func", "writeCellCentres", "-latestTime"], case_dir, case_dir / "log.writeCellCentres")


def _field_values(path: Path, value_kind: str) -> list[Any]:
    text = path.read_text(errors="replace")
    if value_kind == "vector":
        match = re.search(r"internalField\s+nonuniform\s+List<vector>\s+\d+\s*\((.*?)\)\s*;", text, re.S)
        if not match:
            raise RuntimeError(f"Expected nonuniform vector field in {path}.")
        return [tuple(map(float, item.groups())) for item in re.finditer(r"\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)", match.group(1))]
    match = re.search(r"internalField\s+nonuniform\s+List<scalar>\s+\d+\s*\((.*?)\)\s*;", text, re.S)
    if not match:
        raise RuntimeError(f"Expected nonuniform scalar field in {path}.")
    return [float(value) for value in re.findall(r"[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?", match.group(1))]


def _latest_time(case_dir: Path) -> Path:
    numeric = []
    for child in case_dir.iterdir():
        if child.is_dir():
            try:
                numeric.append((float(child.name), child))
            except ValueError:
                continue
    if not numeric:
        raise RuntimeError("OpenFOAM did not write a solution time directory.")
    return max(numeric, key=lambda item: item[0])[1]


def _convergence(log_path: Path) -> tuple[dict[str, float], list[float]]:
    residual_lines = re.findall(r"Solving for (\w+), Initial residual =\s*([-+\d.eE]+)", log_path.read_text(errors="replace"))
    last: dict[str, float] = {}
    history: list[float] = []
    by_step: list[dict[str, float]] = []
    current: dict[str, float] = {}
    previous_field = None
    for field, raw in residual_lines:
        value = float(raw)
        if field == "Ux" and previous_field is not None and current:
            by_step.append(current)
            current = {}
        current[field] = value
        previous_field = field
    if current:
        by_step.append(current)
    for row in by_step:
        history.append(max(row.values()))
        last.update(row)
    return last, history[-200:]


def _coefficients(case_dir: Path) -> tuple[float, float, list[dict[str, float]]]:
    files = list((case_dir / "postProcessing/windlyLabForceCoeffs").glob("*/coefficient.dat"))
    if not files:
        raise RuntimeError("OpenFOAM did not write force coefficients.")
    data = files[0].read_text(errors="replace").splitlines()
    headings: list[str] = []
    rows: list[dict[str, float]] = []
    for line in data:
        stripped = line.strip()
        if stripped.startswith("#"):
            tokens = stripped.lstrip("# ").split()
            if "Cd" in tokens and "Cl" in tokens:
                headings = tokens
            continue
        values = stripped.split()
        if headings and len(values) >= len(headings):
            try:
                row = {name: float(value) for name, value in zip(headings, values)}
            except ValueError:
                continue
            if "Cd" in row and "Cl" in row:
                rows.append(row)
    if not rows:
        raise RuntimeError("Could not parse the OpenFOAM forceCoeffs output.")
    final = rows[-1]
    return final["Cd"], final["Cl"], rows


def _extract_field(case_dir: Path, speed: float, density: float) -> tuple[list[dict[str, float]], dict[str, float]]:
    time_dir = _latest_time(case_dir)
    centres = _field_values(time_dir / "C", "vector")
    velocities = _field_values(time_dir / "U", "vector")
    pressures = _field_values(time_dir / "p", "scalar")
    if not centres or not (len(centres) == len(velocities) == len(pressures)):
        raise RuntimeError("OpenFOAM cell-centre, velocity, and pressure fields have inconsistent sizes.")
    bounds = {"xMinM": min(v[0] for v in centres), "xMaxM": max(v[0] for v in centres), "yMinM": min(v[1] for v in centres), "yMaxM": max(v[1] for v in centres)}
    stride = max(1, math.ceil(len(centres) / 1400))
    samples = []
    for index in range(0, len(centres), stride):
        x, y, _ = centres[index]
        ux, uy, _ = velocities[index]
        p_pa = pressures[index] * density  # simpleFoam p is kinematic pressure [m^2/s^2].
        samples.append({"xM": x, "yM": y, "uxMps": ux, "uyMps": uy, "speedMps": math.hypot(ux, uy), "pressurePa": p_pa})
    speeds = [sample["speedMps"] for sample in samples]
    pressures_pa = [sample["pressurePa"] for sample in samples]
    stats = {**bounds, "cellCount": len(centres), "sampleCount": len(samples), "speedMinMps": min(speeds), "speedMaxMps": max(speeds), "pressureMinPa": min(pressures_pa), "pressureMaxPa": max(pressures_pa), "timeDirectory": time_dir.name}
    return samples, stats


def run_naca0012(case_dir: Path, angle: float, speed: float, density: float = 1.225, dynamic_viscosity: float = 1.81e-5) -> dict[str, Any]:
    case_dir.mkdir(parents=True, exist_ok=True)
    docker = shutil.which("docker")
    docker_ready = False
    if docker:
        check = _run([docker, "info", "--format", "{{.ServerVersion}}"], timeout=6)
        docker_ready = check.returncode == 0

    if docker_ready:
        _docker_prepare(docker, case_dir, angle, speed, density, dynamic_viscosity)
        _docker_solve(docker, case_dir)
        runtime = "OpenFOAM Foundation 11 in Docker"
    elif shutil.which("simpleFoam") and os.environ.get("FOAM_TUTORIALS"):
        _native_solve(case_dir, angle, speed, density, dynamic_viscosity)
        runtime = f"OpenFOAM {os.environ.get('WM_PROJECT_VERSION', '')} native".strip()
    else:
        raise RuntimeError("No working OpenFOAM runtime was found. Start Docker Desktop or load a native OpenFOAM environment, then retry.")

    parameters = json.loads((case_dir / "windlylab-parameters.json").read_text())
    last_residuals, residual_history = _convergence(case_dir / "log.simpleFoam")
    cd, cl, coeff_rows = _coefficients(case_dir)
    samples, field_stats = _extract_field(case_dir, speed, parameters["densityKgM3"])

    required_residuals = [last_residuals.get("p", math.inf), last_residuals.get("Ux", math.inf), last_residuals.get("Uy", math.inf)]
    turbulence_residuals = [value for key, value in last_residuals.items() if key not in {"p", "Ux", "Uy", "Uz"}]
    if turbulence_residuals:
        required_residuals.extend(turbulence_residuals)
    residual_ok = max(required_residuals) <= 1e-4 and last_residuals.get("Ux", math.inf) <= 1e-5 and last_residuals.get("Uy", math.inf) <= 1e-5
    coefficient_window = coeff_rows[-20:]
    stable = len(coefficient_window) == 20 and all(
        abs(coefficient_window[-1][name] - coefficient_window[0][name]) / max(abs(coefficient_window[-1][name]), 0.01) <= 0.01
        for name in ("Cd", "Cl")
    )
    converged = residual_ok and stable
    reason = "Residual thresholds and the final 20 force-coefficient samples passed the convergence checks." if converged else (
        f"Solver completed, but convergence was not established (final residuals: {last_residuals}; force coefficient window stable: {stable}). No validated result values are being published."
    )
    q = 0.5 * parameters["densityKgM3"] * speed**2
    results = {"dragCoefficient": cd, "liftCoefficient": cl, "dragN": cd * q * parameters["spanM"], "liftN": cl * q * parameters["spanM"], "reynoldsNumber": speed * parameters["chordM"] / parameters["nuM2PerS"], "source": "openfoam", "runtime": runtime, "converged": converged, "finalResiduals": last_residuals, "coefficientSamples": len(coeff_rows), "forceStable": stable}
    return {"converged": converged, "convergenceMessage": reason, "results": results if converged else None, "convergenceHistory": residual_history, "flowField": {"samples": samples, "statistics": field_stats, "pressureMeaning": "Gauge pressure from OpenFOAM kinematic p multiplied by rho=1.225 kg/m^3.", "velocityMeaning": "Cell-centre velocity vectors from the final OpenFOAM solution."}, "parameters": parameters}
