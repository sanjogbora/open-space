# Current Status

## Navigation

The viewer currently supports the core walkthrough navigation loop:

- Click or tap a floor mesh to move.
- A blue floor marker appears at the selected destination.
- The camera eases toward the clicked point.
- If a clicked point is slightly outside a walk zone, the viewer now searches nearby reachable floor points before failing.
- Door/opening clicks keep a projected floor target for routing or repair even when the first target is outside the current walk zone.
- Viewer repair links include camera position so Studio can orient door-pass repair zones toward the attempted route.
- Studio door-pass repair can also add a missing target-side walk patch so the clicked room becomes reachable.
- Viewer movement stabilizes floor height so tiny ridges and threshold geometry do not make the camera bounce as aggressively.
- Viewer movement resolves bounded step-up/step-down floor changes so thresholds and simple stairs are smoother while larger vertical jumps are blocked.
- Viewer navigation failures now distinguish oversized step/level changes from ordinary wall or route blocks.
- Click-to-move now rejects most flat furniture/cupboard surfaces unless they are part of the generated floor/navigation surfaces.
- Straight click routes can fall back to route waypoints and grid pathfinding around blocked spans.
- Predefined room/view buttons move the camera to saved views.
- A floorplan/minimap overlay tracks camera position and can jump to saved views.
- Studio hides generated navigation zones by default so normal repairs focus on manual walk/pass/block patches.
- Studio has an Auto Fix navigation action that can set graph bounds, add boundary blocks, add walk patches from saved views, and bridge close navigation islands.
- Viewer initial-camera repair avoids likely exterior/grass planes when it can recover to a better navigation surface.
- Viewer doorway recovery treats named/transparent door panels as portal surfaces, then validates the floor beyond through normal bounds and route checks.
- Bundle analysis warns when the first camera view appears to start on a dominant exterior/terrain plane.
- Top views can hide ceiling/roof shell meshes so uploaded apartments are inspectable from above.
- Movement is constrained by configured scene bounds.
- Basic collision boxes are generated from configured collision mesh names.
- Keyboard movement works with WASD/arrow keys.
- Left-click drag, right-click drag, and touch drag look around.
- Mobile tap and drag-look controls are present.
- Movement behavior is now driven by `controls.json`.
- Studio has a Controls tab for enabling/disabling WASD, click-to-move, drag-look, speed, step thresholds, sensitivity, and click threshold.
- Studio navigation repair now shows a recommended plain-English fix from the viewer failure reason.
- Studio navigation zones now default to readable walk/pass/block cards with raw coordinates hidden under Advanced.
- Studio zone map now has paint tools for adding walk areas, door passes, and blockers visually.
- Viewer supports runtime material variant controls from the scene manifest.
- Viewer supports hotspot, link, video texture, material variant, object-toggle, and object-pick interactions.
- Viewer has share, copy-embed, fullscreen, and screenshot controls.
- Viewer exposes camera pose for UI overlays and external integrations.
- Studio can upload a replacement GLB through the local API and rerun bundle analysis.
- Analyzer now generates `optimization.json` with mobile, balanced, and desktop budget profiles.
- Optimizer now emits `scene.optimized.glb` and `optimization-job.json`.
- Optimizer now keeps `optimization-history.json` for recent job history.
- Optimizer now runs glTF Transform cleanup plus `EXT_meshopt_compression`.
- Optimizer now creates WebP transfer textures and can create KTX2/Basis textures when `toktx` is installed.
- API can run optimization jobs and apply the optimized model to the manifest.
- API and Studio can switch a project between original and optimized GLB sources.
- Studio has an Optimization tab with profile warnings, recommendations, job trigger, and last-job results.
- API lists projects and creates new projects by cloning the demo bundle.
- Studio sidebar can switch between project bundles.
- API publishes versioned static scene bundles.
- Studio has a Publish tab with draft URL, published URLs, embed snippets, and version history.
- Reimport analysis preserves material edits and object visibility by stable material/object names.
- Viewer supports in-viewport object picking with object/material details.
- Studio Interactions can create and edit hotspots, external scene links, and object toggles.
- Analyzer inspects embedded GLB image payloads for dimensions, invalid buffer references, and unsupported MIME types.
- API upload validation rejects malformed GLB containers with broken lengths, truncated chunks, invalid JSON chunks, or non-glTF 2.0 assets.
- API texture repair scores duplicate loose texture candidates by relative path and texture-folder context before copying.
- Import diagnostics now flag models that have materials but no texture/image definitions, which helps explain flat or poor-looking imports.
- Studio Import shows recommended next actions so non-technical users do not need to interpret every diagnostic manually.
- Studio/API expose Blender/Cycles lightmap bake jobs with quality presets, UV2 generation, generated lightmap assets, and material assignment.

