import type { SceneManifest } from "@walkthrough/scene-schema";
export {
  analyzeGltfModel,
  extractMaterialsDocument,
  extractObjectsDocument,
  extractSceneGraph,
  parseGlbJson
} from "./gltf-model";
export type { GltfModelStats } from "./gltf-model";

export type AssetKind = "model" | "video" | "image" | "unknown";

export interface AssetReference {
  kind: AssetKind;
  source: string;
  label: string;
}

export interface AssetSize {
  source: string;
  bytes: number;
  exists: boolean;
}

export interface SceneBudget {
  maxTotalBytes: number;
  maxModelBytes: number;
  maxVideoBytes: number;
  maxInteractionCount: number;
}

export interface SceneBundleWarning {
  code: string;
  message: string;
}

export interface SceneBundleStats {
  assetCount: number;
  missingAssetCount: number;
  totalBytes: number;
  modelBytes: number;
  videoBytes: number;
  interactionCount: number;
  viewCount: number;
  triangleCount?: number;
  meshCount?: number;
  materialCount?: number;
  warnings: readonly SceneBundleWarning[];
}

export const defaultSceneBudget: SceneBudget = {
  maxTotalBytes: 160 * 1024 * 1024,
  maxModelBytes: 70 * 1024 * 1024,
  maxVideoBytes: 45 * 1024 * 1024,
  maxInteractionCount: 80
};

export function isExternalAsset(source: string): boolean {
  return (
    source.startsWith("generated://") ||
    source.startsWith("data:") ||
    source.startsWith("blob:") ||
    source.startsWith("http://") ||
    source.startsWith("https://")
  );
}

export function collectAssetReferences(manifest: SceneManifest): readonly AssetReference[] {
  const assets: AssetReference[] = [];

  if (manifest.sceneUrl && !isExternalAsset(manifest.sceneUrl)) {
    assets.push({
      kind: "model",
      source: manifest.sceneUrl,
      label: "Scene model"
    });
  }

  manifest.interactions.forEach((interaction) => {
    if (interaction.kind === "video-texture" && !isExternalAsset(interaction.source)) {
      assets.push({
        kind: "video",
        source: interaction.source,
        label: interaction.label
      });
    }
  });

  if (manifest.branding.logoUrl && !isExternalAsset(manifest.branding.logoUrl)) {
    assets.push({
      kind: "image",
      source: manifest.branding.logoUrl,
      label: "Brand logo"
    });
  }

  return assets;
}

export function summarizeSceneBundle(
  manifest: SceneManifest,
  assetSizes: readonly AssetSize[],
  budget: SceneBudget = defaultSceneBudget
): SceneBundleStats {
  const totalBytes = assetSizes.reduce((sum, asset) => sum + asset.bytes, 0);
  const missingAssetCount = assetSizes.filter((asset) => !asset.exists).length;
  const modelBytes = assetSizes
    .filter((asset) => asset.source.endsWith(".glb") || asset.source.endsWith(".gltf"))
    .reduce((sum, asset) => sum + asset.bytes, 0);
  const videoBytes = assetSizes
    .filter((asset) => /\.(mp4|webm|mov)$/i.test(asset.source))
    .reduce((sum, asset) => sum + asset.bytes, 0);

  const warnings: SceneBundleWarning[] = [];

  if (missingAssetCount > 0) {
    warnings.push({
      code: "missing-assets",
      message: `${missingAssetCount} referenced asset(s) are missing.`
    });
  }

  if (totalBytes > budget.maxTotalBytes) {
    warnings.push({
      code: "total-size-budget",
      message: `Bundle size exceeds ${(budget.maxTotalBytes / 1024 / 1024).toFixed(0)} MB.`
    });
  }

  if (modelBytes > budget.maxModelBytes) {
    warnings.push({
      code: "model-size-budget",
      message: `Model assets exceed ${(budget.maxModelBytes / 1024 / 1024).toFixed(0)} MB.`
    });
  }

  if (videoBytes > budget.maxVideoBytes) {
    warnings.push({
      code: "video-size-budget",
      message: `Video assets exceed ${(budget.maxVideoBytes / 1024 / 1024).toFixed(0)} MB.`
    });
  }

  if (manifest.interactions.length > budget.maxInteractionCount) {
    warnings.push({
      code: "interaction-count-budget",
      message: `Interaction count exceeds ${budget.maxInteractionCount}.`
    });
  }

  return {
    assetCount: assetSizes.length,
    missingAssetCount,
    totalBytes,
    modelBytes,
    videoBytes,
    interactionCount: manifest.interactions.length,
    viewCount: manifest.views.length,
    warnings
  };
}
