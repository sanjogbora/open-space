import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--")) ?? "apps/viewer-demo/public/scenes/demo";
const resolutionArg = args.find((arg) => arg.startsWith("--resolution="));
const samplesArg = args.find((arg) => arg.startsWith("--samples="));
const marginArg = args.find((arg) => arg.startsWith("--margin="));
const modeArg = args.find((arg) => arg.startsWith("--mode="));
const bundleDir = path.resolve(target);
const blenderCommand = process.env.BLENDER_PATH || "blender";
const resolution = Number(resolutionArg?.split("=")[1] ?? process.env.LIGHTMAP_RESOLUTION ?? 1024);
const samples = Number(samplesArg?.split("=")[1] ?? process.env.LIGHTMAP_SAMPLES ?? 96);
const margin = Number(marginArg?.split("=")[1] ?? process.env.LIGHTMAP_MARGIN ?? 16);
const requestedBakeMode = String(modeArg?.split("=")[1] ?? process.env.LIGHTMAP_BAKE_MODE ?? "lighting").toLowerCase();
const bakeMode = ["lighting", "combined"].includes(requestedBakeMode) ? requestedBakeMode : "lighting";
const outputSceneUrl = "scene.lightmapped.glb";

function jobId(timestamp) {
  return `bake-${timestamp.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z")}`;
}

function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function step(id, label, status = "pending", note) {
  return {
    id,
    label,
    status,
    ...(note ? { note } : {})
  };
}

async function writeJob(job) {
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, "lightmap-bake-job.json"), `${JSON.stringify(job, null, 2)}\n`);
}

function runBlender(scriptPath, configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      blenderCommand,
      ["--background", "--factory-startup", "--python", scriptPath, "--", configPath],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || stdout || `Blender exited with ${code}.`));
    });
  });
}

