# Product Requirements Document

## Product Name

Working name: Walkthrough Studio.

The name is temporary. The product should not use Shapespark's name, marks, UI assets, copy, proprietary formats, or private implementation details.

## Vision

Create a Shapespark-class product that lets architects, designers, and real-estate teams turn 3D architecture models into optimized, realistic, interactive browser walkthroughs with minimal technical work.

The product must feel simple to a non-technical user:

1. Import or sync a model.
2. Adjust materials, lights, views, interactions, and branding.
3. Bake and optimize the scene.
4. Publish a shareable link or website embed.
5. Reopen the project later and update the model without rebuilding the presentation from scratch.

## Target Users

- Architects and interior designers who work in SketchUp, Revit, 3ds Max, Blender, Maya, or Cinema 4D.
- Archviz studios producing client presentations.
- Real-estate marketing teams publishing interactive property walkthroughs.
- Agencies needing embeddable interactive 3D experiences for client websites.

## Product Scope

### Import And Sync

The product must support:

- Upload/import of common scene formats: GLB, glTF, FBX, OBJ, DAE.
- First-party export plugin path for SketchUp, Revit, and 3ds Max in later phases.
- Blender import/export workflow through FBX and GLB.
- Scene update flow where model changes can be reimported while preserving editor-side settings where possible.
- Import diagnostics: missing textures, extreme triangle count, huge textures, wrong scale, non-manifold geometry warnings, unsupported materials.

### Scene Editor

The product must provide a visual editor for:

- Scene list and project management.
- Object selection, visibility, lock state, and metadata.
- Material editing: base color, texture, opacity, roughness, metalness, normal/bump, emissive, alpha, double-sided rendering, UV transform, water/grass/special materials.
- Light editing: sun, ambient, point, spot, area, emissive surfaces, instance groups, intensity, color, shadows, bake inclusion.
- Reflection probes and environment/sky controls.
- Camera/view editing: walk views, orbit views, top/floor-plan views, initial view, view thumbnails, view ordering.
- Interactions: hotspots, HTML popups, links, audio, video textures, material picker, object toggles, room labels.
- Viewer configuration: title, author, logo, loading cover, UI theme, custom branding, controls, measurement units.
- Publish settings: visibility, URL slug, embed options, password/private link, custom domain.

### Baking And Optimization

The product must provide a repeatable processing pipeline:

- Normalize scale, axes, transforms, and scene graph.
- Analyze meshes, materials, textures, draw calls, lightmap requirements, and memory budget.
- Generate or validate secondary UVs for lightmaps.
- Bake realistic indirect lighting into lightmaps.
- Post-process lightmaps with denoise and artifact repair options.
- Resize textures based on scene usage and quality target.
- Compress geometry using Draco and/or Meshopt.
- Compress textures using KTX2/Basis where supported, with fallback formats.
- Merge meshes where safe and preserve interaction boundaries where needed.
- Generate multiple quality profiles: desktop high, balanced, mobile.
- Produce a publishable scene bundle with manifest, assets, metadata, and runtime config.

### Browser Viewer

The viewer must support:

- WebGL/WebGPU-ready runtime architecture, with WebGL as the stable baseline.
- Loading screen with progress and recoverable error messages.
- First-person walkthrough navigation.
- Click-to-move floor navigation with a blue floor target marker.
- Smooth camera acceleration, deceleration, and room/view transitions.
- Collision, camera height, stair/floor handling, and wall clipping prevention.
- Desktop keyboard/mouse controls.
- Mobile touch controls and orientation-safe UI.
- View list, floor plan/top view, orbit views, and initial camera selection.
- Hotspots, labels, HTML popups, links, audio, video textures, and material picker interactions.
- Device-aware quality selection and graceful degradation.
- Fullscreen mode, screenshot mode, share link, embed mode, and optional VR/WebXR mode.

### Publishing And Hosting

The product must support:

- Cloud-hosted projects with scene slots or storage quotas.
- Public share links.
- Website embed code.
- Custom branding.
- Custom domain support.
- Optional self-host export package.
- Versioned scene publishes and rollback.
- CDN-backed asset delivery.
- Basic analytics: loads, device class, average session time, most used views/interactions.

### Collaboration And Meetings

The product should eventually support:

- Shared guided walkthrough sessions.
- Multi-user avatars/cursors.
- In-scene video/audio meetings.
- Host controls: follow presenter, teleport group, mute, lock scene, highlight object.

### API And Customization

The product should expose:

- Viewer JavaScript API.
- Events for scene loaded, view changed, object clicked, hotspot opened, material changed.
- Runtime commands for camera movement, material replacement, object visibility, and texture/video updates.
- HTML/JS customization hooks for advanced clients.

## Success Criteria

### User Experience

- A non-technical user can import a clean architecture model, add views and hotspots, bake/optimize, and publish without editing code.
- A published scene opens from a link on desktop and mobile without installing an app.
- Reimporting an updated model preserves existing views/interactions/material overrides where object identity can be matched.

### Visual Quality

- Baked indoor scenes must show convincing indirect lighting, soft shadowing, and believable material response.
- Runtime lighting must be cheap enough that the viewer remains smooth on mid-range phones.

### Performance

Initial production targets:

- Viewer first meaningful render under 5 seconds on broadband for balanced scenes.
- 30 FPS minimum on target mobile devices for approved mobile-quality scenes.
- 60 FPS target on mainstream desktop/laptop GPUs.
- Mobile scene bundles should stay within strict GPU memory budgets defined per scene.

### Reliability

- Failed imports must produce actionable diagnostics.
- Failed bakes must preserve the project and report the failing asset/stage.
- Published scenes must be versioned so a failed update cannot break a live client link.

## Non-Goals For Early Builds

- Perfect automatic support for every proprietary CAD/BIM feature.
- Full real-time global illumination in the browser.
- Recreating Shapespark's proprietary implementation.
- Supporting every browser feature equally before the core viewer and pipeline are stable.
- Building all native plugins before the web viewer, editor, and processing pipeline are proven.

## Key Risks

- Automatic lightmap UV generation and bake artifact repair are the hardest technical areas.
- Mobile GPU memory varies widely, so optimization needs device profiles and conservative defaults.
- Importing messy models from multiple tools will require many real-world sample scenes.
- Native exporter plugins for Revit, SketchUp, and 3ds Max require separate platform expertise and testing.
- Video meetings inside 3D scenes introduce realtime infrastructure complexity beyond the viewer itself.

