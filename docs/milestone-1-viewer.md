# Milestone 1: Viewer MVP

## Goal

Build the first working Shapespark-style viewer experience. This milestone intentionally avoids the full editor and full optimization pipeline. It proves the visible client experience and establishes the runtime foundation everything else will use.

## Deliverables

### Repo Scaffold

- pnpm monorepo.
- TypeScript config.
- Vite viewer demo app.
- Shared viewer package.
- Shared scene schema package.
- Basic lint/test commands.

### Viewer Runtime

- Load GLB/GLTF scenes.
- Render with Three.js.
- Loading screen with progress.
- Environment light fallback.
- Camera orbit/debug mode for development.
- First-person/walk mode.
- Click-to-move floor navigation.
- Blue floor marker.
- Smooth camera tweening.
- View buttons loaded from JSON.
- Floorplan/minimap overlay with saved view points.
- Hotspots loaded from JSON.
- External links loaded from JSON.
- Video texture interaction loaded from JSON.
- Object-toggle interaction loaded from JSON.
- Basic fullscreen/share/embed UI shell.
- Screenshot capture control.

### Scene Config

Initial JSON files:

- `views.json`
- `interactions.json`
- `navigation.json`
- `branding.json`

### Mobile

- Touch look/pan controls.
- Tap-to-move.
- Responsive viewer chrome.
- Orientation-safe layout.

### Quality Checks

- Desktop viewport smoke test.
- Mobile viewport smoke test.
- Scene load error handling.
- Non-overlapping UI check.
- Performance overlay in development mode.

## Acceptance Criteria

- A local demo can load a GLB scene from `/public/scenes/demo/scene.glb`.
- A user can click the floor and move with a visible blue marker.
- A user can switch between predefined room views.
- A user can jump between saved views from the minimap.
- A user can open a hotspot.
- A user can open a configured external link.
- A user can show or hide a configured object from an in-scene toggle.
- A configured video texture can play on a named material or mesh.
- The viewer is usable on desktop and mobile viewport sizes.
- Scene behavior is controlled by JSON, not hard-coded scene-specific logic.

## Suggested Implementation Order

1. Scaffold monorepo and viewer demo.
2. Add Three.js scene loader.
3. Add camera controller and view transitions.
4. Add floor raycaster and marker.
5. Add JSON schema and config loader.
6. Add hotspots.
7. Add video texture manager.
8. Add mobile controls.
9. Add smoke tests and performance overlay.

## Known Tradeoffs

- Collision can start simple with floor-plane movement and bounds checks, then move to navmesh/capsule collision.
- Lightmaps can be displayed if present, but baking belongs to Phase 5.
- Optimization can be stubbed until the pipeline exists.
- The viewer UI should be original and product-specific, not a visual copy of Shapespark.
