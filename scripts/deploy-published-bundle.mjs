import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const deploymentArg = args.find((arg) => !arg.startsWith("--"));
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
const s3Arg = args.find((arg) => arg.startsWith("--s3="))?.slice("--s3=".length);
const viewerBaseArg = args.find((arg) => arg.startsWith("--viewer-base="))?.slice("--viewer-base=".length);
const publicBaseArg = args.find((arg) => arg.startsWith("--public-base="))?.slice("--public-base=".length);
const dryRun = args.includes("--dry-run");
const applyCacheControl = args.includes("--apply-cache-control");
const allowBlockedQualityGate = args.includes("--allow-blocked");

if (!deploymentArg) {
  throw new Error(
    "Usage: node scripts/deploy-published-bundle.mjs <deployment.json> [--out=dist/published] [--s3=s3://bucket/prefix] [--viewer-base=https://viewer.example.com] [--public-base=https://cdn.example.com/scene/] [--apply-cache-control] [--allow-blocked] [--dry-run]"
  );
}

const deploymentPath = path.resolve(deploymentArg);
const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
const sourceDir = path.dirname(deploymentPath);
const deployStartedAt = new Date().toISOString();

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}.`));
    });
  });
}

async function fileInfo(relativePath) {
  const safePath = safeDeploymentAssetPath(relativePath);
  const fullPath = path.join(sourceDir, safePath);
  try {
    await access(fullPath);
    const info = await stat(fullPath);
    const sha256 = createHash("sha256").update(await readFile(fullPath)).digest("hex");
    return { path: safePath, exists: true, bytes: info.size, sha256 };
  } catch {
    return { path: safePath, exists: false, bytes: 0, sha256: "" };
  }
}

function safeDeploymentAssetPath(relativePath) {
  const cleanPath = String(relativePath ?? "").replace(/\\/g, "/");
  const normalized = path.posix.normalize(cleanPath);
  if (
    !cleanPath ||
    path.isAbsolute(cleanPath) ||
    /^[a-zA-Z]:/.test(cleanPath) ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".."
  ) {
    throw new Error(`Unsafe deployment asset path: ${relativePath}`);
  }
  return normalized;
}

async function validateDeployment() {
  if (deployment.schemaVersion !== "0.1") {
    throw new Error("Unsupported deployment manifest schema.");
  }
  if (!deployment.projectId || !deployment.version || !Array.isArray(deployment.assets)) {
    throw new Error("Deployment manifest is missing projectId, version, or assets.");
  }
  const seen = new Set();
  for (const asset of deployment.assets) {
    const safePath = safeDeploymentAssetPath(asset.path);
    if (seen.has(safePath)) {
      throw new Error(`Duplicate deployment asset path: ${safePath}`);
    }
    seen.add(safePath);
  }
  const checks = await Promise.all(deployment.assets.map((asset) => fileInfo(asset.path)));
  const missing = checks.filter((check) => !check.exists);
  const mismatched = checks.filter((check) => {
    const asset = deployment.assets.find((item) => item.path === check.path);
    return check.exists && typeof asset?.bytes === "number" && check.bytes !== asset.bytes;
  });
  const hashMismatched = checks.filter((check) => {
    const asset = deployment.assets.find((item) => item.path === check.path);
    return check.exists && typeof asset?.sha256 === "string" && asset.sha256 && check.sha256 !== asset.sha256;
  });
  if (missing.length > 0 || mismatched.length > 0 || hashMismatched.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `${missing.length} asset(s) are missing` : undefined,
        mismatched.length > 0 ? `${mismatched.length} asset(s) have changed size since publish` : undefined,
        hashMismatched.length > 0 ? `${hashMismatched.length} asset(s) have changed content since publish` : undefined
      ]
        .filter(Boolean)
        .join("; ")
    );
  }
  validateQualityGate();
  return checks;
}

function validateQualityGate() {
  const qualityGate = deployment.qualityGate;
  if (!qualityGate) {
    console.warn("Deployment manifest has no qualityGate; deploy will continue with asset validation only.");
    return;
  }
  const blockerCount = Number(qualityGate.blockerCount ?? 0);
  if (qualityGate.status !== "blocked" && blockerCount <= 0) {
    return;
  }
  const blockers = Array.isArray(qualityGate.blockers)
    ? qualityGate.blockers
        .slice(0, 6)
        .map((blocker) => blocker.title || blocker.code || blocker.message)
        .filter(Boolean)
    : [];
  const detail = blockers.length > 0 ? `: ${blockers.join("; ")}` : "";
  const message = `Deployment quality gate is blocked${detail}.`;
  if (allowBlockedQualityGate) {
    console.warn(`${message} Continuing because --allow-blocked was provided.`);
    return;
  }
  throw new Error(`${message} Fix the bundle or pass --allow-blocked for internal testing only.`);
}

function cachePolicySummary() {
  const summary = {
    immutable: 0,
    revalidated: 0,
    uncategorized: 0
  };
  for (const asset of deployment.assets ?? []) {
    const cacheControl = String(asset.cacheControl ?? "").toLowerCase();
    if (cacheControl.includes("immutable")) {
      summary.immutable += 1;
    } else if (cacheControl.includes("must-revalidate") || cacheControl.includes("no-cache")) {
      summary.revalidated += 1;
    } else {
      summary.uncategorized += 1;
    }
  }
  return summary;
}

function headersFile(deployment) {
  const lines = [];
  for (const rule of deployment.headers ?? []) {
    lines.push(rule.source);
    for (const header of rule.headers ?? []) {
      lines.push(`  ${header.key}: ${header.value}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function vercelConfig(deployment) {
  return {
    headers: (deployment.headers ?? []).map((rule) => ({
      source: rule.source,
      headers: rule.headers
    }))
  };
}

