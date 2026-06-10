// Screenshot helper for lighting iteration: loads the viewer on a scene/view
// and saves a PNG to artifacts/lighting-shots so renders can be compared
// against the Shapespark reference frames.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const scene = process.argv[2] ?? "/scenes/updated/scene.manifest.json";
const viewLabel = process.argv[3] ?? "Utility";
const outName = process.argv[4] ?? "shot";
const targetUrl = `http://127.0.0.1:5173/?scene=${encodeURIComponent(scene)}`;
const outputDir = path.resolve("artifacts", "lighting-shots");

const executablePath = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].filter(Boolean)[0];

const browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=default"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 800 } });
  page.on("console", (message) => {
    if (message.type() === "error") console.error("[page]", message.text());
  });
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 120_000 });
  // Wait for the loading overlay to disappear (scene ready).
  await page.waitForSelector(".loading-layer", { state: "detached", timeout: 240_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const viewButton = page.getByRole("button", { name: viewLabel, exact: true }).first();
  if (await viewButton.count()) {
    await viewButton.click().catch(() => {});
    await page.waitForTimeout(7000);
  }
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `${outName}.png`);
  await writeFile(file, await page.screenshot({ fullPage: false }));
  console.log(`saved ${file}`);
} finally {
  await browser.close();
}
