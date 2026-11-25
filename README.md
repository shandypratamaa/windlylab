# WindlyLab

WindlyLab is a virtual smoke tunnel that runs in the browser. A lattice Boltzmann CFD solver computes 2D incompressible Navier–Stokes flow around airfoils, cars, and basic shapes; realistic smoke shows the flow, and a live analysis explains what is happening (attached flow, trailing-edge separation, stall, vortex shedding). Drag and lift are measured from the solved flow. An optional local OpenFOAM runner can cross-check a NACA 0012 at full-scale Reynolds number.

Everything except the OpenFOAM runner works as a static site with no backend.

## Solver (`src/physics/lbm/`, run in a Web Worker from `src/features/cfd/`)

- **Method:** D2Q9 lattice Boltzmann, BGK collision with a Smagorinsky large-eddy subgrid model (C = 0.16).
- **Walls:** interpolated bounce-back (Bouzidi, Firdaouss & Lallemand 2001) using the exact wall distance on every boundary link, so curved surfaces are not staircased. Vehicles sit on a moving ground belt.
- **Boundaries:** velocity inlet (equilibrium ghost nodes with local density so the prescribed flux is delivered), zero-gradient outlet with a viscous sponge, and absorbing far-field layers that relax towards the free stream and soak up pressure waves.
- **Forces:** momentum exchange on gauge populations. Coefficients are time-averaged after the start-up transient (1.2 tunnel flow-throughs from a fresh start). Changes to an already developed flow (angle, slat, flap, scale) only wait as long as the change needs: 0.45 flow-throughs for small angle tweaks, up to ~1 for deploying flaps; the averages keep refining afterwards; the panel also reports Strouhal number (from lift zero-crossings), lift rms, L/D, and blockage.
- **Air properties:** density from the ideal-gas law; viscosity from Sutherland's law at the chosen temperature.
- **Multi-core:** when the page is cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, set by the Vite dev and preview servers), the lattice is split into bands of rows that helper workers advance in lockstep over `SharedArrayBuffer`s (2 / 3 / 4 helpers for Low / Medium / High). Results are bit-identical to the single-threaded path; the High grid settles about 2–3× faster. Without isolation the solver runs on one thread.

### Geometry and tunnel size

