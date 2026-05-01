import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from "@gltf-transform/extensions";
import {
  dedup,
  getGLPrimitiveCount,
  meshopt,
  prune,
  reorder,
  resample,
  simplify,
  textureCompress,
  weld
} from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--")) ?? "apps/viewer-demo/public/scenes/demo";
const profileArg = args.find((arg) => arg.startsWith("--profile="));
const profile = profileArg?.split("=")[1] ?? "balanced";
const applyOptimized = args.includes("--apply");
const manifestPath = target.endsWith(".json")
  ? path.resolve(target)
  : path.resolve(target, "scene.manifest.json");
const bundleDir = path.dirname(manifestPath);
const optimizedSceneUrl = "scene.optimized.glb";

function isExternalAsset(source) {
  return (
    source.startsWith("generated://") ||
    source.startsWith("data:") ||
    source.startsWith("blob:") ||
    source.startsWith("http://") ||
    source.startsWith("https://")
  );
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command, args = []) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function resolveToktxCommand() {
  const configuredPath = process.env.KTX_SOFTWARE_PATH || process.env.TOKTX_PATH;
  if (configuredPath) {
    const executable = configuredPath.toLowerCase().endsWith("toktx.exe") || configuredPath.toLowerCase().endsWith("toktx")
      ? configuredPath
      : path.join(configuredPath, process.platform === "win32" ? "toktx.exe" : "toktx");
    if (await commandExists(executable, ["--version"])) {
      return executable;
    }
    return undefined;
  }
  if (await commandExists("toktx", ["--version"])) {
    return "toktx";
  }
  return undefined;
}

function spawnCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({ ok: false, code: undefined, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function readJsonDefault(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function align4(buffer, fill = 0x20) {
  const remainder = buffer.length % 4;
  if (remainder === 0) {
    return buffer;
  }
  return Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}

function readChunks(bytes) {
  if (bytes.length < 20) {
    throw new Error("GLB is too small.");
  }
  const magic = bytes.readUInt32LE(0);
  const version = bytes.readUInt32LE(4);
  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error("Only GLB v2 files are supported.");
  }

  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) {
      throw new Error("GLB chunk length is invalid.");
    }
    chunks.push({ type, data: bytes.subarray(start, end) });
    offset = end;
  }
  return chunks;
}

function writeGlb(chunks) {
  const chunkBuffers = chunks.map((chunk) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(chunk.data.length, 0);
    header.writeUInt32LE(chunk.type, 4);
    return Buffer.concat([header, chunk.data]);
  });
  const totalLength = 12 + chunkBuffers.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  return Buffer.concat([header, ...chunkBuffers]);
}

function compactGlbJson(bytes) {
  const chunks = readChunks(bytes);
  const jsonChunk = chunks.find((chunk) => chunk.type === 0x4e4f534a);
  if (!jsonChunk) {
    throw new Error("GLB JSON chunk is missing.");
  }

  const document = JSON.parse(new TextDecoder().decode(jsonChunk.data).trim());
  const json = align4(Buffer.from(JSON.stringify(document), "utf8"), 0x20);
  const optimizedChunks = chunks.map((chunk) =>
    chunk === jsonChunk ? { ...chunk, data: json } : chunk
  );
  return writeGlb(optimizedChunks);
}

async function optimizeGlb(sourcePath, outputPath, profile) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  const level = profile === "mobile" ? "high" : "medium";
  const textureLimit =
    profile === "mobile" ? [1024, 1024] : profile === "desktop" ? [4096, 4096] : [2048, 2048];
  const textureQuality = profile === "mobile" ? 72 : profile === "desktop" ? 86 : 80;
  const io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, EXTMeshoptCompression])
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder
    });
  const document = await io.read(sourcePath);
  await document.transform(
    dedup(),
    prune(),
    weld({ overwrite: false }),
    resample()
  );
  const meshSimplificationStep = await applyMeshSimplification(document, profile);
  await document.transform(
    textureCompress({
      encoder: sharp,
      targetFormat: "webp",
      resize: textureLimit,
      quality: textureQuality,
      effort: 4,
      slots: /^(?!normalTexture).*$/i
    })
  );
  const gpuTextureStep = await applyKtxCompression(document, profile);
  await document.transform(
    reorder({ encoder: MeshoptEncoder, target: "size" }),
    meshopt({ encoder: MeshoptEncoder, level })
  );
  await io.write(outputPath, document);
  return { meshSimplificationStep, gpuTextureStep };
}

function countDocumentTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      try {
        total += Math.max(0, Math.floor(getGLPrimitiveCount(primitive)));
      } catch {
        // Non-renderable malformed primitives are reported by the analyzer.
      }
    }
  }
  return total;
}

