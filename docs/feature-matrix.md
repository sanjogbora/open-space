# Feature Matrix

This matrix maps the intended product against public Shapespark-facing capabilities as of April 28, 2026. Sources are public product, pricing, and help-center pages.

## Product And Workflow

| Capability | Target Product Requirement | Source Reference |
| --- | --- | --- |
| Browser-based architectural walkthroughs | Published scenes open by link or embed in modern browsers. | https://www.shapespark.com/ |
| Desktop and mobile viewing | Viewer must be responsive and performance-budgeted by device class. | https://www.shapespark.com/ |
| VR-capable viewing | Add WebXR/VR mode after stable desktop/mobile viewer. | https://www.shapespark.com/ |
| Editor workflow | Provide cloud editor first, optional desktop wrapper later. | https://www.shapespark.com/pricing |
| Share links and embeds | Publish hosted scenes and generate embed snippets. | https://www.shapespark.com/pricing |
| Self-hosting | Export static scene bundles for own-server deployment in later phase. | https://www.shapespark.com/pricing-perpetual |
| Custom branding | Project and account-level logos, hidden platform branding, theme controls. | https://www.shapespark.com/pricing |
| Custom domain | Map published scenes to customer domains. | https://www.shapespark.com/pricing |
| Viewer API | Provide JavaScript API and event hooks. | https://www.shapespark.com/pricing |
| HTML/JS customization | Allow controlled custom scripts/styles in advanced plans. | https://www.shapespark.com/pricing |
| Video meetings in 3D | Add multi-user voice/video walkthrough sessions after core publishing. | https://www.shapespark.com/pricing |

## Import

| Capability | Target Product Requirement | Source Reference |
| --- | --- | --- |
| FBX, DAE, OBJ import | Support through server-side conversion pipeline. | https://help.shapespark.com/hc/en-us/articles/360008931457--1-Import-3D-model-to-Shapespark |
| SketchUp export workflow | Build native or extension-based sync in later phase. | https://help.shapespark.com/hc/en-us/articles/360009183838-Import-a-3D-model-from-SketchUp |
| Revit export workflow | Build add-in after importer identity and update flow are proven. | https://help.shapespark.com/hc/en-us/articles/360009191838-Import-a-3D-model-from-Revit |
| 3ds Max export workflow | Build plugin after shared exporter protocol exists. | https://help.shapespark.com/hc/en-us/articles/360014324137-Import-a-3D-model-from-3ds-Max |
| Blender workflow | Support FBX/GLB import and publish Blender export guidance early. | https://help.shapespark.com/hc/en-us/articles/5622695173905-Import-3D-model-from-Blender |
| Update existing scene | Preserve editor-side metadata across reimports with stable object matching. | https://www.shapespark.com/ |

## Scene Editing

| Capability | Target Product Requirement | Source Reference |
| --- | --- | --- |
| Material editor | Edit standard, water, grass/special materials, textures, emissive, double-sided, UV transform. | https://help.shapespark.com/hc/en-us/articles/360009286378-Materials |
| Light editor | Add ambient, sun, point, spot, area, and grouped light instances. | https://help.shapespark.com/hc/en-us/articles/360009263358-Lights |
| Lightmap baking controls | Quality presets, samples, bounces, resolution, max lightmaps, denoise/post-process, CPU/GPU/cloud job selection. | https://help.shapespark.com/hc/en-us/articles/360009198617-Bake-Lightmap-baking |
| Views | Walk, orbit, and top/floor-plan views with ordered viewer list. | https://help.shapespark.com/hc/en-us/articles/360009314477-Viewer |
| Viewer cover/settings | Project title, author, logo, website, branding controls. | https://help.shapespark.com/hc/en-us/articles/360009314477-Viewer |
| HTML labels/popups | Add rich-content popups triggered from scene interactions. | https://help.shapespark.com/hc/en-us/articles/360010148837-Interactivity-settings |
| Audio | Add scene audio with autoplay/menu/trigger behavior. | https://help.shapespark.com/hc/en-us/articles/360010148837-Interactivity-settings |
| Material picker | Runtime material replacement choices for viewer users. | https://help.shapespark.com/hc/en-us/articles/360010148837-Interactivity-settings |

## Optimization

| Capability | Target Product Requirement | Source Reference |
| --- | --- | --- |
| Baked global illumination | Use lightmaps so runtime performance stays cheap. | https://www.shapespark.com/ |
| Bake quality presets | Draft, medium, high, and super style quality tiers. | https://help.shapespark.com/hc/en-us/articles/360009198617-Bake-Lightmap-baking |
| Final high-quality bake | Provide high-sample final bake profile and job timing warnings. | https://help.shapespark.com/hc/en-us/articles/360009033018-How-to-bake-the-final-high-quality-version-of-the-lightmap |
| Texture size control | Resize/compress textures according to scene use and target device profile. | https://help.shapespark.com/hc/en-us/articles/360008898517-What-are-the-optimal-texture-sizes-to-use-in-scenes |
| Mesh simplification | Add simplification tools and warnings for heavy scenes. | https://help.shapespark.com/hc/en-us/articles/4827097566609-Performance-improvements-and-mesh-simplification |
| Scene size budgets | Define desktop/mobile triangle, texture, lightmap, draw-call, and GPU-memory budgets. | https://help.shapespark.com/hc/en-us/articles/360008934597-What-is-the-scene-size-triangles-limit |

## Deliberate Differences

- The first implementation should use GLB/glTF as the canonical internal delivery format because it is web-native.
- The cloud editor should come before a Windows-only desktop editor unless a specific offline workflow becomes mandatory.
- Native exporter plugins should share one exporter protocol and one asset identity model.
- The viewer should be built as a standalone SDK so the editor, published scenes, embeds, and client customizations all use the same runtime.

