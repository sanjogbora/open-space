import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
const convertibleModelExtensions = new Set([".dae", ".fbx", ".obj"]);
const defaultControlsDocument = {
  schemaVersion: "0.1",
  movement: {
    enabled: true,
    clickToMove: true,
    keyboard: true,
    dragLook: true,
    moveSpeed: 3.8,
    clickMoveSpeed: 1.05,
    maxStepUp: 0.38,
    maxStepDown: 0.72,
    floorBumpTolerance: 0.48,
    floorHeightSmoothing: 0.9,
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
const idleLightmapBakeJob = {
  schemaVersion: "0.1",
  id: "",
  status: "idle",
  engine: "blender-cycles",
  message: "No lightmap bake job has run for this project.",
  steps: []
};
const idleConversionJob = {
  schemaVersion: "0.1",
  id: "",
  status: "idle",
  engine: "blender",
  message: "No model conversion job has run for this project.",
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

function apiError(message, status = 500, details) {
  const error = new Error(message);
  error.status = status;
  if (details && typeof details === "object") {
    error.details = details;
  }
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

async function writeProjectFileBinary(projectId, filename, body) {
  await Promise.all(
    targetDirs(projectId).map(async (target) => {
      const outputPath = path.join(target, filename);
      const relative = path.relative(target, outputPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw badRequest(`Unsafe project path: ${filename}.`);
      }
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, body);
    })
  );
}

async function clearPreviousModelAssets(projectId) {
  const staleNames = [
    "scene.glb",
    "scene.gltf",
    "scene.bin",
    "scene.optimized.glb",
    "scene.lightmapped.glb",
    "conversion-job.json",
    "source",
    "textures",
    "images",
    "lightmaps"
  ];
  await Promise.all(
    targetDirs(projectId).flatMap((target) =>
      staleNames.map((name) => rm(path.join(target, name), { recursive: true, force: true }))
    )
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
  return readJsonDefault(path.join(targetDirs(projectId)[0], "lightmap-bake-job.json"), idleLightmapBakeJob);
}

async function conversionJob(projectId) {
  return readJsonDefault(path.join(targetDirs(projectId)[0], "conversion-job.json"), idleConversionJob);
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
      purpose: "FBX/OBJ/DAE conversion and Cycles lightmap baking",
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
  const declaredLength = body.readUInt32LE(8);
  if (magic !== 0x46546c67 || version !== 2) {
    throw badRequest("Only binary GLB v2 uploads are supported in this milestone.");
  }
  if (declaredLength !== body.length) {
    throw badRequest(
      declaredLength > body.length
        ? "GLB upload is truncated; the header length is larger than the uploaded file."
        : "GLB upload has trailing bytes after the declared file length."
    );
  }
  let offset = 12;
  let jsonChunks = 0;
  let jsonChunkStart = 0;
  let jsonChunkLength = 0;
  while (offset < body.length) {
    if (offset + 8 > body.length) {
      throw badRequest("GLB chunk header is truncated.");
    }
    const chunkLength = body.readUInt32LE(offset);
    const chunkType = body.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkLength % 4 !== 0) {
      throw badRequest("GLB chunk length must be 4-byte aligned.");
    }
    if (chunkEnd > body.length) {
      throw badRequest("GLB chunk data is truncated.");
    }
    if (chunkType === 0x4e4f534a) {
      jsonChunks += 1;
      jsonChunkStart = chunkStart;
      jsonChunkLength = chunkLength;
    }
    offset = chunkEnd;
  }
  if (offset !== body.length) {
    throw badRequest("GLB chunks do not match the declared file length.");
  }
  if (jsonChunks !== 1) {
    throw badRequest("GLB must contain exactly one JSON chunk.");
  }
  let document;
  try {
    document = JSON.parse(body.subarray(jsonChunkStart, jsonChunkStart + jsonChunkLength).toString("utf8").trim());
  } catch {
    throw badRequest("GLB JSON chunk is invalid.");
  }
  if (document?.asset?.version !== "2.0") {
    throw badRequest("Only glTF 2.0 GLB uploads are supported.");
  }
}

function parseGlbJsonDocument(body) {
  validateGlbBuffer(body);
  const jsonChunkLength = body.readUInt32LE(12);
  const jsonChunkType = body.readUInt32LE(16);
  if (jsonChunkType !== 0x4e4f534a) {
    throw badRequest("GLB JSON chunk is missing.");
  }
  const jsonText = body.subarray(20, 20 + jsonChunkLength).toString("utf8").trim();
  let document;
  try {
    document = JSON.parse(jsonText);
  } catch {
    throw badRequest("GLB JSON chunk is invalid.");
  }
  return document;
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
  const clean = value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
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

function safeSourceModelPath(filename) {
  const extension = path.extname(filename).toLowerCase();
  if (!convertibleModelExtensions.has(extension)) {
    throw badRequest("Unsupported source model. Upload FBX, OBJ, DAE, GLB, GLTF, or ZIP.");
  }
  const base = path.basename(filename, extension).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `source/${base || "model"}${extension}`;
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

function archiveResourceExists(entriesByName, sceneUrl, uri) {
  const cleanUri = stripUriQuery(uri);
  const exact = path.posix.normalize(path.posix.join(path.posix.dirname(sceneUrl.replace(/\\/g, "/")), cleanUri));
  if (entriesByName.has(exact.toLowerCase())) {
    return true;
  }
  const basename = path.posix.basename(cleanUri).toLowerCase();
  return [...entriesByName.keys()].some((filename) => path.posix.basename(filename) === basename);
}

function archiveSceneDocument(entry) {
  try {
    if (entry.filename.toLowerCase().endsWith(".glb")) {
      return parseGlbJsonDocument(entry.data);
    }
    return JSON.parse(entry.data.toString("utf8"));
  } catch {
    return undefined;
  }
}

function archiveSceneUrl(entries) {
  const entriesByName = new Map(entries.map((entry) => [entry.filename.toLowerCase(), entry]));
  const sceneEntries = entries.filter((entry) => {
    const lower = entry.filename.toLowerCase();
    return lower.endsWith(".glb") || lower.endsWith(".gltf");
  });
  const ranked = sceneEntries
    .map((entry) => {
      const document = archiveSceneDocument(entry);
      const resources = [
        ...(document?.images ?? []).map((image) => image?.uri).filter(localGltfUri),
        ...(document?.buffers ?? []).map((buffer) => buffer?.uri).filter(localGltfUri)
      ];
      const foundResources = resources.filter((uri) =>
        archiveResourceExists(entriesByName, entry.filename, uri)
      ).length;
      const missingResources = Math.max(0, resources.length - foundResources);
      const isGlb = entry.filename.toLowerCase().endsWith(".glb");
      const hasEmbeddedPayload =
        (document?.buffers ?? []).some((buffer) => typeof buffer?.byteLength === "number" && !buffer.uri) ||
        (document?.images ?? []).some((image) => typeof image?.bufferView === "number");
      return {
        entry,
        score:
          foundResources * 8 -
          missingResources * 12 +
          (hasEmbeddedPayload ? 4 : 0) +
          (isGlb ? 2 : 0) -
          entry.filename.split("/").length
      };
    })
    .sort((a, b) => b.score - a.score || a.entry.filename.localeCompare(b.entry.filename));
  return ranked[0]?.entry.filename;
}

function archiveConvertibleModelUrl(entries) {
  const sourceHints = /\b(scene|model|main|export|house|apartment|residence|interior)\b/i;
  const candidates = entries
    .filter((entry) => convertibleModelExtensions.has(path.extname(entry.filename).toLowerCase()))
    .map((entry) => {
      const extension = path.extname(entry.filename).toLowerCase();
      const baseName = path.basename(entry.filename, extension);
      const folder = path.posix.dirname(entry.filename.replace(/\\/g, "/"));
      const siblingAssetCount = entries.filter((candidate) => {
        const candidateFolder = path.posix.dirname(candidate.filename.replace(/\\/g, "/"));
        const candidateExtension = path.extname(candidate.filename).toLowerCase();
        return (
          candidateFolder === folder &&
          [".bin", ".jpg", ".jpeg", ".png", ".webp", ".mtl"].includes(candidateExtension)
        );
      }).length;
      return {
        entry,
        score:
          (baseName.toLowerCase() === "scene" ? 10 : 0) +
          (sourceHints.test(baseName) ? 4 : 0) +
          (extension === ".fbx" ? 2 : 0) +
          (extension === ".obj" ? 1 : 0) +
          Math.min(4, siblingAssetCount) -
          entry.filename.split("/").length
      };
    })
    .sort((a, b) => b.score - a.score || a.entry.filename.localeCompare(b.entry.filename));
  return candidates[0]?.entry.filename;
}

async function writeProjectArchive(projectId, body) {
  const entries = extractZipEntries(body);
  const sceneUrl = archiveSceneUrl(entries);
  const sourceRelative = sceneUrl ? undefined : archiveConvertibleModelUrl(entries);
  if (!sceneUrl && !sourceRelative) {
    throw badRequest("ZIP uploads must contain a GLB/GLTF scene file, or an FBX/OBJ/DAE source model.");
  }
  if (sceneUrl) {
    const sceneEntry = entries.find((entry) => entry.filename === sceneUrl);
    if (sceneUrl.toLowerCase().endsWith(".gltf")) {
      validateGltfBuffer(sceneEntry.data);
    } else {
      validateGlbBuffer(sceneEntry.data);
    }
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

  return {
    sceneUrl: sceneUrl ?? "scene.glb",
    sourceRelative
  };
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

function normalizedRelativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/").toLowerCase();
}

function textureCandidateScore(target, scenePath, uri, sourcePath) {
  const cleanUri = stripUriQuery(uri).replace(/\\/g, "/");
  const expectedPath = path.resolve(path.dirname(scenePath), cleanUri);
  const expectedRelative = normalizedRelativePath(target, expectedPath);
  const sourceRelative = normalizedRelativePath(target, sourcePath);
  const sourceParts = sourceRelative.split("/");
  const uriParts = cleanUri.toLowerCase().split("/").filter(Boolean);
  let score = 0;

  if (sourceRelative === expectedRelative) {
    score += 120;
  }
  if (sourceRelative.endsWith(cleanUri.toLowerCase())) {
    score += 90;
  }
  if (uriParts.length >= 2 && sourceRelative.endsWith(uriParts.slice(-2).join("/"))) {
    score += 55;
  }
  if (uriParts.length >= 3 && sourceRelative.endsWith(uriParts.slice(-3).join("/"))) {
    score += 35;
  }

  const sourceFolder = sourceParts.at(-2) ?? "";
  const uriFolder = uriParts.at(-2) ?? "";
  if (sourceFolder && uriFolder && sourceFolder === uriFolder) {
    score += 18;
  }
  if (["texture", "textures", "image", "images", "maps", "materials"].includes(sourceFolder)) {
    score += 8;
  }
  if (path.extname(sourcePath).toLowerCase() === path.extname(cleanUri).toLowerCase()) {
    score += 6;
  }
  return score;
}

async function repairExternalTexturePaths(projectId) {
  const result = {
    copied: 0,
    skippedAmbiguous: 0,
    missing: 0,
    copiedPaths: [],
    ambiguousPaths: [],
    missingPaths: []
  };
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
        imageByName.set(key, [...(imageByName.get(key) ?? []), imagePath]);
      }

      await Promise.all(
        imageUris.map(async (uri) => {
          const expectedPath = safeProjectOutputPath(target, path.resolve(path.dirname(scenePath), uri));
          if (await fileExists(expectedPath)) {
            return;
          }
          const sourcePaths = (imageByName.get(path.basename(uri).toLowerCase()) ?? []).filter(
            (sourcePath) => path.resolve(sourcePath) !== path.resolve(expectedPath)
          );
          if (sourcePaths.length === 0) {
            result.missing += 1;
            result.missingPaths.push(uri);
            return;
          }
          const rankedSources = sourcePaths
            .map((sourcePath) => ({
              sourcePath,
              score: textureCandidateScore(target, scenePath, uri, sourcePath)
            }))
            .sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath));
          const [bestSource, nextSource] = rankedSources;
          if (!bestSource || (nextSource && nextSource.score === bestSource.score)) {
            result.skippedAmbiguous += 1;
            result.ambiguousPaths.push({
              target: uri,
              candidates: rankedSources.slice(0, 5).map((entry) => normalizedRelativePath(target, entry.sourcePath))
            });
            return;
          }
          const sourcePath = bestSource.sourcePath;
          await mkdir(path.dirname(expectedPath), { recursive: true });
          await cp(sourcePath, expectedPath);
          result.copied += 1;
          result.copiedPaths.push({
            target: uri,
            source: normalizedRelativePath(target, sourcePath)
          });
        })
      );
    })
  );
  return result;
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
    (movement.maxStepUp !== undefined && typeof movement.maxStepUp !== "number") ||
    (movement.maxStepDown !== undefined && typeof movement.maxStepDown !== "number") ||
    (movement.floorBumpTolerance !== undefined && typeof movement.floorBumpTolerance !== "number") ||
    (movement.floorHeightSmoothing !== undefined && typeof movement.floorHeightSmoothing !== "number") ||
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

function runProcess(command, args, errorLabel) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
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
      reject(new Error(stderr || stdout || `${errorLabel} exited with ${code}.`));
    });
  });
}

