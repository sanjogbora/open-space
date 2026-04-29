# Technical Architecture

## Architecture Goals

- Make the visible walkthrough experience excellent early.
- Keep the scene format, processing pipeline, and viewer runtime separable.
- Build automation around real 3D constraints instead of assuming all input models are clean.
- Preserve project settings across model updates.
- Treat optimization and baking as first-class product features, not scripts hidden behind the UI.

## Recommended Stack

### Monorepo

- TypeScript-first monorepo.
- Package manager: pnpm.
- Apps:
  - `apps/studio`: cloud editor and dashboard.
  - `apps/viewer-demo`: local viewer playground.
  - `apps/api`: backend API.
  - `apps/worker`: processing job orchestrator.
- Packages:
  - `packages/viewer`: browser viewer SDK.
  - `packages/scene-schema`: manifest, project, and runtime schemas.
  - `packages/editor-core`: editor state, commands, undo/redo, selection.
  - `packages/pipeline`: import, analysis, optimization, bake orchestration.
  - `packages/ui`: shared UI components.

### Frontend

- React + TypeScript for studio/editor UI.
- Three.js for viewer runtime.
- React Three Fiber can be used inside the editor, but the published viewer should expose a framework-independent SDK.
- Zustand or equivalent lightweight state for editor state.
- IndexedDB/local cache for large project metadata and asset previews.

### Backend

- Node.js/TypeScript API for users, projects, publishing, jobs, and collaboration.
- PostgreSQL for projects, scene versions, users, billing/account data, publish metadata.
- Object storage for uploaded assets, processed bundles, thumbnails, and bake outputs.
- Redis/queue for long-running import, optimization, and bake jobs.

### Processing

- Canonical source pipeline:
  - Upload model.
  - Convert to internal glTF/GLB representation.
  - Analyze scene.
  - Normalize transforms, units, axes.
  - Resolve textures and materials.
  - Generate diagnostics.
  - Create optimized scene profiles.
  - Bake lightmaps when requested.
  - Package publish bundle.
- Tools to evaluate:
  - Blender headless for import conversion, UV generation, and baking prototypes.
  - gltf-transform for glTF optimization, texture resizing, Draco/Meshopt, KTX2.
  - meshoptimizer for geometry compression and simplification.
  - Basis Universal/KTX2 for compressed textures.
  - Later: custom GPU bake service if Blender becomes a bottleneck.

## System Components

### 1. Studio Dashboard

Responsibilities:

- Project list.
- Upload/import entry point.
- Scene version history.
- Publish state and links.
- Account/team/branding settings.
- Job status dashboard.

### 2. Scene Editor

Responsibilities:

- Load editable scene manifest.
- Render scene in editor viewport.
- Select objects/materials/lights.
- Edit project-level viewer settings.
- Add views, hotspots, labels, audio, material picker, video textures.
- Preview published runtime behavior.
- Send bake/optimize/publish jobs.

The editor must use command-based mutation with undo/redo. Each command should produce structured project changes, so the same system can support autosave, versioning, collaboration, and API-driven updates.

### 3. Viewer SDK

Responsibilities:

- Load published scene manifest and assets.
- Select quality profile based on device and user setting.
- Render optimized geometry, lightmaps, materials, probes, sky, and post-processing.
- Handle movement, collision, floor navigation, view transitions, hotspots, labels, media, and runtime interactions.
- Expose JavaScript API.

The published viewer must not depend on the full editor app. It should be small, embeddable, and stable.

### 4. Scene Schema

Core runtime files:

- `scene.manifest.json`: version, asset list, quality profiles, bounds, units, feature flags.
- `scene.graph.json`: objects, stable IDs, hierarchy, visibility, metadata.
- `materials.json`: material definitions and variants.
- `views.json`: walk, orbit, top views, thumbnails, camera transforms.
- `interactions.json`: hotspots, labels, audio, videos, material pickers, links.
- `navigation.json`: floor zones, collision hints, camera height, movement settings.
- `branding.json`: title, author, logo, theme, loader settings.

### 5. Importer

Responsibilities:

- Accept GLB, glTF, FBX, OBJ, DAE initially.
- Convert source formats to canonical glTF.
- Preserve source object names, material names, transforms, units, and hierarchy where possible.
- Assign stable object IDs.
- Report diagnostics and suggested fixes.

Long-term native exporters must output the same canonical scene package and stable IDs, instead of inventing separate import paths per tool.

### 6. Optimization Pipeline

Stages:

1. Scene analysis:
   - Triangle count.
   - Mesh count.
   - Material count.
   - Draw-call estimate.
   - Texture memory estimate.
   - Lightmap memory estimate.
   - Mesh bounds and surface area.
2. Cleanup:
   - Remove unused nodes/materials/textures.
   - Apply transforms where safe.
   - Deduplicate textures/materials.
3. Mesh optimization:
   - Reorder vertices.
   - Quantize where safe.
   - Simplify selected meshes.
   - Merge static meshes by material and interaction boundary.
   - Compress with Meshopt/Draco.
4. Texture optimization:
   - Resize based on world-space texel density and material importance.
   - Generate KTX2/Basis compressed textures.
   - Keep PNG/JPEG/WebP fallbacks where required.
5. Profile generation:
   - Desktop high.
   - Balanced.
   - Mobile.
6. Validation:
   - Open bundle in headless viewer.
   - Capture screenshots.
   - Record load time, GPU memory estimate, draw calls, FPS smoke test.

### 7. Lightmap Baking

Initial approach:

- Use Blender headless for UV2 generation and Cycles baking.
- Export baked lightmaps and attach them to runtime materials.
- Store bake settings and results as versioned job artifacts.

Required controls:

- Quality preset.
- Samples.
- Bounces.
- Lightmap resolution.
- Maximum lightmaps.
- Ambient occlusion.
- Denoise/post-process options.
- CPU/GPU/cloud worker selection where infrastructure allows.

Hard requirements:

- Bake must be restartable.
- Failed bake must leave project editable.
- Bake output must be previewable before publish.
- Material or interaction edits that do not affect lighting should not require a rebake.

### 8. Publishing

Publish process:

1. Select scene version.
2. Confirm quality profiles.
3. Build immutable publish bundle.
4. Upload bundle to object storage/CDN.
5. Create or update public URL.
6. Generate embed code.
7. Keep previous version for rollback.

Published scene URLs should resolve through a thin host page that loads the viewer SDK and scene manifest.

### 9. Collaboration And Meetings

Later architecture:

- WebRTC for audio/video.
- WebSocket/WebRTC data channel for camera pose, avatar state, object highlight, and presenter control.
- Meeting rooms bound to published scene versions.
- Server-side room registry, permissions, and moderation.

## Data Model Sketch

Main entities:

- User
- Team
- Project
- SourceAsset
- SceneVersion
- EditorDocument
- ProcessingJob
- PublishTarget
- PublishedVersion
- AssetBundle
- MeetingRoom
- ViewerEvent

Object identity is critical. The model update system should combine source-tool GUIDs where available, hierarchy path, object name, material signature, geometry hash, and bounds hash to match objects across imports.

## Early Technical Decisions

- Use glTF/GLB as the internal web delivery target.
- Build viewer before native exporter plugins.
- Use Blender headless for the first baking pipeline.
- Use open optimization tools before custom GPU infrastructure.
- Start with one cloud editor before adding desktop/offline packaging.
- Require real-world test scenes before claiming automatic optimization parity.

