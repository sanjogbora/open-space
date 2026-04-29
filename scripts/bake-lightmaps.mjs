import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const target = process.argv.find((arg, index) => index > 1 && !arg.startsWith("--")) ?? "apps/viewer-demo/public/scenes/demo";
const bundleDir = path.resolve(target);
const blenderCommand = process.env.BLENDER_PATH || "blender";

function commandAvailable(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

const timestamp = new Date().toISOString();
const hasBlender = await commandAvailable(blenderCommand);
const job = {
  schemaVersion: "0.1",
  id: `bake-${timestamp.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z")}`,
  status: hasBlender ? "blocked" : "blocked",
  startedAt: timestamp,
  completedAt: timestamp,
  engine: "blender-cycles",
  message: hasBlender
    ? "Blender is available, but automatic UV unwrap and bake export is not enabled in this build yet."
    : "Blender was not found. Install Blender or set BLENDER_PATH before running automatic lightmap baking.",
  steps: [
    {
      id: "detect-blender",
      label: "Detect Blender renderer",
      status: hasBlender ? "completed" : "failed",
      note: hasBlender ? `Using ${blenderCommand}` : "blender --version failed"
    },
    {
      id: "unwrap-uv2",
      label: "Create secondary lightmap UVs",
      status: "pending"
    },
    {
      id: "bake-cycles",
      label: "Bake indirect lighting and shadows",
      status: "pending"
    },
    {
      id: "assign-lightmaps",
      label: "Assign generated lightmaps to materials",
      status: "pending"
    }
  ]
};

await mkdir(bundleDir, { recursive: true });
await writeFile(path.join(bundleDir, "lightmap-bake-job.json"), `${JSON.stringify(job, null, 2)}\n`);
console.log(JSON.stringify(job, null, 2));
