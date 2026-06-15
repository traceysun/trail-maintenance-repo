# Trail Maintenance — source

A first-person atmospheric horror walking sim built with Three.js (vanilla ES modules,
no build step). PS1/VHS-leaning but with generated high-fidelity meshes and PBR ground.

## Run locally
It's static files, but ES-module imports and texture/GLB loading need a real HTTP
server (not file://). From this folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, VS Code Live Server, etc.).

## File map
- `index.html`   — canvas + HUD overlay + all CSS (VHS scanlines, vignette, glitch). Loads `game.js` as a module.
- `game.js`      — the whole game (~1700 lines): rendering, world build, input, audio, horror events, endings. Start here.
- `strings.js`   — all player-visible text (objectives, prompts, sign/note copy, endings). Edit copy here.
- `logic.js`     — required platform stub for the Higgsfield game host (meta/setup/validateAction/etc). Not needed to run locally.
- `vendor/`      — pinned Three.js r160 + GLTFLoader + BufferGeometryUtils (import paths already rewritten to local).
- `assets/models/*.glb` — generated meshes: trees (pine/spruce/fir), bushes, shed, outpost, cabin, signpost.
- `assets/textures/*`   — ground (floor/dirt/gravel + normal maps), grass tuft, forest backdrop.
- `assets/audio/*.mp3`  — wind, footsteps, static, hammer, brush, two dispatch voice lines.
- `design/assets.csv`   — asset manifest.

## Where things live in game.js (search for these)
- `buildTrees()`        — tree placement / density (the path-hugging corridor logic).
- `buildGrass()`        — instanced grass tufts.
- `buildBushes()`       — fern/shrub scatter.
- `buildForestBackdrop()` — the enclosing painted-forest box.
- `buildMaterials()`    — ground materials + tiling (floor/dirt/gravel share one palette).
- `buildGroundAndPath()`— ground plane + trail ribbon UVs.
- `buildParkingLot()` / `buildTrailhead()` — the start area + signs.
- `buildShed()` / `buildOutpost()` / `buildCabin()` — structures (GLB shell + collision + interactables).
- `buildBranches()`     — the fallen logs + the roll-off-the-path interaction.
- `Events` / `Phases` / `Endings` — horror beats and the two endings.
- `loadTreeMesh()` / `loadBuildingMeshes()` / `loadBushMesh()` / `loadLogMesh()` — GLB loaders (graceful procedural fallback if a file is missing).

## Notes
- All GLB textures were downsized to ~1k and the meshes kept ~5k–12k tris for web perf.
- No localStorage/sessionStorage (not supported on the host); state is in-memory.
- Deploy target was Higgsfield's game host; `logic.js` + `index.html` must sit at the zip root there.
