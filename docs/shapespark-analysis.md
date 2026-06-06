# ShapeSpark Analysis: UI, Editor Panels, Gap Analysis & Improvement Roadmap

> Last updated: 2026-06-06  
> Based on: **live cloud editor exploration** (`sandrty.shapespark.com/bake2___1_/draft/editor/`), help.shapespark.com docs

---

## 1. ShapeSpark Viewer UI Elements

Observed live at `sandrty.shapespark.com/demo-room/`

### Bottom Navigation Bar
| Element | Description |
|---|---|
| **Views menu** | Hamburger/list icon — dropdown listing named views (Walk, Top, Orbit). First view is default on load |
| **Navigation mode toggle** | Walk / Orbit / Top — switches camera control mode |
| **Fullscreen button** | Enters browser fullscreen |
| **VR button** | Launches WebXR VR mode (shown when WebXR available) |
| **Share button** | Native share sheet / copy link |
| **Branding logo** | Bottom-left corner, configurable per scene |

### In-Viewer Overlays
| Element | Description |
|---|---|
| **Loading screen** | Progress bar with scene name overlay during initial load |
| **Minimap** | Bottom-left; cropped floor-plan showing camera position + orientation arrow. Click-to-teleport. Multi-floor tabs |
| **Hotspot sprites** | Billboards (always face camera) positioned in 3D space; trigger info panels, switches, navigation |
| **Info panel popup** | HTML card with title, text, image, embedded YouTube/Vimeo — opened by hotspot trigger |
| **Material picker UI** | Side panel or inline swatches for swapping material variants at runtime |
| **Object switcher** | Toggle buttons to show/hide alternate geometry (furniture variants, open/closed states) |
| **Auto-tour** | Plays automatically on load; animated transitions between predefined views; can be paused |

### Walk Mode Controls
- **Mouse**: look around (drag)
- **WASD / Arrow keys**: move
- **Click floor/minimap**: teleport
- **Scroll wheel**: zoom (orbit mode)
- **Double-click**: teleport to point

---

## 2. ShapeSpark Cloud Editor — Right Panel (Live Exploration)

The cloud editor at `Edit draft` opens a **full web-based editor** with 10 tab icons on the far right edge. These were all observed live.

### Tab Order (right strip, top → bottom)
| Icon | Panel name |
|---|---|
| Circular arrow | **Bake settings** |
| Light bulb | **Lights settings** |
| Prism/splitter | **Reflection probes settings** |
| Checkerboard | **Materials settings** |
| Cloud | **Sky settings** |
| Pyramid/triangle | **Objects settings** |
| Camera box | **Camera settings** |
| Eye | **Viewer settings** |
| Person/walk | **Interactivity settings** |
| Map | **Minimap settings** |

---

### Tab 1: Bake settings *(circular arrow icon)*
**Path-tracing section:**
- **Quality** — preset buttons: Draft / Medium / High / Super
- **Samples** — number field (default: 75 for Draft)
- **Bounces** — number field (default: 8)
- **Lightmap res.** — number field (default: 75)
- **Max lightmaps** — number field (default: 2)
- **Ambient occlusion** — toggle (enabled by default)
  - Distance (default: 1), Intensity (default: 0.5)
- **Light tree** — toggle (enabled by default)

**Post-processing section:**
- **Enable filters** — toggle (enabled by default)
- **AI denoiser** — toggle (off by default)
- **Flood dark limit** — number field (default: 0.02)

**Actions:**
- **Bake** button (blue)
- Note: "Clicking Post-process, or Bake saves the scene"
- **Save changes** / **Publish draft** at bottom

---

### Tab 2: Lights settings *(bulb icon)*
**Filter checkboxes:** Ambient light, Sky light, Emissive materials

**Light list** — scrollable list of all lights in scene (e.g. Point, Point.001, Point.002…)

**Add buttons:** `+ Spot` `+ Area` `+ Sun` `+ Point`

