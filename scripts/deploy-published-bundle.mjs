import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const deploymentArg = args.find((arg) => !arg.startsWith("--"));
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
const s3Arg = args.find((arg) => arg.startsWith("--s3="))?.slice("--s3=".length);
const viewerBaseArg = args.find((arg) => arg.startsWith("--viewer-base="))?.slice("--viewer-base=".length);
const publicBaseArg = args.find((arg) => arg.startsWith("--public-base="))?.slice("--public-base=".length);
const dryRun = args.includes("--dry-run");

if (!deploymentArg) {
  throw new Error(
    "Usage: node scripts/deploy-published-bundle.mjs <deployment.json> [--out=dist/published] [--s3=s3://bucket/prefix] [--viewer-base=https://viewer.example.com] [--public-base=https://cdn.example.com/scene/] [--dry-run]"
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
  return checks;
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

async function writeDeployReport(mode, target, checks, reportDir = sourceDir) {
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
  if ((viewerBaseArg && !publicBaseArg) || (!viewerBaseArg && publicBaseArg)) {
    throw new Error("--viewer-base and --public-base must be provided together.");
  }
  const args = ["s3", "sync", sourceDir, targetUri, "--delete"];
  if (dryRun) {
    args.push("--dryrun");
  }
  await run(process.env.AWS_CLI_PATH || "aws", args);
  await writeDeployReport("s3", targetUri, checks);
}

if (s3Arg) {
  await deployToS3(s3Arg);
} else {
  await deployToDirectory(outArg ?? "dist/published");
}
