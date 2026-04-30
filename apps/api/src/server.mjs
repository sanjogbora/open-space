import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const port = Number(process.env.PORT ?? 5175);
const bundleTargets = [
  path.join(repoRoot, "apps/viewer-demo/public/scenes/demo"),
  path.join(repoRoot, "apps/studio/public/scenes/demo")
];
const sceneRoots = [
  path.join(repoRoot, "apps/viewer-demo/public/scenes"),
  path.join(repoRoot, "apps/studio/public/scenes")
];
const publishedRoot = path.join(repoRoot, "apps/viewer-demo/public/published");
const imageExtensions = new Set([".avif", ".basis", ".jpg", ".jpeg", ".ktx2", ".png", ".webp"]);
const defaultControlsDocument = {
  schemaVersion: "0.1",
  movement: {
    enabled: true,
    clickToMove: true,
    keyboard: true,
    dragLook: true,
    moveSpeed: 3.8,
    clickMoveSpeed: 1.2,
    lookSensitivityX: 0.004,
    lookSensitivityY: 0.0035,
    clickMoveThresholdPx: 8
  }
};
const idleOptimizationJob = {
  schemaVersion: "0.1",
  id: "",
  status: "idle",
  profile: "balanced",
  applied: false,
  steps: []
};

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-file-name"
};

function sendJson(response, status, body) {
  response.writeHead(status, jsonHeaders);
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, jsonHeaders);
  response.end();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonDefault(filePath, fallback) {
  try {
    return await readJson(filePath);
  } catch {
    return fallback;
  }
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : {};
}