**Details (per selected light):**
- Enable toggle (e.g. "Point light")
- **Name** — text field
- **Type** — dropdown (Point / Spot / Area / Sun)
- **Strength** — number field (default: 25 for Point)
- **Size** — number field (default: 0.1)
- **Color** — hex color field (e.g. #fff1e7)
- **IES profile** — file picker ("Not selected")
- **Instances** section — lists position coordinates (XYZ) for each instance; copy/move/delete per instance

---

### Tab 3: Reflection probes settings *(prism icon)*
- **Instance list** — position entries with copy/delete icons
- `+` button to add new probe
- **Details:**
  - **Position** — X, Y, Z number fields
  - **Bounding box** — toggle
    - **Min** — X, Y, Z (e.g. -19562.7, -4280.5, -0.01)
    - **Max** — X, Y, Z (e.g. 16308.95, 5904.46, 2488.36)

---

### Tab 4: Materials settings *(checkerboard icon)*
**Material list** — scrollable, filter search at top; icons for copy/pick per entry. Selected row highlighted blue.

**Preview section** — rendered 3D sphere showing material appearance in real time.

**Details (per selected material):**
- **Name** — text field (e.g. "Material.001")
- **Type** — dropdown (Standard / …)
- **Base color** — texture picker (filename + copy/settings/clear icons) + link icon to unlink from import
  - **Correction** — toggle to enable color correction sub-fields
- **Opacity** — slider [0,1] with link icon (default: 1)
- **Reflective** — toggle (on by default)
- **Roughness** — slider [0,1] with texture picker icon (default: 1)
- **Metallic** — number field [0,1] with texture picker icon (default: 0)
- **Bump map** — file picker ("Not selected")
- **Normal map** — file picker ("Not selected")
- **Parallax correction** — toggle (on by default)
- **Emissive** — toggle (off by default)
- **Double sided** — toggle (off by default)
- **UV transform** — toggle to expand (off by default)
- **Anti-Tiling** — 3-button selector: **None** / **Organic** / **Regular**

---

### Tab 5: Sky settings *(cloud icon)*
**Details section:**
- **Sky texture** — file picker ("Not selected")
- **Horizon vertical offset** — number (default: 0)
- **Procedural model** — dropdown (Simple / …)
- **Zenith color** — hex color (default: #f4f9ff)
- **Use gradient** — toggle (on by default)
  - **Gradient elevation** — number (default: -30)
  - **Gradient power** — number (default: 0.9)
- **Nadir color** — hex color (default: #ffffff)

**Fog section:**
- **Distance fog** — toggle (off)
- **Height fog** — toggle (off)

---

### Tab 6: Objects settings *(pyramid icon)*
**Object list** — scrollable flat list of all meshes; filter/sort at top; per-row: copy/pick icons

**Object section (per selected):**
- **Triangles** — display (e.g. "27,889 / simplified from 76,353")
- **Lightmap resolution** — display (e.g. "global (75)")
- **Simplification level** — display (e.g. "global (Normal)")
- **Collisions** — display (enabled/disabled)

**Object type section:**
- **Type** — object name/type
- **Instances** — count

---

### Tab 7: Camera settings *(camera box icon)*
**Details section:**
- **Exposure** — number (default: 0)
- **Gamma** — number (default: 1)
- **Field of view** — degrees (default: 70)
- **Max speed** — m/s (default: 1.11)
- **Auto exposure** — toggle (on by default)
  - **Brightness Target** — number (default: 0)
- **Auto path** — toggle (on by default)
- **Auto climb** — toggle (off by default)

**Color management section:**
- **Tone mapping** — dropdown (High contrast / Medium contrast / Low contrast / None)
- **Color map** — dropdown (None / …LUT options)

**Effects section:**
- **Motion blur** — toggle (off by default)

**Camera volumes section** — add zones for per-area exposure override

---

### Tab 8: Viewer settings *(eye icon)*
**Cover section:**
- **Title** — text field
- **Author** — text field
- **Author website** — text field
- **Shapespark logo** — toggle (on, marked with `*`)
- **Language** — dropdown (English / …)
- Note: "Branding disabled in Camera [plan]"

**Views section:**
- List of saved views (empty in this scene)
- `+ Walk` `+ Top` `+ Orbit` — add named camera views

**Settings section:**
- **Automatic tour** — toggle (off)
- **Progressive loader** — toggle (on)
- **Interaction prompt** — toggle (off)

---

### Tab 9: Interactivity settings *(person icon)*
- **Extensions** section — empty list with `+` button to add new extension
- *(When extensions are added: each shows type + trigger configuration)*

---

### Tab 10: Minimap settings *(map icon)*
- **Enable Minimap** — toggle (off by default)
- *(When enabled: crop bounds, slice height, rotation, level tabs appear)*

---

### Top Toolbar (9 icons, center-top)
Observed row of 9 cube/grid icons — viewport mode switches:
- Likely: Perspective | Front | Right | Camera view | Wireframe | Solid | Material preview | Rendered | UV view

---

---

## 3. Gap Analysis: ShapeSpark vs Our Tool

### Our Current Capabilities
| Feature | Status |
|---|---|
| glTF/GLB scene loading | ✅ |
| First-person walk navigation | ✅ |
| Orbit mode | ✅ |
| Named views / view menu | ✅ |
| Basic directional + hemisphere lighting | ✅ |
| Double-sided materials (manifest flag) | ✅ |
| Ambient intensity scaling (manifest flag) | ✅ |
| Tone mapping (manifest flag) | ✅ |
| Scene upload (Blender conversion pipeline) | ✅ |
| Lightmap baking (Blender Cycles) | ✅ |
| Minimap | ✅ (basic) |
| Scene manifest schema + validation | ✅ |
| Multi-project management | ✅ |

### Feature Gaps

#### High Impact / Medium Effort
| Gap | ShapeSpark Has | Impact | Effort |
|---|---|---|---|
| **In-browser material editor** | Full tab: roughness, metallic, emissive, UV transform, anti-tiling | Very High | Medium |
| **Interactive hotspots** | Sprite + 3D-click + volume triggers; HTML popup content | Very High | Medium |
| **Material picker extension** | Runtime material variant switching | High | Medium |
| **Camera volumes** | Per-area exposure/gamma override | High | Low |
| **Auto-tour** | Animated view-to-view slideshow | High | Low |
| **Reflection probes** | Box-projected environment captures | High | Medium |

#### High Impact / High Effort
| Gap | ShapeSpark Has | Impact | Effort |
|---|---|---|---|
| **Sky / HDRI lighting** | Procedural + HDR panorama + fog | High | High |
| **In-browser light editor** | All light types + IES profiles + real-time preview | High | High |
| **Object visibility per view** | Hide ceiling in Top view, furniture variants | High | Medium |
| **Switch Object extension** | Toggle geometry variants at runtime | High | Medium |
| **Audio extensions** | Ambient + triggered audio | Medium | Medium |

#### Medium Impact / Low Effort
| Gap | ShapeSpark Has | Impact | Effort |
|---|---|---|---|
| **Auto-climb on stairs** | Camera follows surface height | Medium | Low |
| **Minimap click-to-teleport** | Auto Path + pathfinding | Medium | Low |
| **Multi-floor minimap** | Level tabs with separate crops | Medium | Low |
| **Custom FOV per view** | Per-view FOV override | Low | Low |
| **Scene branding / logo** | Custom logo URL per scene | Low | Low |

#### Low Priority
| Gap | ShapeSpark Has | Impact | Effort |
|---|---|---|---|
| **VR / WebXR mode** | Full WebXR headset + hand tracking | Medium | High |
| **Video texture control** | Play/pause video geometry | Low | Medium |
| **Meeting screen** | Live screen-share in 3D | Low | High |
| **Script extensions** | Custom JS via viewer API | Medium | High |
| **Motion blur** | Camera motion blur post-process | Low | Low |

---

## 4. Improvement Roadmap

### Phase 1 — Quick Wins (1–2 weeks each)
1. **Camera volumes** — Per-area exposure/gamma override blocks in scene manifest + viewer support
2. **Auto-tour** — Enable view sequence playback with animated transitions; add `autoTour` to manifest
3. **Auto-climb** — Raycast below camera to follow walkable surfaces on terrain/stairs
4. **Minimap enhancements** — Click-to-teleport with path preview; multi-floor level switching UI

### Phase 2 — Interactive Hotspots (2–4 weeks)
5. **Hotspot system** — Sprite billboard + 3D object click triggers; JSON-configured in manifest
6. **HTML Label extension** — Info popup panel with rich content (text, image, YouTube embed)
7. **Switch Object extension** — Toggle mesh group visibility at runtime
8. **Material Picker extension** — Predefined variant list, sphere preview balls, applies to selected objects

### Phase 3 — Material Editor (3–5 weeks)
9. **In-browser material editor** — Right panel UI for:
   - PBR properties (roughness, metallic sliders)
   - Texture upload/swap
   - UV transform (scale, offset, rotation)
   - Emissive toggle + strength
   - Anti-tiling method selector
10. **Reflection probes** — Add IBL probe placement with bounding box; bake into EXR cubemaps

### Phase 4 — Lighting & Sky (4–6 weeks)
11. **Sky / HDRI** — Equirectangular panorama as background + IBL lighting source
12. **In-browser light editor** — Add/remove lights, position gizmos, strength/color controls
13. **Fog system** — Distance fog + height fog in viewer (shader-based)

### Phase 5 — Advanced
14. **Per-object visibility** — Object groups with per-view visibility rules
15. **VR / WebXR** — Three.js VR session support
16. **Audio system** — Positional/ambient audio tied to camera volumes or hotspot triggers
17. **Viewer API / Script extensions** — Documented JS API for custom embed behaviors

---

## 5. Technical Notes

### Lightmap / Baked GI
- ShapeSpark: Blender Cycles 4.4 + xatlas auto UV2 unwrap → RGBD lightmap textures (PNG/WebP)
- Our implementation: same Cycles pipeline via `scripts/bake-lightmap.mjs`
- three.js r151+: TEXCOORD_1 → attribute `uv1` (not `uv2`); `texture.channel = 1` for lightmap UV
- `rendering.ambientIntensity` manifest flag scales real-time lights (hemisphere + directional) for baked scenes — prevents double-illumination

### Material System
- ShapeSpark uses `extras.json` sidecar file for per-material properties FBX/OBJ can't carry (roughness, metallic, emissive)
- Our approach: same extras sidecar pattern supported in manifest; Blender exports these as glTF PBR

### Double-Sided Materials
- ShapeSpark: per-material checkbox in editor
- Our approach: `rendering.doubleSidedMaterials: true` applies to all materials; Blender `use_backface_culling = False` bakes the flag into glTF `doubleSided: true` per material
- Auto-applied for meshes named "wall", "floor", "ceiling" regardless of manifest flag

### Camera & Navigation
- ShapeSpark: Walk (FPS), Orbit, Top — same 3 modes we support
- Max walk speed, FOV, auto-climb all driven by manifest/editor config
- Camera volumes: AABB zones with per-volume `exposure` and `gamma` overrides → maps directly to manifest `cameraVolumes[]` array

### Hotspot Architecture
- ShapeSpark: billboards rendered as `THREE.Sprite` with custom `SpriteMaterial`
- Trigger types map to: raycasting against sprite bounds (sprite trigger), mesh raycasting (3D object click), camera AABB test per frame (volume trigger)
- Extension data stored in scene manifest; viewer reads and instantiates at load time

### Reflection Probes
- ShapeSpark: renders 6-face cubemap per probe during bake; stores as DDS/KTX
- three.js: `PMREMGenerator` + `RGBELoader` for equirectangular; or `CubeCamera` for real-time
- Box-projected reflections: custom shader uniform for bounding box projection correction

---

## 6. ShapeSpark Viewer UI Elements We're Missing (Quick Reference)

```
[ ] Hotspot sprites (billboard overlays in 3D)
[ ] HTML info panel popup
[ ] Material picker side panel
[ ] Switch object toggle buttons
[ ] Auto-tour play/pause button
[ ] Camera volume zones (invisible, but affect exposure)
[ ] "Share" button in viewer chrome
[ ] Minimap click-to-teleport with pathfinding
[ ] Multi-floor minimap level tabs
[ ] Fog overlay (distance + height)
[ ] HDRI / sky dome background
[ ] VR mode button (when WebXR available)
```

---

*Generated from live ShapeSpark cloud viewer exploration + help.shapespark.com documentation research.*