const blenderPython = String.raw`
import bpy
import json
import math
import mathutils
import os
import re
import sys

args = sys.argv[sys.argv.index("--") + 1:]
config_path = args[0]
with open(config_path, "r", encoding="utf8") as handle:
    config = json.load(handle)

source_path = config["sourcePath"]
output_glb = config["outputGlb"]
lightmap_dir = config["lightmapDir"]
report_path = config["reportPath"]
resolution = int(config["resolution"])
samples = int(config["samples"])
margin = int(config["margin"])
bake_mode = config.get("bakeMode", "lighting")

def clean_name(value):
    value = re.sub(r"[^A-Za-z0-9_.-]+", "-", value or "material").strip("-")
    return (value or "material")[:72]

def clamp_power_of_two(value, minimum, maximum):
    value = max(minimum, min(maximum, int(value)))
    power = 1
    while power < value:
        power *= 2
    lower = max(minimum, power // 2)
    return lower if abs(value - lower) < abs(power - value) else min(maximum, power)

def object_footprint_area(obj):
    corners = [obj.matrix_world @ mathutils.Vector(corner) for corner in obj.bound_box]
    min_x = min(corner.x for corner in corners)
    max_x = max(corner.x for corner in corners)
    min_z = min(corner.z for corner in corners)
    max_z = max(corner.z for corner in corners)
    return max(0.01, abs(max_x - min_x) * abs(max_z - min_z))

def lightmap_size_for_area(area):
    if area < 1.25:
        return min(512, resolution)
    if area < 5:
        return min(1024, resolution)
    if area < 16:
        return min(1536, resolution)
    return resolution

os.makedirs(lightmap_dir, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
bpy.ops.import_scene.gltf(filepath=source_path)

meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
if not meshes:
    raise RuntimeError("No mesh objects were imported from the source model.")

for obj in meshes:
    for slot_index, slot in enumerate(obj.material_slots):
        base = slot.material or bpy.data.materials.new("Material")
        material = base.copy()
        material.name = clean_name(f"{base.name}-{obj.name}-{slot_index}")
        material.use_nodes = True
        slot.material = material

for obj in meshes:
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    if len(obj.data.uv_layers) == 0:
        base_uv = obj.data.uv_layers.new(name="UVMap")
        obj.data.uv_layers.active = base_uv
        obj.data.uv_layers.active_render = base_uv
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.015, area_weight=0.2)
        bpy.ops.object.mode_set(mode="OBJECT")
    uv = obj.data.uv_layers.get("Lightmap") or obj.data.uv_layers.new(name="Lightmap")
    obj.data.uv_layers.active = uv
    obj.data.uv_layers.active_render = uv
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.035, area_weight=0.2)
    bpy.ops.object.mode_set(mode="OBJECT")

if not any(obj.type == "LIGHT" for obj in bpy.context.scene.objects):
    light_data = bpy.data.lights.new("Walkthrough Bake Area", type="AREA")
    light_data.energy = 450
    light_data.size = 5
    light_obj = bpy.data.objects.new("Walkthrough Bake Area", light_data)
    bpy.context.collection.objects.link(light_obj)
    light_obj.location = (0, 5, 4)

bpy.context.scene.render.engine = "CYCLES"
bpy.context.scene.cycles.samples = samples
bpy.context.scene.cycles.use_denoising = True
bpy.context.scene.world = bpy.context.scene.world or bpy.data.worlds.new("World")
bpy.context.scene.world.color = (0.78, 0.82, 0.88)

materials = []
seen = set()
material_areas = {}
for obj in meshes:
    for slot in obj.material_slots:
        material = slot.material
        if material and material.name not in seen:
            materials.append(material)
            seen.add(material.name)
        if material:
            material_areas[material.name] = max(material_areas.get(material.name, 0), object_footprint_area(obj))

lightmaps = []
for material in materials:
    nodes = material.node_tree.nodes
    material_resolution = clamp_power_of_two(lightmap_size_for_area(material_areas.get(material.name, 1)), 256, resolution)
    image = bpy.data.images.new(f"{material.name}-lightmap", width=material_resolution, height=material_resolution, alpha=False, float_buffer=False)
    image.generated_color = (1.0, 1.0, 1.0, 1.0)
    node = nodes.new(type="ShaderNodeTexImage")
    node.name = "WalkthroughLightmapBake"
    node.label = "Walkthrough Lightmap Bake"
    node.image = image
    nodes.active = node
    relative_url = f"lightmaps/{clean_name(material.name)}.png"
    lightmaps.append({
        "materialName": material.name,
        "relativeUrl": relative_url,
        "imageName": image.name,
        "outputPath": os.path.join(lightmap_dir, f"{clean_name(material.name)}.png"),
        "resolution": material_resolution
    })

bpy.ops.object.select_all(action="DESELECT")
for obj in meshes:
    obj.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if bake_mode == "combined":
    bpy.ops.object.bake(type="COMBINED", margin=margin, use_clear=True)
else:
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=margin, use_clear=True)

for entry in lightmaps:
    image = bpy.data.images[entry["imageName"]]
    image.filepath_raw = entry["outputPath"]
    image.file_format = "PNG"
    image.save()

bpy.ops.export_scene.gltf(filepath=output_glb, export_format="GLB", export_texcoords=True, export_materials="EXPORT", export_yup=True)

with open(report_path, "w", encoding="utf8") as handle:
    json.dump({
        "materialCount": len(materials),
        "lightmaps": [{"materialName": item["materialName"], "url": item["relativeUrl"], "resolution": item["resolution"]} for item in lightmaps]
    }, handle, indent=2)
`;

const timestamp = new Date().toISOString();
const id = jobId(timestamp);
const manifestPath = path.join(bundleDir, "scene.manifest.json");
const materialsPath = path.join(bundleDir, "materials.json");
const initialSteps = [
  step("detect-blender", "Detect Blender renderer"),
  step("unwrap-uv2", "Create secondary lightmap UVs"),
  step("bake-cycles", "Bake indirect lighting and shadows"),
  step("assign-lightmaps", "Assign generated lightmaps to materials")
];