async function runNodeScriptForTargets(script, targets, args, errorLabel) {
  let stdout = "";
  let stderr = "";
  for (const target of targets) {
    const result = await runProcess(process.execPath, [script, target, ...args], errorLabel);
    stdout += result.stdout;
    stderr += result.stderr;
  }
  return { stdout, stderr };
}

function runAnalyze(projectId = "demo") {
  return runNodeScriptForTargets(
    "scripts/analyze-scene-bundle.mjs",
    targetDirs(projectId),
    ["--write"],
    "Analyzer"
  );
}

function runOptimize(projectId = "demo", profile = "balanced", applyOptimized = true) {
  const args = [`--profile=${profile}`];
  if (applyOptimized) {
    args.push("--apply");
  }
  return runNodeScriptForTargets(
    "scripts/optimize-scene-bundle.mjs",
    targetDirs(projectId),
    args,
    "Optimizer"
  );
}

function lightmapBakeOptions(body = {}) {
  const presets = {
    draft: { resolution: 512, samples: 32, margin: 8 },
    medium: { resolution: 1024, samples: 96, margin: 16 },
    high: { resolution: 2048, samples: 192, margin: 24 },
    super: { resolution: 4096, samples: 384, margin: 32 }
  };
  const integerOption = (value, fallback, min, max) => {
    const parsed = Number(value ?? fallback);
    const finiteValue = Number.isFinite(parsed) ? parsed : fallback;
    return Math.round(Math.min(max, Math.max(min, finiteValue)));
  };
  const requestedMode = String(body.mode ?? "lighting").toLowerCase();
  const mode = ["lighting", "combined"].includes(requestedMode) ? requestedMode : "lighting";
  const requestedPreset = String(body.preset ?? "medium").toLowerCase();
  const preset = Object.hasOwn(presets, requestedPreset) ? requestedPreset : "medium";
  const presetDefaults = presets[preset];
  return {
    preset,
    resolution: integerOption(body.resolution, presetDefaults.resolution, 256, 4096),
    samples: integerOption(body.samples, presetDefaults.samples, 16, 1024),
    margin: integerOption(body.margin, presetDefaults.margin, 2, 96),
    maxMaterials: integerOption(body.maxMaterials, 160, 1, 512),
    mode
  };
}

