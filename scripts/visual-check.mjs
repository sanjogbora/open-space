import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const runtimeNodeModules =
  process.env.CODEX_RUNTIME_NODE_MODULES ??
  "C:/Users/sanjo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const require = createRequire(`${runtimeNodeModules}/package.json`);
const { chromium } = require("playwright");
const { PNG } = require("pngjs");

const targetUrl = process.env.VISUAL_CHECK_URL ?? "http://127.0.0.1:5173/";
const checkMode = process.env.VISUAL_CHECK_MODE ?? "viewer";
const clickText = process.env.VISUAL_CHECK_CLICK_TEXT;
const interactionCheck = process.env.VISUAL_CHECK_INTERACTION;
const outputDir = path.resolve("artifacts", "visual-check");
const chromeCandidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean);

function analyzePng(buffer) {
  const png = PNG.sync.read(buffer);
  const colorBuckets = new Set();
  let brightPixels = 0;
  let darkPixels = 0;
  let total = 0;

  for (let y = 0; y < png.height; y += 8) {
    for (let x = 0; x < png.width; x += 8) {
      const index = (png.width * y + x) << 2;
      const r = png.data[index] ?? 0;
      const g = png.data[index + 1] ?? 0;
      const b = png.data[index + 2] ?? 0;
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colorBuckets.add(`${r >> 4}-${g >> 4}-${b >> 4}`);
      if (luminance > 50) {
        brightPixels += 1;
      } else {
        darkPixels += 1;
      }
      total += 1;
    }
  }

  return {
    width: png.width,
    height: png.height,
    colorBuckets: colorBuckets.size,
    brightRatio: brightPixels / total,
    darkRatio: darkPixels / total
  };
}

function comparePng(firstBuffer, secondBuffer) {
  const first = PNG.sync.read(firstBuffer);
  const second = PNG.sync.read(secondBuffer);
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error("Cannot compare screenshots with different dimensions.");
  }

  let changed = 0;
  let sampled = 0;
  for (let y = 0; y < first.height; y += 6) {
    for (let x = 0; x < first.width; x += 6) {
      const index = (first.width * y + x) << 2;
      const dr = Math.abs((first.data[index] ?? 0) - (second.data[index] ?? 0));
      const dg = Math.abs((first.data[index + 1] ?? 0) - (second.data[index + 1] ?? 0));
      const db = Math.abs((first.data[index + 2] ?? 0) - (second.data[index + 2] ?? 0));
      if (dr + dg + db > 18) {
        changed += 1;
      }
      sampled += 1;
    }
  }

  return changed / sampled;
}

async function captureViewport(page, name, viewport) {
  await page.setViewportSize(viewport);
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  if (checkMode === "viewer") {
    await waitForViewerCanvas(page);
  } else {
    await page.waitForSelector("body", { state: "visible", timeout: 10_000 });
    if (clickText) {
      await page.getByRole("button", { name: clickText, exact: true }).click();
    }
  }
  await page.waitForTimeout(500);

  const screenshot = await page.screenshot({ fullPage: false });
  const stats = analyzePng(screenshot);
  const outputPath = path.join(outputDir, `${name}.png`);
  await writeFile(outputPath, screenshot);

  if (stats.colorBuckets < 24 || stats.brightRatio < 0.08) {
    throw new Error(
      `${name} appears blank or under-rendered: ${JSON.stringify(stats)}`
    );
  }

  return {
    name,
    outputPath,
    ...stats
  };
}

async function runViewerControlsCheck(page) {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await waitForViewerCanvas(page);
  await page.waitForTimeout(700);

  const canvas = page.locator("canvas.walkthrough-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("Viewer canvas has no bounding box.");
  }

  const before = await page.screenshot({ fullPage: false });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(650);
  await page.keyboard.up("KeyW");
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.52);
  await page.mouse.down({ button: "left" });
  await page.mouse.move(box.x + box.width * 0.67, box.y + box.height * 0.45, { steps: 12 });
  await page.mouse.up({ button: "left" });
  await page.waitForTimeout(400);
  const after = await page.screenshot({ fullPage: false });
  const diffRatio = comparePng(before, after);

  await writeFile(path.join(outputDir, "viewer-controls-before.png"), before);
  await writeFile(path.join(outputDir, "viewer-controls-after.png"), after);

  if (diffRatio < 0.012) {
    throw new Error(`Viewer controls did not create enough visual movement: ${diffRatio}`);
  }

  return {
    name: "viewer-controls",
    diffRatio
  };
}

