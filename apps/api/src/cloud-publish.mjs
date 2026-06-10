// Publishes a local published bundle to Supabase Storage (free tier) so a
// walkthrough can be shared as a stable public link. Storage layout is a
// convention the viewer can construct without any database lookup:
//   <bucket>/<slug>/live/scene.manifest.json (+ all bundle assets)
// Re-publishing overwrites live/, so share links never change.
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Supabase free tier caps uploads at 50 MB per file.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const contentTypes = new Map([
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".bin", "application/octet-stream"],
  [".json", "application/json"],
  [".html", "text/html; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ktx2", "image/ktx2"],
  [".basis", "application/octet-stream"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".svg", "image/svg+xml"]
]);

/** Minimal .env loader so SUPABASE_* can live in <repo>/.env.local (gitignored). */
export async function loadEnvFiles(repoRoot) {
  for (const name of [".env.local", ".env"]) {
    try {
      const raw = await readFile(path.join(repoRoot, name), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        const key = match[1];
        const value = match[2].replace(/^["']|["']$/g, "");
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // File absent — fine.
    }
  }
}

export function cloudConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return null;
  }
  return {
    url,
    key,
    bucket: process.env.SUPABASE_BUCKET ?? "scenes",
    viewerUrl: process.env.PUBLIC_VIEWER_URL?.replace(/\/+$/, "") ?? ""
  };
}

export function generateShareSlug() {
  return randomBytes(8).toString("base64url").replace(/[-_]/g, "").slice(0, 10).toLowerCase() || "scene";
}

async function walkFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute, base)));
    } else if (entry.isFile()) {
      files.push(path.relative(base, absolute).replaceAll("\\", "/"));
    }
  }
  return files;
}

function shouldUpload(relativePath, manifest) {
  if (relativePath.startsWith("source/")) return false;
  if (relativePath.endsWith(".blend")) return false;
  if (/^\.(convert-model|lightmap-bake)/.test(relativePath)) return false;
  if (/^(conversion|optimization|lightmap-bake)-(job|history)\.json$/.test(relativePath)) return false;
  if (relativePath === "share.json" || relativePath === "publish-history.json") return false;
  // Skip the unoptimized original when the manifest serves a different model file.
  const sceneUrl = manifest?.sceneUrl;
  const originalSceneUrl = manifest?.originalSceneUrl;
  if (originalSceneUrl && sceneUrl && originalSceneUrl !== sceneUrl && relativePath === originalSceneUrl) {
    return false;
  }
  return true;
}

/**
 * Uploads the bundle directory to <bucket>/<slug>/live/ with upsert.
 * Throws with actionable messages on missing config or oversized files.
 */
export async function publishBundleToCloud({ bundleDir, slug, manifest }) {
  const config = cloudConfig();
  if (!config) {
    const error = new Error(
      "Cloud sharing is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local at the repo root (see docs/deployment.md)."
    );
    error.status = 400;
    throw error;
  }
  const relativeFiles = (await walkFiles(bundleDir)).filter((file) => shouldUpload(file, manifest));
  if (!relativeFiles.includes("scene.manifest.json")) {
    const error = new Error("Bundle has no scene.manifest.json — publish a version first.");
    error.status = 400;
    throw error;
  }

  const payloads = [];
  const oversized = [];
  for (const relative of relativeFiles) {
    const data = await readFile(path.join(bundleDir, relative));
    if (data.byteLength > MAX_FILE_BYTES) {
      oversized.push(`${relative} (${(data.byteLength / 1024 / 1024).toFixed(1)} MB)`);
    }
    payloads.push({ relative, data });
  }
  if (oversized.length > 0) {
    const error = new Error(
      `These files exceed the Supabase free-tier 50 MB upload limit: ${oversized.join(", ")}. Run optimization (mobile or balanced profile with KTX2) to shrink the model, then publish and share again.`
    );
    error.status = 400;
    throw error;
  }

  let uploadedBytes = 0;
  for (const { relative, data } of payloads) {
    const objectPath = `${slug}/live/${relative}`;
    const extension = path.extname(relative).toLowerCase();
    const response = await fetch(
      `${config.url}/storage/v1/object/${config.bucket}/${encodeURI(objectPath)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.key}`,
          "x-upsert": "true",
          "content-type": contentTypes.get(extension) ?? "application/octet-stream",
          "cache-control": extension === ".json" || extension === ".html" ? "max-age=60" : "max-age=31536000"
        },
        body: data
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(
        `Upload failed for ${relative}: ${response.status} ${detail.slice(0, 300)}. Check that the "${config.bucket}" bucket exists and is public, and that the service role key is correct.`
      );
      error.status = 502;
      throw error;
    }
    uploadedBytes += data.byteLength;
  }

  const manifestUrl = `${config.url}/storage/v1/object/public/${config.bucket}/${slug}/live/scene.manifest.json`;
  const shareUrl = config.viewerUrl
    ? `${config.viewerUrl}/v/${slug}`
    : `${config.viewerUrl || ""}/?scene=${encodeURIComponent(manifestUrl)}`;
  return {
    slug,
    uploadedCount: payloads.length,
    uploadedBytes,
    manifestUrl,
    shareUrl: config.viewerUrl ? shareUrl : manifestUrl
  };
}