function runLightmapBake(projectId = "demo", options = {}) {
  const bakeOptions = lightmapBakeOptions(options);
  return runNodeScriptForTargets(
    "scripts/bake-lightmaps.mjs",
    targetDirs(projectId),
    [
      `--resolution=${bakeOptions.resolution}`,
      `--samples=${bakeOptions.samples}`,
      `--margin=${bakeOptions.margin}`,
      `--max-materials=${bakeOptions.maxMaterials}`,
      `--mode=${bakeOptions.mode}`,
      `--preset=${bakeOptions.preset}`
    ],
    "Lightmap bake"
  );
}

function runModelConversion(projectId = "demo", sourceRelative) {
  return new Promise((resolve, reject) => {
    const viewerTarget = `apps/viewer-demo/public/scenes/${projectId}`;
    const studioTarget = `apps/studio/public/scenes/${projectId}`;
    const args = [`--source=${sourceRelative}`, "--output=scene.glb"];
    const commands = [viewerTarget, studioTarget].map((target) => ({
      command: "node",
      args: ["scripts/convert-model.mjs", target, ...args]
    }));
    let stdout = "";
    let stderr = "";
    const runNext = (index) => {
      const command = commands[index];
      if (!command) {
        resolve({ stdout, stderr });
        return;
      }
      const child = spawn(command.command, command.args, {
        cwd: repoRoot,
        windowsHide: true
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          runNext(index + 1);
          return;
        }
        reject(new Error(stderr || stdout || `Model conversion exited with ${code}.`));
      });
    };
    runNext(0);
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
    lightmapBakeJobDocument,
    conversionJobDocument
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
    lightmapBakeJob(projectId),
    conversionJob(projectId)
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
    lightmapBakeJob: lightmapBakeJobDocument,
    conversionJob: conversionJobDocument
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

function graphHasExteriorGroundPlane(graph) {
  const rawBounds = combineGraphBounds(graph);
  if (!rawBounds) {
    return false;
  }
  const fullArea = Math.max(1, boundsArea(rawBounds));
  return (graph.nodes ?? []).some((node) => {
    if (!node.bounds) {
      return false;
    }
    const name = `${node.name} ${node.meshName ?? ""}`;
    if (!likelyExteriorPlaneName(name)) {
      return false;
    }
    const [width, height, depth] = boundsSize(node.bounds);
    const area = width * depth;
    const flat = height <= Math.max(0.12, Math.min(width, depth) * 0.08);
    return flat && area > fullArea * 0.18;
  });
}

function likelyNonWalkSurfaceName(name) {
  const normalized = String(name || "").toLowerCase();
  return [
    "plant",
    "tree",
    "chair",
    "table",
    "sofa",
    "couch",
    "bed",
    "cabinet",
    "cupboard",
    "wardrobe",
    "counter",
    "worktop",
    "shelf",
    "tv",
    "screen",
    "monitor",
    "appliance",
    "fridge",
    "oven",
    "sink",
    "toilet",
    "vanity",
    "decor",
    "vase",
    "lamp",
    "light",
    "fan",
    "door",
    "window",
    "glass",
    "wall",
    "partition",
    "ceiling",
    "roof"
  ].some((keyword) => normalized.includes(keyword));
}

function graphFocusBounds(graph) {
  const rawBounds = combineGraphBounds(graph);
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

const roomSemanticHints = [
  { label: "Living TV", keywords: ["tv", "television", "media", "console"], weight: 4 },
  { label: "Living", keywords: ["living", "sofa", "couch", "lounge", "coffee table"], weight: 3 },
  { label: "Dining", keywords: ["dining", "dinner", "chair", "table"], weight: 2 },
  { label: "Kitchen", keywords: ["kitchen", "fridge", "refrigerator", "sink", "cooktop", "stove", "oven", "hob", "countertop"], weight: 3 },
  { label: "Master Bedroom", keywords: ["master", "king bed", "queen bed"], weight: 4 },
  { label: "Bedroom", keywords: ["bedroom", "bed", "mattress", "wardrobe", "closet", "dresser"], weight: 3 },
  { label: "Bath", keywords: ["bath", "toilet", "wc", "shower", "basin", "vanity"], weight: 3 },
  { label: "Balcony", keywords: ["balcony", "terrace", "patio", "deck", "sitout"], weight: 3 },
  { label: "Foyer", keywords: ["foyer", "entry", "entrance", "lobby"], weight: 3 },
  { label: "Pooja", keywords: ["pooja", "puja", "temple", "mandir"], weight: 4 },
  { label: "Study", keywords: ["study", "office", "desk", "workstation"], weight: 3 },
  { label: "Utility", keywords: ["utility", "washer", "washing", "laundry", "dry area"], weight: 3 },
  { label: "Family Room", keywords: ["family", "multipurpose", "den"], weight: 3 }
];

function semanticRoomLabelForName(name) {
  const normalized = String(name ?? "").toLowerCase();
  let best;
  for (const hint of roomSemanticHints) {
    const matches = hint.keywords.filter((keyword) => normalized.includes(keyword)).length;
    if (matches === 0) {
      continue;
    }
    const score = matches * hint.weight;
    if (!best || score > best.score) {
      best = { label: hint.label, score };
    }
  }
  return best;
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
      let score = roomKeywords.reduce((sum, keyword) => sum + (searchName.includes(keyword) ? 1 : 0), 0);
      const semanticLabel = semanticRoomLabelForName(searchName);
      if (semanticLabel) {
        score += semanticLabel.score;
      }
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
      if ((score === 0 && !flatEnough) || area < (score > 0 ? 0.35 : 1.25)) {
        return undefined;
      }
      const center = [
        (scaledBounds.min[0] + scaledBounds.max[0]) / 2,
        scaledBounds.min[1] + cameraHeight,
        (scaledBounds.min[2] + scaledBounds.max[2]) / 2
      ];
      return {
        id: `auto-room-${node.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64),
        label: semanticLabel?.label ?? roomLabelFromName(node.name || node.meshName),
        center,
        target: [center[0], Math.max(scaledBounds.min[1] + 1.2, center[1] - 0.35), center[2] - Math.max(0.8, Math.abs(size[2]) * 0.3)],
        dimensions: `${Math.abs(size[0]).toFixed(1)}x${Math.abs(size[2]).toFixed(1)}m`,
        bounds: scaledBounds,
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

function roomCandidateDistanceToView(candidate, view) {
  const point = view?.position;
  if (!candidate || !Array.isArray(point) || point.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (candidate.bounds) {
    const dx =
      point[0] < candidate.bounds.min[0]
        ? candidate.bounds.min[0] - point[0]
        : point[0] > candidate.bounds.max[0]
          ? point[0] - candidate.bounds.max[0]
          : 0;
    const dz =
      point[2] < candidate.bounds.min[2]
        ? candidate.bounds.min[2] - point[2]
        : point[2] > candidate.bounds.max[2]
          ? point[2] - candidate.bounds.max[2]
          : 0;
    return Math.hypot(dx, dz);
  }
  if (!Array.isArray(candidate.center) || candidate.center.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(candidate.center[0] - point[0], candidate.center[2] - point[2]);
}

function nearestRoomView(candidate, views) {
  return [...views]
    .filter((view) => view.kind !== "top")
    .map((view) => ({ view, distance: roomCandidateDistanceToView(candidate, view) }))
    .sort((a, b) => a.distance - b.distance)[0]?.view;
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
  const walkViews = views.filter((view) => view.kind !== "top");
  const usedCandidateIds = new Set();
  const rooms = walkViews.map((view, index) => {
    const candidate =
      roomCandidates[index] ??
      roomCandidates
        .filter((item) => !usedCandidateIds.has(item.id))
        .map((item) => ({ item, distance: roomCandidateDistanceToView(item, view) }))
        .filter((entry) => entry.distance <= 0.75)
        .sort((a, b) => a.distance - b.distance)[0]?.item;
    if (candidate?.id) {
      usedCandidateIds.add(candidate.id);
    }
    return {
      id: candidate?.id ?? `room-${view.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72),
      label: candidate?.label ?? view.label,
      viewId: view.id,
      center: candidate?.center ?? view.position,
      ...(candidate?.dimensions ? { dimensions: candidate.dimensions } : {}),
      ...(candidate?.bounds ? { bounds: candidate.bounds } : {})
    };
  });

  const extraRooms = roomCandidates
    .filter((candidate) => candidate?.id && !usedCandidateIds.has(candidate.id))
    .map((candidate) => {
      const nearestView = nearestRoomView(candidate, walkViews);
      return {
        id: candidate.id,
        label: candidate.label,
        ...(nearestView ? { viewId: nearestView.id } : {}),
        center: candidate.center ?? nearestView?.position ?? [0, 0, 0],
        ...(candidate?.dimensions ? { dimensions: candidate.dimensions } : {}),
        ...(candidate?.bounds ? { bounds: candidate.bounds } : {})
      };
    });

  return [...rooms, ...extraRooms].slice(0, 14);
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
      const nonWalkNamed = likelyNonWalkSurfaceName(searchName);
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
      const genericLowFlatSurface =
        !keywordMatched && !exteriorNamed && !nonWalkNamed && flatEnough && centerY <= genericFloorMaxY;
      if (nonWalkNamed || (!keywordMatched && !genericLowFlatSurface) || !flatEnough || area < 1) {
        return undefined;
      }
      return {
        id: `walk-${node.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60),
        label: genericLowFlatSurface ? "Detected walk surface" : node.name || "Walk surface",
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
      if (
        referenceArea &&
        candidate.generic &&
        candidate.area > Math.max(referenceArea * 8, 80)
      ) {
        return false;
      }
      if (!referenceArea || !candidate.exterior) {
        return true;
      }
      return candidate.area <= Math.max(referenceArea * 6, 12);
    })
    .slice(0, 12)
    .map(({ area: _area, exterior: _exterior, generic: _generic, ...zone }) =>
      generatedNavigationZone(zone, "floor-detection")
    );
}

function generatedNavigationZone(zone, generatedBy) {
  return {
    ...zone,
    source: "generated",
    generatedBy
  };
}

function roomLabelFromZoneContents(zone, graph, modelScale) {
  if (!zone || !graph) {
    return undefined;
  }
  const rejectKeywords = ["wall", "door", "window", "glass", "ceiling", "roof", "floor", "slab", "tile", "ground"];
  const box = navigationZoneBox(zone);
  const scores = new Map();
  for (const node of graph.nodes ?? []) {
    if (!node.bounds) {
      continue;
    }
    const scaledBounds = scaleBounds(node.bounds, modelScale);
    if (!scaledBounds) {
      continue;
    }
    const center = [
      (scaledBounds.min[0] + scaledBounds.max[0]) / 2,
      (scaledBounds.min[1] + scaledBounds.max[1]) / 2,
      (scaledBounds.min[2] + scaledBounds.max[2]) / 2
    ];
    if (
      center[0] < box.minX - 0.65 ||
      center[0] > box.maxX + 0.65 ||
      center[2] < box.minZ - 0.65 ||
      center[2] > box.maxZ + 0.65
    ) {
      continue;
    }
    const searchName = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
    if (rejectKeywords.some((keyword) => searchName.includes(keyword))) {
      continue;
    }
    const semanticLabel = semanticRoomLabelForName(searchName);
    if (semanticLabel) {
      scores.set(semanticLabel.label, (scores.get(semanticLabel.label) ?? 0) + semanticLabel.score);
    }
  }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : undefined;
}

function zoneRoomLabel(zone, index, semanticLabel) {
  if (semanticLabel) {
    return semanticLabel;
  }
  const label = roomLabelFromName(zone?.label ?? "");
  const genericLabel =
    !label ||
    /\b(detected|walk|surface|floor|ground|slab|tile|carpet|rug|object|mesh)\b/i.test(label);
  return genericLabel ? `Area ${index + 1}` : label;
}

function roomCandidatesFromWalkZones(walkZones, bounds, cameraHeight, existingCandidates = [], graph, modelScale = 1) {
  const existingCenters = existingCandidates
    .map((candidate) => candidate.center)
    .filter((center) => Array.isArray(center) && center.length >= 3);
  const sceneCenter = bounds
    ? [
        (bounds.min[0] + bounds.max[0]) / 2,
        bounds.min[1] + cameraHeight,
        (bounds.min[2] + bounds.max[2]) / 2
      ]
    : undefined;
  return [...(walkZones ?? [])]
    .filter((zone) => zone?.kind === "walk" && zone.enabled !== false)
    .sort(
      (a, b) =>
        Math.abs((b.size?.[0] ?? 0) * (b.size?.[2] ?? 0)) -
        Math.abs((a.size?.[0] ?? 0) * (a.size?.[2] ?? 0))
    )
    .filter((zone) => {
      const center = zone.center;
      if (!Array.isArray(center) || center.length < 3) {
        return false;
      }
      const minGap = Math.max(
        1.25,
        Math.min(Math.abs(zone.size?.[0] ?? 1), Math.abs(zone.size?.[2] ?? 1)) * 0.28
      );
      return !existingCenters.some((existingCenter) => {
        const dx = existingCenter[0] - center[0];
        const dz = existingCenter[2] - center[2];
        return Math.hypot(dx, dz) < minGap;
      });
    })
    .slice(0, Math.max(0, 10 - existingCandidates.length))
    .map((zone, index) => {
      const width = Math.max(0.8, Math.abs(zone.size?.[0] ?? 1));
      const depth = Math.max(0.8, Math.abs(zone.size?.[2] ?? 1));
      const center = [zone.center[0], zone.center[1] + cameraHeight, zone.center[2]];
      const bounds = {
        min: [zone.center[0] - width / 2, zone.center[1], zone.center[2] - depth / 2],
        max: [
          zone.center[0] + width / 2,
          zone.center[1] + Math.max(0.08, Math.abs(zone.size?.[1] ?? 0.08)),
          zone.center[2] + depth / 2
        ]
      };
      const targetOffset = Math.min(3.5, Math.max(1, Math.max(width, depth) * 0.28));
      const target = sceneCenter
        ? [
            center[0] + Math.sign(sceneCenter[0] - center[0] || (width >= depth ? 1 : 0)) * targetOffset,
            Math.max(zone.center[1] + 1.05, center[1] - 0.3),
            center[2] + Math.sign(sceneCenter[2] - center[2] || (depth > width ? 1 : 0)) * targetOffset
          ]
        : [
            center[0] + (width >= depth ? targetOffset : 0),
            Math.max(zone.center[1] + 1.05, center[1] - 0.3),
            center[2] + (depth > width ? targetOffset : 0)
          ];
      return {
        id: `auto-room-zone-${zone.id ?? index}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64),
        label: zoneRoomLabel(
          zone,
          existingCandidates.length + index,
          roomLabelFromZoneContents(zone, graph, modelScale)
        ),
        center,
        target,
        dimensions: `${width.toFixed(1)}x${depth.toFixed(1)}m`,
        bounds,
        area: width * depth,
        score: 0
      };
    });
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
  if (normalized.includes("passage") || normalized.includes("corridor")) {
    score += 7;
  }
  if (normalized.includes("slider") || normalized.includes("sliding")) {
    score += 6;
  }
  if (normalized.includes("frame") || normalized.includes("threshold")) {
    score += 5;
  }
  if (normalized.includes("entry") || normalized.includes("entrance") || normalized.includes("balcony") || normalized.includes("terrace")) {
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

function doorPassGeometryScore(bounds, cameraHeight) {
  if (!bounds) {
    return 0;
  }
  const size = [
    Math.max(0.001, bounds.max[0] - bounds.min[0]),
    Math.max(0.001, bounds.max[1] - bounds.min[1]),
    Math.max(0.001, bounds.max[2] - bounds.min[2])
  ];
  const width = Math.max(size[0], size[2]);
  const thickness = Math.min(size[0], size[2]);
  const height = size[1];
  const looksLikeDoorLeaf =
    height >= Math.max(1.1, cameraHeight * 0.72) &&
    height <= Math.max(3.4, cameraHeight * 2.2) &&
    width >= 0.45 &&
    width <= 2.3 &&
    thickness <= Math.max(0.18, width * 0.18);
  const looksLikeThreshold =
    height <= 0.34 &&
    width >= 0.65 &&
    width <= 2.6 &&
    thickness <= Math.max(0.28, width * 0.22);
  return (looksLikeDoorLeaf ? 4 : 0) + (looksLikeThreshold ? 3 : 0);
}

function zoneBoxDistanceToPoint(zone, point) {
  const box = navigationZoneBox(zone);
  const dx = point[0] < box.minX ? box.minX - point[0] : point[0] > box.maxX ? point[0] - box.maxX : 0;
  const dz = point[2] < box.minZ ? box.minZ - point[2] : point[2] > box.maxZ ? point[2] - box.maxZ : 0;
  return Math.hypot(dx, dz);
}

function expandDoorPassToWalkZones(passZone, walkZones, cameraHeight) {
  if (!Array.isArray(walkZones) || walkZones.length < 2) {
    return passZone;
  }
  const nearby = walkZones
    .map((zone) => ({ zone, distance: zoneBoxDistanceToPoint(zone, passZone.center) }))
    .filter((entry) => entry.distance <= Math.max(1.8, cameraHeight * 1.65))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map((entry) => entry.zone);
  if (nearby.length < 2) {
    return passZone;
  }

  let bestBridge;
  for (let aIndex = 0; aIndex < nearby.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < nearby.length; bIndex += 1) {
      const zoneA = nearby[aIndex];
      const zoneB = nearby[bIndex];
      const boxA = navigationZoneBox(zoneA);
      const boxB = navigationZoneBox(zoneB);
      const xGap =
        boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
      const zGap =
        boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;
      const xOverlap = rangeOverlap(boxA.minX, boxA.maxX, boxB.minX, boxB.maxX);
      const zOverlap = rangeOverlap(boxA.minZ, boxA.maxZ, boxB.minZ, boxB.maxZ);
      const bridgeScore = Math.min(xGap || 0, zGap || 0) + Math.max(xOverlap, zOverlap) * -0.15;
      if (!bestBridge || bridgeScore < bestBridge.score) {
        bestBridge = { boxA, boxB, xGap, zGap, xOverlap, zOverlap, score: bridgeScore };
      }
    }
  }
  if (!bestBridge || Math.max(bestBridge.xGap, bestBridge.zGap) > Math.max(2.6, cameraHeight * 1.7)) {
    return passZone;
  }

  if (bestBridge.xGap > 0 && bestBridge.zOverlap >= 0.25) {
    const left = bestBridge.boxA.maxX < bestBridge.boxB.minX ? bestBridge.boxA : bestBridge.boxB;
    const right = left === bestBridge.boxA ? bestBridge.boxB : bestBridge.boxA;
    const overlapMin = Math.max(bestBridge.boxA.minZ, bestBridge.boxB.minZ);
    const overlapMax = Math.min(bestBridge.boxA.maxZ, bestBridge.boxB.maxZ);
    return {
      ...passZone,
      center: [
        (left.maxX + right.minX) / 2,
        Math.max(0.8, cameraHeight * 0.55),
        Math.min(overlapMax, Math.max(overlapMin, passZone.center[2]))
      ],
      size: [
        Math.min(3.4, Math.max(passZone.size[0], bestBridge.xGap + 0.9)),
        Math.max(1.8, cameraHeight + 0.65),
        Math.min(2.4, Math.max(passZone.size[2], bestBridge.zOverlap + 0.45))
      ]
    };
  }

  if (bestBridge.zGap > 0 && bestBridge.xOverlap >= 0.25) {
    const near = bestBridge.boxA.maxZ < bestBridge.boxB.minZ ? bestBridge.boxA : bestBridge.boxB;
    const far = near === bestBridge.boxA ? bestBridge.boxB : bestBridge.boxA;
    const overlapMin = Math.max(bestBridge.boxA.minX, bestBridge.boxB.minX);
    const overlapMax = Math.min(bestBridge.boxA.maxX, bestBridge.boxB.maxX);
    return {
      ...passZone,
      center: [
        Math.min(overlapMax, Math.max(overlapMin, passZone.center[0])),
        Math.max(0.8, cameraHeight * 0.55),
        (near.maxZ + far.minZ) / 2
      ],
      size: [
        Math.min(2.4, Math.max(passZone.size[0], bestBridge.xOverlap + 0.45)),
        Math.max(1.8, cameraHeight + 0.65),
        Math.min(3.4, Math.max(passZone.size[2], bestBridge.zGap + 0.9))
      ]
    };
  }

  return passZone;
}