Current limitations:

- Collision is box-based, not a full navmesh/capsule controller.
- No stair/level transition logic yet.
- Floor-plan authoring is still basic: zones can be painted and dragged, but not yet drawn as polygons.
- Pathfinding is still an internal generated grid/waypoint fallback, not an authored production navmesh.
- No polygon navmesh editor yet.

## Implemented Product Foundation

- Viewer SDK with GLB loading.
- Scene bundle manifest.
- Embedded viewer mode and embed script.
- Demo GLB scene.
- Scene analyzer with size, mesh, material, vertex, and triangle stats.
- Generated optimization budget report.
- Generated `scene.graph.json`.
- Generated `materials.json`.
- Generated `objects.json`.
- Generated `controls.json`.
- Embedded GLB texture dimensions and image-buffer diagnostics in generated stats.
- Generated `optimization-job.json` after optimization jobs.
- Generated `optimization-history.json` after optimization jobs.
- Studio app with Overview, Views, Interactions, Materials, Objects, and Bundle sections.
- Studio Publish tab for local static bundle publishing.
- Studio Variants tab for editing material finish sets and color options.
- Studio Interactions tab for hotspot, link, and object-toggle editing.
- Local API for reading/writing the manifest, materials, objects, and controls documents.
- Local API endpoint for replacing the demo GLB model and regenerating stats.
- Local API endpoint for running and applying optimization jobs.
- Viewer registers the Meshopt decoder so optimized GLBs load in-browser.
- Viewer registers the KTX2 loader so `KHR_texture_basisu` optimized textures can load in-browser.
- Hotspot, link, object-toggle, and video texture support.
- Runtime material override loading.
- Runtime material variant switching.
- Viewer can relight unlit/flat GLTF materials as standard lit materials, with a Studio toggle to disable it when a source intentionally uses flat rendering.
- Viewer generates runtime vertex normals for meshes that lack normal attributes, improving lighting on rough exports.
- Runtime object inspection panel.
- Visual smoke tests for desktop/mobile viewer and Studio.
- Automatic Blender lightmap bake job and manual lightmap upload workflow.

## Major Work Remaining

- FBX/OBJ/DAE conversion pipeline.
- SketchUp/Revit/3ds Max exporters.
- Dedicated KTX2 normal-map profile and more texture quality controls.
- Draco compression as an optional alternative to Meshopt.
- Mesh simplification.
- Draw-call optimization and safe mesh merging.
- Production-grade bake farm scheduling, denoise/artifact repair, and light editing.
- Material texture maps, normal maps, emissive maps, UV controls, and texture-backed variants.
- Studio-linked in-viewport object editing and placement tools.
- Full navmesh/capsule controller with stair and multi-level handling.
- Polygon-based floor-plan/navigation-zone painting UI.
- Robust reimport identity matching across renamed/restructured models.
- Durable project/account backend.
- Multi-project API and database persistence.
- Cloud storage and production publish hosting.
- CDN hosting and custom domains.
- Analytics.
- Collaboration and 3D meetings.