function projectIdFromPathname(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/projects/([a-z0-9-]+)${suffix}$`)
    : /^\/api\/projects\/([a-z0-9-]+)$/;
  return pathname.match(pattern)?.[1];
}

function slug(value) {
  const result = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return result || "project";
}

function targetDirs(projectId) {
  return sceneRoots.map((root) => path.join(root, projectId));
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeAll(filename, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  await Promise.all(
    bundleTargets.map((target) => writeFile(path.join(target, filename), payload))
  );
}

async function writeAllBinary(filename, body) {
  await Promise.all(
    bundleTargets.map((target) => writeFile(path.join(target, filename), body))
  );
}

async function writeProjectAll(projectId, filename, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  await Promise.all(
    targetDirs(projectId).map((target) => writeFile(path.join(target, filename), payload))
  );
}

async function writeProjectAllBinary(projectId, filename, body) {
  await Promise.all(
    targetDirs(projectId).map((target) => writeFile(path.join(target, filename), body))
  );
}

async function publishHistory(projectId) {
  return readJsonDefault(path.join(targetDirs(projectId)[0], "publish-history.json"), {
    schemaVersion: "0.1",
    projectId,
    versions: []
  });
}

async function optimizationJob(projectId) {
  return readJsonDefault(path.join(targetDirs(projectId)[0], "optimization-job.json"), {
    schemaVersion: "0.1",
    id: "",
    status: "idle",
    profile: "balanced",
    applied: false,
    steps: []
  });
}

async function optimizationHistory(projectId) {
  return readJsonDefault(path.join(targetDirs(projectId)[0], "optimization-history.json"), {
    schemaVersion: "0.1",
    jobs: []
  });
}

async function lightmapBakeJob(projectId) {
  return readJsonDefault(path.join(targetDirs(projectId)[0], "lightmap-bake-job.json"), {
    schemaVersion: "0.1",
    id: "",
    status: "idle",
    engine: "blender-cycles",
    message: "No lightmap bake job has run for this project.",
    steps: []
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

function commandAvailable(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function localToolStatus() {
  const blenderCommand = process.env.BLENDER_PATH || "blender";
  const configuredToktx = process.env.KTX_SOFTWARE_PATH || process.env.TOKTX_PATH;
  const toktxCommand = configuredToktx
    ? configuredToktx.toLowerCase().endsWith("toktx.exe") || configuredToktx.toLowerCase().endsWith("toktx")
      ? configuredToktx
      : path.join(configuredToktx, process.platform === "win32" ? "toktx.exe" : "toktx")
    : "toktx";
  const awsCommand = process.env.AWS_CLI_PATH || "aws";
  const [blenderReady, toktxReady, awsReady] = await Promise.all([
    commandAvailable(blenderCommand),
    commandAvailable(toktxCommand),
    commandAvailable(awsCommand, ["--version"])
  ]);
  return {
    blender: {
      ready: blenderReady,
      command: blenderCommand,
      purpose: "Cycles lightmap baking",
      action: blenderReady ? "Ready" : "Install Blender or set BLENDER_PATH."
    },
    toktx: {
      ready: toktxReady,
      command: toktxCommand,
      purpose: "KTX2/Basis GPU texture compression",
      action: toktxReady ? "Ready" : "Install Khronos KTX-Software or set KTX_SOFTWARE_PATH/TOKTX_PATH."
    },
    aws: {
      ready: awsReady,
      command: awsCommand,
      purpose: "S3/R2 deployment helper",
      action: awsReady ? "Ready" : "Install AWS CLI or set AWS_CLI_PATH for bucket deployment."
    }
  };
}

function validateGlbBuffer(body) {
  if (body.length < 20) {
    throw badRequest("Uploaded model is too small to be a GLB.");
  }
  const magic = body.readUInt32LE(0);
  const version = body.readUInt32LE(4);
  if (magic !== 0x46546c67 || version !== 2) {
    throw badRequest("Only binary GLB v2 uploads are supported in this milestone.");
  }
}

function parseGlbJsonDocument(body) {
  validateGlbBuffer(body);
  const jsonChunkLength = body.readUInt32LE(12);
  const jsonChunkType = body.readUInt32LE(16);
  if (jsonChunkType !== 0x4e4f534a) {
    throw badRequest("GLB JSON chunk is missing.");
  }
  return JSON.parse(body.subarray(20, 20 + jsonChunkLength).toString("utf8").trim());
}

function validateGltfBuffer(body) {
  let document;
  try {
    document = JSON.parse(body.toString("utf8"));
  } catch {
    throw badRequest("Uploaded GLTF JSON is invalid.");
  }
  if (document?.asset?.version !== "2.0") {
    throw badRequest("Only glTF 2.0 uploads are supported.");
  }
}

function localGltfUri(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.startsWith("data:") &&
    !value.startsWith("blob:") &&
    !value.startsWith("http://") &&
    !value.startsWith("https://")
  );
}

function stripUriQuery(value) {
  return value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
}

function isSafeLocalSceneUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") &&
    !normalized.startsWith("http://") &&
    !normalized.startsWith("https://") &&
    !normalized.startsWith("data:") &&
    !normalized.startsWith("blob:") &&
    !normalized.split("/").some((part) => part === "" || part === "." || part === "..") &&
    (normalized.toLowerCase().endsWith(".glb") || normalized.toLowerCase().endsWith(".gltf"))
  );
}

function isZipBuffer(body) {
  return body.length >= 4 && body.readUInt32LE(0) === 0x04034b50;
}

function safeArchivePath(filename) {
  const normalized = filename.replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.endsWith("/") ||
    normalized.startsWith("__MACOSX/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function findEndOfCentralDirectory(body) {
  const minOffset = Math.max(0, body.length - 0xffff - 22);
  for (let offset = body.length - 22; offset >= minOffset; offset -= 1) {
    if (body.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw badRequest("ZIP archive is missing its central directory.");
}

function extractZipEntries(body) {
  const eocdOffset = findEndOfCentralDirectory(body);
  const entryCount = body.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = body.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > body.length || body.readUInt32LE(offset) !== 0x02014b50) {
      throw badRequest("ZIP central directory is invalid.");
    }

    const method = body.readUInt16LE(offset + 10);
    const compressedSize = body.readUInt32LE(offset + 20);
    const uncompressedSize = body.readUInt32LE(offset + 24);
    const nameLength = body.readUInt16LE(offset + 28);
    const extraLength = body.readUInt16LE(offset + 30);
    const commentLength = body.readUInt16LE(offset + 32);
    const localHeaderOffset = body.readUInt32LE(offset + 42);
    const rawName = body.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const filename = safeArchivePath(rawName);

    if (filename) {
      if (localHeaderOffset + 30 > body.length || body.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw badRequest(`ZIP local header is invalid for ${filename}.`);
      }
      const localNameLength = body.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = body.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > body.length) {
        throw badRequest(`ZIP entry is truncated: ${filename}.`);
      }
      const compressed = body.subarray(dataStart, dataEnd);
      let data;
      if (method === 0) {
        data = Buffer.from(compressed);
      } else if (method === 8) {
        data = inflateRawSync(compressed);
      } else {
        throw badRequest(`Unsupported ZIP compression method ${method} for ${filename}.`);
      }
      if (data.length !== uncompressedSize) {
        throw badRequest(`ZIP entry has an invalid size: ${filename}.`);
      }
      entries.push({ filename, data });
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function archiveSceneUrl(entries) {
  const sceneEntries = entries
    .map((entry) => entry.filename)
    .filter((filename) => {
      const lower = filename.toLowerCase();
      return lower.endsWith(".glb") || lower.endsWith(".gltf");
    })
    .sort((a, b) => {
      const aIsGlb = a.toLowerCase().endsWith(".glb");
      const bIsGlb = b.toLowerCase().endsWith(".glb");
      if (aIsGlb !== bIsGlb) {
        return aIsGlb ? -1 : 1;
      }
      return a.split("/").length - b.split("/").length || a.localeCompare(b);
    });
  return sceneEntries[0];
}

async function writeProjectArchive(projectId, body) {
  const entries = extractZipEntries(body);
  const sceneUrl = archiveSceneUrl(entries);
  if (!sceneUrl) {
    throw badRequest("ZIP uploads must contain a GLB or GLTF scene file.");
  }
  const sceneEntry = entries.find((entry) => entry.filename === sceneUrl);
  if (sceneUrl.toLowerCase().endsWith(".gltf")) {
    validateGltfBuffer(sceneEntry.data);
  } else {
    validateGlbBuffer(sceneEntry.data);
  }

  await Promise.all(
    targetDirs(projectId).flatMap((target) =>
      entries.map(async (entry) => {
        const outputPath = path.join(target, entry.filename);
        const relative = path.relative(target, outputPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw badRequest(`Unsafe ZIP path: ${entry.filename}.`);
        }
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, entry.data);
      })
    )
  );

  return sceneUrl;
}

async function listProjectImages(root, dir = root, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["dist", "node_modules", ".git"].includes(entry.name)) {
        continue;
      }
      await listProjectImages(root, fullPath, files);
      continue;
    }
    if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

function safeProjectOutputPath(root, filePath) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw badRequest(`Unsafe project path: ${filePath}.`);
  }
  return filePath;
}

async function modelDocument(scenePath) {
  const extension = path.extname(scenePath).toLowerCase();
  if (extension === ".glb") {
    return parseGlbJsonDocument(await readFile(scenePath));
  }
  if (extension === ".gltf") {
    return JSON.parse(await readFile(scenePath, "utf8"));
  }
  return undefined;
}

async function repairExternalTexturePaths(projectId) {
  let copied = 0;
  await Promise.all(
    targetDirs(projectId).map(async (target) => {
      const manifest = await readJson(path.join(target, "scene.manifest.json"));
      const sceneUrl = manifest.sceneUrl ?? "scene.glb";
      if (!isSafeLocalSceneUrl(sceneUrl)) {
        return;
      }
      const scenePath = safeProjectOutputPath(target, path.join(target, sceneUrl));
      const document = await modelDocument(scenePath);
      const imageUris = (document?.images ?? [])
        .map((image) => image?.uri)
        .filter(localGltfUri)
        .map(stripUriQuery)
        .filter((uri) => imageExtensions.has(path.extname(uri).toLowerCase()));
      if (imageUris.length === 0) {
        return;
      }

      const looseImages = await listProjectImages(target);
      const imageByName = new Map();
      for (const imagePath of looseImages) {
        const key = path.basename(imagePath).toLowerCase();
        if (!imageByName.has(key)) {
          imageByName.set(key, imagePath);
        }
      }

      await Promise.all(
        imageUris.map(async (uri) => {
          const expectedPath = safeProjectOutputPath(target, path.resolve(path.dirname(scenePath), uri));
          if (await fileExists(expectedPath)) {
            return;
          }
          const sourcePath = imageByName.get(path.basename(uri).toLowerCase());
          if (!sourcePath || path.resolve(sourcePath) === path.resolve(expectedPath)) {
            return;
          }
          await mkdir(path.dirname(expectedPath), { recursive: true });
          await cp(sourcePath, expectedPath);
          copied += 1;
        })
      );
    })
  );
  return copied;
}

function validateManifest(value) {
  if (!value || value.schemaVersion !== "0.1" || !Array.isArray(value.views)) {
    throw new Error("Invalid scene manifest.");
  }
}

function validateMaterials(value) {
  if (!value || value.schemaVersion !== "0.1" || !Array.isArray(value.materials)) {
    throw new Error("Invalid materials document.");
  }
}

function validateObjects(value) {
  if (!value || value.schemaVersion !== "0.1" || !Array.isArray(value.objects)) {
    throw new Error("Invalid objects document.");
  }
}

function validateControls(value) {
  const movement = value?.movement;
  if (
    !value ||
    value.schemaVersion !== "0.1" ||
    !movement ||
    typeof movement.enabled !== "boolean" ||
    typeof movement.clickToMove !== "boolean" ||
    typeof movement.keyboard !== "boolean" ||
    typeof movement.dragLook !== "boolean" ||
    typeof movement.moveSpeed !== "number" ||
    (movement.clickMoveSpeed !== undefined && typeof movement.clickMoveSpeed !== "number") ||
    typeof movement.lookSensitivityX !== "number" ||
    typeof movement.lookSensitivityY !== "number" ||
    typeof movement.clickMoveThresholdPx !== "number"
  ) {
    throw new Error("Invalid controls document.");
  }
}

function validateModelSource(value) {
  if (!isSafeLocalSceneUrl(value)) {
    throw badRequest("Model source must be a local GLB or GLTF path.");
  }
}

function safeProjectAssetPath(filename, kind = "lightmap") {
  const extension = path.extname(filename).toLowerCase();
  const folder = kind === "media" ? "media" : "lightmaps";
  const allowedExtensions =
    kind === "media"
      ? [".mp4", ".mov", ".webm"]
      : [".avif", ".jpg", ".jpeg", ".ktx2", ".png", ".webp"];
  if (!allowedExtensions.includes(extension)) {
    throw badRequest(
      kind === "media"
        ? "Media assets must be MP4, MOV, or WebM videos."
        : "Lightmap assets must be PNG, JPEG, WebP, AVIF, or KTX2 images."
    );
  }
  const baseName = slug(path.basename(filename, extension));
  return `${folder}/${baseName}${extension}`;
}

async function writeProjectAsset(projectId, assetPath, body) {
  const safePath = safeArchivePath(assetPath);
  if (!safePath || (!safePath.startsWith("lightmaps/") && !safePath.startsWith("media/"))) {
    throw badRequest("Asset path must be inside the lightmaps or media folder.");
  }
  await Promise.all(
    targetDirs(projectId).map(async (target) => {
      const outputPath = path.join(target, safePath);
      const relative = path.relative(target, outputPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw badRequest(`Unsafe asset path: ${assetPath}.`);
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, body);
    })
  );
  return safePath;
}

function runAnalyze(projectId = "demo") {
  return new Promise((resolve, reject) => {
    const viewerTarget = `apps/viewer-demo/public/scenes/${projectId}`;
    const studioTarget = `apps/studio/public/scenes/${projectId}`;
    const command = `node scripts/analyze-scene-bundle.mjs ${viewerTarget} --write && node scripts/analyze-scene-bundle.mjs ${studioTarget} --write`;
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/c", command], {
      cwd: repoRoot,
      windowsHide: true
    });
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
      reject(new Error(stderr || stdout || `Analyzer exited with ${code}.`));
    });
  });
}

function runOptimize(projectId = "demo", profile = "balanced", applyOptimized = true) {
  return new Promise((resolve, reject) => {
    const viewerTarget = `apps/viewer-demo/public/scenes/${projectId}`;
    const studioTarget = `apps/studio/public/scenes/${projectId}`;
    const applyFlag = applyOptimized ? " --apply" : "";
    const command =
      `node scripts/optimize-scene-bundle.mjs ${viewerTarget} --profile=${profile}${applyFlag} && ` +
      `node scripts/optimize-scene-bundle.mjs ${studioTarget} --profile=${profile}${applyFlag}`;
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/c", command], {
      cwd: repoRoot,
      windowsHide: true
    });
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
      reject(new Error(stderr || stdout || `Optimizer exited with ${code}.`));
    });
  });
}

function runLightmapBake(projectId = "demo") {
  return new Promise((resolve, reject) => {
    const viewerTarget = `apps/viewer-demo/public/scenes/${projectId}`;
    const studioTarget = `apps/studio/public/scenes/${projectId}`;
    const command =
      `node scripts/bake-lightmaps.mjs ${viewerTarget} && ` +
      `node scripts/bake-lightmaps.mjs ${studioTarget}`;
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/c", command], {
      cwd: repoRoot,
      windowsHide: true
    });
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
      reject(new Error(stderr || stdout || `Lightmap bake exited with ${code}.`));
    });
  });
}

async function projectPayload(projectId = "demo") {
  const target = targetDirs(projectId)[0];
  const [
    manifest,
    materials,
    objects,
    controls,
    graph,
    stats,
    optimization,
    publishHistoryDocument,
    optimizationJobDocument,
    optimizationHistoryDocument,
    lightmapBakeJobDocument
  ] =
    await Promise.all([
    readJson(path.join(target, "scene.manifest.json")),
    readJson(path.join(target, "materials.json")),
    readJson(path.join(target, "objects.json")),
    readJson(path.join(target, "controls.json")),
    readJson(path.join(target, "scene.graph.json")),
    readJson(path.join(target, "stats.json")),
    readJson(path.join(target, "optimization.json")),
    publishHistory(projectId),
    optimizationJob(projectId),
    optimizationHistory(projectId),
    lightmapBakeJob(projectId)
  ]);
  return {
    id: projectId,
    manifest,
    materials,
    objects,
    controls,
    graph,
    stats,
    optimization,
    publishHistory: publishHistoryDocument,
    optimizationJob: optimizationJobDocument,
    optimizationHistory: optimizationHistoryDocument,
    lightmapBakeJob: lightmapBakeJobDocument
  };
}

async function listProjects() {
  const root = sceneRoots[0];
  const entries = await readdir(root, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    try {
      const project = await projectPayload(entry.name);
      projects.push({
        id: project.id,
        title: project.manifest.branding.title,
        clientName: project.manifest.branding.clientName,
        viewCount: project.manifest.views.length,
        triangleCount: project.stats.triangleCount,
        updatedAt: project.stats.generatedAt,
        publishCount: project.publishHistory.versions.length,
        lastPublishedAt: project.publishHistory.versions[0]?.publishedAt
      });
    } catch {
      // Ignore incomplete scene folders.
    }
  }
  return projects.sort((a, b) => a.clientName?.localeCompare(b.clientName ?? "") ?? a.id.localeCompare(b.id));
}

async function createProject(name) {
  const baseId = slug(name);
  const existing = new Set((await listProjects()).map((project) => project.id));
  let projectId = baseId;
  let index = 2;
  while (existing.has(projectId)) {
    projectId = `${baseId}-${index}`;
    index += 1;
  }

  const [viewerTarget, studioTarget] = targetDirs(projectId);
  await Promise.all([
    mkdir(path.dirname(viewerTarget), { recursive: true }),
    mkdir(path.dirname(studioTarget), { recursive: true })
  ]);
  await Promise.all([
    cp(path.join(sceneRoots[0], "demo"), viewerTarget, { recursive: true }),
    cp(path.join(sceneRoots[1], "demo"), studioTarget, { recursive: true })
  ]);

  const project = await projectPayload(projectId);
  const manifest = {
    ...project.manifest,
    branding: {
      ...project.manifest.branding,
      clientName: name,
      title: "Walkthrough Studio"
    }
  };
  await writeProjectAll(projectId, "scene.manifest.json", manifest);
  await runAnalyze(projectId);
  return projectPayload(projectId);
}

function combineGraphBounds(graph) {
  const bounds = graph.nodes
    .map((node) => node.bounds)
    .filter(Boolean);
  if (bounds.length === 0) {
    return undefined;
  }
  return bounds.reduce(
    (current, next) => ({
      min: [
        Math.min(current.min[0], next.min[0]),
        Math.min(current.min[1], next.min[1]),
        Math.min(current.min[2], next.min[2])
      ],
      max: [
        Math.max(current.max[0], next.max[0]),
        Math.max(current.max[1], next.max[1]),
        Math.max(current.max[2], next.max[2])
      ]
    }),
    {
      min: [...bounds[0].min],
      max: [...bounds[0].max]
    }
  );
}

function boundsSize(bounds) {
  return [
    Math.abs(bounds.max[0] - bounds.min[0]),
    Math.abs(bounds.max[1] - bounds.min[1]),
    Math.abs(bounds.max[2] - bounds.min[2])
  ];
}

function boundsArea(bounds) {
  const [width, _height, depth] = boundsSize(bounds);
  return width * depth;
}

function likelyExteriorPlaneName(name) {
  const normalized = String(name || "").toLowerCase();
  return [
    "terrain",
    "landscape",
    "grass",
    "lawn",
    "site",
    "environment",
    "background",
    "plane",
    "plot"
  ].some((keyword) => normalized.includes(keyword));
}

function graphFocusBounds(graph) {
  const rawBounds = graphFocusBounds(graph);
  if (!rawBounds) {
    return undefined;
  }
  const fullArea = Math.max(1, boundsArea(rawBounds));
  const focusBounds = (graph.nodes ?? [])
    .filter((node) => {
      if (!node.bounds) {
        return false;
      }
      const name = `${node.name} ${node.meshName ?? ""}`;
      const [width, height, depth] = boundsSize(node.bounds);
      const area = Math.max(0, width * depth);
      const flat = height <= Math.max(0.08, Math.min(width, depth) * 0.04);
      const hugeRelativePlane = flat && area > fullArea * 0.45;
      if (likelyExteriorPlaneName(name) && (flat || area > fullArea * 0.25)) {
        return false;
      }
      if (hugeRelativePlane && area > 25) {
        return false;
      }
      return height > 0.15 || area < fullArea * 0.35;
    })
    .map((node) => node.bounds);
  if (focusBounds.length === 0) {
    return rawBounds;
  }
  return combineGraphBounds({ nodes: focusBounds.map((bounds, index) => ({ id: `focus-${index}`, bounds })) });
}

function unitScaleForBounds(bounds) {
  if (!bounds) {
    return 1;
  }
  const width = Math.abs(bounds.max[0] - bounds.min[0]);
  const height = Math.abs(bounds.max[1] - bounds.min[1]);
  const depth = Math.abs(bounds.max[2] - bounds.min[2]);
  const largestDimension = Math.max(width, height, depth);
  if (largestDimension > 10_000) {
    return 0.001;
  }
  if (largestDimension > 500) {
    return 0.01;
  }
  return 1;
}

function scaleVec3(value, scale) {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function scaleBounds(bounds, scale) {
  if (!bounds || scale === 1) {
    return bounds;
  }
  return {
    min: scaleVec3(bounds.min, scale),
    max: scaleVec3(bounds.max, scale)
  };
}

function roomLabelFromName(name) {
  const cleaned = String(name || "Room")
    .replace(/[_-]+/g, " ")
    .replace(/\b(mesh|object|floor|slab|tile|area|room)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Room";
}

function graphRoomCandidates(graph, modelScale, cameraHeight) {
  const rawBounds = combineGraphBounds(graph);
  const rawArea = rawBounds ? Math.max(1, boundsArea(rawBounds)) : 1;
  const roomKeywords = [
    "living",
    "dining",
    "kitchen",
    "bedroom",
    "bath",
    "toilet",
    "foyer",
    "entry",
    "lobby",
    "balcony",
    "terrace",
    "family",
    "study",
    "office",
    "pooja",
    "utility",
    "dry area",
    "hall"
  ];
  const rejectKeywords = ["wall", "door", "window", "glass", "ceiling", "roof", "railing", "column", "pillar"];
  return (graph?.nodes ?? [])
    .map((node) => {
      if (!node.bounds) {
        return undefined;
      }
      const searchName = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
      if (rejectKeywords.some((keyword) => searchName.includes(keyword))) {
        return undefined;
      }
      const score = roomKeywords.reduce((sum, keyword) => sum + (searchName.includes(keyword) ? 1 : 0), 0);
      const scaledBounds = scaleBounds(node.bounds, modelScale);
      if (!scaledBounds) {
        return undefined;
      }
      const size = [
        scaledBounds.max[0] - scaledBounds.min[0],
        scaledBounds.max[1] - scaledBounds.min[1],
        scaledBounds.max[2] - scaledBounds.min[2]
      ];
      const area = Math.abs(size[0] * size[2]);
      const flatEnough = Math.abs(size[1]) <= Math.max(0.35, Math.min(Math.abs(size[0]), Math.abs(size[2])) * 0.22);
      const genericDominantPlane = score === 0 && flatEnough && area > rawArea * modelScale * modelScale * 0.35;
      if (genericDominantPlane || (score === 0 && likelyExteriorPlaneName(searchName))) {
        return undefined;
      }
      if ((score === 0 && !flatEnough) || area < 1.25) {
        return undefined;
      }
      const center = [
        (scaledBounds.min[0] + scaledBounds.max[0]) / 2,
        scaledBounds.min[1] + cameraHeight,
        (scaledBounds.min[2] + scaledBounds.max[2]) / 2
      ];
      return {
        id: `auto-room-${node.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64),
        label: roomLabelFromName(node.name || node.meshName),
        center,
        target: [center[0], Math.max(scaledBounds.min[1] + 1.2, center[1] - 0.35), center[2] - Math.max(0.8, Math.abs(size[2]) * 0.3)],
        dimensions: `${Math.abs(size[0]).toFixed(1)}x${Math.abs(size[2]).toFixed(1)}m`,
        area,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.area - a.area)
    .slice(0, 14);
}