async function runViewerObjectPickCheck(page) {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await waitForViewerCanvas(page);
  await page.waitForTimeout(700);

  const canvas = page.locator("canvas.walkthrough-canvas");
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("Viewer canvas has no bounding box.");
  }

  const clickPoints = [
    [0.42, 0.58],
    [0.48, 0.55],
    [0.35, 0.52],
    [0.62, 0.55]
  ];

  for (const [xRatio, yRatio] of clickPoints) {
    await page.mouse.click(box.x + box.width * xRatio, box.y + box.height * yRatio);
    try {
      await page.waitForSelector(".object-panel", { state: "visible", timeout: 900 });
      const screenshot = await page.screenshot({ fullPage: false });
      await writeFile(path.join(outputDir, "viewer-object-pick.png"), screenshot);
      return {
        name: "viewer-object-pick",
        clicked: [xRatio, yRatio]
      };
    } catch {
      // Try another likely object point.
    }
  }

  throw new Error("Object pick panel did not appear after clicking likely scene objects.");
}

async function runViewerScreenshotCheck(page) {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await waitForViewerCanvas(page);
  await page.waitForTimeout(700);

  const downloadPromise = page.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
  await page.getByRole("button", { name: "Screenshot", exact: true }).click();
  await page.waitForSelector(".toast", { state: "visible", timeout: 3_000 });
  const toastText = await page.locator(".toast").last().innerText();
  const download = await downloadPromise;

  if (!toastText.includes("Screenshot saved")) {
    throw new Error(`Screenshot action did not report success: ${toastText}`);
  }

  return {
    name: "viewer-screenshot",
    suggestedFilename: download ? download.suggestedFilename() : null
  };
}

async function runViewerMinimapCheck(page) {
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await waitForViewerCanvas(page);
  await page.waitForSelector(".minimap", { state: "visible", timeout: 5_000 });
  await page.waitForSelector(".minimap-camera", { state: "visible", timeout: 5_000 });

  const viewCount = await page.locator(".minimap-view").count();
  if (viewCount < 2) {
    throw new Error(`Expected minimap view dots, found ${viewCount}.`);
  }

  await page.locator('.minimap-view[title="Kitchen"]').click();
  await page.waitForTimeout(900);
  const isActive = await page.locator('.minimap-view[title="Kitchen"]').evaluate((node) =>
    node.classList.contains("active")
  );
  if (!isActive) {
    throw new Error("Minimap view click did not activate the Kitchen view.");
  }

  return {
    name: "viewer-minimap",
    viewCount
  };
}

async function waitForViewerCanvas(page) {
  try {
    await page.waitForSelector("canvas.walkthrough-canvas", { state: "visible", timeout: 5_000 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas.walkthrough-canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 100 && canvas.height > 100;
    });
    return;
  } catch {
    const iframeHandle = await page.waitForSelector("iframe", { state: "attached", timeout: 5_000 });
    const frame = await iframeHandle.contentFrame();
    if (!frame) {
      throw new Error("Embed iframe did not expose a content frame.");
    }
    await frame.waitForSelector("canvas.walkthrough-canvas", { state: "visible", timeout: 10_000 });
    await frame.waitForFunction(() => {
      const canvas = document.querySelector("canvas.walkthrough-canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 100 && canvas.height > 100;
    });
  }
}

await mkdir(outputDir, { recursive: true });

const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ["--disable-gpu-sandbox"]
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const results = [];

try {
  if (interactionCheck === "viewer-controls") {
    results.push(await runViewerControlsCheck(page));
  } else if (interactionCheck === "viewer-object-pick") {
    results.push(await runViewerObjectPickCheck(page));
  } else if (interactionCheck === "viewer-screenshot") {
    results.push(await runViewerScreenshotCheck(page));
  } else if (interactionCheck === "viewer-minimap") {
    results.push(await runViewerMinimapCheck(page));
  } else {
    results.push(await captureViewport(page, "desktop", { width: 1440, height: 900 }));
    results.push(await captureViewport(page, "mobile", { width: 390, height: 844 }));
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ targetUrl, results }, null, 2));