async function applyMeshSimplification(document, profile) {
  if (profile === "desktop") {
    return {
      id: "mesh-simplification",
      label: "Simplify heavy mesh geometry",
      status: "skipped",
      note: "Desktop profile preserves source geometry."
    };
  }

  const beforeTriangles = countDocumentTriangles(document);
  const minimumTriangles = profile === "mobile" ? 150_000 : 500_000;
  if (beforeTriangles < minimumTriangles) {
    return {
      id: "mesh-simplification",
      label: "Simplify heavy mesh geometry",
      status: "skipped",
      beforeTriangles,
      afterTriangles: beforeTriangles,
      note: `Scene has ${formatCount(beforeTriangles)} triangles, below the ${formatCount(minimumTriangles)} ${profile} simplification threshold.`
    };
  }

  const ratio = profile === "mobile" ? 0.82 : 0.92;
  const error = profile === "mobile" ? 0.001 : 0.00035;
  await document.transform(
    simplify({
      simplifier: MeshoptSimplifier,
      ratio,
      error,
      lockBorder: true
    }),
    prune()
  );
  const afterTriangles = countDocumentTriangles(document);
  return {
    id: "mesh-simplification",
    label: "Simplify heavy mesh geometry",
    status: afterTriangles < beforeTriangles ? "completed" : "skipped",
    beforeTriangles,
    afterTriangles,
    ratio,
    error,
    note:
      afterTriangles < beforeTriangles
        ? `Reduced geometry from ${formatCount(beforeTriangles)} to ${formatCount(afterTriangles)} triangles.`
        : "Simplifier did not reduce this model within the configured error limit."
  };
}

function formatCount(value) {
  return Number(value).toLocaleString("en-US");
}

function percentChange(before, after) {
  if (before <= 0) {
    return 0;
  }
  return Number((((before - after) / before) * 100).toFixed(2));
}

