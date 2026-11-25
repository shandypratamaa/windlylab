"""Prepare the versioned OpenFOAM Foundation airFoil2D tutorial for a job."""

from __future__ import annotations

import argparse
import math
import re
import shutil
from pathlib import Path


def dictionary_blocks(text: str) -> list[tuple[str, int, int]]:
    """Return named OpenFOAM dictionary spans using balanced braces."""
    found: list[tuple[str, int, int]] = []
    for match in re.finditer(r"(?m)^\s*([\w.\-]+)\s*\n\s*\{", text):
        open_brace = text.find("{", match.start(), match.end())
        depth = 0
        for index in range(open_brace, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    found.append((match.group(1), open_brace, index + 1))
                    break
    return found


def block_content(text: str, name: str) -> tuple[int, int] | None:
    for key, start, end in dictionary_blocks(text):
        if key == name:
            return start, end
    return None


def parse_patches(boundary_text: str) -> dict[str, str]:
    patches: dict[str, str] = {}
    for name, start, end in dictionary_blocks(boundary_text):
        block = boundary_text[start:end]
        if re.search(r"\btype\s+\w+\s*;", block):
            patches[name] = re.search(r"\btype\s+(\w+)\s*;", block).group(1)  # type: ignore[union-attr]
    return patches


def set_vector_field(field_text: str, vector: tuple[float, float, float], wall_names: set[str]) -> str:
    formatted = f"({vector[0]:.9g} {vector[1]:.9g} {vector[2]:.9g})"
    field_text = re.sub(r"(internalField\s+uniform\s+)\([^)]*\)", rf"\g<1>{formatted}", field_text, count=1)
    boundary = block_content(field_text, "boundaryField")
    if not boundary:
        raise RuntimeError("The tutorial U field has no boundaryField dictionary.")
    start, end = boundary
    body = field_text[start:end]
    for name, patch_start, patch_end in reversed(dictionary_blocks(body)):
        if name in wall_names or name in {"frontAndBack", "front", "back"}:
            continue
        patch = body[patch_start:patch_end]
        if re.search(r"\btype\s+(?:fixedValue|freestream)\s*;", patch):
            patch = re.sub(r"((?:freestreamValue|value)\s+uniform\s+)\([^)]*\)", rf"\g<1>{formatted}", patch)
            body = body[:patch_start] + patch + body[patch_end:]
    return field_text[:start] + body + field_text[end:]


def add_dictionary_entry(text: str, parent: str, entry: str) -> str:
    span = block_content(text, parent)
    if not span:
        return text.rstrip() + f"\n{parent}\n{{\n{entry}\n}}\n"
    start, end = span
    if re.search(r"\bresidualControl\s*\{", text[start:end]):
        return text
    insert_at = end - 1
    return text[:insert_at] + "\n" + entry + "\n" + text[insert_at:]


def add_function_objects(control: str, patch: str, angle: float, speed: float, density: float, span: float) -> str:
    radians = math.radians(angle)
    drag = (math.cos(radians), math.sin(radians), 0.0)
    lift = (-math.sin(radians), math.cos(radians), 0.0)
    functions = f"""
    windlyLabForceCoeffs
    {{
        type            forceCoeffs;
        libs            (\"libforces.so\");
        patches         ({patch});
        rho             rhoInf;
        rhoInf          {density:.9g};
        pRef            0;
        liftDir         ({lift[0]:.9g} {lift[1]:.9g} 0);
        dragDir         ({drag[0]:.9g} {drag[1]:.9g} 0);
        pitchAxis       (0 0 1);
        CofR            (0.25 0 0);
        magUInf         {speed:.9g};
        lRef            1;
        Aref            {span:.9g};
        executeControl  timeStep;
        executeInterval 1;
        writeControl    timeStep;
        writeInterval   10;
    }}
"""
    span_functions = block_content(control, "functions")
    if span_functions:
        start, end = span_functions
        return control[:end - 1] + functions + control[end - 1:]
    return control.rstrip() + "\nfunctions\n{\n" + functions + "}\n"


def prepare(template: Path, case: Path, angle: float, speed: float, density: float, dynamic_viscosity: float) -> None:
    if not template.is_dir():
        raise RuntimeError(f"OpenFOAM tutorial case not found: {template}")
    if any(case.iterdir()):
        shutil.rmtree(case)
    case.mkdir(parents=True, exist_ok=True)
    shutil.copytree(template, case, dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.foam", "*.OpenFOAM"))

    boundary_path = case / "constant/polyMesh/boundary"
    if not boundary_path.exists():
        raise RuntimeError("The OpenFOAM airFoil2D tutorial is missing its prebuilt mesh.")
    patches = parse_patches(boundary_path.read_text())
    walls = {name for name, kind in patches.items() if kind == "wall"}
    if not walls:
        raise RuntimeError("Could not identify the airfoil wall in the tutorial mesh.")
    wall = sorted(walls)[0]

    velocity = (speed * math.cos(math.radians(angle)), speed * math.sin(math.radians(angle)), 0.0)
    u_path = case / "0/U"
    if not u_path.exists():
        raise RuntimeError("The tutorial is missing its initial velocity field (0/U).")
    u_path.write_text(set_vector_field(u_path.read_text(), velocity, walls))

    control_path = case / "system/controlDict"
    control = control_path.read_text()
    control = re.sub(r"(application\s+)\w+\s*;", r"\1simpleFoam;", control, count=1)
    control = re.sub(r"(endTime\s+)[-+\d.eE]+\s*;", r"\g<1>2500;", control, count=1)

    transport_path = case / "constant/transportProperties"
    transport = transport_path.read_text()
    nu = dynamic_viscosity / density
    if not re.search(r"\bnu\s+\[[^\]]+\]\s+[-+\d.eE]+\s*;", transport):
        raise RuntimeError("Could not find the tutorial's kinematic viscosity (nu) in transportProperties.")
    transport = re.sub(r"(\bnu\s+\[[^\]]+\]\s+)[-+\d.eE]+(\s*;)", rf"\g<1>{nu:.9g}\2", transport, count=1)
    transport_path.write_text(transport)

    points_text = (case / "constant/polyMesh/points").read_text()
    points = [tuple(map(float, m.groups())) for m in re.finditer(r"\(\s*([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s*\)", points_text)]
    span = max((p[2] for p in points), default=0.01) - min((p[2] for p in points), default=0)
    if span <= 0:
        raise RuntimeError("The tutorial mesh is not extruded as a 2D one-cell-thick mesh.")
    control = add_function_objects(control, wall, angle, speed, density, span)
    control_path.write_text(control)

    solution_path = case / "system/fvSolution"
    if solution_path.exists():
        solution = solution_path.read_text()
        solution = add_dictionary_entry(solution, "SIMPLE", """        residualControl
        {
            p               1e-5;
            U               1e-6;
            \"(k|epsilon|omega|nuTilda)\" 1e-5;
        }""")
        solution_path.write_text(solution)

    (case / "windlylab-parameters.json").write_text(json_dumps({"airfoil": "NACA 0012", "dimension": "2D", "angleOfAttackDeg": angle, "airspeedMps": speed, "densityKgM3": density, "dynamicViscosityPaS": dynamic_viscosity, "nuM2PerS": nu, "chordM": 1.0, "airfoilWall": wall, "spanM": span}))


def json_dumps(value: object) -> str:
    import json
    return json.dumps(value, indent=2) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("template", type=Path)
    parser.add_argument("case", type=Path)
    parser.add_argument("--angle", type=float, default=4)
    parser.add_argument("--speed", type=float, default=30)
    parser.add_argument("--density", type=float, default=1.225)
    parser.add_argument("--dynamic-viscosity", type=float, default=1.81e-5)
    args = parser.parse_args()
    prepare(args.template, args.case, args.angle, args.speed, args.density, args.dynamic_viscosity)
    print(f"Prepared NACA 0012 2D case in {args.case}")


if __name__ == "__main__":
    main()
