# Pipeline

The pipeline package is the start of the import, validation, optimization, bake, and publish flow.

Current package:

```txt
packages/pipeline
```

Current CLI:

```txt
pnpm.cmd analyze:demo
node scripts/optimize-scene-bundle.mjs apps/viewer-demo/public/scenes/demo --profile=balanced --apply
```

This runs:

```txt
node scripts/analyze-scene-bundle.mjs apps/viewer-demo/public/scenes/demo --write
```

## Current Analyzer

The analyzer reads `scene.manifest.json`, resolves bundle-local asset references, and writes:

```txt
stats.json
scene.graph.json
materials.json
objects.json
optimization.json
```

When regenerating `materials.json` and `objects.json`, the analyzer preserves existing material edits and object visibility by matching stable names. This is the first reimport-safety layer; later work still needs stronger identity matching for renamed or heavily restructured source models.

Current checks:

- Scene schema version.
- View count.
- Interaction count.
- Referenced model assets.
- Referenced video texture assets.
- Referenced logo/image assets.
- Missing asset count.
- Total bundle bytes.
- Model bytes.
- Video bytes.
- GLB/glTF node count.
- GLB/glTF mesh and primitive count.
- GLB/glTF material, texture, and image count.
- GLB/glTF vertex and triangle count.
- Object graph with stable node IDs, material IDs, bounds, and per-object triangle counts.
- Material override document with base color, roughness, metalness, and opacity.
- Object override document with visibility state.
- First budget warnings.
- Mobile, balanced, and desktop optimization profile reports.

## Current Optimizer

The optimizer script creates the first publishable optimized artifact:

```txt
scene.optimized.glb
optimization-job.json
optimization-history.json
```

Current steps:

- Validate the GLB v2 container.
- Compact the GLB JSON chunk.
- Deduplicate and prune unused resources with glTF Transform.
- Weld vertices and resample animation data.
- Reorder mesh data for transmission size.
- Apply `EXT_meshopt_compression`.
- Emit `scene.optimized.glb`.
- Optionally update `scene.manifest.json` to use the optimized model.
- Keep the latest job in `optimization-job.json`.
- Keep the latest 20 jobs in `optimization-history.json`.
- Leave KTX2/Basis texture compression as a pending job step.

The demo scene now compresses from roughly 34 KB to roughly 15 KB with Meshopt enabled. On larger production scenes, the same job path will preserve the original `scene.glb`, generate `scene.optimized.glb`, apply the optimized artifact, refresh stats, and expose rollback in Studio.

## Initial Budgets

- Total bundle: 160 MB.
- Model assets: 70 MB.
- Video assets: 45 MB.
- Interactions: 80.

These are conservative early defaults. Later phases will add device-specific budgets for mobile, balanced, and desktop quality profiles.

## Next Pipeline Work

- Count estimated draw calls and texture dimensions.
- Generate optimization recommendations.
- Add Draco as an alternative geometry compression option where useful.
- Generate KTX2/Basis texture outputs.
- Add Blender-headless bake job orchestration.
- Emit publish-ready asset manifests.