function graphPassZoneCandidates(graph, modelScale, cameraHeight, walkZones = []) {
  return (graph?.nodes ?? [])
    .map((node) => {
      if (!node.bounds) {
        return undefined;
      }
      const searchName = `${node.name} ${node.meshName ?? ""}`;
      const nameScore = doorPassScore(searchName);
      const normalizedName = searchName.toLowerCase();
      const geometryScore = /wall|partition|ceiling|roof|window|glass|handle|knob/.test(normalizedName)
        ? 0
        : doorPassGeometryScore(scaleBounds(node.bounds, modelScale), cameraHeight);
      const score = nameScore + geometryScore;
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
      if (footprint > (score >= 8 ? 6.5 : 4) || size[1] > Math.max(4, cameraHeight * 2.2)) {
        return undefined;
      }
      return expandDoorPassToWalkZones({
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
      }, walkZones, cameraHeight);
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 16)
    .map(({ score: _score, ...zone }) => generatedNavigationZone(zone, "door-detection"));
}

function navigationZoneBox(zone) {
  const halfX = Math.abs(zone.size?.[0] ?? 0) / 2;
  const halfZ = Math.abs(zone.size?.[2] ?? 0) / 2;
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localCorners =
    Array.isArray(zone.polygon) && zone.polygon.length >= 3
      ? zone.polygon
      : [
          [-halfX, -halfZ],
          [halfX, -halfZ],
          [halfX, halfZ],
          [-halfX, halfZ]
        ];
  const corners = localCorners.map(([x, z]) => [
    zone.center[0] + x * cos - z * sin,
    zone.center[2] + x * sin + z * cos
  ]);
  return {
    minX: Math.min(...corners.map(([x]) => x)),
    maxX: Math.max(...corners.map(([x]) => x)),
    minZ: Math.min(...corners.map(([, z]) => z)),
    maxZ: Math.max(...corners.map(([, z]) => z))
  };
}

function rangeOverlap(minA, maxA, minB, maxB) {
  return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
}

function pointInsideNavigationZone(zone, point, padding = 0.1) {
  if (Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
    const rotation = -(zone.rotationY ?? 0);
    const dx = point[0] - zone.center[0];
    const dz = point[2] - zone.center[2];
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const localPoint = [dx * cos - dz * sin, dx * sin + dz * cos];
    return pointInPolygonWithPadding(localPoint, zone.polygon, padding);
  }
  const box = navigationZoneBox(zone);
  return (
    point[0] >= box.minX - padding &&
    point[0] <= box.maxX + padding &&
    point[2] >= box.minZ - padding &&
    point[2] <= box.maxZ + padding
  );
}

function pointInPolygonWithPadding(point, polygon, padding) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current];
    const b = polygon[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
    if (padding > 0 && pointToSegmentDistance2D(point, a, b) <= padding) {
      return true;
    }
  }
  return inside;
}

