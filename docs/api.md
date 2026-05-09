# Local API

The local API is the first backend foundation for Studio. It turns browser-only edits into actual scene-bundle file updates.

Local URL:

```txt
http://127.0.0.1:5175/
```

Command:

```txt
pnpm.cmd dev:api
```

## Current Endpoints

```txt
GET  /health
GET  /api/projects
POST /api/projects
GET  /api/projects/demo
POST /api/projects/demo/manifest
POST /api/projects/demo/materials
POST /api/projects/demo/objects
POST /api/projects/demo/controls
POST /api/projects/demo/model
POST /api/projects/demo/analyze
POST /api/projects/demo/optimize
POST /api/projects/demo/model-source
POST /api/projects/demo/publish
POST /api/projects/demo/publish/active
```

## Current Behavior

- Reads the demo bundle from `apps/viewer-demo/public/scenes/demo`.
- Writes manifest/material/object/control edits to both viewer and Studio demo bundles.
- Writes uploaded GLB models to both demo bundles.
- Runs `pnpm.cmd analyze:demo` after API saves.
- Returns fresh stats and optimization reports after analysis.
- Runs local optimization jobs that emit `scene.optimized.glb`, write `optimization-job.json`, optionally apply the optimized model to the manifest, and refresh analysis.
- Switches project manifests between `scene.glb` and `scene.optimized.glb` for rollback or re-apply.
- Creates new projects by cloning the demo scene bundle into viewer and Studio scene roots.
- Publishes static versioned bundles under the viewer `published/` path.
- Promotes a published version to `/published/<project>/live/` for stable live links and local rollback.

## Why This Matters

Shapespark-class editing needs a persistent project document, not local browser state. This local API is the first small version of that backend:

- project read/write
- scene bundle persistence
- analyzer job trigger
- optimization job trigger
- optimized/original model source switching
- editor-to-viewer publish path

## Current Limitations

- Project storage is still filesystem-based.
- No authentication.
- No database.
- Uploads are GLB-only.
- Optimization jobs run synchronously; no background queue yet.
- Publish history and live-version rollback are filesystem-based.
