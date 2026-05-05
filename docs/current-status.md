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
- Auto-generated walk zones now fall back to detected floor geometry when they miss a valid room floor, while authored zones remain strict.
- Viewer movement stabilizes floor height so tiny ridges and threshold geometry do not make the camera bounce as aggressively.
- Viewer movement resolves bounded step-up/step-down floor changes so thresholds and simple stairs are smoother while larger vertical jumps are blocked.
- Viewer navigation failures now distinguish oversized step/level changes from ordinary wall or route blocks.
- Viewer exposes height-glide and floor-bump controls so imported models with ridges or raised thresholds can be tuned without code changes.
- Click-to-move now rejects most flat furniture/cupboard surfaces unless they are part of the generated floor/navigation surfaces.
- Straight click routes can fall back to route waypoints and grid pathfinding around blocked spans.
- Grid fallback routes now cache sampled floor height per cell, reject over-height step transitions, and slightly prefer level routes to reduce camera bouncing over ridges or multi-level gaps.
- Predefined room/view buttons move the camera to saved views.
- A floorplan/minimap overlay tracks camera position and can jump to saved views.
- Studio hides generated navigation zones by default so normal repairs focus on manual walk/pass/block patches.
- Studio has an Auto Fix navigation action that can set graph bounds, add boundary blocks, add walk patches from saved views, and bridge close navigation islands.
- Studio surfaces TV/video screen planning in Interactions with mapped candidate counts and one-click likely screen mapping.
- Bundle analysis and publish readiness warn when planned video screens have no source or no valid target surface.
- Studio surfaces room/floorplan mapping status with room counts, linked walk views, and one-click room sync.
- Bundle analysis warns about duplicate object/material names that can make interaction targeting ambiguous after import.
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
- Studio now starts navigation repair with a guided setup card before the detailed zone editor.
- Studio zone map now has paint tools for adding walk areas, door passes, and blockers visually.
- Imported auto-walk generation now rejects obvious furniture/decor/door/window/ceiling/roof surfaces and labels generic flat surfaces as detected walk surfaces instead of exposing confusing source mesh names.
- Bundle analysis now warns when existing generated walk zones appear to sit on non-floor objects, so Studio can explain confusing navigation repair results.
- Studio zone map now supports click-to-add polygon drawing for walk, pass, and block zones before fine-tuning vertices.
- Studio can drag polygon vertices directly on the zone map, insert points from edge handles, and Advanced zone editing can still edit polygon X/Z points.
- Studio Auto Fix can add detected door/pass zones from likely door, opening, passage, and threshold meshes.
- Navigation zones can now store polygon footprints in addition to rectangles, and the viewer/analyzer/Studio map honor polygon walk/pass/block zones.
- Viewer route planning now uses polygon zone centroids, inset corners, and edge midpoints as route candidates instead of treating polygon zones like rectangles.
- Viewer prunes routed click-to-move paths after visibility/grid routing so movement glides through fewer unnecessary intermediate waypoints.
- Viewer grid fallback now validates each neighbor movement segment, so fallback routes do not pass through thin walls between legal sample points.
- Viewer mouse-wheel forward/back movement now decays blocked impulses quickly instead of repeatedly pushing into walls or invalid floor.
- Viewer collision now uses swept segment checks against inflated blocker bounds so movement and route validation cannot skip through thin walls between sampled positions.
- Viewer supports runtime material variant controls from the scene manifest.
- Viewer supports hotspot, link, video texture, material variant, object-toggle, and object-pick interactions.
- Viewer has share, copy-embed, fullscreen, and screenshot controls.
- Viewer exposes camera pose for UI overlays and external integrations.
- Studio has environment presets for interior walkthroughs, exterior grass context, and neutral model review.
- Studio can upload a replacement GLB through the local API and rerun bundle analysis.
- Studio/API can upload direct FBX, OBJ, or DAE files and convert them to GLB through Blender when `BLENDER_PATH` is available.
- Studio/API can upload ZIP archives containing FBX, OBJ, or DAE source models with sidecar texture/material folders and convert the selected source scene to GLB through Blender.
- Studio Import shows source-conversion job status, selected source file, Blender failure messages, and conversion steps.
- Failed source conversions return the conversion job in the API error response so Studio can show the Blender/setup failure instead of only a generic upload error.
- Analyzer now generates `optimization.json` with mobile, balanced, and desktop budget profiles.
- Optimizer now emits `scene.optimized.glb` and `optimization-job.json`.
- Optimizer now keeps `optimization-history.json` for recent job history.
- Optimizer now runs glTF Transform cleanup plus `EXT_meshopt_compression`.
- Optimizer can safely join compatible unnamed primitives for mobile/balanced profiles to reduce draw calls while preserving named objects for targeting.
- Optimizer can simplify heavy geometry for mobile and balanced profiles while preserving desktop source geometry.
- Optimizer now creates WebP transfer textures and can create KTX2/Basis textures when `toktx` is installed, including high-quality UASTC compression for normal/alpha maps.
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
- Failed Blender/Cycles bakes return the bake job in the API error response so Studio can show the failed stage and job steps.

Current limitations:

- Collision is still box-based, but movement now uses swept checks; it is not yet a full navmesh/capsule controller.
- Floor-plan authoring is still basic compared with a production navmesh editor, but zones can now be drawn as polygons and fine-tuned on the map.
- Pathfinding is still an internal generated grid/waypoint fallback, not an authored production navmesh.
- No full production navmesh editor yet.

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
- Runtime material overrides can now apply base color, base texture, normal map, emissive map, emissive intensity, UV repeat/offset/rotation, roughness, metalness, opacity, and lightmaps.
- Runtime material variant switching can swap color and base texture options.
- Viewer can relight unlit/flat GLTF materials as standard lit materials, with a Studio toggle to disable it when a source intentionally uses flat rendering.
- Viewer generates runtime vertex normals for meshes that lack normal attributes, improving lighting on rough exports.
- Runtime object inspection panel.
- Visual smoke tests for desktop/mobile viewer and Studio.
- Automatic Blender lightmap bake job and manual lightmap/material texture upload workflows.
- Blender-backed FBX/OBJ/DAE conversion jobs for direct source uploads and ZIP source archives.

## Major Work Remaining

- SketchUp/Revit/3ds Max exporters.
- More texture quality controls.
- Draco compression as an optional alternative to Meshopt.
- More aggressive draw-call optimization and safe mesh merging controls.
- Production-grade bake farm scheduling, denoise/artifact repair, and light editing.
- Variant texture upload shortcuts and richer finish-option previews.
- Studio-linked in-viewport object editing and placement tools.
- Full navmesh/capsule controller with stair and multi-level handling.
- More advanced navmesh authoring tools beyond polygon zone drawing.
- Robust reimport identity matching across renamed/restructured models.
- Durable project/account backend.
- Multi-project API and database persistence.
- Cloud storage and production publish hosting.
- CDN hosting and custom domains.
- Analytics.
- Collaboration and 3D meetings.