function pointToSegmentDistance2D(point, start, end) {
  const segmentX = end[0] - start[0];
  const segmentZ = end[1] - start[1];
  const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
  if (segmentLengthSq < 0.0001) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const t = Math.min(
    1,
    Math.max(0, ((point[0] - start[0]) * segmentX + (point[1] - start[1]) * segmentZ) / segmentLengthSq)
  );
  return Math.hypot(point[0] - (start[0] + segmentX * t), point[1] - (start[1] + segmentZ * t));
}

function autoPassZonesBetweenWalkZones(walkZones, cameraHeight) {
  const candidates = [];
  const maxGap = Math.min(1.45, Math.max(0.65, cameraHeight * 0.75));
  for (let aIndex = 0; aIndex < walkZones.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < walkZones.length; bIndex += 1) {
      const zoneA = walkZones[aIndex];
      const zoneB = walkZones[bIndex];
      const boxA = navigationZoneBox(zoneA);
      const boxB = navigationZoneBox(zoneB);
      const zOverlap = rangeOverlap(boxA.minZ, boxA.maxZ, boxB.minZ, boxB.maxZ);
      const xOverlap = rangeOverlap(boxA.minX, boxA.maxX, boxB.minX, boxB.maxX);
      const xGap = boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
      const zGap = boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;

      if (xGap > 0 && xGap <= maxGap && zOverlap >= 0.55 && zOverlap <= Math.max(2.6, cameraHeight * 1.6)) {
        const left = boxA.maxX < boxB.minX ? boxA : boxB;
        const right = left === boxA ? boxB : boxA;
        candidates.push({
          id: `pass-auto-${aIndex}-${bIndex}-x`,
          label: "Auto doorway pass",
          kind: "pass",
          center: [
            (left.maxX + right.minX) / 2,
            Math.max(0.8, cameraHeight * 0.55),
            (Math.max(boxA.minZ, boxB.minZ) + Math.min(boxA.maxZ, boxB.maxZ)) / 2
          ],
          size: [Math.max(0.9, xGap + 0.55), Math.max(1.8, cameraHeight + 0.65), Math.min(1.8, Math.max(0.9, zOverlap))],
          rotationY: 0,
          enabled: true,
          score: 4 - xGap
        });
      }

      if (zGap > 0 && zGap <= maxGap && xOverlap >= 0.55 && xOverlap <= Math.max(2.6, cameraHeight * 1.6)) {
        const near = boxA.maxZ < boxB.minZ ? boxA : boxB;
        const far = near === boxA ? boxB : boxA;
        candidates.push({
          id: `pass-auto-${aIndex}-${bIndex}-z`,
          label: "Auto doorway pass",
          kind: "pass",
          center: [
            (Math.max(boxA.minX, boxB.minX) + Math.min(boxA.maxX, boxB.maxX)) / 2,
            Math.max(0.8, cameraHeight * 0.55),
            (near.maxZ + far.minZ) / 2
          ],
          size: [Math.min(1.8, Math.max(0.9, xOverlap)), Math.max(1.8, cameraHeight + 0.65), Math.max(0.9, zGap + 0.55)],
          rotationY: 0,
          enabled: true,
          score: 4 - zGap
        });
      }
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ score: _score, ...zone }) => generatedNavigationZone(zone, "walk-zone-gap-detection"));
}