- **Model scale** resizes the body inside the solver grid. At 1× every model blocks under 5% of the tunnel height (wings ≈4%, cars and bluff bodies ≈4.5%); larger scales raise blockage and the live readout shows it. Wings get a fixed number of cells per chord (56 / 72 / 100 for Low / Medium / High); bluff bodies and cars get a fixed number of cells across their frontal height (9 / 12 / 18), with the tunnel length sized to the body. The grid depends only on model and resolution, so scale, angle, slats, flaps and rear-wing angle change without restarting the flow.
- **Rear wing angle** tilts the spoiler lip or rear wing of the spoiler, large-wing and race cars independently.
- **Airliner wing (the only aircraft model):** a classic airliner high-lift section. Stowed (cruise), the slat forms the airfoil's nose and the double-slotted flap's two elements nest in the cove under the main element's thin trailing-edge shroud, so the section is the clean airfoil. Deploying the slat slides it forward and droops it; deploying the flaps runs the fore flap aft and down on its track while the smaller aft flap deflects about 1.6× as far. Slots open from sealed to exactly 3% of chord within the first ~6° and stay that wide. Flight modes (sidebar box): **Cruise** levels off where the aircraft is; **Climb** and **Descend** go from the start altitude (the same as the flight panel's initial altitude, 3,000 m by default) up or down by the chosen change at the chosen rate of climb/descent (1–20 m/s, shown in ft/min too), and level off exactly. In every mode the angle of attack, slat and flaps adjust automatically. The box shows the route, rate and time to the target (from a dry run of the same controller), warns when the wing can't manage the rate at this speed and gives the minimum airspeed when it can't fly at all. Changing the start altitude during a climb/descent restarts the flight and moves the target; a warning says so in the box and under the flight panel's initial-altitude slider. Clicking the active mode again, or moving the angle/slat/flap sliders by hand, returns to flying by hand. If even landing flaps cannot carry the weight, the mode gives the minimum airspeed. The airliner defaults to 700 km/h. A single-slotted flap option remains. Slat is drawn blue and flaps red, as in standard high-lift diagrams.
- **Airspeed** is set in km/h up to 900 km/h. Above ~370 km/h (Mach 0.3) real air compresses, and above Mach ~0.7 a real wing forms shocks; the solver is incompressible, and the UI says so.
- **Flight simulation (optional, aircraft only):** a panel under the tunnel. When on, the air comes from the International Standard Atmosphere at the aircraft's altitude (initial altitude slider, 0–13,000 m). It shows temperature, pressure, density, true/equivalent airspeed, Mach and dynamic pressure, and turns the CFD section lift into whole-aircraft lift (360 m² wing, aspect ratio 9.5, lifting-line correction) against weight (mass slider). **Autopilot (altitude hold)** is a separate mode, off by default and never switched on by Cruise/Climb/Descend. Turning it on replaces the active mode and asks for the altitude to hold (prefilled with the current altitude, with one-click choices for the current and initial altitude). It flies there at the chosen vertical speed and holds it. Each 0.02 s of flight time the controller picks a vertical speed (easing off over the last ~100 m so it levels off exactly with no overshoot), works out the lift that gives it, including the angle the wing loses while climbing (w/V), and sets the angle of attack, slat and flaps that make that lift, extending or retracting them as needed. Flight lift comes from the measured lift lines for the configuration that is set, corrected live by the settled CFD lift; hand-set slat/flap angles use the CFD lift directly. With the autopilot off the wing stays as set and the aircraft drifts, with climb-induced loss of angle of attack as damping, to where lift equals weight. Flight time runs faster than real time (Time speed slider, 1×–60×, default 20×); it changes only how long you wait on screen, so the box and panel show both the flight time to a target and the on-screen time at the current speed. Because the tunnel simulates low Reynolds number, its lift is lower than a full-size wing's, so the airliner usually needs more angle, flap or speed than in reality.
- **Smooth motion:** sliders stream values every 80 ms while dragging; the body eases towards them on the wall clock (pitch 40°/s, slat/flap/wing 90°/s, scale ×2/s), rebuilt every 8 lattice steps, and the renderer interpolates the drawn body between updates. Measured in the browser on the High grid: the flap moves 1–3 px per frame at ~86 fps and settles ~0.2 s after the slider is released.
- **Air conditions:** temperature and static pressure set density (ideal gas) and viscosity (Sutherland). With *Reynolds number → Match real air* (default) the simulated Re is the real one for the current speed, size, temperature and pressure, capped at what the grid can resolve; forces per span always use the real density. Full-size conditions (Re ~10⁶–10⁷) exceed the cap, so there they change forces and the displayed Re but not the flow pattern — slower, smaller or thinner/warmer air brings Re under the cap and changes the flow too.
- **Cars** are a 2D slice through the centreline. The wheels are drawn but not solid (they sit at the sides, so the slice passes between them), and the body is raised if needed to keep at least 3 cells of air under the floor; a thinner gap chokes the underbody flow and pushed the large-wing car to a spurious Cl ≈ 9. Extra smoke wands are aimed under the floor, at the nose, bonnet, windscreen and roof, and either side of a spoiler or wing. The sports car (and its spoiler, wing and race versions) is a low coupe with a ~27° windscreen. Measured on the Medium grid without side relief (Cd / Cl): SUV 0.68 / 1.55, coupe 0.80 / 1.11, sports 0.81 / 1.56, spoiler 0.86 / 2.13, large wing 0.73 / 0.43, race 0.86 / −0.71 (downforce). 2D slices read more drag and lift than 3D cars.
- **Side relief (2.5D)**, for cars: around the car and in its near wake, local pressure relaxes towards ambient (a mass bleed) at a rate scaled by speed over car width, standing in for air escaping around the sides of a real car. With air flowing under the floor its effect is mixed (it lowers lift for some cars and raises it for others) and within the run-to-run wobble for several. It is an approximation, not a 3D simulation.
- **View:** scroll to zoom, drag to pan, and click to add a smoke injector. On-screen buttons zoom, focus on the model, or show the whole tunnel. The smoke rake is concentrated around the model.

### Realistic smoke

Smoke wands release a passive dye that is advected with the solved velocity using a bounded second-order MacCormack semi-Lagrangian scheme. It is drawn as optical density over a dark tunnel, like a photographed smoke tunnel. Streakline particles and velocity, vorticity, and pressure-coefficient fields are also available. The Cp map runs blue (low pressure) → white (ambient) → red (high pressure); smoke is drawn dark over it. Click the flow to add an injector; hover to probe local speed, Cp, and flow angle.

### Flow analysis

For airfoils and plates the simulation samples the flow two cells off the surface along the chord, keeps a time-averaged tangential velocity per chord station, and reports where reversed flow begins on the suction side. `src/features/cfd/flow-insights.ts` turns that, together with the force history, into short, everyday-language descriptions ("The wing is stalling", "Swirls are breaking off left and right", "The car is being lifted"), with the numbers in a small line underneath. A popup appears when the headline state changes and holds for 1.5 s.