const hasBlender = await commandAvailable(blenderCommand);
if (!hasBlender) {
  const job = {
    schemaVersion: "0.1",
    id,
    status: "blocked",
    startedAt: timestamp,
    completedAt: timestamp,
    engine: "blender-cycles",
    bakeMode,
    message: "Blender was not found. Install Blender or set BLENDER_PATH before running automatic lightmap baking.",
    steps: [
      step("detect-blender", "Detect Blender renderer", "failed", "blender --version failed"),
      ...initialSteps.slice(1)
    ]
  };
  await writeJob(job);
  console.log(JSON.stringify(job, null, 2));
  process.exit(0);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const manifestSceneUrl = manifest.sceneUrl ?? "scene.glb";
const fallbackSourceUrl = manifest.originalSceneUrl && manifestSceneUrl === outputSceneUrl
  ? manifest.originalSceneUrl
  : manifestSceneUrl;
const sceneUrl = fallbackSourceUrl ?? manifestSceneUrl;
const sourcePath = path.resolve(bundleDir, sceneUrl);
if (!(await fileExists(sourcePath))) {
  throw new Error(`Scene source not found: ${sceneUrl}`);
}

const startedJob = {
  schemaVersion: "0.1",
  id,
  status: "running",
  startedAt: timestamp,
  engine: "blender-cycles",
  message: `Baking ${sceneUrl} with Blender.`,
  bakeMode,
  steps: [
    step("detect-blender", "Detect Blender renderer", "completed", `Using ${blenderCommand}`),
    ...initialSteps.slice(1)
  ]
};
await writeJob(startedJob);

const scriptPath = path.join(bundleDir, ".lightmap-bake.py");
const configPath = path.join(bundleDir, ".lightmap-bake-config.json");
const reportPath = path.join(bundleDir, "lightmaps", "lightmap-report.json");
const outputGlb = path.join(bundleDir, outputSceneUrl);
await Promise.all([
  rm(outputGlb, { force: true }),
  rm(path.join(bundleDir, "lightmaps"), { recursive: true, force: true })
]);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(scriptPath, blenderPython);
await writeFile(
  configPath,
  `${JSON.stringify(
    {
      sourcePath,
      outputGlb,
      lightmapDir: path.join(bundleDir, "lightmaps"),
      reportPath,
      resolution,
      samples,
      margin,
      bakeMode
    },
    null,
    2
  )}\n`
);

try {
  await runBlender(scriptPath, configPath);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const existingMaterials = JSON.parse(await readFile(materialsPath, "utf8"));
  const byName = new Map((existingMaterials.materials ?? []).map((material) => [material.name, material]));
  for (const lightmap of report.lightmaps ?? []) {
    const existing = byName.get(lightmap.materialName) ?? {
      id: `mat-baked-${lightmap.materialName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "material"}`,
      name: lightmap.materialName
    };
    byName.set(lightmap.materialName, {
      ...existing,
      lightMapUrl: lightmap.url,
      lightMapIntensity: existing.lightMapIntensity ?? 1,
      lightMapUvSet: 1
    });
  }

  await writeFile(
    materialsPath,
    `${JSON.stringify(
      {
        ...existingMaterials,
        generator: "walkthrough-lightmap-bake",
        source: outputSceneUrl,
        materials: [...byName.values()]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        sceneUrl: outputSceneUrl,
        originalSceneUrl: manifest.originalSceneUrl ?? sceneUrl,
        materialsUrl: manifest.materialsUrl ?? "materials.json",
        rendering: {
          ...manifest.rendering,
          doubleSidedMaterials: true
        }
      },
      null,
      2
    )}\n`
  );

  const completedAt = new Date().toISOString();
  const job = {
    ...startedJob,
    status: "completed",
    completedAt,
    message: `Baked ${report.lightmaps?.length ?? 0} lightmap texture(s) and exported ${outputSceneUrl}.`,
    outputSceneUrl,
    lightmapCount: report.lightmaps?.length ?? 0,
    resolution,
    samples,
    margin,
    bakeMode,
    steps: [
      step("detect-blender", "Detect Blender renderer", "completed", `Using ${blenderCommand}`),
      step("unwrap-uv2", "Create secondary lightmap UVs", "completed", "Generated Lightmap UVs with Blender smart projection."),
      step("bake-cycles", "Bake indirect lighting and shadows", "completed", `${samples} Cycles samples with automatic 256-${resolution}px ${bakeMode} lightmaps.`),
      step("assign-lightmaps", "Assign generated lightmaps to materials", "completed", "Updated materials.json and scene manifest.")
    ]
  };
  await writeJob(job);
  console.log(JSON.stringify(job, null, 2));
} catch (error) {
  const completedAt = new Date().toISOString();
  const job = {
    ...startedJob,
    status: "failed",
    completedAt,
    message: error instanceof Error ? error.message : "Lightmap bake failed.",
    steps: [
      step("detect-blender", "Detect Blender renderer", "completed", `Using ${blenderCommand}`),
      step("unwrap-uv2", "Create secondary lightmap UVs", "failed"),
      step("bake-cycles", "Bake indirect lighting and shadows", "pending"),
      step("assign-lightmaps", "Assign generated lightmaps to materials", "pending")
    ]
  };
  await writeJob(job);
  console.log(JSON.stringify(job, null, 2));
  process.exitCode = 1;
}
