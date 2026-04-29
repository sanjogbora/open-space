# Shapespark Capability Plan

This document maps the public Shapespark behavior we need to match into concrete product work for Open Space.

## What Shapespark Actually Exposes

- Import pipeline: desktop app import plus dedicated SketchUp, Revit, and 3ds Max exporters; generic import supports FBX, DAE, and OBJ.
- Viewer navigation: left click/tap moves to the clicked place, left drag looks around, WSAD walks forward/sideways, arrow keys walk/look, Q/E changes height.
- View system: walk, orbit, and top views. The first view is the initial view. View names appear in the viewer menu.
- Top/floor-plan experience: top views can hide ceilings. Room names are implemented as sprite triggers that change to predefined room views.
- Object system: objects have hierarchy/type, custom collisions, custom hide-in-views, and walk-on settings for auto-climb.
- Interactivity: material pickers, HTML popups, links, audio, video texture control, change-view triggers, object switching, camera-volume triggers, and script extensions.
- Loading: progressive loader can show basic colors before final textures/lightmaps, then improve quality in the background.
- Rendering: lightmap baking with path-traced GI, sample presets, bounces, max lightmaps, denoising, AO, CPU/GPU baking, and post-process-only runs.
- Publishing: hosted/shareable WebGL scenes, embeds, mobile/browser support, custom branding, and viewer API hooks.

## Immediate Product Direction

### Navigation and Collision

1. Keep click-to-move and WSAD separate:
   - WSAD speed should be direct and responsive.
   - Click-to-move should glide with slower damping and clear marker feedback.
2. Replace inferred wall boxes with an editable navigation layer:
   - Auto-detect floors/walls on import.
   - Let the user mark objects as `Walk on`, `Collision`, `Ignore collision`, and `Hide in top view`.
   - Generate a navmesh from walkable floor surfaces and blocked wall/object volumes.
3. Add visible debug tools:
   - Show walkable surfaces.
   - Show collision boxes/navmesh.
   - Explain why a click was rejected.

### Top View and Rooms

1. Create a Room Views editor:
   - Add room name, dimensions, view target, and clickable top-view label.
   - Show the room list in the viewer like the reference screenshot.
2. Add per-view object visibility:
   - Hide ceiling/fans/roof in Top view while keeping them visible in Walk views.
   - Support object groups such as `ceiling`, `fan`, `door`, `wall`, `furniture`.
3. Generate a top-view snapshot:
   - Start with live orthographic camera.
   - Later cache a thumbnail/atlas for faster load and sharper floor-plan UI.

### Media and Interactions

1. Add Video Surface workflow:
   - Pick screen material or mesh.
   - Upload/link video.
   - Configure autoplay, muted, loop, trigger distance, and offscreen pause.
2. Add trigger types:
   - Sprite/text label trigger.
   - Object trigger.
   - Camera-volume trigger.
   - Change-view trigger.
3. Add object switching:
   - Useful for furniture/finish variants.

### Loading and Publishing

1. Improve loading state:
   - Real progress stages: manifest, model, textures, controls, scene ready.
   - Branded loading overlay with progress ring.
2. Add progressive loading later:
   - Show geometry with simple materials first.
   - Load higher quality textures/lightmaps afterward.
3. Publishing:
   - Versioned bundles already exist.
   - Add embed customization, scene password/access later.

### Import and Optimization Pipeline

1. Current short-term target:
   - ZIP with GLB/GLTF, textures, generated views, bounds, controls reset.
   - Meshopt compression.
2. Next target:
   - KTX2/Basis texture compression.
   - Texture resizing based on surface importance.
   - Better object classification from mesh names/materials/geometry.
3. Long-term target:
   - Blender/worker-based lightmap bake pipeline.
   - UV2 generation, bake settings, denoise/post-process, lightmap packing.

## Current Priority Order

1. Smooth click-to-move and marker polish.
2. Navmesh/collision editor and reliable wall blocking.
3. Top view with room labels/list and hide-ceiling-in-top-view.
4. Video texture surface workflow.
5. Loading/progressive-ready states.
6. Texture compression and lightmap pipeline.

## Source Notes

- Shapespark Navigation: https://help.shapespark.com/hc/en-us/articles/360009196618-Navigation
- Shapespark Viewer/views/progressive loader: https://help.shapespark.com/hc/en-us/articles/360009314477-Viewer
- Shapespark room names in top/orbit views: https://help.shapespark.com/hc/en-us/articles/360009526918-How-to-add-interactive-room-names-in-the-top-and-orbit-views
- Shapespark hide ceiling in top/orbit: https://help.shapespark.com/hc/en-us/articles/360009384898-How-to-hide-a-ceiling-from-the-Top-Orbit-view
- Shapespark Objects: https://help.shapespark.com/hc/en-us/articles/360009289998-Objects
- Shapespark Bake/lightmaps: https://help.shapespark.com/hc/en-us/articles/360009198617-Bake-Lightmap-baking
- Shapespark import: https://help.shapespark.com/hc/en-us/articles/360008931457--1-Import-3D-model-to-Shapespark
- Shapespark viewer API/video textures: https://github.com/shapespark/shapespark-viewer-api