### What the numbers mean

The solver runs at a **simulated Reynolds number** (about 2,500–11,000 at most, depending on body and grid), not the physical Reynolds number of a full-size wing or car (10⁶–10⁷). Coefficients describe low-Re 2D flow: drag runs higher and stall comes earlier than full-scale data. Forces per metre of span apply those coefficients to your air density, speed, and reference length. Car results are a 2D centreline slice with no sideways relief, so they are far above 3D vehicle values and best read qualitatively. Mach numbers above 0.3 are flagged because the solver is incompressible.

### Validation

`tests/lbm.test.mjs` runs the Schäfer–Turek 2D-1 benchmark (cylinder in a channel, Re = 20; reference Cd = 5.5795, Cl = 0.0106). With 16 cells across the cylinder and interpolated walls the solver gives Cd ≈ 5.80 (+3.9%) and Cl ≈ 0.011; plain halfway bounce-back gives +8%. A cylinder at Re = 100 sheds a von Kármán street with St ≈ 0.19 at 14% blockage (unconfined reference ≈ 0.165). Other tests cover inlet flux, zero lift on a symmetric section at 0°, positive lift at incidence, separation detection (attached at 0°, leading-edge separation at 16°), bounded smoke, and the flow descriptions.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- Python 3 (the API uses the standard library; no pip packages are required)
- Docker Desktop for Mac with the Docker engine running, or a native OpenFOAM environment exposing `simpleFoam` and `FOAM_TUTORIALS`

## Local development

Install Docker Desktop for Mac if needed, start it, then pull the OpenFOAM Foundation image:

```sh
docker pull --platform linux/amd64 openfoam/openfoam11-graphical-apps
```

The image contains the official OpenFOAM 11 `simpleFoam` application and tutorial library. On Apple Silicon, Docker Desktop runs the published Linux/amd64 image through its compatibility support.

Install frontend packages and start both local services from the WindlyLab folder:

```sh
npm ci
npm run dev:all
```

Open the Vite URL printed in the terminal. The API listens only on `127.0.0.1:8000`; Vite proxies `/api` to it. `Ctrl-C` stops both services. `GET /api/health` reports whether the API can reach Docker/OpenFOAM. If the runtime is absent, the browser solver still works and the OpenFOAM button stays disabled.

Open the wind tunnel, pick a wing section, set airspeed and angle of attack, and use **Run NACA 0012 in OpenFOAM** in the cross-check panel. The backend copies the official `airFoil2D` tutorial case into `backend/runs/<job-id>/`, applies the selected flow settings, runs `simpleFoam`, extracts the cell-centre pressure/velocity field and force coefficients, and checks equation residuals plus the final 20 force-coefficient samples. Only a solver run that exits successfully and passes both checks is shown as a completed result. Failed or unconverged runs show diagnostics only. Job files and logs stay under the ignored `backend/runs/` folder.

Run `npm run typecheck` to check the strict TypeScript project, `npm run build` to create the static site in `dist/`, and `npm run preview` to serve that production build locally. The GitHub Pages deployment includes only the frontend; it cannot run OpenFOAM, and the local API is not exposed by the Pages site.

## Deployment (Vercel)

Live site: https://windlylab.vercel.app

The site is a static Vite build. `vercel.json` sets the build (`npm run build` → `dist`) and sends the two cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) so the browser allows `SharedArrayBuffer` and the solver runs on several cores. Every push to `main` deploys automatically once the GitHub repository is imported into Vercel.

The OpenFOAM cross-check needs the local Python API (`npm run dev:all`), so it is only shown when WindlyLab runs on localhost; the hosted site hides it.

## Project map

- `src/app/` — simulator shell and controls
- `src/features/model-library/` — built-in model definitions
- `backend/` — local-only Python API, OpenFOAM tutorial case preparation, runner, and combined dev launcher
- `src/features/solver/` — API adapter and renderer for actual solver-sampled pressure and velocity fields
- `src/physics/lbm/` — lattice Boltzmann solver, body geometry and rasteriser, simulation wrapper (smoke, force statistics)
- `src/features/cfd/` — CFD Web Worker, message protocol, canvas renderer, colour maps, and flow-insight descriptions
- `src/physics/aerodynamic-formulas.ts` — SI atmosphere and similarity formulas (ideal-gas density, Sutherland viscosity, Re, Mach)
- `src/types/` — model, setting, flow-field, result, and solver contracts

Body shapes are generic 2D sections (NACA 4-digit airfoils, primitives, and simplified vehicle side profiles), not replicas of production geometry.
