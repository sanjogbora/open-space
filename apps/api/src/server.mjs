import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    typeof movement.lookSensitivityX !== "number" ||
    typeof movement.lookSensitivityY !== "number" ||
    typeof movement.clickMoveThresholdPx !== "number"
  ) {
    throw new Error("Invalid controls document.");
  }
}

function validateModelSource(value) {
  if (value !== "scene.glb" && value !== "scene.optimized.glb") {
    throw badRequest("Model source must be scene.glb or scene.optimized.glb.");
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
      validateGlbBuffer(body);
      await writeProjectAllBinary(modelProjectId, "scene.glb", body);
      await runAnalyze(modelProjectId);
      const project = await projectPayload(modelProjectId);
      sendJson(response, 200, { ok: true, stats: project.stats, optimization: project.optimization });
      return;
    }

    const analyzeProjectId = projectIdFromPathname(url.pathname, "/analyze");
    if (request.method === "POST" && analyzeProjectId) {
      await runAnalyze(analyzeProjectId);
      const project = await projectPayload(analyzeProjectId);
      sendJson(response, 200, { ok: true, stats: project.stats, optimization: project.optimization });
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
