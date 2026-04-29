# Roadmap

This roadmap is phased so the product becomes useful early while still moving toward full Shapespark-class scope.

## Phase 0: Product Definition

Status: in progress.

Deliverables:

- PRD.
- Feature matrix.
- Technical architecture.
- Milestone plan.
- Repo structure decision.

Exit criteria:

- Scope is explicit.
- First milestone can start without ambiguity.

## Phase 1: Viewer MVP

Goal: prove the visible walkthrough experience.

Deliverables:

- TypeScript monorepo scaffold.
- Three.js viewer package.
- GLB loading.
- Loading UI.
- Camera controls.
- Click-to-move navigation and blue floor marker.
- View buttons from JSON.
- Floorplan/minimap with saved view points.
- Hotspots from JSON.
- Links from JSON.
- Video texture support.
- Object-toggle support.
- Screenshot capture.
- Mobile responsive controls.
- Demo scene harness.

Exit criteria:

- A GLB scene can be opened locally and explored.
- JSON config can add views, hotspots, and links without code changes.
- Viewer can show current position and saved views on a simple floorplan overlay.
- Viewer works in desktop and mobile viewport tests.

## Phase 2: Published Scene Bundle

Goal: define the scene package format and make the viewer embeddable.

Deliverables:

- `scene.manifest.json`.
- Asset manifest.
- Views/interactions/navigation/branding JSON schemas.
- Static host page.
- Embed script prototype.
- Quality-profile selection stub.

Exit criteria:

- A scene can be packaged as static files.
- Viewer can load by URL and embed in another page.

## Phase 3: Cloud Studio Skeleton

Goal: create the product shell around the viewer.

Deliverables:

- Project dashboard. Initial local shell exists.
- Upload flow.
- Scene version list.
- Editor viewport.
- Save/load editor document. Initial local-storage draft save exists.
- View/hotspot/branding editors. Initial manifest editors exist.
- Material editor. Initial generated materials and override fields exist.
- Object graph browser. Initial generated graph and object list exist.
- Publish button wired to local/static bundle generation. Initial viewer/embed link controls exist.

Exit criteria:

- A user can create a project, upload a GLB, configure views/hotspots, and publish a static scene.

## Phase 4: Optimization Pipeline

Goal: make uploaded scenes web-ready.

Deliverables:

- Import analysis reports. Initial bundle and GLB stats exist.
- gltf-transform optimization jobs.
- Meshopt/Draco compression.
- Texture resize and KTX2 compression.
- Desktop/balanced/mobile profiles.
- Scene budget warnings.
- Automated viewer smoke test.

Exit criteria:

- The system can produce optimized scene bundles from source GLB.
- Users see clear warnings when a scene is too heavy for mobile.

## Phase 5: Lightmap Baking

Goal: reach realistic baked-light visual quality.

Deliverables:

- Blender headless bake job.
- UV2 generation/validation.
- Bake settings UI.
- Lightmap asset generation.
- Lightmap material assignment in viewer.
- Bake preview and publish flow.
- Denoise/post-process experiments.

Exit criteria:

- A test interior scene can be baked, optimized, loaded, and viewed with convincing indirect lighting.

## Phase 6: Import Expansion

Goal: support real architecture workflows.

Deliverables:

- FBX/OBJ/DAE conversion.
- Blender workflow guide.
- Import diagnostics.
- Reimport/update matching.
- SketchUp exporter prototype.
- Revit exporter research/prototype.
- 3ds Max exporter research/prototype.

Exit criteria:

- Multiple source tools can import into the same internal project model.
- Reimport preserves enough editor settings to be useful in client workflows.

## Phase 7: Advanced Editor

Goal: approach full non-technical editing.

Deliverables:

- Material editor.
- Light editor.
- Object visibility and metadata editor.
- Reflection probes.
- Sky/environment controls.
- Audio, HTML label, material picker, and object-toggle interactions.
- Floor plan/top view editor. Initial viewer-side minimap exists.
- Undo/redo and autosave.

Exit criteria:

- Most scene customization can happen in the editor without writing JSON.

## Phase 8: Hosting, Accounts, And API

Goal: operate as a product.

Deliverables:

- Auth and teams.
- Cloud storage.
- Scene slots/storage quotas.
- Publish URLs.
- Custom branding.
- Custom domains.
- Viewer JavaScript API.
- Analytics.
- Self-host export.

Exit criteria:

- A customer can manage projects and publish production links.

## Phase 9: Collaboration And 3D Meetings

Goal: match advanced presentation workflows.

Deliverables:

- Guided walkthrough sessions.
- Multi-user presence.
- Audio/video meeting support.
- Presenter controls.
- Custom avatars.

Exit criteria:

- Multiple viewers can join one scene and communicate/present inside it.

## Phase 10: Hardening And Scale

Goal: move from capable product to reliable commercial platform.

Deliverables:

- Real scene benchmark suite.
- Mobile device lab matrix.
- Automated visual regression.
- Bake farm scheduling.
- CDN cache tuning.
- Observability.
- Billing integration.
- Support tooling.

Exit criteria:

- The platform can support many customer projects with predictable quality, cost, and uptime.