function navigationZonesOverlap(a, b, padding = 0.2) {
  const boxA = navigationZoneBox(a);
  const boxB = navigationZoneBox(b);
  return (
    boxA.minX - padding <= boxB.maxX &&
    boxA.maxX + padding >= boxB.minX &&
    boxA.minZ - padding <= boxB.maxZ &&
    boxA.maxZ + padding >= boxB.minZ
  );
}

function navigationComponents(zones) {
  if (zones.length === 0) {
    return [];
  }
  const seen = new Set();
  const components = [];
  for (const zone of zones) {
    if (seen.has(zone.id)) {
      continue;
    }
    const component = [];
    const queue = [zone];
    seen.add(zone.id);
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const candidate of zones) {
        if (!seen.has(candidate.id) && navigationZonesOverlap(current, candidate)) {
          seen.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function zoneBridgeGap(a, b) {
  const boxA = navigationZoneBox(a);
  const boxB = navigationZoneBox(b);
  const xGap = boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
  const zGap = boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;
  return Math.hypot(xGap, zGap);
}

function nearestNavigationComponentBridge(connectedZones, component) {
  let nearest;
  connectedZones.forEach((from) => {
    component.forEach((to) => {
      const gap = zoneBridgeGap(from, to);
      if (!nearest || gap < nearest.gap) {
        nearest = { from, to, gap };
      }
    });
  });
  return nearest;
}

function createBridgePassZone(from, to, index, cameraHeight) {
  const boxA = navigationZoneBox(from);
  const boxB = navigationZoneBox(to);
  const xGap = boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
  const zGap = boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;
  const xOverlap = rangeOverlap(boxA.minX, boxA.maxX, boxB.minX, boxB.maxX);
  const zOverlap = rangeOverlap(boxA.minZ, boxA.maxZ, boxB.minZ, boxB.maxZ);
  const horizontalSize = Math.min(3.2, Math.max(1, xGap + 0.85));
  const depthSize = Math.min(3.2, Math.max(1, zGap + 0.85));
  const overlapWidth = Math.min(2.4, Math.max(1, xOverlap || 1.2));
  const overlapDepth = Math.min(2.4, Math.max(1, zOverlap || 1.2));
  return generatedNavigationZone({
    id: `pass-bridge-${index}`,
    label: `Bridge pass ${index}`,
    kind: "pass",
    center: [
      Number(((from.center[0] + to.center[0]) / 2).toFixed(3)),
      Number(Math.max(0.8, cameraHeight * 0.55).toFixed(3)),
      Number(((from.center[2] + to.center[2]) / 2).toFixed(3))
    ],
    size:
      xGap >= zGap
        ? [horizontalSize, Math.max(1.8, cameraHeight + 0.65), overlapDepth]
        : [overlapWidth, Math.max(1.8, cameraHeight + 0.65), depthSize],
    rotationY: 0,
    enabled: true
  }, "navigation-island-bridge");
}

function autoBridgePassZones(routeZones, cameraHeight) {
  const components = navigationComponents(routeZones);
  if (components.length <= 1) {
    return [];
  }
  const bridges = [];
  const connectedComponents = [components[0] ?? []];
  components.slice(1).forEach((component, index) => {
    const nearest = nearestNavigationComponentBridge(connectedComponents.flat(), component);
    if (!nearest || nearest.gap > Math.max(2.4, cameraHeight * 1.45)) {
      return;
    }
    bridges.push(createBridgePassZone(nearest.from, nearest.to, index + 1, cameraHeight));
    connectedComponents.push(component);
  });
  return bridges;
}

function autoBoundaryBlockZones(bounds, cameraHeight) {
  if (!bounds) {
    return [];
  }
  const width = Math.max(1, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(1, bounds.max[2] - bounds.min[2]);
  const height = Math.max(1.8, bounds.max[1] - bounds.min[1], cameraHeight + 0.7);
  const y = bounds.min[1] + height / 2;
  const thickness = Math.max(0.35, Math.min(width, depth) * 0.035);
  return [
    {
      id: "boundary-block-north",
      label: "Boundary North",
      kind: "block",
      center: [(bounds.min[0] + bounds.max[0]) / 2, y, bounds.max[2] + thickness / 2],
      size: [width + thickness * 2, height, thickness],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    },
    {
      id: "boundary-block-south",
      label: "Boundary South",
      kind: "block",
      center: [(bounds.min[0] + bounds.max[0]) / 2, y, bounds.min[2] - thickness / 2],
      size: [width + thickness * 2, height, thickness],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    },
    {
      id: "boundary-block-east",
      label: "Boundary East",
      kind: "block",
      center: [bounds.max[0] + thickness / 2, y, (bounds.min[2] + bounds.max[2]) / 2],
      size: [thickness, height, depth + thickness * 2],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    },
    {
      id: "boundary-block-west",
      label: "Boundary West",
      kind: "block",
      center: [bounds.min[0] - thickness / 2, y, (bounds.min[2] + bounds.max[2]) / 2],
      size: [thickness, height, depth + thickness * 2],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    }
  ];
}

function autoWalkZonesForViews(views, existingRouteZones, bounds, cameraHeight) {
  if (!Array.isArray(views) || !bounds) {
    return [];
  }
  const width = Math.max(0.9, Math.min(2.2, (bounds.max[0] - bounds.min[0]) * 0.18));
  const depth = Math.max(0.9, Math.min(2.2, (bounds.max[2] - bounds.min[2]) * 0.18));
  const floorY = bounds.min[1] + 0.03;
  return views
    .filter((view) => view.kind === "walk")
    .filter((view) => !existingRouteZones.some((zone) => pointInsideNavigationZone(zone, view.position, 0.25)))
    .map((view) => ({
      id: `walk-auto-view-${view.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72),
      label: `${view.label} walk patch`,
      kind: "walk",
      center: [view.position[0], floorY, view.position[2]],
      size: [width, 0.08, depth],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "walk-view-patch",
      cameraHeight
    }))
    .map(({ cameraHeight: _cameraHeight, ...zone }) => zone);
}

function isGeneratedNavigationZone(zone) {
  const id = String(zone?.id ?? "");
  return (
    zone?.source === "generated" ||
    id === "walk-main" ||
    id.startsWith("walk-node-") ||
    id.startsWith("pass-node-") ||
    id.startsWith("pass-auto-") ||
    id.startsWith("pass-bridge-") ||
    id.startsWith("walk-auto-view-") ||
    id.startsWith("boundary-block-") ||
    id.startsWith("walk-Object") ||
    id.startsWith("pass-Object")
  );
}

function importedNavigationZones(bounds, existingZones = [], graph, modelScale = 1, cameraHeight = 1.65, views = []) {
  const preservedZones = Array.isArray(existingZones)
    ? existingZones.filter((zone) => !isGeneratedNavigationZone(zone))
    : [];
  const graphZones = graphWalkZoneCandidates(graph, modelScale);
  const passZones = [
    ...graphPassZoneCandidates(graph, modelScale, cameraHeight, graphZones),
    ...autoPassZonesBetweenWalkZones(graphZones, cameraHeight)
  ];
  const viewZones = autoWalkZonesForViews(views, [...graphZones, ...passZones, ...preservedZones], bounds, cameraHeight);
  const bridgeZones = autoBridgePassZones([...graphZones, ...passZones, ...viewZones], cameraHeight);
  const boundaryZones = autoBoundaryBlockZones(bounds, cameraHeight);
  if (graphZones.length > 0) {
    return [...graphZones, ...passZones, ...viewZones, ...bridgeZones, ...boundaryZones, ...preservedZones];
  }
  if (!bounds) {
    return [...passZones, ...bridgeZones, ...preservedZones];
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
      enabled: true,
      source: "generated",
      generatedBy: "bounds-fallback"
    },
    ...passZones,
    ...viewZones,
    ...bridgeZones,
    ...boundaryZones,
    ...preservedZones
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
  const rawSceneBounds = combineGraphBounds(graph);
  const rawBounds = graphFocusBounds(graph) ?? rawSceneBounds;
  const modelScale = unitScaleForBounds(rawBounds);
  const bounds = scaleBounds(rawBounds, modelScale);
  const cameraHeight = manifest.navigation?.cameraHeight ?? 1.65;
  const roomCandidates = graphRoomCandidates(graph, modelScale, cameraHeight);
  const walkZoneCandidates = graphWalkZoneCandidates(graph, modelScale);
  const effectiveRoomCandidates =
    roomCandidates.length >= 2
      ? roomCandidates
      : [
          ...roomCandidates,
          ...roomCandidatesFromWalkZones(walkZoneCandidates, bounds, cameraHeight, roomCandidates, graph, modelScale)
        ].slice(0, 10);
  const views = importedModelViews(bounds, cameraHeight, effectiveRoomCandidates);
  const margin = 0.75;
  const generatedGroundSize = bounds
    ? Math.max(30, (bounds.max[0] - bounds.min[0]) * 1.8, (bounds.max[2] - bounds.min[2]) * 1.8)
    : undefined;
  const generatedGroundY = bounds ? bounds.min[1] - 0.04 : undefined;
  const modelHasExteriorGround = graphHasExteriorGroundPlane(graph);
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
  const navigationZones = importedNavigationZones(bounds, manifest.navigation?.zones, graph, modelScale, cameraHeight, views);
  const roomMapCandidates = [
    ...effectiveRoomCandidates,
    ...roomCandidatesFromWalkZones(
      navigationZones.filter((zone) => zone.kind === "walk"),
      bounds,
      cameraHeight,
      effectiveRoomCandidates,
      graph,
      modelScale
    )
  ].slice(0, 14);

  const nextManifest = {
    ...manifest,
    sceneUrl,
    originalSceneUrl: manifest.originalSceneUrl ?? sceneUrl,
    rendering: {
      ...manifest.rendering,
      doubleSidedMaterials: true,
      relightUnlitMaterials: manifest.rendering?.relightUnlitMaterials ?? true,
      modelScale
    },
    environment: {
      ...manifest.environment,
      backgroundColor: manifest.environment?.backgroundColor ?? "#d8dde2",
      skyBackdropEnabled: manifest.environment?.skyBackdropEnabled ?? true,
      skyTopColor: manifest.environment?.skyTopColor ?? "#d8e7f5",
      skyHorizonColor: manifest.environment?.skyHorizonColor ?? "#f3f6f8",
      groundEnabled: manifest.environment?.groundEnabled ?? !modelHasExteriorGround,
      groundColor: manifest.environment?.groundColor ?? "#6f8f5a",
      groundSize: generatedGroundSize ?? manifest.environment?.groundSize ?? 90,
      groundY: generatedGroundY ?? manifest.environment?.groundY ?? -0.04,
      enclosureEnabled: manifest.environment?.enclosureEnabled ?? true,
      enclosureColor: manifest.environment?.enclosureColor ?? manifest.environment?.groundColor ?? "#5f7f4b",
      enclosureHeight: manifest.environment?.enclosureHeight ?? 14,
      enclosureRadius:
        manifest.environment?.enclosureRadius ??
        Math.max(12, (generatedGroundSize ?? manifest.environment?.groundSize ?? 90) * 0.48)
    },
    views,
    rooms: importedRooms(views, roomMapCandidates, manifest.rooms),
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
        "collision",
        "collider",
        "blocker",
        "window",
        "partition",
        "rail",
        "railing",
        "column",
        "pillar"
      ],
      ignoredCollisionMeshNames: manifest.navigation?.ignoredCollisionMeshNames ?? [],
      zones: navigationZones,
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
      rm(path.join(target, "scene.lightmapped.glb"), { force: true }),
      rm(path.join(target, "lightmaps"), { recursive: true, force: true }),
      writeFile(path.join(target, "optimization-job.json"), `${JSON.stringify(idleOptimizationJob, null, 2)}\n`),
      writeFile(
        path.join(target, "optimization-history.json"),
        `${JSON.stringify({ schemaVersion: "0.1", jobs: [] }, null, 2)}\n`
      ),
      writeFile(path.join(target, "lightmap-bake-job.json"), `${JSON.stringify(idleLightmapBakeJob, null, 2)}\n`),
      writeFile(path.join(target, "conversion-job.json"), `${JSON.stringify(idleConversionJob, null, 2)}\n`)
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
    const sha256 = createHash("sha256").update(await readFile(fullPath)).digest("hex");
    const relativePath = path.relative(root, fullPath).replace(/\\/g, "/");
    const extension = path.extname(entry.name).toLowerCase();
    const immutable = [".glb", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".ktx2", ".wasm", ".js", ".css"].includes(extension);
    files.push({
      path: relativePath,
      bytes: info.size,
      sha256,
      cacheControl: immutable ? "public, max-age=31536000, immutable" : "public, max-age=300, must-revalidate"
    });
  }
  return files;
}

async function removePublishOnlyTemporaryFiles(root) {
  await Promise.all([
    rm(path.join(root, "source"), { recursive: true, force: true }),
    rm(path.join(root, ".lightmap-bake.py"), { force: true }),
    rm(path.join(root, ".lightmap-bake-config.json"), { force: true }),
    rm(path.join(root, ".lightmap-bake-status.json"), { force: true }),
    rm(path.join(root, "optimization-job.json"), { force: true }),
    rm(path.join(root, "optimization-history.json"), { force: true }),
    rm(path.join(root, "lightmap-bake-job.json"), { force: true }),
    rm(path.join(root, "conversion-job.json"), { force: true }),
    rm(path.join(root, ".convert-model.py"), { force: true }),
    rm(path.join(root, ".convert-model-config.json"), { force: true }),
    rm(path.join(root, "publish-history.json"), { force: true }),
    rm(path.join(root, "stats.json"), { force: true })
  ]);
}

function publishedIndexHtml(scenePath) {
  const viewerUrl = `/?scene=${encodeURIComponent(scenePath)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${viewerUrl}" />
    <title>Open walkthrough</title>
  </head>
  <body>
    <a href="${viewerUrl}">Open walkthrough</a>
  </body>
</html>
`;
}

function publishBlockersFromStats(stats) {
  const readinessBlockers = stats.publishReadiness?.blockers ?? [];
  if (readinessBlockers.length > 0) {
    return readinessBlockers.map((blocker) => blocker.title ?? blocker.code).filter(Boolean);
  }
  const blockingDiagnostics = (stats.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === "error");
  return [
    (stats.missingAssetCount ?? 0) > 0 ? `${stats.missingAssetCount} missing asset(s)` : undefined,
    ...blockingDiagnostics.map((diagnostic) => diagnostic.title ?? diagnostic.code)
  ].filter(Boolean);
}

function publishQualityGate(stats) {
  const diagnostics = stats.diagnostics ?? [];
  return {
    status: stats.publishReadiness?.status ?? "ready",
    analyzedAt: stats.generatedAt,
    blockerCount: stats.publishReadiness?.blockers?.length ?? diagnostics.filter((item) => item.severity === "error").length,
    warningCount: stats.publishReadiness?.warnings?.length ?? diagnostics.filter((item) => item.severity === "warning").length,
    diagnosticCount: diagnostics.length,
    blockers: stats.publishReadiness?.blockers ?? [],
    warnings: stats.publishReadiness?.warnings ?? [],
    diagnostics: diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      title: diagnostic.title,
      message: diagnostic.message,
      ...(diagnostic.action ? { action: diagnostic.action } : {})
    }))
  };
}

async function publishProject(projectId) {
  await runAnalyze(projectId);
  const publishedAt = new Date().toISOString();
  const version = publishedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z");
  const source = targetDirs(projectId)[0];
  const stats = await readJson(path.join(source, "stats.json"));
  const publishBlockers = publishBlockersFromStats(stats);
  if (publishBlockers.length > 0) {
    throw badRequest(`Publish blocked: ${publishBlockers.join("; ")}.`);
  }
  const output = path.join(publishedRoot, projectId, version);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(source, output, { recursive: true, force: true });
  await removePublishOnlyTemporaryFiles(output);
  const scenePath = `/published/${projectId}/${version}/scene.manifest.json`;
  const viewerUrl = `/?scene=${encodeURIComponent(scenePath)}`;
  await writeFile(path.join(output, "index.html"), publishedIndexHtml(scenePath));
  const assets = await listPublishAssets(output);
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const deployment = {
    schemaVersion: "0.1",
    projectId,
    version,
    publishedAt,
    scenePath,
    viewerUrl,
    cdnBasePath: `/published/${projectId}/${version}/`,
    assetCount: assets.length,
    totalBytes,
    qualityGate: publishQualityGate(stats),
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
    viewerUrl,
    deploymentPath: `apps/viewer-demo/public/published/${projectId}/${version}/deployment.json`,
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
      await clearPreviousModelAssets(modelProjectId);
      await resetOptimizationState(modelProjectId);
      const isGltfUpload = filename.endsWith(".gltf");
      const sourceExtension = path.extname(filename);
      const isConvertibleUpload = convertibleModelExtensions.has(sourceExtension);
      const isArchiveUpload = filename.endsWith(".zip") || isZipBuffer(body);
      const archiveUpload = isArchiveUpload ? await writeProjectArchive(modelProjectId, body) : undefined;
      const sceneUrl = archiveUpload?.sceneUrl ?? (isConvertibleUpload ? "scene.glb" : isGltfUpload ? "scene.gltf" : "scene.glb");
      if (archiveUpload?.sourceRelative) {
        try {
          await runModelConversion(modelProjectId, archiveUpload.sourceRelative);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Model conversion failed.";
          throw apiError(message, 500, { conversionJob: await conversionJob(modelProjectId) });
        }
        const output = await readFile(path.join(targetDirs(modelProjectId)[0], "scene.glb"));
        validateGlbBuffer(output);
      } else if (isConvertibleUpload) {
        const sourceRelative = safeSourceModelPath(filename);
        await writeProjectFileBinary(modelProjectId, sourceRelative, body);
        try {
          await runModelConversion(modelProjectId, sourceRelative);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Model conversion failed.";
          throw apiError(message, 500, { conversionJob: await conversionJob(modelProjectId) });
        }
        const output = await readFile(path.join(targetDirs(modelProjectId)[0], "scene.glb"));
        validateGlbBuffer(output);
      } else if (!isArchiveUpload && sceneUrl === "scene.gltf") {
        validateGltfBuffer(body);
        await writeProjectAllBinary(modelProjectId, "scene.gltf", body);
      } else if (!isArchiveUpload && sceneUrl === "scene.glb") {
        validateGlbBuffer(body);
        await writeProjectAllBinary(modelProjectId, "scene.glb", body);
      }
      await setManifestSceneUrl(modelProjectId, sceneUrl);
      const externalResourceRepair = await repairExternalTexturePaths(modelProjectId);
      await runAnalyze(modelProjectId);
      await resetManifestForUploadedModel(modelProjectId, sceneUrl);
      await runAnalyze(modelProjectId);
      const project = await projectPayload(modelProjectId);
      sendJson(response, 200, {
        ok: true,
        manifest: project.manifest,
        controls: project.controls,
        stats: project.stats,
        optimization: project.optimization,
        conversionJob: project.conversionJob,
        repairedExternalResources: externalResourceRepair.copied,
        externalResourceRepair
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
      const externalResourceRepair = await repairExternalTexturePaths(repairProjectId);
      const current = await projectPayload(repairProjectId);
      await resetManifestForUploadedModel(repairProjectId, current.manifest.sceneUrl ?? "scene.glb", {
        resetInteractions: false,
        resetControls: false
      });
      await runAnalyze(repairProjectId);
      const project = await projectPayload(repairProjectId);
      sendJson(response, 200, {
        ok: true,
        repairedExternalResources: externalResourceRepair.copied,
        externalResourceRepair,
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
      const body = await readBody(request);
      try {
        await runLightmapBake(lightmapBakeProjectId, body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lightmap bake failed.";
        throw apiError(message, 500, { lightmapBakeJob: await lightmapBakeJob(lightmapBakeProjectId) });
      }
      await runAnalyze(lightmapBakeProjectId);
      const project = await projectPayload(lightmapBakeProjectId);
      sendJson(response, 200, {
        ok: true,
        manifest: project.manifest,
        materials: project.materials,
        stats: project.stats,
        optimization: project.optimization,
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
    const details = error?.details && typeof error.details === "object" ? error.details : {};
    sendJson(response, status, { error: message, ...details });
  }
}

createServer((request, response) => {
  void handleRequest(request, response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Walkthrough API listening on http://127.0.0.1:${port}`);
});
