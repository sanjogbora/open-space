import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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
    optimizationHistoryDocument
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
    optimizationHistory(projectId)
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
    optimizationHistory: optimizationHistoryDocument
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

function importedModelViews(bounds, cameraHeight) {
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
    {
      id: "top",
      label: "Top",
      kind: "top",
      position: [center[0], bounds.max[1] + topHeight, center[2] + 0.01],
      target: [center[0], center[1], center[2]],
      fov: 48
    }
  ];
}

function graphWalkZoneCandidates(graph, modelScale) {
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
  return (graph?.nodes ?? [])
    .map((node) => {
      if (!node.bounds) {
        return undefined;
      }
      const searchName = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
      const keywordMatched = floorKeywords.some((keyword) => searchName.includes(keyword));
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
      if (!keywordMatched || !flatEnough || area < 1) {
        return undefined;
      }
      return {
        id: `walk-${node.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60),
        label: node.name || "Walk surface",
        kind: "walk",
        center: [
          (scaledBounds.min[0] + scaledBounds.max[0]) / 2,
          scaledBounds.min[1] + 0.03,
          (scaledBounds.min[2] + scaledBounds.max[2]) / 2
        ],
        size: [Math.max(0.8, Math.abs(size[0])), 0.08, Math.max(0.8, Math.abs(size[2]))],
        rotationY: 0,
        enabled: true,
        area
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area)
    .slice(0, 12)
    .map(({ area: _area, ...zone }) => zone);
}

function importedNavigationZones(bounds, existingZones = [], graph, modelScale = 1) {
  const hasUserAuthoredZones =
    Array.isArray(existingZones) &&
    existingZones.some((zone) => !String(zone.id ?? "").startsWith("walk-main"));
  if (hasUserAuthoredZones) {
    return existingZones;
  }
  const graphZones = graphWalkZoneCandidates(graph, modelScale);
  if (graphZones.length > 0) {
    return graphZones;
  }
  if (!bounds) {
    return [];
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
    }
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
      groundEnabled: manifest.environment?.groundEnabled ?? true,
      groundColor: manifest.environment?.groundColor ?? "#6f8f5a",
      groundSize:
        manifest.environment?.groundSize ??
        (bounds ? Math.max(30, (bounds.max[0] - bounds.min[0]) * 1.8, (bounds.max[2] - bounds.min[2]) * 1.8) : 90),
      groundY: manifest.environment?.groundY ?? (bounds ? bounds.min[1] - 0.04 : -0.04)
    },
    views: importedModelViews(bounds, cameraHeight),
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
      zones: importedNavigationZones(bounds, manifest.navigation?.zones, graph, modelScale),
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

async function publishProject(projectId) {
  await runAnalyze(projectId);
  const publishedAt = new Date().toISOString();
  const version = publishedAt.replace(/[-:.]/g, "").replace("T", "-").replace("Z", "z");
  const source = targetDirs(projectId)[0];
  const output = path.join(publishedRoot, projectId, version);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(source, output, { recursive: true, force: true });

  const entry = {
    version,
    publishedAt,
    scenePath: `/published/${projectId}/${version}/scene.manifest.json`
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
      const current = await projectPayload(repairProjectId);
      await resetManifestForUploadedModel(repairProjectId, current.manifest.sceneUrl ?? "scene.glb", {
        resetInteractions: false,
        resetControls: false
      });
      await runAnalyze(repairProjectId);
      const project = await projectPayload(repairProjectId);
      sendJson(response, 200, {
        ok: true,
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