function importedModelViews(bounds, cameraHeight, roomCandidates = []) {
  if (!bounds) {
    return [
      {
        id: "view-1",
        label: "View 1",
        kind: "walk",
        position: [0, cameraHeight, 3],
        target: [0, cameraHeight - 0.25, 0],
        fov: 62
      },
      {
        id: "top",
        label: "Top",
        kind: "top",
        position: [0, 12, 0.01],
        target: [0, 0, 0],
        fov: 48
      }
    ];
  }

  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
  const width = Math.max(2, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(2, bounds.max[2] - bounds.min[2]);
  const insetX = width * 0.22;
  const insetZ = depth * 0.22;
  const eyeY = Math.max(cameraHeight, bounds.min[1] + cameraHeight);
  const targetY = Math.max(bounds.min[1] + 1.2, eyeY - 0.3);
  const topHeight = Math.max(10, Math.max(width, depth) * 1.5);

  const topView = {
    id: "top",
    label: "Top",
    kind: "top",
    position: [center[0], bounds.max[1] + topHeight, center[2] + 0.01],
    target: [center[0], center[1], center[2]],
    fov: 48
  };

  if (roomCandidates.length >= 2) {
    return [
      ...roomCandidates.map((candidate, index) => ({
        id: index === 0 ? "entry" : `room-view-${index + 1}`,
        label: candidate.label,
        kind: "walk",
        position: candidate.center,
        target: candidate.target,
        fov: 62
      })),
      topView
    ];
  }

  return [
    {
      id: "entry",
      label: "Entry",
      kind: "walk",
      position: [center[0], eyeY, bounds.max[2] - insetZ],
      target: [center[0], targetY, center[2]],
      fov: 62
    },
    {
      id: "center",
      label: "Center",
      kind: "walk",
      position: [center[0], eyeY, center[2]],
      target: [center[0], targetY, bounds.min[2] + insetZ],
      fov: 62
    },
    {
      id: "left",
      label: "Left",
      kind: "walk",
      position: [bounds.min[0] + insetX, eyeY, center[2]],
      target: [center[0], targetY, center[2]],
      fov: 62
    },
    {
      id: "right",
      label: "Right",
      kind: "walk",
      position: [bounds.max[0] - insetX, eyeY, center[2]],
      target: [center[0], targetY, center[2]],
      fov: 62
    },
    topView
  ];
}

function importedRooms(views, roomCandidates, existingRooms = []) {
  const hasCustomRooms =
    Array.isArray(existingRooms) &&
    existingRooms.some((room) => {
      const id = String(room.id ?? "");
      return id && !id.startsWith("room-") && !id.startsWith("auto-room-");
    });
  if (hasCustomRooms) {
    return existingRooms;
  }
  return views
    .filter((view) => view.kind !== "top")
    .map((view, index) => {
      const candidate = roomCandidates[index];
      return {
        id: candidate?.id ?? `room-${view.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72),
        label: view.label,
        viewId: view.id,
        center: view.position,
        ...(candidate?.dimensions ? { dimensions: candidate.dimensions } : {})
      };
    });
}

function graphWalkZoneCandidates(graph, modelScale) {
  const focusBounds = scaleBounds(graphFocusBounds(graph), modelScale);
  const focusHeight = focusBounds ? Math.max(0.1, focusBounds.max[1] - focusBounds.min[1]) : 1;
  const genericFloorMaxY = focusBounds ? focusBounds.min[1] + Math.max(0.65, focusHeight * 0.42) : Number.POSITIVE_INFINITY;
  const floorKeywords = [
    "floor",
    "ground",
    "slab",
    "tile",
    "carpet",
    "rug",
    "deck",
    "patio",
    "balcony",
    "terrace",
    "porch"
  ];
  const candidates = (graph?.nodes ?? [])
    .map((node) => {
      if (!node.bounds) {
        return undefined;
      }
      const searchName = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
      const keywordMatched = floorKeywords.some((keyword) => searchName.includes(keyword));
      const exteriorNamed = likelyExteriorPlaneName(searchName);
      const scaledBounds = scaleBounds(node.bounds, modelScale);
      if (!scaledBounds) {
        return undefined;
      }
      const size = [
        scaledBounds.max[0] - scaledBounds.min[0],
        scaledBounds.max[1] - scaledBounds.min[1],
        scaledBounds.max[2] - scaledBounds.min[2]
      ];
      const area = Math.abs(size[0] * size[2]);
      const flatEnough = Math.abs(size[1]) <= Math.max(0.24, Math.min(Math.abs(size[0]), Math.abs(size[2])) * 0.18);
      const centerY = (scaledBounds.min[1] + scaledBounds.max[1]) / 2;
      const genericLowFlatSurface = !keywordMatched && !exteriorNamed && flatEnough && centerY <= genericFloorMaxY;
      if ((!keywordMatched && !genericLowFlatSurface) || !flatEnough || area < 1) {
        return undefined;
      }
      return {
        id: `walk-${node.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60),
        label: node.name || (genericLowFlatSurface ? "Detected walk surface" : "Walk surface"),
        kind: "walk",
        center: [
          (scaledBounds.min[0] + scaledBounds.max[0]) / 2,
          scaledBounds.min[1] + 0.03,
          (scaledBounds.min[2] + scaledBounds.max[2]) / 2
        ],
        size: [Math.max(0.8, Math.abs(size[0])), 0.08, Math.max(0.8, Math.abs(size[2]))],
        rotationY: 0,
        enabled: true,
        area,
        exterior: exteriorNamed,
        generic: genericLowFlatSurface
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area);
  const nonExteriorAreas = candidates.filter((candidate) => !candidate.exterior).map((candidate) => candidate.area);
  const referenceArea =
    nonExteriorAreas.length > 0
      ? nonExteriorAreas[Math.floor(nonExteriorAreas.length / 2)]
      : candidates[Math.floor(candidates.length / 2)]?.area;
  return candidates
    .filter((candidate) => {
      if (!referenceArea || !candidate.exterior) {
        return true;
      }
      return candidate.area <= Math.max(referenceArea * 6, 12);
    })
    .slice(0, 12)
    .map(({ area: _area, exterior: _exterior, generic: _generic, ...zone }) => zone);
}

function doorPassScore(name) {
  const normalized = name.toLowerCase();
  let score = 0;
  if (normalized.includes("door")) {
    score += 10;
  }
  if (normalized.includes("opening") || normalized.includes("portal")) {
    score += 8;
  }
  if (normalized.includes("frame") || normalized.includes("threshold")) {
    score += 5;
  }
  if (normalized.includes("entry") || normalized.includes("entrance")) {
    score += 4;
  }
  if (normalized.includes("window")) {
    score -= 6;
  }
  if (normalized.includes("handle") || normalized.includes("knob")) {
    score -= 5;
  }
  return score;
}

function graphPassZoneCandidates(graph, modelScale, cameraHeight) {
  return (graph?.nodes ?? [])
    .map((node) => {
      if (!node.bounds) {
        return undefined;
      }
      const score = doorPassScore(`${node.name} ${node.meshName ?? ""}`);
      if (score <= 0) {
        return undefined;
      }
      const scaledBounds = scaleBounds(node.bounds, modelScale);
      if (!scaledBounds) {
        return undefined;
      }
      const size = [
        Math.max(0.1, scaledBounds.max[0] - scaledBounds.min[0]),
        Math.max(0.1, scaledBounds.max[1] - scaledBounds.min[1]),
        Math.max(0.1, scaledBounds.max[2] - scaledBounds.min[2])
      ];
      const footprint = Math.max(size[0], size[2]);
      if (footprint > 4 || size[1] > Math.max(4, cameraHeight * 2.2)) {
        return undefined;
      }
      return {
        id: `pass-${node.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60),
        label: node.name || "Pass zone",
        kind: "pass",
        center: [
          (scaledBounds.min[0] + scaledBounds.max[0]) / 2,
          Math.max(0.8, cameraHeight * 0.55),
          (scaledBounds.min[2] + scaledBounds.max[2]) / 2
        ],
        size: [
          Math.min(2.2, Math.max(0.85, size[0] * 1.35)),
          Math.max(1.8, cameraHeight + 0.65),
          Math.min(2.2, Math.max(0.95, size[2] * 1.35))
        ],
        rotationY: 0,
        enabled: true,
        score
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 16)
    .map(({ score: _score, ...zone }) => zone);
}

function importedNavigationZones(bounds, existingZones = [], graph, modelScale = 1, cameraHeight = 1.65) {
  const hasUserAuthoredZones =
    Array.isArray(existingZones) &&
    existingZones.some((zone) => {
      const id = String(zone.id ?? "");
      return !id.startsWith("walk-main") && !id.startsWith("walk-") && !id.startsWith("pass-");
    });
  if (hasUserAuthoredZones) {
    return existingZones;
  }
  const graphZones = graphWalkZoneCandidates(graph, modelScale);
  const passZones = graphPassZoneCandidates(graph, modelScale, cameraHeight);
  if (graphZones.length > 0) {
    return [...graphZones, ...passZones];
  }
  if (!bounds) {
    return passZones;
  }
  const width = Math.max(1.5, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(1.5, bounds.max[2] - bounds.min[2]);
  return [
    {
      id: "walk-main",
      label: "Main walk zone",
      kind: "walk",
      center: [
        (bounds.min[0] + bounds.max[0]) / 2,
        bounds.min[1] + 0.03,
        (bounds.min[2] + bounds.max[2]) / 2
      ],
      size: [width, 0.08, depth],
      rotationY: 0,
      enabled: true
    },
    ...passZones
  ];
}

async function resetManifestForUploadedModel(
  projectId,
  sceneUrl = "scene.glb",
  options = { resetInteractions: true, resetControls: true }
) {
  const target = targetDirs(projectId)[0];
  const [manifest, graph] = await Promise.all([
    readJson(path.join(target, "scene.manifest.json")),
    readJson(path.join(target, "scene.graph.json"))
  ]);
  const rawBounds = combineGraphBounds(graph);
  const modelScale = unitScaleForBounds(rawBounds);
  const bounds = scaleBounds(rawBounds, modelScale);
  const cameraHeight = manifest.navigation?.cameraHeight ?? 1.65;
  const roomCandidates = graphRoomCandidates(graph, modelScale, cameraHeight);
  const views = importedModelViews(bounds, cameraHeight, roomCandidates);
  const margin = 0.75;
  const navigationBounds = bounds
    ? {
        min: [bounds.min[0] - margin, Math.min(0.2, bounds.min[1] - 0.1), bounds.min[2] - margin],
        max: [
          bounds.max[0] + margin,
          Math.max(bounds.max[1] + 0.5, bounds.min[1] + cameraHeight + 0.5),
          bounds.max[2] + margin
        ]
      }
    : manifest.navigation?.bounds;

  const nextManifest = {
    ...manifest,
    sceneUrl,
    originalSceneUrl: manifest.originalSceneUrl ?? sceneUrl,
    rendering: {
      ...manifest.rendering,
      doubleSidedMaterials: true,
      modelScale
    },
    environment: {
      ...manifest.environment,
      backgroundColor: manifest.environment?.backgroundColor ?? "#d8dde2",
      skyBackdropEnabled: manifest.environment?.skyBackdropEnabled ?? true,
      skyTopColor: manifest.environment?.skyTopColor ?? "#d8e7f5",
      skyHorizonColor: manifest.environment?.skyHorizonColor ?? "#f3f6f8",
      groundEnabled: manifest.environment?.groundEnabled ?? true,
      groundColor: manifest.environment?.groundColor ?? "#6f8f5a",
      groundSize:
        manifest.environment?.groundSize ??
        (bounds ? Math.max(30, (bounds.max[0] - bounds.min[0]) * 1.8, (bounds.max[2] - bounds.min[2]) * 1.8) : 90),
      groundY: manifest.environment?.groundY ?? (bounds ? bounds.min[1] - 0.04 : -0.04)
    },
    views,
    rooms: importedRooms(views, roomCandidates, manifest.rooms),
    interactions: options.resetInteractions ? [] : manifest.interactions,
    navigation: {
      ...manifest.navigation,
      floorMeshNames: [
        "floor",
        "ground",
        "navmesh",
        "walkable",
        "slab",
        "carpet",
        "rug",
        "tile"
      ],
      collisionMeshNames: [
        "wall",
        "glass",
        "door",
        "collision",
        "window",
        "partition",
        "rail",
        "railing",
        "column",
        "pillar"
      ],
      ignoredCollisionMeshNames: manifest.navigation?.ignoredCollisionMeshNames ?? [],
      zones: importedNavigationZones(bounds, manifest.navigation?.zones, graph, modelScale, cameraHeight),
      ...(navigationBounds ? { bounds: navigationBounds } : {})
    }
  };
  const writes = [writeProjectAll(projectId, "scene.manifest.json", nextManifest)];
  if (options.resetControls) {
    writes.push(writeProjectAll(projectId, "controls.json", defaultControlsDocument));
  }
  await Promise.all(writes);
}

async function setManifestSceneUrl(projectId, sceneUrl) {
  const manifests = await Promise.all(
    targetDirs(projectId).map((target) => readJson(path.join(target, "scene.manifest.json")))
  );
  await Promise.all(
    manifests.map((manifest, index) =>
      writeFile(
        path.join(targetDirs(projectId)[index], "scene.manifest.json"),
        `${JSON.stringify({ ...manifest, sceneUrl, originalSceneUrl: manifest.originalSceneUrl ?? sceneUrl }, null, 2)}\n`
      )
    )
  );
}

async function resetOptimizationState(projectId) {
  await Promise.all(
    targetDirs(projectId).flatMap((target) => [
      rm(path.join(target, "scene.optimized.glb"), { force: true }),
      writeFile(path.join(target, "optimization-job.json"), `${JSON.stringify(idleOptimizationJob, null, 2)}\n`),
      writeFile(
        path.join(target, "optimization-history.json"),
        `${JSON.stringify({ schemaVersion: "0.1", jobs: [] }, null, 2)}\n`
      )
    ])
  );
}

async function listPublishAssets(root, dir = root, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await listPublishAssets(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const info = await stat(fullPath);
    const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
    const extension = path.extname(entry.name).toLowerCase();
    const immutable = [".glb", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".ktx2", ".wasm", ".js", ".css"].includes(extension);
    files.push({
      path: relativePath,
      bytes: info.size,
      cacheControl: immutable ? "public, max-age=31536000, immutable" : "public, max-age=300, must-revalidate"
    });
  }
  return files;
}

async function publishProject(projectId) {
  await runAnalyze(projectId);
  const publishedAt = new Date().toISOString();
  const version = publishedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z");
  const source = targetDirs(projectId)[0];
  const output = path.join(publishedRoot, projectId, version);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(source, output, { recursive: true, force: true });
  const assets = await listPublishAssets(output);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const scenePath = `/published/${projectId}/${version}/scene.manifest.json`;
  const deployment = {
    schemaVersion: "0.1",
    projectId,
    version,
    publishedAt,
    scenePath,
    cdnBasePath: `/published/${projectId}/${version}/`,
    assetCount: assets.length,
    totalBytes,
    assets,
    headers: [
      {
        source: "/**/*.{glb,png,jpg,jpeg,webp,avif,ktx2,wasm,js,css}",
        headers: [{ key: "cache-control", value: "public, max-age=31536000, immutable" }]
      },
      {
        source: "/**/*.{json,html}",
        headers: [{ key: "cache-control", value: "public, max-age=300, must-revalidate" }]
      }
    ]
  };
  await writeFile(path.join(output, "deployment.json"), `${JSON.stringify(deployment, null, 2)}\n`);

  const entry = {
    version,
    publishedAt,
    scenePath,
    deploymentPath: `/published/${projectId}/${version}/deployment.json`,
    cdnBasePath: deployment.cdnBasePath,
    assetCount: deployment.assetCount,
    totalBytes: deployment.totalBytes
  };
  const history = await publishHistory(projectId);
  const nextHistory = {
    ...history,
    projectId,
    versions: [entry, ...history.versions.filter((item) => item.version !== version)]
  };
  await writeProjectAll(projectId, "publish-history.json", nextHistory);
  return {
    ok: true,
    entry,
    publishHistory: nextHistory
  };
}

async function handleRequest(request, response) {
  if (request.method === "OPTIONS") {
    sendEmpty(response);
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tools") {
      sendJson(response, 200, { tools: await localToolStatus() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      sendJson(response, 200, { projects: await listProjects() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const body = await readBody(request);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "New Project";
      sendJson(response, 200, await createProject(name));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/projects/demo") {
      sendJson(response, 200, await projectPayload("demo"));
      return;
    }

    const projectId = projectIdFromPathname(url.pathname);
    if (request.method === "GET" && projectId) {
      sendJson(response, 200, await projectPayload(projectId));
      return;
    }

    const manifestProjectId = projectIdFromPathname(url.pathname, "/manifest");
    if (request.method === "POST" && manifestProjectId) {
      const body = await readBody(request);
      validateManifest(body);
      await writeProjectAll(manifestProjectId, "scene.manifest.json", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    const materialsProjectId = projectIdFromPathname(url.pathname, "/materials");
    if (request.method === "POST" && materialsProjectId) {
      const body = await readBody(request);
      validateMaterials(body);
      await writeProjectAll(materialsProjectId, "materials.json", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    const objectsProjectId = projectIdFromPathname(url.pathname, "/objects");
    if (request.method === "POST" && objectsProjectId) {
      const body = await readBody(request);
      validateObjects(body);
      await writeProjectAll(objectsProjectId, "objects.json", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    const controlsProjectId = projectIdFromPathname(url.pathname, "/controls");
    if (request.method === "POST" && controlsProjectId) {
      const body = await readBody(request);
      validateControls(body);
      await writeProjectAll(controlsProjectId, "controls.json", body);
      sendJson(response, 200, { ok: true });
      return;
    }

    const modelProjectId = projectIdFromPathname(url.pathname, "/model");
    if (request.method === "POST" && modelProjectId) {
      const body = await readRawBody(request);
      if (body.length === 0) {
        throw badRequest("Uploaded model is empty.");
      }
      const filename = String(request.headers["x-file-name"] ?? "").toLowerCase();
      const sceneUrl = filename.endsWith(".zip") || isZipBuffer(body)
        ? await writeProjectArchive(modelProjectId, body)
        : "scene.glb";
      if (sceneUrl === "scene.glb") {
        validateGlbBuffer(body);
        await writeProjectAllBinary(modelProjectId, "scene.glb", body);
      }
      await resetOptimizationState(modelProjectId);
      await setManifestSceneUrl(modelProjectId, sceneUrl);
      await runAnalyze(modelProjectId);
      await resetManifestForUploadedModel(modelProjectId, sceneUrl);
      await runAnalyze(modelProjectId);
      const project = await projectPayload(modelProjectId);
      sendJson(response, 200, {
        ok: true,
        manifest: project.manifest,
        controls: project.controls,
        stats: project.stats,
        optimization: project.optimization
      });
      return;
    }

    const assetProjectId = projectIdFromPathname(url.pathname, "/asset");
    if (request.method === "POST" && assetProjectId) {
      const body = await readRawBody(request);
      if (body.length === 0) {
        throw badRequest("Uploaded asset is empty.");
      }
      const fileName = String(request.headers["x-file-name"] ?? "lightmap.webp");
      const kind = url.searchParams.get("kind") === "media" ? "media" : "lightmap";
      const requestedPath = url.searchParams.get("path");
      const assetPath = await writeProjectAsset(
        assetProjectId,
        requestedPath || safeProjectAssetPath(fileName, kind),
        body
      );
      await runAnalyze(assetProjectId);
      const project = await projectPayload(assetProjectId);
      sendJson(response, 200, {
        ok: true,
        assetPath,
        stats: project.stats,
        optimization: project.optimization
      });
      return;
    }

    const analyzeProjectId = projectIdFromPathname(url.pathname, "/analyze");
    if (request.method === "POST" && analyzeProjectId) {
      await runAnalyze(analyzeProjectId);
      const project = await projectPayload(analyzeProjectId);
      sendJson(response, 200, { ok: true, stats: project.stats, optimization: project.optimization });
      return;
    }

    const repairProjectId = projectIdFromPathname(url.pathname, "/repair-import");
    if (request.method === "POST" && repairProjectId) {
      await runAnalyze(repairProjectId);
      const repairedExternalResources = await repairExternalTexturePaths(repairProjectId);
      const current = await projectPayload(repairProjectId);
      await resetManifestForUploadedModel(repairProjectId, current.manifest.sceneUrl ?? "scene.glb", {
        resetInteractions: false,
        resetControls: false
      });
      await runAnalyze(repairProjectId);
      const project = await projectPayload(repairProjectId);
      sendJson(response, 200, {
        ok: true,
        repairedExternalResources,
        manifest: project.manifest,
        controls: project.controls,
        stats: project.stats,
        optimization: project.optimization
      });
      return;
    }

    const optimizeProjectId = projectIdFromPathname(url.pathname, "/optimize");
    if (request.method === "POST" && optimizeProjectId) {
      const body = await readBody(request);
      const profile =
        body.profile === "mobile" || body.profile === "desktop" || body.profile === "balanced"
          ? body.profile
          : "balanced";
      const applyOptimized = body.apply !== false;
      await runOptimize(optimizeProjectId, profile, applyOptimized);
      await runAnalyze(optimizeProjectId);
      const project = await projectPayload(optimizeProjectId);
      sendJson(response, 200, {
        ok: true,
        manifest: project.manifest,
        stats: project.stats,
        optimization: project.optimization,
        optimizationJob: project.optimizationJob,
        optimizationHistory: project.optimizationHistory
      });
      return;
    }

    const lightmapBakeProjectId = projectIdFromPathname(url.pathname, "/bake-lightmaps");
    if (request.method === "POST" && lightmapBakeProjectId) {
      await runLightmapBake(lightmapBakeProjectId);
      const project = await projectPayload(lightmapBakeProjectId);
      sendJson(response, 200, {
        ok: true,
        lightmapBakeJob: project.lightmapBakeJob
      });
      return;
    }

    const modelSourceProjectId = projectIdFromPathname(url.pathname, "/model-source");
    if (request.method === "POST" && modelSourceProjectId) {
      const body = await readBody(request);
      validateModelSource(body.sceneUrl);
      const dirs = targetDirs(modelSourceProjectId);
      if (!(await fileExists(path.join(dirs[0], body.sceneUrl)))) {
        throw badRequest(`${body.sceneUrl} does not exist for this project.`);
      }
      const manifests = await Promise.all(
        dirs.map((dir) => readJson(path.join(dir, "scene.manifest.json")))
      );
      await Promise.all(
        manifests.map((manifest, index) =>
          writeFile(
            path.join(dirs[index], "scene.manifest.json"),
            `${JSON.stringify({ ...manifest, sceneUrl: body.sceneUrl }, null, 2)}\n`
          )
        )
      );
      await runAnalyze(modelSourceProjectId);
      const project = await projectPayload(modelSourceProjectId);
      sendJson(response, 200, {
        ok: true,
        manifest: project.manifest,
        stats: project.stats,
        optimization: project.optimization
      });
      return;
    }

    const publishProjectId = projectIdFromPathname(url.pathname, "/publish");
    if (request.method === "POST" && publishProjectId) {
      sendJson(response, 200, await publishProject(publishProjectId));
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown API error.";
    const status = typeof error?.status === "number" ? error.status : 500;
    sendJson(response, status, { error: message });
  }
}

createServer((request, response) => {
  void handleRequest(request, response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Walkthrough API listening on http://127.0.0.1:${port}`);
});
