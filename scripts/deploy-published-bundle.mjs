import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const deploymentArg = args.find((arg) => !arg.startsWith("--"));
const outArg = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
const s3Arg = args.find((arg) => arg.startsWith("--s3="))?.slice("--s3=".length);
const dryRun = args.includes("--dry-run");

if (!deploymentArg) {
  throw new Error("Usage: node scripts/deploy-published-bundle.mjs <deployment.json> [--out=dist/published] [--s3=s3://bucket/prefix] [--dry-run]");
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

async function writeDeployReport(mode, target, checks, reportDir = sourceDir) {
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
    cachePolicy: cachePolicySummary()
  };
  if (!dryRun) {
    await writeFile(path.join(reportDir, "deploy-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}

async function deployToDirectory(outputRoot) {
  const checks = await validateDeployment();
  const target = path.resolve(outputRoot, deployment.projectId, deployment.version);
  if (dryRun) {
    await writeDeployReport("directory", target, checks);
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(sourceDir, target, { recursive: true, force: true });
  await writeFile(path.join(target, "_headers"), headersFile(deployment));
  await writeFile(path.join(target, "vercel.json"), `${JSON.stringify(vercelConfig(deployment), null, 2)}\n`);
  await writeDeployReport("directory", target, checks, target);
}

async function deployToS3(targetUri) {
  const checks = await validateDeployment();
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