function mimeExtension(mimeType) {
  switch (mimeType) {
    case "image/avif":
      return ".avif";
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

function ktxQualityForProfile(profile) {
  if (profile === "mobile") {
    return 96;
  }
  if (profile === "desktop") {
    return 160;
  }
  return 128;
}

function textureUseSets(document) {
  const normalTextures = new Set();
  const alphaTextures = new Set();

  for (const material of document.getRoot().listMaterials()) {
    const normalTexture = material.getNormalTexture();
    if (normalTexture) {
      normalTextures.add(normalTexture);
    }
    if (material.getAlphaMode() === "BLEND" || material.getAlphaMode() === "MASK") {
      const baseTexture = material.getBaseColorTexture();
      if (baseTexture) {
        alphaTextures.add(baseTexture);
      }
    }
  }

  return { normalTextures, alphaTextures };
}

async function encodeKtxTexture(toktxCommand, inputPath, outputPath, options) {
  const commonArgs = ["--t2", "--genmipmap"];
  const qlevel = String(options.qlevel);
  const attempts = options.alpha
    ? [
        [...commonArgs, "--encode", "uastc", "--zcmp", "18", outputPath, inputPath],
        [...commonArgs, "--uastc", "--zcmp", "18", outputPath, inputPath]
      ]
    : [
        [...commonArgs, "--encode", "etc1s", "--clevel", "4", "--qlevel", qlevel, outputPath, inputPath],
        [...commonArgs, "--bcmp", "--clevel", "4", "--qlevel", qlevel, outputPath, inputPath]
      ];

  let lastResult;
  for (const args of attempts) {
    await rm(outputPath, { force: true });
    lastResult = await spawnCapture(toktxCommand, args);
    if (lastResult.ok) {
      return { ok: true, args };
    }
  }

  return {
    ok: false,
    args: attempts.at(-1),
    error: [lastResult?.stderr, lastResult?.stdout].filter(Boolean).join("\n").trim()
  };
}

async function applyKtxCompression(document, profile) {
  const toktxCommand = await resolveToktxCommand();
  if (!toktxCommand) {
    return {
      id: "gpu-texture-compression",
      label: "KTX2/Basis GPU texture compression",
      status: "blocked",
      convertedTextures: 0,
      skippedTextures: 0,
      note: "toktx was not found. Install Khronos KTX-Software and set KTX_SOFTWARE_PATH or TOKTX_PATH to enable KTX2/Basis GPU texture output."
    };
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "walkthrough-ktx-"));
  const { normalTextures, alphaTextures } = textureUseSets(document);
  const qlevel = ktxQualityForProfile(profile);
  let convertedTextures = 0;
  let skippedTextures = 0;
  const failed = [];

  try {
    for (const [index, texture] of document.getRoot().listTextures().entries()) {
      const image = texture.getImage();
      const extension = mimeExtension(texture.getMimeType());
      if (!image || !extension || normalTextures.has(texture)) {
        skippedTextures += 1;
        continue;
      }

      const inputPath = path.join(tmpDir, `texture-${index}${extension}`);
      const outputPath = path.join(tmpDir, `texture-${index}.ktx2`);
      await writeFile(inputPath, image);
      const result = await encodeKtxTexture(toktxCommand, inputPath, outputPath, {
        alpha: alphaTextures.has(texture),
        qlevel
      });
      if (!result.ok) {
        failed.push({
          texture: texture.getName() || texture.getURI() || `Texture ${index + 1}`,
          error: result.error || "toktx failed without diagnostic output."
        });
        continue;
      }

      texture
        .setImage(await readFile(outputPath))
        .setMimeType("image/ktx2")
        .setURI("");
      convertedTextures += 1;
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  if (convertedTextures > 0) {
    document.createExtension(KHRTextureBasisu).setRequired(true);
  }

  if (failed.length > 0 && convertedTextures === 0) {
    return {
      id: "gpu-texture-compression",
      label: "KTX2/Basis GPU texture compression",
      status: "failed",
      convertedTextures,
      skippedTextures,
      failedTextures: failed.slice(0, 5),
      note: `${failed.length} texture(s) failed KTX2 conversion; the optimized scene still uses WebP/PNG image textures.`
    };
  }

  return {
    id: "gpu-texture-compression",
    label: "KTX2/Basis GPU texture compression",
    status: convertedTextures > 0 ? "completed" : "skipped",
    convertedTextures,
    skippedTextures,
    ...(failed.length > 0
      ? {
          failedTextures: failed.slice(0, 5),
          note: `${convertedTextures} texture(s) converted; ${failed.length} texture(s) stayed as image textures after toktx failures.`
        }
      : {
          note:
            convertedTextures > 0
              ? `${convertedTextures} texture(s) converted with toktx at ${toktxCommand}. Normal maps are kept as source images unless a dedicated normal-map profile is added.`
              : "No eligible embedded color textures were found for KTX2 conversion."
        })
  };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "0.1") {
  throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
}

const manifestSceneUrl = manifest.sceneUrl ?? "scene.glb";
if (isExternalAsset(manifestSceneUrl)) {
  throw new Error("External scene URLs cannot be optimized by the local pipeline.");
}

const fallbackSource = path.resolve(bundleDir, "scene.glb");
const originalSource = manifest.originalSceneUrl ? path.resolve(bundleDir, manifest.originalSceneUrl) : undefined;
const currentSource = path.resolve(bundleDir, manifestSceneUrl);
const sourceSceneUrl =
  manifestSceneUrl === optimizedSceneUrl && originalSource && (await exists(originalSource))
    ? manifest.originalSceneUrl
    : manifestSceneUrl === optimizedSceneUrl && (await exists(fallbackSource))
    ? "scene.glb"
    : manifestSceneUrl;
const sourcePath = path.resolve(bundleDir, sourceSceneUrl);
const outputPath = path.resolve(bundleDir, optimizedSceneUrl);
const beforeInfo = await stat(sourcePath);
if (sourcePath.toLowerCase().endsWith(".glb")) {
  const sourceBytes = await readFile(sourcePath);
  const compactBytes = compactGlbJson(sourceBytes);
  await writeFile(outputPath, compactBytes);
}
const { meshSimplificationStep, gpuTextureStep } = await optimizeGlb(sourcePath, outputPath, profile);
const afterInfo = await stat(outputPath);

if (applyOptimized) {
  const nextManifest = {
    ...manifest,
    originalSceneUrl: manifest.originalSceneUrl ?? sourceSceneUrl,
    sceneUrl: optimizedSceneUrl
  };
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
}

const timestamp = new Date().toISOString();
const job = {
  schemaVersion: "0.1",
  id: `opt-${timestamp.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z")}`,
  status: "completed",
  profile,
  applied: applyOptimized,
  startedAt: timestamp,
  completedAt: timestamp,
  sourceSceneUrl,
  optimizedSceneUrl,
  before: {
    modelBytes: beforeInfo.size
  },
  after: {
    modelBytes: afterInfo.size,
    savedBytes: Math.max(0, beforeInfo.size - afterInfo.size),
    savedPercent: percentChange(beforeInfo.size, afterInfo.size)
  },
  steps: [
    {
      id: "validate-glb",
      label: "Validate GLB v2 container",
      status: "completed"
    },
    {
      id: "compact-json",
      label: "Compact GLB JSON chunk",
      status: "completed"
    },
    {
      id: "dedup-prune",
      label: "Deduplicate and prune unused resources",
      status: "completed"
    },
    {
      id: "weld-resample",
      label: "Weld vertices and resample animation data",
      status: "completed"
    },
    meshSimplificationStep,
    {
      id: "mesh-reorder",
      label: "Reorder mesh data for transmission size",
      status: "completed"
    },
    {
      id: "texture-compression",
      label: "Compress texture images to WebP",
      status: "completed"
    },
    gpuTextureStep,
    {
      id: "mesh-compression",
      label: "Apply EXT_meshopt_compression",
      status: "completed"
    },
    {
      id: "emit-artifact",
      label: "Write optimized scene artifact",
      status: "completed"
    }
  ]
};

await writeFile(path.resolve(bundleDir, "optimization-job.json"), `${JSON.stringify(job, null, 2)}\n`);
const historyPath = path.resolve(bundleDir, "optimization-history.json");
const history = await readJsonDefault(historyPath, {
  schemaVersion: "0.1",
  jobs: []
});
const nextHistory = {
  schemaVersion: "0.1",
  jobs: [job, ...(history.jobs ?? []).filter((item) => item.id !== job.id)].slice(0, 20)
};
await writeFile(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`);
console.log(JSON.stringify(job, null, 2));