function normalizeUrlBase(value, label) {
  if (!value) {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
  return parsed.href.replace(/\/+$/, "");
}

function joinS3Uri(baseUri, relativePath) {
  return `${baseUri.replace(/\/+$/, "")}/${safeDeploymentAssetPath(relativePath)}`;
}

function contentTypeForAssetPath(relativePath) {
  const extension = path.extname(safeDeploymentAssetPath(relativePath)).toLowerCase();
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".glb":
      return "model/gltf-binary";
    case ".gltf":
      return "model/gltf+json";
    case ".bin":
      return "application/octet-stream";
    case ".wasm":
      return "application/wasm";
    case ".basis":
      return "image/basis";
    case ".ktx2":
      return "image/ktx2";
    case ".avif":
      return "image/avif";
    case ".webp":
      return "image/webp";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

function launchIndexHtml(viewerBase, publicBase) {
  const sceneUrl = `${publicBase}/scene.manifest.json`;
  const viewerUrl = `${viewerBase}/?scene=${encodeURIComponent(sceneUrl)}`;
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

function embedSnippetHtml(viewerBase, publicBase) {
  const sceneUrl = `${publicBase}/scene.manifest.json`;
  const embedUrl = `${viewerBase}/embed.js`;
  const title = deployment.projectId || "Walkthrough";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Embed ${title}</title>
  </head>
  <body>
    <script src="${embedUrl}" data-scene="${sceneUrl}" data-title="${title}" data-height="640px"></script>
  </body>
</html>
`;
}

async function writeDeployReport(mode, target, checks, reportDir = sourceDir, extra = {}) {
  const viewerBase = normalizeUrlBase(viewerBaseArg, "--viewer-base");
  const publicBase = normalizeUrlBase(publicBaseArg, "--public-base");
  const report = {
    schemaVersion: "0.1",
    mode,
    target,
    deploymentPath,
    projectId: deployment.projectId,
    version: deployment.version,
    startedAt: deployStartedAt,
    completedAt: new Date().toISOString(),
    dryRun,
    assetCount: deployment.assetCount,
    checkedAssetCount: checks.length,
    totalBytes: deployment.totalBytes,
    cachePolicy: cachePolicySummary(),
    qualityGate: deployment.qualityGate ?? null,
    qualityGateOverride: allowBlockedQualityGate,
    ...extra,
    ...(viewerBase ? { viewerBase } : {}),
    ...(publicBase ? { publicBase } : {}),
    ...(viewerBase && publicBase
      ? {
          launchUrl: `${viewerBase}/?scene=${encodeURIComponent(`${publicBase}/scene.manifest.json`)}`,
          embedScript: `<script src="${viewerBase}/embed.js" data-scene="${publicBase}/scene.manifest.json" data-title="${deployment.projectId}" data-height="640px"></script>`
        }
      : {})
  };
  if (!dryRun) {
    await writeFile(path.join(reportDir, "deploy-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

async function deployToDirectory(outputRoot) {
  const checks = await validateDeployment();
  const viewerBase = normalizeUrlBase(viewerBaseArg, "--viewer-base");
  const publicBase = normalizeUrlBase(publicBaseArg, "--public-base");
  if ((viewerBase && !publicBase) || (!viewerBase && publicBase)) {
    throw new Error("--viewer-base and --public-base must be provided together.");
  }
  const target = path.resolve(outputRoot, deployment.projectId, deployment.version);
  if (dryRun) {
    await writeDeployReport("directory", target, checks);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(sourceDir, target, { recursive: true, force: true });
  await writeFile(path.join(target, "_headers"), headersFile(deployment));
  await writeFile(path.join(target, "vercel.json"), `${JSON.stringify(vercelConfig(deployment), null, 2)}\n`);
  if (viewerBase && publicBase) {
    await writeFile(path.join(target, "index.html"), launchIndexHtml(viewerBase, publicBase));
    await writeFile(path.join(target, "embed.html"), embedSnippetHtml(viewerBase, publicBase));
  }
  await writeDeployReport("directory", target, checks, target);
}

async function deployToS3(targetUri) {
  const checks = await validateDeployment();
  const viewerBase = normalizeUrlBase(viewerBaseArg, "--viewer-base");
  const publicBase = normalizeUrlBase(publicBaseArg, "--public-base");
  if ((viewerBase && !publicBase) || (!viewerBase && publicBase)) {
    throw new Error("--viewer-base and --public-base must be provided together.");
  }
  let syncSourceDir = sourceDir;
  let stagingDir;
  try {
    if (viewerBase && publicBase && !dryRun) {
      stagingDir = await mkdtemp(path.join(os.tmpdir(), "open-space-publish-"));
      await cp(sourceDir, stagingDir, { recursive: true, force: true });
      await writeFile(path.join(stagingDir, "index.html"), launchIndexHtml(viewerBase, publicBase));
      await writeFile(path.join(stagingDir, "embed.html"), embedSnippetHtml(viewerBase, publicBase));
      syncSourceDir = stagingDir;
    }

    const args = ["s3", "sync", syncSourceDir, targetUri, "--delete"];
    if (dryRun) {
      args.push("--dryrun");
    }
    await run(process.env.AWS_CLI_PATH || "aws", args);
    let cacheControlApplied = 0;
    if (applyCacheControl && !dryRun) {
      for (const asset of deployment.assets ?? []) {
        if (!asset.cacheControl) {
          continue;
        }
        const assetUri = joinS3Uri(targetUri, asset.path);
        await run(process.env.AWS_CLI_PATH || "aws", [
          "s3",
          "cp",
          assetUri,
          assetUri,
          "--metadata-directive",
          "REPLACE",
          "--cache-control",
          asset.cacheControl,
          "--content-type",
          contentTypeForAssetPath(asset.path)
        ]);
        cacheControlApplied += 1;
      }
      for (const page of ["index.html", "embed.html"]) {
        const pageUri = joinS3Uri(targetUri, page);
        await run(process.env.AWS_CLI_PATH || "aws", [
          "s3",
          "cp",
          pageUri,
          pageUri,
          "--metadata-directive",
          "REPLACE",
          "--cache-control",
          "public, max-age=300, must-revalidate",
          "--content-type",
          "text/html; charset=utf-8"
        ]);
      }
    }
    await writeDeployReport("s3", targetUri, checks, sourceDir, {
      cacheControlMode: applyCacheControl ? "per-asset" : "sync-default",
      cacheControlApplied,
      launchFilesRewritten: Boolean(viewerBase && publicBase && !dryRun)
    });
  } finally {
    if (stagingDir) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

if (s3Arg) {
  await deployToS3(s3Arg);
} else {
  await deployToDirectory(outArg ?? "dist/published");
}
