import { spawn } from "node:child_process";
import { cp, mkdir, readFile } from "node:fs/promises";
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

async function deployToDirectory(outputRoot) {
  const target = path.resolve(outputRoot, deployment.projectId, deployment.version);
  if (dryRun) {
    console.log(JSON.stringify({ mode: "directory", sourceDir, target, dryRun: true }, null, 2));
    return;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(sourceDir, target, { recursive: true, force: true });
  console.log(JSON.stringify({ mode: "directory", target, assetCount: deployment.assetCount }, null, 2));
}

async function deployToS3(targetUri) {
  const args = ["s3", "sync", sourceDir, targetUri, "--delete"];
  if (dryRun) {
    args.push("--dryrun");
  }
  await run(process.env.AWS_CLI_PATH || "aws", args);
  console.log(JSON.stringify({ mode: "s3", target: targetUri, assetCount: deployment.assetCount }, null, 2));
}

if (s3Arg) {
  await deployToS3(s3Arg);
} else {
  await deployToDirectory(outArg ?? "dist/published");
}
