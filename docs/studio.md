# Studio App

The Studio app is the first editor surface for the product.

Local URL:

```txt
http://127.0.0.1:5174/
```

Command:

```txt
pnpm.cmd dev:studio
```

Optional local URL overrides:

```txt
VITE_API_URL=http://127.0.0.1:5175
VITE_VIEWER_URL=http://127.0.0.1:5173
```

Viewer-to-Studio repair links can be configured from `apps/viewer-demo/.env`:

```txt
VITE_STUDIO_URL=http://127.0.0.1:5174
```

## Current Scope

- Project shell for the demo residence.
- Manifest loading and validation.
- Branding fields.
- View list and camera/view editing.
- Hotspot list and hotspot editing.
- Link interaction list and link editing.
- Object-toggle interaction list and object target editing.
- Materials list and material override editing.
- Material variant editor.
- Object graph browser from generated `scene.graph.json`.
- Object visibility toggles from generated `objects.json`.
- Controls editor for WASD, click-to-move, drag-look, speed, sensitivity, and click threshold.
- Upload/import panel backed by the local API.
- Optimization report panel backed by generated `optimization.json`.
- Optimization job trigger, model source rollback controls, last-job result panel, and recent job history.
- Publish panel with versioned local bundle output and embed snippets.
- Manifest JSON inspector.
- Bundle statistics from generated `stats.json`.
- Viewer URL and embed snippet copy actions.
- Draft save/reset using browser local storage when the API is unavailable.

## Current Data Flow

The Studio prototype loads:

```txt
apps/studio/public/scenes/demo/scene.manifest.json
```

The Viewer prototype loads:

```txt
apps/viewer-demo/public/scenes/demo/scene.manifest.json
```

They are duplicated for now so each Vite app can run independently. The local API also mirrors project documents into these bundle folders while the durable backend is still being built.

## Next Editor Work

- Add in-viewport object selection.
- Add texture-map, UV transform, and emissive controls to the material editor.
- Add light editor.
- Add publish version rollback.
