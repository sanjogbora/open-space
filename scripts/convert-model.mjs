import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--")) ?? "apps/viewer-demo/public/scenes/demo";
const sourceArg = args.find((arg) => arg.startsWith("--source="));
const outputArg = args.find((arg) => arg.startsWith("--output="));
const bundleDir = path.resolve(target);
const sourceRelative = sourceArg?.split("=").slice(1).join("=") ?? "";
const outputSceneUrl = outputArg?.split("=").slice(1).join("=") || "scene.glb";
const sourcePath = path.resolve(bundleDir, sourceRelative);
const outputPath = path.resolve(bundleDir, outputSceneUrl);
const blenderCommand = process.env.BLENDER_PATH || "blender";

function step(id, label, status = "pending", note) {
  return {
    id,
    label,
    status,
    ...(note ? { note } : {})
  };
}

function jobId(timestamp) {
  return `convert-${timestamp.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z")}`;
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

async function writeJob(job) {
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, "conversion-job.json"), `${JSON.stringify(job, null, 2)}\n`);
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
import os
import sys

args = sys.argv[sys.argv.index("--") + 1:]
config_path = args[0]
with open(config_path, "r", encoding="utf8") as handle:
    config = json.load(handle)

source_path = config["sourcePath"]
output_path = config["outputPath"]
extension = os.path.splitext(source_path)[1].lower()

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

if extension == ".blend":
    try:
        bpy.ops.wm.open_mainfile(filepath=source_path, load_ui=False, use_scripts=False)
    except TypeError:
        bpy.ops.wm.open_mainfile(filepath=source_path, load_ui=False)
elif extension == ".fbx":
    bpy.ops.import_scene.fbx(filepath=source_path)
elif extension == ".obj":
    if hasattr(bpy.ops.wm, "obj_import"):
        bpy.ops.wm.obj_import(filepath=source_path)
    else:
        bpy.ops.import_scene.obj(filepath=source_path)
elif extension == ".dae":
    bpy.ops.wm.collada_import(filepath=source_path)
else:
    raise RuntimeError(f"Unsupported source extension: {extension}")

mesh_count = len([item for item in bpy.context.scene.objects if item.type == "MESH"])
if mesh_count == 0:
    raise RuntimeError("Converted scene has no mesh objects.")

os.makedirs(os.path.dirname(output_path), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_materials="EXPORT"
)
`;

const timestamp = new Date().toISOString();
const baseJob = {
  schemaVersion: "0.1",
  id: jobId(timestamp),
  status: "running",
  engine: "blender",
  startedAt: timestamp,
  source: sourceRelative,
  outputSceneUrl,
  steps: [
    step("detect-blender", "Detect Blender converter", "pending"),
    step("validate-source", "Validate source model", "pending"),
    step("import-source", "Import source model", "pending"),
    step("export-glb", "Export glTF binary scene", "pending")
  ]
};

await writeJob(baseJob);

if (!sourceRelative || path.relative(bundleDir, sourcePath).startsWith("..")) {
  const job = {
    ...baseJob,
    status: "failed",
    completedAt: new Date().toISOString(),
    message: "Source path must be inside the scene bundle.",
    steps: [
      step("detect-blender", "Detect Blender converter", "skipped"),
      step("validate-source", "Validate source model", "failed", "Unsafe or missing source path."),
      step("import-source", "Import source model", "skipped"),
      step("export-glb", "Export glTF binary scene", "skipped")
    ]
  };
  await writeJob(job);
  throw new Error(job.message);
}

if (!(await commandAvailable(blenderCommand))) {
  const job = {
    ...baseJob,
    status: "blocked",
    completedAt: new Date().toISOString(),
    message: "Blender was not found. Install Blender or set BLENDER_PATH.",
    steps: [
      step("detect-blender", "Detect Blender converter", "failed", `${blenderCommand} --version failed`),
      step("validate-source", "Validate source model", "skipped"),
      step("import-source", "Import source model", "skipped"),
      step("export-glb", "Export glTF binary scene", "skipped")
    ]
  };
  await writeJob(job);
  throw new Error(job.message);
}

if (!(await fileExists(sourcePath))) {
  const job = {
    ...baseJob,
    status: "failed",
    completedAt: new Date().toISOString(),
    message: "Uploaded source model was not found.",
    steps: [
      step("detect-blender", "Detect Blender converter", "completed", `Using ${blenderCommand}`),
      step("validate-source", "Validate source model", "failed", sourceRelative),
      step("import-source", "Import source model", "skipped"),
      step("export-glb", "Export glTF binary scene", "skipped")
    ]
  };
  await writeJob(job);
  throw new Error(job.message);
}

const configPath = path.join(bundleDir, ".convert-model-config.json");
const scriptPath = path.join(bundleDir, ".convert-model.py");
await writeFile(configPath, `${JSON.stringify({ sourcePath, outputPath }, null, 2)}\n`);
await writeFile(scriptPath, blenderPython);

try {
  await runBlender(scriptPath, configPath);
  const outputBytes = (await readFile(outputPath)).length;
  const job = {
    ...baseJob,
    status: "completed",
    completedAt: new Date().toISOString(),
    outputBytes,
    message: `Converted ${sourceRelative} to ${outputSceneUrl}.`,
    steps: [
      step("detect-blender", "Detect Blender converter", "completed", `Using ${blenderCommand}`),
      step("validate-source", "Validate source model", "completed"),
      step("import-source", "Import source model", "completed"),
      step("export-glb", "Export glTF binary scene", "completed", `${outputBytes} bytes`)
    ]
  };
  await writeJob(job);
  console.log(JSON.stringify(job, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Model conversion failed.";
  const job = {
    ...baseJob,
    status: "failed",
    completedAt: new Date().toISOString(),
    message,
    steps: [
      step("detect-blender", "Detect Blender converter", "completed", `Using ${blenderCommand}`),
      step("validate-source", "Validate source model", "completed"),
      step("import-source", "Import source model", "failed", message),
      step("export-glb", "Export glTF binary scene", "skipped")
    ]
  };
  await writeJob(job);
  throw error;
}
