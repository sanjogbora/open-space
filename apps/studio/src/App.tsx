import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Box,
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FileJson,
  Globe2,
  Layers3,
  MapPin,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Wrench,
  Video
} from "lucide-react";
import {
  navigationZoneConnectionPadding,
  pointInPolygon2D,
  pointToPolygonDistance2D,
  polygonDistance2D,
  parseSceneManifest,
  type HotspotInteraction,
  type LinkInteraction,
  type MaterialOverride,
  type MaterialVariant,
  type MaterialVariantInteraction,
  type NavigationZone,
  type ObjectOverride,
  type ObjectToggleInteraction,
  type SceneControlsDocument,
  type SceneGraphDocument,
  type SceneGraphNode,
  type SceneInteraction,
  type SceneManifest,
  type SceneView,
  type VideoTextureInteraction,
  type RoomDefinition,
  type Vec2,
  type Vec3
} from "@walkthrough/scene-schema";

type StudioTab =
  | "overview"
  | "repair"
  | "import"
  | "optimization"
  | "publish"
  | "views"
  | "rooms"
  | "interactions"
  | "materials"
  | "variants"
  | "objects"
  | "controls"
  | "environment"
  | "bundle";
type Notice = "saved" | "copied" | "reset" | null;
type UploadState = "idle" | "uploading" | "done" | "error";
type PublishState = "idle" | "publishing" | "done" | "error";
type OptimizeState = "idle" | "optimizing" | "done" | "error";
type RepairState = "idle" | "repairing" | "done" | "error";
type BakeState = "idle" | "baking" | "done" | "error";
type ObjectListFilter = "all" | "ceiling" | "top-hidden" | "roles" | "hidden";
type MaterialListFilter = "all" | "suggested" | "untextured" | "plain-green" | "transparent" | "lightmaps";
type BakePreset = "draft" | "medium" | "high" | "super";
type LightmapBakeSettings = {
  preset: BakePreset;
  resolution: number;
  samples: number;
  margin: number;
  maxMaterials: number;
  denoise: boolean;
  mode: "lighting" | "combined";
};
type BakePreflightIssue = {
  severity: "error" | "warning";
  message: string;
};
type HotspotIcon = NonNullable<HotspotInteraction["icon"]>;
type SetupRequestInteraction = HotspotInteraction | LinkInteraction | ObjectToggleInteraction | VideoTextureInteraction;
type MovementToggle = "enabled" | "keyboard" | "clickToMove" | "dragLook";
type NavigationPaintShape = "rectangle" | "polygon";
type MaterialTextureField = "mapUrl" | "normalMapUrl" | "emissiveMapUrl" | "lightMapUrl";
type TextureSuggestionConfidence = "strong" | "review";

interface MaterialTextureCandidate {
  source: string;
  bytes: number;
  field: MaterialTextureField;
  score: number;
}

interface NavigationPolygonDraft {
  kind: NavigationZone["kind"];
  points: Vec2[];
}

const bakePresetDefaults: Record<BakePreset, { resolution: number; samples: number; margin: number }> = {
  draft: { resolution: 512, samples: 32, margin: 8 },
  medium: { resolution: 1024, samples: 96, margin: 16 },
  high: { resolution: 2048, samples: 192, margin: 24 },
  super: { resolution: 4096, samples: 384, margin: 32 }
};

const materialTextureAccept = ".avif,.jpg,.jpeg,.ktx2,.png,.webp,image/avif,image/jpeg,image/png,image/webp";
const materialTextureFields: readonly MaterialTextureField[] = ["mapUrl", "normalMapUrl", "emissiveMapUrl", "lightMapUrl"];
const materialTextureFieldLabels: Record<MaterialTextureField, string> = {
  mapUrl: "base texture",
  normalMapUrl: "normal map",
  emissiveMapUrl: "emissive map",
  lightMapUrl: "lightmap"
};
const highConfidenceTextureSuggestionScore = 28;

function normalizeTextureMatchName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferTextureField(source: string): MaterialTextureField {
  const normalized = normalizeTextureMatchName(source);
  if (/\b(lightmap|light map|bake|baked|shadow)\b/.test(normalized)) {
    return "lightMapUrl";
  }
  if (/\b(normal|nrm|bump)\b/.test(normalized)) {
    return "normalMapUrl";
  }
  if (/\b(emissive|emission|emit|glow|screen|display)\b/.test(normalized)) {
    return "emissiveMapUrl";
  }
  return "mapUrl";
}

const genericMaterialTextureTokens = new Set([
  "mat",
  "material",
  "materials",
  "texture",
  "textures",
  "map",
  "maps",
  "base",
  "basecolor",
  "color",
  "colour",
  "diffuse",
  "albedo",
  "image",
  "gltf",
  "embedded"
]);

const materialTextureSemanticGroups = [
  ["wood", "timber", "oak", "walnut", "veneer", "plywood"],
  ["brick", "stone", "concrete", "cement", "plaster", "stucco", "marble", "granite", "tile", "tiles"],
  ["grass", "lawn", "terrain", "ground", "soil", "garden"],
  ["glass", "window", "mirror", "glazing"],
  ["fabric", "cloth", "sofa", "cushion", "carpet", "rug", "curtain"],
  ["metal", "steel", "aluminium", "aluminum", "chrome", "iron"],
  ["wall", "paint", "wallpaper"],
  ["floor", "flooring", "parquet"],
  ["screen", "tv", "display", "emissive", "emission"]
];

function usefulTextureTokens(value: string): string[] {
  return normalizeTextureMatchName(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !genericMaterialTextureTokens.has(token));
}

function semanticTextureScore(materialTokens: string[], textureTokens: string[]): number {
  let score = 0;
  for (const group of materialTextureSemanticGroups) {
    const materialHit = group.some((token) => materialTokens.includes(token));
    const textureHit = group.some((token) => textureTokens.includes(token));
    if (materialHit && textureHit) {
      score += 10;
    }
  }
  return score;
}

function materialTextureCandidateScore(materialName: string, source: string): number {
  const material = normalizeTextureMatchName(materialName);
  const texture = normalizeTextureMatchName(source.split(/[\\/]/).pop() ?? source);
  const pathName = normalizeTextureMatchName(source);
  const materialTokens = usefulTextureTokens(materialName);
  const textureTokens = usefulTextureTokens(source);
  let score = 0;
  if (texture === material || pathName.endsWith(material)) {
    score += 40;
  }
  for (const token of materialTokens) {
    if (texture.includes(token)) {
      score += 8;
    } else if (pathName.includes(token)) {
      score += 3;
    }
  }
  score += semanticTextureScore(materialTokens, textureTokens);
  if (/\b(base|basecolor|color|diffuse|albedo|map|texture)\b/.test(texture)) {
    score += 4;
  }
  if (/\b(texture|textures|material|materials|maps)\b/.test(pathName)) {
    score += 2;
  }
  return score;
}

function looseTextureNameLooksGeneric(source: string): boolean {
  const fileName = source.split(/[\\/]/).pop() ?? source;
  const normalized = normalizeTextureMatchName(fileName);
  if (!normalized) {
    return true;
  }
  if (/^(gltf )?embedded \d+$/.test(normalized)) {
    return true;
  }
  if (/^(image|texture|material|map) \d+$/.test(normalized)) {
    return true;
  }
  return usefulTextureTokens(fileName).length === 0;
}

function materialAssignedTextureCount(material: MaterialOverride): number {
  return materialTextureFields.filter((field) => Boolean(material[field])).length;
}

function materialSearchText(material: MaterialOverride): string {
  return normalizeTextureMatchName(
    [
      material.name,
      material.baseColor,
      material.mapUrl,
      material.normalMapUrl,
      material.emissiveMapUrl,
      material.lightMapUrl
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function isLikelyPlainGreenMaterial(material: MaterialOverride): boolean {
  const assignedTextureCount = materialAssignedTextureCount(material);
  const normalizedName = normalizeTextureMatchName(material.name);
  const color = material.baseColor?.trim().toLowerCase() ?? "";
  const hex = /^#([0-9a-f]{6})$/.exec(color);
  const rgb = hex
    ? {
        r: Number.parseInt(hex[1]!.slice(0, 2), 16),
        g: Number.parseInt(hex[1]!.slice(2, 4), 16),
        b: Number.parseInt(hex[1]!.slice(4, 6), 16)
      }
    : null;
  const looksGreen =
    normalizedName.includes("green") ||
    normalizedName.includes("grass") ||
    normalizedName.includes("terrain") ||
    Boolean(rgb && rgb.g > 120 && rgb.g > rgb.r * 1.25 && rgb.g > rgb.b * 1.25);
  return assignedTextureCount === 0 && looksGreen;
}

function textureSuggestionConfidence(score: number): TextureSuggestionConfidence {
  return score >= highConfidenceTextureSuggestionScore ? "strong" : "review";
}

function textureSuggestionConfidenceLabel(score: number): string {
  return textureSuggestionConfidence(score) === "strong" ? "High confidence" : "Review";
}

function textureSuggestionConfidenceDetail(score: number): string {
  if (score >= highConfidenceTextureSuggestionScore) {
    return "Strong name/path match; safe for one-click apply";
  }
  if (score >= 20) {
    return "Some name overlap; inspect before applying";
  }
  return "Weak semantic match; review manually";
}

interface NavigationRepairDraft {
  reason: string;
  blockerName: string;
  objectName?: string;
  blockerKind?: "authored" | "named" | "inferred";
  action?: string;
  hint?: string;
  point?: Vec3;
  target?: Vec3;
  from?: Vec3;
  bodyRadius?: number;
}

type NavigationRepairAction = "pass" | "walk" | "ignore" | "tune";

interface NavigationRepairRecommendation {
  title: string;
  detail: string;
  primaryLabel: string;
  action: NavigationRepairAction;
  requiresPoint?: boolean;
  requiresBlocker?: boolean;
}

interface NavigationRepairDiagnosis {
  title: string;
  detail: string;
  checks: string[];
}

interface NavigationRepairPlanStep {
  badge: string;
  title: string;
  detail: string;
}

interface NavigationQaIssue {
  id: string;
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  action?: string;
}

interface NavigationCoverage {
  walkZones: number;
  passZones: number;
  blockZones: number;
  routeComponents: number;
  walkViews: number;
  coveredWalkViews: number;
}

type NavigationQuickFixAction =
  | "auto"
  | "bounds"
  | "bridge"
  | "fit-zone-bounds"
  | "paint-walk"
  | "paint-pass"
  | "view-walks"
  | "widen-pass"
  | "review-zones"
  | "test";

interface NavigationQuickFix {
  title: string;
  detail: string;
  button: string;
  action: NavigationQuickFixAction;
  targetZoneId?: string;
}

interface NavigationRepairPathStep {
  id: string;
  label: string;
  detail: string;
  status: "done" | "active" | "pending";
  quickFix: NavigationQuickFix | undefined;
}

interface MaterialsDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  materials: MaterialOverride[];
}

interface ObjectsDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  objects: ObjectOverride[];
}

interface BundleStats {
  generatedAt: string;
  viewCount: number;
  interactionCount: number;
  assetCount: number;
  missingAssetCount: number;
  totalBytes: number;
  modelBytes: number;
  videoBytes: number;
  triangleCount: number;
  meshCount: number;
  primitiveCount?: number;
  materialCount: number;
  sceneBoundsSize?: readonly [number, number, number];
  sceneLargestDimension?: number;
  sceneFootprintCenter?: readonly [number, number];
  sceneFootprintCenterDistance?: number;
  focusedBoundsSize?: readonly [number, number, number];
  focusedLargestDimension?: number;
  focusedFootprintCenter?: readonly [number, number];
  focusedFootprintCenterDistance?: number;
  modelOffset?: readonly [number, number, number];
  modelOffsetDistance?: number;
  texturedMaterialCount?: number;
  textureCount?: number;
  imageCount?: number;
  materialTextureImageCount?: number;
  unusedTextureImageCount?: number;
  lightmapMaterialCount?: number;
  secondaryUvLightmapMaterialCount?: number;
  lightmapAssetCount?: number;
  missingLightmapAssetCount?: number;
  tinyLightmapAssetCount?: number;
  lightmapAssetBytes?: number;
  embeddedImageCount?: number;
  maxTextureDimension?: number;
  oversizedTextureCount?: number;
  extremeAspectTextureCount?: number;
  estimatedTexturePixels?: number;
  estimatedTextureMemoryBytes?: number;
  textureMemoryImages?: readonly {
    source: string;
    width: number;
    height: number;
    estimatedBytes: number;
    bytes?: number;
  }[];
  looseImageCount?: number;
  compression?: {
    meshopt?: boolean;
    draco?: boolean;
    basisu?: boolean;
    webp?: boolean;
  };
  warnings: readonly {
    code: string;
    message: string;
  }[];
  diagnostics?: readonly {
    severity: "error" | "warning" | "info";
    code: string;
    title: string;
    message: string;
    action?: string;
  }[];
  publishReadiness?: {
    status: "ready" | "warning" | "blocked";
    blockers: readonly PublishReadinessIssue[];
    warnings: readonly PublishReadinessIssue[];
  };
  assets?: readonly {
    kind: string;
    source: string;
    label: string;
    exists: boolean;
    bytes?: number;
  }[];
  looseImages?: readonly {
    source: string;
    bytes: number;
  }[];
  lightmapAssets?: readonly {
    kind: string;
    source: string;
    label: string;
    exists: boolean;
    bytes?: number;
  }[];
  materialTextureSuggestionCount?: number;
  materialTextureSuggestions?: readonly {
    materialName: string;
    field: MaterialTextureField;
    source: string;
    score: number;
  }[];
  models?: readonly {
    format: string;
    embeddedImageCount?: number;
    unsupportedRequiredExtensions?: readonly string[];
    externalResourceCount?: number;
    missingExternalResourceCount?: number;
    externalResources?: readonly {
      kind: string;
      source: string;
      exists: boolean;
      bytes?: number;
      caseMismatch?: boolean;
      actualSource?: string;
      decodeFailed?: boolean;
      unsupportedMimeType?: string;
    }[];
    embeddedImages?: readonly {
      source: string;
      label: string;
      bytes: number;
      mimeType?: string;
      width?: number;
      height?: number;
      decodeFailed?: boolean;
      unsupportedMimeType?: string;
    }[];
    unsafeLocalResources?: readonly {
      kind: string;
      source: string;
      label?: string;
    }[];
  }[];
}

type MaterialTextureSuggestion = NonNullable<BundleStats["materialTextureSuggestions"]>[number];

interface PublishReadinessIssue {
  code: string;
  title: string;
  message: string;
  action?: string;
}

interface OptimizationDocument {
  schemaVersion: "0.1";
  generatedAt: string;
  source: string;
  profiles: readonly {
    id: string;
    label: string;
    status: "pass" | "warn";
    budgets: {
      maxTotalBytes: number;
      maxModelBytes: number;
      maxTriangles: number;
      maxDrawPrimitives?: number;
      maxTextureMemoryBytes?: number;
      maxMaterials: number;
      maxMeshes: number;
    };
    metrics: {
      totalBytes: number;
      modelBytes: number;
      triangles: number;
      drawPrimitives?: number;
      textureMemoryBytes?: number;
      materials: number;
      meshes: number;
    };
    warnings: readonly {
      code: string;
      message: string;
    }[];
  }[];
  texturePlans?: readonly {
    profileId: string;
    label: string;
    status: "ready" | "planned" | "needs-review";
    budgetBytes: number;
    currentBytes: number;
    estimatedAfterBytes: number;
    estimatedSavingsBytes: number;
    maxDimension: number;
    items: readonly {
      source: string;
      width: number;
      height: number;
      currentBytes: number;
      targetWidth: number;
      targetHeight: number;
      targetMaxDimension: number;
      estimatedBytesAfter: number;
      estimatedSavingsBytes: number;
      reason: string;
    }[];
  }[];
  recommendations: readonly {
    priority: "high" | "medium" | "low";
    action: string;
    reason: string;
  }[];
}

interface OptimizationJobDocument {
  schemaVersion: "0.1";
  id: string;
  status: "idle" | "completed" | "failed";
  profile: "mobile" | "balanced" | "desktop";
  applied: boolean;
  startedAt?: string;
  completedAt?: string;
  sourceSceneUrl?: string;
  optimizedSceneUrl?: string;
  before?: {
    modelBytes: number;
    textureImageBytes?: number;
    decodedTextureBytes?: number;
    textureCount?: number;
  };
  after?: {
    modelBytes: number;
    savedBytes: number;
    savedPercent: number;
    textureImageBytes?: number;
    decodedTextureBytes?: number;
    textureCount?: number;
    savedTextureImageBytes?: number;
    savedDecodedTextureBytes?: number;
  };
  steps: readonly {
    id: string;
    label: string;
    status: "completed" | "pending" | "failed" | "skipped" | "blocked";
    note?: string;
  }[];
}

interface OptimizationHistoryDocument {
  schemaVersion: "0.1";
  jobs: OptimizationJobDocument[];
}

interface LightmapBakeJobDocument {
  schemaVersion: "0.1";
  id: string;
  status: "idle" | "running" | "completed" | "blocked" | "failed";
  engine: string;
  bakeMode?: "lighting" | "combined";
  preset?: BakePreset;
  message?: string;
  outputSceneUrl?: string;
  lightmapCount?: number;
  totalLightmapBytes?: number;
  resolution?: number;
  samples?: number;
  margin?: number;
  maxMaterials?: number;
  denoise?: boolean;
  lightmaps?: readonly {
    materialName: string;
    url: string;
    resolution?: number;
    bytes?: number;
  }[];
  startedAt?: string;
  completedAt?: string;
  steps: readonly {
    id: string;
    label: string;
    status: "completed" | "pending" | "failed" | "skipped";
    note?: string;
  }[];
}

interface ConversionJobDocument {
  schemaVersion: "0.1";
  id: string;
  status: "idle" | "running" | "completed" | "blocked" | "failed";
  engine: string;
  source?: string;
  outputSceneUrl?: string;
  outputBytes?: number;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  steps: readonly {
    id: string;
    label: string;
    status: "completed" | "pending" | "failed" | "skipped" | "blocked";
    note?: string;
  }[];
}

interface ProjectSummary {
  id: string;
  title: string;
  clientName?: string;
  viewCount: number;
  triangleCount: number;
  updatedAt: string;
  publishCount?: number;
  lastPublishedAt?: string;
}

interface PublishEntry {
  version: string;
  publishedAt: string;
  scenePath: string;
  viewerUrl?: string;
  deploymentPath?: string;
  cdnBasePath?: string;
  assetCount?: number;
  totalBytes?: number;
  runtime?: PublishRuntimeSummary;
  qualityGate?: {
    status: "ready" | "warning" | "blocked";
    analyzedAt?: string;
    blockerCount?: number;
    warningCount?: number;
    diagnosticCount?: number;
    blockers?: readonly PublishReadinessIssue[];
    warnings?: readonly PublishReadinessIssue[];
  };
}

interface PublishRuntimeSummary {
  sceneUrl: string;
  originalSceneUrl: string;
  modelScale: number;
  modelOffset?: readonly [number, number, number];
  modelOffsetDistance?: number;
  toneMapping: string;
  exposure: number;
  doubleSidedMaterials: boolean;
  relightUnlitMaterials: boolean;
  viewCount: number;
  walkViewCount: number;
  topViewCount: number;
  interactionCount: number;
  roomCount: number;
  navigationZoneCount: number;
  focusedFootprintCenterDistance?: number;
}

interface PublishCheck {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
  blocking?: boolean;
  action?: ImportNextStepAction;
}

interface ClientDeliveryStep {
  id: string;
  label: string;
  detail: string;
  status: "ready" | "blocked" | "warning" | "active" | "todo";
  actionLabel: string;
}

interface PublishHandoffStep {
  id: "gate" | "draft" | "version" | "live" | "package";
  label: string;
  detail: string;
  status: ClientDeliveryStep["status"];
  actionLabel: string;
}

interface HostingHandoffStep {
  id: "validate" | "local" | "bucket" | "cache" | "domain";
  label: string;
  detail: string;
  status: ClientDeliveryStep["status"];
  actionLabel: string;
}

interface VideoSurfaceCandidate {
  id: string;
  meshName: string;
  materialName?: string;
  triangleCount: number;
  label: string;
  score: number;
  dimensions?: string;
}

interface InteractionHealthStep {
  id: string;
  label: string;
  detail: string;
  status: "ready" | "warning" | "active";
  action: string;
}

interface DoorPassCandidate {
  id: string;
  name: string;
  triangleCount: number;
  center: Vec3;
  size: Vec3;
  score: number;
}

interface PublishHistoryDocument {
  schemaVersion: "0.1";
  projectId: string;
  activeVersion?: string;
  activePublishedAt?: string;
  activatedAt?: string;
  activeDeliveryMode?: string;
  activatedAsDraft?: boolean;
  activeQualityGate?: PublishEntry["qualityGate"];
  liveScenePath?: string;
  liveViewerUrl?: string;
  versions: PublishEntry[];
}

interface ToolStatusDocument {
  tools: Record<
    string,
    {
      ready: boolean;
      command: string;
      purpose: string;
      action: string;
    }
  >;
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

const viewerBaseUrl = cleanBaseUrl(import.meta.env.VITE_VIEWER_URL ?? "http://127.0.0.1:5173");
const apiBaseUrl = cleanBaseUrl(import.meta.env.VITE_API_URL ?? "http://127.0.0.1:5175");
const studioTabIds: readonly StudioTab[] = [
  "overview",
  "repair",
  "import",
  "optimization",
  "publish",
  "views",
  "rooms",
  "interactions",
  "materials",
  "variants",
  "objects",
  "controls",
  "environment",
  "bundle"
];
const movementToggles: readonly { field: MovementToggle; label: string }[] = [
  { field: "enabled", label: "Movement" },
  { field: "keyboard", label: "WASD" },
  { field: "clickToMove", label: "Click to move" },
  { field: "dragLook", label: "Mouse drag look" }
];
const movementPresets: readonly {
  id: string;
  label: string;
  detail: string;
  movement: Partial<SceneControlsDocument["movement"]>;
}[] = [
  {
    id: "smooth-interior",
    label: "Smooth Interior",
    detail: "Slower glide, stronger tiny-bump ignore.",
    movement: {
      clickMoveSpeed: 1.05,
      wheelMoveSpeed: 1,
      collisionRadius: 0.26,
      maxStepUp: 0.38,
      maxStepDown: 0.72,
      floorHeightSmoothing: 0.9,
      floorBumpTolerance: 0.48
    }
  },
  {
    id: "ridge-safe",
    label: "Ridge Safe",
    detail: "Least bobbing on messy imported floors.",
    movement: {
      clickMoveSpeed: 0.92,
      wheelMoveSpeed: 0.82,
      collisionRadius: 0.28,
      maxStepUp: 0.3,
      maxStepDown: 0.68,
      floorHeightSmoothing: 0.75,
      floorBumpTolerance: 0.62
    }
  },
  {
    id: "steps",
    label: "Steps",
    detail: "More forgiving for thresholds and simple stairs.",
    movement: {
      clickMoveSpeed: 1.15,
      wheelMoveSpeed: 1,
      collisionRadius: 0.24,
      maxStepUp: 0.62,
      maxStepDown: 1.15,
      floorHeightSmoothing: 1.35,
      floorBumpTolerance: 0.24
    }
  },
  {
    id: "precise",
    label: "Precise",
    detail: "Stricter floor following for clean navmesh-style floors.",
    movement: {
      clickMoveSpeed: 1.25,
      wheelMoveSpeed: 0.85,
      collisionRadius: 0.32,
      maxStepUp: 0.28,
      maxStepDown: 0.55,
      floorHeightSmoothing: 2.15,
      floorBumpTolerance: 0.08
    }
  }
];

const movementComfortFields: readonly (keyof SceneControlsDocument["movement"])[] = [
  "clickMoveSpeed",
  "wheelMoveSpeed",
  "collisionRadius",
  "maxStepUp",
  "maxStepDown",
  "floorHeightSmoothing",
  "floorBumpTolerance"
];

function movementNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function closestMovementPreset(movement: SceneControlsDocument["movement"]): (typeof movementPresets)[number] {
  return movementPresets.reduce((best, preset) => {
    const score = movementComfortFields.reduce((total, field) => {
      const presetValue = preset.movement[field];
      if (typeof presetValue !== "number") {
        return total;
      }
      const currentValue = movementNumber(movement[field], presetValue);
      return total + Math.abs(currentValue - presetValue) / Math.max(0.1, Math.abs(presetValue));
    }, 0);
    return score < best.score ? { preset, score } : best;
  }, { preset: movementPresets[0]!, score: Number.POSITIVE_INFINITY }).preset;
}

function movementComfortStatus(
  controls: SceneControlsDocument | null,
  manifest: SceneManifest
): { label: string; tone: "ready" | "warning" | "blocked"; detail: string; lines: string[] } {
  if (!controls?.movement.enabled) {
    return {
      label: "Movement off",
      tone: "blocked",
      detail: "Movement is disabled, so WASD, wheel glide, and click-to-move cannot be tested.",
      lines: ["- Movement: off"]
    };
  }

  const movement = controls.movement;
  const preset = closestMovementPreset(movement);
  const clickGlide = movementNumber(movement.clickMoveSpeed, 1.05);
  const wheelGlide = movementNumber(movement.wheelMoveSpeed, 1);
  const bodyRadius = movementNumber(movement.collisionRadius, 0.28);
  const stepUp = movementNumber(movement.maxStepUp, 0.38);
  const stepDown = movementNumber(movement.maxStepDown, 0.72);
  const heightGlide = movementNumber(movement.floorHeightSmoothing, 0.9);
  const bumpIgnore = movementNumber(movement.floorBumpTolerance, 0.48);
  const cameraHeight = manifest.navigation.cameraHeight;
  const warnings = [
    bumpIgnore < 0.18
      ? "Floor Bump Ignore is strict, so tiny slabs, rug lips, or imported floor ridges may make the camera bob."
      : "",
    heightGlide > 1.8
      ? "Height Glide is high, so the camera follows floor height changes more tightly instead of smoothing them out."
      : "",
    stepUp > 0.55 && bumpIgnore < 0.3
      ? "Step Up is forgiving but bump ignore is low, so thresholds may still feel like small climbs."
      : "",
    bodyRadius > 0.34
      ? "Body Radius is wide, so narrow doors may block even when the floor looks clickable."
      : "",
    bodyRadius < 0.2
      ? "Body Radius is narrow, so users may clip closer to walls and furniture."
      : ""
  ].filter(Boolean);
  const tone = warnings.length > 0 ? "warning" : "ready";
  const detail =
    warnings.length > 0
      ? warnings[0]!
      : preset.id === "ridge-safe"
        ? "Ridge Safe-style settings are active for smoother imported floors."
        : "Movement comfort settings are in a reasonable range for viewer testing.";
  const lines = [
    `- Closest preset: ${preset.label}`,
    `- Camera height: ${cameraHeight.toFixed(2)}`,
    `- Click glide: ${clickGlide.toFixed(2)}`,
    `- Wheel glide: ${wheelGlide.toFixed(2)}`,
    `- Body radius: ${bodyRadius.toFixed(2)}`,
    `- Step up/down: ${stepUp.toFixed(2)} / ${stepDown.toFixed(2)}`,
    `- Height glide: ${heightGlide.toFixed(2)}`,
    `- Floor bump ignore: ${bumpIgnore.toFixed(2)}`,
    warnings.length > 0 ? `- Watch: ${warnings.join(" ")}` : "- Watch: no obvious comfort risk from movement settings."
  ];

  return { label: preset.label, tone, detail, lines };
}

function initialProjectId(): string {
  return new URLSearchParams(window.location.search).get("project") ?? "demo";
}

function initialStudioTab(): StudioTab {
  const tab = new URLSearchParams(window.location.search).get("tab");
  return studioTabIds.includes(tab as StudioTab) ? (tab as StudioTab) : "overview";
}

function parsePointParam(value: string | null): Vec3 | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [x, y, z] = parts as [number, number, number];
  return [x, y, z];
}

function initialNavigationRepairDraft(): NavigationRepairDraft | null {
  const params = new URLSearchParams(window.location.search);
  const blockerName = params.get("blocker") ?? "";
  const objectName = params.get("object") ?? "";
  const blockerKindParam = params.get("blockerKind");
  const blockerKind =
    blockerKindParam === "authored" || blockerKindParam === "named" || blockerKindParam === "inferred"
      ? blockerKindParam
      : undefined;
  const reason = params.get("reason") ?? "";
  const action = params.get("action") ?? "";
  const hint = params.get("hint") ?? "";
  const point = parsePointParam(params.get("point"));
  const target = parsePointParam(params.get("target"));
  const from = parsePointParam(params.get("from"));
  const bodyRadiusRaw = params.get("bodyRadius");
  const bodyRadiusParam = bodyRadiusRaw ? Number(bodyRadiusRaw) : Number.NaN;
  const bodyRadius = Number.isFinite(bodyRadiusParam) ? bodyRadiusParam : undefined;
  if (
    !blockerName &&
    !objectName &&
    !reason &&
    !action &&
    !hint &&
    !point &&
    !target &&
    !from &&
    bodyRadius === undefined
  ) {
    return null;
  }
  return {
    reason,
    blockerName,
    ...(objectName ? { objectName } : {}),
    ...(blockerKind ? { blockerKind } : {}),
    ...(action ? { action } : {}),
    ...(hint ? { hint } : {}),
    ...(point ? { point } : {}),
    ...(target ? { target } : {}),
    ...(from ? { from } : {}),
    ...(bodyRadius !== undefined ? { bodyRadius } : {})
  };
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updateVec3(value: Vec3, index: number, next: string): Vec3 {
  const draft = [...value] as [number, number, number];
  draft[index] = toNumber(next, value[index] ?? 0);
  return draft;
}

function isFiniteVec3(value: Vec3): boolean {
  return value.length === 3 && value.every((item) => Number.isFinite(item));
}

function vec3Summary(value: Vec3): string {
  return value.map((item) => item.toFixed(2)).join(", ");
}

function isValidInteractionUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) {
    return true;
  }
  return trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("#");
}

function isValidMediaSource(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return true;
  }
  if (/^(\/|\.\/|\.\.\/)/.test(trimmed)) {
    return /\.(mp4|mov|webm)([?#].*)?$/i.test(trimmed);
  }
  return /^media\/.+\.(mp4|mov|webm)([?#].*)?$/i.test(trimmed);
}

function parseKeywordList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function keywordList(value: readonly string[] | undefined): string {
  return (value ?? []).join(", ");
}

function zoneMapStyle(
  zone: NavigationZone,
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>
) {
  const width = Math.max(0.001, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(0.001, bounds.max[2] - bounds.min[2]);
  if (zone.polygon && zone.polygon.length >= 3) {
    const worldPoints = navigationZonePolygonWorldPoints(zone);
    const minX = Math.min(...worldPoints.map(([x]) => x));
    const maxX = Math.max(...worldPoints.map(([x]) => x));
    const minZ = Math.min(...worldPoints.map(([, z]) => z));
    const maxZ = Math.max(...worldPoints.map(([, z]) => z));
    const polygonWidth = Math.max(0.001, maxX - minX);
    const polygonDepth = Math.max(0.001, maxZ - minZ);
    const clipPath = `polygon(${worldPoints
      .map(([x, z]) => `${((x - minX) / polygonWidth) * 100}% ${100 - ((z - minZ) / polygonDepth) * 100}%`)
      .join(", ")})`;
    return {
      left: `${(((minX + maxX) / 2 - bounds.min[0]) / width) * 100}%`,
      top: `${100 - (((minZ + maxZ) / 2 - bounds.min[2]) / depth) * 100}%`,
      width: `${clampNumber((polygonWidth / width) * 100, 2, 100)}%`,
      height: `${clampNumber((polygonDepth / depth) * 100, 2, 100)}%`,
      transform: "translate(-50%, -50%)",
      clipPath
    };
  }
  return {
    left: `${((zone.center[0] - bounds.min[0]) / width) * 100}%`,
    top: `${100 - ((zone.center[2] - bounds.min[2]) / depth) * 100}%`,
    width: `${clampNumber((zone.size[0] / width) * 100, 2, 100)}%`,
    height: `${clampNumber((zone.size[2] / depth) * 100, 2, 100)}%`,
    transform: `translate(-50%, -50%) rotate(${zone.rotationY ?? 0}rad)`
  };
}

function navigationZoneOriginLabel(zone: NavigationZone): string | undefined {
  if (zone.source === "generated") {
    const generator = zone.generatedBy ? zone.generatedBy.replace(/-/g, " ") : "";
    return generator ? `Generated: ${generator}` : "Generated";
  }
  if (zone.source === "authored") {
    return "Authored";
  }
  return undefined;
}

function navigationZoneKindLabel(kind: NavigationZone["kind"]): string {
  if (kind === "walk") {
    return "Walk area";
  }
  if (kind === "pass") {
    return "Door pass";
  }
  return "Blocker";
}

function navigationZonePlainSummary(zone: NavigationZone): string {
  const width = zone.size[0].toFixed(2);
  const depth = zone.size[2].toFixed(2);
  const shape = zone.polygon && zone.polygon.length >= 3 ? `${zone.polygon.length}-point polygon` : "rectangle";
  if (zone.kind === "walk") {
    return `${shape}, ${width} x ${depth} m clickable floor patch`;
  }
  if (zone.kind === "pass") {
    return `${shape}, ${width} x ${depth} m doorway connector`;
  }
  return `${shape}, ${width} x ${depth} m hard boundary`;
}

function navigationZonePlainHelp(kind: NavigationZone["kind"]): string {
  if (kind === "walk") {
    return "People can stand and click-to-move inside this area.";
  }
  if (kind === "pass") {
    return "Use this to connect two walk areas through a door or opening.";
  }
  return "People cannot move through this area.";
}

function objectNavigationBehaviorLabel(behavior: ObjectOverride["navigationBehavior"] | undefined): string {
  if (behavior === "walk") {
    return "Walk";
  }
  if (behavior === "collision") {
    return "Collision";
  }
  if (behavior === "ignore") {
    return "Ignored";
  }
  return "Auto";
}

function objectNavigationBehaviorDetail(behavior: NonNullable<ObjectOverride["navigationBehavior"]>): {
  title: string;
  detail: string;
  action: string;
} {
  if (behavior === "walk") {
    return {
      title: "Walkable Floor",
      detail: "Use for real floors, patios, landings, or flat areas people can stand on.",
      action: "Let clicks land here"
    };
  }
  if (behavior === "collision") {
    return {
      title: "Wall / Blocker",
      detail: "Use for walls, columns, cabinets, closed doors, glass, or furniture that should stop movement.",
      action: "Stop movement here"
    };
  }
  if (behavior === "ignore") {
    return {
      title: "Ignore For Movement",
      detail: "Use for helper meshes, decor, transparent panels, or objects that accidentally block a doorway.",
      action: "Do not block or walk"
    };
  }
  return {
    title: "Auto Detection",
    detail: "Use the analyzer's default decision from object names, material hints, and generated navigation zones.",
    action: "Use detected role"
  };
}

function normalizedObjectMatchName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function objectMatchesBlockerName(object: ObjectOverride, blockerName: string): boolean {
  const objectName = normalizedObjectMatchName(object.name);
  const objectId = normalizedObjectMatchName(object.id);
  const blocker = normalizedObjectMatchName(blockerName);
  if (!objectName || !blocker) {
    return false;
  }
  if (objectName === blocker || objectId === blocker) {
    return true;
  }
  return (
    (objectName.length >= 4 && blocker.includes(objectName)) ||
    (blocker.length >= 4 && objectName.includes(blocker))
  );
}

function objectSearchText(node: SceneGraphNode, override?: ObjectOverride): string {
  return normalizedObjectMatchName(
    [node.name, node.meshName, node.materialIds.join(" "), override?.name, override?.navigationBehavior].filter(Boolean).join(" ")
  );
}

function isLikelyCeilingOrRoofObject(node: SceneGraphNode): boolean {
  const text = objectSearchText(node);
  return /\b(ceiling|false ceiling|dropped ceiling|roof|roofing|soffit|lid|cover)\b/.test(text);
}

function hasObjectNavigationRole(override: ObjectOverride | undefined): boolean {
  return Boolean(override?.navigationBehavior && override.navigationBehavior !== "default");
}

function navigationRepairRecommendation(draft: NavigationRepairDraft): NavigationRepairRecommendation {
  if (draft.reason === "route-not-found") {
    return {
      title: "Recommended fix: add a doorway connector",
      detail:
        "The clicked floor exists, but the route cannot cross from the current walk area to that spot. Add a green pass zone and a target walk patch if needed, then save and retry the click.",
      primaryLabel: "Add Door Pass",
      action: "pass",
      requiresPoint: true
    };
  }

  if (draft.reason === "outside-walk-zone" || draft.reason === "no-walkable-hit") {
    return {
      title: "Recommended fix: add clickable floor",
      detail:
        draft.objectName
          ? `${draft.objectName} was clicked, but the viewer could not confirm a trusted floor target there. Add a blue walk patch only if a person should stand at that location.`
          : "The clicked spot is not inside any walk area. Add a blue walk patch there if a person should be allowed to stand on that part of the model.",
      primaryLabel: "Add Walk Patch",
      action: "walk",
      requiresPoint: true
    };
  }

  if (draft.reason === "blocked-step") {
    return {
      title: "Recommended fix: tune stair movement",
      detail:
        "The clicked route crosses a height change bigger than the current step limits. Apply the Steps preset first for thresholds or simple stairs; add a walk patch only if the landing itself is missing.",
      primaryLabel: "Apply Steps Preset",
      action: "tune"
    };
  }

  if (draft.reason === "blocked-collision") {
    if (draft.blockerKind === "authored") {
      return {
        title: "Recommended fix: adjust the blocker",
        detail:
          "The viewer hit a blocker that was authored in Studio. Resize or split that block zone around the doorway, or delete it if it was added by mistake.",
        primaryLabel: "Add Door Pass",
        action: "pass",
        requiresPoint: true
      };
    }
    if (draft.blockerKind === "inferred" && draft.blockerName) {
      return {
        title: "Recommended fix: confirm the detected wall",
        detail:
          `The viewer inferred this object as a wall or partition. Add a door pass if it is a real opening; if the doorway is just narrow, try reducing Body Radius${draft.bodyRadius ? ` from ${draft.bodyRadius.toFixed(2)}` : ""}. Ignore the blocker only if the object is not meant to stop movement.`,
        primaryLabel: "Add Door Pass",
        action: "pass",
        requiresPoint: true
      };
    }
    if (draft.point) {
      return {
        title: "Recommended fix: add a doorway connector",
        detail:
          `Something is acting like a wall at the clicked point. If this is a door or opening, add a green pass zone first; if the opening is narrow, try lowering Body Radius${draft.bodyRadius ? ` from ${draft.bodyRadius.toFixed(2)}` : ""}. Studio will add a target walk patch if that side is missing one.`,
        primaryLabel: "Add Door Pass",
        action: "pass",
        requiresPoint: true
      };
    }
    return {
      title: "Recommended fix: ignore the false blocker",
      detail:
        "The viewer reported a blocker but no precise floor point. Ignore it only if this object is not actually supposed to stop movement.",
      primaryLabel: "Ignore Blocker",
      action: "ignore",
      requiresBlocker: true
    };
  }

  return {
    title: "Recommended fix: review the clicked point",
    detail:
      "This looks like a bounds or setup issue. Use the zone map first; if the point should be reachable, add a walk patch or pass zone near the highlighted point.",
    primaryLabel: draft.point ? "Add Walk Patch" : "Review Zones",
    action: draft.point ? "walk" : "pass",
    requiresPoint: true
  };
}

function navigationRepairDiagnosis(
  draft: NavigationRepairDraft,
  coverage: NavigationCoverage | null,
  hasMatchedBlocker: boolean,
  narrowBodyRepairRadius: number | null
): NavigationRepairDiagnosis {
  if (draft.reason === "route-not-found") {
    return {
      title: "Why this failed",
      detail:
        "The clicked floor looks valid, but the viewer could not find a connected walk path from the current area to that room.",
      checks: [
        coverage && coverage.routeComponents > 1
          ? `${coverage.routeComponents} separate route islands are active, so a doorway connector is probably missing.`
          : "The current walk areas do not prove a connected route through the doorway.",
        coverage && coverage.passZones > 0
          ? `${coverage.passZones} door pass zone(s) exist; expand or move one if it does not cross the opening.`
          : "No door pass zones exist yet, so separate rooms will stay disconnected.",
        draft.from && draft.target
          ? "The viewer sent both the current camera point and clicked target, so Studio can place the connector in the right direction."
          : "Use the map to place a pass across the physical opening, then save and retry."
      ]
    };
  }

  if (draft.reason === "outside-walk-zone" || draft.reason === "no-walkable-hit") {
    return {
      title: "Why this failed",
      detail:
        "The click did not land on a floor area that the viewer trusts for walking.",
      checks: [
        draft.objectName
          ? `Clicked object: ${draft.objectName}. If this is furniture, a cupboard, glass, or decor, leave it unwalkable.`
          : "The viewer did not receive a specific clicked object name for this failure.",
        "Add a walk patch only if a person should be allowed to stand there.",
        coverage && coverage.walkZones > 0
          ? `${coverage.walkZones} walk area(s) are already active; this click is outside them.`
          : "No authored walk areas are active yet."
      ]
    };
  }

  if (draft.reason === "blocked-step") {
    return {
      title: "Why this failed",
      detail:
        "The route crosses a height change larger than the current movement settings allow.",
      checks: [
        "Use the Steps preset for thresholds, landings, or simple stair transitions.",
        "If the model has tiny ridges or slab lips, keep the smooth-interior preset and draw cleaner walk patches.",
        "If this is furniture or a wall top, keep it blocked."
      ]
    };
  }

  if (draft.reason === "blocked-collision") {
    return {
      title: "Why this failed",
      detail:
        "The viewer found an object or block zone in the route before it could reach the clicked point.",
      checks: [
        hasMatchedBlocker
          ? "Studio matched the likely model object below, so choose whether it is a wall, walkable surface, or false blocker."
          : "No exact object match was found; use the clicked point and blocker name in Technical details if needed.",
        narrowBodyRepairRadius
          ? `The opening may be narrow; Body ${narrowBodyRepairRadius.toFixed(2)} is available as a quick test.`
          : "If this is a doorway, add a door pass through the opening before ignoring blockers.",
        draft.blockerKind === "authored"
          ? "The blocker came from a Studio zone, so resize or split that block zone around the opening."
          : "If the object is not actually a wall, mark it ignored from this card."
      ]
    };
  }

  return {
    title: "Why this failed",
    detail:
      "The viewer could not classify this click cleanly from the model data it received.",
    checks: [
      "Start by checking whether the clicked area should be walkable.",
      "If it should be reachable from another room, add a door pass through the opening.",
      "If the model geometry is unusual, inspect the object role and generated zones."
    ]
  };
}

function navigationRepairPlanSteps(
  draft: NavigationRepairDraft,
  recommendation: NavigationRepairRecommendation | null
): NavigationRepairPlanStep[] {
  let failureTitle = "The click needs review";
  let failureDetail = "Studio could not classify that movement cleanly from the viewer data.";

  if (draft.reason === "route-not-found") {
    failureTitle = "The room is not connected";
    failureDetail = "The target floor exists, but there is no trusted path through the doorway or opening yet.";
  } else if (draft.reason === "outside-walk-zone" || draft.reason === "no-walkable-hit") {
    failureTitle = draft.objectName ? `${draft.objectName} is not trusted floor` : "The click is outside trusted floor";
    failureDetail = draft.objectName
      ? "The user clicked an object or surface, but the viewer could not project it to a reachable floor area."
      : "The viewer does not currently treat that spot as a place where someone can stand.";
  } else if (draft.reason === "blocked-step") {
    failureTitle = "A height change stopped movement";
    failureDetail = "The route crosses a threshold, step, or ridge that is larger than the current movement limits.";
  } else if (draft.reason === "blocked-collision") {
    failureTitle = draft.blockerName ? `${draft.blockerName} is blocking the route` : "An object is blocking the route";
    failureDetail = "The viewer found wall-like geometry or a block zone before it could reach the clicked point.";
  } else if (draft.reason === "outside-bounds") {
    failureTitle = "The click is outside the allowed boundary";
    failureDetail = "The point is beyond the project's navigation bounds, so the viewer refuses to move there.";
  }

  return [
    {
      badge: "1",
      title: failureTitle,
      detail: failureDetail
    },
    {
      badge: "2",
      title: recommendation?.primaryLabel ?? "Apply a repair",
      detail: recommendation?.detail ?? "Use the recommended action or the zone map if this area should be reachable."
    },
    {
      badge: "3",
      title: "Save and retry",
      detail: "Save Changes, open the debug viewer, and repeat the same click to confirm the path now works."
    }
  ];
}

function navigationRepairActionLabel(action: string | undefined): string {
  if (action === "add-walk-zone") {
    return "Add walk patch";
  }
  if (action === "add-door-pass") {
    return "Add door pass";
  }
  if (action === "adjust-blocker") {
    return "Adjust blocker";
  }
  if (action === "tune-steps") {
    return "Tune step limits";
  }
  if (action === "inspect-click") {
    return "Inspect clicked area";
  }
  return "Review navigation";
}

function markNavigationZoneAuthored(zone: NavigationZone): NavigationZone {
  const { generatedBy: _generatedBy, ...rest } = zone;
  return {
    ...rest,
    source: "authored"
  };
}

function rectangularPolygonForZone(zone: NavigationZone): Vec2[] {
  const halfX = zone.size[0] / 2;
  const halfZ = zone.size[2] / 2;
  return [
    [-halfX, -halfZ],
    [halfX, -halfZ],
    [halfX, halfZ],
    [-halfX, halfZ]
  ];
}

function navigationZonePolygonWorldPoints(zone: NavigationZone): Array<[number, number]> {
  if (!zone.polygon || zone.polygon.length < 3) {
    return [];
  }
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return zone.polygon.map(([x, z]) => [
    zone.center[0] + x * cos - z * sin,
    zone.center[2] + x * sin + z * cos
  ]);
}

function snapPolygonPoint(point: Vec2, polygon: readonly Vec2[], pointIndex: number): Vec2 {
  const grid = 0.05;
  const snapDistance = 0.16;
  let snappedX = Number((Math.round(point[0] / grid) * grid).toFixed(3));
  let snappedZ = Number((Math.round(point[1] / grid) * grid).toFixed(3));
  const neighbors = [
    polygon[(pointIndex - 1 + polygon.length) % polygon.length],
    polygon[(pointIndex + 1) % polygon.length]
  ].filter((candidate): candidate is Vec2 => Boolean(candidate));
  for (const neighbor of neighbors) {
    if (Math.abs(snappedX - neighbor[0]) <= snapDistance) {
      snappedX = neighbor[0];
    }
    if (Math.abs(snappedZ - neighbor[1]) <= snapDistance) {
      snappedZ = neighbor[1];
    }
  }
  return [snappedX, snappedZ];
}

function roomCenter(room: RoomDefinition, views: readonly SceneView[]): Vec3 {
  const linkedView = views.find((view) => view.id === room.viewId);
  return room.center ?? linkedView?.position ?? [0, 0, 0];
}

function pointMapStyle(
  point: Vec3,
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>
) {
  const width = Math.max(0.001, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(0.001, bounds.max[2] - bounds.min[2]);
  return {
    left: `${((point[0] - bounds.min[0]) / width) * 100}%`,
    top: `${100 - ((point[2] - bounds.min[2]) / depth) * 100}%`
  };
}

function pointMapPercent(
  point: Vec3,
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>
) {
  const width = Math.max(0.001, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(0.001, bounds.max[2] - bounds.min[2]);
  return {
    left: ((point[0] - bounds.min[0]) / width) * 100,
    top: 100 - ((point[2] - bounds.min[2]) / depth) * 100
  };
}

function repairRouteLineStyle(
  from: Vec3,
  target: Vec3,
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>
) {
  const start = pointMapPercent(from, bounds);
  const end = pointMapPercent(target, bounds);
  const dx = end.left - start.left;
  const dy = end.top - start.top;
  return {
    left: `${start.left}%`,
    top: `${start.top}%`,
    width: `${Math.hypot(dx, dy)}%`,
    transform: `rotate(${Math.atan2(dy, dx)}rad)`
  };
}

function roomBoundsMapStyle(
  roomBounds: NonNullable<RoomDefinition["bounds"]>,
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>
) {
  const width = Math.max(0.001, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(0.001, bounds.max[2] - bounds.min[2]);
  return {
    left: `${((roomBounds.min[0] - bounds.min[0]) / width) * 100}%`,
    top: `${100 - ((roomBounds.max[2] - bounds.min[2]) / depth) * 100}%`,
    width: `${clampNumber(((roomBounds.max[0] - roomBounds.min[0]) / width) * 100, 2, 100)}%`,
    height: `${clampNumber(((roomBounds.max[2] - roomBounds.min[2]) / depth) * 100, 2, 100)}%`
  };
}

function enabledNavigationZones(navigation: SceneManifest["navigation"], kind?: NavigationZone["kind"]) {
  return (navigation.zones ?? []).filter((zone) => zone.enabled !== false && (!kind || zone.kind === kind));
}

function pointInNavigationBounds(
  point: Vec3,
  bounds: SceneManifest["navigation"]["bounds"] | undefined,
  padding = 0
): boolean {
  if (!bounds) {
    return true;
  }
  return (
    point[0] >= bounds.min[0] - padding &&
    point[0] <= bounds.max[0] + padding &&
    point[1] >= bounds.min[1] - padding &&
    point[1] <= bounds.max[1] + padding &&
    point[2] >= bounds.min[2] - padding &&
    point[2] <= bounds.max[2] + padding
  );
}

function pointInNavigationZone(zone: NavigationZone, point: Vec3, padding = 0): boolean {
  const rotation = -(zone.rotationY ?? 0);
  const dx = point[0] - zone.center[0];
  const dz = point[2] - zone.center[2];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  if (zone.polygon && zone.polygon.length >= 3) {
    return (
      Math.abs(point[1] - zone.center[1]) <= zone.size[1] / 2 + padding &&
      pointInPolygon2D([localX, localZ], zone.polygon, padding)
    );
  }
  return (
    Math.abs(localX) <= zone.size[0] / 2 + padding &&
    Math.abs(point[1] - zone.center[1]) <= zone.size[1] / 2 + padding &&
    Math.abs(localZ) <= zone.size[2] / 2 + padding
  );
}

function navigationZoneAabb(zone: NavigationZone) {
  const halfX = zone.size[0] / 2;
  const halfZ = zone.size[2] / 2;
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localCorners: readonly Vec2[] =
    zone.polygon && zone.polygon.length >= 3
      ? zone.polygon
      : [
          [-halfX, -halfZ],
          [halfX, -halfZ],
          [halfX, halfZ],
          [-halfX, halfZ]
        ];
  const corners: Array<[number, number]> = localCorners.map(([x, z]) => [
    zone.center[0] + x * cos - z * sin,
    zone.center[2] + x * sin + z * cos
  ]);
  return {
    minX: Math.min(...corners.map(([x]) => x)),
    maxX: Math.max(...corners.map(([x]) => x)),
    minZ: Math.min(...corners.map(([, z]) => z)),
    maxZ: Math.max(...corners.map(([, z]) => z))
  };
}

function navigationZoneFootprint(zone: NavigationZone): Vec2[] {
  const halfX = zone.size[0] / 2;
  const halfZ = zone.size[2] / 2;
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localCorners =
    zone.polygon && zone.polygon.length >= 3
      ? zone.polygon
      : [
          [-halfX, -halfZ],
          [halfX, -halfZ],
          [halfX, halfZ],
          [-halfX, halfZ]
        ];
  return localCorners.map(([x, z]) => [
    zone.center[0] + x * cos - z * sin,
    zone.center[2] + x * sin + z * cos
  ]);
}

function navigationZoneNarrowestSpan(zone: NavigationZone): number {
  if (zone.polygon && zone.polygon.length >= 3) {
    const xs = zone.polygon.map(([x]) => x);
    const zs = zone.polygon.map(([, z]) => z);
    return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  }
  return Math.min(Math.abs(zone.size[0]), Math.abs(zone.size[2]));
}

function widenNavigationPassZone(zone: NavigationZone, requiredSpan: number): NavigationZone {
  const nextSize: Vec3 = [
    Math.max(zone.size[0], requiredSpan),
    zone.size[1],
    Math.max(zone.size[2], requiredSpan)
  ];
  if (!zone.polygon || zone.polygon.length < 3) {
    return {
      ...zone,
      size: nextSize
    };
  }
  const xs = zone.polygon.map(([x]) => x);
  const zs = zone.polygon.map(([, z]) => z);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const zSpan = Math.max(...zs) - Math.min(...zs);
  if (xSpan >= requiredSpan && zSpan >= requiredSpan) {
    return {
      ...zone,
      size: nextSize
    };
  }
  const centroidSum = zone.polygon.reduce<Vec2>(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
    [0, 0]
  );
  const centroid: Vec2 = [
    centroidSum[0] / zone.polygon.length,
    centroidSum[1] / zone.polygon.length
  ];
  const scaleX = xSpan > 0 && xSpan <= zSpan ? requiredSpan / xSpan : 1;
  const scaleZ = zSpan > 0 && zSpan < xSpan ? requiredSpan / zSpan : 1;
  return {
    ...zone,
    size: nextSize,
    polygon: zone.polygon.map(([x, z]) => [
      Number((centroid[0] + (x - centroid[0]) * scaleX).toFixed(3)),
      Number((centroid[1] + (z - centroid[1]) * scaleZ).toFixed(3))
    ])
  };
}

function navigationZonesOverlap(a: NavigationZone, b: NavigationZone, padding = 0.2): boolean {
  const boxA = navigationZoneAabb(a);
  const boxB = navigationZoneAabb(b);
  const boundsMayTouch =
    boxA.minX - padding <= boxB.maxX &&
    boxA.maxX + padding >= boxB.minX &&
    boxA.minZ - padding <= boxB.maxZ &&
    boxA.maxZ + padding >= boxB.minZ;
  if (!boundsMayTouch) {
    return false;
  }
  return polygonDistance2D(navigationZoneFootprint(a), navigationZoneFootprint(b)) <= padding;
}

function navigationZonesConnect(a: NavigationZone, b: NavigationZone, bodyRadius = 0.28): boolean {
  return navigationZonesOverlap(a, b, navigationZoneConnectionPadding(a.kind, b.kind, bodyRadius));
}

function navigationZoneOutsideBounds(
  zone: NavigationZone,
  bounds: SceneManifest["navigation"]["bounds"] | undefined,
  padding = 0.05
): boolean {
  if (!bounds) {
    return false;
  }
  const box = navigationZoneAabb(zone);
  return (
    box.minX < bounds.min[0] - padding ||
    box.maxX > bounds.max[0] + padding ||
    box.minZ < bounds.min[2] - padding ||
    box.maxZ > bounds.max[2] + padding ||
    zone.center[1] < bounds.min[1] - Math.max(0.25, zone.size[1]) ||
    zone.center[1] > bounds.max[1] + Math.max(0.25, zone.size[1])
  );
}

function navigationComponents(zones: readonly NavigationZone[], bodyRadius = 0.28): NavigationZone[][] {
  if (zones.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const components: NavigationZone[][] = [];
  for (const zone of zones) {
    if (seen.has(zone.id)) {
      continue;
    }
    const component: NavigationZone[] = [];
    const queue = [zone];
    seen.add(zone.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const candidate of zones) {
        if (!seen.has(candidate.id) && navigationZonesConnect(current, candidate, bodyRadius)) {
          seen.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function navigationZoneDisplayName(zone: NavigationZone): string {
  return zone.label?.trim() || zone.id || "Unnamed zone";
}

function navigationComponentSummary(
  components: readonly NavigationZone[][],
  maxComponents = 3,
  maxZonesPerComponent = 3
): string {
  return [...components]
    .sort((a, b) => b.length - a.length)
    .slice(0, maxComponents)
    .map((component, index) => {
      const zoneNames = component
        .slice(0, maxZonesPerComponent)
        .map(navigationZoneDisplayName)
        .join(", ");
      const hiddenCount = Math.max(0, component.length - maxZonesPerComponent);
      const suffix = hiddenCount > 0 ? ` +${hiddenCount} more` : "";
      const zoneCount = `${component.length} zone${component.length === 1 ? "" : "s"}`;
      return `island ${index + 1}: ${zoneCount}${zoneNames ? ` (${zoneNames}${suffix})` : ""}`;
    })
    .join("; ");
}

function countNavigationComponents(zones: readonly NavigationZone[]): number {
  return navigationComponents(zones).length;
}

function zoneBridgeGap(a: NavigationZone, b: NavigationZone): number {
  const footprintDistance = polygonDistance2D(navigationZoneFootprint(a), navigationZoneFootprint(b));
  if (Number.isFinite(footprintDistance)) {
    return footprintDistance;
  }
  const boxA = navigationZoneAabb(a);
  const boxB = navigationZoneAabb(b);
  const xGap = boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
  const zGap = boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;
  return Math.hypot(xGap, zGap);
}

function zoneBoxDistanceToPoint(zone: NavigationZone, point: Vec3): number {
  const footprint = navigationZoneFootprint(zone);
  if (footprint.length >= 3) {
    return pointToPolygonDistance2D([point[0], point[2]], footprint);
  }
  const box = navigationZoneAabb(zone);
  const dx = point[0] < box.minX ? box.minX - point[0] : point[0] > box.maxX ? point[0] - box.maxX : 0;
  const dz = point[2] < box.minZ ? box.minZ - point[2] : point[2] > box.maxZ ? point[2] - box.maxZ : 0;
  return Math.hypot(dx, dz);
}

function expandDoorPassToWalkZones(
  passZone: NavigationZone,
  walkZones: readonly NavigationZone[],
  cameraHeight: number
): NavigationZone {
  if (walkZones.length < 2) {
    return passZone;
  }
  const nearby = walkZones
    .map((zone) => ({ zone, distance: zoneBoxDistanceToPoint(zone, passZone.center) }))
    .filter((entry) => entry.distance <= Math.max(1.8, cameraHeight * 1.65))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .map((entry) => entry.zone);
  if (nearby.length < 2) {
    return passZone;
  }

  let bestBridge:
    | {
        boxA: ReturnType<typeof navigationZoneAabb>;
        boxB: ReturnType<typeof navigationZoneAabb>;
        xGap: number;
        zGap: number;
        xOverlap: number;
        zOverlap: number;
        score: number;
      }
    | undefined;
  for (let aIndex = 0; aIndex < nearby.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < nearby.length; bIndex += 1) {
      const boxA = navigationZoneAabb(nearby[aIndex]!);
      const boxB = navigationZoneAabb(nearby[bIndex]!);
      const xGap = boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
      const zGap = boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;
      const xOverlap = Math.max(0, Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX));
      const zOverlap = Math.max(0, Math.min(boxA.maxZ, boxB.maxZ) - Math.max(boxA.minZ, boxB.minZ));
      const score = Math.min(xGap || 0, zGap || 0) - Math.max(xOverlap, zOverlap) * 0.15;
      if (!bestBridge || score < bestBridge.score) {
        bestBridge = { boxA, boxB, xGap, zGap, xOverlap, zOverlap, score };
      }
    }
  }
  if (!bestBridge || Math.max(bestBridge.xGap, bestBridge.zGap) > Math.max(2.6, cameraHeight * 1.7)) {
    return passZone;
  }

  if (bestBridge.xGap > 0 && bestBridge.zOverlap >= 0.25) {
    const left = bestBridge.boxA.maxX < bestBridge.boxB.minX ? bestBridge.boxA : bestBridge.boxB;
    const right = left === bestBridge.boxA ? bestBridge.boxB : bestBridge.boxA;
    const overlapMin = Math.max(bestBridge.boxA.minZ, bestBridge.boxB.minZ);
    const overlapMax = Math.min(bestBridge.boxA.maxZ, bestBridge.boxB.maxZ);
    return {
      ...passZone,
      center: [
        Number(((left.maxX + right.minX) / 2).toFixed(3)),
        Number(Math.max(0.8, cameraHeight * 0.55).toFixed(3)),
        Number(clampNumber(passZone.center[2], overlapMin, overlapMax).toFixed(3))
      ],
      size: [
        Number(Math.min(3.4, Math.max(passZone.size[0], bestBridge.xGap + 0.9)).toFixed(3)),
        Number(Math.max(1.8, cameraHeight + 0.65).toFixed(3)),
        Number(Math.min(2.4, Math.max(passZone.size[2], bestBridge.zOverlap + 0.45)).toFixed(3))
      ]
    };
  }

  if (bestBridge.zGap > 0 && bestBridge.xOverlap >= 0.25) {
    const near = bestBridge.boxA.maxZ < bestBridge.boxB.minZ ? bestBridge.boxA : bestBridge.boxB;
    const far = near === bestBridge.boxA ? bestBridge.boxB : bestBridge.boxA;
    const overlapMin = Math.max(bestBridge.boxA.minX, bestBridge.boxB.minX);
    const overlapMax = Math.min(bestBridge.boxA.maxX, bestBridge.boxB.maxX);
    return {
      ...passZone,
      center: [
        Number(clampNumber(passZone.center[0], overlapMin, overlapMax).toFixed(3)),
        Number(Math.max(0.8, cameraHeight * 0.55).toFixed(3)),
        Number(((near.maxZ + far.minZ) / 2).toFixed(3))
      ],
      size: [
        Number(Math.min(2.4, Math.max(passZone.size[0], bestBridge.xOverlap + 0.45)).toFixed(3)),
        Number(Math.max(1.8, cameraHeight + 0.65).toFixed(3)),
        Number(Math.min(3.4, Math.max(passZone.size[2], bestBridge.zGap + 0.9)).toFixed(3))
      ]
    };
  }

  return passZone;
}

function nearestNavigationComponentBridge(
  connectedZones: readonly NavigationZone[],
  component: readonly NavigationZone[]
): { from: NavigationZone; to: NavigationZone; gap: number } | null {
  let nearest: { from: NavigationZone; to: NavigationZone; gap: number } | null = null;
  connectedZones.forEach((from) => {
    component.forEach((to) => {
      const gap = zoneBridgeGap(from, to);
      if (!nearest || gap < nearest.gap) {
        nearest = { from, to, gap };
      }
    });
  });
  return nearest;
}

function createBridgePassZone(
  from: NavigationZone,
  to: NavigationZone,
  index: number,
  cameraHeight: number
): NavigationZone {
  const boxA = navigationZoneAabb(from);
  const boxB = navigationZoneAabb(to);
  const xGap = boxA.maxX < boxB.minX ? boxB.minX - boxA.maxX : boxB.maxX < boxA.minX ? boxA.minX - boxB.maxX : 0;
  const zGap = boxA.maxZ < boxB.minZ ? boxB.minZ - boxA.maxZ : boxB.maxZ < boxA.minZ ? boxA.minZ - boxB.maxZ : 0;
  const xOverlap = Math.max(0, Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX));
  const zOverlap = Math.max(0, Math.min(boxA.maxZ, boxB.maxZ) - Math.max(boxA.minZ, boxB.minZ));
  const center: Vec3 = [
    Number(((from.center[0] + to.center[0]) / 2).toFixed(3)),
    Number(Math.max(0.8, cameraHeight * 0.55).toFixed(3)),
    Number(((from.center[2] + to.center[2]) / 2).toFixed(3))
  ];

  const horizontalSize = Math.min(3.2, Math.max(1, xGap + 0.85));
  const depthSize = Math.min(3.2, Math.max(1, zGap + 0.85));
  const overlapWidth = Math.min(2.4, Math.max(1, xOverlap || 1.2));
  const overlapDepth = Math.min(2.4, Math.max(1, zOverlap || 1.2));
  const size: Vec3 =
    xGap >= zGap
      ? [horizontalSize, Math.max(1.8, cameraHeight + 0.65), overlapDepth]
      : [overlapWidth, Math.max(1.8, cameraHeight + 0.65), depthSize];

  return {
    id: `pass-bridge-${index}`,
    label: `Bridge pass ${index}`,
    kind: "pass",
    center,
    size,
    rotationY: 0,
    enabled: true
  };
}

function expandedOneSidedPassZone(
  passZone: NavigationZone,
  walkZones: readonly NavigationZone[],
  cameraHeight: number
): NavigationZone | undefined {
  const touchingWalkZones = walkZones.filter((walkZone) => navigationZonesOverlap(passZone, walkZone));
  if (touchingWalkZones.length !== 1 || walkZones.length < 2) {
    return undefined;
  }
  const nearestTarget = walkZones
    .filter((walkZone) => walkZone.id !== touchingWalkZones[0]!.id)
    .map((walkZone) => ({ walkZone, gap: zoneBridgeGap(passZone, walkZone) }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (!nearestTarget || nearestTarget.gap > Math.max(2.8, cameraHeight * 1.65)) {
    return undefined;
  }
  const bridge = createBridgePassZone(touchingWalkZones[0]!, nearestTarget.walkZone, 0, cameraHeight);
  const expanded: NavigationZone = {
    ...bridge,
    id: passZone.id,
    label: passZone.label || bridge.label
  };
  if (passZone.source) {
    expanded.source = passZone.source;
  }
  if (passZone.generatedBy) {
    expanded.generatedBy = passZone.generatedBy;
  }
  return expanded;
}

function createDoorPassZoneFromCandidate(
  candidate: DoorPassCandidate,
  id: string,
  source: NonNullable<NavigationZone["source"]>
): NavigationZone {
  return {
    id,
    label: `Pass ${candidate.name}`.slice(0, 80),
    kind: "pass",
    center: candidate.center,
    size: candidate.size,
    rotationY: 0,
    enabled: true,
    source,
    ...(source === "generated" ? { generatedBy: "door-detection" } : {})
  };
}

function navigationQaIssues(manifest: SceneManifest, bodyRadius = 0.28): NavigationQaIssue[] {
  const issues: NavigationQaIssue[] = [];
  const navigation = manifest.navigation;
  const walkZones = enabledNavigationZones(navigation, "walk");
  const passZones = enabledNavigationZones(navigation, "pass");
  const blockZones = enabledNavigationZones(navigation, "block");
  const routeZones = [...walkZones, ...passZones];

  if (!navigation.bounds) {
    issues.push({
      id: "missing-bounds",
      severity: "warning",
      title: "Navigation bounds are not set",
      detail: "Users can drift into empty exterior space unless bounds or boundary blocks constrain movement.",
      action: "Use graph bounds, then add boundary block zones around the model."
    });
  }

  if (walkZones.length === 0) {
    issues.push({
      id: "missing-walk-zones",
      severity: "warning",
      title: "No explicit walk zones",
      detail: "Click-to-move will fall back to detected floor meshes, which can include roofs, counters, or exterior planes.",
      action: "Add walk zones for the real floor areas users should be allowed to stand on."
    });
  }

  if (walkZones.length > 1 && passZones.length === 0) {
    issues.push({
      id: "missing-pass-zones",
      severity: "warning",
      title: "Multiple walk zones without door passes",
      detail: "Separate rooms may behave like separate islands, so clicking through a doorway can stop at the threshold.",
      action: "Add pass zones at doorways/openings between room walk zones."
    });
  }

  const routeComponents = navigationComponents(routeZones, bodyRadius);
  if (routeComponents.length > 1) {
    const islandSummary = navigationComponentSummary(routeComponents);
    issues.push({
      id: "disconnected-route-zones",
      severity: "warning",
      title: "Walkable areas are disconnected",
      detail: `${routeComponents.length} separate navigation islands were detected across walk/pass zones${
        islandSummary ? `: ${islandSummary}.` : "."
      }`,
      action: "Add or resize pass zones until connected rooms touch through doorways."
    });
  }

  passZones.forEach((zone) => {
    const touchingWalkZones = walkZones.filter((walkZone) => navigationZonesConnect(zone, walkZone, bodyRadius));
    const touchingBlockZones = blockZones.filter((blockZone) => navigationZonesOverlap(zone, blockZone, 0.05));
    const narrowestSpan = navigationZoneNarrowestSpan(zone);
    const requiredSpan = Math.max(0.42, bodyRadius * 2);
    if (narrowestSpan < requiredSpan) {
      issues.push({
        id: `narrow-pass-${zone.id}`,
        severity: "warning",
        title: `Door pass may be too narrow: ${zone.label}`,
        detail: `This pass is ${narrowestSpan.toFixed(2)}m wide, below the ${requiredSpan.toFixed(2)}m body clearance needed for the current Body Radius.`,
        action: "Widen the pass zone or reduce Body Radius before relying on this doorway."
      });
    }
    if (touchingWalkZones.length === 0) {
      issues.push({
        id: `orphan-pass-${zone.id}`,
        severity: "warning",
        title: `Pass zone is isolated: ${zone.label}`,
        detail: "This doorway pass does not overlap any walk zone, so pathfinding cannot use it.",
        action: "Move or resize the pass zone so it overlaps the room floor walk zones on both sides."
      });
    } else if (walkZones.length > 1 && touchingWalkZones.length === 1) {
      issues.push({
        id: `one-sided-pass-${zone.id}`,
        severity: "warning",
        title: `Pass zone reaches only one room: ${zone.label}`,
        detail: "This doorway pass overlaps one walk area but does not reach a second walk area.",
        action: "Extend the pass through the doorway, or add a walk patch inside the target room."
      });
    }
    if (touchingBlockZones.length > 0) {
      const blockerNames = touchingBlockZones
        .slice(0, 3)
        .map((blockZone) => blockZone.label || blockZone.id)
        .join(", ");
      issues.push({
        id: `blocked-pass-${zone.id}`,
        severity: "warning",
        title: `Pass zone crosses a blocker: ${zone.label}`,
        detail: `This doorway pass overlaps ${blockerNames || "a block zone"}, so routing may still stop at the opening even though the pass exists.`,
        action: "Split, shrink, or move the block zone around the doorway pass so the green connector can create a real opening."
      });
    }
  });

  walkZones.forEach((zone) => {
    const touchingBlockZones = blockZones.filter((blockZone) => navigationZonesOverlap(zone, blockZone, 0.05));
    if (touchingBlockZones.length > 0) {
      const blockerNames = touchingBlockZones
        .slice(0, 3)
        .map((blockZone) => blockZone.label || blockZone.id)
        .join(", ");
      issues.push({
        id: `blocked-walk-${zone.id}`,
        severity: "warning",
        title: `Walk zone overlaps a blocker: ${zone.label}`,
        detail: `This walk area overlaps ${blockerNames || "a block zone"}, so users may see clickable floor that still refuses movement.`,
        action: "Shrink or split the blocker around the room floor, or trim the walk area away from blocked geometry."
      });
    }
  });

  walkZones
    .filter((zone) => navigationZoneOutsideBounds(zone, navigation.bounds))
    .forEach((zone) => {
      issues.push({
        id: `walk-zone-bounds-${zone.id}`,
        severity: "warning",
        title: `Walk zone extends outside bounds: ${zone.label}`,
        detail: "The viewer enforces movement bounds before walk zones, so this floor area may look reachable but still refuse movement.",
        action: "Expand navigation bounds or trim the walk zone until all reachable floor area sits inside bounds."
      });
    });

  passZones
    .filter((zone) => navigationZoneOutsideBounds(zone, navigation.bounds))
    .forEach((zone) => {
      issues.push({
        id: `pass-zone-bounds-${zone.id}`,
        severity: "warning",
        title: `Pass zone extends outside bounds: ${zone.label}`,
        detail: "Door routing can stop at the movement boundary if the pass connector crosses outside the allowed area.",
        action: "Expand navigation bounds or move this pass fully inside bounds."
      });
    });

  manifest.views
    .filter((view) => view.kind === "walk")
    .forEach((view) => {
      if (!pointInNavigationBounds(view.position, navigation.bounds, 0.1)) {
        issues.push({
          id: `view-bounds-${view.id}`,
          severity: "error",
          title: `View starts outside bounds: ${view.label}`,
          detail: `Position ${view.position.map((value) => value.toFixed(2)).join(", ")} is outside navigation bounds.`,
          action: "Move the view inside the model or expand the navigation bounds."
        });
      }
      if (blockZones.some((zone) => pointInNavigationZone(zone, view.position, 0.15))) {
        issues.push({
          id: `view-blocked-${view.id}`,
          severity: "warning",
          title: `View starts inside a block zone: ${view.label}`,
          detail: "Users may start clipped into a boundary or wall blocker.",
          action: "Move the view, reduce the block zone, or split the block around the doorway."
        });
      }
      if (walkZones.length > 0 && !routeZones.some((zone) => pointInNavigationZone(zone, view.position, 0.25))) {
        issues.push({
          id: `view-walk-zone-${view.id}`,
          severity: "warning",
          title: `View is outside walkable zones: ${view.label}`,
          detail: "The camera can load there, but click routing may not be able to continue into connected rooms.",
          action: "Add a walk patch around this view or move the view into a walk zone."
        });
      }
    });

  if (issues.length === 0) {
    issues.push({
      id: "navigation-ready",
      severity: "info",
      title: "Navigation setup has no obvious zone issues",
      detail: "Bounds, walk zones, pass zones, and starting views look coherent from the Studio-side checks."
    });
  }

  return issues;
}

function navigationCoverage(manifest: SceneManifest): NavigationCoverage {
  const navigation = manifest.navigation;
  const walkZones = enabledNavigationZones(navigation, "walk");
  const passZones = enabledNavigationZones(navigation, "pass");
  const blockZones = enabledNavigationZones(navigation, "block");
  const routeZones = [...walkZones, ...passZones];
  const walkViews = manifest.views.filter((view) => view.kind === "walk");
  const coveredWalkViews = walkViews.filter((view) =>
    routeZones.some((zone) => pointInNavigationZone(zone, view.position, 0.25))
  );
  return {
    walkZones: walkZones.length,
    passZones: passZones.length,
    blockZones: blockZones.length,
    routeComponents: countNavigationComponents(routeZones),
    walkViews: walkViews.length,
    coveredWalkViews: coveredWalkViews.length
  };
}

function navigationQuickFixForIssue(issue: NavigationQaIssue | undefined): NavigationQuickFix {
  if (!issue || issue.severity === "info") {
    return {
      title: "Navigation is ready to test",
      detail: "Open the viewer and check walking, click movement, doors, and room buttons.",
      button: "Test Viewer",
      action: "test"
    };
  }
  if (issue.id === "missing-bounds" || issue.id.startsWith("view-bounds-")) {
    return {
      title: "Set movement boundary",
      detail: "Use the detected model bounds so users cannot drift into empty exterior space.",
      button: "Use Bounds",
      action: "bounds"
    };
  }
  if (issue.id.startsWith("walk-zone-bounds-") || issue.id.startsWith("pass-zone-bounds-")) {
    return {
      title: "Expand movement boundary",
      detail: "Grow the movement bounds to include authored walk and door-pass zones that currently sit outside the allowed area.",
      button: "Fit Bounds",
      action: "fit-zone-bounds"
    };
  }
  if (issue.id === "missing-walk-zones" || issue.id.startsWith("view-walk-zone-")) {
    return {
      title: "Draw clickable floor",
      detail: "Add a blue walk area over the floor where a person should be allowed to stand.",
      button: "Draw Walk Area",
      action: "paint-walk"
    };
  }
  if (
    issue.id.startsWith("narrow-pass-")
  ) {
    return {
      title: "Widen narrow door passes",
      detail: "Expand existing green pass zones so the current camera body can fit through the doorway.",
      button: "Widen Passes",
      action: "widen-pass"
    };
  }
  if (issue.id === "disconnected-route-zones") {
    return {
      title: "Bridge nearby walk islands",
      detail: "Try adding green connector passes between close walk areas before drawing doorway passes manually.",
      button: "Auto Bridge",
      action: "bridge"
    };
  }
  if (
    issue.id === "missing-pass-zones" ||
    issue.id.startsWith("orphan-pass-") ||
    issue.id.startsWith("one-sided-pass-")
  ) {
    return {
      title: "Connect rooms through doors",
      detail: "Add a green door pass where two walk areas should connect through an opening.",
      button: "Draw Door Pass",
      action: "paint-pass"
    };
  }
  if (issue.id.startsWith("blocked-pass-") || issue.id.startsWith("blocked-walk-")) {
    const targetZoneId = issue.id.replace(/^blocked-(?:pass|walk)-/, "");
    return {
      title: "Review blocking zones",
      detail: "A walk or door-pass zone overlaps a blocker. Use the zone map to split, shrink, or move blockers away from the intended route.",
      button: "Review Blockers",
      action: "review-zones",
      targetZoneId
    };
  }
  return {
    title: "Run automatic repair",
    detail: "Let Studio rebuild bounds, view walk patches, boundary blockers, and likely door passes.",
    button: "Auto Fix",
    action: "auto"
  };
}

function navigationRepairPath(
  manifest: SceneManifest,
  coverage: NavigationCoverage,
  primaryIssue: NavigationQaIssue | undefined
): NavigationRepairPathStep[] {
  const hasBounds = Boolean(manifest.navigation.bounds);
  const hasWalkViews = coverage.walkViews > 0;
  const walkViewsCovered = !hasWalkViews || coverage.coveredWalkViews >= coverage.walkViews;
  const walkReady = coverage.walkZones > 0 && walkViewsCovered;
  const routeReady = coverage.routeComponents <= 1;
  const routeNeedsBridge = coverage.walkZones > 1 && coverage.routeComponents > 1;
  const hasBlockingIssue = Boolean(primaryIssue && primaryIssue.severity !== "info");
  const issueFix = navigationQuickFixForIssue(primaryIssue);

  const steps: NavigationRepairPathStep[] = [
    {
      id: "bounds",
      label: "1. Boundary",
      detail: hasBounds
        ? "Movement has a bounded area."
        : "Set movement bounds so users cannot drift into empty exterior space.",
      status: hasBounds ? "done" : "active",
      quickFix: hasBounds
        ? undefined
        : {
            title: "Set movement boundary",
            detail: "Use the detected model bounds.",
            button: "Use Bounds",
            action: "bounds"
          }
    },
    {
      id: "walk",
      label: "2. Walk areas",
      detail:
        coverage.walkZones === 0
          ? "Create clickable floor areas from saved walk views or draw them on the map."
          : walkViewsCovered
            ? `${coverage.walkZones} walk area(s) cover the saved walk views.`
            : `${coverage.coveredWalkViews}/${coverage.walkViews} walk view(s) are inside walk areas.`,
      status: walkReady ? "done" : hasBounds ? "active" : "pending",
      quickFix: walkReady
        ? undefined
        : {
            title: "Create clickable floor",
            detail: "Generate walk patches from saved walk views, then refine them on the map.",
            button: "View Walks",
            action: "view-walks"
          }
    },
    {
      id: "connect",
      label: "3. Room links",
      detail: routeNeedsBridge
        ? `${coverage.routeComponents} route islands need green passes through doors or openings.`
        : coverage.passZones > 0
          ? `${coverage.passZones} door pass(es) connect rooms.`
          : "Add door passes only where separate rooms need a connector.",
      status: routeReady ? "done" : walkReady ? "active" : "pending",
      quickFix: routeReady
        ? undefined
        : {
            title: "Bridge route islands",
            detail: "Try automatic green connectors between nearby walk areas.",
            button: "Auto Bridge",
            action: "bridge"
          }
    },
    {
      id: "blockers",
      label: "4. Blockers",
      detail: hasBlockingIssue
        ? primaryIssue?.detail ?? "One navigation issue still needs review."
        : "No obvious blocker or zone issue remains in Studio checks.",
      status: hasBlockingIssue ? (routeReady ? "active" : "pending") : "done",
      quickFix: hasBlockingIssue ? issueFix : undefined
    },
    {
      id: "test",
      label: "5. Test",
      detail: "Open the viewer and test WASD, click-to-move, doorways, and room buttons.",
      status: hasBounds && walkReady && routeReady && !hasBlockingIssue ? "active" : "pending",
      quickFix: {
        title: "Test viewer",
        detail: "Open the walkthrough with navigation debug enabled.",
        button: "Test Viewer",
        action: "test"
      }
    }
  ];

  return steps;
}

function isHotspot(interaction: SceneInteraction): interaction is HotspotInteraction {
  return interaction.kind === "hotspot";
}

function isLink(interaction: SceneInteraction): interaction is LinkInteraction {
  return interaction.kind === "link";
}

function isMaterialVariantInteraction(
  interaction: SceneInteraction
): interaction is MaterialVariantInteraction {
  return interaction.kind === "material-variant";
}

function isObjectToggle(interaction: SceneInteraction): interaction is ObjectToggleInteraction {
  return interaction.kind === "object-toggle";
}

function isVideoTexture(interaction: SceneInteraction): interaction is VideoTextureInteraction {
  return interaction.kind === "video-texture";
}

function videoSurfaceScore(name: string): number {
  const normalized = name.toLowerCase();
  let score = 0;
  if (normalized.includes("screen")) {
    score += 8;
  }
  if (normalized.includes("tv") || normalized.includes("television")) {
    score += 8;
  }
  if (normalized.includes("display") || normalized.includes("monitor")) {
    score += 6;
  }
  if (normalized.includes("lcd") || normalized.includes("led") || normalized.includes("panel")) {
    score += 5;
  }
  if (normalized.includes("video") || normalized.includes("media") || normalized.includes("movie")) {
    score += 5;
  }
  if (
    normalized.includes("rendertexture") ||
    normalized.includes("rendertotexture") ||
    normalized.includes("render to texture") ||
    normalized.includes("emissive")
  ) {
    score += 4;
  }
  if (normalized.includes("glass") || normalized.includes("black")) {
    score += 1;
  }
  return score;
}

function videoSurfaceShapeScore(bounds: SceneGraphDocument["nodes"][number]["bounds"]): number {
  if (!bounds) {
    return 0;
  }
  const width = Math.abs(bounds.max[0] - bounds.min[0]);
  const height = Math.abs(bounds.max[1] - bounds.min[1]);
  const depth = Math.abs(bounds.max[2] - bounds.min[2]);
  const horizontal = Math.max(width, depth);
  const thickness = Math.min(width, depth);
  if (horizontal < 0.35 || height < 0.2) {
    return 0;
  }
  const aspect = horizontal / Math.max(0.001, height);
  const thin = thickness <= Math.max(0.08, horizontal * 0.18);
  const screenLikeAspect = aspect >= 1.1 && aspect <= 3.2;
  return (thin ? 4 : 0) + (screenLikeAspect ? 3 : 0);
}

function doorPassScore(name: string): number {
  const normalized = name.toLowerCase();
  let score = 0;
  if (normalized.includes("door")) {
    score += 10;
  }
  if (normalized.includes("opening") || normalized.includes("portal")) {
    score += 8;
  }
  if (normalized.includes("passage") || normalized.includes("corridor")) {
    score += 7;
  }
  if (normalized.includes("slider") || normalized.includes("sliding")) {
    score += 6;
  }
  if (normalized.includes("frame") || normalized.includes("threshold")) {
    score += 5;
  }
  if (normalized.includes("entry") || normalized.includes("entrance") || normalized.includes("balcony") || normalized.includes("terrace")) {
    score += 4;
  }
  if (normalized.includes("window")) {
    score -= 6;
  }
  if (normalized.includes("handle") || normalized.includes("knob")) {
    score -= 5;
  }
  return score;
}

function doorPassGeometryScore(bounds: NonNullable<SceneGraphDocument["nodes"][number]["bounds"]>, cameraHeight: number): number {
  const size: Vec3 = [
    Math.max(0.001, bounds.max[0] - bounds.min[0]),
    Math.max(0.001, bounds.max[1] - bounds.min[1]),
    Math.max(0.001, bounds.max[2] - bounds.min[2])
  ];
  const width = Math.max(size[0], size[2]);
  const thickness = Math.min(size[0], size[2]);
  const height = size[1];
  const looksLikeDoorLeaf =
    height >= Math.max(1.1, cameraHeight * 0.72) &&
    height <= Math.max(3.4, cameraHeight * 2.2) &&
    width >= 0.45 &&
    width <= 2.3 &&
    thickness <= Math.max(0.18, width * 0.18);
  const looksLikeThreshold =
    height <= 0.34 &&
    width >= 0.65 &&
    width <= 2.6 &&
    thickness <= Math.max(0.28, width * 0.22);
  return (looksLikeDoorLeaf ? 4 : 0) + (looksLikeThreshold ? 3 : 0);
}

function createView(index: number): SceneView {
  return {
    id: `view-${index}`,
    label: `View ${index}`,
    kind: "walk",
    position: [0, 1.65, 3],
    target: [0, 1.3, 0],
    fov: 62
  };
}

function createTopViewFromBounds(
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>,
  index: number
): SceneView {
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
  const width = Math.max(1, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(1, bounds.max[2] - bounds.min[2]);
  const height = Math.max(bounds.max[1] + 4, Math.max(width, depth) * 1.45);
  return {
    id: index === 1 ? "top" : `top-${index}`,
    label: index === 1 ? "Top" : `Top ${index}`,
    kind: "top",
    position: [center[0], Number(height.toFixed(3)), center[2] + 0.01],
    target: [center[0], center[1], center[2]],
    fov: 55
  };
}

function createMaterialVariantInteraction(index: number, materialName: string): MaterialVariantInteraction {
  return {
    id: `finish-${index}`,
    kind: "material-variant",
    label: `${materialName || "Material"} Finish`,
    targetMaterialName: materialName,
    variants: [
      {
        id: "option-1",
        label: "Option 1",
        color: "#07333d"
      },
      {
        id: "option-2",
        label: "Option 2",
        color: "#8d8376"
      }
    ]
  };
}

function createHotspot(index: number): HotspotInteraction {
  return {
    id: `hotspot-${index}`,
    kind: "hotspot",
    label: `Hotspot ${index}`,
    position: [0, 1.25, 0],
    title: `Hotspot ${index}`,
    body: "",
    icon: "info"
  };
}

function createLink(index: number): LinkInteraction {
  return {
    id: `link-${index}`,
    kind: "link",
    label: `Link ${index}`,
    position: [0, 1.25, 0],
    url: "https://example.com",
    openInNewTab: true
  };
}

function createObjectToggle(index: number, object?: ObjectOverride): ObjectToggleInteraction {
  return {
    id: `object-toggle-${index}`,
    kind: "object-toggle",
    label: object ? `Toggle ${object.name}` : `Object Toggle ${index}`,
    position: [0, 1.25, 0],
    ...(object ? { targetObjectId: object.id, targetObjectName: object.name } : {}),
    initiallyVisible: true
  };
}

function createVideoTexture(index: number): VideoTextureInteraction {
  return {
    id: `video-texture-${index}`,
    kind: "video-texture",
    label: `Video Surface ${index}`,
    source: "",
    autoplay: true,
    muted: true,
    loop: true,
    triggerDistance: 8
  };
}

function withVideoSurfaceCandidate(
  interaction: VideoTextureInteraction,
  candidate: VideoSurfaceCandidate
): VideoTextureInteraction {
  const nextInteraction: VideoTextureInteraction = {
    ...interaction,
    targetMeshName: candidate.meshName
  };
  if (candidate.materialName) {
    nextInteraction.targetMaterialName = candidate.materialName;
  } else {
    delete nextInteraction.targetMaterialName;
  }
  return nextInteraction;
}

function createRoom(index: number, view?: SceneView): RoomDefinition {
  return {
    id: `room-${index}`,
    label: view?.label ?? `Room ${index}`,
    ...(view ? { viewId: view.id, center: view.position } : {})
  };
}

function createRoomFromView(view: SceneView, index: number): RoomDefinition {
  return {
    id: `room-${view.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72),
    label: view.label,
    viewId: view.id,
    center: view.position
  };
}

function navigationZoneArea(zone: NavigationZone): number {
  const aabb = navigationZoneAabb(zone);
  return Math.max(0.01, aabb.maxX - aabb.minX) * Math.max(0.01, aabb.maxZ - aabb.minZ);
}

function mergeNavigationAabbs(zones: readonly NavigationZone[]) {
  const boxes = zones.map(navigationZoneAabb);
  return {
    minX: Math.min(...boxes.map((box) => box.minX)),
    maxX: Math.max(...boxes.map((box) => box.maxX)),
    minZ: Math.min(...boxes.map((box) => box.minZ)),
    maxZ: Math.max(...boxes.map((box) => box.maxZ))
  };
}

function semanticRoomLabelForName(value: string): { label: string; score: number } | undefined {
  const normalized = value.toLowerCase();
  const rules: readonly [RegExp, string, number][] = [
    [/\b(living|lounge|sofa|couch|tv|television)\b/, "Living", 4],
    [/\b(dining|dinner|table)\b/, "Dining", 4],
    [/\b(kitchen|counter|sink|stove|hob|oven|fridge|refrigerator)\b/, "Kitchen", 4],
    [/\b(bed|bedroom|wardrobe|closet)\b/, "Bedroom", 4],
    [/\b(bath|bathroom|toilet|wc|shower|vanity)\b/, "Bathroom", 4],
    [/\b(balcony|terrace|patio|deck)\b/, "Balcony", 4],
    [/\b(foyer|entry|entrance|lobby)\b/, "Foyer", 3],
    [/\b(pooja|prayer|mandir)\b/, "Pooja", 3],
    [/\b(family|den)\b/, "Family Room", 3],
    [/\b(study|office|desk)\b/, "Study", 3],
    [/\b(laundry|utility|dry area|washer)\b/, "Utility", 3]
  ];
  const match = rules.find(([pattern]) => pattern.test(normalized));
  return match ? { label: match[1], score: match[2] } : undefined;
}

function autoGeneratedRoomLabel(value: string | undefined): boolean {
  return !value || /^(entry|center|left|right|top|view \d+|room \d+|area \d+)$/i.test(value.trim());
}

function transformGraphVec3(value: Vec3, modelScale: number, modelOffset: Vec3 = [0, 0, 0]): Vec3 {
  return [
    value[0] * modelScale + modelOffset[0],
    value[1] * modelScale + modelOffset[1],
    value[2] * modelScale + modelOffset[2]
  ];
}

function transformGraphBounds(
  bounds: NonNullable<SceneGraphDocument["nodes"][number]["bounds"]>,
  modelScale: number,
  modelOffset: Vec3 = [0, 0, 0]
): NonNullable<SceneManifest["navigation"]["bounds"]> {
  return {
    min: transformGraphVec3(bounds.min, modelScale, modelOffset),
    max: transformGraphVec3(bounds.max, modelScale, modelOffset)
  };
}

function semanticRoomLabelFromZoneGroup(
  zones: readonly NavigationZone[],
  graph: SceneGraphDocument | null,
  modelScale: number,
  modelOffset: Vec3 = [0, 0, 0]
): string | undefined {
  if (!graph || zones.length === 0) {
    return undefined;
  }
  const rejectKeywords =
    /\b(wall|door|window|glass|ceiling|roof|floor|slab|tile|ground|column|pillar|plant|tree|chair|table|sofa|couch|bed|cabinet|cupboard|wardrobe|counter|shelf|tv|screen|appliance|decor|vase|lamp|fan)\b/;
  const aabb = mergeNavigationAabbs(zones);
  const scores = new Map<string, number>();
  for (const node of graph.nodes) {
    if (!node.bounds) {
      continue;
    }
    const center = transformGraphVec3(
      [
        (node.bounds.min[0] + node.bounds.max[0]) / 2,
        (node.bounds.min[1] + node.bounds.max[1]) / 2,
        (node.bounds.min[2] + node.bounds.max[2]) / 2
      ],
      modelScale,
      modelOffset
    );
    if (
      center[0] < aabb.minX - 0.75 ||
      center[0] > aabb.maxX + 0.75 ||
      center[2] < aabb.minZ - 0.75 ||
      center[2] > aabb.maxZ + 0.75
    ) {
      continue;
    }
    const searchName = `${node.name} ${node.meshName ?? ""}`;
    if (rejectKeywords.test(searchName.toLowerCase())) {
      continue;
    }
    const semantic = semanticRoomLabelForName(searchName);
    if (semantic) {
      scores.set(semantic.label, (scores.get(semantic.label) ?? 0) + semantic.score);
    }
  }
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 4 ? best[0] : undefined;
}

function createRoomFromNavigationZoneGroup(
  zones: readonly NavigationZone[],
  index: number,
  views: readonly SceneView[],
  graph: SceneGraphDocument | null = null,
  modelScale = 1,
  modelOffset: Vec3 = [0, 0, 0]
): RoomDefinition {
  const sortedZones = [...zones].sort((a, b) => a.id.localeCompare(b.id));
  const aabb = mergeNavigationAabbs(sortedZones);
  const center: Vec3 = [
    (aabb.minX + aabb.maxX) / 2,
    sortedZones.reduce((sum, zone) => sum + zone.center[1], 0) / sortedZones.length,
    (aabb.minZ + aabb.maxZ) / 2
  ];
  const linkedView = views.find((view) =>
    view.kind === "walk" && sortedZones.some((zone) => pointInNavigationZone(zone, view.position, 0.35))
  );
  const semanticLabel = semanticRoomLabelFromZoneGroup(sortedZones, graph, modelScale, modelOffset);
  const namedZone = sortedZones.find((zone) => zone.label && !/^walk/i.test(zone.label));
  const linkedViewLabel = autoGeneratedRoomLabel(linkedView?.label) ? undefined : linkedView?.label;
  const width = Math.max(0.01, aabb.maxX - aabb.minX);
  const depth = Math.max(0.01, aabb.maxZ - aabb.minZ);
  const idSource = sortedZones.map((zone) => zone.id).join("-");
  return {
    id: `room-walk-${idSource}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72),
    label: linkedViewLabel ?? semanticLabel ?? namedZone?.label ?? `Room ${index}`,
    ...(linkedView ? { viewId: linkedView.id } : {}),
    center,
    dimensions: `${width.toFixed(1)}m x ${depth.toFixed(1)}m`,
    bounds: {
      min: [aabb.minX, Math.min(...sortedZones.map((zone) => zone.center[1] - zone.size[1] / 2)), aabb.minZ],
      max: [aabb.maxX, Math.max(...sortedZones.map((zone) => zone.center[1] + zone.size[1] / 2)), aabb.maxZ]
    }
  };
}

function createRoomsFromNavigationZones(
  zones: readonly NavigationZone[],
  views: readonly SceneView[],
  graph: SceneGraphDocument | null = null,
  modelScale = 1,
  modelOffset: Vec3 = [0, 0, 0]
): RoomDefinition[] {
  const walkViews = views.filter((view) => view.kind === "walk");
  const roomZones = zones.filter(
    (zone) =>
      navigationZoneArea(zone) >= 0.9 ||
      walkViews.some((view) => pointInNavigationZone(zone, view.position, 0.35))
  );
  return navigationComponents(roomZones)
    .sort((a, b) => {
      const boxA = mergeNavigationAabbs(a);
      const boxB = mergeNavigationAabbs(b);
      return boxA.minZ - boxB.minZ || boxA.minX - boxB.minX;
    })
    .map((component, index) =>
      createRoomFromNavigationZoneGroup(component, index + 1, views, graph, modelScale, modelOffset)
    );
}

function uniqueRoomLabels(rooms: readonly RoomDefinition[]): RoomDefinition[] {
  const counts = new Map<string, number>();
  rooms.forEach((room) => counts.set(room.label, (counts.get(room.label) ?? 0) + 1));
  const seen = new Map<string, number>();
  return rooms.map((room) => {
    const total = counts.get(room.label) ?? 0;
    if (total <= 1) {
      return room;
    }
    const index = (seen.get(room.label) ?? 0) + 1;
    seen.set(room.label, index);
    return {
      ...room,
      label: `${room.label} ${index}`
    };
  });
}

function createNavigationZone(
  index: number,
  kind: NavigationZone["kind"],
  bounds?: SceneManifest["navigation"]["bounds"]
): NavigationZone {
  const isWalk = kind === "walk";
  const isPass = kind === "pass";
  const center: Vec3 = bounds
    ? [
        (bounds.min[0] + bounds.max[0]) / 2,
        isWalk ? bounds.min[1] + 0.03 : (bounds.min[1] + bounds.max[1]) / 2,
        (bounds.min[2] + bounds.max[2]) / 2
      ]
    : [0, isWalk ? 0.03 : 1.1, 0];
  const size: Vec3 = bounds
    ? [
        Math.max(isPass ? 0.65 : 1, (bounds.max[0] - bounds.min[0]) * (isWalk ? 0.9 : isPass ? 0.05 : 0.08)),
        isWalk ? 0.08 : Math.max(1, (bounds.max[1] - bounds.min[1]) * (isPass ? 0.45 : 1)),
        Math.max(isPass ? 0.9 : 1, (bounds.max[2] - bounds.min[2]) * (isWalk ? 0.9 : isPass ? 0.12 : 0.45))
      ]
    : isWalk
      ? [4, 0.08, 4]
      : isPass
        ? [0.8, 2.2, 1.4]
        : [0.25, 2.2, 3];
  const labelPrefix = kind === "walk" ? "Walk" : kind === "pass" ? "Pass" : "Block";
  return {
    id: `${kind}-zone-${index}`,
    label: `${labelPrefix} Zone ${index}`,
    kind,
    center,
    size,
    rotationY: 0,
    enabled: true,
    source: "authored"
  };
}

function createBoundaryBlockZoneSet(
  bounds: NonNullable<SceneManifest["navigation"]["bounds"]>,
  cameraHeight: number
): NavigationZone[] {
  const width = Math.max(1, bounds.max[0] - bounds.min[0]);
  const depth = Math.max(1, bounds.max[2] - bounds.min[2]);
  const height = Math.max(1.8, bounds.max[1] - bounds.min[1], cameraHeight + 0.6);
  const y = bounds.min[1] + height / 2;
  const thickness = Math.max(0.35, Math.min(width, depth) * 0.035);
  return [
    {
      id: "boundary-block-north",
      label: "Boundary North",
      kind: "block",
      center: [(bounds.min[0] + bounds.max[0]) / 2, y, bounds.max[2] + thickness / 2],
      size: [width + thickness * 2, height, thickness],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    },
    {
      id: "boundary-block-south",
      label: "Boundary South",
      kind: "block",
      center: [(bounds.min[0] + bounds.max[0]) / 2, y, bounds.min[2] - thickness / 2],
      size: [width + thickness * 2, height, thickness],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    },
    {
      id: "boundary-block-east",
      label: "Boundary East",
      kind: "block",
      center: [bounds.max[0] + thickness / 2, y, (bounds.min[2] + bounds.max[2]) / 2],
      size: [thickness, height, depth + thickness * 2],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    },
    {
      id: "boundary-block-west",
      label: "Boundary West",
      kind: "block",
      center: [bounds.min[0] - thickness / 2, y, (bounds.min[2] + bounds.max[2]) / 2],
      size: [thickness, height, depth + thickness * 2],
      rotationY: 0,
      enabled: true,
      source: "generated",
      generatedBy: "navigation-bounds"
    }
  ];
}

function createWalkZonesForViews(
  walkViews: readonly SceneView[],
  navigation: SceneManifest["navigation"]
): NavigationZone[] {
  const bounds = navigation.bounds;
  const floorY = bounds ? bounds.min[1] + 0.03 : 0.03;
  const patchSize = bounds
    ? Math.max(1.6, Math.min(4, Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) * 0.16))
    : 2.4;
  return walkViews.map((view) => ({
    id: `walk-view-${view.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64),
    label: `${view.label} walk patch`,
    kind: "walk",
    center: [Number(view.position[0].toFixed(3)), Number(floorY.toFixed(3)), Number(view.position[2].toFixed(3))],
    size: [patchSize, 0.08, patchSize],
    rotationY: 0,
    enabled: true,
    source: "generated",
    generatedBy: "walk-view-patch"
  }));
}

function projectScenePath(projectId: string): string {
  return `/scenes/${projectId}/scene.manifest.json`;
}

function projectAssetPath(projectId: string, asset: string): string {
  return `/scenes/${projectId}/${asset}`;
}

function canPreviewTextureAsset(source: string): boolean {
  return /\.(avif|jpe?g|png|webp)$/i.test(source);
}

function normalizeAssetReference(source: string): string {
  return source.replace(/\\/g, "/").replace(/^\/+/, "");
}

function isExternalAssetReference(source: string): boolean {
  return /^(https?:|data:|blob:|generated:\/\/)/i.test(source);
}

function draftKey(projectId: string, document: string): string {
  return `walkthrough-studio.${projectId}-${document}`;
}

function viewerUrl(projectId: string): string {
  return `${viewerBaseUrl}/?scene=${encodeURIComponent(projectScenePath(projectId))}`;
}

function navigationDebugViewerUrl(projectId: string): string {
  return `${viewerUrl(projectId)}&debug=nav`;
}

function publishedViewerUrl(entry: PublishEntry): string {
  if (entry.viewerUrl) {
    return `${viewerBaseUrl}${entry.viewerUrl}`;
  }
  return `${viewerBaseUrl}/?scene=${encodeURIComponent(entry.scenePath)}`;
}

function publishEntryDeliveryMode(entry: PublishEntry): string {
  if (entry.qualityGate?.status === "ready") {
    return "Client-ready";
  }
  if (entry.qualityGate?.status === "blocked") {
    return "Blocked draft";
  }
  if (entry.qualityGate?.status === "warning") {
    return "Draft";
  }
  return "Unverified draft";
}

function setLiveActionLabel(entry: PublishEntry | undefined): string {
  if (!entry) {
    return "Waiting";
  }
  return entry.qualityGate?.status === "ready" ? "Set Live" : "Set Draft Live";
}

function livePublishedViewerUrl(projectId: string, history: PublishHistoryDocument | null): string {
  if (history?.liveViewerUrl) {
    return `${viewerBaseUrl}${history.liveViewerUrl}`;
  }
  return `${viewerBaseUrl}/?scene=${encodeURIComponent(`/published/${projectId}/live/scene.manifest.json`)}`;
}

function embedSnippet(projectId: string, title: string): string {
  return `<script src="${viewerBaseUrl}/embed.js" data-scene="${projectScenePath(projectId)}" data-title="${title}" data-height="640px"></script>`;
}

function publishedEmbedSnippet(entry: PublishEntry, title: string): string {
  return `<script src="${viewerBaseUrl}/embed.js" data-scene="${entry.scenePath}" data-title="${title}" data-height="640px"></script>`;
}

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function publishedLocalDeployCommand(entry: PublishEntry): string {
  if (!entry.deploymentPath) {
    return "";
  }
  return `node scripts/deploy-published-bundle.mjs ${shellQuote(entry.deploymentPath)} --out=dist/published --viewer-base=https://viewer.example.com --public-base=https://cdn.example.com/open-space/${entry.version}/`;
}

function publishedValidateDeployCommand(entry: PublishEntry): string {
  const command = publishedLocalDeployCommand(entry);
  return command ? `${command} --dry-run` : "";
}

function publishedClientGateDeployCommand(entry: PublishEntry): string {
  const command = publishedValidateDeployCommand(entry);
  return command ? `${command} --fail-on-warning --fail-on-deployment-warning` : "";
}

function publishedBucketDeployCommand(entry: PublishEntry): string {
  if (!entry.deploymentPath) {
    return "";
  }
  return `node scripts/deploy-published-bundle.mjs ${shellQuote(entry.deploymentPath)} --s3=s3://your-bucket/open-space/${entry.version} --viewer-base=https://viewer.example.com --public-base=https://cdn.example.com/open-space/${entry.version}/`;
}

function publishedBucketDeployWithCacheCommand(entry: PublishEntry): string {
  const command = publishedBucketDeployCommand(entry);
  return command ? `${command} --apply-cache-control` : "";
}

function publishedS3CompatibleDeployCommand(entry: PublishEntry): string {
  const command = publishedBucketDeployWithCacheCommand(entry);
  return command
    ? `${command} --endpoint-url=https://ACCOUNT_ID.r2.cloudflarestorage.com --region=auto --profile=open-space`
    : "";
}

function formatRuntimeNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(digits).replace(/\.?0+$/, "");
}

function formatRuntimeVec3(value: readonly [number, number, number], digits = 1): string {
  return value.map((axis) => formatRuntimeNumber(axis, digits)).join(", ");
}

function publishedRuntimeChecklistLines(entry: PublishEntry): string[] {
  const runtime = entry.runtime;
  if (!runtime) {
    return [];
  }

  return [
    "",
    "Published runtime:",
    `- Scene asset: ${runtime.sceneUrl}`,
    `- Source asset: ${runtime.originalSceneUrl}`,
    `- Model scale: ${formatRuntimeNumber(runtime.modelScale)}x`,
    ...(runtime.modelOffset
      ? [
          `- Model offset: ${formatRuntimeVec3(runtime.modelOffset)} (${formatRuntimeNumber(
            runtime.modelOffsetDistance ?? 0,
            1
          )} units)`
        ]
      : []),
    `- Render profile: ${runtime.toneMapping}, exposure ${formatRuntimeNumber(runtime.exposure, 2)}`,
    `- Views: ${runtime.viewCount} total, ${runtime.walkViewCount} walk, ${runtime.topViewCount} top`,
    `- Rooms/interactions/navigation: ${runtime.roomCount} rooms, ${runtime.interactionCount} interactions, ${runtime.navigationZoneCount} nav zones`
  ];
}

function publishedDeploymentChecklist(entry: PublishEntry, title: string): string {
  const gate = entry.qualityGate;
  const deliveryMode = publishEntryDeliveryMode(entry);
  const isClientReady = gate?.status === "ready";
  const lines = [
    `Open Space deployment checklist - ${title}`,
    `Version: ${entry.version}`,
    `Published at: ${entry.publishedAt}`,
    `Delivery mode: ${deliveryMode}`,
    `Viewer URL: ${publishedViewerUrl(entry)}`,
    `Embed snippet:`,
    publishedEmbedSnippet(entry, title),
    "",
    "Quality gate:",
    `- Status: ${gate?.status ?? "unknown"}`,
    `- Blockers: ${gate?.blockerCount ?? 0}`,
    `- Warnings: ${gate?.warningCount ?? 0}`,
    ...(gate?.blockers?.length
      ? ["", "Published blockers:", ...gate.blockers.map((issue) => `- ${issue.title}: ${issue.message}`)]
      : []),
    ...(gate?.warnings?.length
      ? ["", "Published warnings:", ...gate.warnings.map((issue) => `- ${issue.title}: ${issue.message}`)]
      : []),
    ...publishedRuntimeChecklistLines(entry),
    "",
    "Preflight:",
    entry.deploymentPath
      ? `1. Validate bundle:\n${publishedValidateDeployCommand(entry)}`
      : "1. Republish this project to generate deployment metadata.",
    entry.deploymentPath ? `2. Run client gate:\n${publishedClientGateDeployCommand(entry)}` : "",
    "",
    "Production upload:",
    entry.deploymentPath
      ? `3. S3/R2 with cache headers:\n${publishedBucketDeployWithCacheCommand(entry)}`
      : "- Deployment command unavailable until the project is republished.",
    entry.deploymentPath ? `4. S3-compatible endpoint example:\n${publishedS3CompatibleDeployCommand(entry)}` : "",
    "",
    "After upload:",
    isClientReady
      ? "- This version is marked client-ready by the saved quality gate."
      : "- Treat this package as an internal draft until blockers/warnings are fixed or explicitly accepted.",
    "- Open the viewer URL on desktop and mobile.",
    "- Test WASD, click-to-move, mouse wheel movement, room buttons, top view, TV/video screens, and hotspots.",
    "- Confirm CDN URLs are HTTPS and cache headers are applied to GLB, texture, video, KTX2, WebP, and AVIF assets."
  ];

  return lines.filter(Boolean).join("\n");
}

function publishReadinessReportText({
  projectId,
  title,
  manifest,
  stats,
  publishChecks,
  draftViewerUrl,
  liveViewerUrl,
  liveVersion,
  liveDeliveryMode
}: {
  projectId: string;
  title: string;
  manifest: SceneManifest;
  stats: BundleStats | null;
  publishChecks: readonly PublishCheck[];
  draftViewerUrl: string;
  liveViewerUrl?: string;
  liveVersion?: string;
  liveDeliveryMode?: string;
}): string {
  const blockers = stats?.publishReadiness?.blockers ?? [];
  const warnings = stats?.publishReadiness?.warnings ?? [];
  const failedChecks = publishChecks.filter((check) => !check.ready);
  const sourceQaIssueGroups = stats ? sourceQaGroups(stats).filter((group) => group.count > 0) : [];
  const sourceQaIssueLines = sourceQaIssueGroupEvidenceLines(sourceQaIssueGroups, { issuesPerGroup: 3 });
  const lines = [
    `Open Space pre-publish readiness - ${title}`,
    `Project: ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    `Draft viewer: ${draftViewerUrl}`,
    liveViewerUrl ? `Live viewer: ${liveViewerUrl}` : "",
    liveVersion ? `Live version: ${liveVersion}` : "",
    liveDeliveryMode ? `Live delivery mode: ${liveDeliveryMode}` : "",
    liveDeliveryMode && liveDeliveryMode !== "Client-ready"
      ? "Live sharing note: Treat the live link as an internal draft until warnings are fixed or explicitly accepted."
      : "",
    "",
    "Publish gate:",
    `- Status: ${stats?.publishReadiness?.status ?? "not analyzed"}`,
    `- Blockers: ${blockers.length}`,
    `- Warnings: ${warnings.length}`,
    `- Diagnostics: ${stats?.diagnostics?.length ?? 0}`,
    "",
    "Source QA findings:",
    sourceQaIssueLines.length > 0
      ? ""
      : "- No grouped Source QA issue is currently flagged.",
    ...sourceQaIssueLines,
    "",
    "Scene summary:",
    `- Views: ${manifest.views.length}`,
    `- Walk views: ${manifest.views.filter((view) => view.kind === "walk").length}`,
    `- Rooms: ${manifest.rooms?.length ?? 0}`,
    `- Interactions: ${manifest.interactions.length}`,
    `- Bundle: ${formatBytes(stats?.totalBytes ?? 0)}`,
    `- Model: ${formatBytes(stats?.modelBytes ?? 0)}`,
    `- Triangles: ${stats?.triangleCount ?? 0}`,
    `- Draw primitives: ${stats?.primitiveCount ?? stats?.meshCount ?? 0}`,
    `- Texture RAM: ${formatBytes(stats?.estimatedTextureMemoryBytes ?? 0)}`,
    stats?.modelOffset
      ? `- Viewer model offset: ${stats.modelOffset.map((value) => value.toFixed(1)).join(", ")}`
      : "",
    `- Lightmaps: ${stats?.lightmapAssetCount ?? 0}/${stats?.lightmapMaterialCount ?? 0}`,
    "",
    "Readiness rows:",
    ...publishChecks.map(
      (check) =>
        `- ${check.ready ? "ready" : check.blocking ? "blocked" : "warning"}: ${check.label} - ${check.detail}${check.action ? `; action: ${nextStepCopy(check.action).button}` : ""}`
    ),
    "",
    failedChecks.length > 0 ? "Next fixes:" : "Next fixes: none",
    ...failedChecks.map(
      (check) => `- ${check.label}: ${check.detail}${check.action ? ` -> ${nextStepCopy(check.action).button}` : ""}`
    ),
    "",
    blockers.length > 0 ? "Publish blockers:" : "",
    ...blockers.map((issue) => `- ${issue.title}: ${issue.message}${issue.action ? ` Action: ${issue.action}` : ""}`),
    warnings.length > 0 ? "Publish warnings:" : "",
    ...warnings.map((issue) => `- ${issue.title}: ${issue.message}${issue.action ? ` Action: ${issue.action}` : ""}`),
    "",
    "Manual QA before sharing:",
    "- Open the draft viewer and test WASD, mouse drag, mouse wheel movement, and click-to-move.",
    "- Try entering rooms through doors and verify walls/windows/cupboards reject movement.",
    "- Check top view, room buttons, TV/video screens, hotspots, baked lighting, and mobile performance."
  ];

  return lines.filter(Boolean).join("\n");
}

function clientViewerTestScriptText({
  projectId,
  title,
  viewerUrl,
  versionLabel,
  versionDeliveryMode,
  manifest,
  stats
}: {
  projectId: string;
  title: string;
  viewerUrl: string;
  versionLabel: string;
  versionDeliveryMode?: string;
  manifest: SceneManifest;
  stats: BundleStats | null;
}): string {
  const walkViewCount = manifest.views.filter((view) => view.kind === "walk").length;
  const topViewCount = manifest.views.filter((view) => view.kind === "top").length;
  const roomCount = manifest.rooms?.length ?? 0;
  const videoCount = manifest.interactions.filter((interaction) => interaction.kind === "video-texture").length;
  const hotspotCount = manifest.interactions.filter((interaction) => interaction.kind === "hotspot").length;
  const linkCount = manifest.interactions.filter((interaction) => interaction.kind === "link").length;
  const objectToggleCount = manifest.interactions.filter((interaction) => interaction.kind === "object-toggle").length;
  const publishReadiness = stats?.publishReadiness;
  const lines = [
    `Open Space client viewer test - ${title}`,
    `Project: ${projectId}`,
    `Version: ${versionLabel}`,
    versionDeliveryMode ? `Delivery mode: ${versionDeliveryMode}` : "",
    `Generated: ${new Date().toISOString()}`,
    `Viewer URL: ${viewerUrl}`,
    "",
    "Scene setup expected:",
    `- Views: ${manifest.views.length} total, ${walkViewCount} walk, ${topViewCount} top`,
    `- Rooms: ${roomCount}`,
    `- Interactions: ${videoCount} video screen(s), ${hotspotCount} hotspot(s), ${linkCount} link(s), ${objectToggleCount} object toggle(s)`,
    stats
      ? `- Bundle: ${formatBytes(stats.totalBytes)}, model: ${formatBytes(stats.modelBytes)}, triangles: ${stats.triangleCount}`
      : "- Bundle analysis: not available",
    publishReadiness
      ? `- Publish gate: ${publishReadiness.status}, ${publishReadiness.blockers.length} blocker(s), ${publishReadiness.warnings.length} warning(s)`
      : "- Publish gate: not analyzed",
    "",
    "Test steps:",
    "1. Open the viewer URL in a clean browser window.",
    "2. Wait for loading to finish and confirm the first camera frames the actual model, not empty space or only terrain.",
    "3. Drag the mouse to look around and use the mouse wheel to move forward/backward.",
    "4. Press W/A/S/D and confirm left/right/forward/back movement feels correct.",
    "5. Click a valid floor area and confirm the blue marker appears, movement glides smoothly, and the camera stops at the target.",
    "6. Try clicking a wall, window, cupboard, exterior area, or invalid surface and confirm movement is blocked instead of passing through.",
    "7. Enter at least two rooms through doorways and confirm door passes work without jumping over ridges or clipping into walls.",
    "8. Use every room button and top view; confirm labels, minimap/camera position, and top-view hiding are readable.",
    "9. Inspect ceiling, doors, TV screens, windows/exterior context, and baked-lighting shadows from normal viewing height.",
    "10. Test every configured video screen, hotspot, link, and object toggle.",
    "11. Resize to mobile width or test on a phone; confirm load, touch look, click movement, and video playback are acceptable.",
    "",
    "Pass/fail notes:",
    "- Visual match vs reference: ",
    "- Movement and wall boundaries: ",
    "- Doorway entry: ",
    "- Rooms/top view: ",
    "- Screens/hotspots/links/toggles: ",
    "- Mobile performance: ",
    "- Issues to fix before sharing: "
  ];

  return lines.filter(Boolean).join("\n");
}

function navigationQaBriefText({
  projectId,
  manifest,
  controls,
  coverage,
  issues,
  repairDraft,
  quickFix,
  navigationViewerUrl
}: {
  projectId: string;
  manifest: SceneManifest;
  controls: SceneControlsDocument | null;
  coverage: NavigationCoverage | null;
  issues: readonly NavigationQaIssue[];
  repairDraft: NavigationRepairDraft | null;
  quickFix: NavigationQuickFix;
  navigationViewerUrl: string;
}): string {
  const movement = controls?.movement;
  const comfort = movementComfortStatus(controls, manifest);
  const passIssues = issues.filter((issue) => /pass|door|island|route/i.test(`${issue.id} ${issue.title}`));
  const blockerIssues = issues.filter((issue) => /block|collision|wall/i.test(`${issue.id} ${issue.title}`));
  const lines = [
    `Open Space navigation QA brief - ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    `Navigation debug viewer: ${navigationViewerUrl}`,
    "",
    "Current movement feel:",
    `- ${comfort.label}: ${comfort.detail}`,
    ...comfort.lines,
    "",
    "Navigation coverage:",
    coverage
      ? `- Walk areas: ${coverage.walkZones}, door passes: ${coverage.passZones}, blockers: ${coverage.blockZones}, route islands: ${coverage.routeComponents}`
      : "- Coverage has not been analyzed yet.",
    coverage
      ? `- Walk views covered: ${coverage.coveredWalkViews}/${coverage.walkViews}`
      : "",
    "",
    "Movement settings:",
    movement
      ? `- Enabled: ${movement.enabled ? "yes" : "no"}, WASD: ${movement.keyboard ? "yes" : "no"}, click-to-move: ${movement.clickToMove ? "yes" : "no"}, drag look: ${movement.dragLook ? "yes" : "no"}`
      : "- Movement controls are not loaded.",
    movement ? `- Move speed: ${movement.moveSpeed}, click glide: ${movement.clickMoveSpeed ?? "default"}, wheel glide: ${movement.wheelMoveSpeed ?? "default"}` : "",
    movement ? `- Body radius: ${movement.collisionRadius ?? 0.28}, step up/down: ${movement.maxStepUp ?? 0.38}/${movement.maxStepDown ?? 0.72}` : "",
    movement ? `- Height glide: ${movement.floorHeightSmoothing ?? 0.9}, floor bump ignore: ${movement.floorBumpTolerance ?? 0.48}` : "",
    "",
    "Recommended next fix:",
    `- ${quickFix.title}: ${quickFix.detail}`,
    `- Button: ${quickFix.button}`,
    "",
    "Navigation issues:",
    issues.length > 0 ? `- ${issues.length} issue(s) currently listed.` : "- No navigation QA issues are currently listed.",
    ...issues.slice(0, 8).map((issue) => `- ${issue.severity.toUpperCase()}: ${issue.title} - ${issue.detail}${issue.action ? ` Action: ${issue.action}` : ""}`),
    passIssues.length > 0 ? "" : "",
    passIssues.length > 0 ? "Door/pass focus:" : "",
    ...passIssues.slice(0, 5).map((issue) => `- ${issue.title}: ${issue.detail}`),
    blockerIssues.length > 0 ? "" : "",
    blockerIssues.length > 0 ? "Blocker focus:" : "",
    ...blockerIssues.slice(0, 5).map((issue) => `- ${issue.title}: ${issue.detail}`),
    repairDraft ? "" : "",
    repairDraft ? "Viewer blocked-click context:" : "",
    repairDraft ? `- Reason: ${repairDraft.reason}` : "",
    repairDraft?.hint ? `- Viewer hint: ${repairDraft.hint}` : "",
    repairDraft?.action ? `- Viewer recommended action: ${navigationRepairActionLabel(repairDraft.action)}` : "",
    repairDraft?.blockerName ? `- Blocker: ${repairDraft.blockerName}${repairDraft.blockerKind ? ` (${repairDraft.blockerKind})` : ""}` : "",
    repairDraft?.objectName ? `- Object: ${repairDraft.objectName}` : "",
    repairDraft?.from ? `- From: ${vec3Summary(repairDraft.from)}` : "",
    repairDraft?.target ? `- Target: ${vec3Summary(repairDraft.target)}` : "",
    repairDraft?.point ? `- Blocked point: ${vec3Summary(repairDraft.point)}` : "",
    repairDraft?.bodyRadius ? `- Body radius at failure: ${repairDraft.bodyRadius.toFixed(2)}` : "",
    "",
    "Retest script:",
    "- Save Studio changes, then open the navigation debug viewer.",
    "- Retry the exact failed click or doorway first; do not judge from a different room.",
    "- Confirm the blue marker appears only on valid walkable floor.",
    "- Confirm walls, cupboards, windows, balcony/exterior bounds, and authored blockers reject movement.",
    "- If the camera bounces over thresholds or rugs, apply Ridge Safe or Steps and retest before repainting zones.",
    "- If the camera reaches a doorway but cannot enter, inspect route islands, one-sided door passes, blocked passes, and body radius.",
    "- Return to Repair Center or Controls only after the same failed click is either fixed or explained."
  ];

  return lines.filter(Boolean).join("\n");
}

function materialFixBriefText({
  projectId,
  material,
  diagnosis,
  previews,
  candidates
}: {
  projectId: string;
  material: MaterialOverride;
  diagnosis: { title: string; detail: string; action: string } | null;
  previews: readonly { field: MaterialTextureField; label: string; source: string }[];
  candidates: readonly MaterialTextureCandidate[];
}): string {
  const assignedLines = materialTextureFields.map((field) => {
    const source = material[field];
    return `- ${materialTextureFieldLabels[field]}: ${source || "not assigned"}`;
  });
  const candidateLines = candidates.slice(0, 8).map(
    (candidate) =>
      `- ${candidate.source}: suggested ${materialTextureFieldLabels[candidate.field]}, ${formatBytes(candidate.bytes)}, ${textureSuggestionConfidenceLabel(candidate.score)}, score ${candidate.score}${
        looseTextureNameLooksGeneric(candidate.source) ? ", generic filename needs visual confirmation" : ""
      }`
  );
  const previewLines = previews.map((preview) => `- ${preview.label}: ${preview.source}`);
  return [
    `Open Space material fix brief - ${material.name}`,
    `Project: ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Current visual diagnosis:",
    diagnosis ? `- ${diagnosis.title}: ${diagnosis.detail}` : "- No selected-material diagnosis is currently available.",
    diagnosis ? `- Next action: ${diagnosis.action}` : "",
    "",
    "Current material values:",
    `- Base color: ${material.baseColor ?? "not set"}`,
    `- Roughness: ${material.roughness ?? "not set"}`,
    `- Metalness: ${material.metalness ?? "not set"}`,
    `- Opacity: ${material.opacity ?? "not set"}`,
    "",
    "Assigned texture maps:",
    ...assignedLines,
    previews.length > 0 ? "" : "",
    previews.length > 0 ? "Preview these assigned maps:" : "",
    ...previewLines,
    candidates.length > 0 ? "" : "",
    candidates.length > 0 ? "Loose texture candidates to compare visually:" : "",
    ...candidateLines,
    "",
    "Fix guidance:",
    "- Compare thumbnails against the source/reference render before assigning loose files.",
    "- Assign base textures only when the image clearly matches the surface color/pattern.",
    "- Assign normal maps only when the image is a bump/normal-style texture.",
    "- Assign emissive maps only for screens/lights/glowing surfaces.",
    "- Assign lightmaps only after bake/relink QA confirms the image is not blank, tiny, or unrelated.",
    "- If candidates use generic names like gltf_embedded_0.png, request a cleaner export or manually verify each material."
  ].join("\n");
}

function interactionSetupRequestText({
  projectId,
  title,
  interaction,
  steps,
  draftViewerUrl
}: {
  projectId: string;
  title: string;
  interaction: SetupRequestInteraction;
  steps: readonly InteractionHealthStep[];
  draftViewerUrl: string;
}): string {
  const warnings = steps.filter((step) => step.status === "warning");
  const activeSteps = steps.filter((step) => step.status === "active");
  const kindLabel =
    interaction.kind === "video-texture"
      ? "video screen"
      : interaction.kind === "object-toggle"
        ? "object toggle"
        : interaction.kind;
  const label = interaction.kind === "hotspot" ? interaction.title : interaction.label;
  const currentSetup =
    interaction.kind === "video-texture"
      ? [
          `- Label: ${interaction.label}`,
          `- Target mesh: ${interaction.targetMeshName ?? "not selected"}`,
          `- Target material: ${interaction.targetMaterialName ?? "not selected"}`,
          `- Video source: ${interaction.source.trim() || "missing"}`,
          `- Playback: autoplay ${interaction.autoplay !== false ? "on" : "off"}, muted ${
            interaction.muted !== false ? "on" : "off"
          }, loop ${interaction.loop !== false ? "on" : "off"}`,
          `- Trigger distance: ${interaction.triggerDistance ?? 8}m`
        ]
      : interaction.kind === "hotspot"
        ? [
            `- Title: ${interaction.title || "missing"}`,
            `- Icon: ${interaction.icon ?? "info"}`,
            `- Body: ${interaction.body?.trim() ? "present" : "missing"}`,
            `- Position: ${vec3Summary(interaction.position)}`
          ]
        : interaction.kind === "link"
          ? [
              `- Label: ${interaction.label || "missing"}`,
              `- URL: ${interaction.url || "missing"}`,
              `- Opens in new tab: ${interaction.openInNewTab !== false ? "yes" : "no"}`,
              `- Position: ${vec3Summary(interaction.position)}`
            ]
          : [
              `- Label: ${interaction.label || "missing"}`,
              `- Target object id: ${interaction.targetObjectId ?? "not selected"}`,
              `- Target object name: ${interaction.targetObjectName ?? "not selected"}`,
              `- Initially visible: ${interaction.initiallyVisible !== false ? "yes" : "no"}`,
              `- Position: ${vec3Summary(interaction.position)}`
            ];
  const fixLines =
    warnings.length > 0
      ? warnings.map((step) => `- ${step.label}: ${step.detail} Action: ${step.action}`)
      : ["- No setup blockers in Studio. Run the viewer test and confirm the interaction behaves visually."];

  const lines = [
    `Open Space interaction setup request - ${title}`,
    `Project: ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    `Draft viewer: ${draftViewerUrl}`,
    "",
    `Interaction: ${label || interaction.id}`,
    `Kind: ${kindLabel}`,
    `ID: ${interaction.id}`,
    "",
    "Current setup:",
    ...currentSetup,
    "",
    "Fix needed:",
    ...fixLines,
    ...(activeSteps.length > 0 ? [""] : []),
    ...activeSteps.map((step) => `- Viewer check: ${step.detail}`),
    "",
    "Visual QA steps:",
    "- In Studio, open Interactions and select this item.",
    "- Use the readiness card first; only edit numeric fields when the visual card still shows a warning.",
    "- Save, open the viewer, and test from at least two camera views.",
    interaction.kind === "video-texture"
      ? "- Confirm the video appears on the intended TV/screen surface, is muted for mobile autoplay, loops if required, and pauses when far away."
      : "- Confirm the marker appears in the intended spot, does not hide behind geometry, and opens or toggles the expected content.",
    "- Test once on mobile width before publishing."
  ];

  return lines.filter(Boolean).join("\n");
}

function lightmapBakePlanText({
  projectId,
  settings,
  materialCount,
  estimatedMaterialCount,
  estimatedBytes,
  preflightIssues,
  blenderTool,
  job
}: {
  projectId: string;
  settings: LightmapBakeSettings;
  materialCount: number;
  estimatedMaterialCount: number;
  estimatedBytes: number;
  preflightIssues: readonly BakePreflightIssue[];
  blenderTool: ToolStatusDocument["tools"][string] | undefined;
  job: LightmapBakeJobDocument | null;
}): string {
  const blockingIssues = preflightIssues.filter((issue) => issue.severity === "error");
  const warningIssues = preflightIssues.filter((issue) => issue.severity === "warning");
  const lightmaps = job?.lightmaps ?? [];
  const reviewLightmaps = lightmaps.filter((lightmap) => lightmapPreviewQuality(lightmap) === "warning");
  const defaults = bakePresetDefaults[settings.preset];
  const presetModified =
    settings.resolution !== defaults.resolution ||
    settings.samples !== defaults.samples ||
    settings.margin !== defaults.margin;

  const lines = [
    `Open Space lightmap bake plan - ${projectId}`,
    "",
    "Current bake settings:",
    `- Preset: ${settings.preset}${presetModified ? " (customized)" : ""}`,
    `- Resolution: ${settings.resolution}px`,
    `- Samples: ${settings.samples}`,
    `- Margin: ${settings.margin}px`,
    `- Max materials: ${settings.maxMaterials}`,
    `- Bake pass: ${settings.mode}`,
    `- Denoise: ${settings.denoise ? "on" : "off"}`,
    "",
    "Preflight estimate:",
    `- Eligible materials: ${materialCount}`,
    `- Materials in this run: ${estimatedMaterialCount}`,
    `- Raw lightmap target: ${formatBytes(estimatedBytes)}`,
    `- Blender: ${blenderTool ? (blenderTool.ready ? `ready (${blenderTool.command})` : `not ready (${blenderTool.action})`) : "unknown"}`,
    `- Blocking issues: ${blockingIssues.length}`,
    `- Warnings: ${warningIssues.length}`,
    ...preflightIssues.map((issue) => `  - ${issue.severity.toUpperCase()}: ${issue.message}`),
    "",
    "Recommended order:",
    blockingIssues.length > 0
      ? "1. Fix the blocking preflight issue(s) before starting Blender."
      : blenderTool && !blenderTool.ready
        ? "1. Install or configure Blender, then reload Studio before baking."
        : "1. Run the bake with the current settings.",
    warningIssues.length > 0
      ? "2. If this is a client review, consider Medium/High settings and reduce raw lightmap memory before baking."
      : "2. Current settings are reasonable for a local bake.",
    "3. Inspect generated lightmap thumbnails for blank, tiny, or flat-looking outputs.",
    "4. Open the viewer and compare soft shadows, seams, overly dark corners, and washed-out materials before publishing.",
    "",
    "Last bake job:",
    job ? `- Status: ${job.status}` : "- No bake job recorded yet.",
    job?.message ? `- Message: ${job.message}` : "",
    job?.outputSceneUrl ? `- Output scene: ${job.outputSceneUrl}` : "",
    job ? `- Lightmaps: ${job.lightmapCount ?? lightmaps.length}` : "",
    job ? `- Total lightmap bytes: ${formatBytes(job.totalLightmapBytes ?? 0)}` : "",
    reviewLightmaps.length > 0 ? `- Review ${reviewLightmaps.length} lightmap output(s):` : "",
    ...reviewLightmaps.slice(0, 10).map(
      (lightmap) =>
        `  - ${lightmap.materialName}: ${lightmap.url} (${lightmap.resolution ?? "unknown"}px, ${formatBytes(lightmap.bytes ?? 0)})`
    )
  ];

  return lines.filter(Boolean).join("\n");
}

function lightmapBakeQaReportText({
  projectId,
  job,
  materialCount,
  viewerUrl
}: {
  projectId: string;
  job: LightmapBakeJobDocument;
  materialCount: number;
  viewerUrl: string;
}): string {
  const lightmaps = job.lightmaps ?? [];
  const lightmapCount = job.lightmapCount ?? lightmaps.length;
  const expectedCount = Math.min(materialCount, job.maxMaterials ?? materialCount);
  const reviewLightmaps = lightmaps.filter((lightmap) => lightmapPreviewQuality(lightmap) === "warning");
  const readyLightmaps = Math.max(0, lightmaps.length - reviewLightmaps.length);
  const totalBytes = job.totalLightmapBytes ?? 0;
  const averageBytes = lightmapCount > 0 ? totalBytes / lightmapCount : 0;
  const missingOutput = lightmapCount <= 0 || !job.outputSceneUrl;
  const incompleteOutput = expectedCount > 0 && lightmapCount > 0 && lightmapCount < expectedCount;
  const lowSettings =
    ((job.resolution ?? 0) > 0 && (job.resolution ?? 0) < 1024) ||
    ((job.samples ?? 0) > 0 && (job.samples ?? 0) < 64);
  const result =
    missingOutput
      ? "blocked"
      : reviewLightmaps.length > 0 || incompleteOutput || lowSettings
        ? "needs visual review"
        : "ready for viewer test";
  const recommendedAction =
    missingOutput
      ? "Re-run the bake after checking Blender output and material eligibility."
      : reviewLightmaps.length > 0
        ? "Review the flagged thumbnails first, then rebake or relink only the failing material lightmaps."
        : incompleteOutput
          ? "Inspect materials without lightmaps and decide whether they need baked lighting before publishing."
          : lowSettings
            ? "Use Medium or High settings before client review if shadows look noisy or soft."
            : "Open the viewer and compare lighting against the reference render before publishing.";
  const lines = [
    `Open Space lightmap bake QA - ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    `Viewer: ${viewerUrl}`,
    "",
    "Bake result:",
    `- Status: ${job.status}`,
    `- Result: ${result}`,
    job.message ? `- Message: ${job.message}` : "",
    job.outputSceneUrl ? `- Output scene: ${job.outputSceneUrl}` : "- Output scene: missing",
    `- Engine: ${job.engine}`,
    `- Bake pass: ${job.bakeMode ?? "unknown"}`,
    `- Preset: ${job.preset ?? "unknown"}`,
    `- Resolution: ${job.resolution ?? "unknown"}px`,
    `- Samples: ${job.samples ?? "unknown"}`,
    `- Denoise: ${job.denoise === false ? "off" : "on"}`,
    "",
    "Lightmap coverage:",
    `- Expected materials: ${expectedCount}`,
    `- Generated lightmaps: ${lightmapCount}`,
    `- Ready previews: ${readyLightmaps}`,
    `- Review previews: ${reviewLightmaps.length}`,
    `- Total bytes: ${formatBytes(totalBytes)}`,
    `- Average bytes: ${formatBytes(averageBytes)}`,
    "",
    "Recommended action:",
    `- ${recommendedAction}`,
    reviewLightmaps.length > 0 ? "Lightmaps to inspect:" : "",
    ...reviewLightmaps.slice(0, 12).map((lightmap) => {
      const issue = lightmapPreviewIssue(lightmap) ?? "Review this lightmap preview before publishing.";
      return `- ${lightmap.materialName}: ${issue} ${lightmap.url} (${lightmap.resolution ?? "unknown"}px, ${formatBytes(lightmap.bytes ?? 0)})`;
    }),
    "",
    "Viewer QA:",
    "- Open the viewer after saving Studio changes.",
    "- Compare soft shadows, corners, ceiling/wall contact, and bright seam artifacts against the reference render.",
    "- Check at least one bright room, one dark room, one hallway, and one material with a manually uploaded or generated lightmap.",
    "- If the scene looks flat, noisy, blank, or overly dark, return to Bake before publishing."
  ];

  return lines.filter(Boolean).join("\n");
}

function lightmapBakeFailureReportText({
  projectId,
  settings,
  preflightIssues,
  blenderTool,
  job
}: {
  projectId: string;
  settings: LightmapBakeSettings;
  preflightIssues: readonly BakePreflightIssue[];
  blenderTool: ToolStatusDocument["tools"][string] | undefined;
  job: LightmapBakeJobDocument;
}): string {
  const failedSteps = job.steps.filter((step) => step.status === "failed");
  const skippedSteps = job.steps.filter((step) => step.status === "skipped");
  const pendingSteps = job.steps.filter((step) => step.status === "pending");
  const blockingPreflightIssues = preflightIssues.filter((issue) => issue.severity === "error");
  const warningPreflightIssues = preflightIssues.filter((issue) => issue.severity === "warning");
  const denoiseEnabled = job.denoise ?? settings.denoise;
  const nextAction =
    blockingPreflightIssues.length > 0
      ? "Fix the blocking preflight issue first, then run the bake again."
      : blenderTool && !blenderTool.ready
        ? "Install or configure Blender, reload Studio, and run the bake again."
        : failedSteps.length > 0
          ? "Review the failed Blender stage and reduce bake scope or quality before retrying."
          : "Review the job message and retry with Draft or Medium settings before production bake.";
  return [
    `Open Space lightmap bake failure - ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Failure summary:",
    `- Status: ${job.status}`,
    job.message ? `- Message: ${job.message}` : "- Message: none",
    `- Engine: ${job.engine}`,
    `- Bake pass: ${job.bakeMode ?? settings.mode}`,
    `- Preset: ${job.preset ?? settings.preset}`,
    `- Resolution: ${job.resolution ?? settings.resolution}px`,
    `- Samples: ${job.samples ?? settings.samples}`,
    `- Margin: ${job.margin ?? settings.margin}px`,
    `- Max materials: ${job.maxMaterials ?? settings.maxMaterials}`,
    `- Denoise: ${denoiseEnabled ? "on" : "off"}`,
    `- Blender: ${blenderTool ? (blenderTool.ready ? `ready (${blenderTool.command})` : `not ready (${blenderTool.action})`) : "unknown"}`,
    "",
    "Preflight:",
    `- Blocking issues: ${blockingPreflightIssues.length}`,
    `- Warnings: ${warningPreflightIssues.length}`,
    ...preflightIssues.map((issue) => `- ${issue.severity.toUpperCase()}: ${issue.message}`),
    "",
    "Job stages:",
    ...job.steps.map((step) => `- ${step.status.toUpperCase()}: ${step.label}${step.note ? ` - ${step.note}` : ""}`),
    failedSteps.length > 0 ? "" : "",
    failedSteps.length > 0 ? "Failed stages:" : "",
    ...failedSteps.map((step) => `- ${step.label}${step.note ? `: ${step.note}` : ""}`),
    skippedSteps.length > 0 ? "" : "",
    skippedSteps.length > 0 ? "Skipped stages:" : "",
    ...skippedSteps.map((step) => `- ${step.label}${step.note ? `: ${step.note}` : ""}`),
    pendingSteps.length > 0 ? "" : "",
    pendingSteps.length > 0 ? "Pending stages at failure:" : "",
    ...pendingSteps.map((step) => `- ${step.label}${step.note ? `: ${step.note}` : ""}`),
    "",
    "Next action:",
    `- ${nextAction}`,
    "- Retry with Draft first if the model is large or Blender is unstable.",
    "- Reduce max materials or resolution when raw lightmap memory is high.",
    "- If Blender cannot open the source, reimport from a cleaner GLB/ZIP before rebaking.",
    "- After a successful retry, inspect thumbnails and run the viewer lighting QA before publishing."
  ].join("\n");
}

function sceneFramingReportLines(stats: BundleStats | null): string[] {
  if (!stats) {
    return ["- Scene framing data is not available yet."];
  }
  const sceneArea = footprintAreaFromSize(stats.sceneBoundsSize);
  const focusedArea = footprintAreaFromSize(stats.focusedBoundsSize);
  const focusedShare =
    typeof sceneArea === "number" && sceneArea > 0 && typeof focusedArea === "number"
      ? Math.min(1, Math.max(0, focusedArea / sceneArea))
      : undefined;
  const sceneDiagnostics = (stats.diagnostics ?? []).filter((diagnostic) =>
    isSceneFramingDiagnostic(diagnostic.code)
  );
  return [
    typeof stats.sceneLargestDimension === "number"
      ? `- Full scene span: ${stats.sceneLargestDimension.toFixed(1)} units`
      : "- Full scene span: unknown",
    typeof stats.focusedLargestDimension === "number"
      ? `- Focused building span: ${stats.focusedLargestDimension.toFixed(1)} units`
      : "- Focused building span: unknown",
    typeof focusedShare === "number"
      ? `- Focused building share: ${Math.max(1, Math.round(focusedShare * 100))}% of the full scene footprint`
      : "- Focused building share: unknown",
    stats.sceneFootprintCenter && typeof stats.sceneFootprintCenterDistance === "number"
      ? `- Full scene center: ${stats.sceneFootprintCenter.map((value) => value.toFixed(1)).join(", ")} (${stats.sceneFootprintCenterDistance.toFixed(1)} units from origin)`
      : "",
    stats.focusedFootprintCenter && typeof stats.focusedFootprintCenterDistance === "number"
      ? `- Focused building center: ${stats.focusedFootprintCenter.map((value) => value.toFixed(1)).join(", ")} (${stats.focusedFootprintCenterDistance.toFixed(1)} units from origin)`
      : "",
    stats.modelOffset
      ? `- Viewer runtime offset: ${formatRuntimeVec3(stats.modelOffset)} (${formatRuntimeNumber(stats.modelOffsetDistance ?? 0, 1)} units applied)`
      : "- Viewer runtime offset: none",
    sceneDiagnostics.length > 0
      ? `- Framing diagnostics: ${sceneDiagnostics.map((diagnostic) => diagnostic.title).join("; ")}`
      : "- Framing diagnostics: none",
    sceneDiagnostics.length > 0
      ? "- Action: run Import Repair, then confirm first load, top view, room buttons, and click-to-move frame the actual building."
      : "- Action: open the viewer and confirm the first view, top view, and movement targets still frame the building."
  ].filter(Boolean);
}

function sourceQaPlanText(stats: BundleStats, projectId: string): string {
  const sourceReviewCodes = new Set([
    "malformed-model",
    "invalid-default-scene",
    "default-scene-has-no-renderable-meshes",
    "missing-gltf-scene-definitions",
    "meshes-outside-default-scene",
    "non-triangle-primitives",
    "invalid-scene-node-references",
    "invalid-node-child-references",
    "invalid-node-mesh-references",
    "invalid-node-transforms",
    "zero-scale-nodes",
    "negative-scale-nodes",
    "suspicious-node-scales",
    "invalid-position-accessor-shapes",
    "invalid-normal-accessor-shapes",
    "invalid-uv-accessor-shapes",
    "invalid-index-accessor-shapes",
    "missing-position-attributes",
    "invalid-accessor-references",
    "invalid-buffer-view-references",
    "invalid-buffer-view-ranges",
    "invalid-accessor-buffer-views",
    "invalid-accessor-byte-ranges",
    "undersized-model-buffers",
    "missing-position-bounds",
    "invalid-position-bounds",
    "collapsed-position-bounds",
    "invalid-material-references",
    "invalid-texture-references",
    "invalid-image-buffer-references",
    "duplicate-node-names",
    "duplicate-material-names",
    "unsafe-gltf-resource-paths",
    "unsupported-required-extensions",
    "embedded-texture-decode-failed",
    "sidecar-texture-decode-failed",
    "unsupported-image-mime-types",
    "missing-model-resources",
    "case-mismatched-model-resources",
    "large-coordinate-units",
    "scene-far-from-origin",
    "dominant-flat-plane",
    "focused-model-small-in-scene",
    "initial-view-on-dominant-plane",
    "initial-view-misses-focused-model",
    "missing-scene-bounds",
    "relocatable-texture-resources",
    "stale-object-overrides",
    "invalid-object-navigation-behavior",
    "repeated-large-mesh-instances",
    "no-named-ceiling-meshes"
  ]);
  const diagnostics = stats.diagnostics ?? [];
  const sourceDiagnostics = diagnostics.filter((diagnostic) => sourceReviewCodes.has(diagnostic.code));
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const sourceGroups = sourceQaGroups(stats);
  const sourceIssueGroups = sourceGroups.filter((group) => group.count > 0);
  const modelFormats = Array.from(new Set((stats.models ?? []).map((model) => model.format))).filter(Boolean);
  const errorCount = sourceDiagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warningCount = sourceDiagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const sourceIssueLines = sourceQaIssueGroupEvidenceLines(sourceIssueGroups, { issuesPerGroup: 4 });

  const lines = [
    `Open Space source QA handoff - ${projectId}`,
    "",
    "Source/model summary:",
    `- Model formats: ${modelFormats.length > 0 ? modelFormats.join(", ") : "unknown"}`,
    `- Model size: ${formatBytes(stats.modelBytes)}`,
    `- Meshes: ${stats.meshCount}`,
    `- Materials: ${stats.materialCount}`,
    `- Triangles: ${stats.triangleCount}`,
    typeof stats.sceneLargestDimension === "number"
      ? `- Scene span: ${stats.sceneLargestDimension.toFixed(1)} units`
      : "",
    stats.sceneFootprintCenter && typeof stats.sceneFootprintCenterDistance === "number"
      ? `- Scene footprint center: ${stats.sceneFootprintCenter.map((value) => value.toFixed(1)).join(", ")} (${stats.sceneFootprintCenterDistance.toFixed(1)} units from origin)`
      : "",
    stats.focusedFootprintCenter && typeof stats.focusedFootprintCenterDistance === "number"
      ? `- Focused footprint center: ${stats.focusedFootprintCenter.map((value) => value.toFixed(1)).join(", ")} (${stats.focusedFootprintCenterDistance.toFixed(1)} units from origin)`
      : "",
    stats.modelOffset
      ? `- Viewer model offset: ${stats.modelOffset.map((value) => value.toFixed(1)).join(", ")} (${(stats.modelOffsetDistance ?? 0).toFixed(1)} units applied)`
      : "",
    `- Embedded images: ${stats.embeddedImageCount ?? 0}`,
    `- External resources: ${externalResources.length}`,
    `- Missing external resources: ${missingResources.length}`,
    "",
    "Scene framing:",
    ...sceneFramingReportLines(stats),
    "",
    "Source QA diagnostics:",
    `- Blocking source issues: ${errorCount}`,
    `- Source warnings: ${warningCount}`,
    `- Source structure issues: ${sourceDiagnostics.filter((diagnostic) => isSourceStructureDiagnostic(diagnostic.code)).length}`,
    sourceDiagnostics.length === 0
      ? "- No source/export diagnostics are currently flagged."
      : "",
    ...sourceDiagnostics.slice(0, 16).map(
      (diagnostic) => {
        const symptom = diagnosticVisualSymptom(diagnostic.code);
        return `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.title} - ${diagnostic.message}${symptom ? ` Likely symptom: ${symptom}` : ""}${diagnostic.action ? ` Action: ${diagnostic.action}` : ""}`;
      }
    ),
    "",
    "Plain-language repair issues:",
    sourceIssueLines.length > 0
      ? ""
      : "- No grouped visual repair issues are currently flagged.",
    ...sourceIssueLines,
    "",
    "Recommended order:",
    sourceDiagnostics.some((diagnostic) => isSourceStructureDiagnostic(diagnostic.code))
      ? "1. Re-export the source scene from Blender/SketchUp/Revit/etc. as a valid glTF 2.0/GLB, then reimport."
      : "1. Source structure does not show a hard GLB validity blocker.",
    missingResources.length > 0
      ? "2. Upload the original ZIP/texture folder and run Import Repair so missing resources can be copied into the scene bundle."
      : "2. External resource paths do not currently show missing files.",
    sourceDiagnostics.some((diagnostic) => diagnostic.code.includes("material") || diagnostic.code.includes("texture"))
      ? "3. Review Materials and relink texture/material slots before judging visual quality."
      : "3. Material/texture references do not currently show source-level reference errors.",
    sourceDiagnostics.some((diagnostic) => diagnostic.code.includes("override") || diagnostic.code.includes("navigation-behavior"))
      ? "4. Review Objects after reimport and remove stale overrides or invalid navigation roles."
      : "4. Object override metadata does not currently need cleanup.",
    "5. Run Import Repair, save, then open the viewer and compare against the source/reference viewer.",
    "",
    missingResources.length > 0 ? "Missing external resources:" : "",
    ...missingResources.slice(0, 12).map((resource) => `- ${resource.source}`)
  ];

  return lines.filter(Boolean).join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function footprintAreaFromSize(size: readonly [number, number, number] | undefined): number | undefined {
  if (!size) {
    return undefined;
  }
  return Math.abs(size[0] * size[2]);
}

function geometryCompressionLabel(stats: BundleStats | null): string {
  if (stats?.compression?.meshopt) {
    return "Meshopt";
  }
  if (stats?.compression?.draco) {
    return "Draco";
  }
  return "None";
}

function textureCompressionLabel(stats: BundleStats | null): string {
  if (stats?.compression?.basisu) {
    return "KTX2";
  }
  if (stats?.compression?.webp) {
    return "WebP";
  }
  return "None";
}

function App() {
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState(initialProjectId);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [selectedTab, setSelectedTab] = useState<StudioTab>(initialStudioTab);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [selectedInteractionId, setSelectedInteractionId] = useState("");
  const [selectedVariantInteractionId, setSelectedVariantInteractionId] = useState("");
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [bundleStats, setBundleStats] = useState<BundleStats | null>(null);
  const [optimizationDoc, setOptimizationDoc] = useState<OptimizationDocument | null>(null);
  const [optimizationJob, setOptimizationJob] = useState<OptimizationJobDocument | null>(null);
  const [optimizationHistory, setOptimizationHistory] = useState<OptimizationHistoryDocument | null>(null);
  const [lightmapBakeJob, setLightmapBakeJob] = useState<LightmapBakeJobDocument | null>(null);
  const [conversionJob, setConversionJob] = useState<ConversionJobDocument | null>(null);
  const [publishHistory, setPublishHistory] = useState<PublishHistoryDocument | null>(null);
  const [sceneGraph, setSceneGraph] = useState<SceneGraphDocument | null>(null);
  const [materialsDoc, setMaterialsDoc] = useState<MaterialsDocument | null>(null);
  const [objectsDoc, setObjectsDoc] = useState<ObjectsDocument | null>(null);
  const [controlsDoc, setControlsDoc] = useState<SceneControlsDocument | null>(null);
  const [toolStatus, setToolStatus] = useState<ToolStatusDocument | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [materialSearchQuery, setMaterialSearchQuery] = useState("");
  const [materialListFilter, setMaterialListFilter] = useState<MaterialListFilter>("all");
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [objectSearchQuery, setObjectSearchQuery] = useState("");
  const [objectListFilter, setObjectListFilter] = useState<ObjectListFilter>("all");
  const [objectReviewMessage, setObjectReviewMessage] = useState("");
  const [apiConnected, setApiConnected] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [saveError, setSaveError] = useState("");
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState("");
  const [lightmapUploadState, setLightmapUploadState] = useState<UploadState>("idle");
  const [lightmapUploadError, setLightmapUploadError] = useState("");
  const [variantUploadState, setVariantUploadState] = useState<UploadState>("idle");
  const [variantUploadError, setVariantUploadError] = useState("");
  const [mediaUploadState, setMediaUploadState] = useState<UploadState>("idle");
  const [mediaUploadError, setMediaUploadError] = useState("");
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const [activePublishVersion, setActivePublishVersion] = useState("");
  const [publishError, setPublishError] = useState("");
  const [publishSuccess, setPublishSuccess] = useState("");
  const [optimizeState, setOptimizeState] = useState<OptimizeState>("idle");
  const [optimizeError, setOptimizeError] = useState("");
  const [bakeState, setBakeState] = useState<BakeState>("idle");
  const [bakeError, setBakeError] = useState("");
  const [bakeSettings, setBakeSettings] = useState<LightmapBakeSettings>({
    preset: "medium" as BakePreset,
    resolution: 1024,
    samples: 96,
    margin: 16,
    maxMaterials: 160,
    denoise: true,
    mode: "lighting" as "lighting" | "combined"
  });
  const [repairState, setRepairState] = useState<RepairState>("idle");
  const [repairError, setRepairError] = useState("");
  const [repairSummary, setRepairSummary] = useState("");
  const [blockerNameDraft, setBlockerNameDraft] = useState("");
  const [navigationRepairDraft, setNavigationRepairDraft] = useState<NavigationRepairDraft | null>(
    initialNavigationRepairDraft
  );
  const [expandedNavigationZoneIds, setExpandedNavigationZoneIds] = useState<Set<string>>(new Set());
  const [navigationPaintKind, setNavigationPaintKind] = useState<NavigationZone["kind"] | null>(null);
  const [navigationPaintShape, setNavigationPaintShape] = useState<NavigationPaintShape>("rectangle");
  const [navigationPolygonDraft, setNavigationPolygonDraft] = useState<NavigationPolygonDraft | null>(null);
  const [showGeneratedNavigationZones, setShowGeneratedNavigationZones] = useState(false);
  const [showNavigationZoneList, setShowNavigationZoneList] = useState(false);
  const [highlightedNavigationIssueId, setHighlightedNavigationIssueId] = useState("");
  const [optimizationProfile, setOptimizationProfile] =
    useState<OptimizationJobDocument["profile"]>("balanced");
  const [applyOptimizedImmediately, setApplyOptimizedImmediately] = useState(true);

  useEffect(() => {
    if (!navigationRepairDraft) {
      return;
    }
    setSelectedTab("controls");
    window.setTimeout(() => {
      document.querySelector(".repair-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    if (navigationRepairDraft.blockerName) {
      setBlockerNameDraft(navigationRepairDraft.blockerName);
    } else if (navigationRepairDraft.objectName) {
      setBlockerNameDraft(navigationRepairDraft.objectName);
    }
  }, [navigationRepairDraft]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        try {
          const listResponse = await fetch(`${apiBaseUrl}/api/projects`);
          if (listResponse.ok) {
            const list = (await listResponse.json()) as { projects: ProjectSummary[] };
            if (!cancelled) {
              setProjectSummaries(list.projects);
            }
          }
          const toolsResponse = await fetch(`${apiBaseUrl}/api/tools`);
          if (toolsResponse.ok && !cancelled) {
            setToolStatus((await toolsResponse.json()) as ToolStatusDocument);
          } else if (!toolsResponse.ok && !cancelled) {
            setToolStatus({
              tools: {
                api: {
                  ready: false,
                  command: "/api/tools",
                  purpose: "Production tool readiness endpoint",
                  action: "Restart the API dev server."
                }
              }
            });
          }

          const apiResponse = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}`);
          if (apiResponse.ok) {
            const project = (await apiResponse.json()) as {
              id: string;
              manifest: SceneManifest;
              materials: MaterialsDocument;
              objects: ObjectsDocument;
              controls: SceneControlsDocument;
              graph: SceneGraphDocument;
              stats: BundleStats;
              optimization: OptimizationDocument;
              optimizationJob: OptimizationJobDocument;
              optimizationHistory: OptimizationHistoryDocument;
              lightmapBakeJob: LightmapBakeJobDocument;
              conversionJob: ConversionJobDocument;
              publishHistory: PublishHistoryDocument;
            };
            if (!cancelled) {
              setApiConnected(true);
              setActiveProjectId(project.id);
              setManifest(project.manifest);
              setMaterialsDoc(project.materials);
              setObjectsDoc(project.objects);
              setControlsDoc(project.controls);
              setSceneGraph(project.graph);
              setBundleStats(project.stats);
              setOptimizationDoc(project.optimization);
              setOptimizationJob(project.optimizationJob);
              setOptimizationHistory(project.optimizationHistory);
              setLightmapBakeJob(project.lightmapBakeJob);
              setConversionJob(project.conversionJob);
              setPublishHistory(project.publishHistory);
              setSelectedViewId(project.manifest.views[0]?.id ?? "");
              setSelectedInteractionId(
                (
                  project.manifest.interactions.find(isHotspot) ??
                  project.manifest.interactions.find(isLink) ??
                  project.manifest.interactions.find(isObjectToggle)
                )?.id ?? ""
              );
              setSelectedVariantInteractionId(
                project.manifest.interactions.find(isMaterialVariantInteraction)?.id ?? ""
              );
              setSelectedMaterialId(project.materials.materials[0]?.id ?? "");
              setSelectedObjectId(project.graph.nodes[0]?.id ?? "");
            }
            return;
          }
        } catch {
          setApiConnected(false);
          if (!cancelled) {
            setToolStatus({
              tools: {
                api: {
                  ready: false,
                  command: apiBaseUrl,
                  purpose: "Production tool readiness endpoint",
                  action: "Start the API dev server."
                }
              }
            });
          }
        }

        const stored = localStorage.getItem(draftKey(activeProjectId, "manifest"));
        if (stored) {
          const parsed = parseSceneManifest(JSON.parse(stored));
          if (!cancelled) {
            setManifest(parsed);
            setSelectedViewId(parsed.views[0]?.id ?? "");
            setSelectedInteractionId(
              (
                parsed.interactions.find(isHotspot) ??
                parsed.interactions.find(isLink) ??
                parsed.interactions.find(isObjectToggle)
              )?.id ?? ""
            );
            setSelectedVariantInteractionId(parsed.interactions.find(isMaterialVariantInteraction)?.id ?? "");
          }
          return;
        }

        const response = await fetch(projectScenePath(activeProjectId));
        if (!response.ok) {
          throw new Error(`Manifest request failed with ${response.status}.`);
        }
        const parsed = parseSceneManifest(await response.json());
        if (!cancelled) {
          setManifest(parsed);
          setSelectedViewId(parsed.views[0]?.id ?? "");
          setSelectedInteractionId(
            (
              parsed.interactions.find(isHotspot) ??
              parsed.interactions.find(isLink) ??
              parsed.interactions.find(isObjectToggle)
            )?.id ?? ""
          );
          setSelectedVariantInteractionId(parsed.interactions.find(isMaterialVariantInteraction)?.id ?? "");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Manifest failed to load.";
        if (!cancelled) {
          setLoadingError(message);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadPublishHistory() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, "publish-history.json"));
        if (!response.ok) {
          if (!cancelled) {
            setPublishHistory({ schemaVersion: "0.1", projectId: activeProjectId, versions: [] });
          }
          return;
        }
        const document = (await response.json()) as PublishHistoryDocument;
        if (!cancelled) {
          setPublishHistory(document);
        }
      } catch {
        if (!cancelled) {
          setPublishHistory({ schemaVersion: "0.1", projectId: activeProjectId, versions: [] });
        }
      }
    }

    void loadPublishHistory();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setSceneGraph(null);
      return;
    }

    let cancelled = false;
    const graphUrl = manifest.graphUrl ?? "scene.graph.json";

    async function loadGraph() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, graphUrl));
        if (!response.ok) {
          return;
        }
        const graph = (await response.json()) as SceneGraphDocument;
        if (!cancelled) {
          setSceneGraph(graph);
          setSelectedObjectId(graph.nodes[0]?.id ?? "");
        }
      } catch {
        if (!cancelled) {
          setSceneGraph(null);
        }
      }
    }

    void loadGraph();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setMaterialsDoc(null);
      return;
    }

    let cancelled = false;
    const materialsUrl = manifest.materialsUrl ?? "materials.json";

    async function loadMaterials() {
      try {
        const stored = localStorage.getItem(draftKey(activeProjectId, "materials"));
        if (stored) {
          const parsed = JSON.parse(stored) as MaterialsDocument;
          if (!cancelled) {
            setMaterialsDoc(parsed);
            setSelectedMaterialId(parsed.materials[0]?.id ?? "");
          }
          return;
        }

        const response = await fetch(projectAssetPath(activeProjectId, materialsUrl));
        if (!response.ok) {
          return;
        }
        const document = (await response.json()) as MaterialsDocument;
        if (!cancelled) {
          setMaterialsDoc(document);
          setSelectedMaterialId(document.materials[0]?.id ?? "");
        }
      } catch {
        if (!cancelled) {
          setMaterialsDoc(null);
        }
      }
    }

    void loadMaterials();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setObjectsDoc(null);
      return;
    }

    let cancelled = false;
    const objectsUrl = manifest.objectsUrl ?? "objects.json";

    async function loadObjects() {
      try {
        const stored = localStorage.getItem(draftKey(activeProjectId, "objects"));
        if (stored) {
          const parsed = JSON.parse(stored) as ObjectsDocument;
          if (!cancelled) {
            setObjectsDoc(parsed);
          }
          return;
        }

        const response = await fetch(projectAssetPath(activeProjectId, objectsUrl));
        if (!response.ok) {
          return;
        }
        const document = (await response.json()) as ObjectsDocument;
        if (!cancelled) {
          setObjectsDoc(document);
        }
      } catch {
        if (!cancelled) {
          setObjectsDoc(null);
        }
      }
    }

    void loadObjects();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setControlsDoc(null);
      return;
    }

    let cancelled = false;
    const controlsUrl = manifest.controlsUrl ?? "controls.json";

    async function loadControls() {
      try {
        const stored = localStorage.getItem(draftKey(activeProjectId, "controls"));
        if (stored) {
          const parsed = JSON.parse(stored) as SceneControlsDocument;
          if (!cancelled) {
            setControlsDoc(parsed);
          }
          return;
        }

        const response = await fetch(projectAssetPath(activeProjectId, controlsUrl));
        if (!response.ok) {
          return;
        }
        const document = (await response.json()) as SceneControlsDocument;
        if (!cancelled) {
          setControlsDoc(document);
        }
      } catch {
        if (!cancelled) {
          setControlsDoc(null);
        }
      }
    }

    void loadControls();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, "stats.json"));
        if (!response.ok) {
          return;
        }
        const stats = (await response.json()) as BundleStats;
        if (!cancelled) {
          setBundleStats(stats);
        }
      } catch {
        if (!cancelled) {
          setBundleStats(null);
        }
      }
    }

    void loadStats();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadOptimization() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, "optimization.json"));
        if (!response.ok) {
          return;
        }
        const optimization = (await response.json()) as OptimizationDocument;
        if (!cancelled) {
          setOptimizationDoc(optimization);
        }
      } catch {
        if (!cancelled) {
          setOptimizationDoc(null);
        }
      }
    }

    void loadOptimization();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), 1400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedView = useMemo(
    () => manifest?.views.find((view) => view.id === selectedViewId),
    [manifest, selectedViewId]
  );

  const rooms = useMemo(() => manifest?.rooms ?? [], [manifest]);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomId) ?? rooms[0],
    [rooms, selectedRoomId]
  );
  const walkViewCount = useMemo(
    () => manifest?.views.filter((view) => view.kind === "walk").length ?? 0,
    [manifest]
  );
  const topViewCount = useMemo(
    () => manifest?.views.filter((view) => view.kind === "top").length ?? 0,
    [manifest]
  );
  const linkedRoomViewCount = useMemo(() => {
    const linkedViewIds = new Set(rooms.map((room) => room.viewId).filter(Boolean));
    return manifest?.views.filter((view) => view.kind === "walk" && linkedViewIds.has(view.id)).length ?? 0;
  }, [manifest, rooms]);
  const roomBoundsCount = useMemo(() => rooms.filter((room) => Boolean(room.bounds)).length, [rooms]);
  const roomWalkZoneCount = useMemo(
    () => (manifest ? enabledNavigationZones(manifest.navigation, "walk").length : 0),
    [manifest]
  );
  const roomSetupSteps = useMemo(() => {
    const roomCount = rooms.length;
    const hasNavigationBounds = Boolean(manifest?.navigation.bounds);
    return [
      {
        id: "labels",
        label: "Room labels",
        detail: roomCount > 0 ? `${roomCount} room${roomCount === 1 ? "" : "s"} named` : "No rooms yet",
        status: roomCount > 0 ? "ready" : "warning",
        action: roomCount > 0 ? "Labels OK" : "Sync or Add"
      },
      {
        id: "regions",
        label: "Floorplan regions",
        detail: roomBoundsCount > 0
          ? `${roomBoundsCount}/${roomCount} mapped`
          : "No room areas on top view",
        status: roomCount > 0 && roomBoundsCount >= roomCount ? "ready" : "warning",
        action: roomWalkZoneCount > 0 ? "From Walks" : "Draw Walk Areas"
      },
      {
        id: "views",
        label: "Room buttons",
        detail: walkViewCount > 0
          ? `${linkedRoomViewCount}/${walkViewCount} walk view${walkViewCount === 1 ? "" : "s"} linked`
          : "No walk views to link",
        status: walkViewCount > 0 && linkedRoomViewCount >= walkViewCount ? "ready" : "warning",
        action: walkViewCount > 0 ? "Sync Views" : "Set Views"
      },
      {
        id: "bounds",
        label: "Top-view bounds",
        detail: hasNavigationBounds ? "Room map is enabled" : "Set bounds to use map",
        status: hasNavigationBounds ? "ready" : "warning",
        action: hasNavigationBounds ? "Bounds OK" : "Fix Bounds"
      },
      {
        id: "walks",
        label: "Walk areas",
        detail: roomWalkZoneCount > 0
          ? `${roomWalkZoneCount} walk area${roomWalkZoneCount === 1 ? "" : "s"} available`
          : "No walk areas to sync",
        status: roomWalkZoneCount > 0 ? "ready" : "warning",
        action: roomWalkZoneCount > 0 ? "Sync Regions" : "Fix Walk Areas"
      }
    ];
  }, [
    linkedRoomViewCount,
    manifest?.navigation.bounds,
    roomBoundsCount,
    roomWalkZoneCount,
    rooms.length,
    walkViewCount
  ]);
  const selectedRoomWalkabilitySteps = useMemo(() => {
    if (!manifest || !selectedRoom) {
      return [];
    }
    const linkedView = selectedRoom.viewId
      ? manifest.views.find((view) => view.id === selectedRoom.viewId)
      : undefined;
    const routeZones = [
      ...enabledNavigationZones(manifest.navigation, "walk"),
      ...enabledNavigationZones(manifest.navigation, "pass")
    ];
    const blockZones = enabledNavigationZones(manifest.navigation, "block");
    const routeComponents = navigationComponents(routeZones);
    const selectedCenter = roomCenter(selectedRoom, manifest.views);
    const componentForPoint = (point: Vec3 | undefined) =>
      point ? routeComponents.find((component) => component.some((zone) => pointInNavigationZone(zone, point, 0.35))) : undefined;
    const centerComponent = componentForPoint(selectedCenter);
    const viewComponent = componentForPoint(linkedView?.position);
    const centerBlocked = blockZones.some((zone) => pointInNavigationZone(zone, selectedCenter, 0.15));
    const viewBlocked = linkedView
      ? blockZones.some((zone) => pointInNavigationZone(zone, linkedView.position, 0.15))
      : false;
    const centerInsideBounds = pointInNavigationBounds(selectedCenter, manifest.navigation.bounds, 0.05);
    const viewInsideBounds = linkedView
      ? pointInNavigationBounds(linkedView.position, manifest.navigation.bounds, 0.05)
      : false;
    const sameRouteIsland = Boolean(centerComponent && viewComponent && centerComponent === viewComponent);
    return [
      {
        id: "button",
        label: "Room button",
        detail: linkedView ? `Linked to ${linkedView.label}.` : "No walk view linked.",
        status: linkedView ? "ready" : "warning",
        action: linkedView ? "Button OK" : "Link View"
      },
      {
        id: "floor",
        label: "Clickable floor",
        detail: centerBlocked
          ? "Room center is inside a blocker."
          : centerComponent
            ? "Room center sits on walk/pass area."
            : "Room center is outside walk areas.",
        status: centerComponent && !centerBlocked ? "ready" : "warning",
        action: centerComponent && !centerBlocked ? "Floor OK" : "Fix Floor"
      },
      {
        id: "route",
        label: "Door route",
        detail: !linkedView
          ? "Link a walk view before testing routes."
          : viewBlocked
            ? "Linked view starts inside a blocker."
            : sameRouteIsland
              ? "Room and view share a route island."
              : "Room and view are on separate route islands.",
        status: linkedView && sameRouteIsland && !viewBlocked ? "ready" : "warning",
        action: linkedView && sameRouteIsland && !viewBlocked ? "Route OK" : "Repair Route"
      },
      {
        id: "map",
        label: "Floorplan area",
        detail: selectedRoom.bounds
          ? "Room has a top-view region."
          : !centerInsideBounds || (linkedView && !viewInsideBounds)
            ? "Room/view sits outside navigation bounds."
            : "No top-view region drawn.",
        status: selectedRoom.bounds && centerInsideBounds && (!linkedView || viewInsideBounds) ? "ready" : "warning",
        action: selectedRoom.bounds ? "Area OK" : roomWalkZoneCount > 0 ? "From Walks" : "Set Bounds"
      }
    ];
  }, [manifest, roomWalkZoneCount, selectedRoom]);

  const hotspotInteractions = useMemo(
    () => manifest?.interactions.filter(isHotspot) ?? [],
    [manifest]
  );

  const linkInteractions = useMemo(
    () => manifest?.interactions.filter(isLink) ?? [],
    [manifest]
  );

  const objectToggleInteractions = useMemo(
    () => manifest?.interactions.filter(isObjectToggle) ?? [],
    [manifest]
  );

  const videoTextureInteractions = useMemo(
    () => manifest?.interactions.filter(isVideoTexture) ?? [],
    [manifest]
  );

  const materialVariantInteractions = useMemo(
    () => manifest?.interactions.filter(isMaterialVariantInteraction) ?? [],
    [manifest]
  );
  const navigationIssues = useMemo(
    () => (manifest ? navigationQaIssues(manifest, controlsDoc?.movement.collisionRadius ?? 0.28) : []),
    [controlsDoc?.movement.collisionRadius, manifest]
  );
  const navigationCoverageSummary = useMemo(() => (manifest ? navigationCoverage(manifest) : null), [manifest]);
  const movementSetupSteps = useMemo(() => {
    const movement = controlsDoc?.movement;
    const hasWalkAreas = (navigationCoverageSummary?.walkZones ?? 0) > 0;
    const hasBounds = Boolean(manifest?.navigation.bounds);
    const comfort = manifest
      ? movementComfortStatus(controlsDoc, manifest)
      : { tone: "blocked" as const };
    const wheelSpeed = movement?.wheelMoveSpeed ?? 0;
    return [
      {
        id: "movement",
        label: "Movement",
        detail: movement?.enabled ? "Viewer movement is enabled" : "Viewer movement is off",
        status: movement?.enabled ? "ready" : "warning",
        action: movement?.enabled ? "Movement OK" : "Enable"
      },
      {
        id: "keyboard",
        label: "WASD",
        detail: movement?.keyboard ? "Keyboard walking is enabled" : "Keyboard walking is off",
        status: movement?.keyboard ? "ready" : "warning",
        action: movement?.keyboard ? "WASD OK" : "Enable WASD"
      },
      {
        id: "click",
        label: "Click-to-move",
        detail:
          movement?.clickToMove && hasWalkAreas
            ? `${navigationCoverageSummary?.walkZones ?? 0} walk area${(navigationCoverageSummary?.walkZones ?? 0) === 1 ? "" : "s"}`
            : movement?.clickToMove
              ? "Needs walk areas"
              : "Click movement is off",
        status: movement?.clickToMove && hasWalkAreas ? "ready" : "warning",
        action: movement?.clickToMove ? "View Walks" : "Enable Click"
      },
      {
        id: "look-wheel",
        label: "Look & wheel",
        detail:
          movement?.dragLook && wheelSpeed > 0
            ? `Drag look and wheel glide ${wheelSpeed}`
            : "Mouse drag or wheel glide needs setup",
        status: movement?.dragLook && wheelSpeed > 0 ? "ready" : "warning",
        action: movement?.dragLook && wheelSpeed > 0 ? "Input OK" : "Enable"
      },
      {
        id: "collision",
        label: "Walls & bounds",
        detail: hasBounds
          ? comfort.tone === "warning"
            ? "Movement comfort needs tuning"
            : "Bounds and collision are configured"
          : "No movement bounds yet",
        status: hasBounds && comfort.tone !== "warning" ? "ready" : "warning",
        action: hasBounds ? (comfort.tone === "warning" ? "Ridge Safe" : "Collision OK") : "Auto Fix"
      }
    ];
  }, [controlsDoc, manifest, navigationCoverageSummary?.walkZones]);
  const viewSetupSteps = useMemo(() => {
    const viewCount = manifest?.views.length ?? 0;
    const coveredWalkViews = navigationCoverageSummary?.coveredWalkViews ?? 0;
    return [
      {
        id: "saved",
        label: "Saved views",
        detail: viewCount > 0 ? `${viewCount} view${viewCount === 1 ? "" : "s"} configured` : "No camera views yet",
        status: viewCount > 0 ? "ready" : "warning",
        action: viewCount > 0 ? "Views OK" : "Add View"
      },
      {
        id: "walk",
        label: "Walk views",
        detail: walkViewCount > 0 ? `${walkViewCount} walk start${walkViewCount === 1 ? "" : "s"}` : "No walkthrough starts",
        status: walkViewCount > 0 ? "ready" : "warning",
        action: walkViewCount > 0 ? "Walk OK" : "Add Walk"
      },
      {
        id: "top",
        label: "Top view",
        detail: topViewCount > 0 ? `${topViewCount} top/floorplan view${topViewCount === 1 ? "" : "s"}` : "No top view yet",
        status: topViewCount > 0 ? "ready" : "warning",
        action: topViewCount > 0 ? "Top OK" : "Create Top"
      },
      {
        id: "rooms",
        label: "Room links",
        detail:
          walkViewCount > 0
            ? `${linkedRoomViewCount}/${walkViewCount} linked to rooms`
            : "Add walk views before room links",
        status: walkViewCount > 0 && linkedRoomViewCount >= walkViewCount ? "ready" : "warning",
        action: walkViewCount > 0 ? "Sync Rooms" : "Add Walk"
      },
      {
        id: "zones",
        label: "Walk coverage",
        detail:
          walkViewCount > 0
            ? `${coveredWalkViews}/${walkViewCount} inside walk areas`
            : roomWalkZoneCount > 0
              ? `${roomWalkZoneCount} walk area${roomWalkZoneCount === 1 ? "" : "s"} available`
              : "No walk coverage yet",
        status: walkViewCount > 0 && coveredWalkViews >= walkViewCount ? "ready" : "warning",
        action: walkViewCount > 0 ? "Create Zones" : "Fix Walk Areas"
      }
    ];
  }, [
    linkedRoomViewCount,
    manifest?.views.length,
    navigationCoverageSummary?.coveredWalkViews,
    roomWalkZoneCount,
    topViewCount,
    walkViewCount
  ]);
  const viewerRepairCanBridgeIslands =
    navigationRepairDraft?.reason === "route-not-found" &&
    (navigationCoverageSummary?.routeComponents ?? 0) > 1;
  const navigationZones = useMemo(() => manifest?.navigation.zones ?? [], [manifest]);
  const generatedNavigationZoneCount = useMemo(
    () => navigationZones.filter((zone) => zone.source === "generated").length,
    [navigationZones]
  );
  const visibleNavigationZones = useMemo(
    () =>
      showGeneratedNavigationZones
        ? navigationZones
        : navigationZones.filter((zone) => zone.source !== "generated"),
    [navigationZones, showGeneratedNavigationZones]
  );
  const navigationZoneSetupSteps = useMemo(() => {
    const activeZones = navigationZones.filter((zone) => zone.enabled !== false);
    const walkCount = activeZones.filter((zone) => zone.kind === "walk").length;
    const passCount = activeZones.filter((zone) => zone.kind === "pass").length;
    const blockCount = activeZones.filter((zone) => zone.kind === "block").length;
    const manualCount = activeZones.filter((zone) => zone.source !== "generated").length;
    const disconnectedCount = Math.max(0, (navigationCoverageSummary?.routeComponents ?? 0) - 1);
    return [
      {
        id: "walk",
        label: "Clickable floor",
        detail: walkCount > 0
          ? `${walkCount} walk area${walkCount === 1 ? "" : "s"} active`
          : "Draw where visitors can stand or click.",
        status: walkCount > 0 ? "ready" : "warning",
        action: walkCount > 0 ? "Review Walks" : "Draw Walk"
      },
      {
        id: "pass",
        label: "Door connectors",
        detail: disconnectedCount > 0
          ? `${disconnectedCount + 1} route islands need passes`
          : passCount > 0
            ? `${passCount} pass area${passCount === 1 ? "" : "s"} active`
            : "Add passes through doors or tight openings.",
        status: disconnectedCount > 0 ? "warning" : passCount > 0 ? "ready" : "warning",
        action: disconnectedCount > 0 || passCount === 0 ? "Draw Pass" : "Passes OK"
      },
      {
        id: "block",
        label: "Hard boundaries",
        detail: blockCount > 0
          ? `${blockCount} blocker${blockCount === 1 ? "" : "s"} keep movement inside`
          : manifest?.navigation.bounds
            ? "Add boundary blockers to stop outside movement."
            : "Set movement bounds before blockers.",
        status: blockCount > 0 ? "ready" : "warning",
        action: blockCount > 0 ? "Review Blocks" : manifest?.navigation.bounds ? "Create Boundary" : "Set Bounds"
      },
      {
        id: "auto",
        label: "Auto detection",
        detail: generatedNavigationZoneCount > 0
          ? `${generatedNavigationZoneCount} generated zone${generatedNavigationZoneCount === 1 ? "" : "s"} ${showGeneratedNavigationZones ? "visible" : "hidden"}`
          : manualCount > 0
            ? `${manualCount} manual zone${manualCount === 1 ? "" : "s"} active`
            : "Run Auto Fix or draw zones manually.",
        status: generatedNavigationZoneCount > 0 || manualCount > 0 ? "active" : "warning",
        action: generatedNavigationZoneCount > 0 ? "Inspect Auto" : "Auto Fix"
      }
    ];
  }, [
    generatedNavigationZoneCount,
    manifest?.navigation.bounds,
    navigationCoverageSummary?.routeComponents,
    navigationZones,
    showGeneratedNavigationZones
  ]);
  const repairRecommendation = useMemo(
    () => (navigationRepairDraft ? navigationRepairRecommendation(navigationRepairDraft) : null),
    [navigationRepairDraft]
  );
  const narrowBodyRepairRadius = useMemo(() => {
    const radius = navigationRepairDraft?.bodyRadius ?? controlsDoc?.movement.collisionRadius;
    if (navigationRepairDraft?.reason !== "blocked-collision" || typeof radius !== "number" || radius <= 0.22) {
      return null;
    }
    return Number(clampNumber(radius - 0.06, 0.18, 0.24).toFixed(2));
  }, [controlsDoc?.movement.collisionRadius, navigationRepairDraft?.bodyRadius, navigationRepairDraft?.reason]);
  const navigationRepairObjectMatch = useMemo(() => {
    const matchName = navigationRepairDraft?.blockerName || navigationRepairDraft?.objectName;
    if (!matchName || !objectsDoc) {
      return null;
    }
    const blocker = normalizedObjectMatchName(matchName);
    const sceneNode = sceneGraph?.nodes.find((node) => {
      const names = [node.id, node.name, node.meshName ?? ""].map(normalizedObjectMatchName);
      return names.some(
        (name) =>
          name === blocker ||
          (name.length >= 4 && blocker.includes(name)) ||
          (blocker.length >= 4 && name.includes(blocker))
      );
    });
    const objectBySceneNode = sceneNode
      ? objectsDoc.objects.find((object) => object.id === sceneNode.id || object.name === sceneNode.name)
      : undefined;
    const objectByName = objectsDoc.objects.find((object) => objectMatchesBlockerName(object, matchName));
    const object = objectBySceneNode ?? objectByName;
    return object ? { object, sceneNode } : null;
  }, [navigationRepairDraft?.blockerName, navigationRepairDraft?.objectName, objectsDoc, sceneGraph]);
  const repairDiagnosis = useMemo(
    () =>
      navigationRepairDraft
        ? navigationRepairDiagnosis(
            navigationRepairDraft,
            navigationCoverageSummary,
            Boolean(navigationRepairObjectMatch),
            narrowBodyRepairRadius
          )
        : null,
    [navigationCoverageSummary, navigationRepairDraft, navigationRepairObjectMatch, narrowBodyRepairRadius]
  );
  const primaryNavigationIssue = useMemo(
    () => navigationIssues.find((issue) => issue.severity !== "info"),
    [navigationIssues]
  );
  const navigationRepairPathSteps = useMemo(
    () =>
      manifest && navigationCoverageSummary
        ? navigationRepairPath(manifest, navigationCoverageSummary, primaryNavigationIssue)
        : [],
    [manifest, navigationCoverageSummary, primaryNavigationIssue]
  );
  const doorwayNavigationSteps = useMemo(() => {
    const routeIssue = navigationIssues.find((issue) => issue.id === "disconnected-route-zones");
    const passIssue = navigationIssues.find(
      (issue) =>
        issue.id === "missing-pass-zones" ||
        issue.id.startsWith("one-sided-pass-") ||
        issue.id.startsWith("orphan-pass-")
    );
    const narrowIssue = navigationIssues.find((issue) => issue.id.startsWith("narrow-pass-"));
    const blockerIssue = navigationIssues.find(
      (issue) => issue.id.startsWith("blocked-pass-") || issue.id.startsWith("blocked-walk-")
    );
    const boundsIssue = navigationIssues.find(
      (issue) => issue.id.startsWith("walk-zone-bounds-") || issue.id.startsWith("pass-zone-bounds-")
    );
    const narrowCount = navigationIssues.filter((issue) => issue.id.startsWith("narrow-pass-")).length;
    const blockedCount = navigationIssues.filter(
      (issue) => issue.id.startsWith("blocked-pass-") || issue.id.startsWith("blocked-walk-")
    ).length;
    const passRepairCount = navigationIssues.filter(
      (issue) =>
        issue.id === "missing-pass-zones" ||
        issue.id.startsWith("one-sided-pass-") ||
        issue.id.startsWith("orphan-pass-")
    ).length;
    const boundsCount = navigationIssues.filter(
      (issue) => issue.id.startsWith("walk-zone-bounds-") || issue.id.startsWith("pass-zone-bounds-")
    ).length;
    return [
      {
        id: "islands",
        label: "Route islands",
        detail:
          (navigationCoverageSummary?.routeComponents ?? 0) > 1
            ? `${navigationCoverageSummary?.routeComponents ?? 0} disconnected route islands`
            : "Walk and pass areas are connected",
        status: routeIssue ? "warning" : "ready",
        issue: routeIssue,
        action: routeIssue ? "Auto Bridge" : "Connected"
      },
      {
        id: "passes",
        label: "Door passes",
        detail: passRepairCount > 0
          ? `${passRepairCount} connector issue${passRepairCount === 1 ? "" : "s"}`
          : `${navigationCoverageSummary?.passZones ?? 0} door pass${(navigationCoverageSummary?.passZones ?? 0) === 1 ? "" : "es"}`,
        status: passIssue ? "warning" : "ready",
        issue: passIssue,
        action: passIssue ? "Draw Door Pass" : "Passes OK"
      },
      {
        id: "clearance",
        label: "Door clearance",
        detail: narrowCount > 0
          ? `${narrowCount} narrow pass${narrowCount === 1 ? "" : "es"}`
          : `Body radius ${(controlsDoc?.movement.collisionRadius ?? 0.28).toFixed(2)}`,
        status: narrowIssue ? "warning" : "ready",
        issue: narrowIssue,
        action: narrowIssue ? "Widen Passes" : "Clearance OK"
      },
      {
        id: "blockers",
        label: "Blockers",
        detail: blockedCount > 0
          ? `${blockedCount} overlap${blockedCount === 1 ? "" : "s"} near walk/pass zones`
          : "No blocker overlap in routes",
        status: blockerIssue ? "warning" : "ready",
        issue: blockerIssue,
        action: blockerIssue ? "Review Blockers" : "Clear"
      },
      {
        id: "bounds",
        label: "Bounds",
        detail: boundsCount > 0
          ? `${boundsCount} reachable zone${boundsCount === 1 ? "" : "s"} outside bounds`
          : "Reachable zones are inside bounds",
        status: boundsIssue ? "warning" : "ready",
        issue: boundsIssue,
        action: boundsIssue ? "Fit Bounds" : "Bounds OK"
      }
    ];
  }, [controlsDoc?.movement.collisionRadius, navigationCoverageSummary, navigationIssues]);
  const navigationQuickFix = useMemo(
    () => navigationQuickFixForIssue(primaryNavigationIssue),
    [primaryNavigationIssue]
  );
  const publishChecks = useMemo<PublishCheck[]>(() => {
    const errorDiagnostics = bundleStats?.diagnostics?.filter((diagnostic) => diagnostic.severity === "error") ?? [];
    const publishBlockers = bundleStats?.publishReadiness?.blockers ?? [];
    const publishWarnings = bundleStats?.publishReadiness?.warnings ?? [];
    const navigationErrorCount = navigationIssues.filter((issue) => issue.severity === "error").length;
    return [
      {
        id: "views",
        label: "Starting views",
        ready: (manifest?.views.length ?? 0) > 0,
        detail: `${manifest?.views.length ?? 0} configured`,
        blocking: true,
        action: "views"
      },
      {
        id: "assets",
        label: "Referenced assets",
        ready: (bundleStats?.missingAssetCount ?? 0) === 0,
        detail:
          bundleStats && bundleStats.missingAssetCount > 0
            ? `${bundleStats.missingAssetCount} missing`
            : "All present",
        blocking: true,
        action: "repair"
      },
      {
        id: "diagnostics",
        label: "Blocking diagnostics",
        ready: errorDiagnostics.length === 0,
        detail: errorDiagnostics.length > 0 ? `${errorDiagnostics.length} error(s)` : "No errors",
        blocking: true,
        action: errorDiagnostics[0] ? importActionForDiagnostic(errorDiagnostics[0].code) ?? "review" : "review"
      },
      {
        id: "navigation",
        label: "Navigation hard checks",
        ready: navigationErrorCount === 0,
        detail: navigationErrorCount > 0 ? `${navigationErrorCount} error(s)` : "No errors",
        blocking: true,
        action: "navigation"
      },
      {
        id: "production",
        label: "Production quality gate",
        ready: Boolean(bundleStats) && publishBlockers.length === 0,
        detail: !bundleStats
          ? "Run analysis"
          : publishBlockers.length > 0
            ? `${publishBlockers.length} blocker(s)`
            : bundleStats.publishReadiness?.status === "warning"
              ? `${bundleStats.publishReadiness.warnings.length} warning(s)`
              : "Ready",
        blocking: true,
        action: publishBlockers[0]
          ? publishActionForIssue(publishBlockers[0].code) ?? "review"
          : bundleStats?.publishReadiness?.warnings[0]
            ? publishActionForIssue(bundleStats.publishReadiness.warnings[0].code) ?? "review"
            : "review"
      },
      {
        id: "client-warnings",
        label: "Client delivery warnings",
        ready: Boolean(bundleStats) && publishWarnings.length === 0,
        detail: !bundleStats
          ? "Run analysis"
          : publishWarnings.length > 0
            ? `${publishWarnings.length} warning(s): ${publishWarnings[0]?.title ?? "Review publish warnings"}`
            : "No warnings",
        action: publishWarnings[0] ? publishActionForIssue(publishWarnings[0].code) ?? "review" : "review"
      },
      {
        id: "geometry",
        label: "Geometry compression",
        ready: geometryCompressionLabel(bundleStats) !== "None",
        detail: geometryCompressionLabel(bundleStats),
        action: "optimize"
      },
      {
        id: "texture",
        label: "Texture transfer compression",
        ready: textureCompressionLabel(bundleStats) !== "None" || (bundleStats?.imageCount ?? 0) === 0,
        detail: (bundleStats?.imageCount ?? 0) === 0 ? "No textures" : textureCompressionLabel(bundleStats),
        action: "optimize"
      }
    ];
  }, [bundleStats, manifest, navigationIssues]);
  const hasBlockingPublishErrors = publishChecks.some((check) => check.blocking && !check.ready);
  const publishWarningCount = bundleStats?.publishReadiness?.warnings.length ?? 0;
  const hasPublishWarnings = publishWarningCount > 0;
  const publishPrimaryActionLabel =
    publishState === "publishing" ? "Publishing" : hasPublishWarnings ? "Publish Draft" : "Publish";
  const firstPublishCheckIssue = publishChecks.find((check) => check.blocking && !check.ready) ?? publishChecks.find((check) => !check.ready);
  const firstPublishGateIssue =
    bundleStats?.publishReadiness?.blockers[0] ?? bundleStats?.publishReadiness?.warnings[0];
  const latestPublishedEntry = publishHistory?.versions[0];
  const activePublishedEntry = publishHistory?.activeVersion
    ? publishHistory.versions.find((entry) => entry.version === publishHistory.activeVersion)
    : undefined;
  const activeLiveDeliveryMode = activePublishedEntry
    ? publishEntryDeliveryMode(activePublishedEntry)
    : publishHistory?.activeDeliveryMode;
  const activeLiveIsDraft = Boolean(publishHistory?.activeVersion) && (
    activePublishedEntry
      ? activePublishedEntry.qualityGate?.status !== "ready"
      : publishHistory?.activatedAsDraft === true || publishHistory?.activeQualityGate?.status !== "ready"
  );
  const publishHandoffEntry = activePublishedEntry ?? latestPublishedEntry;
  const publishHandoffSteps = useMemo<PublishHandoffStep[]>(() => {
    const hasPublishedVersion = Boolean(latestPublishedEntry);
    const hasLiveVersion = Boolean(activePublishedEntry);
    const deploymentReady = Boolean(publishHandoffEntry?.deploymentPath);
    return [
      {
        id: "gate",
        label: "Quality gate",
        detail: hasBlockingPublishErrors
          ? firstPublishCheckIssue
            ? `${firstPublishCheckIssue.label}: ${firstPublishCheckIssue.detail}`
            : "Clear publish blockers before making a client link."
          : hasPublishWarnings
            ? `${publishWarningCount} client warning${publishWarningCount === 1 ? "" : "s"} remain: ${firstPublishGateIssue?.title ?? "review publish warnings"}.`
            : "No blocking rows or client warnings are open.",
        status: hasBlockingPublishErrors ? "blocked" : hasPublishWarnings ? "warning" : "ready",
        actionLabel: hasBlockingPublishErrors ? "Fix First" : hasPublishWarnings ? "Copy Warnings" : "Copy Report"
      },
      {
        id: "draft",
        label: "Draft test",
        detail: hasBlockingPublishErrors
          ? "Use the draft viewer to inspect fixes before publishing."
          : hasPublishWarnings
            ? "Open the current viewer as a draft and confirm each warning is acceptable before client delivery."
            : "Open the current viewer and test movement, rooms, lights, and screens.",
        status: hasBlockingPublishErrors ? "active" : hasPublishWarnings ? "warning" : "ready",
        actionLabel: "Open Draft"
      },
      {
        id: "version",
        label: "Version",
        detail: hasPublishedVersion
          ? `Latest static bundle is ${latestPublishedEntry?.version ?? "ready"}.`
          : hasPublishWarnings
            ? "Create a warning-marked draft bundle for internal QA before client delivery."
            : "Create the versioned static bundle clients can open.",
        status: publishState === "publishing" ? "active" : hasPublishedVersion ? "ready" : hasBlockingPublishErrors ? "blocked" : "todo",
        actionLabel:
          publishState === "publishing"
            ? "Publishing"
            : hasPublishWarnings
              ? hasPublishedVersion
                ? "Publish Draft Again"
                : "Publish Draft"
              : hasPublishedVersion
                ? "Publish Again"
                : "Publish"
      },
      {
        id: "live",
        label: "Live link",
        detail: hasLiveVersion
          ? `Clients open ${activePublishedEntry?.version ?? publishHistory?.activeVersion}.`
          : hasPublishedVersion
            ? latestPublishedEntry?.qualityGate?.status === "ready"
              ? "Set the latest version as the live client link."
              : "Latest version is still a draft; only set it live if the warnings are accepted."
            : "Publish a version before choosing a live link.",
        status: hasLiveVersion ? "ready" : hasPublishedVersion ? "todo" : "blocked",
        actionLabel: hasLiveVersion ? "Copy Link" : hasPublishedVersion ? setLiveActionLabel(latestPublishedEntry) : "Waiting"
      },
      {
        id: "package",
        label: "Deploy package",
        detail: deploymentReady
          ? "Deployment path and checklist are ready to hand off."
          : hasPublishedVersion
            ? "Open the version details after publish to confirm deploy metadata."
            : "Publish once to generate deploy metadata.",
        status: deploymentReady ? "ready" : hasPublishedVersion ? "todo" : "blocked",
        actionLabel: deploymentReady ? "Copy Checklist" : hasPublishedVersion ? "Review Version" : "Waiting"
      }
    ];
  }, [
    activePublishedEntry,
    firstPublishCheckIssue,
    firstPublishGateIssue?.title,
    hasBlockingPublishErrors,
    hasPublishWarnings,
    latestPublishedEntry,
    latestPublishedEntry?.qualityGate?.status,
    publishHandoffEntry?.deploymentPath,
    publishHistory?.activeVersion,
    publishWarningCount,
    publishState
  ]);
  const publishHostingSteps = useMemo<HostingHandoffStep[]>(() => {
    const hasPublishedVersion = Boolean(publishHandoffEntry);
    const hasDeploymentPath = Boolean(publishHandoffEntry?.deploymentPath);
    const packageStatus: ClientDeliveryStep["status"] = hasDeploymentPath
      ? "ready"
      : hasPublishedVersion
        ? "todo"
        : "blocked";
    return [
      {
        id: "validate",
        label: "Validate bundle",
        detail: hasDeploymentPath
          ? "Dry-run command is ready for CI or local QA."
          : hasPublishedVersion
            ? "Republish if deployment metadata is missing."
            : "Publish a version before validating delivery.",
        status: packageStatus,
        actionLabel: hasDeploymentPath ? "Copy Validate" : "Waiting"
      },
      {
        id: "local",
        label: "Local package",
        detail: hasDeploymentPath
          ? "Copy a command that prepares a static deploy folder."
          : "Create a versioned package before local deploy.",
        status: packageStatus,
        actionLabel: hasDeploymentPath ? "Copy Local" : "Waiting"
      },
      {
        id: "bucket",
        label: "S3/R2 upload",
        detail: hasDeploymentPath
          ? "Copy an object-storage upload command for production."
          : "Publish first, then choose bucket credentials outside Studio.",
        status: packageStatus,
        actionLabel: hasDeploymentPath ? "Copy Upload" : "Waiting"
      },
      {
        id: "cache",
        label: "CDN cache",
        detail: hasDeploymentPath
          ? "Copy upload with immutable cache headers for heavy assets."
          : "Cache headers can be prepared after the package exists.",
        status: packageStatus,
        actionLabel: hasDeploymentPath ? "Copy Cache" : "Waiting"
      },
      {
        id: "domain",
        label: "Domain handoff",
        detail: hasDeploymentPath
          ? "Copy the client checklist for launch URL, embed, and QA."
          : "Custom domains need the published checklist first.",
        status: hasDeploymentPath ? "ready" : hasPublishedVersion ? "todo" : "blocked",
        actionLabel: hasDeploymentPath ? "Copy Handoff" : "Waiting"
      }
    ];
  }, [publishHandoffEntry]);
  const clientDeliverySteps = useMemo<ClientDeliveryStep[]>(() => {
    const hasPublishedVersion = Boolean(latestPublishedEntry);
    const hasLiveVersion = Boolean(activePublishedEntry);
    return [
      {
        id: "readiness",
        label: "1. Clear blockers",
        detail: hasBlockingPublishErrors
          ? firstPublishCheckIssue
            ? `${firstPublishCheckIssue.label}: ${firstPublishCheckIssue.detail}`
            : "Fix the blocking readiness rows before sharing."
          : firstPublishCheckIssue
            ? `${firstPublishCheckIssue.label}: ${firstPublishCheckIssue.detail}`
            : hasPublishWarnings
              ? `${publishWarningCount} client warning${publishWarningCount === 1 ? "" : "s"} remain.`
              : "No blocking publish rows or client warnings are open.",
        status: hasBlockingPublishErrors ? "blocked" : hasPublishWarnings ? "warning" : "ready",
        actionLabel: hasBlockingPublishErrors ? "Open Repair Center" : hasPublishWarnings ? "Copy Warnings" : "Copy Readiness"
      },
      {
        id: "version",
        label: "2. Create version",
        detail: hasPublishedVersion
          ? `Latest bundle: ${latestPublishedEntry?.version ?? "published"}`
          : hasPublishWarnings
            ? "Create a draft bundle for internal QA; warnings remain before client handoff."
            : "Create a static bundle that can be opened, embedded, or deployed.",
        status: publishState === "publishing" ? "active" : hasPublishedVersion ? "ready" : "todo",
        actionLabel: publishPrimaryActionLabel
      },
      {
        id: "live",
        label: "3. Set live link",
        detail: hasLiveVersion
          ? `Live version: ${activePublishedEntry?.version ?? publishHistory?.activeVersion}`
          : hasPublishedVersion
            ? latestPublishedEntry?.qualityGate?.status === "ready"
              ? "Choose the version clients should see by default."
              : "Latest bundle is still a draft; do not make it live until warnings are accepted."
            : "Publish one version before setting the live link.",
        status: hasLiveVersion ? "ready" : hasPublishedVersion ? "todo" : "blocked",
        actionLabel: hasLiveVersion ? "Copy Live Link" : hasPublishedVersion ? setLiveActionLabel(latestPublishedEntry) : "Waiting"
      },
      {
        id: "client-test",
        label: "4. Test as client",
        detail: hasLiveVersion
          ? "Open the live viewer and test movement, rooms, top view, screens, lighting, and mobile."
          : hasPublishedVersion
            ? "Open the latest published draft exactly as a reviewer would see it before setting it live."
            : "Use the editable draft viewer until a published version exists.",
        status: hasLiveVersion && !hasBlockingPublishErrors && !hasPublishWarnings ? "ready" : hasLiveVersion ? "active" : "todo",
        actionLabel: hasLiveVersion ? "Open Live Viewer" : hasPublishedVersion ? "Open Published Draft" : "Open Draft Viewer"
      }
    ];
  }, [
    activePublishedEntry,
    firstPublishCheckIssue,
    hasBlockingPublishErrors,
    hasPublishWarnings,
    latestPublishedEntry,
    publishHistory?.activeVersion,
    publishPrimaryActionLabel,
    publishWarningCount,
    publishState
  ]);
  const environmentSetupSteps = useMemo(() => {
    const environment = manifest?.environment;
    const skyEnabled = environment?.skyBackdropEnabled ?? true;
    const groundEnabled = environment?.groundEnabled ?? true;
    const enclosureEnabled = environment?.enclosureEnabled ?? true;
    const groundY = environment?.groundY ?? -0.04;
    const groundSize = environment?.groundSize ?? 90;
    const enclosureRadius = environment?.enclosureRadius ?? 44;
    const isReviewMode = skyEnabled === false && groundEnabled === false && enclosureEnabled === false;
    return [
      {
        id: "sky",
        label: "Sky backdrop",
        detail: skyEnabled ? "Window background is visible" : "Neutral review background",
        status: skyEnabled || isReviewMode ? "ready" : "warning",
        action: skyEnabled ? "Sky OK" : "Interior"
      },
      {
        id: "outside",
        label: "Outside ground",
        detail: groundEnabled ? `Ground ${groundSize}m wide` : "No grass/ground plane",
        status: groundEnabled || isReviewMode ? "ready" : "warning",
        action: groundEnabled ? "Ground OK" : "Exterior"
      },
      {
        id: "enclosure",
        label: "Landscape wall",
        detail: enclosureEnabled ? `Radius ${enclosureRadius}m` : "No outside enclosure",
        status: enclosureEnabled || isReviewMode ? "ready" : "warning",
        action: enclosureEnabled ? "Enclosure OK" : "Exterior"
      },
      {
        id: "height",
        label: "Ground height",
        detail: `${groundY.toFixed(2)}m relative to model`,
        status: groundY <= 0.1 ? "ready" : "warning",
        action: groundY <= 0.1 ? "Height OK" : "Lower Ground"
      },
      {
        id: "review",
        label: "Review mode",
        detail: isReviewMode ? "Debug background enabled" : "Client backdrop enabled",
        status: isReviewMode ? "active" : "ready",
        action: isReviewMode ? "Reviewing" : "Review"
      }
    ];
  }, [manifest?.environment]);
  const blenderTool = toolStatus?.tools.blender;
  const materialCountForBake = bundleStats?.materialCount ?? materialsDoc?.materials.length ?? 0;
  const lightmappedMaterialCountForBake =
    materialsDoc?.materials.filter((material) => Boolean(material.lightMapUrl)).length ??
    bundleStats?.lightmapMaterialCount ??
    0;
  const hasPartialLightmapCoverageForBake =
    lightmappedMaterialCountForBake > 0 && lightmappedMaterialCountForBake < materialCountForBake;
  const hasCompleteLightmapCoverageForBake =
    materialCountForBake > 0 && lightmappedMaterialCountForBake >= materialCountForBake;
  const estimatedBakeMaterialCount = Math.min(materialCountForBake, bakeSettings.maxMaterials);
  const estimatedBakeTextureBytes =
    estimatedBakeMaterialCount * bakeSettings.resolution * bakeSettings.resolution * 4;
  const bakeMaterialLimitExceeded = materialCountForBake > bakeSettings.maxMaterials;
  const activeBakePresetDefaults = bakePresetDefaults[bakeSettings.preset];
  const bakePresetModified =
    bakeSettings.resolution !== activeBakePresetDefaults.resolution ||
    bakeSettings.samples !== activeBakePresetDefaults.samples ||
    bakeSettings.margin !== activeBakePresetDefaults.margin;
  const bakeSourceQaGroups = bundleStats
    ? sourceQaGroups(bundleStats).filter(
        (group) =>
          group.count > 0 &&
          (group.id === "structure" || group.id === "resources" || group.id === "references")
      )
    : [];
  const bakePreflightIssues: BakePreflightIssue[] = [
    ...bakeSourceQaGroups.map((group) => ({
      severity: group.severity === "error" ? ("error" as const) : ("warning" as const),
      message:
        group.severity === "error"
          ? `Source QA ${group.label}: ${group.count} blocking export issue${group.count === 1 ? "" : "s"} must be fixed before baking.`
          : `Source QA ${group.label}: review ${group.count} source warning${group.count === 1 ? "" : "s"} before baking.`
    })),
    bakeMaterialLimitExceeded
      ? {
          severity: "error",
          message: `${materialCountForBake} materials exceed the current ${bakeSettings.maxMaterials} material bake limit.`
        }
      : undefined,
    estimatedBakeTextureBytes > 2 * 1024 * 1024 * 1024
      ? {
          severity: "error",
          message: `${formatBytes(estimatedBakeTextureBytes)} raw lightmap target is too large for a reliable local bake.`
        }
      : estimatedBakeTextureBytes > 1024 * 1024 * 1024
        ? {
            severity: "warning",
            message: `${formatBytes(estimatedBakeTextureBytes)} raw lightmap target can make Blender slow or unstable.`
          }
        : undefined,
    bakeSettings.resolution >= 4096
      ? {
          severity: "warning",
          message: "4096px lightmaps are expensive; use them only for final hero scenes."
        }
      : undefined,
    bakeSettings.samples >= 384
      ? {
          severity: "warning",
          message: "Super sample counts can take a long time on CPU or weak GPUs."
        }
      : undefined,
    bakeSettings.samples < 64
      ? {
          severity: "warning",
          message: "Low sample counts are fast but can produce noisy lighting."
        }
      : undefined,
    !bakeSettings.denoise && bakeSettings.samples < 192
      ? {
          severity: "warning",
          message: "Denoise is off; use higher samples or enable denoise before client review."
        }
      : undefined,
    bakeSettings.resolution < 1024 && bakeSettings.preset !== "draft"
      ? {
          severity: "warning",
          message: "Resolution below 1024px may produce soft or blurry baked shadows."
        }
      : undefined
  ].filter((issue): issue is BakePreflightIssue => Boolean(issue));
  const bakePreflightBlocked = bakePreflightIssues.some((issue) => issue.severity === "error");
  const bakePreflightRisk = bakePreflightIssues.length > 0;
  const lightmapBakeBlockedReason = !apiConnected
    ? "API is not connected."
    : bakeState === "baking"
      ? "Bake is already running."
      : !blenderTool
        ? "Checking Blender availability."
        : !blenderTool.ready
          ? blenderTool.action
          : bakePreflightBlocked
            ? "Resolve the bake preflight errors before starting Blender."
            : "";
  const canRunLightmapBake = !lightmapBakeBlockedReason;
  const bakeReviewPreviewCount = (lightmapBakeJob?.lightmaps ?? []).filter(
    (lightmap) => lightmapPreviewQuality(lightmap) === "warning"
  ).length;
  const bakeSetupSteps = useMemo(
    () => [
      {
        id: "tool",
        label: "Bake tool",
        detail: apiConnected
          ? blenderTool?.ready
            ? "Blender/Cycles is ready"
            : (blenderTool?.action ?? "Checking Blender")
          : "API is offline",
        status: apiConnected && blenderTool?.ready ? "ready" : "warning",
        action: apiConnected && blenderTool?.ready ? "Tool OK" : "Check Setup"
      },
      {
        id: "quality",
        label: "Quality preset",
        detail: `${bakeSettings.preset} / ${bakeSettings.samples} samples`,
        status:
          bakeSettings.preset === "draft"
            ? "warning"
            : bakeSettings.preset === "super"
              ? "active"
              : "ready",
        action: bakeSettings.preset === "draft" ? "Use Medium" : bakeSettings.preset === "super" ? "Use High" : "Preset OK"
      },
      {
        id: "memory",
        label: "Lightmap size",
        detail: formatBytes(estimatedBakeTextureBytes),
        status:
          estimatedBakeTextureBytes > 1024 * 1024 * 1024
            ? "warning"
            : estimatedBakeTextureBytes > 512 * 1024 * 1024
              ? "active"
              : "ready",
        action: estimatedBakeTextureBytes > 1024 * 1024 * 1024 ? "Lower px" : "Size OK"
      },
      {
        id: "preflight",
        label: "Preflight",
        detail: bakePreflightIssues.length > 0
          ? `${bakePreflightIssues.length} issue${bakePreflightIssues.length === 1 ? "" : "s"} before bake`
          : "Settings look reasonable",
        status: bakePreflightBlocked ? "warning" : bakePreflightIssues.length > 0 ? "active" : "ready",
        action: bakePreflightIssues.length > 0 ? "Tune" : "Ready"
      },
      {
        id: "output",
        label: "Last output",
        detail: lightmapBakeJob?.status
          ? bakeReviewPreviewCount > 0
            ? `${bakeReviewPreviewCount} preview${bakeReviewPreviewCount === 1 ? "" : "s"} need review`
            : `${lightmapBakeJob.status}${lightmapBakeJob.lightmapCount ? ` / ${lightmapBakeJob.lightmapCount} lightmaps` : ""}`
          : "No bake output yet",
        status: bakeReviewPreviewCount > 0 ? "warning" : lightmapBakeJob?.status === "completed" ? "ready" : "active",
        action: bakeReviewPreviewCount > 0 ? "Review" : lightmapBakeJob?.status === "completed" ? "Output OK" : "Bake"
      }
    ],
    [
      apiConnected,
      bakePreflightBlocked,
      bakePreflightIssues.length,
      bakeReviewPreviewCount,
      bakeSettings.preset,
      bakeSettings.samples,
      blenderTool?.action,
      blenderTool?.ready,
      estimatedBakeTextureBytes,
      lightmapBakeJob?.lightmapCount,
      lightmapBakeJob?.status
    ]
  );
  const bakeTriageSteps = useMemo(
    () => [
      {
        id: "shadows",
        label: "No soft shadows",
        detail:
          hasCompleteLightmapCoverageForBake
            ? `${lightmappedMaterialCountForBake}/${materialCountForBake} material(s) use lightmaps.`
            : hasPartialLightmapCoverageForBake
              ? `${lightmappedMaterialCountForBake}/${materialCountForBake} material(s) use lightmaps; confirm the rest are intentionally unbaked.`
              : "Bake lighting when the scene looks flat compared with Shapespark.",
        status: hasCompleteLightmapCoverageForBake ? "ready" : "warning",
        action: hasCompleteLightmapCoverageForBake ? "Review" : hasPartialLightmapCoverageForBake ? "Review Gaps" : "Bake Medium"
      },
      {
        id: "blank-output",
        label: "Blank/tiny output",
        detail:
          bakeReviewPreviewCount > 0
            ? `${bakeReviewPreviewCount} lightmap preview${bakeReviewPreviewCount === 1 ? "" : "s"} need review.`
            : lightmapBakeJob?.status === "completed"
              ? "No suspicious lightmap previews are flagged."
              : "Use after a bake finishes with tiny or empty images.",
        status: bakeReviewPreviewCount > 0 ? "warning" : lightmapBakeJob?.status === "completed" ? "ready" : "active",
        action: bakeReviewPreviewCount > 0 ? "Review Output" : "Check Output"
      },
      {
        id: "heavy",
        label: "Bake too heavy",
        detail:
          bakePreflightIssues.length > 0
            ? `${bakePreflightIssues.length} preflight issue${bakePreflightIssues.length === 1 ? "" : "s"} before bake.`
            : `${formatBytes(estimatedBakeTextureBytes)} raw lightmap target.`,
        status: bakePreflightIssues.length > 0 || estimatedBakeTextureBytes > 512 * 1024 * 1024 ? "warning" : "ready",
        action: "Make Safer"
      },
      {
        id: "tool",
        label: "Blender setup",
        detail: apiConnected
          ? blenderTool?.ready
            ? "Blender/Cycles is ready."
            : (blenderTool?.action ?? "Checking Blender.")
          : "API is offline.",
        status: apiConnected && blenderTool?.ready ? "ready" : "warning",
        action: apiConnected && blenderTool?.ready ? "Tool OK" : "Copy Plan"
      }
    ],
    [
      apiConnected,
      bakePreflightIssues.length,
      bakeReviewPreviewCount,
      blenderTool?.action,
      blenderTool?.ready,
      estimatedBakeTextureBytes,
      hasCompleteLightmapCoverageForBake,
      hasPartialLightmapCoverageForBake,
      lightmapBakeJob?.status,
      lightmappedMaterialCountForBake,
      materialCountForBake
    ]
  );
  const resetBakeSettingsToPreset = () => {
    setBakeSettings((current) => ({
      ...current,
      ...bakePresetDefaults[current.preset]
    }));
  };

  const selectedHotspot = useMemo(
    () => hotspotInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [hotspotInteractions, selectedInteractionId]
  );

  const selectedLink = useMemo(
    () => linkInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [linkInteractions, selectedInteractionId]
  );

  const selectedObjectToggle = useMemo(
    () => objectToggleInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [objectToggleInteractions, selectedInteractionId]
  );

  const selectedVideoTexture = useMemo(
    () => videoTextureInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [videoTextureInteractions, selectedInteractionId]
  );

  const videoSurfaceCandidates = useMemo((): VideoSurfaceCandidate[] => {
    if (!sceneGraph) {
      return [];
    }
    const candidates = sceneGraph.nodes.map((node) => {
      const materialNames = node.materialIds
        .map((materialId) => sceneGraph.materials.find((material) => material.id === materialId)?.name)
        .filter((name): name is string => Boolean(name));
      const materialName = materialNames[0];
      const searchName = `${node.name} ${node.meshName ?? ""} ${materialNames.join(" ")}`;
      const score = videoSurfaceScore(searchName) + videoSurfaceShapeScore(node.bounds);
      const dimensions = node.bounds
        ? [
            Math.abs(node.bounds.max[0] - node.bounds.min[0]),
            Math.abs(node.bounds.max[1] - node.bounds.min[1]),
            Math.abs(node.bounds.max[2] - node.bounds.min[2])
          ]
            .map((value) => value.toFixed(2))
            .join(" x ")
        : undefined;
      return {
        id: node.id,
        meshName: node.name,
        ...(materialName ? { materialName } : {}),
        triangleCount: node.triangleCount,
        label: materialName ? `${node.name} / ${materialName}` : node.name,
        score,
        ...(dimensions ? { dimensions } : {})
      };
    });
    const likely = candidates.filter((candidate) => candidate.score > 0);
    return (likely.length > 0 ? likely : candidates)
      .sort((a, b) => b.score - a.score || b.triangleCount - a.triangleCount)
      .slice(0, 12);
  }, [sceneGraph]);
  const likelyVideoSurfaceCandidates = useMemo(
    () => videoSurfaceCandidates.filter((candidate) => candidate.score >= 6),
    [videoSurfaceCandidates]
  );
  const mappedVideoSurfaceCount = useMemo(() => {
    return videoSurfaceCandidates.filter((candidate) =>
      videoTextureInteractions.some(
        (interaction) =>
          interaction.targetMeshName === candidate.meshName ||
          (candidate.materialName && interaction.targetMaterialName === candidate.materialName)
      )
    ).length;
  }, [videoSurfaceCandidates, videoTextureInteractions]);
  const videoTextureMissingMediaCount = useMemo(
    () => videoTextureInteractions.filter((interaction) => !interaction.source.trim()).length,
    [videoTextureInteractions]
  );
  const videoTextureMissingTargetCount = useMemo(
    () =>
      videoTextureInteractions.filter(
        (interaction) => !interaction.targetMeshName && !interaction.targetMaterialName
      ).length,
    [videoTextureInteractions]
  );
  const objectToggleKnownTargetKeys = useMemo(() => {
    const ids = new Set<string>();
    const names = new Set<string>();
    objectsDoc?.objects.forEach((object) => {
      ids.add(object.id);
      names.add(normalizedObjectMatchName(object.name));
    });
    sceneGraph?.nodes.forEach((node) => {
      ids.add(node.id);
      names.add(normalizedObjectMatchName(node.name));
    });
    names.delete("");
    return { ids, names };
  }, [objectsDoc, sceneGraph]);
  const objectToggleMissingTargetCount = useMemo(
    () =>
      objectToggleInteractions.filter(
        (interaction) => !interaction.targetObjectId?.trim() && !interaction.targetObjectName?.trim()
      ).length,
    [objectToggleInteractions]
  );
  const objectToggleStaleTargetCount = useMemo(
    () =>
      objectToggleInteractions.filter((interaction) => {
        const targetId = interaction.targetObjectId?.trim();
        const targetName = normalizedObjectMatchName(interaction.targetObjectName ?? "");
        if (!targetId && !targetName) {
          return false;
        }
        return !(
          (targetId && objectToggleKnownTargetKeys.ids.has(targetId)) ||
          (targetName && objectToggleKnownTargetKeys.names.has(targetName))
        );
      }).length,
    [objectToggleInteractions, objectToggleKnownTargetKeys]
  );
  const selectedObjectToggleTargetState = useMemo(() => {
    if (!selectedObjectToggle) {
      return "ready";
    }
    const targetId = selectedObjectToggle.targetObjectId?.trim();
    const targetName = normalizedObjectMatchName(selectedObjectToggle.targetObjectName ?? "");
    if (!targetId && !targetName) {
      return "missing";
    }
    return (targetId && objectToggleKnownTargetKeys.ids.has(targetId)) ||
      (targetName && objectToggleKnownTargetKeys.names.has(targetName))
      ? "ready"
      : "stale";
  }, [objectToggleKnownTargetKeys, selectedObjectToggle]);
  const selectedVideoTextureTargetState = useMemo(() => {
    if (!selectedVideoTexture) {
      return "ready";
    }
    const targetMeshName = selectedVideoTexture.targetMeshName?.trim();
    const targetMaterialName = selectedVideoTexture.targetMaterialName?.trim();
    if (!targetMeshName && !targetMaterialName) {
      return "missing";
    }
    const meshFound =
      !targetMeshName ||
      !sceneGraph ||
      sceneGraph.nodes.some((node) => node.name === targetMeshName || node.meshName === targetMeshName);
    const materialFound =
      !targetMaterialName ||
      (!materialsDoc && !sceneGraph) ||
      Boolean(materialsDoc?.materials.some((material) => material.name === targetMaterialName)) ||
      Boolean(sceneGraph?.materials.some((material) => material.name === targetMaterialName));
    return meshFound && materialFound ? "ready" : "stale";
  }, [materialsDoc, sceneGraph, selectedVideoTexture]);
  const selectedInteractionHealthSteps = useMemo((): InteractionHealthStep[] => {
    if (selectedHotspot) {
      const hasPosition = isFiniteVec3(selectedHotspot.position);
      const hasTitle = Boolean(selectedHotspot.title.trim() || selectedHotspot.label.trim());
      const hasBody = Boolean(selectedHotspot.body?.trim());
      return [
        {
          id: "marker",
          label: "Marker position",
          detail: hasPosition
            ? `Placed at ${vec3Summary(selectedHotspot.position)}`
            : "Marker coordinates are invalid.",
          status: hasPosition ? "ready" : "warning",
          action: hasPosition ? "Marker OK" : "Set Position"
        },
        {
          id: "content",
          label: "Content",
          detail: hasTitle
            ? hasBody
              ? "Title and body are ready."
              : "Title is ready; body is optional."
            : "Add a visible title before publishing.",
          status: hasTitle ? "ready" : "warning",
          action: hasTitle ? "Content OK" : "Add Title"
        },
        {
          id: "viewer",
          label: "Viewer test",
          detail: "Open the viewer and click this marker from a nearby camera view.",
          status: "active",
          action: "Test Click"
        }
      ];
    }
    if (selectedLink) {
      const hasPosition = isFiniteVec3(selectedLink.position);
      const hasLabel = Boolean(selectedLink.label.trim());
      const validUrl = isValidInteractionUrl(selectedLink.url);
      return [
        {
          id: "marker",
          label: "Marker position",
          detail: hasPosition
            ? `Placed at ${vec3Summary(selectedLink.position)}`
            : "Marker coordinates are invalid.",
          status: hasPosition ? "ready" : "warning",
          action: hasPosition ? "Marker OK" : "Set Position"
        },
        {
          id: "destination",
          label: "Destination",
          detail: validUrl ? "URL format is publish-safe." : "Use https, mailto, tel, #, or a relative path.",
          status: validUrl ? "ready" : "warning",
          action: validUrl ? "URL OK" : "Fix URL"
        },
        {
          id: "label",
          label: "Button label",
          detail: hasLabel ? `Shown as ${selectedLink.label}.` : "Add a short label for the link.",
          status: hasLabel ? "ready" : "warning",
          action: hasLabel ? "Label OK" : "Add Label"
        },
        {
          id: "behavior",
          label: "Open behavior",
          detail: selectedLink.openInNewTab !== false
            ? "Opens in a new browser tab."
            : "Opens in the current viewer tab.",
          status: "ready",
          action: selectedLink.openInNewTab !== false ? "New Tab" : "Same Tab"
        }
      ];
    }
    if (selectedObjectToggle) {
      const hasPosition = isFiniteVec3(selectedObjectToggle.position);
      const hasLabel = Boolean(selectedObjectToggle.label.trim());
      return [
        {
          id: "marker",
          label: "Marker position",
          detail: hasPosition
            ? `Placed at ${vec3Summary(selectedObjectToggle.position)}`
            : "Marker coordinates are invalid.",
          status: hasPosition ? "ready" : "warning",
          action: hasPosition ? "Marker OK" : "Set Position"
        },
        {
          id: "target",
          label: "Target object",
          detail:
            selectedObjectToggleTargetState === "ready"
              ? selectedObjectToggle.targetObjectName || selectedObjectToggle.targetObjectId || "Target found."
              : selectedObjectToggleTargetState === "missing"
                ? "Choose the object this marker should show or hide."
                : "Target was not found after reimport; select it again.",
          status: selectedObjectToggleTargetState === "ready" ? "ready" : "warning",
          action: selectedObjectToggleTargetState === "ready" ? "Target OK" : "Choose Object"
        },
        {
          id: "label",
          label: "Marker label",
          detail: hasLabel ? `Shown as ${selectedObjectToggle.label}.` : "Add a short marker label.",
          status: hasLabel ? "ready" : "warning",
          action: hasLabel ? "Label OK" : "Add Label"
        },
        {
          id: "state",
          label: "Starting state",
          detail: selectedObjectToggle.initiallyVisible !== false
            ? "Object starts visible, then marker can hide it."
            : "Object starts hidden, then marker can reveal it.",
          status: "ready",
          action: selectedObjectToggle.initiallyVisible !== false ? "Visible" : "Hidden"
        }
      ];
    }
    return [];
  }, [selectedHotspot, selectedLink, selectedObjectToggle, selectedObjectToggleTargetState]);
  const selectedVideoTextureHealthSteps = useMemo((): InteractionHealthStep[] => {
    if (!selectedVideoTexture) {
      return [];
    }
    const source = selectedVideoTexture.source.trim();
    const hasValidMedia = isValidMediaSource(source);
    const triggerDistance = selectedVideoTexture.triggerDistance ?? 8;
    const targetLabel =
      selectedVideoTexture.targetMaterialName ??
      selectedVideoTexture.targetMeshName ??
      "No mesh or material selected.";
    return [
      {
        id: "target",
        label: "Screen target",
        detail:
          selectedVideoTextureTargetState === "ready"
            ? `Mapped to ${targetLabel}.`
            : selectedVideoTextureTargetState === "missing"
              ? "Choose the TV mesh or material."
              : "Selected target was not found after reimport.",
        status: selectedVideoTextureTargetState === "ready" ? "ready" : "warning",
        action: selectedVideoTextureTargetState === "ready" ? "Target OK" : "Map Screen"
      },
      {
        id: "media",
        label: "Video media",
        detail: source
          ? hasValidMedia
            ? `Using ${source}.`
            : "Use an uploaded media file or an HTTPS video URL."
          : "Upload or paste an MP4, MOV, or WebM video.",
        status: hasValidMedia ? "ready" : "warning",
        action: hasValidMedia ? "Media OK" : "Add Video"
      },
      {
        id: "autoplay",
        label: "Mobile playback",
        detail:
          selectedVideoTexture.autoplay !== false
            ? selectedVideoTexture.muted !== false
              ? "Autoplay is muted, which is safest for browsers."
              : "Unmuted autoplay is often blocked on mobile."
            : "Video waits for user/viewer logic instead of autoplay.",
        status:
          selectedVideoTexture.autoplay !== false && selectedVideoTexture.muted === false ? "warning" : "ready",
        action:
          selectedVideoTexture.autoplay !== false
            ? selectedVideoTexture.muted !== false
              ? "Playback OK"
              : "Mute Video"
            : "Manual"
      },
      {
        id: "performance",
        label: "Performance guard",
        detail:
          triggerDistance > 0
            ? `Pauses when farther than ${triggerDistance.toFixed(1)}m.`
            : "Set a trigger distance so offscreen video does not keep decoding.",
        status: triggerDistance > 0 ? "ready" : "warning",
        action: triggerDistance > 0 ? "Guard OK" : "Set Distance"
      },
      {
        id: "viewer",
        label: "Viewer test",
        detail: "Open the viewer and confirm the video appears on the intended screen.",
        status: "active",
        action: "Test Screen"
      }
    ];
  }, [selectedVideoTexture, selectedVideoTextureTargetState]);
  const interactionSetupSteps = useMemo(() => {
    const likelyCount = likelyVideoSurfaceCandidates.length;
    const interactionCount =
      videoTextureInteractions.length +
      hotspotInteractions.length +
      linkInteractions.length +
      objectToggleInteractions.length;
    return [
      {
        id: "detect-screens",
        label: "Detected screens",
        detail: likelyCount > 0 ? `${likelyCount} likely TV/screen surface${likelyCount === 1 ? "" : "s"}` : "No strong screen candidates",
        status: likelyCount > 0 ? "active" : videoSurfaceCandidates.length > 0 ? "warning" : "warning",
        action: likelyCount > 0 ? "Map Likely" : "Add Screen"
      },
      {
        id: "screen-targets",
        label: "Mapped targets",
        detail: videoTextureInteractions.length > 0
          ? videoTextureMissingTargetCount > 0
            ? `${videoTextureMissingTargetCount} screen${videoTextureMissingTargetCount === 1 ? "" : "s"} need target`
            : `${mappedVideoSurfaceCount} candidate${mappedVideoSurfaceCount === 1 ? "" : "s"} mapped`
          : "No video screens configured",
        status: videoTextureInteractions.length > 0 && videoTextureMissingTargetCount === 0 ? "ready" : "warning",
        action: videoTextureInteractions.length > 0 ? "Review Target" : "Add Screen"
      },
      {
        id: "screen-media",
        label: "Video media",
        detail: videoTextureInteractions.length > 0
          ? videoTextureMissingMediaCount > 0
            ? `${videoTextureMissingMediaCount} screen${videoTextureMissingMediaCount === 1 ? "" : "s"} missing video`
            : "Screen media is linked"
          : "Add a screen before uploading media",
        status: videoTextureInteractions.length > 0 && videoTextureMissingMediaCount === 0 ? "ready" : "warning",
        action: videoTextureInteractions.length > 0 ? "Upload Video" : "Add Screen"
      },
      {
        id: "object-toggles",
        label: "Object toggles",
        detail: objectToggleInteractions.length > 0
          ? objectToggleMissingTargetCount > 0
            ? `${objectToggleMissingTargetCount} toggle${objectToggleMissingTargetCount === 1 ? "" : "s"} need target`
            : objectToggleStaleTargetCount > 0
              ? `${objectToggleStaleTargetCount} toggle${objectToggleStaleTargetCount === 1 ? "" : "s"} may be stale`
              : `${objectToggleInteractions.length} toggle${objectToggleInteractions.length === 1 ? "" : "s"} targeted`
          : "Optional show/hide actions",
        status: objectToggleMissingTargetCount > 0 || objectToggleStaleTargetCount > 0 ? "warning" : "ready",
        action: objectToggleInteractions.length > 0 ? "Review Toggle" : "Optional"
      },
      {
        id: "hotspots",
        label: "Hotspots & links",
        detail: interactionCount > 0
          ? `${interactionCount} interaction${interactionCount === 1 ? "" : "s"} configured`
          : "No clickable points yet",
        status: interactionCount > 0 ? "ready" : "warning",
        action: interactionCount > 0 ? "Interactions OK" : "Add Hotspot"
      }
    ];
  }, [
    hotspotInteractions.length,
    likelyVideoSurfaceCandidates.length,
    linkInteractions.length,
    mappedVideoSurfaceCount,
    objectToggleMissingTargetCount,
    objectToggleInteractions.length,
    objectToggleStaleTargetCount,
    videoSurfaceCandidates.length,
    videoTextureInteractions.length,
    videoTextureMissingMediaCount,
    videoTextureMissingTargetCount
  ]);

  const collisionNameCandidates = useMemo(() => {
    if (!sceneGraph || !manifest) {
      return [];
    }
    const keywords = manifest.navigation.collisionMeshNames.map((keyword) => keyword.toLowerCase());
    const ignored = new Set((manifest.navigation.ignoredCollisionMeshNames ?? []).map((name) => name.toLowerCase()));
    return sceneGraph.nodes
      .filter((node) => {
        const name = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
        return keywords.some((keyword) => name.includes(keyword)) && !ignored.has(node.name.toLowerCase());
      })
      .sort((a, b) => b.triangleCount - a.triangleCount)
      .slice(0, 16);
  }, [sceneGraph, manifest]);

  const doorPassCandidates = useMemo((): DoorPassCandidate[] => {
    if (!sceneGraph || !manifest) {
      return [];
    }
    const modelScale = manifest.rendering?.modelScale ?? 1;
    const modelOffset = manifest.rendering?.modelOffset ?? [0, 0, 0];
    const cameraHeight = manifest.navigation.cameraHeight;
    return sceneGraph.nodes
      .map((node) => {
        if (!node.bounds) {
          return null;
        }
        const scaledBounds = transformGraphBounds(node.bounds, modelScale, modelOffset);
        const searchName = `${node.name} ${node.meshName ?? ""}`;
        const nameScore = doorPassScore(searchName);
        const normalizedName = searchName.toLowerCase();
        const geometryScore = /wall|partition|ceiling|roof|window|glass|handle|knob/.test(normalizedName)
          ? 0
          : doorPassGeometryScore(scaledBounds, cameraHeight);
        const score = nameScore + geometryScore;
        if (score <= 0) {
          return null;
        }
        const min = scaledBounds.min;
        const max = scaledBounds.max;
        const width = Math.max(0.1, max[0] - min[0]);
        const depth = Math.max(0.1, max[2] - min[2]);
        const center: Vec3 = [
          Number(((min[0] + max[0]) / 2).toFixed(3)),
          Number(Math.max(0.8, cameraHeight * 0.55).toFixed(3)),
          Number(((min[2] + max[2]) / 2).toFixed(3))
        ];
        const size: Vec3 = [
          Number(clampNumber(Math.max(0.85, width * 1.35), 0.85, 2.2).toFixed(3)),
          Number(Math.max(1.8, cameraHeight + 0.65).toFixed(3)),
          Number(clampNumber(Math.max(0.95, depth * 1.35), 0.95, 2.2).toFixed(3))
        ];
        return {
          id: node.id,
          name: node.name,
          triangleCount: node.triangleCount,
          center,
          size,
          score
        };
      })
      .filter((candidate): candidate is DoorPassCandidate => Boolean(candidate))
      .sort((a, b) => b.score - a.score || b.triangleCount - a.triangleCount)
      .slice(0, 12);
  }, [sceneGraph, manifest]);

  const selectedVariantInteraction = useMemo(
    () => materialVariantInteractions.find((interaction) => interaction.id === selectedVariantInteractionId),
    [materialVariantInteractions, selectedVariantInteractionId]
  );
  const variantTargetKeys = useMemo(() => {
    const meshNames = new Set<string>();
    const materialNames = new Set<string>();
    sceneGraph?.nodes.forEach((node) => {
      if (node.name) {
        meshNames.add(node.name);
      }
      if (node.meshName) {
        meshNames.add(node.meshName);
      }
    });
    sceneGraph?.materials.forEach((material) => {
      if (material.name) {
        materialNames.add(material.name);
      }
    });
    materialsDoc?.materials.forEach((material) => {
      if (material.name) {
        materialNames.add(material.name);
      }
    });
    return { meshNames, materialNames };
  }, [materialsDoc, sceneGraph]);
  const variantMeshTargetOptions = useMemo(() => {
    const names = new Set<string>();
    sceneGraph?.nodes.forEach((node) => {
      if (node.name) {
        names.add(node.name);
      }
      if (node.meshName) {
        names.add(node.meshName);
      }
    });
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [sceneGraph]);
  const variantMaterialTargetOptions = useMemo(() => {
    const names = new Set<string>();
    materialsDoc?.materials.forEach((material) => {
      if (material.name) {
        names.add(material.name);
      }
    });
    sceneGraph?.materials.forEach((material) => {
      if (material.name) {
        names.add(material.name);
      }
    });
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [materialsDoc, sceneGraph]);
  const missingVariantTextureSources = useMemo(() => {
    const sources = new Set<string>();
    bundleStats?.assets
      ?.filter((asset) => asset.kind === "variant-texture" && !asset.exists)
      .forEach((asset) => sources.add(normalizeAssetReference(asset.source)));
    return sources;
  }, [bundleStats]);
  const variantMissingTargetCount = useMemo(
    () => materialVariantInteractions.filter((interaction) => !interaction.targetMaterialName && !interaction.targetMeshName).length,
    [materialVariantInteractions]
  );
  const variantStaleTargetCount = useMemo(
    () =>
      materialVariantInteractions.filter((interaction) => {
        if (!sceneGraph) {
          return false;
        }
        return Boolean(
          (interaction.targetMaterialName && !variantTargetKeys.materialNames.has(interaction.targetMaterialName)) ||
            (interaction.targetMeshName && !variantTargetKeys.meshNames.has(interaction.targetMeshName))
        );
      }).length,
    [materialVariantInteractions, sceneGraph, variantTargetKeys]
  );
  const selectedVariantTargetState = useMemo(() => {
    if (!selectedVariantInteraction || !sceneGraph) {
      return "ready";
    }
    if (!selectedVariantInteraction.targetMaterialName && !selectedVariantInteraction.targetMeshName) {
      return "missing";
    }
    return (selectedVariantInteraction.targetMaterialName &&
      !variantTargetKeys.materialNames.has(selectedVariantInteraction.targetMaterialName)) ||
      (selectedVariantInteraction.targetMeshName && !variantTargetKeys.meshNames.has(selectedVariantInteraction.targetMeshName))
      ? "stale"
      : "ready";
  }, [sceneGraph, selectedVariantInteraction, variantTargetKeys]);
  const variantSetupSteps = useMemo(() => {
    const setCount = materialVariantInteractions.length;
    const targetedCount = materialVariantInteractions.filter(
      (interaction) => Boolean(interaction.targetMaterialName || interaction.targetMeshName)
    ).length;
    const optionCount = materialVariantInteractions.reduce(
      (sum, interaction) => sum + interaction.variants.length,
      0
    );
    const texturedOptionCount = materialVariantInteractions.reduce(
      (sum, interaction) => sum + interaction.variants.filter((variant) => Boolean(variant.texture)).length,
      0
    );
    const colorOptionCount = materialVariantInteractions.reduce(
      (sum, interaction) => sum + interaction.variants.filter((variant) => Boolean(variant.color)).length,
      0
    );
    return [
      {
        id: "sets",
        label: "Finish sets",
        detail: setCount > 0 ? `${setCount} set${setCount === 1 ? "" : "s"} configured` : "No finish sets yet",
        status: setCount > 0 ? "ready" : "warning",
        action: setCount > 0 ? "Sets OK" : "Add Set"
      },
      {
        id: "targets",
        label: "Targets",
        detail: setCount > 0
          ? variantMissingTargetCount > 0
            ? `${variantMissingTargetCount} set${variantMissingTargetCount === 1 ? "" : "s"} need target`
            : variantStaleTargetCount > 0
              ? `${variantStaleTargetCount} set${variantStaleTargetCount === 1 ? "" : "s"} may be stale`
              : `${targetedCount}/${setCount} set${setCount === 1 ? "" : "s"} targeted`
          : "Choose material or mesh",
        status: setCount > 0 && targetedCount >= setCount && variantStaleTargetCount === 0 ? "ready" : "warning",
        action: targetedCount >= setCount && setCount > 0 && variantStaleTargetCount === 0 ? "Targets OK" : "Pick Target"
      },
      {
        id: "options",
        label: "Options",
        detail: optionCount > 0 ? `${optionCount} visible option${optionCount === 1 ? "" : "s"}` : "No options yet",
        status: optionCount > 0 ? "ready" : "warning",
        action: optionCount > 0 ? "Options OK" : "Add Option"
      },
      {
        id: "colors",
        label: "Color swatches",
        detail: colorOptionCount > 0 ? `${colorOptionCount} color swatch${colorOptionCount === 1 ? "" : "es"}` : "No swatches yet",
        status: colorOptionCount > 0 ? "ready" : "warning",
        action: colorOptionCount > 0 ? "Colors OK" : "Add Color"
      },
      {
        id: "textures",
        label: "Texture finishes",
        detail: texturedOptionCount > 0 ? `${texturedOptionCount} texture option${texturedOptionCount === 1 ? "" : "s"}` : "Optional texture URLs",
        status: texturedOptionCount > 0 ? "active" : optionCount > 0 ? "ready" : "warning",
        action: texturedOptionCount > 0 ? "Review" : optionCount > 0 ? "Optional" : "Add Option"
      }
    ];
  }, [materialVariantInteractions, variantMissingTargetCount, variantStaleTargetCount]);

  const objectOverrideById = useMemo(() => {
    const entries = objectsDoc?.objects.map((object) => [object.id, object] as const) ?? [];
    return new Map(entries);
  }, [objectsDoc]);
  const objectReviewRows = useMemo(() => {
    return (sceneGraph?.nodes ?? []).map((node) => {
      const override = objectOverrideById.get(node.id);
      return {
        node,
        override,
        searchText: objectSearchText(node, override),
        isCeilingOrRoof: isLikelyCeilingOrRoofObject(node),
        isHiddenInTopView: override?.hideInTopView === true,
        isHidden: override?.visible === false,
        hasNavigationRole: hasObjectNavigationRole(override)
      };
    });
  }, [objectOverrideById, sceneGraph]);
  const objectFilterCounts = useMemo(
    () => ({
      all: objectReviewRows.length,
      ceiling: objectReviewRows.filter((row) => row.isCeilingOrRoof).length,
      ceilingNeedsTopHidden: objectReviewRows.filter((row) => row.isCeilingOrRoof && !row.isHiddenInTopView).length,
      topHidden: objectReviewRows.filter((row) => row.isHiddenInTopView).length,
      roles: objectReviewRows.filter((row) => row.hasNavigationRole).length,
      hidden: objectReviewRows.filter((row) => row.isHidden).length
    }),
    [objectReviewRows]
  );
  const objectSetupSteps = useMemo(
    () => [
      {
        id: "objects",
        label: "Scene objects",
        detail:
          objectFilterCounts.all > 0
            ? `${objectFilterCounts.all} object${objectFilterCounts.all === 1 ? "" : "s"} indexed`
            : "No scene graph yet",
        status: objectFilterCounts.all > 0 ? "ready" : "warning",
        action: objectFilterCounts.all > 0 ? "Objects OK" : "Run Import"
      },
      {
        id: "ceiling",
        label: "Ceiling review",
        detail:
          objectFilterCounts.ceiling > 0
            ? `${objectFilterCounts.ceiling} ceiling/roof candidate${objectFilterCounts.ceiling === 1 ? "" : "s"}`
            : "No ceiling names detected",
        status: objectFilterCounts.ceilingNeedsTopHidden > 0 ? "warning" : "ready",
        action: objectFilterCounts.ceilingNeedsTopHidden > 0 ? "Hide Top" : "Ceiling OK"
      },
      {
        id: "top",
        label: "Top view cleanup",
        detail:
          objectFilterCounts.topHidden > 0
            ? `${objectFilterCounts.topHidden} object${objectFilterCounts.topHidden === 1 ? "" : "s"} hidden in top`
            : "No top-view hiding yet",
        status: objectFilterCounts.ceilingNeedsTopHidden > 0 ? "warning" : objectFilterCounts.topHidden > 0 ? "ready" : "active",
        action: objectFilterCounts.ceilingNeedsTopHidden > 0 ? "Fix Ceiling" : objectFilterCounts.topHidden > 0 ? "Top OK" : "Review Top"
      },
      {
        id: "roles",
        label: "Movement roles",
        detail:
          objectFilterCounts.roles > 0
            ? `${objectFilterCounts.roles} explicit role${objectFilterCounts.roles === 1 ? "" : "s"}`
            : "Using automatic detection",
        status: objectFilterCounts.roles > 0 ? "active" : "ready",
        action: objectFilterCounts.roles > 0 ? "Review Roles" : "Roles OK"
      },
      {
        id: "hidden",
        label: "Hidden objects",
        detail:
          objectFilterCounts.hidden > 0
            ? `${objectFilterCounts.hidden} globally hidden object${objectFilterCounts.hidden === 1 ? "" : "s"}`
            : "No hidden objects",
        status: objectFilterCounts.hidden > 0 ? "active" : "ready",
        action: objectFilterCounts.hidden > 0 ? "Review Hidden" : "Visible OK"
      }
    ],
    [
      objectFilterCounts.all,
      objectFilterCounts.ceiling,
      objectFilterCounts.ceilingNeedsTopHidden,
      objectFilterCounts.hidden,
      objectFilterCounts.roles,
      objectFilterCounts.topHidden
    ]
  );
  const filteredObjectRows = useMemo(() => {
    const query = normalizedObjectMatchName(objectSearchQuery);
    return objectReviewRows.filter((row) => {
      const matchesFilter =
        objectListFilter === "all" ||
        (objectListFilter === "ceiling" && row.isCeilingOrRoof) ||
        (objectListFilter === "top-hidden" && row.isHiddenInTopView) ||
        (objectListFilter === "roles" && row.hasNavigationRole) ||
        (objectListFilter === "hidden" && row.isHidden);
      return matchesFilter && (!query || row.searchText.includes(query));
    });
  }, [objectListFilter, objectReviewRows, objectSearchQuery]);

  const selectedObject = useMemo(
    () => sceneGraph?.nodes.find((node) => node.id === selectedObjectId),
    [sceneGraph, selectedObjectId]
  );

  const selectedObjectOverride = useMemo(
    () => objectOverrideById.get(selectedObjectId),
    [objectOverrideById, selectedObjectId]
  );
  const selectedObjectEditableOverride = useMemo<ObjectOverride | undefined>(
    () =>
      selectedObject
        ? selectedObjectOverride ?? {
            id: selectedObject.id,
            name: selectedObject.name,
            visible: true
          }
        : undefined,
    [selectedObject, selectedObjectOverride]
  );
  const objectToggleTargetOptions = useMemo<ObjectOverride[]>(() => {
    const options = new Map<string, ObjectOverride>();
    objectsDoc?.objects.forEach((object) => {
      options.set(object.id, object);
    });
    sceneGraph?.nodes.forEach((node) => {
      if (!options.has(node.id)) {
        options.set(node.id, {
          id: node.id,
          name: node.name,
          visible: true
        });
      }
    });
    return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [objectsDoc, sceneGraph]);

  const selectedMaterial = useMemo(
    () => materialsDoc?.materials.find((material) => material.id === selectedMaterialId),
    [materialsDoc, selectedMaterialId]
  );
  const selectedMaterialTextureCandidates = useMemo<MaterialTextureCandidate[]>(() => {
    if (!selectedMaterial || !bundleStats?.looseImages) {
      return [];
    }
    return bundleStats.looseImages
      .map((image) => ({
        source: image.source,
        bytes: image.bytes,
        field: inferTextureField(image.source),
        score: materialTextureCandidateScore(selectedMaterial.name, image.source)
      }))
      .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
      .slice(0, 10);
  }, [bundleStats?.looseImages, selectedMaterial]);
  const selectedMaterialTexturePreviews = useMemo(() => {
    if (!selectedMaterial) {
      return [];
    }
    const fields: readonly { field: MaterialTextureField; label: string }[] = [
      { field: "mapUrl", label: "Base" },
      { field: "normalMapUrl", label: "Normal" },
      { field: "emissiveMapUrl", label: "Emissive" },
      { field: "lightMapUrl", label: "Lightmap" }
    ];
    return fields.flatMap(({ field, label }) => {
      const source = selectedMaterial[field];
      return source ? [{ field, label, source }] : [];
    });
  }, [selectedMaterial]);
  const selectedMaterialTextureReviewSteps = useMemo(() => {
    if (!selectedMaterial) {
      return [];
    }
    const assignedCount = selectedMaterialTexturePreviews.length;
    const bestCandidate = selectedMaterialTextureCandidates[0];
    const strongCandidateCount = selectedMaterialTextureCandidates.filter(
      (candidate) => textureSuggestionConfidence(candidate.score) === "strong"
    ).length;
    const reviewCandidateCount = selectedMaterialTextureCandidates.length - strongCandidateCount;
    const genericCandidateCount = selectedMaterialTextureCandidates.filter((candidate) =>
      looseTextureNameLooksGeneric(candidate.source)
    ).length;
    return [
      {
        id: "base",
        label: "Base image",
        detail: selectedMaterial.mapUrl
          ? "Base texture is assigned."
          : bestCandidate
            ? `${materialTextureFieldLabels[bestCandidate.field]} candidate found.`
            : "No base texture or loose candidate.",
        status: selectedMaterial.mapUrl ? "ready" : bestCandidate ? "active" : "warning",
        action: selectedMaterial.mapUrl ? "Preview" : bestCandidate ? "Review Candidate" : "Upload"
      },
      {
        id: "confidence",
        label: "Match confidence",
        detail:
          strongCandidateCount > 0
            ? `${strongCandidateCount} safe candidate${strongCandidateCount === 1 ? "" : "s"}`
            : reviewCandidateCount > 0
              ? `${reviewCandidateCount} candidate${reviewCandidateCount === 1 ? "" : "s"} need review`
              : `${assignedCount} assigned map${assignedCount === 1 ? "" : "s"}`,
        status: strongCandidateCount > 0 ? "active" : reviewCandidateCount > 0 ? "warning" : assignedCount > 0 ? "ready" : "warning",
        action: selectedMaterialTextureCandidates.length > 0 ? "Compare" : "No Candidates"
      },
      {
        id: "names",
        label: "Filename safety",
        detail:
          genericCandidateCount > 0
            ? `${genericCandidateCount} generic filename${genericCandidateCount === 1 ? "" : "s"}`
            : "Candidate names look specific.",
        status: genericCandidateCount > 0 ? "warning" : "ready",
        action: genericCandidateCount > 0 ? "Inspect Names" : "Names OK"
      },
      {
        id: "lighting",
        label: "Baked lighting",
        detail: selectedMaterial.lightMapUrl ? "Lightmap is linked." : "No lightmap on this material.",
        status: selectedMaterial.lightMapUrl ? "ready" : "warning",
        action: selectedMaterial.lightMapUrl ? "Preview" : "Review Bake"
      }
    ];
  }, [selectedMaterial, selectedMaterialTextureCandidates, selectedMaterialTexturePreviews.length]);
  const pendingMaterialTextureSuggestionCount = useMemo(() => {
    if (!materialsDoc || !bundleStats?.materialTextureSuggestions) {
      return 0;
    }
    const materialsByName = new Map(materialsDoc.materials.map((material) => [material.name, material]));
    return bundleStats.materialTextureSuggestions.filter((suggestion) => {
      const material = materialsByName.get(suggestion.materialName);
      return (
        material &&
        !material[suggestion.field] &&
        textureSuggestionConfidence(suggestion.score) === "strong"
      );
    }).length;
  }, [bundleStats?.materialTextureSuggestions, materialsDoc]);
  const reviewMaterialTextureSuggestionCount = useMemo(() => {
    if (!materialsDoc || !bundleStats?.materialTextureSuggestions) {
      return 0;
    }
    const materialsByName = new Map(materialsDoc.materials.map((material) => [material.name, material]));
    return bundleStats.materialTextureSuggestions.filter((suggestion) => {
      const material = materialsByName.get(suggestion.materialName);
      return (
        material &&
        !material[suggestion.field] &&
        textureSuggestionConfidence(suggestion.score) === "review"
      );
    }).length;
  }, [bundleStats?.materialTextureSuggestions, materialsDoc]);
  const materialTextureSuggestionStatusByName = useMemo(() => {
    const status = new Map<string, { pending: number; review: number }>();
    if (!materialsDoc || !bundleStats?.materialTextureSuggestions) {
      return status;
    }
    const materialsByName = new Map(materialsDoc.materials.map((material) => [material.name, material]));
    for (const suggestion of bundleStats.materialTextureSuggestions) {
      const material = materialsByName.get(suggestion.materialName);
      if (!material || material[suggestion.field]) {
        continue;
      }
      const current = status.get(suggestion.materialName) ?? { pending: 0, review: 0 };
      if (textureSuggestionConfidence(suggestion.score) === "strong") {
        current.pending += 1;
      } else {
        current.review += 1;
      }
      status.set(suggestion.materialName, current);
    }
    return status;
  }, [bundleStats?.materialTextureSuggestions, materialsDoc]);
  const materialReviewRows = useMemo(() => {
    return (materialsDoc?.materials ?? []).map((material) => {
      const suggestionStatus = materialTextureSuggestionStatusByName.get(material.name);
      const assignedTextureCount = materialAssignedTextureCount(material);
      return {
        material,
        assignedTextureCount,
        suggestionStatus,
        searchText: materialSearchText(material),
        hasSuggestions: Boolean(suggestionStatus?.pending || suggestionStatus?.review),
        isUntextured: assignedTextureCount === 0,
        isPlainGreen: isLikelyPlainGreenMaterial(material),
        isTransparent: typeof material.opacity === "number" && material.opacity < 0.98,
        hasLightmap: Boolean(material.lightMapUrl)
      };
    });
  }, [materialTextureSuggestionStatusByName, materialsDoc]);
  const selectedMaterialReviewRow = useMemo(
    () => materialReviewRows.find((row) => row.material.id === selectedMaterialId),
    [materialReviewRows, selectedMaterialId]
  );
  const selectedMaterialDiagnosis = useMemo(() => {
    if (!selectedMaterialReviewRow) {
      return null;
    }
    const { assignedTextureCount, hasLightmap, isPlainGreen, isTransparent, isUntextured, suggestionStatus } =
      selectedMaterialReviewRow;
    if (suggestionStatus?.pending) {
      return {
        tone: "ready",
        title: "Texture suggestion ready",
        detail: `${suggestionStatus.pending} high-confidence texture suggestion${suggestionStatus.pending === 1 ? "" : "s"} can be applied after checking the preview.`,
        action: "Use Apply Visible Suggestions or the texture candidate buttons below."
      };
    }
    if (suggestionStatus?.review) {
      return {
        tone: "warning",
        title: "Texture match needs review",
        detail: `${suggestionStatus.review} possible texture match${suggestionStatus.review === 1 ? "" : "es"} need a visual check before applying.`,
        action: "Compare the candidate thumbnails and choose Base, Normal, Emissive, or Lightmap only when the image is clearly correct."
      };
    }
    if (isPlainGreen) {
      return {
        tone: "warning",
        title: "Plain green material",
        detail: "This material has no texture maps and looks like a placeholder, terrain, or grass-style surface.",
        action: "Assign the correct base texture, or switch Environment presets if this is generated exterior context."
      };
    }
    if (isUntextured) {
      return {
        tone: "warning",
        title: "No texture maps",
        detail: "This material is only using color/values, so it may look flat compared with the reference viewer.",
        action: "Check loose texture candidates or request a cleaner GLB/ZIP export with texture paths preserved."
      };
    }
    if (isTransparent) {
      return {
        tone: "warning",
        title: "Transparency enabled",
        detail: "Transparent materials can make walls, glass, curtains, or helper planes look hollow or sort incorrectly.",
        action: "Keep this only for glass/sheer surfaces; otherwise raise Opacity before publishing."
      };
    }
    if (hasLightmap) {
      return {
        tone: "ready",
        title: "Lightmap assigned",
        detail: "This material has a baked lightmap assigned for the Shapespark-style lighting workflow.",
        action: "Inspect the thumbnail and viewer shadows after baking or relinking lightmaps."
      };
    }
    if (assignedTextureCount > 0) {
      return {
        tone: "ready",
        title: "Texture maps assigned",
        detail: `${assignedTextureCount} texture map${assignedTextureCount === 1 ? "" : "s"} are assigned on this material.`,
        action: "Compare the viewer against the reference render, then only tune roughness, metalness, or opacity if needed."
      };
    }
    return {
      tone: "ready",
      title: "Material looks configured",
      detail: "No obvious material repair issue is flagged for this selection.",
      action: "Use the viewer/reference comparison to decide whether any manual tuning is needed."
    };
  }, [selectedMaterialReviewRow]);
  const materialFilterCounts = useMemo(
    () => ({
      all: materialReviewRows.length,
      suggested: materialReviewRows.filter((row) => row.hasSuggestions).length,
      untextured: materialReviewRows.filter((row) => row.isUntextured).length,
      plainGreen: materialReviewRows.filter((row) => row.isPlainGreen).length,
      transparent: materialReviewRows.filter((row) => row.isTransparent).length,
      lightmaps: materialReviewRows.filter((row) => row.hasLightmap).length
    }),
    [materialReviewRows]
  );
  const materialSetupSteps = useMemo(
    () => [
      {
        id: "suggestions",
        label: "Texture matches",
        detail:
          pendingMaterialTextureSuggestionCount > 0
            ? `${pendingMaterialTextureSuggestionCount} safe match${pendingMaterialTextureSuggestionCount === 1 ? "" : "es"} ready`
            : reviewMaterialTextureSuggestionCount > 0
              ? `${reviewMaterialTextureSuggestionCount} match${reviewMaterialTextureSuggestionCount === 1 ? "" : "es"} need review`
              : "No pending texture matches",
        status:
          pendingMaterialTextureSuggestionCount > 0
            ? "active"
            : reviewMaterialTextureSuggestionCount > 0
              ? "warning"
              : "ready",
        action: materialFilterCounts.suggested > 0 ? "Show Matches" : "Matches OK",
        filter: "suggested" as MaterialListFilter
      },
      {
        id: "missing-maps",
        label: "Missing maps",
        detail:
          materialFilterCounts.untextured > 0
            ? `${materialFilterCounts.untextured} material${materialFilterCounts.untextured === 1 ? "" : "s"} with no textures`
            : "All reviewed materials have maps",
        status: materialFilterCounts.untextured > 0 ? "warning" : "ready",
        action: materialFilterCounts.untextured > 0 ? "Show No Textures" : "Maps OK",
        filter: "untextured" as MaterialListFilter
      },
      {
        id: "plain-green",
        label: "Plain/green",
        detail:
          materialFilterCounts.plainGreen > 0
            ? `${materialFilterCounts.plainGreen} placeholder-like surface${materialFilterCounts.plainGreen === 1 ? "" : "s"}`
            : "No green placeholders flagged",
        status: materialFilterCounts.plainGreen > 0 ? "warning" : "ready",
        action: materialFilterCounts.plainGreen > 0 ? "Show Plain" : "Colors OK",
        filter: "plain-green" as MaterialListFilter
      },
      {
        id: "transparent",
        label: "Transparency",
        detail:
          materialFilterCounts.transparent > 0
            ? `${materialFilterCounts.transparent} transparent material${materialFilterCounts.transparent === 1 ? "" : "s"}`
            : "No transparent materials flagged",
        status: materialFilterCounts.transparent > 0 ? "active" : "ready",
        action: materialFilterCounts.transparent > 0 ? "Review Glass" : "Opacity OK",
        filter: "transparent" as MaterialListFilter
      },
      {
        id: "lightmaps",
        label: "Baked lighting",
        detail:
          materialFilterCounts.lightmaps > 0
            ? `${materialFilterCounts.lightmaps} lightmapped material${materialFilterCounts.lightmaps === 1 ? "" : "s"}`
            : "No lightmaps assigned yet",
        status: materialFilterCounts.lightmaps > 0 ? "ready" : materialFilterCounts.all > 0 ? "warning" : "ready",
        action: materialFilterCounts.lightmaps > 0 ? "Show Lightmaps" : "Bake Review",
        filter: "lightmaps" as MaterialListFilter
      }
    ],
    [
      materialFilterCounts.all,
      materialFilterCounts.lightmaps,
      materialFilterCounts.plainGreen,
      materialFilterCounts.suggested,
      materialFilterCounts.transparent,
      materialFilterCounts.untextured,
      pendingMaterialTextureSuggestionCount,
      reviewMaterialTextureSuggestionCount
    ]
  );
  const materialTriageSteps = useMemo(
    () => [
      {
        id: "flat",
        label: "Looks flat",
        detail:
          materialFilterCounts.untextured > 0
            ? `${materialFilterCounts.untextured} material${materialFilterCounts.untextured === 1 ? "" : "s"} have no texture maps.`
            : "Use when the model looks poorer than the reference viewer.",
        status: materialFilterCounts.untextured > 0 ? "warning" : "ready",
        action: materialFilterCounts.suggested > 0 ? "Show Matches" : "Show No Textures"
      },
      {
        id: "green",
        label: "Green/plain surface",
        detail:
          materialFilterCounts.plainGreen > 0
            ? `${materialFilterCounts.plainGreen} placeholder-like surface${materialFilterCounts.plainGreen === 1 ? "" : "s"} need review.`
            : "Use when a grass/placeholder color dominates the viewer.",
        status: materialFilterCounts.plainGreen > 0 ? "warning" : "ready",
        action: "Show Plain"
      },
      {
        id: "folder",
        label: "Texture folder",
        detail:
          pendingMaterialTextureSuggestionCount > 0
            ? `${pendingMaterialTextureSuggestionCount} safe match${pendingMaterialTextureSuggestionCount === 1 ? "" : "es"} ready to review.`
            : reviewMaterialTextureSuggestionCount > 0
              ? `${reviewMaterialTextureSuggestionCount} possible match${reviewMaterialTextureSuggestionCount === 1 ? "" : "es"} need review.`
              : "No loose texture matches are pending.",
        status:
          pendingMaterialTextureSuggestionCount > 0
            ? "active"
            : reviewMaterialTextureSuggestionCount > 0
              ? "warning"
              : "ready",
        action: "Review Matches"
      },
      {
        id: "lighting",
        label: "Baked shadows",
        detail:
          materialFilterCounts.lightmaps > 0
            ? `${materialFilterCounts.lightmaps} lightmapped material${materialFilterCounts.lightmaps === 1 ? "" : "s"} assigned.`
            : "Bake or relink lightmaps for Shapespark-style lighting.",
        status: materialFilterCounts.lightmaps > 0 ? "ready" : "warning",
        action: materialFilterCounts.lightmaps > 0 ? "Show Lightmaps" : "Review Bake"
      }
    ],
    [
      materialFilterCounts.lightmaps,
      materialFilterCounts.plainGreen,
      materialFilterCounts.suggested,
      materialFilterCounts.untextured,
      pendingMaterialTextureSuggestionCount,
      reviewMaterialTextureSuggestionCount
    ]
  );
  const filteredMaterialRows = useMemo(() => {
    const query = normalizeTextureMatchName(materialSearchQuery);
    return materialReviewRows.filter((row) => {
      const matchesFilter =
        materialListFilter === "all" ||
        (materialListFilter === "suggested" && row.hasSuggestions) ||
        (materialListFilter === "untextured" && row.isUntextured) ||
        (materialListFilter === "plain-green" && row.isPlainGreen) ||
        (materialListFilter === "transparent" && row.isTransparent) ||
        (materialListFilter === "lightmaps" && row.hasLightmap);
      return matchesFilter && (!query || row.searchText.includes(query));
    });
  }, [materialListFilter, materialReviewRows, materialSearchQuery]);
  const filteredMaterialTextureSuggestionCount = useMemo(() => {
    if (!materialsDoc || !bundleStats?.materialTextureSuggestions) {
      return 0;
    }
    const visibleMaterialNames = new Set(filteredMaterialRows.map((row) => row.material.name));
    const materialsByName = new Map(materialsDoc.materials.map((material) => [material.name, material]));
    return bundleStats.materialTextureSuggestions.filter((suggestion) => {
      const material = materialsByName.get(suggestion.materialName);
      return (
        visibleMaterialNames.has(suggestion.materialName) &&
        material &&
        !material[suggestion.field] &&
        textureSuggestionConfidence(suggestion.score) === "strong"
      );
    }).length;
  }, [bundleStats?.materialTextureSuggestions, filteredMaterialRows, materialsDoc]);
  const appliedMaterialTextureSuggestionCount = Math.max(
    0,
    (bundleStats?.materialTextureSuggestions?.length ?? 0) -
      pendingMaterialTextureSuggestionCount -
      reviewMaterialTextureSuggestionCount
  );
  const selectedTexturePlan = useMemo(
    () => optimizationDoc?.texturePlans?.find((plan) => plan.profileId === optimizationProfile),
    [optimizationDoc?.texturePlans, optimizationProfile]
  );
  const selectedOptimizationProfile = useMemo(
    () => optimizationDoc?.profiles.find((profile) => profile.id === optimizationProfile),
    [optimizationDoc?.profiles, optimizationProfile]
  );
  const optimizationSetupSteps = useMemo(() => {
    const profileWarningCount = selectedOptimizationProfile?.warnings.length ?? 0;
    const texturePlanItems = selectedTexturePlan?.items.length ?? 0;
    const textureOverBudget = selectedTexturePlan
      ? selectedTexturePlan.currentBytes > selectedTexturePlan.budgetBytes
      : false;
    const ktxReady = toolStatus?.tools.toktx?.ready ?? false;
    const hasOptimizedPreview = Boolean(optimizationJob?.optimizedSceneUrl);
    const optimizedApplied = manifest?.sceneUrl === "scene.optimized.glb";
    return [
      {
        id: "profile",
        label: "Profile budget",
        detail: selectedOptimizationProfile
          ? profileWarningCount > 0
            ? `${profileWarningCount} ${optimizationProfile} warning${profileWarningCount === 1 ? "" : "s"}`
            : `${optimizationProfile} budget is clear`
          : "Run analysis first",
        status: selectedOptimizationProfile ? (profileWarningCount > 0 ? "warning" : "ready") : "active",
        action: selectedOptimizationProfile ? (profileWarningCount > 0 ? "Review" : "Budget OK") : "Analyze"
      },
      {
        id: "textures",
        label: "Texture RAM",
        detail: selectedTexturePlan
          ? texturePlanItems > 0
            ? `${texturePlanItems} resize target${texturePlanItems === 1 ? "" : "s"}`
            : "No texture resize targets"
          : "No texture plan yet",
        status: textureOverBudget || texturePlanItems > 0 ? "warning" : selectedTexturePlan ? "ready" : "active",
        action: texturePlanItems > 0 ? "Review Plan" : selectedTexturePlan ? "RAM OK" : "Analyze"
      },
      {
        id: "compression",
        label: "GPU compression",
        detail:
          (bundleStats?.imageCount ?? 0) === 0
            ? "No image textures"
            : ktxReady
              ? "KTX2/Basis tool ready"
              : "KTX2/Basis not ready",
        status: (bundleStats?.imageCount ?? 0) === 0 || ktxReady ? "ready" : "warning",
        action: (bundleStats?.imageCount ?? 0) === 0 || ktxReady ? "Compression OK" : "Read Plan"
      },
      {
        id: "preview",
        label: "Preview artifact",
        detail: hasOptimizedPreview
          ? optimizationJob?.status === "completed"
            ? "Optimized preview exists"
            : `Last job ${optimizationJob?.status}`
          : "No optimized preview yet",
        status: hasOptimizedPreview ? (optimizationJob?.status === "completed" ? "ready" : "warning") : "active",
        action: hasOptimizedPreview ? "Preview OK" : "Generate"
      },
      {
        id: "applied",
        label: "Viewer model",
        detail: optimizedApplied ? "Viewer uses optimized GLB" : "Viewer uses original GLB",
        status: optimizedApplied ? "ready" : hasOptimizedPreview ? "active" : "warning",
        action: optimizedApplied ? "Applied" : hasOptimizedPreview ? "Apply Preview" : "Keep Original"
      }
    ];
  }, [
    bundleStats?.imageCount,
    manifest?.sceneUrl,
    optimizationJob?.optimizedSceneUrl,
    optimizationJob?.status,
    optimizationProfile,
    selectedOptimizationProfile,
    selectedTexturePlan,
    toolStatus?.tools.toktx?.ready
  ]);
  const optimizationSymptomSteps = useMemo(() => {
    const profileWarningCount = selectedOptimizationProfile?.warnings.length ?? 0;
    const texturePlanItems = selectedTexturePlan?.items.length ?? 0;
    const textureOverBudget = selectedTexturePlan
      ? selectedTexturePlan.currentBytes > selectedTexturePlan.budgetBytes
      : false;
    const hasOptimizedPreview = Boolean(optimizationJob?.optimizedSceneUrl);
    const optimizedApplied = manifest?.sceneUrl === "scene.optimized.glb";
    return [
      {
        id: "slow-load",
        label: "Loads slowly",
        detail:
          profileWarningCount > 0
            ? `${profileWarningCount} ${optimizationProfile} budget warning${profileWarningCount === 1 ? "" : "s"} found.`
            : hasOptimizedPreview
              ? "An optimized preview is ready to compare."
              : "Generate a compressed preview before applying it.",
        status: profileWarningCount > 0 || !hasOptimizedPreview ? "warning" : "ready",
        action: hasOptimizedPreview ? "Compare" : "Generate"
      },
      {
        id: "mobile-crash",
        label: "Mobile crashes",
        detail: textureOverBudget
          ? `Texture RAM is above the ${selectedTexturePlan?.label ?? optimizationProfile} budget.`
          : profileWarningCount > 0
            ? "Profile warnings can still break weaker devices."
            : "Switch to Mobile and generate a lighter preview.",
        status: textureOverBudget || profileWarningCount > 0 || optimizationProfile !== "mobile" ? "warning" : "ready",
        action: optimizationProfile === "mobile" ? "Mobile Set" : "Use Mobile"
      },
      {
        id: "huge-textures",
        label: "Textures huge",
        detail:
          texturePlanItems > 0
            ? `${texturePlanItems} texture resize target${texturePlanItems === 1 ? "" : "s"} need review.`
            : (bundleStats?.imageCount ?? 0) > 0
              ? "No large texture resize targets for this profile."
              : "No image textures found in this bundle.",
        status: texturePlanItems > 0 ? "warning" : "ready",
        action: texturePlanItems > 0 ? "Open Plan" : "Textures OK"
      },
      {
        id: "quality-changed",
        label: "Quality changed",
        detail: optimizedApplied
          ? "Viewer uses optimized GLB; switch back if it looks worse."
          : hasOptimizedPreview
            ? "Preview exists; compare before applying to the viewer."
            : "Generate a preview, then compare with the original.",
        status: optimizedApplied ? "ready" : hasOptimizedPreview ? "active" : "warning",
        action: optimizedApplied ? "Original" : hasOptimizedPreview ? "Apply Preview" : "Generate"
      }
    ];
  }, [
    bundleStats?.imageCount,
    manifest?.sceneUrl,
    optimizationJob?.optimizedSceneUrl,
    optimizationProfile,
    selectedOptimizationProfile,
    selectedTexturePlan
  ]);

  const updateManifest = (updater: (manifest: SceneManifest) => SceneManifest) => {
    setManifest((current) => (current ? updater(current) : current));
  };

  const updateBranding = (field: "title" | "clientName" | "accentColor", value: string) => {
    updateManifest((current) => ({
      ...current,
      branding: {
        ...current.branding,
        [field]: value
      }
    }));
  };

  const updateView = (viewId: string, updater: (view: SceneView) => SceneView) => {
    updateManifest((current) => ({
      ...current,
      views: current.views.map((view) => (view.id === viewId ? updater(view) : view))
    }));
  };

  const updateRoom = (roomId: string, updater: (room: RoomDefinition) => RoomDefinition) => {
    updateManifest((current) => ({
      ...current,
      rooms: (current.rooms ?? []).map((room) => (room.id === roomId ? updater(room) : room))
    }));
  };

  const updateHotspot = (
    interactionId: string,
    updater: (interaction: HotspotInteraction) => HotspotInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isHotspot(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const updateLink = (
    interactionId: string,
    updater: (interaction: LinkInteraction) => LinkInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isLink(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const updateObjectToggle = (
    interactionId: string,
    updater: (interaction: ObjectToggleInteraction) => ObjectToggleInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isObjectToggle(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const updateVideoTexture = (
    interactionId: string,
    updater: (interaction: VideoTextureInteraction) => VideoTextureInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isVideoTexture(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const applySelectedInteractionPosition = (position: Vec3) => {
    const nextPosition: Vec3 = [
      Number(position[0].toFixed(3)),
      Number(position[1].toFixed(3)),
      Number(position[2].toFixed(3))
    ];
    if (selectedHotspot) {
      updateHotspot(selectedHotspot.id, (interaction) => ({ ...interaction, position: nextPosition }));
      return;
    }
    if (selectedLink) {
      updateLink(selectedLink.id, (interaction) => ({ ...interaction, position: nextPosition }));
      return;
    }
    if (selectedObjectToggle) {
      updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
        ...interaction,
        position: nextPosition
      }));
    }
  };

  const updateMaterialVariantInteraction = (
    interactionId: string,
    updater: (interaction: MaterialVariantInteraction) => MaterialVariantInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isMaterialVariantInteraction(interaction)
          ? updater(interaction)
          : interaction
      )
    }));
  };

  const updateMaterial = (
    materialId: string,
    updater: (material: MaterialOverride) => MaterialOverride
  ) => {
    setMaterialsDoc((current) =>
      current
        ? {
            ...current,
            materials: current.materials.map((material) =>
              material.id === materialId ? updater(material) : material
            )
          }
        : current
    );
  };

  const updateObject = (
    objectId: string,
    updater: (object: ObjectOverride) => ObjectOverride,
    fallbackName?: string
  ) => {
    setObjectsDoc((current) => {
      if (!current) {
        if (!fallbackName) {
          return current;
        }
        return {
          schemaVersion: "0.1",
          generator: "studio",
          source: manifest?.objectsUrl ?? "objects.json",
          objects: [
            updater({
              id: objectId,
              name: fallbackName,
              visible: true
            })
          ]
        };
      }
      let found = false;
      const objects = current.objects.map((object) => {
        if (object.id !== objectId) {
          return object;
        }
        found = true;
        return updater(object);
      });
      if (found) {
        return {
          ...current,
          objects
        };
      }
      if (!fallbackName) {
        return current;
      }
      return {
        ...current,
        objects: [
          ...objects,
          updater({
            id: objectId,
            name: fallbackName,
            visible: true
          })
        ]
      };
    });
  };

  const setObjectNavigationBehavior = (
    objectId: string,
    objectName: string,
    behavior: NonNullable<ObjectOverride["navigationBehavior"]>
  ) => {
    updateObject(objectId, (object) => ({
      ...object,
      navigationBehavior: behavior
    }), objectName);
    const detail = objectNavigationBehaviorDetail(behavior);
    setObjectReviewMessage(`${objectName} set to ${detail.title}. Save & Test to verify movement in the viewer.`);
  };

  const hideCeilingCandidatesInTopView = () => {
    const ceilingRows = objectReviewRows.filter((row) => row.isCeilingOrRoof);
    if (ceilingRows.length === 0) {
      setObjectReviewMessage("No ceiling or roof candidates were detected from object names.");
      return;
    }
    const ceilingIds = new Set(ceilingRows.map((row) => row.node.id));
    setObjectsDoc((current) => {
      if (!current) {
        return current;
      }
      const existingIds = new Set(current.objects.map((object) => object.id));
      const additions: ObjectOverride[] = ceilingRows
        .filter((row) => !existingIds.has(row.node.id))
        .map((row) => ({
          id: row.node.id,
          name: row.node.name,
          visible: true,
          hideInTopView: true
        }));
      return {
        ...current,
        objects: [
          ...current.objects.map((object) =>
            ceilingIds.has(object.id) ? { ...object, hideInTopView: true } : object
          ),
          ...additions
        ]
      };
    });
    setObjectListFilter("ceiling");
    setObjectReviewMessage(`Marked ${ceilingRows.length} ceiling/roof candidate${ceilingRows.length === 1 ? "" : "s"} hidden in top view. Save & Test to verify the floorplan.`);
  };

  const updateControls = (updater: (controls: SceneControlsDocument) => SceneControlsDocument) => {
    setControlsDoc((current) => (current ? updater(current) : current));
  };

  const updateEnvironment = (updater: (environment: NonNullable<SceneManifest["environment"]>) => NonNullable<SceneManifest["environment"]>) => {
    updateManifest((current) => ({
      ...current,
      environment: updater(current.environment ?? {})
    }));
  };

  const applyEnvironmentPreset = (preset: "interior" | "exterior" | "review") => {
    updateEnvironment((environment) => {
      if (preset === "interior") {
        return {
          ...environment,
          skyBackdropEnabled: true,
          groundEnabled: false,
          enclosureEnabled: false,
          backgroundColor: "#d8dde2",
          skyTopColor: "#d8e7f5",
          skyHorizonColor: "#f3f6f8"
        };
      }
      if (preset === "review") {
        return {
          ...environment,
          skyBackdropEnabled: false,
          groundEnabled: false,
          enclosureEnabled: false,
          backgroundColor: "#f4f6f8"
        };
      }
      return {
        ...environment,
        skyBackdropEnabled: true,
        groundEnabled: true,
        enclosureEnabled: true,
        backgroundColor: "#d8dde2",
        skyTopColor: "#d8e7f5",
        skyHorizonColor: "#f3f6f8",
        groundColor: "#6f8f5a",
        enclosureColor: "#5f7f4b",
        groundSize: 90,
        enclosureRadius: 44,
        enclosureHeight: 14,
        groundY: -0.04
      };
    });
  };

  const updateNavigation = (updater: (navigation: SceneManifest["navigation"]) => SceneManifest["navigation"]) => {
    updateManifest((current) => ({
      ...current,
      navigation: updater(current.navigation)
    }));
  };

  const updateRendering = (updater: (rendering: NonNullable<SceneManifest["rendering"]>) => NonNullable<SceneManifest["rendering"]>) => {
    updateManifest((current) => ({
      ...current,
      rendering: updater(current.rendering ?? {})
    }));
  };

  const navigationBoundsFromGraph = (): SceneManifest["navigation"]["bounds"] | undefined => {
    if (!sceneGraph) {
      return undefined;
    }
    const nodeBounds = sceneGraph.nodes
      .map((node) => node.bounds)
      .filter((bounds): bounds is NonNullable<SceneGraphDocument["nodes"][number]["bounds"]> =>
        Boolean(bounds)
      );
    const firstBounds = nodeBounds[0];
    if (!firstBounds) {
      return undefined;
    }
    const bounds = nodeBounds.slice(1).reduce(
      (current, next) => ({
        min: [
          Math.min(current.min[0], next.min[0]),
          Math.min(current.min[1], next.min[1]),
          Math.min(current.min[2], next.min[2])
        ] as Vec3,
        max: [
          Math.max(current.max[0], next.max[0]),
          Math.max(current.max[1], next.max[1]),
          Math.max(current.max[2], next.max[2])
        ] as Vec3
      }),
      { min: [...firstBounds.min] as Vec3, max: [...firstBounds.max] as Vec3 }
    );
    const scale = manifest?.rendering?.modelScale ?? 1;
    const offset = manifest?.rendering?.modelOffset ?? [0, 0, 0];
    const margin = 0.75;
    return {
      min: [
        bounds.min[0] * scale + offset[0] - margin,
        Math.min(0.2, bounds.min[1] * scale + offset[1] - 0.1),
        bounds.min[2] * scale + offset[2] - margin
      ],
      max: [
        bounds.max[0] * scale + offset[0] + margin,
        Math.max(bounds.max[1] * scale + offset[1] + 0.5, (manifest?.navigation.cameraHeight ?? 1.65) + 0.5),
        bounds.max[2] * scale + offset[2] + margin
      ]
    };
  };

  const applyBoundsFromGraph = () => {
    const bounds = navigationBoundsFromGraph();
    if (!bounds) {
      return;
    }
    updateNavigation((navigation) => ({
      ...navigation,
      bounds
    }));
  };

  const fitNavigationBoundsToRouteZones = () => {
    updateNavigation((navigation) => {
      const routeZones = enabledNavigationZones(navigation).filter((zone) => zone.kind === "walk" || zone.kind === "pass");
      if (routeZones.length === 0) {
        return navigation;
      }
      const currentBounds = navigation.bounds ?? navigationBoundsFromGraph();
      if (!currentBounds) {
        return navigation;
      }
      const nextBounds = routeZones.reduce(
        (bounds, zone) => {
          const box = navigationZoneAabb(zone);
          return {
            min: [
              Math.min(bounds.min[0], box.minX - 0.2),
              Math.min(bounds.min[1], zone.center[1] - Math.max(0.2, zone.size[1] / 2)),
              Math.min(bounds.min[2], box.minZ - 0.2)
            ] as Vec3,
            max: [
              Math.max(bounds.max[0], box.maxX + 0.2),
              Math.max(bounds.max[1], zone.center[1] + Math.max(0.2, zone.size[1] / 2)),
              Math.max(bounds.max[2], box.maxZ + 0.2)
            ] as Vec3
          };
        },
        {
          min: [...currentBounds.min] as Vec3,
          max: [...currentBounds.max] as Vec3
        }
      );
      return {
        ...navigation,
        bounds: {
          min: [
            Number(nextBounds.min[0].toFixed(3)),
            Number(nextBounds.min[1].toFixed(3)),
            Number(nextBounds.min[2].toFixed(3))
          ],
          max: [
            Number(nextBounds.max[0].toFixed(3)),
            Number(nextBounds.max[1].toFixed(3)),
            Number(nextBounds.max[2].toFixed(3))
          ]
        }
      };
    });
    setRepairSummary("Expanded movement bounds to include active walk and door-pass zones. Save changes, then retry click navigation.");
    setNotice("saved");
  };

  const addNavigationZone = (kind: NavigationZone["kind"]) => {
    updateNavigation((navigation) => {
      const zones = [...(navigation.zones ?? [])];
      const nextIndex = zones.length + 1;
      return {
        ...navigation,
        zones: [...zones, createNavigationZone(nextIndex, kind, navigation.bounds)]
      };
    });
  };

  const createNavigationZoneAtPoint = (
    kind: NavigationZone["kind"],
    point: Vec3,
    navigation: SceneManifest["navigation"]
  ): NavigationZone => {
    const zones = navigation.zones ?? [];
    const nextIndex = zones.length + 1;
    const base = createNavigationZone(nextIndex, kind, navigation.bounds);
    const idSuffix = `${Date.now()}`.slice(-6);
    const cameraHeight = navigation.cameraHeight;
    const isWalk = kind === "walk";
    const isPass = kind === "pass";
    return {
      ...base,
      id: `${kind}-paint-${idSuffix}`,
      label: kind === "walk" ? `Walk Area ${nextIndex}` : kind === "pass" ? `Door Pass ${nextIndex}` : `Blocker ${nextIndex}`,
      center: [
        Number(point[0].toFixed(3)),
        isWalk
          ? Number(((navigation.bounds?.min[1] ?? 0) + 0.03).toFixed(3))
          : Number(Math.max(0.8, cameraHeight * 0.55).toFixed(3)),
        Number(point[2].toFixed(3))
      ],
      size: isWalk
        ? [2.4, 0.08, 2.4]
        : isPass
          ? [0.9, Math.max(1.8, cameraHeight + 0.6), 1.35]
          : [0.35, Math.max(1.8, cameraHeight + 0.6), 2.8],
      source: "authored"
    };
  };

  const createBoundaryBlockZones = () => {
    updateNavigation((navigation) => {
      const bounds = navigation.bounds;
      if (!bounds) {
        return navigation;
      }
      const existing = (navigation.zones ?? []).filter((zone) => !zone.id.startsWith("boundary-block-"));
      return {
        ...navigation,
        zones: [...existing, ...createBoundaryBlockZoneSet(bounds, navigation.cameraHeight)]
      };
    });
    setNotice("saved");
  };

  const openNavigationPaintTool = (kind: NavigationZone["kind"]) => {
    setNavigationPaintKind(kind);
    setNavigationPaintShape("rectangle");
    setNavigationPolygonDraft(null);
    window.setTimeout(() => document.querySelector(".zone-map")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  };

  const runNavigationQuickFixAction = (quickFix: NavigationQuickFix) => {
    if (quickFix.action === "bounds") {
      applyBoundsFromGraph();
      return;
    }
    if (quickFix.action === "fit-zone-bounds") {
      fitNavigationBoundsToRouteZones();
      return;
    }
    if (quickFix.action === "paint-walk") {
      openNavigationPaintTool("walk");
      return;
    }
    if (quickFix.action === "paint-pass") {
      openNavigationPaintTool("pass");
      return;
    }
    if (quickFix.action === "view-walks") {
      createWalkZonesFromViews();
      return;
    }
    if (quickFix.action === "widen-pass") {
      widenNarrowPassZones();
      return;
    }
    if (quickFix.action === "bridge") {
      createBridgePassZones();
      return;
    }
    if (quickFix.action === "auto") {
      autoRepairNavigation();
      return;
    }
    if (quickFix.action === "review-zones") {
      setShowNavigationZoneList(true);
      setShowGeneratedNavigationZones(true);
      if (quickFix.targetZoneId) {
        setExpandedNavigationZoneIds((current) => new Set(current).add(quickFix.targetZoneId!));
      }
      setRepairSummary("Opened navigation zone details. Review highlighted walk/pass and block zones, then resize or split blockers away from the intended route.");
      window.setTimeout(() => document.querySelector(".zone-map")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId));
  };

  const runNavigationQuickFix = () => runNavigationQuickFixAction(navigationQuickFix);

  const widenNarrowPassZones = () => {
    const bodyRadius = controlsDoc?.movement.collisionRadius ?? 0.28;
    const requiredSpan = Math.max(0.42, bodyRadius * 2);
    let widenedCount = 0;
    updateNavigation((navigation) => ({
      ...navigation,
      zones: (navigation.zones ?? []).map((zone) => {
        if (zone.kind !== "pass" || zone.enabled === false || navigationZoneNarrowestSpan(zone) >= requiredSpan) {
          return zone;
        }
        widenedCount += 1;
        return markNavigationZoneAuthored(widenNavigationPassZone(zone, requiredSpan));
      })
    }));
    setRepairSummary(
      widenedCount > 0
        ? `Widened ${widenedCount} narrow door pass zone(s) to at least ${requiredSpan.toFixed(2)}m. Save changes, then retry the viewer.`
        : "No narrow pass zones needed widening."
    );
    setNotice("saved");
  };

  const disableGeneratedNavigationZones = () => {
    updateNavigation((navigation) => ({
      ...navigation,
      zones: (navigation.zones ?? []).map((zone) =>
        zone.source === "generated" ? { ...zone, enabled: false } : zone
      )
    }));
    setShowGeneratedNavigationZones(true);
    setRepairSummary("Disabled auto-detected navigation zones. Add manual walk/pass/block zones, save, then retry the viewer.");
    setNotice("saved");
  };

  const createWalkZonesFromViews = () => {
    const walkViews = manifest?.views.filter((view) => view.kind === "walk") ?? [];
    if (walkViews.length === 0) {
      return;
    }
    updateNavigation((navigation) => {
      const existing = (navigation.zones ?? []).filter((zone) => !zone.id.startsWith("walk-view-"));
      return {
        ...navigation,
        zones: [...existing, ...createWalkZonesForViews(walkViews, navigation)]
      };
    });
    setNotice("saved");
  };

  const autoRepairNavigation = () => {
    const walkViews = manifest?.views.filter((view) => view.kind === "walk") ?? [];
    const graphBounds = navigationBoundsFromGraph();
    updateNavigation((navigation) => {
      const bounds = navigation.bounds ?? graphBounds;
      const existing = (navigation.zones ?? []).filter(
        (zone) =>
          !zone.id.startsWith("boundary-block-") &&
          !zone.id.startsWith("walk-view-") &&
          !zone.id.startsWith("pass-bridge-") &&
          zone.generatedBy !== "door-detection"
      );
      const zones: NavigationZone[] = [...existing];
      const repairedNavigation: SceneManifest["navigation"] = {
        ...navigation,
        ...(bounds ? { bounds } : {}),
        zones
      };
      let boundaryCount = 0;
      let walkPatchCount = 0;
      let bridgeCount = 0;
      let detectedDoorPassCount = 0;
      let expandedPassCount = 0;
      let widenedPassCount = 0;
      const usedIds = new Set(zones.map((zone) => zone.id));

      if (bounds) {
        const boundaryZones = createBoundaryBlockZoneSet(bounds, navigation.cameraHeight);
        boundaryCount = boundaryZones.length;
        zones.push(...boundaryZones);
      }

      if (walkViews.length > 0) {
        const viewZones = createWalkZonesForViews(walkViews, repairedNavigation);
        walkPatchCount = viewZones.length;
        zones.push(...viewZones);
      }

      doorPassCandidates.slice(0, 8).forEach((candidate) => {
        const alreadyCovered = zones.some((zone) => {
          if (zone.kind !== "pass") {
            return false;
          }
          return Math.hypot(zone.center[0] - candidate.center[0], zone.center[2] - candidate.center[2]) < 0.55;
        });
        if (alreadyCovered) {
          return;
        }
        const baseId = `pass-door-${candidate.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72);
        let nextId = baseId;
        let suffix = 2;
        while (usedIds.has(nextId)) {
          nextId = `${baseId}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(nextId);
        const walkZonesForDoorPass = enabledNavigationZones({ ...repairedNavigation, zones }, "walk");
        zones.push(
          expandDoorPassToWalkZones(
            createDoorPassZoneFromCandidate(candidate, nextId, "generated"),
            walkZonesForDoorPass,
            navigation.cameraHeight
          )
        );
        detectedDoorPassCount += 1;
      });

      const walkZonesForPassRepair = enabledNavigationZones({ ...repairedNavigation, zones }, "walk");
      zones.splice(
        0,
        zones.length,
        ...zones.map((zone) => {
          if (zone.kind !== "pass") {
            return zone;
          }
          const expanded = expandedOneSidedPassZone(zone, walkZonesForPassRepair, navigation.cameraHeight);
          if (!expanded) {
            return zone;
          }
          expandedPassCount += 1;
          return expanded;
        })
      );

      const requiredPassSpan = Math.max(0.42, (controlsDoc?.movement.collisionRadius ?? 0.28) * 2);
      zones.splice(
        0,
        zones.length,
        ...zones.map((zone) => {
          if (zone.kind !== "pass" || zone.enabled === false || navigationZoneNarrowestSpan(zone) >= requiredPassSpan) {
            return zone;
          }
          widenedPassCount += 1;
          return markNavigationZoneAuthored(widenNavigationPassZone(zone, requiredPassSpan));
        })
      );

      const routeZones = enabledNavigationZones({ ...repairedNavigation, zones }).filter(
        (zone) => zone.kind === "walk" || zone.kind === "pass"
      );
      const components = navigationComponents(routeZones);
      if (components.length > 1) {
        const connectedComponents: NavigationZone[][] = [components[0] ?? []];
        components.slice(1).forEach((component, index) => {
          const nearest = nearestNavigationComponentBridge(connectedComponents.flat(), component);
          if (!nearest || nearest.gap > Math.max(2.4, navigation.cameraHeight * 1.45)) {
            return;
          }
          zones.push(createBridgePassZone(nearest.from, nearest.to, index + 1, navigation.cameraHeight));
          bridgeCount += 1;
          connectedComponents.push(component);
        });
      }

      const summary = [
        bounds && !navigation.bounds ? "set bounds" : undefined,
        boundaryCount > 0 ? `${boundaryCount} boundary block(s)` : undefined,
        walkPatchCount > 0 ? `${walkPatchCount} walk patch(es)` : undefined,
        detectedDoorPassCount > 0 ? `${detectedDoorPassCount} detected door pass(es)` : undefined,
        expandedPassCount > 0 ? `${expandedPassCount} one-sided pass repair(s)` : undefined,
        widenedPassCount > 0 ? `${widenedPassCount} widened pass zone(s)` : undefined,
        bridgeCount > 0 ? `${bridgeCount} bridge pass zone(s)` : undefined
      ].filter(Boolean);
      setRepairSummary(
        summary.length > 0
          ? `Auto repair added ${summary.join(", ")}. Save changes, then retry the viewer.`
          : "Auto repair found no navigation changes to add."
      );
      return {
        ...repairedNavigation,
        zones
      };
    });
    setNotice("saved");
  };

  const createBridgePassZones = () => {
    updateNavigation((navigation) => {
      const routeZones = enabledNavigationZones(navigation).filter((zone) => zone.kind === "walk" || zone.kind === "pass");
      const components = navigationComponents(routeZones);
      if (components.length <= 1) {
        setRepairSummary("Navigation zones are already connected.");
        return navigation;
      }

      const existing = (navigation.zones ?? []).filter((zone) => !zone.id.startsWith("pass-bridge-"));
      const bridges: NavigationZone[] = [];
      const bridgeDescriptions: string[] = [];
      const skippedDescriptions: string[] = [];
      const connectedComponents: NavigationZone[][] = [components[0] ?? []];
      const cameraHeight = navigation.cameraHeight;
      const maxBridgeGap = Math.max(2.4, cameraHeight * 1.45);

      components.slice(1).forEach((component, index) => {
        const nearest = nearestNavigationComponentBridge(connectedComponents.flat(), component);
        if (!nearest) {
          return;
        }
        const fromName = navigationZoneDisplayName(nearest.from);
        const toName = navigationZoneDisplayName(nearest.to);
        if (nearest.gap > maxBridgeGap) {
          skippedDescriptions.push(`${fromName} to ${toName} is ${nearest.gap.toFixed(1)}m apart`);
          return;
        }
        bridges.push({
          ...createBridgePassZone(nearest.from, nearest.to, index + 1, cameraHeight),
          label: `Bridge ${fromName} to ${toName}`.slice(0, 80)
        });
        bridgeDescriptions.push(`${fromName} to ${toName}`);
        connectedComponents.push(component);
      });

      if (bridges.length === 0) {
        setRepairSummary(
          skippedDescriptions.length > 0
            ? `No close navigation islands found to bridge automatically. Closest gap: ${skippedDescriptions[0]}. Draw a Door Pass manually through the opening.`
            : "No close navigation islands found to bridge automatically. Draw a Door Pass manually through the opening."
        );
        return navigation;
      }

      setRepairSummary(
        `Added ${bridges.length} bridge pass zone(s)${
          bridgeDescriptions.length > 0 ? `: ${bridgeDescriptions.slice(0, 3).join(", ")}` : ""
        }. Save changes, then retry the viewer.`
      );
      return {
        ...navigation,
        zones: [...existing, ...bridges]
      };
    });
    setNotice("saved");
  };

  const addNavigationRepairZone = (kind: "walk" | "pass") => {
    const point = navigationRepairDraft?.point;
    if (!point) {
      return;
    }
    const repairTarget = navigationRepairDraft?.target ?? point;
    updateNavigation((navigation) => {
      const zones = [...(navigation.zones ?? [])];
      const idSuffix = `${Date.now()}`.slice(-6);
      const isWalk = kind === "walk";
      const floorY = navigation.bounds ? navigation.bounds.min[1] + 0.03 : 0.03;
      const from = navigationRepairDraft?.from;
      const dx = from ? repairTarget[0] - from[0] : 0;
      const dz = from ? repairTarget[2] - from[2] : 0;
      const routeDistance = Math.hypot(dx, dz);
      const hasDirection = routeDistance > 0.05;
      const unitX = hasDirection ? dx / routeDistance : 0;
      const unitZ = hasDirection ? dz / routeDistance : 1;
      const rotationY = !isWalk && hasDirection ? Math.atan2(dx, dz) : 0;
      const passLength = hasDirection
        ? Number(clampNumber(routeDistance * 0.36, 1.35, 2.6).toFixed(3))
        : 1.35;
      const passCenterOffset = !isWalk && hasDirection ? Math.min(0.65, routeDistance * 0.22) : 0;
      const targetPoint: Vec3 = [repairTarget[0], floorY, repairTarget[2]];
      const sourcePoint: Vec3 | undefined = from ? [from[0], floorY, from[2]] : undefined;
      const existingWalkZones = enabledNavigationZones(navigation, "walk");
      const sourceWalkZone = sourcePoint
        ? existingWalkZones.find((walkZone) => pointInNavigationZone(walkZone, sourcePoint, 0.4))
        : undefined;
      const targetWalkZone = existingWalkZones.find((walkZone) => pointInNavigationZone(walkZone, targetPoint, 0.4));
      const targetWalkPatch: NavigationZone | undefined =
        kind === "pass" && !targetWalkZone
          ? {
              id: `walk-repair-${idSuffix}`,
              label: "Target walk repair",
              kind: "walk",
              center: [Number(repairTarget[0].toFixed(3)), Number(floorY.toFixed(3)), Number(repairTarget[2].toFixed(3))],
              size: [2.2, 0.08, 2.2],
              rotationY: 0,
              enabled: true,
              source: "authored"
            }
          : undefined;
      const sourceWalkPatch: NavigationZone | undefined =
        kind === "pass" && sourcePoint && !sourceWalkZone && routeDistance > 1.2
          ? {
              id: `walk-source-repair-${idSuffix}`,
              label: "Source walk repair",
              kind: "walk",
              center: [Number(sourcePoint[0].toFixed(3)), Number(floorY.toFixed(3)), Number(sourcePoint[2].toFixed(3))],
              size: [2.2, 0.08, 2.2],
              rotationY: 0,
              enabled: true,
              source: "authored"
            }
          : undefined;
      const bridgeFrom = sourceWalkZone ?? sourceWalkPatch;
      const bridgeTo = targetWalkZone ?? targetWalkPatch;
      const zoneCenter: Vec3 = [
        Number((point[0] - unitX * passCenterOffset).toFixed(3)),
        isWalk ? Number(floorY.toFixed(3)) : Math.max(0.8, navigation.cameraHeight * 0.55),
        Number((point[2] - unitZ * passCenterOffset).toFixed(3))
      ];
      const zone: NavigationZone =
        kind === "pass" && bridgeFrom && bridgeTo && bridgeFrom.id !== bridgeTo.id
          ? {
              ...createBridgePassZone(bridgeFrom, bridgeTo, Number(idSuffix), navigation.cameraHeight),
              id: `pass-repair-${idSuffix}`,
              label: "Door pass repair",
              source: "authored"
            }
          : {
              id: `${kind}-repair-${idSuffix}`,
              label: isWalk ? "Walk repair" : "Door pass repair",
              kind,
              center: zoneCenter,
              size: isWalk
                ? [2.2, 0.08, 2.2]
                : [0.9, Math.max(1.8, navigation.cameraHeight + 0.6), passLength],
              rotationY,
              enabled: true,
              source: "authored"
            };
      const patches = [sourceWalkPatch, targetWalkPatch].filter((patch): patch is NavigationZone => Boolean(patch));
      return {
        ...navigation,
        zones: [...zones, ...patches, zone]
      };
    });
    setRepairSummary(
      kind === "pass"
        ? "Added a doorway pass and any missing target walk area. Save changes, then retry the click in the viewer."
        : "Added a walk patch at the blocked point. Save changes, then retry the click in the viewer."
    );
    setNotice("saved");
  };

  const applyNavigationRepairRecommendation = () => {
    if (!repairRecommendation || !navigationRepairDraft) {
      return;
    }
    if (repairRecommendation.action === "ignore") {
      ignoreCollisionName(navigationRepairDraft.blockerName);
      return;
    }
    if (repairRecommendation.action === "tune") {
      applyMovementPreset(
        "steps",
        "Applied the Steps movement preset for thresholds and stairs. Save changes, then retry the click in the viewer."
      );
      return;
    }
    addNavigationRepairZone(repairRecommendation.action);
  };

  const addPassZoneFromCandidate = (candidate: DoorPassCandidate) => {
    updateNavigation((navigation) => {
      const zones = [...(navigation.zones ?? [])];
      const id = `pass-${candidate.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 72);
      let nextId = id;
      let suffix = 2;
      const usedIds = new Set(zones.map((zone) => zone.id));
      while (usedIds.has(nextId)) {
        nextId = `${id}-${suffix}`;
        suffix += 1;
      }
      const walkZones = enabledNavigationZones(navigation, "walk");
      return {
        ...navigation,
        zones: [
          ...zones,
          expandDoorPassToWalkZones(
            createDoorPassZoneFromCandidate(candidate, nextId, "authored"),
            walkZones,
            navigation.cameraHeight
          )
        ]
      };
    });
    setNotice("saved");
  };

  const updateNavigationZone = (
    zoneId: string,
    updater: (zone: NavigationZone) => NavigationZone
  ) => {
    updateNavigation((navigation) => ({
      ...navigation,
      zones: (navigation.zones ?? []).map((zone) =>
        zone.id === zoneId ? markNavigationZoneAuthored(updater(zone)) : zone
      )
    }));
  };

  const removeNavigationZone = (zoneId: string) => {
    updateNavigation((navigation) => ({
      ...navigation,
      zones: (navigation.zones ?? []).filter((zone) => zone.id !== zoneId)
    }));
    setExpandedNavigationZoneIds((current) => {
      const next = new Set(current);
      next.delete(zoneId);
      return next;
    });
  };

  const toggleNavigationZoneAdvanced = (zoneId: string) => {
    setExpandedNavigationZoneIds((current) => {
      const next = new Set(current);
      if (next.has(zoneId)) {
        next.delete(zoneId);
      } else {
        next.add(zoneId);
      }
      return next;
    });
  };

  const ignoreCollisionName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    updateNavigation((navigation) => {
      const names = navigation.ignoredCollisionMeshNames ?? [];
      if (names.some((item) => item.toLowerCase() === trimmed.toLowerCase())) {
        return navigation;
      }
      return {
        ...navigation,
        ignoredCollisionMeshNames: [...names, trimmed]
      };
    });
    setBlockerNameDraft("");
    setRepairSummary(`Ignored ${trimmed} as navigation collision. Save changes, then retry the click in the viewer.`);
    setNotice("saved");
  };

  const applyNarrowBodyRepair = () => {
    if (typeof narrowBodyRepairRadius !== "number") {
      return;
    }
    updateControls((current) => ({
      ...current,
      movement: {
        ...current.movement,
        collisionRadius: narrowBodyRepairRadius
      }
    }));
    setRepairSummary(
      `Body Radius set to ${narrowBodyRepairRadius.toFixed(2)}. Save changes, then retry the doorway click in the viewer.`
    );
    setNotice("saved");
  };

  const applyMovementPreset = (presetId: string, summary?: string) => {
    const preset = movementPresets.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    updateControls((current) => ({
      ...current,
      movement: {
        ...current.movement,
        ...preset.movement
      }
    }));
    if (summary) {
      setRepairSummary(summary);
    }
    setNotice("saved");
  };

  const setNavigationRepairObjectBehavior = (
    behavior: NonNullable<ObjectOverride["navigationBehavior"]>
  ) => {
    const match = navigationRepairObjectMatch;
    if (!match) {
      return;
    }
    const blockerName = navigationRepairDraft?.blockerName?.trim();
    const clickedObjectName = navigationRepairDraft?.objectName?.trim();
    updateObject(match.object.id, (object) => ({
      ...object,
      navigationBehavior: behavior
    }), match.object.name);
    if (behavior === "ignore") {
      updateNavigation((navigation) => {
        const existing = navigation.ignoredCollisionMeshNames ?? [];
        const next = [...existing];
        [blockerName, clickedObjectName, match.object.name]
          .filter((name): name is string => Boolean(name))
          .forEach((name) => {
            if (!next.some((item) => item.toLowerCase() === name.toLowerCase())) {
              next.push(name);
            }
          });
        return {
          ...navigation,
          ignoredCollisionMeshNames: next
        };
      });
    }
    setSelectedObjectId(match.object.id);
    setRepairSummary(
      behavior === "ignore"
        ? `Marked ${match.object.name} as ignored for navigation. Save changes, then retry the click in the viewer.`
        : behavior === "walk"
          ? `Marked ${match.object.name} as walkable. Save changes, then retry the click in the viewer.`
          : `Marked ${match.object.name} as a collision object. Save changes, then retry the click in the viewer.`
    );
    setNotice("saved");
  };

  const moveNavigationZoneOnMap = (
    zoneId: string,
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const navigation = manifest?.navigation;
    const bounds = navigation?.bounds;
    if (!bounds) {
      return;
    }
    const pointFromClient = (x: number, y: number): Vec3 => {
      const rect = mapElement.getBoundingClientRect();
      const ratioX = clampNumber((x - rect.left) / Math.max(1, rect.width), 0, 1);
      const ratioY = clampNumber((y - rect.top) / Math.max(1, rect.height), 0, 1);
      const nextX = bounds.min[0] + ratioX * (bounds.max[0] - bounds.min[0]);
      const nextZ = bounds.max[2] - ratioY * (bounds.max[2] - bounds.min[2]);
      return [Number(nextX.toFixed(3)), bounds.min[1], Number(nextZ.toFixed(3))];
    };
    const applyPosition = (x: number, y: number) => {
      const point = pointFromClient(x, y);
      updateNavigationZone(zoneId, (zone) => ({
        ...zone,
        center: [point[0], zone.center[1], point[2]]
      }));
    };
    applyPosition(clientX, clientY);
    const handleMove = (event: PointerEvent) => applyPosition(event.clientX, event.clientY);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const moveNavigationZonePolygonPointOnMap = (
    zoneId: string,
    pointIndex: number,
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const navigation = manifest?.navigation;
    const bounds = navigation?.bounds;
    if (!bounds) {
      return;
    }
    const pointFromClient = (x: number, y: number): Vec2 => {
      const rect = mapElement.getBoundingClientRect();
      const ratioX = clampNumber((x - rect.left) / Math.max(1, rect.width), 0, 1);
      const ratioY = clampNumber((y - rect.top) / Math.max(1, rect.height), 0, 1);
      return [
        bounds.min[0] + ratioX * (bounds.max[0] - bounds.min[0]),
        bounds.max[2] - ratioY * (bounds.max[2] - bounds.min[2])
      ];
    };
    const applyPosition = (x: number, y: number) => {
      const [worldX, worldZ] = pointFromClient(x, y);
      updateNavigationZone(zoneId, (zone) => {
        const rotation = -(zone.rotationY ?? 0);
        const dx = worldX - zone.center[0];
        const dz = worldZ - zone.center[2];
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const localPoint: Vec2 = [
          Number((dx * cos - dz * sin).toFixed(3)),
          Number((dx * sin + dz * cos).toFixed(3))
        ];
        const polygon = zone.polygon ?? rectangularPolygonForZone(zone);
        return {
          ...zone,
          polygon: polygon.map((point, index) =>
            index === pointIndex ? snapPolygonPoint(localPoint, polygon, pointIndex) : point
          )
        };
      });
    };
    applyPosition(clientX, clientY);
    const handleMove = (event: PointerEvent) => applyPosition(event.clientX, event.clientY);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const insertNavigationZonePolygonPoint = (zoneId: string, afterIndex: number) => {
    updateNavigationZone(zoneId, (zone) => {
      const polygon = zone.polygon ?? rectangularPolygonForZone(zone);
      const current = polygon[afterIndex];
      const next = polygon[(afterIndex + 1) % polygon.length];
      if (!current || !next) {
        return zone;
      }
      const midpoint: Vec2 = [
        Number(((current[0] + next[0]) / 2).toFixed(3)),
        Number(((current[1] + next[1]) / 2).toFixed(3))
      ];
      return {
        ...zone,
        polygon: [
          ...polygon.slice(0, afterIndex + 1),
          midpoint,
          ...polygon.slice(afterIndex + 1)
        ]
      };
    });
  };

  const navigationMapPointFromClient = (
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ): Vec3 | undefined => {
    const navigation = manifest?.navigation;
    const bounds = navigation?.bounds;
    if (!bounds) {
      return undefined;
    }
    const rect = mapElement.getBoundingClientRect();
    const ratioX = clampNumber((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const ratioY = clampNumber((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    return [
      Number((bounds.min[0] + ratioX * (bounds.max[0] - bounds.min[0])).toFixed(3)),
      bounds.min[1],
      Number((bounds.max[2] - ratioY * (bounds.max[2] - bounds.min[2])).toFixed(3))
    ];
  };

  const paintNavigationZoneOnMap = (
    kind: NavigationZone["kind"],
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const navigation = manifest?.navigation;
    const point = navigationMapPointFromClient(mapElement, clientX, clientY);
    if (!navigation || !point) {
      return;
    }
    const zone = createNavigationZoneAtPoint(kind, point, navigation);
    updateNavigation((currentNavigation) => {
      return {
        ...currentNavigation,
        zones: [...(currentNavigation.zones ?? []), zone]
      };
    });
    setExpandedNavigationZoneIds((current) => new Set(current).add(zone.id));
    setRepairSummary(`${navigationZoneKindLabel(kind)} added on the map. Save changes, then retry the viewer.`);
    setNotice("saved");
  };

  const addNavigationPolygonDraftPoint = (
    kind: NavigationZone["kind"],
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const point = navigationMapPointFromClient(mapElement, clientX, clientY);
    if (!point) {
      return;
    }
    const polygonPoint: Vec2 = [point[0], point[2]];
    setNavigationPolygonDraft((current) => {
      if (!current || current.kind !== kind) {
        return { kind, points: [polygonPoint] };
      }
      return { ...current, points: [...current.points, polygonPoint] };
    });
  };

  const clearNavigationPolygonDraft = () => {
    setNavigationPolygonDraft(null);
  };

  const finishNavigationPolygonDraft = () => {
    const navigation = manifest?.navigation;
    const bounds = navigation?.bounds;
    const draft = navigationPolygonDraft;
    if (!navigation || !bounds || !draft || draft.points.length < 3) {
      return;
    }
    const minX = Math.min(...draft.points.map(([x]) => x));
    const maxX = Math.max(...draft.points.map(([x]) => x));
    const minZ = Math.min(...draft.points.map(([, z]) => z));
    const maxZ = Math.max(...draft.points.map(([, z]) => z));
    const centerX = Number(((minX + maxX) / 2).toFixed(3));
    const centerZ = Number(((minZ + maxZ) / 2).toFixed(3));
    const idSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const zone: NavigationZone = {
      id: `${draft.kind}-poly-${idSuffix}`,
      label: `${navigationZoneKindLabel(draft.kind)} polygon`,
      kind: draft.kind,
      center: [centerX, bounds.min[1], centerZ],
      size: [
        Number(Math.max(0.8, maxX - minX).toFixed(3)),
        0.08,
        Number(Math.max(0.8, maxZ - minZ).toFixed(3))
      ],
      rotationY: 0,
      enabled: true,
      source: "authored",
      polygon: draft.points.map(([x, z]) => [
        Number((x - centerX).toFixed(3)),
        Number((z - centerZ).toFixed(3))
      ])
    };
    updateNavigation((currentNavigation) => ({
      ...currentNavigation,
      zones: [...(currentNavigation.zones ?? []), zone]
    }));
    setExpandedNavigationZoneIds((current) => new Set(current).add(zone.id));
    setNavigationPolygonDraft(null);
    setRepairSummary(`${navigationZoneKindLabel(draft.kind)} polygon added on the map. Save changes, then retry the viewer.`);
    setNotice("saved");
  };

  const moveRoomOnMap = (
    roomId: string,
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const bounds = manifest?.navigation.bounds;
    if (!bounds) {
      return;
    }
    const applyPosition = (x: number, y: number) => {
      const room = (manifest?.rooms ?? []).find((item) => item.id === roomId);
      if (!room) {
        return;
      }
      const currentCenter = roomCenter(room, manifest?.views ?? []);
      const rect = mapElement.getBoundingClientRect();
      const ratioX = clampNumber((x - rect.left) / Math.max(1, rect.width), 0, 1);
      const ratioY = clampNumber((y - rect.top) / Math.max(1, rect.height), 0, 1);
      const nextX = bounds.min[0] + ratioX * (bounds.max[0] - bounds.min[0]);
      const nextZ = bounds.max[2] - ratioY * (bounds.max[2] - bounds.min[2]);
      updateRoom(roomId, (current) => ({
        ...current,
        center: [Number(nextX.toFixed(3)), current.center?.[1] ?? currentCenter[1], Number(nextZ.toFixed(3))]
      }));
    };
    applyPosition(clientX, clientY);
    const handleMove = (event: PointerEvent) => applyPosition(event.clientX, event.clientY);
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  };

  const persistDraft = async () => {
    if (!manifest) {
      return false;
    }

    setSaveError("");
    try {
      if (apiConnected) {
        await saveToApi();
        return true;
      }
      localStorage.setItem(draftKey(activeProjectId, "manifest"), JSON.stringify(manifest, null, 2));
      if (materialsDoc) {
        localStorage.setItem(draftKey(activeProjectId, "materials"), JSON.stringify(materialsDoc, null, 2));
      }
      if (objectsDoc) {
        localStorage.setItem(draftKey(activeProjectId, "objects"), JSON.stringify(objectsDoc, null, 2));
      }
      if (controlsDoc) {
        localStorage.setItem(draftKey(activeProjectId, "controls"), JSON.stringify(controlsDoc, null, 2));
      }
      setNotice("saved");
      return true;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed.");
      return false;
    }
  };

  const saveDraft = () => {
    void persistDraft();
  };

  const saveAndOpenViewer = async (url = viewerUrl(activeProjectId)) => {
    const saved = await persistDraft();
    if (!saved) {
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const saveToApi = async () => {
    if (!manifest) {
      return;
    }

    const postJson = async (path: string, body: unknown, label: string) => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
        throw new Error(error?.error ?? `${label} save failed with ${response.status}.`);
      }
    };

    await postJson(`/api/projects/${activeProjectId}/manifest`, manifest, "Manifest");

    if (materialsDoc) {
      await postJson(`/api/projects/${activeProjectId}/materials`, materialsDoc, "Materials");
    }

    if (objectsDoc) {
      await postJson(`/api/projects/${activeProjectId}/objects`, objectsDoc, "Objects");
    }

    if (controlsDoc) {
      await postJson(`/api/projects/${activeProjectId}/controls`, controlsDoc, "Controls");
    }

    const analyzeResponse = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/analyze`, {
      method: "POST"
    });
    if (analyzeResponse.ok) {
      const result = (await analyzeResponse.json()) as {
        stats?: BundleStats;
        optimization?: OptimizationDocument;
      };
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
    }

    setNotice("saved");
  };

  const resetDraft = async () => {
    localStorage.removeItem(draftKey(activeProjectId, "manifest"));
    localStorage.removeItem(draftKey(activeProjectId, "materials"));
    localStorage.removeItem(draftKey(activeProjectId, "objects"));
    localStorage.removeItem(draftKey(activeProjectId, "controls"));
    const response = await fetch(projectScenePath(activeProjectId));
    const parsed = parseSceneManifest(await response.json());
    setManifest(parsed);
    setSelectedViewId(parsed.views[0]?.id ?? "");
    setSelectedInteractionId(
      (
        parsed.interactions.find(isHotspot) ??
        parsed.interactions.find(isLink) ??
        parsed.interactions.find(isObjectToggle)
      )?.id ?? ""
    );
    setSelectedVariantInteractionId(parsed.interactions.find(isMaterialVariantInteraction)?.id ?? "");
    setMaterialsDoc(null);
    setObjectsDoc(null);
    setControlsDoc(null);
    setNotice("reset");
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setNotice("copied");
  };

  const createProject = async () => {
    const name = window.prompt("Project name", "New Residence");
    if (!name?.trim()) {
      return;
    }
    const response = await fetch(`${apiBaseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!response.ok) {
      return;
    }
    const project = (await response.json()) as {
      id: string;
      manifest: SceneManifest;
      stats: BundleStats;
    };
    const summary: ProjectSummary = {
      id: project.id,
      title: project.manifest.branding.title,
      viewCount: project.manifest.views.length,
      triangleCount: project.stats.triangleCount,
      updatedAt: project.stats.generatedAt
    };
    if (project.manifest.branding.clientName) {
      summary.clientName = project.manifest.branding.clientName;
    }
    setProjectSummaries((current) => [...current.filter((item) => item.id !== project.id), summary]);
    setActiveProjectId(project.id);
    setNotice("saved");
  };

  const publishProject = async () => {
    if (!apiConnected) {
      setPublishState("error");
      setPublishError("API is not connected.");
      return;
    }

    setPublishState("publishing");
    setPublishError("");
    setPublishSuccess("");
    try {
      const saved = await persistDraft();
      if (!saved) {
        setPublishState("error");
        setPublishError("Save failed. Fix the save error before publishing.");
        return;
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/publish`, {
        method: "POST"
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Publish failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        entry: PublishEntry;
        active: { version: string } | null;
        publishHistory: PublishHistoryDocument;
      };
      setPublishHistory(result.publishHistory);
      setProjectSummaries((current) =>
        current.map((project) => {
          if (project.id !== activeProjectId) {
            return project;
          }
          const nextProject: ProjectSummary = {
            ...project,
            publishCount: result.publishHistory.versions.length
          };
          const lastPublishedAt = result.publishHistory.versions[0]?.publishedAt;
          if (lastPublishedAt) {
            nextProject.lastPublishedAt = lastPublishedAt;
          }
          return nextProject;
        })
      );
      setPublishState("done");
      const deliveryMode = publishEntryDeliveryMode(result.entry);
      setPublishSuccess(
        result.active
          ? `${deliveryMode} version ${result.entry.version} is now the live client link.`
          : `${deliveryMode} version ${result.entry.version} was created for internal QA and is not live yet. Use Set Draft Live only after review.`
      );
      setNotice("saved");
    } catch (error) {
      setPublishState("error");
      setPublishError(error instanceof Error ? error.message : "Publish failed.");
      setPublishSuccess("");
    }
  };

  const activatePublishedVersion = async (entry: PublishEntry) => {
    if (!apiConnected) {
      setPublishError("API is not connected.");
      return;
    }
    if (
      entry.qualityGate?.status !== "ready" &&
      !window.confirm(
        `${publishEntryDeliveryMode(entry)} version ${entry.version} still has saved quality-gate issues. Set it as the live client link anyway?`
      )
    ) {
      return;
    }
    setActivePublishVersion(entry.version);
    setPublishError("");
    setPublishSuccess("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/publish/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: entry.version, allowDraft: entry.qualityGate?.status !== "ready" })
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Activate failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        publishHistory: PublishHistoryDocument;
      };
      setPublishHistory(result.publishHistory);
      setPublishSuccess(`${publishEntryDeliveryMode(entry)} version ${entry.version} is now the live client link.`);
      setNotice("saved");
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : "Could not set live version.");
    } finally {
      setActivePublishVersion("");
    }
  };

  const optimizeProject = async () => {
    if (!apiConnected) {
      setOptimizeState("error");
      setOptimizeError("API is not connected.");
      return;
    }

    setOptimizeState("optimizing");
    setOptimizeError("");
    try {
      const saved = await persistDraft();
      if (!saved) {
        setOptimizeState("error");
        setOptimizeError("Save failed. Fix the save error before optimizing.");
        return;
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: optimizationProfile, apply: applyOptimizedImmediately })
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Optimization failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest: SceneManifest;
        stats: BundleStats;
        optimization: OptimizationDocument;
        optimizationJob: OptimizationJobDocument;
        optimizationHistory: OptimizationHistoryDocument;
      };
      setManifest(result.manifest);
      setBundleStats(result.stats);
      setOptimizationDoc(result.optimization);
      setOptimizationJob(result.optimizationJob);
      setOptimizationHistory(result.optimizationHistory);
      setOptimizeState("done");
      setNotice("saved");
    } catch (error) {
      setOptimizeState("error");
      setOptimizeError(error instanceof Error ? error.message : "Optimization failed.");
    }
  };

  const bakeLightmaps = async () => {
    if (!apiConnected) {
      setBakeState("error");
      setBakeError("API is not connected.");
      return;
    }

    setBakeState("baking");
    setBakeError("");
    try {
      const saved = await persistDraft();
      if (!saved) {
        setBakeState("error");
        setBakeError("Save failed. Fix the save error before baking lightmaps.");
        return;
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/bake-lightmaps`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(bakeSettings)
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string; lightmapBakeJob?: LightmapBakeJobDocument };
        if (error.lightmapBakeJob) {
          setLightmapBakeJob(error.lightmapBakeJob);
        }
        throw new Error(error.error ?? `Lightmap bake failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest?: SceneManifest;
        materials?: MaterialsDocument;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
        lightmapBakeJob: LightmapBakeJobDocument;
      };
      if (result.manifest) {
        setManifest(result.manifest);
      }
      if (result.materials) {
        setMaterialsDoc(result.materials);
      }
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
      setLightmapBakeJob(result.lightmapBakeJob);
      setBakeState(result.lightmapBakeJob.status === "blocked" ? "error" : "done");
      setBakeError(result.lightmapBakeJob.status === "blocked" ? result.lightmapBakeJob.message ?? "" : "");
      setNotice("saved");
    } catch (error) {
      setBakeState("error");
      setBakeError(error instanceof Error ? error.message : "Lightmap bake failed.");
    }
  };

  const reviewLightmapMaterial = (materialName: string) => {
    const normalizedTarget = normalizeTextureMatchName(materialName);
    const matchedMaterial = materialsDoc?.materials.find((material) => {
      const normalizedName = normalizeTextureMatchName(material.name);
      return (
        normalizedName === normalizedTarget ||
        (normalizedName.length >= 3 && normalizedTarget.includes(normalizedName)) ||
        (normalizedTarget.length >= 3 && normalizedName.includes(normalizedTarget))
      );
    });
    if (matchedMaterial) {
      setSelectedMaterialId(matchedMaterial.id);
    }
    setMaterialListFilter("lightmaps");
    setMaterialSearchQuery(materialName);
    window.setTimeout(() => {
      document.querySelector(".material-diagnosis-card, .material-preview-strip")?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }, 0);
  };

  const switchModelSource = async (sceneUrl: string) => {
    if (!apiConnected) {
      setOptimizeState("error");
      setOptimizeError("API is not connected.");
      return;
    }

    setOptimizeState("optimizing");
    setOptimizeError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/model-source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneUrl })
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Model switch failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest: SceneManifest;
        stats: BundleStats;
        optimization: OptimizationDocument;
      };
      setManifest(result.manifest);
      setBundleStats(result.stats);
      setOptimizationDoc(result.optimization);
      setOptimizeState("done");
      setNotice("saved");
    } catch (error) {
      setOptimizeState("error");
      setOptimizeError(error instanceof Error ? error.message : "Model switch failed.");
    }
  };

  const repairImport = async () => {
    if (!apiConnected) {
      setRepairState("error");
      setRepairError("API is not connected.");
      return;
    }

    setRepairState("repairing");
    setRepairError("");
    setRepairSummary("");
    try {
      const saved = await persistDraft();
      if (!saved) {
        setRepairState("error");
        setRepairError("Save failed. Fix the save error before running import repair.");
        return;
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/repair-import`, {
        method: "POST"
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Import repair failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest: SceneManifest;
        controls: SceneControlsDocument;
        stats: BundleStats;
        optimization: OptimizationDocument;
        repairedExternalResources?: number;
        externalResourceRepair?: {
          copied?: number;
          skippedAmbiguous?: number;
          missing?: number;
          copiedPaths?: readonly { target: string; source: string }[];
          ambiguousPaths?: readonly { target: string; candidates: readonly string[] }[];
          missingPaths?: readonly string[];
        };
      };
      setManifest(result.manifest);
      setControlsDoc(result.controls);
      setBundleStats(result.stats);
      setOptimizationDoc(result.optimization);
      setSelectedViewId(result.manifest.views[0]?.id ?? "");
      const repair = result.externalResourceRepair;
      const repairNotes = [
        repair?.copied ? `Copied ${repair.copied} missing texture resource(s).` : "",
        repair?.copiedPaths?.[0] ? `Example: ${repair.copiedPaths[0].source} -> ${repair.copiedPaths[0].target}.` : "",
        result.stats.materialTextureSuggestionCount
          ? `Mapped ${result.stats.materialTextureSuggestionCount} loose texture(s) to material fields.`
          : "",
        repair?.skippedAmbiguous ? `Skipped ${repair.skippedAmbiguous} ambiguous same-name texture match(es).` : "",
        repair?.ambiguousPaths?.[0]
          ? `Ambiguous: ${repair.ambiguousPaths[0].target} matched ${repair.ambiguousPaths[0].candidates.slice(0, 3).join(", ")}.`
          : "",
        repair?.missing ? `${repair.missing} referenced texture resource(s) are still missing.` : ""
      ].filter(Boolean);
      setRepairSummary(
        repairNotes.length > 0
          ? repairNotes.join(" ")
          : "Import diagnostics refreshed; no missing texture paths needed copying."
      );
      setRepairState("done");
      setNotice("saved");
    } catch (error) {
      setRepairState("error");
      setRepairError(error instanceof Error ? error.message : "Import repair failed.");
    }
  };

  const uploadModel = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    if (!apiConnected) {
      setUploadState("error");
      setUploadError("API is not connected.");
      return;
    }
    const lowerName = file.name.toLowerCase();
    const isZip = lowerName.endsWith(".zip");
    const isGlb = lowerName.endsWith(".glb");
    const isGltf = lowerName.endsWith(".gltf");
    const isConvertible = /\.(dae|fbx|obj)$/i.test(lowerName);
    if (!isGlb && !isGltf && !isZip && !isConvertible) {
      setUploadState("error");
      setUploadError("Upload GLB, GLTF, FBX, OBJ, DAE, or a ZIP containing GLB/GLTF/FBX/OBJ/DAE plus textures.");
      return;
    }

    setUploadState("uploading");
    setUploadError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/model`, {
        method: "POST",
        headers: {
          "content-type": isZip
            ? "application/zip"
            : isGltf
              ? "model/gltf+json"
              : isConvertible
                ? "application/octet-stream"
                : "model/gltf-binary",
          "x-file-name": file.name
        },
        body: file
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string; conversionJob?: ConversionJobDocument };
        if (error.conversionJob) {
          setConversionJob(error.conversionJob);
        }
        throw new Error(error.error ?? `Upload failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest?: SceneManifest;
        controls?: SceneControlsDocument;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
        conversionJob?: ConversionJobDocument;
        repairedExternalResources?: number;
      };
      if (result.manifest) {
        setManifest(result.manifest);
        setSelectedViewId(result.manifest.views[0]?.id ?? "");
        setSelectedInteractionId("");
        setSelectedVariantInteractionId("");
      }
      if (result.controls) {
        setControlsDoc(result.controls);
      }
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
      if (result.conversionJob) {
        setConversionJob(result.conversionJob);
      }
      setUploadState("done");
      setNotice("saved");
    } catch (error) {
      setUploadState("error");
      setUploadError(error instanceof Error ? error.message : "Upload failed.");
    }
  };

  const uploadMaterialTexture = async (
    materialId: string,
    field: MaterialTextureField,
    file: File | undefined
  ) => {
    if (!file) {
      return;
    }
    if (!apiConnected) {
      setLightmapUploadState("error");
      setLightmapUploadError("API is not connected.");
      return;
    }
    if (!/\.(avif|jpe?g|ktx2|png|webp)$/i.test(file.name)) {
      setLightmapUploadState("error");
      setLightmapUploadError(`Upload a PNG, JPEG, WebP, AVIF, or KTX2 ${materialTextureFieldLabels[field]}.`);
      return;
    }

    setLightmapUploadState("uploading");
    setLightmapUploadError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/asset`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": file.name
        },
        body: file
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Upload failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        assetPath?: string;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
      };
      if (!result.assetPath) {
        throw new Error("Upload did not return an asset path.");
      }
      const assetPath = result.assetPath;
      updateMaterial(materialId, (material) => {
        const next: MaterialOverride = {
          ...material,
          [field]: assetPath
        };
        if (field === "lightMapUrl") {
          next.lightMapIntensity = material.lightMapIntensity ?? 1;
          next.lightMapUvSet = material.lightMapUvSet ?? 1;
        }
        if (field === "emissiveMapUrl") {
          next.emissiveIntensity = material.emissiveIntensity ?? 1;
        }
        return next;
      });
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
      setLightmapUploadState("done");
      setNotice("saved");
    } catch (error) {
      setLightmapUploadState("error");
      setLightmapUploadError(error instanceof Error ? error.message : "Material texture upload failed.");
    }
  };

  const applyMaterialTextureCandidate = (
    materialId: string,
    candidate: MaterialTextureCandidate,
    field = candidate.field
  ) => {
    updateMaterial(materialId, (material) => {
      const next: MaterialOverride = {
        ...material,
        [field]: candidate.source
      };
      if (field === "lightMapUrl") {
        next.lightMapIntensity = material.lightMapIntensity ?? 1;
        next.lightMapUvSet = material.lightMapUvSet ?? 1;
      }
      if (field === "emissiveMapUrl") {
        next.emissiveIntensity = material.emissiveIntensity ?? 1;
      }
      return next;
    });
    setNotice("saved");
  };

  const applyMaterialTextureSuggestions = (options?: { materialNames?: Set<string>; scopeLabel?: string }) => {
    const suggestions = (bundleStats?.materialTextureSuggestions ?? []).filter(
      (suggestion) =>
        textureSuggestionConfidence(suggestion.score) === "strong" &&
        (!options?.materialNames || options.materialNames.has(suggestion.materialName))
    );
    if (suggestions.length === 0) {
      setRepairSummary(
        options?.scopeLabel
          ? `No high-confidence texture suggestions are ready in ${options.scopeLabel}. Try All or review weaker matches manually.`
          : "No high-confidence texture suggestions are ready to apply. Review Materials to check weaker matches manually."
      );
      return;
    }
    const suggestionsByMaterial = new Map<string, typeof suggestions>();
    for (const suggestion of suggestions) {
      suggestionsByMaterial.set(suggestion.materialName, [
        ...(suggestionsByMaterial.get(suggestion.materialName) ?? []),
        suggestion
      ]);
    }
    const appliedCount =
      materialsDoc?.materials.reduce((count, material) => {
        const materialSuggestions = suggestionsByMaterial.get(material.name) ?? [];
        return count + materialSuggestions.filter((suggestion) => !material[suggestion.field]).length;
      }, 0) ?? 0;
    setMaterialsDoc((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        materials: current.materials.map((material) => {
          const materialSuggestions = suggestionsByMaterial.get(material.name) ?? [];
          let next = material;
          for (const suggestion of materialSuggestions) {
            if (next[suggestion.field]) {
              continue;
            }
            next = {
              ...next,
              [suggestion.field]: suggestion.source
            };
            if (suggestion.field === "lightMapUrl") {
              next.lightMapIntensity = next.lightMapIntensity ?? 1;
              next.lightMapUvSet = next.lightMapUvSet ?? 1;
            }
            if (suggestion.field === "emissiveMapUrl") {
              next.emissiveIntensity = next.emissiveIntensity ?? 1;
            }
          }
          return next;
        })
      };
    });
    setRepairSummary(
      appliedCount > 0
        ? `Applied ${appliedCount} high-confidence texture suggestion(s)${options?.scopeLabel ? ` in ${options.scopeLabel}` : ""}. Save changes, then re-open the viewer to inspect materials.`
        : "No high-confidence texture suggestions were applied because the suggested material fields are already filled."
    );
    setNotice("saved");
  };

  const reviewMaterialTextureSuggestion = (suggestion: MaterialTextureSuggestion) => {
    const material = materialsDoc?.materials.find((item) => item.name === suggestion.materialName);
    if (material) {
      setSelectedMaterialId(material.id);
    }
    openStudioVisualTarget("materials", ".material-diagnosis-card, .texture-candidate-panel, .material-preview-strip");
    setRepairSummary(
      `Review ${suggestion.materialName} ${materialTextureFieldLabels[suggestion.field]} using ${suggestion.source}.`
    );
  };

  const uploadVideoMedia = async (interactionId: string, file: File | undefined) => {
    if (!file) {
      return;
    }
    if (!apiConnected) {
      setMediaUploadState("error");
      setMediaUploadError("API is not connected.");
      return;
    }
    if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
      setMediaUploadState("error");
      setMediaUploadError("Upload an MP4, MOV, or WebM video.");
      return;
    }

    setMediaUploadState("uploading");
    setMediaUploadError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/asset?kind=media`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": file.name
        },
        body: file
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Upload failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        assetPath?: string;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
      };
      if (!result.assetPath) {
        throw new Error("Upload did not return an asset path.");
      }
      const assetPath = result.assetPath;
      updateVideoTexture(interactionId, (interaction) => ({
        ...interaction,
        source: assetPath
      }));
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
      setMediaUploadState("done");
      setNotice("saved");
    } catch (error) {
      setMediaUploadState("error");
      setMediaUploadError(error instanceof Error ? error.message : "Media upload failed.");
    }
  };

  const addView = () => {
    updateManifest((current) => {
      const nextView = createView(current.views.length + 1);
      window.setTimeout(() => setSelectedViewId(nextView.id), 0);
      return {
        ...current,
        views: [...current.views, nextView]
      };
    });
  };

  const createOrUpdateTopView = () => {
    updateManifest((current) => {
      const bounds = current.navigation.bounds;
      if (!bounds) {
        window.setTimeout(() => openNavigationWorkflow(), 0);
        return current;
      }
      const topView = createTopViewFromBounds(
        bounds,
        current.views.filter((view) => view.kind === "top").length + 1
      );
      const existingTop = current.views.find((view) => view.kind === "top");
      if (existingTop) {
        window.setTimeout(() => setSelectedViewId(existingTop.id), 0);
        return {
          ...current,
          views: current.views.map((view) =>
            view.id === existingTop.id
              ? { ...topView, id: existingTop.id, label: existingTop.label || topView.label }
              : view
          )
        };
      }
      let id = topView.id;
      let suffix = 2;
      const usedIds = new Set(current.views.map((view) => view.id));
      while (usedIds.has(id)) {
        id = `${topView.id}-${suffix}`;
        suffix += 1;
      }
      const nextView = { ...topView, id };
      window.setTimeout(() => setSelectedViewId(nextView.id), 0);
      return {
        ...current,
        views: [...current.views, nextView]
      };
    });
    setNotice("saved");
  };

  const removeView = (viewId: string) => {
    updateManifest((current) => {
      const views = current.views.filter((view) => view.id !== viewId);
      window.setTimeout(() => setSelectedViewId(views[0]?.id ?? ""), 0);
      return {
        ...current,
        views
      };
    });
  };

  const addRoom = () => {
    updateManifest((current) => {
      const nextRoom = createRoom((current.rooms?.length ?? 0) + 1, current.views[0]);
      window.setTimeout(() => setSelectedRoomId(nextRoom.id), 0);
      return {
        ...current,
        rooms: [...(current.rooms ?? []), nextRoom]
      };
    });
  };

  const removeRoom = (roomId: string) => {
    updateManifest((current) => {
      const rooms = (current.rooms ?? []).filter((room) => room.id !== roomId);
      window.setTimeout(() => setSelectedRoomId(rooms[0]?.id ?? ""), 0);
      return {
        ...current,
        rooms
      };
    });
  };

  const syncRoomsFromViews = () => {
    updateManifest((current) => {
      const existingRooms = current.rooms ?? [];
      const existingByView = new Map(existingRooms.filter((room) => room.viewId).map((room) => [room.viewId, room]));
      const usedRoomIds = new Set(existingRooms.map((room) => room.id));
      const nextRooms = [...existingRooms];
      current.views
        .filter((view) => view.kind !== "top")
        .forEach((view, index) => {
          const existing = existingByView.get(view.id);
          if (existing) {
            const roomIndex = nextRooms.findIndex((room) => room.id === existing.id);
            nextRooms[roomIndex] = {
              ...existing,
              label: existing.label || view.label,
              center: existing.center ?? view.position
            };
            return;
          }
          const room = createRoomFromView(view, index + 1);
          let roomId = room.id;
          let suffix = 2;
          while (usedRoomIds.has(roomId)) {
            roomId = `${room.id}-${suffix}`;
            suffix += 1;
          }
          usedRoomIds.add(roomId);
          nextRooms.push({ ...room, id: roomId });
      });
      const rooms = uniqueRoomLabels(nextRooms);
      window.setTimeout(() => setSelectedRoomId(rooms[0]?.id ?? ""), 0);
      return {
        ...current,
        rooms
      };
    });
    setNotice("saved");
  };

  const syncRoomsFromWalkZones = () => {
    updateManifest((current) => {
      const walkZones = enabledNavigationZones(current.navigation, "walk");
      if (walkZones.length === 0) {
        setRepairSummary("No walk areas found. Run Controls > Auto Fix or draw walk areas first.");
        return current;
      }
      const existingRooms = current.rooms ?? [];
      const usedRoomIds = new Set(existingRooms.map((room) => room.id));
      const nextRooms = [...existingRooms];
      const generatedRooms = createRoomsFromNavigationZones(
        walkZones,
        current.views,
        sceneGraph,
        current.rendering?.modelScale ?? 1,
        current.rendering?.modelOffset ?? [0, 0, 0]
      );
      if (generatedRooms.length === 0) {
        setRepairSummary("No room-sized walk areas found. Add a walk view or draw a larger walk patch first.");
        return current;
      }
      generatedRooms.forEach((room) => {
        const existingIndex = nextRooms.findIndex((item) => item.id === room.id);
        if (existingIndex >= 0) {
          const existingRoom = nextRooms[existingIndex];
          if (!existingRoom) {
            return;
          }
          const updatedRoom: RoomDefinition = {
            ...existingRoom,
            label: existingRoom.label || room.label
          };
          const center = existingRoom.center ?? room.center;
          if (center) {
            updatedRoom.center = center;
          }
          if (room.bounds) {
            updatedRoom.bounds = room.bounds;
          }
          const dimensions = existingRoom.dimensions ?? room.dimensions;
          if (dimensions) {
            updatedRoom.dimensions = dimensions;
          }
          if (!updatedRoom.viewId && room.viewId) {
            updatedRoom.viewId = room.viewId;
          }
          nextRooms[existingIndex] = updatedRoom;
          return;
        }
        let roomId = room.id;
        let suffix = 2;
        while (usedRoomIds.has(roomId)) {
          roomId = `${room.id}-${suffix}`;
          suffix += 1;
        }
        usedRoomIds.add(roomId);
        nextRooms.push({ ...room, id: roomId });
      });
      const rooms = uniqueRoomLabels(nextRooms);
      window.setTimeout(() => setSelectedRoomId(rooms[0]?.id ?? ""), 0);
      setRepairSummary(`Synced ${walkZones.length} walk area(s) into ${generatedRooms.length} room region(s).`);
      return {
        ...current,
        rooms
      };
    });
    setNotice("saved");
  };

  const addHotspot = () => {
    updateManifest((current) => {
      const nextHotspot = createHotspot(hotspotInteractions.length + 1);
      window.setTimeout(() => setSelectedInteractionId(nextHotspot.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextHotspot]
      };
    });
  };

  const removeHotspot = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isHotspot) ?? interactions.find(isLink) ?? interactions.find(isObjectToggle);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const addLink = () => {
    updateManifest((current) => {
      const nextLink = createLink(linkInteractions.length + 1);
      window.setTimeout(() => setSelectedInteractionId(nextLink.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextLink]
      };
    });
  };

  const removeLink = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isHotspot) ?? interactions.find(isLink) ?? interactions.find(isObjectToggle);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const addObjectToggle = () => {
    updateManifest((current) => {
      const nextToggle = createObjectToggle(objectToggleInteractions.length + 1, selectedObjectEditableOverride);
      window.setTimeout(() => setSelectedInteractionId(nextToggle.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextToggle]
      };
    });
  };

  const removeObjectToggle = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction =
        interactions.find(isHotspot) ??
        interactions.find(isLink) ??
        interactions.find(isObjectToggle) ??
        interactions.find(isVideoTexture);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const addVideoTexture = () => {
    updateManifest((current) => {
      const usedTargets = new Set(
        videoTextureInteractions
          .flatMap((interaction) => [interaction.targetMeshName, interaction.targetMaterialName])
          .filter((value): value is string => Boolean(value))
      );
      const candidate =
        videoSurfaceCandidates.find(
          (item) => !usedTargets.has(item.meshName) && (!item.materialName || !usedTargets.has(item.materialName))
        ) ?? videoSurfaceCandidates[0];
      const nextVideoTexture = candidate
        ? withVideoSurfaceCandidate(createVideoTexture(videoTextureInteractions.length + 1), candidate)
        : createVideoTexture(videoTextureInteractions.length + 1);
      window.setTimeout(() => setSelectedInteractionId(nextVideoTexture.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextVideoTexture]
      };
    });
  };

  const addLikelyVideoTextures = () => {
    updateManifest((current) => {
      const usedTargets = new Set(
        videoTextureInteractions
          .flatMap((interaction) => [interaction.targetMeshName, interaction.targetMaterialName])
          .filter((value): value is string => Boolean(value))
      );
      const candidates = videoSurfaceCandidates
        .filter((candidate) => candidate.score >= 6)
        .filter((candidate) => !usedTargets.has(candidate.meshName) && (!candidate.materialName || !usedTargets.has(candidate.materialName)))
        .slice(0, 4);
      if (candidates.length === 0) {
        return current;
      }
      const nextInteractions = candidates.map((candidate, index) =>
        withVideoSurfaceCandidate(createVideoTexture(videoTextureInteractions.length + index + 1), candidate)
      );
      window.setTimeout(() => setSelectedInteractionId(nextInteractions[0]?.id ?? ""), 0);
      return {
        ...current,
        interactions: [...current.interactions, ...nextInteractions]
      };
    });
  };

  const removeVideoTexture = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction =
        interactions.find(isHotspot) ??
        interactions.find(isLink) ??
        interactions.find(isObjectToggle) ??
        interactions.find(isVideoTexture);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const applyVideoSurfaceCandidate = (candidate: VideoSurfaceCandidate) => {
    if (!selectedVideoTexture) {
      return;
    }
    updateVideoTexture(selectedVideoTexture.id, (interaction) => {
      return withVideoSurfaceCandidate(interaction, candidate);
    });
  };

  const addMaterialVariantInteraction = () => {
    updateManifest((current) => {
      const materialName = selectedMaterial?.name ?? materialsDoc?.materials[0]?.name ?? "";
      const nextInteraction = createMaterialVariantInteraction(
        materialVariantInteractions.length + 1,
        materialName
      );
      window.setTimeout(() => setSelectedVariantInteractionId(nextInteraction.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextInteraction]
      };
    });
  };

  const removeMaterialVariantInteraction = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isMaterialVariantInteraction);
      window.setTimeout(() => setSelectedVariantInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const updateMaterialVariantOption = (
    interactionId: string,
    variantId: string,
    updater: (variant: MaterialVariant) => MaterialVariant
  ) => {
    updateMaterialVariantInteraction(interactionId, (interaction) => ({
      ...interaction,
      variants: interaction.variants.map((variant) =>
        variant.id === variantId ? updater(variant) : variant
      )
    }));
  };

  const uploadMaterialVariantTexture = async (
    interactionId: string,
    variantId: string,
    file: File | undefined
  ) => {
    if (!file) {
      return;
    }
    if (!apiConnected) {
      setVariantUploadState("error");
      setVariantUploadError("API is not connected.");
      return;
    }
    if (!/\.(avif|jpe?g|ktx2|png|webp)$/i.test(file.name)) {
      setVariantUploadState("error");
      setVariantUploadError("Upload a PNG, JPEG, WebP, AVIF, or KTX2 finish texture.");
      return;
    }

    setVariantUploadState("uploading");
    setVariantUploadError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/asset?kind=texture`, {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-file-name": file.name
        },
        body: file
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Upload failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        assetPath?: string;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
      };
      if (!result.assetPath) {
        throw new Error("Upload did not return an asset path.");
      }
      const assetPath = result.assetPath;
      updateMaterialVariantOption(interactionId, variantId, (variant) => ({
        ...variant,
        texture: assetPath
      }));
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
      setVariantUploadState("done");
      setNotice("saved");
    } catch (error) {
      setVariantUploadState("error");
      setVariantUploadError(error instanceof Error ? error.message : "Finish texture upload failed.");
    }
  };

  const addMaterialVariantOption = (interactionId: string) => {
    updateMaterialVariantInteraction(interactionId, (interaction) => ({
      ...interaction,
      variants: [
        ...interaction.variants,
        {
          id: `option-${interaction.variants.length + 1}`,
          label: `Option ${interaction.variants.length + 1}`,
          color: "#ffffff"
        }
      ]
    }));
  };

  const removeMaterialVariantOption = (interactionId: string, variantId: string) => {
    updateMaterialVariantInteraction(interactionId, (interaction) => ({
      ...interaction,
      variants: interaction.variants.filter((variant) => variant.id !== variantId)
    }));
  };

  const importSymptomSteps = useMemo(() => {
    const diagnostics = bundleStats?.diagnostics ?? [];
    const sourceIssueCount = diagnostics.filter(
      (diagnostic) => diagnostic.severity !== "info" && isSourceStructureDiagnostic(diagnostic.code)
    ).length;
    const framingIssueCount = diagnostics.filter(
      (diagnostic) => diagnostic.severity !== "info" && isSceneFramingDiagnostic(diagnostic.code)
    ).length;
    const visualIssueCount = diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity !== "info" &&
        (isGreenPlaceholderDiagnostic(diagnostic.code) ||
          isTextureConnectionDiagnostic(diagnostic.code) ||
          [
            "model-has-no-texture-images",
            "dominant-untextured-material",
            "few-materials-use-textures",
            "invalid-material-references",
            "invalid-texture-references",
            "textures-without-images",
            "textured-primitives-missing-uvs"
          ].includes(diagnostic.code))
    ).length;
    const movementIssueCount =
      navigationIssues.filter((issue) => issue.severity !== "info").length +
      diagnostics.filter(
        (diagnostic) => diagnostic.severity !== "info" && importActionForDiagnostic(diagnostic.code) === "navigation"
      ).length;
    return [
      {
        id: "source",
        label: "Blank or partial",
        detail:
          sourceIssueCount > 0
            ? `${sourceIssueCount} source/export issue${sourceIssueCount === 1 ? "" : "s"} need review.`
            : "Use when the model opens blank, partial, or broken.",
        status: sourceIssueCount > 0 ? "warning" : "ready",
        action: sourceIssueCount > 0 ? "Review Export" : "Source OK"
      },
      {
        id: "framing",
        label: "Wrong first view",
        detail:
          framingIssueCount > 0
            ? `${framingIssueCount} framing issue${framingIssueCount === 1 ? "" : "s"} found.`
            : "Use when the viewer opens on terrain, grass, or empty space.",
        status: framingIssueCount > 0 ? "warning" : "ready",
        action: "Repair Framing"
      },
      {
        id: "visuals",
        label: "Poor or green",
        detail:
          pendingMaterialTextureSuggestionCount > 0
            ? `${pendingMaterialTextureSuggestionCount} safe texture match${pendingMaterialTextureSuggestionCount === 1 ? "" : "es"} ready.`
            : visualIssueCount > 0
              ? `${visualIssueCount} visual/material issue${visualIssueCount === 1 ? "" : "s"} found.`
              : "Use when textures look missing, flat, or green.",
        status: pendingMaterialTextureSuggestionCount > 0 ? "active" : visualIssueCount > 0 ? "warning" : "ready",
        action: pendingMaterialTextureSuggestionCount > 0 ? "Apply Matches" : "Review Materials"
      },
      {
        id: "movement",
        label: "Cannot walk in",
        detail:
          movementIssueCount > 0
            ? `${movementIssueCount} navigation issue${movementIssueCount === 1 ? "" : "s"} need setup.`
            : "Use when clicks stop at doors, walls, or room entries.",
        status: movementIssueCount > 0 ? "warning" : "ready",
        action: "Fix Navigation"
      }
    ];
  }, [bundleStats?.diagnostics, navigationIssues, pendingMaterialTextureSuggestionCount]);

  if (loadingError) {
    return (
      <main className="studio-shell">
        <section className="load-state">
          <FileJson size={28} aria-hidden="true" />
          <strong>Manifest Error</strong>
          <p>{loadingError}</p>
        </section>
      </main>
    );
  }

  if (!manifest) {
    return (
      <main className="studio-shell">
        <section className="load-state">
          <FileJson size={28} aria-hidden="true" />
          <strong>Loading Project</strong>
        </section>
      </main>
    );
  }

  const videoCount = manifest.interactions.filter((interaction) => interaction.kind === "video-texture").length;
  const movementComfort = movementComfortStatus(controlsDoc, manifest);
  const movementTriageSteps = [
    {
      id: "bounce",
      label: "Camera jumps",
      detail:
        movementComfort.tone === "warning"
          ? movementComfort.detail
          : "Use when ridges, rugs, or thresholds make the camera bob.",
      status: movementComfort.tone === "warning" ? "warning" : "ready",
      action: "Ridge Safe"
    },
    {
      id: "door",
      label: "Door feels blocked",
      detail:
        navigationIssues.some((issue) => issue.id.startsWith("narrow-pass-"))
          ? "A door pass looks narrower than the body radius."
          : "Use when a visible doorway blocks click movement.",
      status: navigationIssues.some(
        (issue) =>
          issue.id.startsWith("narrow-pass-") ||
          issue.id.startsWith("blocked-pass-") ||
          issue.id.startsWith("blocked-walk-")
      )
        ? "warning"
        : "ready",
      action: navigationIssues.some((issue) => issue.id.startsWith("narrow-pass-")) ? "Widen Doors" : "Door Fix"
    },
    {
      id: "levels",
      label: "Thresholds or steps",
      detail:
        (controlsDoc?.movement.maxStepUp ?? 0.38) < 0.45
          ? "Step Up is strict for raised thresholds or simple stairs."
          : "Use when a raised strip should be walkable.",
      status: (controlsDoc?.movement.maxStepUp ?? 0.38) < 0.45 ? "warning" : "ready",
      action: "Steps"
    },
    {
      id: "wheel",
      label: "Mouse wheel move",
      detail:
        controlsDoc?.movement.wheelMoveSpeed && controlsDoc.movement.wheelMoveSpeed > 0
          ? `Wheel glide ${controlsDoc.movement.wheelMoveSpeed.toFixed(2)} is enabled.`
          : "Enable wheel glide so scroll moves forward/back.",
      status: controlsDoc?.movement.wheelMoveSpeed && controlsDoc.movement.wheelMoveSpeed > 0 ? "ready" : "warning",
      action: "Enable Wheel"
    }
  ];
  const variantCount = materialVariantInteractions.reduce(
    (sum, interaction) => sum + interaction.variants.length,
    0
  );
  const originalSceneUrl =
    manifest.originalSceneUrl ??
    optimizationJob?.sourceSceneUrl ??
    (manifest.sceneUrl && manifest.sceneUrl !== "scene.optimized.glb" ? manifest.sceneUrl : "scene.glb");
  const scrollToStudioTarget = (selector: string) => {
    window.setTimeout(() => {
      document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  };
  const openStudioVisualTarget = (tab: StudioTab, selector: string) => {
    setSelectedTab(tab);
    scrollToStudioTarget(selector);
  };
  const openBakeWorkflow = () => {
    if (!selectedMaterial && materialsDoc?.materials[0]) {
      setSelectedMaterialId(materialsDoc.materials[0].id);
    }
    openStudioVisualTarget("materials", ".lightmap-bake-card");
  };
  const openMaterialsWorkflow = () => {
    const targetRow =
      materialReviewRows.find((row) => row.suggestionStatus?.pending) ??
      materialReviewRows.find((row) => row.suggestionStatus?.review) ??
      materialReviewRows.find((row) => row.isPlainGreen) ??
      materialReviewRows.find((row) => row.isUntextured) ??
      materialReviewRows.find((row) => row.isTransparent) ??
      materialReviewRows.find((row) => row.hasLightmap) ??
      materialReviewRows[0];
    if (targetRow) {
      setSelectedMaterialId(targetRow.material.id);
      setMaterialSearchQuery("");
      setMaterialListFilter(
        targetRow.suggestionStatus?.pending || targetRow.suggestionStatus?.review
          ? "suggested"
          : targetRow.isPlainGreen
            ? "plain-green"
            : targetRow.isUntextured
              ? "untextured"
              : targetRow.isTransparent
                ? "transparent"
                : targetRow.hasLightmap
                  ? "lightmaps"
                  : "all"
      );
    }
    openStudioVisualTarget(
      "materials",
      ".material-diagnosis-card, .texture-candidate-panel, .material-preview-strip, .material-setup-board"
    );
  };
  const openViewsWorkflow = () => {
    const walkZones = manifest ? enabledNavigationZones(manifest.navigation, "walk") : [];
    const blockZones = manifest ? enabledNavigationZones(manifest.navigation, "block") : [];
    const linkedViewIds = new Set(rooms.map((room) => room.viewId).filter(Boolean));
    const targetView =
      manifest?.views.find((view) => view.kind === "walk" && blockZones.some((zone) => pointInNavigationZone(zone, view.position, 0.15))) ??
      manifest?.views.find((view) => view.kind === "walk" && !pointInNavigationBounds(view.position, manifest.navigation.bounds, 0.05)) ??
      manifest?.views.find(
        (view) =>
          view.kind === "walk" &&
          walkZones.length > 0 &&
          !walkZones.some((zone) => pointInNavigationZone(zone, view.position, 0.35))
      ) ??
      manifest?.views.find((view) => view.kind === "walk" && !linkedViewIds.has(view.id)) ??
      manifest?.views.find((view) => view.kind === "top") ??
      manifest?.views[0];
    if (targetView) {
      setSelectedViewId(targetView.id);
    }
    openStudioVisualTarget("views", ".view-setup-board, .editor-panel");
  };
  const openRoomsWorkflow = () => {
    if (!manifest) {
      openStudioVisualTarget("rooms", ".room-setup-board, .room-planner-card");
      return;
    }
    const routeZones = [
      ...enabledNavigationZones(manifest.navigation, "walk"),
      ...enabledNavigationZones(manifest.navigation, "pass")
    ];
    const blockZones = enabledNavigationZones(manifest.navigation, "block");
    const routeComponents = navigationComponents(routeZones);
    const targetRoom =
      rooms.find((room) => !room.viewId) ??
      rooms.find((room) => !room.bounds) ??
      rooms.find((room) => {
        const center = roomCenter(room, manifest.views);
        return blockZones.some((zone) => pointInNavigationZone(zone, center, 0.15));
      }) ??
      rooms.find((room) => {
        const center = roomCenter(room, manifest.views);
        return !routeComponents.some((component) =>
          component.some((zone) => pointInNavigationZone(zone, center, 0.35))
        );
      }) ??
      rooms.find((room) => !pointInNavigationBounds(roomCenter(room, manifest.views), manifest.navigation.bounds, 0.05)) ??
      rooms[0];
    if (targetRoom) {
      setSelectedRoomId(targetRoom.id);
    }
    openStudioVisualTarget("rooms", ".room-walkability-board, .room-map, .room-setup-board");
  };
  const openNavigationWorkflow = () => {
    const targetIssue = navigationIssues.find((issue) => issue.severity !== "info") ?? navigationIssues[0];
    const targetQuickFix = navigationQuickFixForIssue(targetIssue);
    setHighlightedNavigationIssueId(targetIssue?.severity === "info" ? "" : targetIssue?.id ?? "");

    if (targetQuickFix.action === "paint-walk") {
      setNavigationPaintKind("walk");
      setNavigationPaintShape("rectangle");
      setNavigationPolygonDraft(null);
    } else if (targetQuickFix.action === "paint-pass") {
      setNavigationPaintKind("pass");
      setNavigationPaintShape("rectangle");
      setNavigationPolygonDraft(null);
    } else {
      setNavigationPaintKind(null);
      setNavigationPolygonDraft(null);
    }

    if (targetQuickFix.action === "review-zones") {
      setShowNavigationZoneList(true);
      setShowGeneratedNavigationZones(true);
      if (targetQuickFix.targetZoneId) {
        setExpandedNavigationZoneIds((current) => new Set(current).add(targetQuickFix.targetZoneId!));
      }
    }

    const targetSelector =
      navigationRepairDraft
        ? ".repair-card"
        : targetQuickFix.action === "paint-walk" ||
            targetQuickFix.action === "paint-pass" ||
            targetQuickFix.action === "review-zones"
          ? ".zone-map"
          : ".navigation-quick-fix, .navigation-repair-path, .movement-setup-board";
    openStudioVisualTarget("controls", targetSelector);
  };
  const openEnvironmentWorkflow = () => {
    openStudioVisualTarget("environment", ".environment-setup-board, .environment-preview, .environment-panel, .field-grid");
  };
  const openOptimizationWorkflow = () => {
    openStudioVisualTarget("optimization", ".optimization-setup-board, .optimization-action-controls, .texture-delivery-plan");
  };
  const openPublishWorkflow = () => {
    openStudioVisualTarget("publish", ".client-share-board, .publish-handoff-board, .publish-readiness-list");
  };
  const openSourceReviewWorkflow = () => {
    openStudioVisualTarget("import", ".source-qa-card, .diagnostic-action-map, .diagnostic-list");
  };
  const openVariantsWorkflow = () => {
    const targetVariant =
      materialVariantInteractions.find((interaction) => !interaction.targetMaterialName && !interaction.targetMeshName) ??
      materialVariantInteractions.find((interaction) => {
        if (!sceneGraph) {
          return false;
        }
        return Boolean(
          (interaction.targetMaterialName && !variantTargetKeys.materialNames.has(interaction.targetMaterialName)) ||
            (interaction.targetMeshName && !variantTargetKeys.meshNames.has(interaction.targetMeshName))
        );
      }) ??
      materialVariantInteractions.find((interaction) => interaction.variants.length === 0) ??
      materialVariantInteractions.find((interaction) =>
        interaction.variants.some((variant) => !variant.color && !variant.texture?.trim())
      ) ??
      materialVariantInteractions.find((interaction) =>
        interaction.variants.some((variant) => {
          const texture = variant.texture?.trim() ?? "";
          return texture.startsWith("generated://") || missingVariantTextureSources.has(normalizeAssetReference(texture));
        })
      ) ??
      materialVariantInteractions[0];
    if (targetVariant) {
      setSelectedVariantInteractionId(targetVariant.id);
    }
    openStudioVisualTarget("variants", ".variant-setup-board, .variant-editor-list");
  };
  const openObjectsWorkflow = () => {
    const targetRow =
      objectReviewRows.find((row) => row.isCeilingOrRoof && !row.isHiddenInTopView) ??
      objectReviewRows.find((row) => row.isCeilingOrRoof) ??
      objectReviewRows.find((row) => row.hasNavigationRole) ??
      objectReviewRows.find((row) => row.isHiddenInTopView) ??
      objectReviewRows.find((row) => row.isHidden) ??
      objectReviewRows[0];
    if (targetRow) {
      setSelectedObjectId(targetRow.node.id);
      setObjectSearchQuery("");
      setObjectListFilter(
        targetRow.isCeilingOrRoof
          ? "ceiling"
          : targetRow.hasNavigationRole
            ? "roles"
            : targetRow.isHiddenInTopView
              ? "top-hidden"
              : targetRow.isHidden
                ? "hidden"
                : "all"
      );
    }
    openStudioVisualTarget("objects", ".object-setup-board, .object-review-tools, .object-detail");
  };
  const openInteractionsWorkflow = () => {
    const targetInteraction =
      videoTextureInteractions.find((interaction) => !interaction.targetMeshName && !interaction.targetMaterialName) ??
      videoTextureInteractions.find((interaction) => !interaction.source.trim() || !isValidMediaSource(interaction.source)) ??
      objectToggleInteractions.find((interaction) => {
        const targetId = interaction.targetObjectId?.trim();
        const targetName = normalizedObjectMatchName(interaction.targetObjectName ?? "");
        if (!targetId && !targetName) {
          return true;
        }
        return !(
          (targetId && objectToggleKnownTargetKeys.ids.has(targetId)) ||
          (targetName && objectToggleKnownTargetKeys.names.has(targetName))
        );
      }) ??
      hotspotInteractions.find((interaction) => !isFiniteVec3(interaction.position) || !interaction.title.trim()) ??
      linkInteractions.find(
        (interaction) =>
          !isFiniteVec3(interaction.position) || !interaction.label.trim() || !isValidInteractionUrl(interaction.url)
      ) ??
      videoTextureInteractions[0] ??
      hotspotInteractions[0] ??
      linkInteractions[0] ??
      objectToggleInteractions[0];
    if (targetInteraction) {
      setSelectedInteractionId(targetInteraction.id);
    }
    openStudioVisualTarget("interactions", ".selected-interaction-health, .surface-mapper, .screen-planner-card");
  };
  const runImportDiagnosticAction = (action: ImportNextStepAction) => {
    if (action === "repair") {
      void repairImport();
      return;
    }
    if (action === "apply-textures") {
      applyMaterialTextureSuggestions();
      return;
    }
    if (action === "environment") {
      openEnvironmentWorkflow();
      return;
    }
    if (action === "materials") {
      openMaterialsWorkflow();
      return;
    }
    if (action === "variants") {
      openVariantsWorkflow();
      return;
    }
    if (action === "views") {
      openViewsWorkflow();
      return;
    }
    if (action === "navigation") {
      openNavigationWorkflow();
      return;
    }
    if (action === "objects") {
      openObjectsWorkflow();
      return;
    }
    if (action === "rooms") {
      openRoomsWorkflow();
      return;
    }
    if (action === "interactions") {
      openInteractionsWorkflow();
      return;
    }
    if (action === "optimize") {
      openOptimizationWorkflow();
      return;
    }
    if (action === "bake") {
      openBakeWorkflow();
      return;
    }
    if (action === "review") {
      openSourceReviewWorkflow();
      return;
    }
    void saveAndOpenViewer(viewerUrl(activeProjectId));
  };
  const runRepairCenterAction = (action: ImportNextStepAction) => {
    if (action === "repair") {
      openStudioVisualTarget("import", ".import-repair-card");
      return;
    }
    if (action === "apply-textures") {
      openStudioVisualTarget("materials", ".texture-candidate-panel, .material-preview-strip");
      return;
    }
    if (action === "optimize") {
      openOptimizationWorkflow();
      return;
    }
    runImportDiagnosticAction(action);
  };

  return (
    <main className="studio-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <Box size={22} aria-hidden="true" />
          <div>
            <span>Walkthrough</span>
            <strong>Studio</strong>
          </div>
        </div>

        <div className="project-list">
          {(projectSummaries.length > 0 ? projectSummaries : (() => {
            const fallback: ProjectSummary = {
              id: activeProjectId,
              title: manifest.branding.title,
              viewCount: manifest.views.length,
              triangleCount: bundleStats?.triangleCount ?? 0,
              updatedAt: bundleStats?.generatedAt ?? ""
            };
            if (manifest.branding.clientName) {
              fallback.clientName = manifest.branding.clientName;
            }
            return [fallback];
          })()).map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === activeProjectId ? "project-row active" : "project-row"}
              onClick={() => setActiveProjectId(project.id)}
            >
              <span>{project.clientName ?? project.title}</span>
              <small>
                {project.viewCount} views
                {typeof project.publishCount === "number" ? ` / ${project.publishCount} published` : ""}
              </small>
            </button>
          ))}
        </div>

        <button type="button" className="project-create" onClick={() => void createProject()}>
          <Plus size={16} aria-hidden="true" />
          New Project
        </button>
      </aside>

      <section className="workbench">
        <header className="studio-header">
          <div>
            <span className="eyebrow">Project</span>
            <h1>{manifest.branding.clientName ?? manifest.branding.title}</h1>
          </div>

          <div className="header-actions">
            <span className={apiConnected ? "api-pill connected" : "api-pill"}>
              {apiConnected ? "API" : "Local"}
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={() => void copyText(embedSnippet(activeProjectId, manifest.branding.clientName ?? manifest.branding.title))}
            >
              <Copy size={16} aria-hidden="true" />
              Embed
            </button>
            <a className="button secondary" href={viewerUrl(activeProjectId)} target="_blank" rel="noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              Viewer
            </a>
            <button type="button" className="button secondary" onClick={() => void saveAndOpenViewer()}>
              <Save size={16} aria-hidden="true" />
              Save & Test
            </button>
            <button type="button" className="button secondary" onClick={() => void resetDraft()}>
              <RotateCcw size={16} aria-hidden="true" />
              Reset
            </button>
            <button type="button" className="button primary" onClick={saveDraft}>
              <Save size={16} aria-hidden="true" />
              Save
            </button>
          </div>
        </header>

        {saveError && <p className="error-note save-error-note">{saveError}</p>}

        <nav className="tabs" aria-label="Studio sections">
          {[
            ["overview", "Overview"],
            ["repair", "Repair Center"],
            ["import", "Import"],
            ["optimization", "Optimization"],
            ["publish", "Publish"],
            ["views", "Views"],
            ["rooms", "Rooms"],
            ["interactions", "Interactions"],
            ["materials", "Materials"],
            ["variants", "Variants"],
            ["objects", "Objects"],
            ["controls", "Controls"],
            ["environment", "Environment"],
            ["bundle", "Bundle"]
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={selectedTab === id ? "tab active" : "tab"}
              onClick={() => setSelectedTab(id as StudioTab)}
            >
              {label}
            </button>
          ))}
        </nav>

        {selectedTab === "overview" && (
          <section className="content-grid">
            <div className="panel">
              <div className="panel-heading">
                <Layers3 size={18} aria-hidden="true" />
                <h2>Project</h2>
              </div>
              <div className="field-grid">
                <label>
                  <span>Title</span>
                  <input
                    value={manifest.branding.title}
                    onChange={(event) => updateBranding("title", event.target.value)}
                  />
                </label>
                <label>
                  <span>Client</span>
                  <input
                    value={manifest.branding.clientName ?? ""}
                    onChange={(event) => updateBranding("clientName", event.target.value)}
                  />
                </label>
                <label>
                  <span>Accent</span>
                  <input
                    value={manifest.branding.accentColor}
                    onChange={(event) => updateBranding("accentColor", event.target.value)}
                  />
                </label>
              </div>
              <DiagnosticList
                diagnostics={bundleStats?.diagnostics ?? []}
                onAction={runImportDiagnosticAction}
              />
            </div>

            <div className="side-stack">
              <div className="panel metrics-panel">
                <div className="metric-row">
                  <MapPin size={18} aria-hidden="true" />
                  <span>Views</span>
                  <strong>{manifest.views.length}</strong>
                </div>
                <div className="metric-row">
                  <Globe2 size={18} aria-hidden="true" />
                  <span>Hotspots</span>
                  <strong>{hotspotInteractions.length}</strong>
                </div>
                <div className="metric-row">
                  <ExternalLink size={18} aria-hidden="true" />
                  <span>Links</span>
                  <strong>{linkInteractions.length}</strong>
                </div>
                <div className="metric-row">
                  <Eye size={18} aria-hidden="true" />
                  <span>Object Toggles</span>
                  <strong>{objectToggleInteractions.length}</strong>
                </div>
                <div className="metric-row">
                  <Video size={18} aria-hidden="true" />
                  <span>Video Textures</span>
                  <strong>{videoCount}</strong>
                </div>
                <div className="metric-row">
                  <Palette size={18} aria-hidden="true" />
                  <span>Variants</span>
                  <strong>{variantCount}</strong>
                </div>
                <div className="metric-row">
                  <Activity size={18} aria-hidden="true" />
                  <span>Triangles</span>
                  <strong>{bundleStats?.triangleCount ?? 0}</strong>
                </div>
              </div>

              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Production Tools</h2>
                </div>
                <div className="publish-readiness-list tool-readiness-list" aria-label="Production tool readiness">
                  {toolStatus ? (
                    Object.entries(toolStatus.tools).map(([id, tool]) => (
                      <div
                        key={id}
                        className={tool.ready ? "readiness-row tool-row ready" : "readiness-row tool-row warn"}
                      >
                        <div>
                          <span>{id}</span>
                          <small>{tool.purpose}</small>
                          <code>{tool.command}</code>
                        </div>
                        <strong>{tool.action}</strong>
                      </div>
                    ))
                  ) : (
                    <p className="quiet-note">Checking local production tooling.</p>
                  )}
                </div>
              </div>
            </div>
          </section>
        )}

        {selectedTab === "repair" && (
          <RepairCenter
            stats={bundleStats}
            manifest={manifest}
            publishChecks={publishChecks}
            pendingTextureSuggestionCount={pendingMaterialTextureSuggestionCount}
            reviewTextureSuggestionCount={reviewMaterialTextureSuggestionCount}
            repairState={repairState}
            optimizeState={optimizeState}
            bakeState={bakeState}
            onImport={() => setSelectedTab("import")}
            onAction={runRepairCenterAction}
            onSaveAndTest={(navigationDebug = false) =>
              void saveAndOpenViewer(
                navigationDebug ? navigationDebugViewerUrl(activeProjectId) : viewerUrl(activeProjectId)
              )
            }
            onCopyFixBrief={(item, itemIndex, totalItems) =>
              void copyText(
                repairCenterFixBriefText({
                  projectId: activeProjectId,
                  title: manifest.branding.clientName ?? manifest.branding.title,
                  item,
                  itemIndex,
                  totalItems,
                  stats: bundleStats,
                  publishChecks
                })
              )
            }
          />
        )}

        {selectedTab === "import" && (
          <section className="content-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>Model Import</h2>
              </div>

              <VisualGuideCard
                title="Import repair path"
                detail="Start from the original model package, then let Studio rebuild the parts that make the walkthrough usable."
                steps={[
                  "Upload a GLB, GLTF, source model, or ZIP with its texture folder.",
                  "Run Repair so textures, views, bounds, rooms, and diagnostics are refreshed.",
                  "Open Repair Center again and follow the first visible fix card."
                ]}
                actionLabel={repairState === "repairing" ? "Repairing" : "Repair"}
                actionDisabled={!apiConnected || repairState === "repairing"}
                onAction={() => void repairImport()}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />

              <label className="file-drop">
                <input
                  type="file"
                  accept=".dae,.fbx,.glb,.gltf,.obj,.zip,model/gltf-binary,model/gltf+json,application/zip"
                  disabled={!apiConnected || uploadState === "uploading"}
                  onChange={(event) => void uploadModel(event.target.files?.[0])}
                />
                <span>Upload GLB or ZIP</span>
                <strong>
                  {uploadState === "uploading" && "Uploading"}
                  {uploadState === "done" && "Imported"}
                  {uploadState === "error" && "Failed"}
                  {uploadState === "idle" && "Choose file"}
                </strong>
              </label>

              {uploadError && <p className="error-note">{uploadError}</p>}
              {!apiConnected && <p className="quiet-note">Start the local API before importing models.</p>}
              <div className="publish-action-card import-repair-card">
                <div>
                  <strong>Auto repair import</strong>
                  <p className="quiet-note">
                    Re-detect model scale, regenerate default views, update navigation bounds, and refresh diagnostics.
                  </p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!apiConnected || repairState === "repairing"}
                  onClick={() => void repairImport()}
                >
                  <Wrench size={16} aria-hidden="true" />
                  {repairState === "repairing" ? "Repairing" : "Repair"}
                </button>
              </div>
              {repairError && <p className="error-note">{repairError}</p>}
              {repairSummary && <p className="success-note">{repairSummary}</p>}
              {bundleStats && (
                <SourceQaSummary
                  stats={bundleStats}
                  projectId={activeProjectId}
                  apiConnected={apiConnected}
                  repairState={repairState}
                  onCopy={() => void copyText(sourceQaPlanText(bundleStats, activeProjectId))}
                  onCopyText={(value) => void copyText(value)}
                  onRepair={() => void repairImport()}
                  onReviewDiagnostics={() => document.querySelector(".diagnostic-list")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                />
              )}
              <div className="import-symptom-board" aria-label="Import symptom fixes">
                {importSymptomSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`import-symptom-card ${step.status}`}
                    onClick={() => {
                      if (step.id === "source") {
                        openSourceReviewWorkflow();
                        return;
                      }
                      if (step.id === "framing") {
                        void repairImport();
                        return;
                      }
                      if (step.id === "visuals") {
                        if (pendingMaterialTextureSuggestionCount > 0) {
                          applyMaterialTextureSuggestions();
                          return;
                        }
                        openMaterialsWorkflow();
                        return;
                      }
                      if (step.id === "movement") {
                        openNavigationWorkflow();
                      }
                    }}
                  >
                    <span>
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.status === "active" ? (
                        <Palette size={15} aria-hidden="true" />
                      ) : (
                        <Wrench size={15} aria-hidden="true" />
                      )}
                    </span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>
              {conversionJob && conversionJob.status !== "idle" && (
                <div className="job-step-list">
                  <div className={`job-step-row ${conversionJob.status === "completed" ? "completed" : conversionJob.status === "running" ? "pending" : "failed"}`}>
                    <div className="job-step-main">
                      <span>Source conversion</span>
                      {conversionJob.source && <small>{conversionJob.source}</small>}
                      {conversionJob.message && <small>{conversionJob.message}</small>}
                      {conversionJob.outputBytes && <small>{formatBytes(conversionJob.outputBytes)}</small>}
                    </div>
                    <strong>{conversionJob.status}</strong>
                  </div>
                  {conversionJob.steps.map((step) => (
                    <div key={step.id} className={`job-step-row ${step.status}`}>
                      <div className="job-step-main">
                        <span>{step.label}</span>
                        {step.note && <small>{step.note}</small>}
                      </div>
                      <strong>{step.status}</strong>
                    </div>
                  ))}
                </div>
              )}
              <ImportNextSteps
                stats={bundleStats}
                apiConnected={apiConnected}
                repairState={repairState}
                optimizeState={optimizeState}
                bakeState={bakeState}
                onRepair={() => void repairImport()}
                onOptimize={openOptimizationWorkflow}
                onBake={openBakeWorkflow}
                onEnvironment={openEnvironmentWorkflow}
                onMaterials={openMaterialsWorkflow}
                onVariants={openVariantsWorkflow}
                onViews={openViewsWorkflow}
                onNavigation={openNavigationWorkflow}
                onRooms={openRoomsWorkflow}
                onInteractions={openInteractionsWorkflow}
                onReviewDiagnostics={openSourceReviewWorkflow}
                pendingTextureSuggestionCount={pendingMaterialTextureSuggestionCount}
                reviewTextureSuggestionCount={reviewMaterialTextureSuggestionCount}
                onApplyTextureSuggestions={applyMaterialTextureSuggestions}
                onTest={() => void saveAndOpenViewer(viewerUrl(activeProjectId))}
              />
              <ViewerQaChecklist
                manifest={manifest}
                controls={controlsDoc}
                stats={bundleStats}
                objects={objectsDoc}
                viewerUrl={viewerUrl(activeProjectId)}
                navigationViewerUrl={navigationDebugViewerUrl(activeProjectId)}
                onMaterials={openMaterialsWorkflow}
                onEnvironment={openEnvironmentWorkflow}
                onNavigation={openNavigationWorkflow}
                onRooms={openRoomsWorkflow}
                onViews={openViewsWorkflow}
                onBake={openBakeWorkflow}
                onInteractions={openInteractionsWorkflow}
                onOptimize={openOptimizationWorkflow}
                onObjects={openObjectsWorkflow}
                onPublish={openPublishWorkflow}
                onReviewDiagnostics={openSourceReviewWorkflow}
                onSaveAndTest={() => void saveAndOpenViewer(viewerUrl(activeProjectId))}
                onSaveAndTestNavigation={() => void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId))}
                onCopyReport={() =>
                  void copyText(
                    viewerQaReportText(
                      manifest,
                      controlsDoc,
                      bundleStats,
                      objectsDoc,
                      viewerUrl(activeProjectId),
                      navigationDebugViewerUrl(activeProjectId)
                    )
                  )
                }
              />
            </div>

            <div className="panel stats-panel">
              <div className="panel-heading">
                <Activity size={18} aria-hidden="true" />
                <h2>Imported Scene Stats</h2>
              </div>
              {bundleStats ? (
                <>
                  <div className="stat-grid">
                    <Stat label="Model" value={formatBytes(bundleStats.modelBytes)} />
                    <Stat label="Meshes" value={String(bundleStats.meshCount)} />
                    <Stat label="Draw prims" value={String(bundleStats.primitiveCount ?? bundleStats.meshCount)} />
                    <Stat label="Materials" value={String(bundleStats.materialCount)} />
                    <Stat
                      label="Textured mats"
                      value={`${bundleStats.texturedMaterialCount ?? 0}/${bundleStats.materialCount}`}
                    />
                    <Stat label="Triangles" value={String(bundleStats.triangleCount)} />
                    <Stat label="Images" value={String(bundleStats.imageCount ?? 0)} />
                    <Stat label="Embedded images" value={String(bundleStats.embeddedImageCount ?? 0)} />
                    <Stat label="Max texture" value={`${bundleStats.maxTextureDimension ?? 0}px`} />
                    <Stat label="Texture RAM" value={formatBytes(bundleStats.estimatedTextureMemoryBytes ?? 0)} />
                    <Stat label="Strip textures" value={String(bundleStats.extremeAspectTextureCount ?? 0)} />
                    <Stat
                      label="Lightmaps"
                      value={`${bundleStats.lightmapAssetCount ?? 0}/${bundleStats.lightmapMaterialCount ?? 0}`}
                    />
                    <Stat label="Lightmap size" value={formatBytes(bundleStats.lightmapAssetBytes ?? 0)} />
                    <Stat label="Loose images" value={String(bundleStats.looseImageCount ?? 0)} />
                    <Stat label="Geometry compression" value={geometryCompressionLabel(bundleStats)} />
                    <Stat label="Texture compression" value={textureCompressionLabel(bundleStats)} />
                  </div>
                  <AssetHealth
                    stats={bundleStats}
                    projectId={activeProjectId}
                    apiConnected={apiConnected}
                    repairState={repairState}
                    pendingTextureSuggestionCount={pendingMaterialTextureSuggestionCount}
                    reviewTextureSuggestionCount={reviewMaterialTextureSuggestionCount}
                    appliedTextureSuggestionCount={appliedMaterialTextureSuggestionCount}
                    onApplyTextureSuggestions={applyMaterialTextureSuggestions}
                    onRepair={() => void repairImport()}
                    onMaterials={openMaterialsWorkflow}
                    onOptimize={openOptimizationWorkflow}
                    onBake={openBakeWorkflow}
                    onReviewTextureSuggestion={reviewMaterialTextureSuggestion}
                    onCopyPlan={() => void copyText(assetHealthRepairPlanText(bundleStats, activeProjectId))}
                    onCopyTextureRequest={() => void copyText(assetHealthTextureRequestText(bundleStats, activeProjectId))}
                  />
                  <DiagnosticList
                    diagnostics={bundleStats.diagnostics ?? []}
                    onAction={runImportDiagnosticAction}
                  />
                </>
              ) : (
                <p className="quiet-note">Stats will appear after import.</p>
              )}
            </div>
          </section>
        )}

        {selectedTab === "optimization" && (
          <section className="content-grid bundle-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <Activity size={18} aria-hidden="true" />
                <h2>Optimization Profiles</h2>
              </div>

              <VisualGuideCard
                title="Performance review"
                detail="Optimize only after the model looks correct, then compare the optimized artifact before publishing."
                steps={[
                  "Choose Mobile for weak devices, Balanced for normal sharing, or Desktop for richer scenes.",
                  "Run optimization and compare size, triangle, material, and texture warnings.",
                  "Switch between Original and Optimized if the viewer quality changes too much."
                ]}
                actionLabel={optimizeState === "optimizing" ? "Optimizing" : "Run"}
                actionDisabled={!apiConnected || optimizeState === "optimizing"}
                onAction={() => void optimizeProject()}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />

              <div className="publish-action-card">
                <div>
                  <strong>Optimize Scene Bundle</strong>
                  <p className="quiet-note">
                    Generate an optimized GLB artifact, then either preview it first or apply it to the viewer manifest.
                  </p>
                </div>
                <div className="optimization-action-controls">
                  <select
                    value={optimizationProfile}
                    disabled={optimizeState === "optimizing"}
                    onChange={(event) =>
                      setOptimizationProfile(event.target.value as OptimizationJobDocument["profile"])
                    }
                    aria-label="Optimization profile"
                  >
                    <option value="mobile">Mobile</option>
                    <option value="balanced">Balanced</option>
                    <option value="desktop">Desktop</option>
                  </select>
                  <label className="toggle-row compact-toggle">
                    <input
                      type="checkbox"
                      checked={applyOptimizedImmediately}
                      disabled={optimizeState === "optimizing"}
                      onChange={(event) => setApplyOptimizedImmediately(event.target.checked)}
                    />
                    <span>Apply now</span>
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!apiConnected || optimizeState === "optimizing"}
                    onClick={() => void optimizeProject()}
                  >
                    <Activity size={16} aria-hidden="true" />
                    {optimizeState === "optimizing" ? "Optimizing" : applyOptimizedImmediately ? "Run & Apply" : "Generate Preview"}
                  </button>
                </div>
              </div>

              <div className="optimization-setup-board" aria-label="Optimization setup health">
                {optimizationSetupSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`optimization-setup-card ${step.status}`}
                    disabled={step.status === "ready" && step.id !== "preview"}
                    onClick={() => {
                      if (step.id === "profile") {
                        document.querySelector(".optimization-grid")?.scrollIntoView({ block: "center" });
                        return;
                      }
                      if (step.id === "textures" || step.id === "compression") {
                        document.querySelector(".asset-health-section")?.scrollIntoView({ block: "center" });
                        return;
                      }
                      if (step.id === "preview" && !optimizationJob?.optimizedSceneUrl) {
                        void optimizeProject();
                        return;
                      }
                      if (step.id === "applied" && optimizationJob?.optimizedSceneUrl) {
                        void switchModelSource("scene.optimized.glb");
                      }
                    }}
                  >
                    <span>
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.status === "active" ? (
                        <Activity size={15} aria-hidden="true" />
                      ) : (
                        <AlertTriangle size={15} aria-hidden="true" />
                      )}
                    </span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>

              <div className="optimization-symptom-board" aria-label="Optimization symptom fixes">
                {optimizationSymptomSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`optimization-symptom-card ${step.status}`}
                    onClick={() => {
                      if (step.id === "slow-load") {
                        if (!optimizationJob?.optimizedSceneUrl) {
                          void optimizeProject();
                          return;
                        }
                        document.querySelector(".model-source-actions")?.scrollIntoView({ behavior: "smooth", block: "center" });
                        return;
                      }
                      if (step.id === "mobile-crash") {
                        setOptimizationProfile("mobile");
                        document.querySelector(".optimization-action-controls")?.scrollIntoView({
                          behavior: "smooth",
                          block: "center"
                        });
                        return;
                      }
                      if (step.id === "huge-textures") {
                        document.querySelector(".texture-delivery-plan")?.scrollIntoView({
                          behavior: "smooth",
                          block: "center"
                        });
                        return;
                      }
                      if (step.id === "quality-changed") {
                        if (manifest.sceneUrl === "scene.optimized.glb") {
                          void switchModelSource(originalSceneUrl);
                          return;
                        }
                        if (optimizationJob?.optimizedSceneUrl) {
                          void switchModelSource("scene.optimized.glb");
                          return;
                        }
                        void optimizeProject();
                      }
                    }}
                  >
                    <span>
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.status === "active" ? (
                        <Activity size={15} aria-hidden="true" />
                      ) : (
                        <Wrench size={15} aria-hidden="true" />
                      )}
                    </span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>

              {optimizeError && <p className="error-note">{optimizeError}</p>}

              {optimizationDoc ? (
                <div className="optimization-grid">
                  {optimizationDoc.profiles.map((profile) => (
                    <div key={profile.id} className="optimization-card">
                      <div className="optimization-card-heading">
                        <strong>{profile.label}</strong>
                        <span className={profile.status === "pass" ? "status-pill pass" : "status-pill warn"}>
                          {profile.status === "pass" ? "Ready" : "Needs work"}
                        </span>
                      </div>
                      <div className="stat-grid">
                        <Stat label="Model" value={formatBytes(profile.metrics.modelBytes)} />
                        <Stat label="Triangles" value={String(profile.metrics.triangles)} />
                        <Stat label="Draw prims" value={String(profile.metrics.drawPrimitives ?? profile.metrics.meshes)} />
                        <Stat label="Texture RAM" value={formatBytes(profile.metrics.textureMemoryBytes ?? 0)} />
                        <Stat label="Meshes" value={String(profile.metrics.meshes)} />
                        <Stat label="Materials" value={String(profile.metrics.materials)} />
                        <Stat label="Geometry compression" value={geometryCompressionLabel(bundleStats)} />
                        <Stat label="Texture compression" value={textureCompressionLabel(bundleStats)} />
                      </div>
                      {profile.warnings.length > 0 ? (
                        <ul className="warning-list">
                          {profile.warnings.map((warning) => (
                            <li key={warning.code}>{warning.message}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="quiet-note">Within current profile budgets.</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="quiet-note">Run analysis to generate optimization profiles.</p>
              )}
            </div>

            <div className="side-stack">
              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Recommendations</h2>
                </div>
                {optimizationDoc ? (
                  <div className="recommendation-list">
                    {optimizationDoc.recommendations.map((item) => (
                      <div key={`${item.priority}-${item.action}`} className="recommendation-row">
                        <span className={`priority-pill ${item.priority}`}>{item.priority}</span>
                        <strong>{item.action}</strong>
                        <p>{item.reason}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="quiet-note">No recommendations generated.</p>
                )}
              </div>

              <div className="panel stats-panel texture-delivery-plan">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>Texture Delivery Plan</h2>
                  {selectedTexturePlan && (
                    <button
                      type="button"
                      className="button secondary compact-button"
                      onClick={() => void copyText(textureDeliveryPlanText(selectedTexturePlan, activeProjectId))}
                    >
                      <Copy size={15} aria-hidden="true" />
                      Copy Plan
                    </button>
                  )}
                </div>
                {selectedTexturePlan ? (
                  <div className="asset-health-section">
                    <span>{selectedTexturePlan.label} texture targets</span>
                    <div className="stat-grid">
                      <Stat label="Current RAM" value={formatBytes(selectedTexturePlan.currentBytes)} />
                      <Stat label="Target RAM" value={formatBytes(selectedTexturePlan.budgetBytes)} />
                      <Stat label="Planned RAM" value={formatBytes(selectedTexturePlan.estimatedAfterBytes)} />
                      <Stat label="Max edge" value={`${selectedTexturePlan.maxDimension}px`} />
                    </div>
                    {selectedTexturePlan.items.length > 0 && toolStatus?.tools.toktx?.ready === false && (
                      <p className="quiet-note">
                        WebP resizing can run now. KTX2/Basis GPU compression needs {toolStatus.tools.toktx.command}:{" "}
                        {toolStatus.tools.toktx.action}
                      </p>
                    )}
                    {selectedTexturePlan.items.length > 0 ? (
                      selectedTexturePlan.items.slice(0, 6).map((item) => (
                        <div key={`${selectedTexturePlan.profileId}-${item.source}`} className="asset-suggestion-row">
                          {canPreviewTextureAsset(item.source) && (
                            <img src={projectAssetPath(activeProjectId, item.source)} alt="" loading="lazy" />
                          )}
                          <div>
                            <strong>{item.source}</strong>
                            <small>
                              {item.width}x{item.height} to {item.targetWidth}x{item.targetHeight} - save{" "}
                              {formatBytes(item.estimatedSavingsBytes)}
                            </small>
                            <code>{item.reason}</code>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="quiet-note">No texture downscale targets are needed for this profile.</p>
                    )}
                  </div>
                ) : (
                  <p className="quiet-note">Run analysis to generate a texture delivery plan.</p>
                )}
              </div>

              <div className="panel publish-panel">
                <div className="publish-row">
                  <span>Generated</span>
                </div>
                <code>{optimizationDoc?.generatedAt ?? "Not generated"}</code>
                <div className="publish-row">
                  <span>Current Model</span>
                </div>
                <code>{manifest.sceneUrl ?? "scene.glb"}</code>
                <div className="model-source-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={
                      !apiConnected ||
                      optimizeState === "optimizing" ||
                      (manifest.sceneUrl ?? originalSceneUrl) === originalSceneUrl
                    }
                    onClick={() => void switchModelSource(originalSceneUrl)}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!apiConnected || optimizeState === "optimizing" || manifest.sceneUrl === "scene.optimized.glb"}
                    onClick={() => void switchModelSource("scene.optimized.glb")}
                  >
                    Optimized
                  </button>
                </div>
              </div>

              <div className="panel stats-panel">
                <div className="panel-heading">
                  <Activity size={18} aria-hidden="true" />
                  <h2>Last Optimization Job</h2>
                  {optimizationJob && optimizationJob.status !== "idle" && (
                    <button
                      type="button"
                      className="button secondary compact-button"
                      onClick={() => void copyText(optimizationJobReportText(optimizationJob, activeProjectId))}
                    >
                      <Copy size={15} aria-hidden="true" />
                      Copy Report
                    </button>
                  )}
                </div>
                {optimizationJob && optimizationJob.status !== "idle" ? (
                  <>
                    <div className="stat-grid">
                      <Stat label="Profile" value={optimizationJob.profile} />
                      <Stat label="Status" value={optimizationJob.status} />
                      <Stat label="Before" value={formatBytes(optimizationJob.before?.modelBytes ?? 0)} />
                      <Stat label="After" value={formatBytes(optimizationJob.after?.modelBytes ?? 0)} />
                      <Stat label="Texture before" value={formatBytes(optimizationJob.before?.decodedTextureBytes ?? 0)} />
                      <Stat label="Texture after" value={formatBytes(optimizationJob.after?.decodedTextureBytes ?? 0)} />
                      <Stat label="Texture saved" value={formatBytes(optimizationJob.after?.savedDecodedTextureBytes ?? 0)} />
                      <Stat label="Texture files saved" value={formatBytes(optimizationJob.after?.savedTextureImageBytes ?? 0)} />
                    </div>
                    <div className="publish-row">
                      <span>Artifact</span>
                    </div>
                    <code>{optimizationJob.optimizedSceneUrl ?? "Not generated"}</code>
                    <div className="job-step-list">
                      {optimizationJob.steps.map((step) => (
                        <div key={step.id} className={`job-step-row ${step.status}`}>
                          <div className="job-step-main">
                            <span>{step.label}</span>
                            {step.note && <small>{step.note}</small>}
                          </div>
                          <strong>{step.status}</strong>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="quiet-note">No optimization job has run for this project yet.</p>
                )}
              </div>

              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Optimization History</h2>
                </div>
                {optimizationHistory && optimizationHistory.jobs.length > 0 ? (
                  <div className="job-history-list">
                    {optimizationHistory.jobs.slice(0, 5).map((job) => (
                      <div key={job.id} className="job-history-row">
                        <div>
                          <strong>{job.profile}</strong>
                          <span>{job.completedAt ?? job.startedAt ?? job.id}</span>
                        </div>
                        <small>
                          {formatBytes(job.after?.savedBytes ?? 0)} model /{" "}
                          {formatBytes(job.after?.savedDecodedTextureBytes ?? 0)} texture RAM saved
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="quiet-note">No optimization history yet.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {selectedTab === "publish" && (
          <section className="content-grid bundle-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <Globe2 size={18} aria-hidden="true" />
                <h2>Publish</h2>
                <button
                  type="button"
                  className="button secondary compact-button"
                  onClick={() =>
                    void copyText(
                      publishReadinessReportText({
                        projectId: activeProjectId,
                        title: manifest.branding.clientName ?? manifest.branding.title,
                        manifest,
                        stats: bundleStats,
                        publishChecks,
                        draftViewerUrl: viewerUrl(activeProjectId),
                        ...(activePublishedEntry && publishHistory
                          ? {
                              liveViewerUrl: livePublishedViewerUrl(activeProjectId, publishHistory),
                              liveVersion: activePublishedEntry.version,
                              liveDeliveryMode: publishEntryDeliveryMode(activePublishedEntry)
                            }
                          : {})
                      })
                    )
                  }
                >
                  <Copy size={15} aria-hidden="true" />
                  Copy Readiness
                </button>
              </div>

              <VisualGuideCard
                title="Client-ready publish"
                detail="Treat publishing as the final gate after visual, movement, room, interaction, lighting, and mobile checks are clear."
                steps={[
                  "Fix every blocking readiness row before creating a share link.",
                  hasPublishWarnings
                    ? "Publish only as a draft until the warning rows are fixed or explicitly accepted."
                    : "Publish a versioned bundle and open the generated URL.",
                  "Copy the embed or deployment checklist only after the published viewer passes the same manual test."
                ]}
                actionLabel={publishPrimaryActionLabel}
                actionDisabled={publishState === "publishing" || hasBlockingPublishErrors}
                onAction={() => void publishProject()}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />

              <div className="client-share-board" aria-label="Client share checklist">
                {clientDeliverySteps.map((step) => (
                  <div key={step.id} className={`client-share-step ${step.status}`}>
                    <div className="client-share-step-status">
                      {step.status === "ready" ? (
                        <Check size={16} aria-hidden="true" />
                      ) : step.status === "blocked" ? (
                        <AlertTriangle size={16} aria-hidden="true" />
                      ) : step.status === "warning" ? (
                        <AlertTriangle size={16} aria-hidden="true" />
                      ) : step.status === "active" ? (
                        <Activity size={16} aria-hidden="true" />
                      ) : (
                        <Globe2 size={16} aria-hidden="true" />
                      )}
                    </div>
                    <div className="client-share-step-main">
                      <strong>{step.label}</strong>
                      <p>{step.detail}</p>
                    </div>
                    {step.id === "readiness" && (
                      <button
                        type="button"
                        className="button secondary compact-button client-share-action"
                        onClick={() =>
                          hasBlockingPublishErrors
                            ? setSelectedTab("repair")
                            : void copyText(
                                publishReadinessReportText({
                                  projectId: activeProjectId,
                                  title: manifest.branding.clientName ?? manifest.branding.title,
                                  manifest,
                                  stats: bundleStats,
                                  publishChecks,
                                  draftViewerUrl: viewerUrl(activeProjectId),
                                  ...(activePublishedEntry && publishHistory
                                    ? {
                                        liveViewerUrl: livePublishedViewerUrl(activeProjectId, publishHistory),
                                        liveVersion: activePublishedEntry.version,
                                        liveDeliveryMode: publishEntryDeliveryMode(activePublishedEntry)
                                      }
                                    : {})
                                })
                              )
                        }
                      >
                        {hasBlockingPublishErrors ? <Wrench size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                        {step.actionLabel}
                      </button>
                    )}
                    {step.id === "version" && (
                      <button
                        type="button"
                        className="button secondary compact-button client-share-action"
                        disabled={publishState === "publishing" || hasBlockingPublishErrors}
                        onClick={() => void publishProject()}
                      >
                        <Globe2 size={15} aria-hidden="true" />
                        {step.actionLabel}
                      </button>
                    )}
                    {step.id === "live" &&
                      (activePublishedEntry ? (
                        <button
                          type="button"
                          className="button secondary compact-button client-share-action"
                          onClick={() => void copyText(livePublishedViewerUrl(activeProjectId, publishHistory!))}
                        >
                          <Copy size={15} aria-hidden="true" />
                          {step.actionLabel}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button secondary compact-button client-share-action"
                          disabled={!latestPublishedEntry || !apiConnected || activePublishVersion === latestPublishedEntry.version}
                          onClick={() => latestPublishedEntry && void activatePublishedVersion(latestPublishedEntry)}
                        >
                          <Globe2 size={15} aria-hidden="true" />
                          {activePublishVersion && latestPublishedEntry?.version === activePublishVersion ? "Setting" : step.actionLabel}
                        </button>
                      ))}
                    {step.id === "client-test" &&
                      (() => {
                        const testViewerUrl = activePublishedEntry
                          ? livePublishedViewerUrl(activeProjectId, publishHistory!)
                          : latestPublishedEntry
                            ? publishedViewerUrl(latestPublishedEntry)
                          : viewerUrl(activeProjectId);
                        const testEntry = activePublishedEntry ?? latestPublishedEntry;
                        const versionLabel = testEntry?.version ?? "draft";
                        return (
                          <div className="client-share-actions">
                            <button
                              type="button"
                              className="button secondary compact-button client-share-action"
                              onClick={() =>
                                void copyText(
                                  clientViewerTestScriptText({
                                    projectId: activeProjectId,
                                    title: manifest.branding.clientName ?? manifest.branding.title,
                                    viewerUrl: testViewerUrl,
                                    versionLabel,
                                    ...(testEntry
                                      ? { versionDeliveryMode: publishEntryDeliveryMode(testEntry) }
                                      : {}),
                                    manifest,
                                    stats: bundleStats
                                  })
                                )
                              }
                            >
                              <Copy size={15} aria-hidden="true" />
                              Copy Test
                            </button>
                            <a
                              className="button secondary compact-button client-share-action"
                              href={testViewerUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <ExternalLink size={15} aria-hidden="true" />
                              {step.actionLabel}
                            </a>
                          </div>
                        );
                      })()}
                  </div>
                ))}
              </div>

              <div className="publish-handoff-board" aria-label="Visual publish handoff">
                {publishHandoffSteps.map((step, index) => (
                  <div key={step.id} className={`publish-handoff-step ${step.status}`}>
                    <span className="publish-handoff-index">{index + 1}</span>
                    <div className="publish-handoff-main">
                      <strong>{step.label}</strong>
                      <p>{step.detail}</p>
                    </div>
                    {step.id === "gate" && (
                      <button
                        type="button"
                        className="button secondary compact-button publish-handoff-action"
                        onClick={() =>
                          hasBlockingPublishErrors
                            ? setSelectedTab("repair")
                            : void copyText(
                                publishReadinessReportText({
                                  projectId: activeProjectId,
                                  title: manifest.branding.clientName ?? manifest.branding.title,
                                  manifest,
                                  stats: bundleStats,
                                  publishChecks,
                                  draftViewerUrl: viewerUrl(activeProjectId),
                                  ...(activePublishedEntry && publishHistory
                                    ? {
                                        liveViewerUrl: livePublishedViewerUrl(activeProjectId, publishHistory),
                                        liveVersion: activePublishedEntry.version,
                                        liveDeliveryMode: publishEntryDeliveryMode(activePublishedEntry)
                                      }
                                    : {})
                                })
                              )
                        }
                      >
                        {hasBlockingPublishErrors ? <Wrench size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                        {step.actionLabel}
                      </button>
                    )}
                    {step.id === "draft" && (
                      <a
                        className="button secondary compact-button publish-handoff-action"
                        href={viewerUrl(activeProjectId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={15} aria-hidden="true" />
                        {step.actionLabel}
                      </a>
                    )}
                    {step.id === "version" && (
                      <button
                        type="button"
                        className="button secondary compact-button publish-handoff-action"
                        disabled={publishState === "publishing" || hasBlockingPublishErrors}
                        onClick={() => void publishProject()}
                      >
                        <Globe2 size={15} aria-hidden="true" />
                        {step.actionLabel}
                      </button>
                    )}
                    {step.id === "live" &&
                      (activePublishedEntry ? (
                        <button
                          type="button"
                          className="button secondary compact-button publish-handoff-action"
                          onClick={() => void copyText(livePublishedViewerUrl(activeProjectId, publishHistory!))}
                        >
                          <Copy size={15} aria-hidden="true" />
                          {step.actionLabel}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button secondary compact-button publish-handoff-action"
                          disabled={!latestPublishedEntry || !apiConnected || activePublishVersion === latestPublishedEntry.version}
                          onClick={() => latestPublishedEntry && void activatePublishedVersion(latestPublishedEntry)}
                        >
                          <Globe2 size={15} aria-hidden="true" />
                          {activePublishVersion && latestPublishedEntry?.version === activePublishVersion ? "Setting" : step.actionLabel}
                        </button>
                      ))}
                    {step.id === "package" && (
                      <button
                        type="button"
                        className="button secondary compact-button publish-handoff-action"
                        disabled={!publishHandoffEntry}
                        onClick={() => {
                          if (publishHandoffEntry?.deploymentPath) {
                            void copyText(
                              publishedDeploymentChecklist(
                                publishHandoffEntry,
                                manifest.branding.clientName ?? manifest.branding.title
                              )
                            );
                            return;
                          }
                          document.querySelector(".publish-version-list")?.scrollIntoView({ block: "center" });
                        }}
                      >
                        {publishHandoffEntry?.deploymentPath ? (
                          <Copy size={15} aria-hidden="true" />
                        ) : (
                          <FileJson size={15} aria-hidden="true" />
                        )}
                        {step.actionLabel}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              <div className="publish-hosting-board" aria-label="Hosting handoff">
                {publishHostingSteps.map((step) => (
                  <div key={step.id} className={`publish-hosting-step ${step.status}`}>
                    <span className="publish-hosting-icon">
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.status === "blocked" ? (
                        <AlertTriangle size={15} aria-hidden="true" />
                      ) : (
                        <Globe2 size={15} aria-hidden="true" />
                      )}
                    </span>
                    <div className="publish-hosting-main">
                      <strong>{step.label}</strong>
                      <p>{step.detail}</p>
                    </div>
                    <button
                      type="button"
                      className="button secondary compact-button publish-hosting-action"
                      disabled={!publishHandoffEntry?.deploymentPath}
                      onClick={() => {
                        if (!publishHandoffEntry?.deploymentPath) {
                          return;
                        }
                        if (step.id === "validate") {
                          void copyText(publishedValidateDeployCommand(publishHandoffEntry));
                          return;
                        }
                        if (step.id === "local") {
                          void copyText(publishedLocalDeployCommand(publishHandoffEntry));
                          return;
                        }
                        if (step.id === "bucket") {
                          void copyText(publishedBucketDeployCommand(publishHandoffEntry));
                          return;
                        }
                        if (step.id === "cache") {
                          void copyText(publishedBucketDeployWithCacheCommand(publishHandoffEntry));
                          return;
                        }
                        void copyText(
                          publishedDeploymentChecklist(
                            publishHandoffEntry,
                            manifest.branding.clientName ?? manifest.branding.title
                          )
                        );
                      }}
                    >
                      <Copy size={15} aria-hidden="true" />
                      {step.actionLabel}
                    </button>
                  </div>
                ))}
              </div>

              <div className="publish-action-card">
                <div>
                  <strong>{manifest.branding.clientName ?? manifest.branding.title}</strong>
                  <p className="quiet-note">
                    {hasPublishWarnings
                      ? "Save the current Studio edits, then create a draft static bundle for internal QA before client sharing."
                      : "Save the current Studio edits, then create a static versioned bundle for sharing or embedding."}
                  </p>
                  {firstPublishCheckIssue && (
                    <div className={hasBlockingPublishErrors ? "publish-next-issue blocked" : "publish-next-issue"}>
                      <span>{hasBlockingPublishErrors ? "Publish blocked" : "Before client delivery"}</span>
                      <strong>{firstPublishGateIssue?.title ?? firstPublishCheckIssue.label}</strong>
                      <p>{firstPublishGateIssue?.action ?? firstPublishCheckIssue.detail}</p>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="button primary"
                  disabled={publishState === "publishing" || hasBlockingPublishErrors}
                  onClick={() => void publishProject()}
                >
                  <Globe2 size={16} aria-hidden="true" />
                  {publishPrimaryActionLabel}
                </button>
              </div>

              {publishError && <p className="error-note">{publishError}</p>}
              {publishSuccess && <p className="success-note">{publishSuccess}</p>}

              <div className="publish-readiness-list" aria-label="Publish readiness">
                {publishChecks.map((check) => (
                  <div
                    key={check.id}
                    className={
                      check.ready ? "readiness-row ready" : check.blocking ? "readiness-row blocked" : "readiness-row warn"
                    }
                  >
                    <div>
                      <span>{check.label}</span>
                      <strong>{check.detail}</strong>
                    </div>
                    {!check.ready && check.action && (
                      <button
                        type="button"
                        className="button secondary compact-button readiness-action"
                        onClick={() => runImportDiagnosticAction(check.action!)}
                      >
                        {check.action === "repair" && <Wrench size={15} aria-hidden="true" />}
                        {check.action === "materials" && <Palette size={15} aria-hidden="true" />}
                        {check.action === "views" && <MapPin size={15} aria-hidden="true" />}
                        {check.action === "navigation" && <MapPin size={15} aria-hidden="true" />}
                        {check.action === "rooms" && <Layers3 size={15} aria-hidden="true" />}
                        {check.action === "interactions" && <Video size={15} aria-hidden="true" />}
                        {check.action === "optimize" && <Activity size={15} aria-hidden="true" />}
                        {check.action === "bake" && <Palette size={15} aria-hidden="true" />}
                        {check.action === "review" && <AlertTriangle size={15} aria-hidden="true" />}
                        {nextStepCopy(check.action).button}
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {bundleStats?.publishReadiness &&
                (bundleStats.publishReadiness.blockers.length > 0 ||
                  bundleStats.publishReadiness.warnings.length > 0) && (
                  <div className="diagnostic-list" aria-label="Publish quality gate details">
                    {bundleStats.publishReadiness.blockers.map((issue) => {
                      const action = publishActionForIssue(issue.code);
                      const actionCopy = action ? nextStepCopy(action) : undefined;
                      return (
                        <div key={issue.code} className="diagnostic-card error">
                          <AlertTriangle size={17} aria-hidden="true" />
                          <div className="diagnostic-card-main">
                            <div>
                              <strong>{issue.title}</strong>
                              <p>{issue.message}</p>
                              {issue.action && <small>{issue.action}</small>}
                            </div>
                            {action && actionCopy && (
                              <button
                                type="button"
                                className="button secondary compact-button diagnostic-action"
                                onClick={() => runImportDiagnosticAction(action)}
                              >
                                {action === "repair" && <Wrench size={15} aria-hidden="true" />}
                                {action === "environment" && <Globe2 size={15} aria-hidden="true" />}
                                {action === "materials" && <Palette size={15} aria-hidden="true" />}
                                {action === "views" && <MapPin size={15} aria-hidden="true" />}
                                {action === "navigation" && <MapPin size={15} aria-hidden="true" />}
                                {action === "rooms" && <Layers3 size={15} aria-hidden="true" />}
                                {action === "interactions" && <Video size={15} aria-hidden="true" />}
                                {action === "optimize" && <Activity size={15} aria-hidden="true" />}
                                {action === "bake" && <Palette size={15} aria-hidden="true" />}
                                {action === "review" && <AlertTriangle size={15} aria-hidden="true" />}
                                {actionCopy.button}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {bundleStats.publishReadiness.warnings.map((issue) => {
                      const action = publishActionForIssue(issue.code);
                      const actionCopy = action ? nextStepCopy(action) : undefined;
                      return (
                        <div key={issue.code} className="diagnostic-card warning">
                          <AlertTriangle size={17} aria-hidden="true" />
                          <div className="diagnostic-card-main">
                            <div>
                              <strong>{issue.title}</strong>
                              <p>{issue.message}</p>
                              {issue.action && <small>{issue.action}</small>}
                            </div>
                            {action && actionCopy && (
                              <button
                                type="button"
                                className="button secondary compact-button diagnostic-action"
                                onClick={() => runImportDiagnosticAction(action)}
                              >
                                {action === "repair" && <Wrench size={15} aria-hidden="true" />}
                                {action === "environment" && <Globe2 size={15} aria-hidden="true" />}
                                {action === "materials" && <Palette size={15} aria-hidden="true" />}
                                {action === "views" && <MapPin size={15} aria-hidden="true" />}
                                {action === "navigation" && <MapPin size={15} aria-hidden="true" />}
                                {action === "rooms" && <Layers3 size={15} aria-hidden="true" />}
                                {action === "interactions" && <Video size={15} aria-hidden="true" />}
                                {action === "optimize" && <Activity size={15} aria-hidden="true" />}
                                {action === "bake" && <Palette size={15} aria-hidden="true" />}
                                {action === "review" && <AlertTriangle size={15} aria-hidden="true" />}
                                {actionCopy.button}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

              <div className="publish-row">
                <span>Draft Viewer</span>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void copyText(viewerUrl(activeProjectId))}
                >
                  <Copy size={16} aria-hidden="true" />
                  Copy
                </button>
              </div>
              <code>{viewerUrl(activeProjectId)}</code>
              {publishHistory?.activeVersion && (
                <>
                  <div className="publish-row">
                    <span>Live Published Link</span>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void copyText(livePublishedViewerUrl(activeProjectId, publishHistory))}
                    >
                      <Copy size={16} aria-hidden="true" />
                      Copy
                    </button>
                  </div>
                  <code>{livePublishedViewerUrl(activeProjectId, publishHistory)}</code>
                  {activeLiveIsDraft && (
                    <div className="publish-next-issue">
                      <span>Live link is a draft</span>
                      <strong>{activeLiveDeliveryMode ?? "Draft"}</strong>
                      <p>
                        This client link still has saved quality-gate issues. Keep it for internal review until the
                        warnings are fixed or intentionally accepted.
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="side-stack">
              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Versions</h2>
                </div>
                {publishHistory && publishHistory.versions.length > 0 ? (
                  <div className="publish-version-list">
                    {publishHistory.versions.map((entry) => (
                      <div key={entry.version} className="publish-version-row">
                        <div>
                          <div className="publish-version-title">
                            <strong>{entry.version}</strong>
                            {publishHistory.activeVersion === entry.version ? (
                              <span className="publish-live-pill">Live</span>
                            ) : (
                              <span className="publish-live-pill not-live">Not live</span>
                            )}
                            <span className={`publish-delivery-pill ${entry.qualityGate?.status ?? "unknown"}`}>
                              {publishEntryDeliveryMode(entry)}
                            </span>
                          </div>
                          <span>{entry.publishedAt}</span>
                          {typeof entry.assetCount === "number" && (
                            <small>
                              {entry.assetCount} assets / {formatBytes(entry.totalBytes ?? 0)}
                            </small>
                          )}
                          {entry.qualityGate && (
                            <div className={`publish-gate-pill ${entry.qualityGate.status}`}>
                              <span>{entry.qualityGate.status}</span>
                              <small>
                                {entry.qualityGate.blockerCount ?? 0} blocker
                                {(entry.qualityGate.blockerCount ?? 0) === 1 ? "" : "s"} /{" "}
                                {entry.qualityGate.warningCount ?? 0} warning
                                {(entry.qualityGate.warningCount ?? 0) === 1 ? "" : "s"}
                              </small>
                              {(entry.qualityGate.blockers?.[0] ?? entry.qualityGate.warnings?.[0]) && (
                                <small>
                                  {(entry.qualityGate.blockers?.[0] ?? entry.qualityGate.warnings?.[0])?.title}
                                </small>
                              )}
                            </div>
                          )}
                          {entry.runtime && (
                            <div className="publish-runtime-summary" aria-label="Published runtime summary">
                              <div className="publish-runtime-heading">
                                <span>What ships</span>
                                <small>{entry.runtime.sceneUrl}</small>
                              </div>
                              <div className="publish-runtime-grid">
                                <span>
                                  <strong>{formatRuntimeNumber(entry.runtime.modelScale)}x</strong>
                                  <small>model scale</small>
                                </span>
                                <span>
                                  <strong>
                                    {entry.runtime.modelOffset
                                      ? formatRuntimeNumber(entry.runtime.modelOffsetDistance ?? 0, 1)
                                      : "0"}
                                  </strong>
                                  <small>offset units</small>
                                </span>
                                <span>
                                  <strong>{entry.runtime.toneMapping}</strong>
                                  <small>tone map</small>
                                </span>
                                <span>
                                  <strong>{formatRuntimeNumber(entry.runtime.exposure, 2)}</strong>
                                  <small>exposure</small>
                                </span>
                                <span>
                                  <strong>{entry.runtime.viewCount}</strong>
                                  <small>
                                    {entry.runtime.walkViewCount} walk / {entry.runtime.topViewCount} top
                                  </small>
                                </span>
                                <span>
                                  <strong>{entry.runtime.navigationZoneCount}</strong>
                                  <small>nav zones</small>
                                </span>
                                <span>
                                  <strong>{entry.runtime.roomCount}</strong>
                                  <small>rooms</small>
                                </span>
                                <span>
                                  <strong>{entry.runtime.interactionCount}</strong>
                                  <small>interactions</small>
                                </span>
                              </div>
                              {entry.runtime.modelOffset && (
                                <small>
                                  Runtime offset {formatRuntimeVec3(entry.runtime.modelOffset)} is applied in the
                                  viewer.
                                </small>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="publish-version-actions">
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => void copyText(publishedViewerUrl(entry))}
                          >
                            <Copy size={16} aria-hidden="true" />
                            URL
                          </button>
                          <a
                            className="button secondary"
                            href={publishedViewerUrl(entry)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={16} aria-hidden="true" />
                            Open
                          </a>
                          {entry.deploymentPath && (
                            <button
                              type="button"
                              className="button secondary"
                              onClick={() => void copyText(entry.deploymentPath!)}
                            >
                              <Copy size={16} aria-hidden="true" />
                              Manifest
                            </button>
                          )}
                          <button
                            type="button"
                            className={publishHistory.activeVersion === entry.version ? "button primary" : "button secondary"}
                            disabled={
                              !apiConnected ||
                              activePublishVersion === entry.version ||
                              publishHistory.activeVersion === entry.version
                            }
                            onClick={() => void activatePublishedVersion(entry)}
                          >
                            <Globe2 size={16} aria-hidden="true" />
                            {publishHistory.activeVersion === entry.version
                              ? "Live"
                              : activePublishVersion === entry.version
                                ? "Setting"
                                : setLiveActionLabel(entry)}
                          </button>
                        </div>
                        {entry.cdnBasePath && <code>{entry.cdnBasePath}</code>}
                        <code>{publishedEmbedSnippet(entry, manifest.branding.clientName ?? manifest.branding.title)}</code>
                        {entry.deploymentPath && (
                          <div className="deploy-command-list">
                            <div className="publish-row">
                              <span>Deployment checklist</span>
                              <button
                                type="button"
                                className="button primary"
                                onClick={() =>
                                  void copyText(
                                    publishedDeploymentChecklist(
                                      entry,
                                      manifest.branding.clientName ?? manifest.branding.title
                                    )
                                  )
                                }
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <div className="publish-row">
                              <span>Validate bundle</span>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => void copyText(publishedValidateDeployCommand(entry))}
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <code>{publishedValidateDeployCommand(entry)}</code>
                            <div className="publish-row">
                              <span>Client gate</span>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => void copyText(publishedClientGateDeployCommand(entry))}
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <code>{publishedClientGateDeployCommand(entry)}</code>
                            <div className="publish-row">
                              <span>Local deploy</span>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => void copyText(publishedLocalDeployCommand(entry))}
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <code>{publishedLocalDeployCommand(entry)}</code>
                            <div className="publish-row">
                              <span>S3/R2 deploy</span>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => void copyText(publishedBucketDeployCommand(entry))}
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <code>{publishedBucketDeployCommand(entry)}</code>
                            <div className="publish-row">
                              <span>S3/R2 deploy with cache headers</span>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => void copyText(publishedBucketDeployWithCacheCommand(entry))}
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <code>{publishedBucketDeployWithCacheCommand(entry)}</code>
                            <div className="publish-row">
                              <span>S3-compatible endpoint</span>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => void copyText(publishedS3CompatibleDeployCommand(entry))}
                              >
                                <Copy size={16} aria-hidden="true" />
                                Copy
                              </button>
                            </div>
                            <code>{publishedS3CompatibleDeployCommand(entry)}</code>
                          </div>
                        )}
                        {!entry.deploymentPath && (
                          <p className="quiet-note">
                            Republish this project to generate deployment metadata and copy-ready deploy commands.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="quiet-note">No published versions yet.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {selectedTab === "views" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Views</h2>
                <div className="mini-actions">
                  <button
                    type="button"
                    className="icon-action"
                    title="Create top view from bounds"
                    onClick={createOrUpdateTopView}
                  >
                    <Layers3 size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add view" onClick={addView}>
                    <Plus size={17} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {manifest.views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={selectedViewId === view.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedViewId(view.id)}
                >
                  <span>{view.label}</span>
                  <small>
                    {view.kind === "top"
                      ? "top view"
                      : enabledNavigationZones(manifest.navigation, "block").some((zone) =>
                            pointInNavigationZone(zone, view.position, 0.15)
                          )
                        ? "inside blocker"
                        : !pointInNavigationBounds(view.position, manifest.navigation.bounds, 0.05)
                          ? "outside bounds"
                          : enabledNavigationZones(manifest.navigation, "walk").length > 0 &&
                              !enabledNavigationZones(manifest.navigation, "walk").some((zone) =>
                                pointInNavigationZone(zone, view.position, 0.35)
                              )
                            ? "outside walk area"
                            : rooms.some((room) => room.viewId === view.id)
                              ? "room linked"
                              : "needs room link"}
                  </small>
                </button>
              ))}
            </div>

            {selectedView && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <MapPin size={18} aria-hidden="true" />
                  <h2>{selectedView.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete view"
                    onClick={() => removeView(selectedView.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <VisualGuideCard
                  title="Camera view setup"
                  detail="Saved views should match the room buttons and give users reliable starting points."
                  steps={[
                    "Create one walk view per important room or doorway decision point.",
                    "Use a top view for plan navigation and a walk view for each bottom button.",
                    "After editing positions, reopen the viewer and click each room button."
                  ]}
                  actionLabel="Create Top"
                  onAction={createOrUpdateTopView}
                  secondaryActionLabel="Repair Center"
                  onSecondaryAction={() => setSelectedTab("repair")}
                />

                <div className="view-setup-board" aria-label="View setup health">
                  {viewSetupSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`view-setup-card ${step.status}`}
                      disabled={step.status === "ready"}
                      onClick={() => {
                        if (step.id === "saved" || step.id === "walk") {
                          addView();
                          return;
                        }
                        if (step.id === "top") {
                          createOrUpdateTopView();
                          return;
                        }
                        if (step.id === "rooms") {
                          if (walkViewCount > 0) {
                            syncRoomsFromViews();
                          } else {
                            addView();
                          }
                          return;
                        }
                        if (step.id === "zones") {
                          if (walkViewCount > 0) {
                            createWalkZonesFromViews();
                          } else {
                            openNavigationWorkflow();
                          }
                        }
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : (
                          <MapPin size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedView.label}
                      onChange={(event) =>
                        updateView(selectedView.id, (view) => ({ ...view, label: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>Kind</span>
                    <select
                      value={selectedView.kind}
                      onChange={(event) =>
                        updateView(selectedView.id, (view) => ({
                          ...view,
                          kind: event.target.value as SceneView["kind"]
                        }))
                      }
                    >
                      <option value="walk">Walk</option>
                      <option value="orbit">Orbit</option>
                      <option value="top">Top</option>
                    </select>
                  </label>
                  <label>
                    <span>FOV</span>
                    <input
                      type="number"
                      value={selectedView.fov ?? 62}
                      onChange={(event) =>
                        updateView(selectedView.id, (view) => ({
                          ...view,
                          fov: toNumber(event.target.value, view.fov ?? 62)
                        }))
                      }
                    />
                  </label>
                </div>

                <VectorEditor
                  label="Position"
                  value={selectedView.position}
                  onChange={(next) => updateView(selectedView.id, (view) => ({ ...view, position: next }))}
                />
                <VectorEditor
                  label="Target"
                  value={selectedView.target}
                  onChange={(next) => updateView(selectedView.id, (view) => ({ ...view, target: next }))}
                />
              </div>
            )}
          </section>
        )}

        {selectedTab === "rooms" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Rooms</h2>
                <div className="mini-actions">
                  <button type="button" className="icon-action" title="Sync rooms from views" onClick={syncRoomsFromViews}>
                    <MapPin size={17} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-action"
                    title="Sync rooms from walk areas"
                    disabled={enabledNavigationZones(manifest.navigation, "walk").length === 0}
                    onClick={syncRoomsFromWalkZones}
                  >
                    <Layers3 size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add room" onClick={addRoom}>
                    <Plus size={17} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="room-planner-card">
                <div>
                  <strong>Room map</strong>
                  <p>
                    {rooms.length} room(s), {linkedRoomViewCount}/{walkViewCount} walk view(s) linked.
                  </p>
                </div>
                <div className="inline-actions">
                  <button type="button" className="button secondary compact-button" onClick={syncRoomsFromViews}>
                    <MapPin size={16} aria-hidden="true" />
                    Sync
                  </button>
                  <button
                    type="button"
                    className="button secondary compact-button"
                    disabled={enabledNavigationZones(manifest.navigation, "walk").length === 0}
                    onClick={syncRoomsFromWalkZones}
                  >
                    <Layers3 size={16} aria-hidden="true" />
                    From Walks
                  </button>
                  <button type="button" className="button secondary compact-button" onClick={addRoom}>
                    <Plus size={16} aria-hidden="true" />
                    Add
                  </button>
                </div>
              </div>
              <div className="room-setup-board" aria-label="Room setup health">
                {roomSetupSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`room-setup-card ${step.status}`}
                    disabled={step.status === "ready"}
                    onClick={() => {
                      if (step.id === "labels") {
                        if (rooms.length === 0 && roomWalkZoneCount > 0) {
                          syncRoomsFromWalkZones();
                          return;
                        }
                        addRoom();
                        return;
                      }
                      if (step.id === "regions" || step.id === "walks") {
                        if (roomWalkZoneCount > 0) {
                          syncRoomsFromWalkZones();
                          return;
                        }
                        openNavigationWorkflow();
                        return;
                      }
                      if (step.id === "views") {
                        if (walkViewCount > 0) {
                          syncRoomsFromViews();
                          return;
                        }
                        openViewsWorkflow();
                        return;
                      }
                      if (step.id === "bounds") {
                        openNavigationWorkflow();
                      }
                    }}
                  >
                    <span>{step.status === "ready" ? <Check size={15} aria-hidden="true" /> : <Layers3 size={15} aria-hidden="true" />}</span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>
              {rooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  className={selectedRoom?.id === room.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedRoomId(room.id)}
                >
                  <span>{room.label}</span>
                  <small>
                    {!room.viewId
                      ? "needs view"
                      : !room.bounds
                        ? "needs map area"
                        : enabledNavigationZones(manifest.navigation, "block").some((zone) =>
                            pointInNavigationZone(zone, roomCenter(room, manifest.views), 0.15)
                          )
                          ? "inside blocker"
                          : "room ready"}
                  </small>
                </button>
              ))}
              {rooms.length === 0 && <p className="empty-list">No rooms mapped.</p>}
            </div>

            {selectedRoom && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <MapPin size={18} aria-hidden="true" />
                  <h2>{selectedRoom.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete room"
                    onClick={() => removeRoom(selectedRoom.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>
                <VisualGuideCard
                  title="Room and top-view setup"
                  detail="Make the floorplan readable before editing exact numbers."
                  steps={[
                    "Sync from walk areas when navigation zones already outline each room.",
                    "Drag room markers on the map to the visible center of each space.",
                    "Link each room to a walk view so bottom buttons and top view agree."
                  ]}
                  actionLabel={enabledNavigationZones(manifest.navigation, "walk").length > 0 ? "From Walks" : "Sync"}
                  onAction={
                    enabledNavigationZones(manifest.navigation, "walk").length > 0
                      ? syncRoomsFromWalkZones
                      : syncRoomsFromViews
                  }
                  secondaryActionLabel="Repair Center"
                  onSecondaryAction={() => setSelectedTab("repair")}
                />
                <div className="room-walkability-board" aria-label="Selected room walkability">
                  {selectedRoomWalkabilitySteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`room-walkability-card ${step.status}`}
                      onClick={() => {
                        if (step.id === "button") {
                          if (walkViewCount > 0) {
                            syncRoomsFromViews();
                            return;
                          }
                          openViewsWorkflow();
                          return;
                        }
                        if (step.id === "map") {
                          if (roomWalkZoneCount > 0) {
                            syncRoomsFromWalkZones();
                            return;
                          }
                          openNavigationWorkflow();
                          return;
                        }
                        openNavigationWorkflow();
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : (
                          <Wrench size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>
                {manifest.navigation.bounds ? (
                  ((roomMapBounds) => (
                  <div className="room-map">
                    <div className="room-map-heading">
                      <strong>Room map</strong>
                      <small>Drag a room marker to set its center</small>
                    </div>
                    <div className="room-map-surface">
                      {rooms
                        .filter((room) => room.bounds)
                        .map((room) => (
                          <button
                            key={`area-${room.id}`}
                            type="button"
                            className={selectedRoom.id === room.id ? "room-map-area active" : "room-map-area"}
                            style={roomBoundsMapStyle(room.bounds!, roomMapBounds)}
                            title={room.label}
                            onClick={() => setSelectedRoomId(room.id)}
                          >
                            <span>{room.label}</span>
                          </button>
                        ))}
                      {manifest.views.map((view) => (
                        <button
                          key={view.id}
                          type="button"
                          className={
                            selectedRoom.viewId === view.id ? "room-map-view active" : "room-map-view"
                          }
                          style={pointMapStyle(view.position, roomMapBounds)}
                          title={view.label}
                          onClick={() =>
                            updateRoom(selectedRoom.id, (room) => ({
                              ...room,
                              viewId: view.id,
                              center: view.position
                            }))
                          }
                        >
                          <span className="sr-only">{view.label}</span>
                        </button>
                      ))}
                      {rooms.map((room) => (
                        <button
                          key={room.id}
                          type="button"
                          className={selectedRoom.id === room.id ? "room-map-item active" : "room-map-item"}
                          style={pointMapStyle(roomCenter(room, manifest.views), roomMapBounds)}
                          title={room.label}
                          onClick={() => setSelectedRoomId(room.id)}
                          onPointerDown={(event) => {
                            event.preventDefault();
                            setSelectedRoomId(room.id);
                            const mapElement = event.currentTarget.closest(".room-map-surface");
                            if (mapElement instanceof HTMLElement) {
                              moveRoomOnMap(room.id, mapElement, event.clientX, event.clientY);
                            }
                          }}
                        >
                          <span>{room.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  ))(manifest.navigation.bounds)
                ) : (
                  <div className="publish-action-card">
                    <div>
                      <strong>Room mapping needs bounds</strong>
                      <p className="quiet-note">
                        Set navigation bounds in Controls to enable the draggable room map.
                      </p>
                    </div>
                    <button type="button" className="button secondary" onClick={openNavigationWorkflow}>
                      <Wrench size={16} aria-hidden="true" />
                      Fix Bounds
                    </button>
                  </div>
                )}
                <div className="publish-row">
                  <span>Room setup</span>
                  <button type="button" className="button secondary" onClick={syncRoomsFromViews}>
                    <MapPin size={16} aria-hidden="true" />
                    Sync from views
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={enabledNavigationZones(manifest.navigation, "walk").length === 0}
                    onClick={syncRoomsFromWalkZones}
                  >
                    <Layers3 size={16} aria-hidden="true" />
                    Sync from walk areas
                  </button>
                </div>
                <div className="field-grid">
                  <label>
                    <span>Room name</span>
                    <input
                      value={selectedRoom.label}
                      onChange={(event) =>
                        updateRoom(selectedRoom.id, (room) => ({
                          ...room,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Dimensions</span>
                    <input
                      value={selectedRoom.dimensions ?? ""}
                      onChange={(event) =>
                        updateRoom(selectedRoom.id, (room) => ({
                          ...room,
                          dimensions: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Linked view</span>
                    <select
                      value={selectedRoom.viewId ?? ""}
                      onChange={(event) =>
                        updateRoom(selectedRoom.id, (room) => {
                          const viewId = event.target.value;
                          const linkedView = manifest.views.find((view) => view.id === viewId);
                          const nextRoom: RoomDefinition = { ...room };
                          if (linkedView) {
                            nextRoom.center = linkedView.position;
                          }
                          if (!viewId) {
                            delete nextRoom.viewId;
                            return nextRoom;
                          }
                          return {
                            ...nextRoom,
                            viewId
                          };
                        })
                      }
                    >
                      <option value="">Select view</option>
                      {manifest.views.map((view) => (
                        <option key={view.id} value={view.id}>
                          {view.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {selectedRoom.viewId && (
                  <div className="publish-row">
                    <span>Camera link</span>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => {
                        const linkedView = manifest.views.find((view) => view.id === selectedRoom.viewId);
                        if (!linkedView) {
                          return;
                        }
                        updateRoom(selectedRoom.id, (room) => ({
                          ...room,
                          center: linkedView.position
                        }));
                      }}
                    >
                      <MapPin size={16} aria-hidden="true" />
                      Use linked view position
                    </button>
                  </div>
                )}
                <VectorEditor
                  label="Center"
                  value={selectedRoom.center ?? [0, 0, 0]}
                  onChange={(next) =>
                    updateRoom(selectedRoom.id, (room) => ({
                      ...room,
                      center: next
                    }))
                  }
                />
              </div>
            )}
          </section>
        )}

        {selectedTab === "interactions" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Interactions</h2>
                <div className="mini-actions">
                  <button type="button" className="icon-action" title="Add hotspot" onClick={addHotspot}>
                    <Plus size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add link" onClick={addLink}>
                    <ExternalLink size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add object toggle" onClick={addObjectToggle}>
                    <Eye size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add video surface" onClick={addVideoTexture}>
                    <Video size={17} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-action"
                    title="Map likely video screens"
                    disabled={videoSurfaceCandidates.every((candidate) => candidate.score < 6)}
                    onClick={addLikelyVideoTextures}
                  >
                    <Wrench size={17} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <VisualGuideCard
                className="compact"
                title="Screens and clickable points"
                detail="Use visual candidates first, then edit the selected interaction only when needed."
                steps={[
                  "Map likely TV screens when candidates are available.",
                  "Select a video surface and choose the mesh or material that looks like a screen.",
                  "Add hotspots, links, or object toggles after the main screen surfaces are tested."
                ]}
                actionLabel="Map Likely"
                actionDisabled={likelyVideoSurfaceCandidates.length === 0}
                onAction={addLikelyVideoTextures}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />
              {videoSurfaceCandidates.length > 0 && (
                <div className="screen-planner-card">
                  <div>
                    <strong>TV screens</strong>
                    <p>
                      {mappedVideoSurfaceCount}/{videoSurfaceCandidates.length} candidate surface(s) mapped
                      {likelyVideoSurfaceCandidates.length > 0
                        ? `, ${likelyVideoSurfaceCandidates.length} likely screen(s)`
                        : ""}.
                    </p>
                  </div>
                  <div className="inline-actions">
                    <button type="button" className="button secondary compact-button" onClick={addVideoTexture}>
                      <Video size={16} aria-hidden="true" />
                      Add Screen
                    </button>
                    <button
                      type="button"
                      className="button primary compact-button"
                      disabled={likelyVideoSurfaceCandidates.length === 0}
                      onClick={addLikelyVideoTextures}
                    >
                      <Wrench size={16} aria-hidden="true" />
                      Map Likely
                    </button>
                  </div>
                </div>
              )}
              <div className="interaction-setup-board" aria-label="Interaction setup health">
                {interactionSetupSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`interaction-setup-card ${step.status}`}
                    disabled={step.status === "ready"}
                    onClick={() => {
                      if (step.id === "detect-screens") {
                        if (likelyVideoSurfaceCandidates.length > 0) {
                          addLikelyVideoTextures();
                          return;
                        }
                        addVideoTexture();
                        return;
                      }
                      if (step.id === "screen-targets" || step.id === "screen-media") {
                        const reviewTarget =
                          videoTextureInteractions.find(
                            (interaction) =>
                              (step.id === "screen-media" && !interaction.source.trim()) ||
                              (step.id === "screen-targets" &&
                                !interaction.targetMeshName &&
                                !interaction.targetMaterialName)
                          ) ?? videoTextureInteractions[0];
                        if (reviewTarget) {
                          setSelectedInteractionId(reviewTarget.id);
                          return;
                        }
                        addVideoTexture();
                        return;
                      }
                      if (step.id === "object-toggles") {
                        const reviewTarget =
                          objectToggleInteractions.find((interaction) => {
                            const targetId = interaction.targetObjectId?.trim();
                            const targetName = normalizedObjectMatchName(interaction.targetObjectName ?? "");
                            if (!targetId && !targetName) {
                              return true;
                            }
                            return !(
                              (targetId && objectToggleKnownTargetKeys.ids.has(targetId)) ||
                              (targetName && objectToggleKnownTargetKeys.names.has(targetName))
                            );
                          }) ?? objectToggleInteractions[0];
                        if (reviewTarget) {
                          setSelectedInteractionId(reviewTarget.id);
                          return;
                        }
                        addObjectToggle();
                        return;
                      }
                      if (step.id === "hotspots") {
                        addHotspot();
                      }
                    }}
                  >
                    <span>
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.id.includes("screen") ? (
                        <Video size={15} aria-hidden="true" />
                      ) : (
                        <MapPin size={15} aria-hidden="true" />
                      )}
                    </span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>
              {hotspotInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.title}</span>
                  <small>{interaction.icon ?? "info"}</small>
                </button>
              ))}
              {linkInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>link</small>
                </button>
              ))}
              {objectToggleInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>object toggle</small>
                </button>
              ))}
              {videoTextureInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>
                    {!interaction.targetMeshName && !interaction.targetMaterialName
                      ? "needs target"
                      : !interaction.source.trim()
                        ? "needs video"
                        : isValidMediaSource(interaction.source)
                          ? "screen ready"
                          : "check video"}
                  </small>
                </button>
              ))}
            </div>

            {selectedHotspot && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Globe2 size={18} aria-hidden="true" />
                  <h2>{selectedHotspot.title}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete hotspot"
                    onClick={() => removeHotspot(selectedHotspot.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <InteractionHealthBoard
                  title="Hotspot readiness"
                  steps={selectedInteractionHealthSteps}
                  onCopyRequest={() =>
                    void copyText(
                      interactionSetupRequestText({
                        projectId: activeProjectId,
                        title: manifest.branding.title,
                        interaction: selectedHotspot,
                        steps: selectedInteractionHealthSteps,
                        draftViewerUrl: viewerUrl(activeProjectId)
                      })
                    )
                  }
                />
                <InteractionPlacementCard
                  selectedView={selectedView}
                  onUsePosition={applySelectedInteractionPosition}
                />

                <div className="field-grid">
                  <label>
                    <span>Title</span>
                    <input
                      value={selectedHotspot.title}
                      onChange={(event) =>
                        updateHotspot(selectedHotspot.id, (interaction) => ({
                          ...interaction,
                          title: event.target.value,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Icon</span>
                    <select
                      value={selectedHotspot.icon ?? "info"}
                      onChange={(event) =>
                        updateHotspot(selectedHotspot.id, (interaction) => ({
                          ...interaction,
                          icon: event.target.value as HotspotIcon
                        }))
                      }
                    >
                      <option value="info">Info</option>
                      <option value="media">Media</option>
                      <option value="link">Link</option>
                    </select>
                  </label>
                </div>

                <label className="textarea-field">
                  <span>Body</span>
                  <textarea
                    value={selectedHotspot.body ?? ""}
                    onChange={(event) =>
                      updateHotspot(selectedHotspot.id, (interaction) => ({
                        ...interaction,
                        body: event.target.value
                      }))
                    }
                  />
                </label>

                <VectorEditor
                  label="Position"
                  value={selectedHotspot.position}
                  onChange={(next) =>
                    updateHotspot(selectedHotspot.id, (interaction) => ({ ...interaction, position: next }))
                  }
                />
              </div>
            )}

            {selectedLink && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <ExternalLink size={18} aria-hidden="true" />
                  <h2>{selectedLink.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete link"
                    onClick={() => removeLink(selectedLink.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <InteractionHealthBoard
                  title="Link readiness"
                  steps={selectedInteractionHealthSteps}
                  onCopyRequest={() =>
                    void copyText(
                      interactionSetupRequestText({
                        projectId: activeProjectId,
                        title: manifest.branding.title,
                        interaction: selectedLink,
                        steps: selectedInteractionHealthSteps,
                        draftViewerUrl: viewerUrl(activeProjectId)
                      })
                    )
                  }
                />
                <InteractionPlacementCard
                  selectedView={selectedView}
                  onUsePosition={applySelectedInteractionPosition}
                />

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedLink.label}
                      onChange={(event) =>
                        updateLink(selectedLink.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>URL</span>
                    <input
                      value={selectedLink.url}
                      onChange={(event) =>
                        updateLink(selectedLink.id, (interaction) => ({
                          ...interaction,
                          url: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label className="toggle-row compact-toggle">
                    <input
                      type="checkbox"
                      checked={selectedLink.openInNewTab !== false}
                      onChange={(event) =>
                        updateLink(selectedLink.id, (interaction) => ({
                          ...interaction,
                          openInNewTab: event.target.checked
                        }))
                      }
                    />
                    <span>New tab</span>
                  </label>
                </div>

                <VectorEditor
                  label="Position"
                  value={selectedLink.position}
                  onChange={(next) => updateLink(selectedLink.id, (interaction) => ({ ...interaction, position: next }))}
                />
              </div>
            )}

            {selectedObjectToggle && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Eye size={18} aria-hidden="true" />
                  <h2>{selectedObjectToggle.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete object toggle"
                    onClick={() => removeObjectToggle(selectedObjectToggle.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <InteractionHealthBoard
                  title="Object toggle readiness"
                  steps={selectedInteractionHealthSteps}
                  onCopyRequest={() =>
                    void copyText(
                      interactionSetupRequestText({
                        projectId: activeProjectId,
                        title: manifest.branding.title,
                        interaction: selectedObjectToggle,
                        steps: selectedInteractionHealthSteps,
                        draftViewerUrl: viewerUrl(activeProjectId)
                      })
                    )
                  }
                />
                <InteractionPlacementCard
                  selectedView={selectedView}
                  onUsePosition={applySelectedInteractionPosition}
                />

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedObjectToggle.label}
                      onChange={(event) =>
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Target Object</span>
                    <select
                      value={selectedObjectToggle.targetObjectId ?? ""}
                      onChange={(event) => {
                        const object = objectToggleTargetOptions.find((item) => item.id === event.target.value);
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          targetObjectId: object?.id ?? "",
                          targetObjectName: object?.name ?? ""
                        }));
                      }}
                    >
                      <option value="">Select object</option>
                      {objectToggleTargetOptions.map((object) => (
                        <option key={object.id} value={object.id}>
                          {object.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedObjectToggleTargetState !== "ready" && (
                    <p className="error-note compact-note">
                      {selectedObjectToggleTargetState === "missing"
                        ? "Choose the object this toggle should show or hide before testing."
                        : "This target was not found in the current scene graph. Pick the object again after reimport."}
                    </p>
                  )}
                  <label className="toggle-row compact-toggle">
                    <input
                      type="checkbox"
                      checked={selectedObjectToggle.initiallyVisible !== false}
                      onChange={(event) =>
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          initiallyVisible: event.target.checked
                        }))
                      }
                    />
                    <span>Initially visible</span>
                  </label>
                </div>

                <VectorEditor
                  label="Position"
                  value={selectedObjectToggle.position}
                  onChange={(next) =>
                    updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                      ...interaction,
                      position: next
                    }))
                  }
                />
              </div>
            )}

            {selectedVideoTexture && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Video size={18} aria-hidden="true" />
                  <h2>{selectedVideoTexture.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete video surface"
                    onClick={() => removeVideoTexture(selectedVideoTexture.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <InteractionHealthBoard
                  title="Video screen readiness"
                  steps={selectedVideoTextureHealthSteps}
                  onCopyRequest={() =>
                    void copyText(
                      interactionSetupRequestText({
                        projectId: activeProjectId,
                        title: manifest.branding.title,
                        interaction: selectedVideoTexture,
                        steps: selectedVideoTextureHealthSteps,
                        draftViewerUrl: viewerUrl(activeProjectId)
                      })
                    )
                  }
                />

                {videoSurfaceCandidates.length > 0 && (
                  <div className="surface-mapper">
                    <div className="surface-mapper-heading">
                      <strong>Surface Mapper</strong>
                      <small>{videoSurfaceCandidates.length}</small>
                    </div>
                    <div className="surface-candidate-list">
                      {videoSurfaceCandidates.map((candidate) => {
                        const isActive =
                          selectedVideoTexture.targetMeshName === candidate.meshName ||
                          selectedVideoTexture.targetMaterialName === candidate.materialName;
                        return (
                          <button
                            key={candidate.id}
                            type="button"
                            className={isActive ? "surface-candidate active" : "surface-candidate"}
                            onClick={() => applyVideoSurfaceCandidate(candidate)}
                          >
                            <span>{candidate.label}</span>
                            <small>
                              {candidate.triangleCount} triangles
                              {candidate.dimensions ? ` / ${candidate.dimensions}` : ""}
                              {candidate.score > 0 ? ` / score ${candidate.score}` : ""}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedVideoTexture.label}
                      onChange={(event) =>
                        updateVideoTexture(selectedVideoTexture.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Video URL</span>
                    <input
                      value={selectedVideoTexture.source}
                      onChange={(event) =>
                        updateVideoTexture(selectedVideoTexture.id, (interaction) => ({
                          ...interaction,
                          source: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label className="file-inline-control">
                    <span>Upload Video</span>
                    <input
                      type="file"
                      accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm"
                      disabled={!apiConnected || mediaUploadState === "uploading"}
                      onChange={(event) => void uploadVideoMedia(selectedVideoTexture.id, event.target.files?.[0])}
                    />
                    <strong>
                      {mediaUploadState === "uploading" && "Uploading"}
                      {mediaUploadState === "done" && "Uploaded"}
                      {mediaUploadState === "error" && "Failed"}
                      {mediaUploadState === "idle" && "Choose file"}
                    </strong>
                  </label>
                  <label>
                    <span>Target Mesh</span>
                    <select
                      value={selectedVideoTexture.targetMeshName ?? ""}
                      onChange={(event) => {
                        const targetMeshName = event.target.value;
                        updateVideoTexture(selectedVideoTexture.id, (interaction) => {
                          const { targetMeshName: _removed, ...rest } = interaction;
                          return targetMeshName ? { ...rest, targetMeshName } : rest;
                        });
                      }}
                    >
                      <option value="">Auto / material target</option>
                      {sceneGraph?.nodes.map((node) => (
                        <option key={node.id} value={node.name}>
                          {node.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Target Material</span>
                    <select
                      value={selectedVideoTexture.targetMaterialName ?? ""}
                      onChange={(event) => {
                        const targetMaterialName = event.target.value;
                        updateVideoTexture(selectedVideoTexture.id, (interaction) => {
                          const { targetMaterialName: _removed, ...rest } = interaction;
                          return targetMaterialName ? { ...rest, targetMaterialName } : rest;
                        });
                      }}
                    >
                      <option value="">Auto / mesh target</option>
                      {materialsDoc?.materials.map((material) => (
                        <option key={material.id} value={material.name}>
                          {material.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NumberField
                    label="Trigger Distance"
                    min={0}
                    max={50}
                    step={0.5}
                    value={selectedVideoTexture.triggerDistance ?? 8}
                    onChange={(value) =>
                      updateVideoTexture(selectedVideoTexture.id, (interaction) => ({
                        ...interaction,
                        triggerDistance: value
                      }))
                    }
                  />
                </div>
                {mediaUploadError && <p className="error-note">{mediaUploadError}</p>}

                <div className="toggle-grid">
                  {(["autoplay", "muted", "loop"] as const).map((field) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={selectedVideoTexture[field] !== false}
                        onChange={(event) =>
                          updateVideoTexture(selectedVideoTexture.id, (interaction) => ({
                            ...interaction,
                            [field]: event.target.checked
                          }))
                        }
                      />
                      <span>{field}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "materials" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Materials</h2>
                <small>{filteredMaterialRows.length} / {materialsDoc?.materials.length ?? 0}</small>
              </div>
              <div className="material-review-tools">
                <label className="material-search-field">
                  <span>Find material</span>
                  <input
                    type="search"
                    value={materialSearchQuery}
                    placeholder="Search wall, floor, green, lightmap..."
                    onChange={(event) => setMaterialSearchQuery(event.target.value)}
                  />
                </label>
                <div className="material-filter-row" aria-label="Material filters">
                  {[
                    ["all", "All", materialFilterCounts.all],
                    ["suggested", "Suggested", materialFilterCounts.suggested],
                    ["untextured", "No Textures", materialFilterCounts.untextured],
                    ["plain-green", "Plain/Green", materialFilterCounts.plainGreen],
                    ["transparent", "Transparent", materialFilterCounts.transparent],
                    ["lightmaps", "Lightmaps", materialFilterCounts.lightmaps]
                  ].map(([id, label, count]) => (
                    <button
                      key={id}
                      type="button"
                      className={materialListFilter === id ? "material-filter-chip active" : "material-filter-chip"}
                      onClick={() => setMaterialListFilter(id as MaterialListFilter)}
                    >
                      <span>{label}</span>
                      <strong>{count}</strong>
                    </button>
                  ))}
                </div>
                <div className="material-bulk-actions">
                  <button
                    type="button"
                    className="button secondary compact-button"
                    disabled={filteredMaterialTextureSuggestionCount === 0}
                    onClick={() =>
                      applyMaterialTextureSuggestions({
                        materialNames: new Set(filteredMaterialRows.map((row) => row.material.name)),
                        scopeLabel: "the current material filter"
                      })
                    }
                  >
                    <Check size={15} aria-hidden="true" />
                    Apply Visible Suggestions
                  </button>
                  <small>
                    {filteredMaterialTextureSuggestionCount > 0
                      ? `${filteredMaterialTextureSuggestionCount} high-confidence suggestion${filteredMaterialTextureSuggestionCount === 1 ? "" : "s"} visible in this filtered list.`
                      : "No high-confidence suggestions are visible in this filtered list."}
                  </small>
                </div>
              </div>
              {filteredMaterialRows.map(({ material, suggestionStatus, assignedTextureCount, isPlainGreen, isTransparent, hasLightmap }) => {
                const materialStatus = suggestionStatus?.pending
                  ? `${suggestionStatus.pending} suggested texture${suggestionStatus.pending === 1 ? "" : "s"} ready`
                  : suggestionStatus?.review
                    ? `${suggestionStatus.review} texture match${suggestionStatus.review === 1 ? "" : "es"} need review`
                    : assignedTextureCount > 0
                      ? `${assignedTextureCount} texture map${assignedTextureCount === 1 ? "" : "s"} assigned`
                      : "no texture maps";
                return (
                  <button
                    key={material.id}
                    type="button"
                    className={selectedMaterialId === material.id ? "list-row active" : "list-row"}
                    onClick={() => setSelectedMaterialId(material.id)}
                  >
                    <span>{material.name}</span>
                    <small>{materialStatus}</small>
                    <span className="material-chip-row">
                      {suggestionStatus?.pending ? <span className="material-status-chip ready">Suggested</span> : null}
                      {suggestionStatus?.review ? <span className="material-status-chip review">Review Match</span> : null}
                      {isPlainGreen ? <span className="material-status-chip warning">Plain/Green</span> : null}
                      {isTransparent ? <span className="material-status-chip transparent">Transparent</span> : null}
                      {hasLightmap ? <span className="material-status-chip lightmap">Lightmap</span> : null}
                    </span>
                  </button>
                );
              })}
              {materialsDoc && filteredMaterialRows.length === 0 && (
                <p className="empty-list">No materials match this filter. Clear the search or switch back to All.</p>
              )}
              {!materialsDoc && <p className="empty-list">No materials generated.</p>}
            </div>

            {selectedMaterial && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>{selectedMaterial.name}</h2>
                </div>

                <VisualGuideCard
                  title="Visual material review"
                  detail="Judge materials from previews before changing raw values."
                  steps={[
                    "Pick a material and compare assigned maps with loose texture candidates.",
                    "Use Base, Normal, Emissive, or Lightmap buttons only after the preview matches.",
                    "Bake or upload lightmaps, then test the viewer against a reference render."
                  ]}
                  actionLabel={
                    pendingMaterialTextureSuggestionCount > 0
                      ? `Apply ${pendingMaterialTextureSuggestionCount}`
                      : bakeState === "baking"
                        ? "Baking"
                        : "Bake"
                  }
                  actionDisabled={
                    pendingMaterialTextureSuggestionCount > 0
                      ? false
                      : !canRunLightmapBake || bakeState === "baking"
                  }
                  onAction={
                    pendingMaterialTextureSuggestionCount > 0
                      ? applyMaterialTextureSuggestions
                      : () => void bakeLightmaps()
                  }
                  secondaryActionLabel="Repair Center"
                  onSecondaryAction={() => setSelectedTab("repair")}
                />

                <div className="material-setup-board" aria-label="Material setup health">
                  {materialSetupSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`material-setup-card ${step.status}`}
                      disabled={step.status === "ready" && step.id !== "lightmaps"}
                      onClick={() => {
                        setMaterialSearchQuery("");
                        setMaterialListFilter(step.filter);
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : step.status === "active" ? (
                          <Palette size={15} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>

                <div className="material-triage-board" aria-label="Material symptom fixes">
                  {materialTriageSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`material-triage-card ${step.status}`}
                      onClick={() => {
                        setMaterialSearchQuery("");
                        if (step.id === "flat") {
                          setMaterialListFilter(materialFilterCounts.suggested > 0 ? "suggested" : "untextured");
                          return;
                        }
                        if (step.id === "green") {
                          setMaterialListFilter("plain-green");
                          return;
                        }
                        if (step.id === "folder") {
                          setMaterialListFilter("suggested");
                          return;
                        }
                        if (step.id === "lighting") {
                          if (materialFilterCounts.lightmaps > 0) {
                            setMaterialListFilter("lightmaps");
                            return;
                          }
                          openBakeWorkflow();
                        }
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : step.status === "active" ? (
                          <Palette size={15} aria-hidden="true" />
                        ) : (
                          <Wrench size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>

                {selectedMaterialDiagnosis && (
                  <div className={`material-diagnosis-card ${selectedMaterialDiagnosis.tone}`}>
                    <div>
                      <span>Selected material diagnosis</span>
                      <strong>{selectedMaterialDiagnosis.title}</strong>
                      <p>{selectedMaterialDiagnosis.detail}</p>
                    </div>
                    <div className="material-diagnosis-actions">
                      <small>{selectedMaterialDiagnosis.action}</small>
                      <button
                        type="button"
                        className="button secondary compact-button"
                        onClick={() =>
                          void copyText(
                            materialFixBriefText({
                              projectId: activeProjectId,
                              material: selectedMaterial,
                              diagnosis: selectedMaterialDiagnosis,
                              previews: selectedMaterialTexturePreviews,
                              candidates: selectedMaterialTextureCandidates
                            })
                          )
                        }
                      >
                        <Copy size={15} aria-hidden="true" />
                        Copy Fix Brief
                      </button>
                    </div>
                  </div>
                )}

                <div className="publish-action-card lightmap-bake-card">
                  <div>
                    <strong>Automatic lightmap bake</strong>
                    <p className="quiet-note">
                      Uses Blender/Cycles when available. Manual uploaded lightmaps remain supported below.
                    </p>
                    <small>
                      {blenderTool
                        ? blenderTool.ready
                          ? `Blender ready: ${blenderTool.command}`
                          : blenderTool.action
                        : "Checking Blender availability."}
                    </small>
                  </div>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        void copyText(
                          lightmapBakePlanText({
                            projectId: activeProjectId,
                            settings: bakeSettings,
                            materialCount: materialCountForBake,
                            estimatedMaterialCount: estimatedBakeMaterialCount,
                            estimatedBytes: estimatedBakeTextureBytes,
                            preflightIssues: bakePreflightIssues,
                            blenderTool,
                            job: lightmapBakeJob
                          })
                        )
                      }
                    >
                      <Copy size={16} aria-hidden="true" />
                      Copy Plan
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!canRunLightmapBake}
                      onClick={() => void bakeLightmaps()}
                    >
                      <Activity size={16} aria-hidden="true" />
                      {bakeState === "baking" ? "Baking" : "Bake"}
                    </button>
                  </div>
                </div>
                {!canRunLightmapBake && lightmapBakeBlockedReason && bakeState !== "baking" && !bakePreflightBlocked && (
                  <p className={blenderTool && !blenderTool.ready ? "error-note" : "quiet-note"}>
                    {lightmapBakeBlockedReason}
                  </p>
                )}
                <div className="bake-setup-board" aria-label="Bake setup health">
                  {bakeSetupSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`bake-setup-card ${step.status}`}
                      disabled={step.status === "ready" && step.id !== "output"}
                      onClick={() => {
                        if (step.id === "quality") {
                          const preset = bakeSettings.preset === "super" ? "high" : "medium";
                          setBakeSettings((current) => ({
                            ...current,
                            preset,
                            ...bakePresetDefaults[preset]
                          }));
                          return;
                        }
                        if (step.id === "memory") {
                          setBakeSettings((current) => ({
                            ...current,
                            resolution: Math.min(current.resolution, 1024)
                          }));
                          return;
                        }
                        if (step.id === "preflight") {
                          setBakeSettings((current) => ({
                            ...current,
                            maxMaterials: Math.min(512, Math.max(current.maxMaterials, materialCountForBake)),
                            resolution: estimatedBakeTextureBytes > 1024 * 1024 * 1024 ? 1024 : current.resolution,
                            denoise: current.samples < 192 ? true : current.denoise
                          }));
                          return;
                        }
                        if (step.id === "output" && lightmapBakeJob?.lightmaps?.length) {
                          document.querySelector(".lightmap-review-summary")?.scrollIntoView({ block: "center" });
                          return;
                        }
                        if (step.id === "output" && canRunLightmapBake && lightmapBakeJob?.status !== "completed") {
                          void bakeLightmaps();
                        }
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : step.status === "active" ? (
                          <Activity size={15} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>
                <div className="bake-triage-board" aria-label="Bake symptom fixes">
                  {bakeTriageSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`bake-triage-card ${step.status}`}
                      onClick={() => {
                        if (step.id === "shadows") {
                          if (lightmappedMaterialCountForBake > 0) {
                            setMaterialListFilter("lightmaps");
                            return;
                          }
                          setBakeSettings((current) => ({
                            ...current,
                            preset: "medium",
                            ...bakePresetDefaults.medium
                          }));
                          if (canRunLightmapBake) {
                            void bakeLightmaps();
                          }
                          return;
                        }
                        if (step.id === "blank-output") {
                          document.querySelector(".lightmap-review-summary")?.scrollIntoView({ behavior: "smooth", block: "center" });
                          return;
                        }
                        if (step.id === "heavy") {
                          setBakeSettings((current) => ({
                            ...current,
                            preset: current.preset === "super" ? "high" : current.preset,
                            resolution: Math.min(current.resolution, 1024),
                            samples: Math.min(current.samples, 192),
                            denoise: true,
                            maxMaterials: Math.min(512, Math.max(current.maxMaterials, materialCountForBake))
                          }));
                          return;
                        }
                        if (step.id === "tool") {
                          void copyText(
                            lightmapBakePlanText({
                              projectId: activeProjectId,
                              settings: bakeSettings,
                              materialCount: materialCountForBake,
                              estimatedMaterialCount: estimatedBakeMaterialCount,
                              estimatedBytes: estimatedBakeTextureBytes,
                              preflightIssues: bakePreflightIssues,
                              blenderTool,
                              job: lightmapBakeJob
                            })
                          );
                        }
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : step.status === "active" ? (
                          <Activity size={15} aria-hidden="true" />
                        ) : (
                          <Wrench size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>
                <div className="field-grid">
                  <label className="field">
                    <span>Quality preset</span>
                    <select
                      value={bakeSettings.preset}
                      onChange={(event) => {
                        const preset = event.target.value as BakePreset;
                        setBakeSettings((current) => ({
                          ...current,
                          preset,
                          ...bakePresetDefaults[preset]
                        }));
                      }}
                    >
                      <option value="draft">Draft</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="super">Super</option>
                    </select>
                  </label>
                  <NumberField
                    label="Max lightmap px"
                    min={256}
                    max={4096}
                    step={256}
                    value={bakeSettings.resolution}
                    onChange={(value) =>
                      setBakeSettings((current) => ({
                        ...current,
                        resolution: Math.min(4096, Math.max(256, Math.round(value)))
                      }))
                    }
                  />
                  <NumberField
                    label="Samples"
                    min={16}
                    max={1024}
                    step={16}
                    value={bakeSettings.samples}
                    onChange={(value) =>
                      setBakeSettings((current) => ({
                        ...current,
                        samples: Math.min(1024, Math.max(16, Math.round(value)))
                      }))
                    }
                  />
                  <NumberField
                    label="Bake margin"
                    min={2}
                    max={96}
                    step={1}
                    value={bakeSettings.margin}
                    onChange={(value) =>
                      setBakeSettings((current) => ({
                        ...current,
                        margin: Math.min(96, Math.max(2, Math.round(value)))
                      }))
                    }
                  />
                  <NumberField
                    label="Max materials"
                    min={1}
                    max={512}
                    step={1}
                    value={bakeSettings.maxMaterials}
                    onChange={(value) =>
                      setBakeSettings((current) => ({
                        ...current,
                        maxMaterials: Math.min(512, Math.max(1, Math.round(value)))
                      }))
                    }
                  />
                  <label className="field">
                    <span>Bake pass</span>
                    <select
                      value={bakeSettings.mode}
                      onChange={(event) =>
                        setBakeSettings((current) => ({
                          ...current,
                          mode: event.target.value === "combined" ? "combined" : "lighting"
                        }))
                      }
                    >
                      <option value="lighting">Lighting</option>
                      <option value="combined">Combined</option>
                    </select>
                  </label>
                  <label className="field toggle-field">
                    <span>Denoise</span>
                    <input
                      type="checkbox"
                      checked={bakeSettings.denoise}
                      onChange={(event) =>
                        setBakeSettings((current) => ({
                          ...current,
                          denoise: event.target.checked
                        }))
                      }
                    />
                  </label>
                </div>
                {bakePresetModified && (
                  <div className="bake-preset-note">
                    <span>
                      Custom bake values differ from {bakeSettings.preset} defaults (
                      {activeBakePresetDefaults.resolution}px / {activeBakePresetDefaults.samples} samples /{" "}
                      {activeBakePresetDefaults.margin}px margin).
                    </span>
                    <button type="button" className="button secondary compact-button" onClick={resetBakeSettingsToPreset}>
                      Reset to preset
                    </button>
                  </div>
                )}
                <div className={bakePreflightBlocked ? "bake-preflight-card error" : bakePreflightRisk ? "bake-preflight-card warning" : "bake-preflight-card"}>
                  <div>
                    <strong>Bake preflight</strong>
                    <p>
                      {estimatedBakeMaterialCount} material(s) at {bakeSettings.resolution}px / {bakeSettings.samples} samples.
                    </p>
                  </div>
                  <span>{formatBytes(estimatedBakeTextureBytes)} raw lightmap target</span>
                  {bakePreflightIssues.length > 0 ? (
                    <ul>
                      {bakePreflightIssues.map((issue) => (
                        <li key={issue.message} className={issue.severity}>
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <small>Settings look reasonable for a local Blender/Cycles bake.</small>
                  )}
                </div>
                {bakeError && <p className="error-note">{bakeError}</p>}
                {lightmapBakeJob && lightmapBakeJob.status !== "idle" && (
                  <div className="job-step-list">
                    <div
                      className={`job-step-row ${
                        lightmapBakeJob.status === "completed"
                          ? "completed"
                          : lightmapBakeJob.status === "running"
                            ? "pending"
                            : "failed"
                      }`}
                    >
                      <div className="job-step-main">
                        <span>{lightmapBakeJob.engine}</span>
                        {lightmapBakeJob.message && <small>{lightmapBakeJob.message}</small>}
                        {lightmapBakeJob.bakeMode && <small>{lightmapBakeJob.bakeMode} bake</small>}
                        {typeof lightmapBakeJob.denoise === "boolean" && (
                          <small>{lightmapBakeJob.denoise ? "denoise on" : "denoise off"}</small>
                        )}
                        {lightmapBakeJob.preset && <small>{lightmapBakeJob.preset} quality</small>}
                        {lightmapBakeJob.outputSceneUrl && <small>{lightmapBakeJob.outputSceneUrl}</small>}
                      </div>
                      <strong>{lightmapBakeJob.status}</strong>
                    </div>
                    {(lightmapBakeJob.status === "blocked" || lightmapBakeJob.status === "failed") && (
                      <div className="bake-failure-card">
                        <div>
                          <strong>{lightmapBakeJob.status === "blocked" ? "Bake blocked before output" : "Bake failed before output"}</strong>
                          <p>
                            {lightmapBakeJob.message ??
                              "The bake did not produce a usable lightmapped scene. Copy the report before changing settings."}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="button secondary compact-button"
                          onClick={() =>
                            void copyText(
                              lightmapBakeFailureReportText({
                                projectId: activeProjectId,
                                settings: bakeSettings,
                                preflightIssues: bakePreflightIssues,
                                blenderTool,
                                job: lightmapBakeJob
                              })
                            )
                          }
                        >
                          <Copy size={15} aria-hidden="true" />
                          Copy Failure Report
                        </button>
                      </div>
                    )}
                    {lightmapBakeJob.status === "completed" && (
                      <>
                        <div className="stat-grid compact-stat-grid">
                          <Stat label="Lightmaps" value={String(lightmapBakeJob.lightmapCount ?? lightmapBakeJob.lightmaps?.length ?? 0)} />
                          <Stat label="Total" value={formatBytes(lightmapBakeJob.totalLightmapBytes ?? 0)} />
                          <Stat label="Max px" value={String(lightmapBakeJob.resolution ?? bakeSettings.resolution)} />
                          <Stat label="Samples" value={String(lightmapBakeJob.samples ?? bakeSettings.samples)} />
                          <Stat label="Denoise" value={lightmapBakeJob.denoise === false ? "Off" : "On"} />
                        </div>
                        <LightmapBakeQuality job={lightmapBakeJob} materialCount={materialCountForBake} />
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="button secondary compact-button"
                            onClick={() =>
                              void copyText(
                                lightmapBakeQaReportText({
                                  projectId: activeProjectId,
                                  job: lightmapBakeJob,
                                  materialCount: materialCountForBake,
                                  viewerUrl: viewerUrl(activeProjectId)
                                })
                              )
                            }
                          >
                            <Copy size={15} aria-hidden="true" />
                            Copy Bake QA
                          </button>
                        </div>
                      </>
                    )}
                    {lightmapBakeJob.lightmaps && lightmapBakeJob.lightmaps.length > 0 && (
                      (() => {
                        const prioritizedLightmaps = prioritizeLightmapPreviews(lightmapBakeJob.lightmaps).slice(0, 12);
                        const reviewCount = (lightmapBakeJob.lightmaps ?? []).filter(
                          (lightmap) => lightmapPreviewQuality(lightmap) === "warning"
                        ).length;
                        return (
                          <div className="job-history-list">
                            <div className={reviewCount > 0 ? "lightmap-review-summary warning" : "lightmap-review-summary pass"}>
                              <strong>{reviewCount > 0 ? `${reviewCount} lightmap preview${reviewCount === 1 ? "" : "s"} need review` : "Lightmap previews look ready"}</strong>
                              <small>
                                {reviewCount > 0
                                  ? "Review items are shown first. Look for blank, tiny, blurry, or unexpectedly flat outputs before publishing."
                                  : "Still compare the viewer against the reference render before client delivery."}
                              </small>
                            </div>
                            {prioritizedLightmaps.map((lightmap) => {
                            const quality = lightmapPreviewQuality(lightmap);
                            const issue = lightmapPreviewIssue(lightmap);
                            return (
                              <div
                                key={`${lightmap.materialName}-${lightmap.url}`}
                                className={`job-history-row lightmap-row ${quality}`}
                              >
                                {canPreviewTextureAsset(lightmap.url) ? (
                                  <img src={projectAssetPath(activeProjectId, lightmap.url)} alt="" loading="lazy" />
                                ) : (
                                  <span className="lightmap-preview-placeholder">LM</span>
                                )}
                                <div>
                                  <strong>{lightmap.materialName}</strong>
                                  <span>{issue ?? lightmap.url}</span>
                                </div>
                                <small>
                                  <span className={`lightmap-quality-pill ${quality}`}>
                                    {quality === "warning" ? "Review" : "OK"}
                                  </span>
                                  {lightmap.resolution ? `${lightmap.resolution}px / ` : ""}
                                  {formatBytes(lightmap.bytes ?? 0)}
                                </small>
                                <button
                                  type="button"
                                  className="button secondary compact-button lightmap-review-button"
                                  onClick={() => reviewLightmapMaterial(lightmap.materialName)}
                                >
                                  Review Material
                                </button>
                              </div>
                            );
                            })}
                          </div>
                        );
                      })()
                    )}
                    {lightmapBakeJob.steps.map((step) => (
                      <div key={step.id} className={`job-step-row ${step.status}`}>
                        <div className="job-step-main">
                          <span>{step.label}</span>
                          {step.note && <small>{step.note}</small>}
                        </div>
                        <strong>{step.status}</strong>
                      </div>
                    ))}
                  </div>
                )}

                <div className="field-grid">
                  <label>
                    <span>Name</span>
                    <input
                      value={selectedMaterial.name}
                      onChange={(event) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          name: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Base Color</span>
                    <div className="color-control">
                      <input
                        type="color"
                        value={selectedMaterial.baseColor ?? "#ffffff"}
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => ({
                            ...material,
                            baseColor: event.target.value
                          }))
                        }
                      />
                      <input
                        value={selectedMaterial.baseColor ?? ""}
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => ({
                            ...material,
                            baseColor: event.target.value
                          }))
                        }
                      />
                    </div>
                  </label>
                </div>

                <div className="field-grid">
                  <NumberField
                    label="Roughness"
                    value={selectedMaterial.roughness ?? 0.5}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        roughness: value
                      }))
                    }
                  />
                  <NumberField
                    label="Metalness"
                    value={selectedMaterial.metalness ?? 0}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        metalness: value
                      }))
                    }
                  />
                  <NumberField
                    label="Opacity"
                    value={selectedMaterial.opacity ?? 1}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        opacity: value
                      }))
                    }
                  />
                </div>

                <div className="field-grid">
                  <label>
                    <span>Lightmap URL</span>
                    <input
                      value={selectedMaterial.lightMapUrl ?? ""}
                      placeholder="lightmaps/living-room.webp"
                      onChange={(event) =>
                        updateMaterial(selectedMaterial.id, (material) => {
                          const nextUrl = event.target.value.trim();
                          if (!nextUrl) {
                            const { lightMapUrl, ...rest } = material;
                            return rest;
                          }
                          return {
                            ...material,
                            lightMapUrl: nextUrl
                          };
                        })
                      }
                    />
                  </label>
                  <label className="file-inline-control">
                    <span>Upload Lightmap</span>
                    <input
                      type="file"
                      accept={materialTextureAccept}
                      disabled={!apiConnected || lightmapUploadState === "uploading"}
                      onChange={(event) =>
                        void uploadMaterialTexture(selectedMaterial.id, "lightMapUrl", event.target.files?.[0])
                      }
                    />
                    <strong>
                      {lightmapUploadState === "uploading" && "Uploading"}
                      {lightmapUploadState === "done" && "Uploaded"}
                      {lightmapUploadState === "error" && "Failed"}
                      {lightmapUploadState === "idle" && "Choose file"}
                    </strong>
                  </label>
                  <NumberField
                    label="Lightmap Intensity"
                    min={0}
                    max={8}
                    step={0.05}
                    value={selectedMaterial.lightMapIntensity ?? 1}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        lightMapIntensity: value
                      }))
                    }
                  />
                  <NumberField
                    label="Lightmap UV Set"
                    min={0}
                    max={3}
                    step={1}
                    value={selectedMaterial.lightMapUvSet ?? 1}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        lightMapUvSet: Math.max(0, Math.round(value))
                      }))
                    }
                  />
                </div>
                {lightmapUploadError && <p className="error-note">{lightmapUploadError}</p>}

                <div className="object-detail">
                  <h3>Texture Maps</h3>
                  <div className="texture-review-board" aria-label="Selected material texture review">
                    {selectedMaterialTextureReviewSteps.map((step) => (
                      <button
                        key={step.id}
                        type="button"
                        className={`texture-review-card ${step.status}`}
                        onClick={() => {
                          if (step.id === "lighting" && !selectedMaterial.lightMapUrl) {
                            openBakeWorkflow();
                            return;
                          }
                          if (step.id === "base" && !selectedMaterial.mapUrl && selectedMaterialTextureCandidates.length === 0) {
                            document.querySelector(".material-upload-fields")?.scrollIntoView({
                              behavior: "smooth",
                              block: "center"
                            });
                            return;
                          }
                          const targetSelector =
                            step.id === "base" && selectedMaterial.mapUrl
                              ? ".material-preview-strip"
                              : ".texture-candidate-panel";
                          document.querySelector(targetSelector)?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }}
                      >
                        <span>
                          {step.status === "ready" ? (
                            <Check size={15} aria-hidden="true" />
                          ) : step.status === "active" ? (
                            <Palette size={15} aria-hidden="true" />
                          ) : (
                            <AlertTriangle size={15} aria-hidden="true" />
                          )}
                        </span>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                        <em>{step.action}</em>
                      </button>
                    ))}
                  </div>
                  <div className="material-preview-strip">
                    {selectedMaterialTexturePreviews.length > 0 ? (
                      selectedMaterialTexturePreviews.map((preview) => (
                        <div key={preview.field} className="material-preview-tile">
                          {canPreviewTextureAsset(preview.source) ? (
                            <img src={projectAssetPath(activeProjectId, preview.source)} alt="" loading="lazy" />
                          ) : (
                            <span>{preview.label.slice(0, 2).toUpperCase()}</span>
                          )}
                          <strong>{preview.label}</strong>
                          <small>{preview.source}</small>
                        </div>
                      ))
                    ) : (
                      <p className="quiet-note">No texture maps are assigned to this material yet.</p>
                    )}
                  </div>
                  {selectedMaterialTextureCandidates.length > 0 && (
                    <div className="texture-candidate-panel">
                      <div className="surface-mapper-heading">
                        <strong>Loose texture candidates</strong>
                        <small>{selectedMaterialTextureCandidates.length}</small>
                      </div>
                      <div className="surface-candidate-list">
                        {selectedMaterialTextureCandidates.map((candidate) => {
                          const assignedField = materialTextureFields.find((field) => selectedMaterial[field] === candidate.source);
                          const isGenericTextureName = looseTextureNameLooksGeneric(candidate.source);
                          return (
                            <div
                              key={`${candidate.field}-${candidate.source}`}
                              className={assignedField ? "surface-candidate texture-candidate-card active" : "surface-candidate texture-candidate-card"}
                            >
                              {canPreviewTextureAsset(candidate.source) && (
                                <img
                                  className="texture-candidate-thumb"
                                  src={projectAssetPath(activeProjectId, candidate.source)}
                                  alt=""
                                  loading="lazy"
                                />
                              )}
                              <span>{candidate.source}</span>
                              <small>
                                Suggested: {materialTextureFieldLabels[candidate.field]} / {formatBytes(candidate.bytes)} /{" "}
                                {textureSuggestionConfidenceDetail(candidate.score)} / score {candidate.score}
                              </small>
                              {assignedField && (
                                <small className="texture-candidate-assigned">
                                  Assigned as {materialTextureFieldLabels[assignedField]}
                                </small>
                              )}
                              {isGenericTextureName && (
                                <small className="texture-candidate-warning">
                                  Generic embedded filename. Compare the preview before assigning.
                                </small>
                              )}
                              <div className="texture-candidate-actions" aria-label={`Assign ${candidate.source}`}>
                                {materialTextureFields.map((field) => (
                                  <button
                                    key={field}
                                    type="button"
                                    className={selectedMaterial[field] === candidate.source ? "active" : ""}
                                    onClick={() => applyMaterialTextureCandidate(selectedMaterial.id, candidate, field)}
                                  >
                                    {materialTextureFieldLabels[field].replace(" texture", "")}
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="field-grid material-upload-fields">
                    <label>
                      <span>Base Texture URL</span>
                      <input
                        value={selectedMaterial.mapUrl ?? ""}
                        placeholder="textures/wall-color.webp"
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => {
                            const nextUrl = event.target.value.trim();
                            if (!nextUrl) {
                              const { mapUrl, ...rest } = material;
                              return rest;
                            }
                            return {
                              ...material,
                              mapUrl: nextUrl
                            };
                          })
                        }
                      />
                    </label>
                    <label className="file-inline-control">
                      <span>Upload Base Texture</span>
                      <input
                        type="file"
                        accept={materialTextureAccept}
                        disabled={!apiConnected || lightmapUploadState === "uploading"}
                        onChange={(event) =>
                          void uploadMaterialTexture(selectedMaterial.id, "mapUrl", event.target.files?.[0])
                        }
                      />
                      <strong>
                        {lightmapUploadState === "uploading" && "Uploading"}
                        {lightmapUploadState === "done" && "Uploaded"}
                        {lightmapUploadState === "error" && "Failed"}
                        {lightmapUploadState === "idle" && "Choose file"}
                      </strong>
                    </label>
                    <label>
                      <span>Normal Map URL</span>
                      <input
                        value={selectedMaterial.normalMapUrl ?? ""}
                        placeholder="textures/wall-normal.webp"
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => {
                            const nextUrl = event.target.value.trim();
                            if (!nextUrl) {
                              const { normalMapUrl, ...rest } = material;
                              return rest;
                            }
                            return {
                              ...material,
                              normalMapUrl: nextUrl
                            };
                          })
                        }
                      />
                    </label>
                    <label className="file-inline-control">
                      <span>Upload Normal Map</span>
                      <input
                        type="file"
                        accept={materialTextureAccept}
                        disabled={!apiConnected || lightmapUploadState === "uploading"}
                        onChange={(event) =>
                          void uploadMaterialTexture(selectedMaterial.id, "normalMapUrl", event.target.files?.[0])
                        }
                      />
                      <strong>
                        {lightmapUploadState === "uploading" && "Uploading"}
                        {lightmapUploadState === "done" && "Uploaded"}
                        {lightmapUploadState === "error" && "Failed"}
                        {lightmapUploadState === "idle" && "Choose file"}
                      </strong>
                    </label>
                    <label>
                      <span>Emissive Map URL</span>
                      <input
                        value={selectedMaterial.emissiveMapUrl ?? ""}
                        placeholder="textures/screen-emissive.webp"
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => {
                            const nextUrl = event.target.value.trim();
                            if (!nextUrl) {
                              const { emissiveMapUrl, ...rest } = material;
                              return rest;
                            }
                            return {
                              ...material,
                              emissiveMapUrl: nextUrl
                            };
                          })
                        }
                      />
                    </label>
                    <label className="file-inline-control">
                      <span>Upload Emissive Map</span>
                      <input
                        type="file"
                        accept={materialTextureAccept}
                        disabled={!apiConnected || lightmapUploadState === "uploading"}
                        onChange={(event) =>
                          void uploadMaterialTexture(selectedMaterial.id, "emissiveMapUrl", event.target.files?.[0])
                        }
                      />
                      <strong>
                        {lightmapUploadState === "uploading" && "Uploading"}
                        {lightmapUploadState === "done" && "Uploaded"}
                        {lightmapUploadState === "error" && "Failed"}
                        {lightmapUploadState === "idle" && "Choose file"}
                      </strong>
                    </label>
                    <NumberField
                      label="Emissive Intensity"
                      min={0}
                      max={16}
                      step={0.05}
                      value={selectedMaterial.emissiveIntensity ?? 1}
                      onChange={(value) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          emissiveIntensity: value
                        }))
                      }
                    />
                    <NumberField
                      label="Repeat X"
                      min={0.01}
                      max={64}
                      step={0.05}
                      value={selectedMaterial.textureRepeat?.[0] ?? 1}
                      onChange={(value) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          textureRepeat: [
                            Number(Math.max(0.01, value).toFixed(3)),
                            material.textureRepeat?.[1] ?? 1
                          ]
                        }))
                      }
                    />
                    <NumberField
                      label="Repeat Y"
                      min={0.01}
                      max={64}
                      step={0.05}
                      value={selectedMaterial.textureRepeat?.[1] ?? 1}
                      onChange={(value) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          textureRepeat: [
                            material.textureRepeat?.[0] ?? 1,
                            Number(Math.max(0.01, value).toFixed(3))
                          ]
                        }))
                      }
                    />
                    <NumberField
                      label="Offset X"
                      min={-10}
                      max={10}
                      step={0.01}
                      value={selectedMaterial.textureOffset?.[0] ?? 0}
                      onChange={(value) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          textureOffset: [
                            Number(value.toFixed(3)),
                            material.textureOffset?.[1] ?? 0
                          ]
                        }))
                      }
                    />
                    <NumberField
                      label="Offset Y"
                      min={-10}
                      max={10}
                      step={0.01}
                      value={selectedMaterial.textureOffset?.[1] ?? 0}
                      onChange={(value) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          textureOffset: [
                            material.textureOffset?.[0] ?? 0,
                            Number(value.toFixed(3))
                          ]
                        }))
                      }
                    />
                    <NumberField
                      label="Texture Rotation"
                      min={-6.283}
                      max={6.283}
                      step={0.01}
                      value={selectedMaterial.textureRotation ?? 0}
                      onChange={(value) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          textureRotation: Number(value.toFixed(3))
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="object-detail">
                  <h3>Used By</h3>
                  <div className="chip-row">
                    {sceneGraph?.nodes
                      .filter((node) => node.materialIds.includes(selectedMaterial.id))
                      .slice(0, 12)
                      .map((node) => <span key={node.id}>{node.name}</span>)}
                    {sceneGraph?.nodes.filter((node) => node.materialIds.includes(selectedMaterial.id)).length ===
                      0 && <span>None</span>}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "variants" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Variant Sets</h2>
                <button
                  type="button"
                  className="icon-action"
                  title="Add variant set"
                  onClick={addMaterialVariantInteraction}
                >
                  <Plus size={17} aria-hidden="true" />
                </button>
              </div>
              {materialVariantInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedVariantInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedVariantInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>
                    {!interaction.targetMaterialName && !interaction.targetMeshName
                      ? "needs target"
                      : sceneGraph &&
                          ((interaction.targetMaterialName &&
                            !variantTargetKeys.materialNames.has(interaction.targetMaterialName)) ||
                            (interaction.targetMeshName && !variantTargetKeys.meshNames.has(interaction.targetMeshName)))
                        ? "target missing"
                        : interaction.variants.length === 0
                          ? "needs options"
                          : interaction.variants.some((variant) => !variant.color && !variant.texture?.trim())
                            ? "needs finish"
                            : interaction.variants.some((variant) => {
                                const texture = variant.texture?.trim() ?? "";
                                return (
                                  Boolean(texture) &&
                                  (texture.startsWith("generated://") ||
                                    missingVariantTextureSources.has(normalizeAssetReference(texture)))
                                );
                              })
                              ? "missing texture"
                              : "finish ready"}
                  </small>
                </button>
              ))}
              {materialVariantInteractions.length === 0 && (
                <p className="empty-list">No material variant sets configured.</p>
              )}
            </div>

            {!selectedVariantInteraction && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>Finish Options</h2>
                </div>
                <VisualGuideCard
                  title="Material finish setup"
                  detail="Create client-facing finish choices only after the base material looks correct."
                  steps={[
                    "Add a finish set for each editable sofa, wall, cabinet, fabric, or product surface.",
                    "Target a material or mesh, then add clear options with color swatches or texture previews.",
                    "Test the viewer so the client can switch finishes without breaking lighting or texture scale."
                  ]}
                  actionLabel="Add Set"
                  onAction={addMaterialVariantInteraction}
                  secondaryActionLabel="Materials"
                  onSecondaryAction={() => setSelectedTab("materials")}
                />
                <div className="variant-setup-board" aria-label="Variant setup health">
                  {variantSetupSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`variant-setup-card ${step.status}`}
                      disabled={step.status === "ready" || step.status === "active"}
                      onClick={addMaterialVariantInteraction}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : step.status === "active" ? (
                          <Palette size={15} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedVariantInteraction && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>{selectedVariantInteraction.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete variant set"
                    onClick={() => removeMaterialVariantInteraction(selectedVariantInteraction.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <VisualGuideCard
                  title="Material finish setup"
                  detail="Make finish choices visual and easy to test before publishing."
                  steps={[
                    "Target the real material or mesh users should be able to change.",
                    "Keep option labels client-friendly and use color swatches or texture URLs for each finish.",
                    "Open the viewer and confirm every option switches only the intended surface."
                  ]}
                  actionLabel="Add Option"
                  onAction={() => addMaterialVariantOption(selectedVariantInteraction.id)}
                  secondaryActionLabel="Materials"
                  onSecondaryAction={() => setSelectedTab("materials")}
                />

                <div className="variant-setup-board" aria-label="Variant setup health">
                  {variantSetupSteps.map((step) => (
                    <button
                      key={step.id}
                      type="button"
                      className={`variant-setup-card ${step.status}`}
                      disabled={step.status === "ready" || step.status === "active"}
                      onClick={() => {
                        if (step.id === "sets") {
                          addMaterialVariantInteraction();
                          return;
                        }
                        if (step.id === "targets") {
                          document.querySelector(".field-grid")?.scrollIntoView({ block: "center" });
                          return;
                        }
                        if (step.id === "options" || step.id === "colors" || step.id === "textures") {
                          addMaterialVariantOption(selectedVariantInteraction.id);
                        }
                      }}
                    >
                      <span>
                        {step.status === "ready" ? (
                          <Check size={15} aria-hidden="true" />
                        ) : step.status === "active" ? (
                          <Palette size={15} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={15} aria-hidden="true" />
                        )}
                      </span>
                      <strong>{step.label}</strong>
                      <small>{step.detail}</small>
                      <em>{step.action}</em>
                    </button>
                  ))}
                </div>

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedVariantInteraction.label}
                      onChange={(event) =>
                        updateMaterialVariantInteraction(selectedVariantInteraction.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Target Material</span>
                    <select
                      value={selectedVariantInteraction.targetMaterialName ?? ""}
                      onChange={(event) =>
                        updateMaterialVariantInteraction(selectedVariantInteraction.id, (interaction) => {
                          const { targetMeshName, ...rest } = interaction;
                          return {
                            ...rest,
                            targetMaterialName: event.target.value
                          };
                        })
                      }
                    >
                      <option value="">Select material</option>
                      {variantMaterialTargetOptions.map((materialName) => (
                        <option key={materialName} value={materialName}>
                          {materialName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Target Mesh</span>
                    <input
                      list="variant-mesh-targets"
                      value={selectedVariantInteraction.targetMeshName ?? ""}
                      onChange={(event) =>
                        updateMaterialVariantInteraction(selectedVariantInteraction.id, (interaction) => {
                          const { targetMeshName, ...rest } = interaction;
                          return event.target.value
                            ? { ...rest, targetMeshName: event.target.value }
                            : rest;
                        })
                      }
                    />
                    <datalist id="variant-mesh-targets">
                      {variantMeshTargetOptions.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                  </label>
                </div>
                {selectedVariantTargetState !== "ready" && (
                  <p className="error-note compact-note">
                    {selectedVariantTargetState === "missing"
                      ? "Choose the material or mesh this finish set should control before testing."
                      : "This finish target was not found in the current scene graph. Pick the material or mesh again after reimport."}
                  </p>
                )}

                <div className="variant-editor-list">
                  <div className="publish-row">
                    <span>Options</span>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => addMaterialVariantOption(selectedVariantInteraction.id)}
                    >
                      <Plus size={16} aria-hidden="true" />
                      Add
                    </button>
                  </div>

                  {selectedVariantInteraction.variants.map((variant) => {
                    const textureSource = variant.texture?.trim() ?? "";
                    const normalizedTextureSource = normalizeAssetReference(textureSource);
                    const isGeneratedTexture = textureSource.startsWith("generated://");
                    const isExternalTexture = isExternalAssetReference(textureSource);
                    const isMissingTexture =
                      Boolean(textureSource) &&
                      !isExternalTexture &&
                      missingVariantTextureSources.has(normalizedTextureSource);
                    const canPreviewTexture =
                      Boolean(textureSource) &&
                      !isGeneratedTexture &&
                      canPreviewTextureAsset(textureSource);
                    const previewStatus = !variant.color && !textureSource
                      ? "Needs color or texture"
                      : isGeneratedTexture
                        ? "Placeholder only"
                        : isMissingTexture
                          ? "Missing file"
                          : textureSource
                            ? canPreviewTexture
                              ? "Texture preview"
                              : isExternalTexture
                                ? "External texture"
                                : "Texture path"
                            : "Color swatch";
                    const previewTone = !variant.color && !textureSource
                      ? "warning"
                      : isGeneratedTexture || isMissingTexture
                        ? "error"
                        : "ready";
                    return (
                      <div key={variant.id} className="variant-editor-row">
                        <label>
                          <span>Label</span>
                          <input
                            value={variant.label}
                            onChange={(event) =>
                              updateMaterialVariantOption(
                                selectedVariantInteraction.id,
                                variant.id,
                                (current) => ({ ...current, label: event.target.value })
                              )
                            }
                          />
                        </label>
                        <label>
                          <span>Color</span>
                          <div className="color-control">
                            <input
                              type="color"
                              value={variant.color ?? "#ffffff"}
                              onChange={(event) =>
                                updateMaterialVariantOption(
                                  selectedVariantInteraction.id,
                                  variant.id,
                                  (current) => ({ ...current, color: event.target.value })
                                )
                              }
                            />
                            <input
                              value={variant.color ?? ""}
                              onChange={(event) =>
                                updateMaterialVariantOption(
                                  selectedVariantInteraction.id,
                                  variant.id,
                                  (current) => ({ ...current, color: event.target.value })
                                )
                              }
                            />
                          </div>
                        </label>
                        <div className={`variant-option-visual ${previewTone}`}>
                          {canPreviewTexture && !isExternalTexture ? (
                            <img src={projectAssetPath(activeProjectId, normalizedTextureSource)} alt="" loading="lazy" />
                          ) : canPreviewTexture && isExternalTexture ? (
                            <img src={textureSource} alt="" loading="lazy" />
                          ) : (
                            <span style={{ background: variant.color || undefined }}>
                              {textureSource ? "TX" : variant.color ? "CL" : "?"}
                            </span>
                          )}
                          <strong>{previewStatus}</strong>
                          <small>{textureSource || variant.color || "Add a visible swatch or texture."}</small>
                        </div>
                        <label className="variant-texture-control">
                          <span>Texture URL</span>
                          <input
                            value={variant.texture ?? ""}
                            placeholder="textures/finish-option.webp"
                            onChange={(event) =>
                              updateMaterialVariantOption(
                                selectedVariantInteraction.id,
                                variant.id,
                                (current) => {
                                  const texture = event.target.value.trim();
                                  if (!texture) {
                                    const { texture: _texture, ...rest } = current;
                                    return rest;
                                  }
                                  return { ...current, texture };
                                }
                              )
                            }
                          />
                          <input
                            type="file"
                            accept={materialTextureAccept}
                            disabled={!apiConnected || variantUploadState === "uploading"}
                            onChange={(event) =>
                              void uploadMaterialVariantTexture(
                                selectedVariantInteraction.id,
                                variant.id,
                                event.target.files?.[0]
                              )
                            }
                          />
                          <strong>
                            {variantUploadState === "uploading" && "Uploading texture"}
                            {variantUploadState === "done" && "Texture uploaded"}
                            {variantUploadState === "error" && "Upload failed"}
                            {variantUploadState === "idle" && "Upload texture"}
                          </strong>
                        </label>
                        <button
                          type="button"
                          className="icon-action danger"
                          title="Delete option"
                          onClick={() => removeMaterialVariantOption(selectedVariantInteraction.id, variant.id)}
                        >
                          <Trash2 size={17} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                  {variantUploadError && <p className="error-note compact-note">{variantUploadError}</p>}
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "objects" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Objects</h2>
                <small>{filteredObjectRows.length} / {sceneGraph?.nodes.length ?? 0}</small>
              </div>
              <VisualGuideCard
                className="compact"
                title="Object cleanup"
                detail="Use object roles when one mesh is confusing navigation, top view, or presentation."
                steps={[
                  "Hide ceiling-heavy or exterior-only objects from top view when they cover the plan.",
                  "Mark floors as Walk on, walls or furniture as Collision, and helper meshes as Ignore navigation.",
                  "Retest blocked clicks after changing any object role."
                ]}
                actionLabel="Save & Test"
                onAction={() => void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId))}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />
              <div className="object-setup-board" aria-label="Object setup health">
                {objectSetupSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`object-setup-card ${step.status}`}
                    disabled={step.status === "ready" && step.id !== "objects"}
                    onClick={() => {
                      setObjectSearchQuery("");
                      if (step.id === "objects") {
                        setObjectListFilter("all");
                        return;
                      }
                      if (step.id === "ceiling") {
                        if (objectFilterCounts.ceilingNeedsTopHidden > 0) {
                          hideCeilingCandidatesInTopView();
                        } else {
                          setObjectListFilter("ceiling");
                        }
                        return;
                      }
                      if (step.id === "top") {
                        setObjectListFilter(objectFilterCounts.ceilingNeedsTopHidden > 0 ? "ceiling" : "top-hidden");
                        return;
                      }
                      if (step.id === "roles") {
                        setObjectListFilter("roles");
                        return;
                      }
                      if (step.id === "hidden") {
                        setObjectListFilter("hidden");
                      }
                    }}
                  >
                    <span>
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.status === "active" ? (
                        <Layers3 size={15} aria-hidden="true" />
                      ) : (
                        <AlertTriangle size={15} aria-hidden="true" />
                      )}
                    </span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>
              <div className="object-review-tools">
                <label className="object-search-field">
                  <span>Find object</span>
                  <input
                    type="search"
                    value={objectSearchQuery}
                    placeholder="Search ceiling, roof, wall, mesh name..."
                    onChange={(event) => setObjectSearchQuery(event.target.value)}
                  />
                </label>
                <div className="object-filter-row" aria-label="Object filters">
                  {[
                    ["all", "All", objectFilterCounts.all],
                    ["ceiling", "Ceiling/Roof", objectFilterCounts.ceiling],
                    ["top-hidden", "Hidden in Top", objectFilterCounts.topHidden],
                    ["roles", "Movement Roles", objectFilterCounts.roles],
                    ["hidden", "Hidden", objectFilterCounts.hidden]
                  ].map(([id, label, count]) => (
                    <button
                      key={id}
                      type="button"
                      className={objectListFilter === id ? "object-filter-chip active" : "object-filter-chip"}
                      onClick={() => setObjectListFilter(id as ObjectListFilter)}
                    >
                      <span>{label}</span>
                      <strong>{count}</strong>
                    </button>
                  ))}
                </div>
                <div className="object-bulk-actions">
                  <button
                    type="button"
                    className="button secondary compact-button"
                    disabled={!objectsDoc || objectFilterCounts.ceilingNeedsTopHidden === 0}
                    onClick={hideCeilingCandidatesInTopView}
                  >
                    <EyeOff size={15} aria-hidden="true" />
                    Hide Ceiling in Top View
                  </button>
                  <small>
                    {objectFilterCounts.ceilingNeedsTopHidden > 0
                      ? `${objectFilterCounts.ceilingNeedsTopHidden} candidate${objectFilterCounts.ceilingNeedsTopHidden === 1 ? "" : "s"} still visible in top view.`
                      : objectFilterCounts.ceiling > 0
                        ? "Ceiling/roof candidates are already hidden in top view."
                        : "No ceiling/roof candidates detected by name."}
                  </small>
                </div>
                {objectReviewMessage && <p className="success-note compact-note">{objectReviewMessage}</p>}
              </div>
              {filteredObjectRows.map(({ node, override, isCeilingOrRoof, isHiddenInTopView }) => {
                return (
                  <div
                    key={node.id}
                    className={selectedObjectId === node.id ? "list-row active" : "list-row"}
                  >
                    <button type="button" className="list-row-main" onClick={() => setSelectedObjectId(node.id)}>
                      <span>{node.name}</span>
                      <small>
                        {node.triangleCount} triangles
                        {" - "}
                        {isCeilingOrRoof && !isHiddenInTopView
                          ? "needs top hide"
                          : override?.navigationBehavior && override.navigationBehavior !== "default"
                            ? "movement role"
                            : override?.visible === false
                              ? "hidden"
                              : isHiddenInTopView
                                ? "top hidden"
                                : "object ready"}
                      </small>
                      {(isCeilingOrRoof || isHiddenInTopView) && (
                        <span className={isHiddenInTopView ? "object-role-chip top-hidden" : "object-role-chip review"}>
                          {isHiddenInTopView ? "Top Hidden" : "Review Top"}
                        </span>
                      )}
                      {override?.navigationBehavior && override.navigationBehavior !== "default" && (
                        <span className={`object-role-chip ${override.navigationBehavior}`}>
                          {objectNavigationBehaviorLabel(override.navigationBehavior)}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="visibility-button"
                      title={override?.visible === false ? "Show object" : "Hide object"}
                      onClick={() =>
                        updateObject(node.id, (object) => ({
                          ...object,
                          visible: !object.visible
                        }), node.name)
                      }
                    >
                      {override?.visible === false ? (
                        <EyeOff size={16} aria-hidden="true" />
                      ) : (
                        <Eye size={16} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                );
              })}
              {sceneGraph && filteredObjectRows.length === 0 && (
                <p className="empty-list">No objects match this filter. Clear the search or switch back to All.</p>
              )}
              {!sceneGraph && <p className="empty-list">No scene graph generated.</p>}
            </div>

            {selectedObject && sceneGraph && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Layers3 size={18} aria-hidden="true" />
                  <h2>{selectedObject.name}</h2>
                </div>

                <div className="stat-grid">
                  <Stat label="Mesh" value={selectedObject.meshName ?? "None"} />
                  <Stat label="Triangles" value={String(selectedObject.triangleCount)} />
                  <Stat label="Vertices" value={String(selectedObject.vertexCount)} />
                  <Stat
                    label="Visible"
                    value={selectedObjectEditableOverride?.visible === false ? "Hidden" : "Visible"}
                  />
                  <Stat
                    label="Top View"
                    value={selectedObjectEditableOverride?.hideInTopView ? "Hidden" : "Visible"}
                  />
                  <Stat
                    label="Navigation"
                    value={objectNavigationBehaviorLabel(selectedObjectEditableOverride?.navigationBehavior)}
                  />
                </div>

                {selectedObjectEditableOverride && (
                  <div className="object-detail">
                    <h3>View Visibility</h3>
                    <div className="toggle-grid">
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={selectedObjectEditableOverride.hideInTopView === true}
                          onChange={(event) =>
                            updateObject(selectedObjectEditableOverride.id, (object) => ({
                              ...object,
                              hideInTopView: event.target.checked
                            }), selectedObject.name)
                          }
                        />
                        <span>Hide in top view</span>
                      </label>
                    </div>
                  </div>
                )}

                {selectedObjectEditableOverride && (
                  <div className="object-detail">
                    <h3>Navigation Behavior</h3>
                    <div className="object-role-decision-board" aria-label="Object movement role">
                      {(["default", "walk", "collision", "ignore"] as const).map((behavior) => {
                        const detail = objectNavigationBehaviorDetail(behavior);
                        const isActive = (selectedObjectEditableOverride.navigationBehavior ?? "default") === behavior;
                        return (
                          <button
                            key={behavior}
                            type="button"
                            className={isActive ? `object-role-decision active ${behavior}` : `object-role-decision ${behavior}`}
                            onClick={() =>
                              setObjectNavigationBehavior(selectedObjectEditableOverride.id, selectedObject.name, behavior)
                            }
                          >
                            <span>
                              {isActive ? (
                                <Check size={15} aria-hidden="true" />
                              ) : behavior === "collision" ? (
                                <AlertTriangle size={15} aria-hidden="true" />
                              ) : behavior === "ignore" ? (
                                <EyeOff size={15} aria-hidden="true" />
                              ) : (
                                <Layers3 size={15} aria-hidden="true" />
                              )}
                            </span>
                            <strong>{detail.title}</strong>
                            <small>{detail.detail}</small>
                            <em>{detail.action}</em>
                          </button>
                        );
                      })}
                    </div>
                    <label>
                      <span>Object role</span>
                      <select
                        value={selectedObjectEditableOverride.navigationBehavior ?? "default"}
                        onChange={(event) =>
                          setObjectNavigationBehavior(
                            selectedObjectEditableOverride.id,
                            selectedObject.name,
                            event.target.value as NonNullable<ObjectOverride["navigationBehavior"]>
                          )
                        }
                      >
                        <option value="default">Default detection</option>
                        <option value="walk">Walk on</option>
                        <option value="collision">Collision</option>
                        <option value="ignore">Ignore navigation</option>
                      </select>
                    </label>
                    <div className="object-role-test-card">
                      <span>After changing movement role</span>
                      <strong>Save and retry the exact blocked click</strong>
                      <button
                        type="button"
                        className="button secondary compact-button"
                        onClick={() => void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId))}
                      >
                        <Save size={15} aria-hidden="true" />
                        Save & Test Navigation
                      </button>
                    </div>
                  </div>
                )}

                <div className="object-detail">
                  <h3>Material Usage</h3>
                  <div className="chip-row">
                    {selectedObject.materialIds.map((materialId) => {
                      const material = sceneGraph.materials.find((item) => item.id === materialId);
                      return <span key={materialId}>{material?.name ?? materialId}</span>;
                    })}
                    {selectedObject.materialIds.length === 0 && <span>None</span>}
                  </div>
                </div>

                <div className="object-detail">
                  <h3>Bounds</h3>
                  {selectedObject.bounds ? (
                    <code>
                      min [{selectedObject.bounds.min.join(", ")}] max [{selectedObject.bounds.max.join(", ")}]
                    </code>
                  ) : (
                    <p className="quiet-note">No bounds available.</p>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "controls" && (
          <section className="content-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <Settings2 size={18} aria-hidden="true" />
                <h2>Movement Controls</h2>
              </div>

              <VisualGuideCard
                title="Navigation repair loop"
                detail="Keep movement fixes visual: make walkable surfaces, connect doorways, then test in the viewer."
                steps={[
                  "Run Auto Fix to create bounds, walk areas, door passes, and exterior blockers.",
                  "Use the zone map to paint a walk patch or door pass where the viewer says movement is blocked.",
                  "If the camera bobs over ridges or tiny walls, apply Ridge Safe before editing zones.",
                  "Retest with the navigation debug viewer and repeat only the failing doorway or room."
                ]}
                actionLabel={navigationQuickFix.button}
                onAction={runNavigationQuickFix}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />

              {controlsDoc ? (
                <>
                  <div className="movement-setup-board" aria-label="Movement setup health">
                    {movementSetupSteps.map((step) => (
                      <button
                        key={step.id}
                        type="button"
                        className={`movement-setup-card ${step.status}`}
                        disabled={step.status === "ready"}
                        onClick={() => {
                          if (step.id === "movement") {
                            updateControls((current) => ({
                              ...current,
                              movement: { ...current.movement, enabled: true }
                            }));
                            return;
                          }
                          if (step.id === "keyboard") {
                            updateControls((current) => ({
                              ...current,
                              movement: { ...current.movement, keyboard: true }
                            }));
                            return;
                          }
                          if (step.id === "click") {
                            if (!controlsDoc.movement.clickToMove) {
                              updateControls((current) => ({
                                ...current,
                                movement: { ...current.movement, clickToMove: true }
                              }));
                              return;
                            }
                            createWalkZonesFromViews();
                            return;
                          }
                          if (step.id === "look-wheel") {
                            updateControls((current) => ({
                              ...current,
                              movement: {
                                ...current.movement,
                                dragLook: true,
                                wheelMoveSpeed: Math.max(current.movement.wheelMoveSpeed ?? 0, 0.82)
                              }
                            }));
                            return;
                          }
                          if (step.id === "collision") {
                            if (!manifest.navigation.bounds) {
                              runNavigationQuickFix();
                              return;
                            }
                            applyMovementPreset("ridge-safe");
                          }
                        }}
                      >
                        <span>
                          {step.status === "ready" ? (
                            <Check size={15} aria-hidden="true" />
                          ) : (
                            <Settings2 size={15} aria-hidden="true" />
                          )}
                        </span>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                        <em>{step.action}</em>
                      </button>
                    ))}
                  </div>

                  <div className="toggle-grid">
                    {movementToggles.map(({ field, label }) => (
                      <label key={field} className="toggle-row">
                        <input
                          type="checkbox"
                          checked={controlsDoc.movement[field]}
                          onChange={(event) =>
                            updateControls((current) => ({
                              ...current,
                              movement: {
                                ...current.movement,
                                [field]: event.target.checked
                              }
                            }))
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="movement-preset-grid" aria-label="Movement presets">
                    {movementPresets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="movement-preset-button"
                        onClick={() => applyMovementPreset(preset.id)}
                      >
                        <strong>{preset.label}</strong>
                        <small>{preset.detail}</small>
                      </button>
                    ))}
                  </div>

                  <div className={`movement-comfort-card ${movementComfort.tone}`}>
                    <div>
                      <span>Current comfort</span>
                      <strong>{movementComfort.label}</strong>
                      <p>{movementComfort.detail}</p>
                    </div>
                    <ul>
                      {movementComfort.lines.slice(1, 8).map((line) => (
                        <li key={line}>{line.replace(/^- /, "")}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="movement-triage-board" aria-label="Movement symptom fixes">
                    {movementTriageSteps.map((step) => (
                      <button
                        key={step.id}
                        type="button"
                        className={`movement-triage-card ${step.status}`}
                        onClick={() => {
                          if (step.id === "bounce") {
                            applyMovementPreset("ridge-safe");
                            return;
                          }
                          if (step.id === "door") {
                            if (navigationIssues.some((issue) => issue.id.startsWith("narrow-pass-"))) {
                              widenNarrowPassZones();
                              return;
                            }
                            openNavigationPaintTool("pass");
                            return;
                          }
                          if (step.id === "levels") {
                            applyMovementPreset("steps");
                            return;
                          }
                          if (step.id === "wheel") {
                            updateControls((current) => ({
                              ...current,
                              movement: {
                                ...current.movement,
                                dragLook: true,
                                wheelMoveSpeed: Math.max(current.movement.wheelMoveSpeed ?? 0, 0.82)
                              }
                            }));
                          }
                        }}
                      >
                        <span>
                          {step.status === "ready" ? (
                            <Check size={15} aria-hidden="true" />
                          ) : (
                            <Wrench size={15} aria-hidden="true" />
                          )}
                        </span>
                        <strong>{step.label}</strong>
                        <small>{step.detail}</small>
                        <em>{step.action}</em>
                      </button>
                    ))}
                  </div>

                  <div className="field-grid">
                    <NumberField
                      label="Camera Height"
                      min={0.8}
                      max={2.4}
                      step={0.05}
                      value={manifest.navigation.cameraHeight}
                      onChange={(value) =>
                        updateNavigation((navigation) => ({
                          ...navigation,
                          cameraHeight: value
                        }))
                      }
                    />
                    <NumberField
                      label="Move Speed"
                      min={0.5}
                      max={12}
                      step={0.1}
                      value={controlsDoc.movement.moveSpeed}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, moveSpeed: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Body Radius"
                      min={0.12}
                      max={0.6}
                      step={0.01}
                      value={controlsDoc.movement.collisionRadius ?? 0.28}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, collisionRadius: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Click Glide"
                      min={0.4}
                      max={6}
                      step={0.1}
                      value={controlsDoc.movement.clickMoveSpeed ?? 1.05}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, clickMoveSpeed: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Wheel Glide"
                      min={0.1}
                      max={4}
                      step={0.05}
                      value={controlsDoc.movement.wheelMoveSpeed ?? 1}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, wheelMoveSpeed: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Step Up"
                      min={0.05}
                      max={1.2}
                      step={0.01}
                      value={controlsDoc.movement.maxStepUp ?? 0.38}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, maxStepUp: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Step Down"
                      min={0.05}
                      max={2}
                      step={0.01}
                      value={controlsDoc.movement.maxStepDown ?? 0.72}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, maxStepDown: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Height Glide"
                      min={0.5}
                      max={8}
                      step={0.05}
                      value={controlsDoc.movement.floorHeightSmoothing ?? 0.9}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, floorHeightSmoothing: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Floor Bump Ignore"
                      min={0.02}
                      max={0.8}
                      step={0.01}
                      value={controlsDoc.movement.floorBumpTolerance ?? 0.48}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, floorBumpTolerance: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Horizontal Look"
                      min={0.001}
                      max={0.02}
                      step={0.001}
                      value={controlsDoc.movement.lookSensitivityX}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, lookSensitivityX: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Vertical Look"
                      min={0.001}
                      max={0.02}
                      step={0.001}
                      value={controlsDoc.movement.lookSensitivityY}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, lookSensitivityY: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Click Threshold"
                      min={2}
                      max={24}
                      step={1}
                      value={controlsDoc.movement.clickMoveThresholdPx}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, clickMoveThresholdPx: value }
                        }))
                      }
                    />
                  </div>

                  <div className="repair-panel">
                    <div className="panel-heading compact-heading">
                      <Wrench size={18} aria-hidden="true" />
                      <h2>Navigation Repair</h2>
                    </div>
                    <div className="navigation-guide-card">
                      <div>
                        <strong>Guided setup</strong>
                        <p>
                          Start with Auto Fix, then test the viewer. If a doorway blocks movement, use Fix in Studio
                          from the viewer and apply the recommended repair here.
                        </p>
                      </div>
                      <div className={`navigation-quick-fix ${primaryNavigationIssue?.severity ?? "info"}`}>
                        <div>
                          <span>Next fix</span>
                          <strong>{navigationQuickFix.title}</strong>
                          <p>{navigationQuickFix.detail}</p>
                        </div>
                        <button type="button" className="button primary" onClick={runNavigationQuickFix}>
                          {navigationQuickFix.action === "test" ? (
                            <ExternalLink size={16} aria-hidden="true" />
                          ) : navigationQuickFix.action === "paint-walk" ||
                            navigationQuickFix.action === "paint-pass" ||
                            navigationQuickFix.action === "review-zones" ? (
                            <MapPin size={16} aria-hidden="true" />
                          ) : (
                            <Wrench size={16} aria-hidden="true" />
                          )}
                          {navigationQuickFix.button}
                        </button>
                      </div>
                      <div className="navigation-guide-actions">
                        <button
                          type="button"
                          className="button primary"
                          disabled={!sceneGraph && !manifest.navigation.bounds && manifest.views.filter((view) => view.kind === "walk").length === 0}
                          onClick={autoRepairNavigation}
                        >
                          <Wrench size={16} aria-hidden="true" />
                          Auto Fix
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() =>
                            void copyText(
                              navigationQaBriefText({
                                projectId: activeProjectId,
                                manifest,
                                controls: controlsDoc,
                                coverage: navigationCoverageSummary,
                                issues: navigationIssues,
                                repairDraft: navigationRepairDraft,
                                quickFix: navigationQuickFix,
                                navigationViewerUrl: navigationDebugViewerUrl(activeProjectId)
                              })
                            )
                          }
                        >
                          <Copy size={16} aria-hidden="true" />
                          Copy QA
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId))}
                        >
                          <Save size={16} aria-hidden="true" />
                          Test
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!navigationRepairDraft?.point}
                          onClick={() => addNavigationRepairZone("pass")}
                        >
                          <Plus size={16} aria-hidden="true" />
                          Door Pass
                        </button>
                      </div>
                      {navigationCoverageSummary && (
                        <div className="navigation-guide-summary">
                          <span>{navigationCoverageSummary.walkZones} walk area(s)</span>
                          <span>{navigationCoverageSummary.passZones} door pass(es)</span>
                          <span>{navigationCoverageSummary.routeComponents} route island(s)</span>
                        </div>
                      )}
                      <div className="navigation-doorway-board" aria-label="Doorway navigation health">
                        {doorwayNavigationSteps.map((step) => (
                          <button
                            key={step.id}
                            type="button"
                            className={`navigation-doorway-card ${step.status}`}
                            disabled={!step.issue}
                            onClick={() => step.issue && runNavigationQuickFixAction(navigationQuickFixForIssue(step.issue))}
                          >
                            <span>{step.status === "ready" ? <Check size={15} aria-hidden="true" /> : <MapPin size={15} aria-hidden="true" />}</span>
                            <strong>{step.label}</strong>
                            <small>{step.detail}</small>
                            <em>{step.action}</em>
                          </button>
                        ))}
                      </div>
                      {navigationRepairPathSteps.length > 0 && (
                        <div className="navigation-repair-path" aria-label="Navigation repair path">
                          {navigationRepairPathSteps.map((step) => (
                            <div key={step.id} className={`navigation-path-step ${step.status}`}>
                              <div className="navigation-path-marker" aria-hidden="true">
                                {step.status === "done" ? "OK" : step.status === "active" ? "!" : ""}
                              </div>
                              <div>
                                <strong>{step.label}</strong>
                                <p>{step.detail}</p>
                              </div>
                              {step.quickFix && step.status !== "done" && (
                                <button
                                  type="button"
                                  className={step.status === "active" ? "button primary compact-button" : "button secondary compact-button"}
                                  disabled={step.status === "pending"}
                                  onClick={() => runNavigationQuickFixAction(step.quickFix!)}
                                >
                                  {step.quickFix.action === "test" ? (
                                    <ExternalLink size={15} aria-hidden="true" />
                                  ) : step.quickFix.action === "paint-walk" ||
                                    step.quickFix.action === "paint-pass" ||
                                    step.quickFix.action === "review-zones" ? (
                                    <MapPin size={15} aria-hidden="true" />
                                  ) : (
                                    <Wrench size={15} aria-hidden="true" />
                                  )}
                                  {step.quickFix.button}
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {navigationRepairDraft && (
                      <div className="repair-card">
                        <div className="repair-card-heading">
                          <div>
                            <span>Viewer repair</span>
                            <strong>{repairRecommendation?.title ?? "Navigation needs a repair"}</strong>
                            <div className="repair-source-pill">
                              Viewer recommended: {navigationRepairActionLabel(navigationRepairDraft.action)}
                            </div>
                            <p>
                              {navigationRepairDraft.hint ||
                                "Choose the action that matches the clicked area, then save and retry the viewer."}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="button secondary compact-button"
                            onClick={() => setNavigationRepairDraft(null)}
                          >
                            Dismiss
                          </button>
                        </div>
                        {repairDiagnosis && (
                          <div className="repair-diagnosis">
                            <div>
                              <strong>{repairDiagnosis.title}</strong>
                              <p>{repairDiagnosis.detail}</p>
                            </div>
                            <ul>
                              {repairDiagnosis.checks.map((check) => (
                                <li key={check}>{check}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {repairRecommendation && (
                          <div className="repair-recommendation">
                            <div>
                              <strong>Recommended</strong>
                              <p>{repairRecommendation.detail}</p>
                              {viewerRepairCanBridgeIslands && (
                                <small>
                                  Studio detected {navigationCoverageSummary?.routeComponents} disconnected route islands. Auto Bridge can add a connector when the nearest islands are close enough.
                                </small>
                              )}
                            </div>
                            <button
                              type="button"
                              className="button primary"
                              disabled={
                                (repairRecommendation.requiresPoint && !navigationRepairDraft.point) ||
                                (repairRecommendation.requiresBlocker && !navigationRepairDraft.blockerName)
                              }
                              onClick={applyNavigationRepairRecommendation}
                            >
                              <Wrench size={16} aria-hidden="true" />
                              {repairRecommendation.primaryLabel}
                            </button>
                          </div>
                        )}
                        <div className="repair-playbook" aria-label="Simple repair steps">
                          {navigationRepairPlanSteps(navigationRepairDraft, repairRecommendation).map((step) => (
                            <div key={step.badge} className="repair-playbook-step">
                              <span aria-hidden="true">{step.badge}</span>
                              <div>
                                <strong>{step.title}</strong>
                                <p>{step.detail}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="repair-action-grid" aria-label="Navigation repair actions">
                          {viewerRepairCanBridgeIslands && (
                            <button
                              type="button"
                              className="repair-action-button primary-action"
                              onClick={createBridgePassZones}
                            >
                              <span>Split Route Islands</span>
                              <strong>Auto Bridge</strong>
                              <small>Try this first when the clicked room is in a nearby disconnected walk area.</small>
                            </button>
                          )}
                          <button
                            type="button"
                            className={viewerRepairCanBridgeIslands ? "repair-action-button" : "repair-action-button primary-action"}
                            disabled={!navigationRepairDraft.point}
                            onClick={() => addNavigationRepairZone("pass")}
                          >
                            <span>Open Doorway</span>
                            <strong>Add Door Pass</strong>
                            <small>Connect the current area to the clicked room through a door or opening.</small>
                          </button>
                          <button
                            type="button"
                            className="repair-action-button"
                            disabled={!navigationRepairDraft.point}
                            onClick={() => addNavigationRepairZone("walk")}
                          >
                            <span>Add Floor Area</span>
                            <strong>Walk Patch</strong>
                            <small>Allow users to stand on the clicked floor when it was not detected.</small>
                          </button>
                          <button
                            type="button"
                            className="repair-action-button"
                            disabled={!navigationRepairDraft.blockerName}
                            onClick={() => ignoreCollisionName(navigationRepairDraft.blockerName)}
                          >
                            <span>Ignore Object</span>
                            <strong>Not A Wall</strong>
                            <small>Use this only when the detected blocker should not stop movement.</small>
                          </button>
                          {narrowBodyRepairRadius && (
                            <button
                              type="button"
                              className="repair-action-button"
                              onClick={applyNarrowBodyRepair}
                            >
                              <span>Narrow Opening</span>
                              <strong>Body {narrowBodyRepairRadius.toFixed(2)}</strong>
                              <small>Try this when a real doorway is valid but the camera body is too wide.</small>
                            </button>
                          )}
                          <button
                            type="button"
                            className="repair-action-button"
                            onClick={() =>
                              applyMovementPreset(
                                "steps",
                                "Applied the Steps movement preset for thresholds and stairs. Save changes, then retry the click in the viewer."
                              )
                            }
                          >
                            <span>Tune Movement</span>
                            <strong>Apply Steps Preset</strong>
                            <small>Use this when the route crosses thresholds, stairs, or level changes.</small>
                          </button>
                        </div>
                        {navigationRepairObjectMatch && (
                          <div className="repair-object-card">
                            <div>
                              <strong>Matched model object</strong>
                              <p>
                                {navigationRepairObjectMatch.object.name} is the likely object involved in this failed click.
                                Choose whether it should be walkable, blocking, or ignored instead of editing coordinates.
                              </p>
                              <small>
                                Current role:{" "}
                                {objectNavigationBehaviorLabel(
                                  navigationRepairObjectMatch.object.navigationBehavior
                                )}
                              </small>
                            </div>
                            <div className="inline-actions">
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => setNavigationRepairObjectBehavior("ignore")}
                              >
                                Ignore Object
                              </button>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => setNavigationRepairObjectBehavior("walk")}
                              >
                                Make Walkable
                              </button>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => setNavigationRepairObjectBehavior("collision")}
                              >
                                Keep As Wall
                              </button>
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => {
                                  setSelectedObjectId(navigationRepairObjectMatch.object.id);
                                  openStudioVisualTarget("objects", ".object-review-tools, .object-detail");
                                }}
                              >
                                Review Object
                              </button>
                            </div>
                          </div>
                        )}
                        {navigationRepairDraft.objectName && !navigationRepairObjectMatch && (
                          <div className="repair-object-card">
                            <div>
                              <strong>Clicked object needs review</strong>
                              <p>
                                Studio could not automatically match {navigationRepairDraft.objectName} to a saved object
                                override. Review Objects with this name prefilled, then choose whether it should be ignored,
                                walkable, or a wall.
                              </p>
                            </div>
                            <div className="inline-actions">
                              <button
                                type="button"
                                className="button secondary"
                                onClick={() => {
                                  setObjectSearchQuery(navigationRepairDraft.objectName ?? "");
                                  setObjectListFilter("all");
                                  openStudioVisualTarget("objects", ".object-setup-board, .object-review-tools");
                                }}
                              >
                                Review Object
                              </button>
                            </div>
                          </div>
                        )}
                        <details className="repair-debug-details">
                          <summary>Technical details</summary>
                          <dl className="repair-details">
                            <div>
                              <dt>Reason</dt>
                              <dd>{navigationRepairDraft.reason || "Unknown"}</dd>
                            </div>
                            {navigationRepairDraft.blockerName && (
                              <div>
                                <dt>Blocker</dt>
                                <dd>{navigationRepairDraft.blockerName}</dd>
                              </div>
                            )}
                            {navigationRepairDraft.objectName && (
                              <div>
                                <dt>Clicked Object</dt>
                                <dd>{navigationRepairDraft.objectName}</dd>
                              </div>
                            )}
                            {navigationRepairDraft.blockerKind && (
                              <div>
                                <dt>Blocker Type</dt>
                                <dd>{navigationRepairDraft.blockerKind}</dd>
                              </div>
                            )}
                            {navigationRepairDraft.action && (
                              <div>
                                <dt>Suggested Action</dt>
                                <dd>{navigationRepairDraft.action.replace(/-/g, " ")}</dd>
                              </div>
                            )}
                            {navigationRepairDraft.point && (
                              <div>
                                <dt>Point</dt>
                                <dd>{navigationRepairDraft.point.map((value) => value.toFixed(2)).join(", ")}</dd>
                              </div>
                            )}
                            {navigationRepairDraft.target && (
                              <div>
                                <dt>Target</dt>
                                <dd>{navigationRepairDraft.target.map((value) => value.toFixed(2)).join(", ")}</dd>
                              </div>
                            )}
                            {navigationRepairDraft.from && (
                              <div>
                                <dt>From</dt>
                                <dd>{navigationRepairDraft.from.map((value) => value.toFixed(2)).join(", ")}</dd>
                              </div>
                            )}
                            {typeof navigationRepairDraft.bodyRadius === "number" && (
                              <div>
                                <dt>Body Radius</dt>
                                <dd>{navigationRepairDraft.bodyRadius.toFixed(2)}</dd>
                              </div>
                            )}
                          </dl>
                        </details>
                      </div>
                    )}
                    <div className="navigation-qa-list" aria-label="Navigation QA">
                      {navigationIssues.map((issue) => {
                        const issueFix = navigationQuickFixForIssue(issue);
                        const focusedIssue = highlightedNavigationIssueId === issue.id;
                        return (
                          <div
                            key={issue.id}
                            className={`navigation-qa-card ${issue.severity}${focusedIssue ? " focused" : ""}`}
                          >
                            <div>
                              <strong>{issue.title}</strong>
                              <p>{issue.detail}</p>
                              {issue.action && <small>{issue.action}</small>}
                            </div>
                            {issue.severity !== "info" && (
                              <button
                                type="button"
                                className="button secondary compact-button"
                                onClick={() => runNavigationQuickFixAction(issueFix)}
                              >
                                {issueFix.action === "test" ? (
                                  <ExternalLink size={16} aria-hidden="true" />
                                ) : issueFix.action === "paint-walk" ||
                                  issueFix.action === "paint-pass" ||
                                  issueFix.action === "widen-pass" ||
                                  issueFix.action === "review-zones" ? (
                                  <MapPin size={16} aria-hidden="true" />
                                ) : (
                                  <Wrench size={16} aria-hidden="true" />
                                )}
                                {issueFix.button}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {navigationCoverageSummary && (
                      <div className="navigation-coverage-grid" aria-label="Navigation coverage summary">
                        <div className="navigation-coverage-card">
                          <span>Walk</span>
                          <strong>{navigationCoverageSummary.walkZones}</strong>
                        </div>
                        <div className="navigation-coverage-card">
                          <span>Pass</span>
                          <strong>{navigationCoverageSummary.passZones}</strong>
                        </div>
                        <div className="navigation-coverage-card">
                          <span>Block</span>
                          <strong>{navigationCoverageSummary.blockZones}</strong>
                        </div>
                        <div
                          className={
                            navigationCoverageSummary.routeComponents > 1
                              ? "navigation-coverage-card warn"
                              : "navigation-coverage-card"
                          }
                        >
                          <span>Islands</span>
                          <strong>{navigationCoverageSummary.routeComponents}</strong>
                        </div>
                        <div
                          className={
                            navigationCoverageSummary.walkViews > navigationCoverageSummary.coveredWalkViews
                              ? "navigation-coverage-card warn wide"
                              : "navigation-coverage-card wide"
                          }
                        >
                          <span>Views covered by zones</span>
                          <strong>
                            {navigationCoverageSummary.coveredWalkViews}/{navigationCoverageSummary.walkViews}
                          </strong>
                        </div>
                      </div>
                    )}
                    <div className="publish-action-card">
                      <div>
                        <strong>Regenerate navigation from model</strong>
                        <p className="quiet-note">
                          Re-analyze the active GLB/GLTF and rebuild views, rooms, bounds, walk zones, and pass zones.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!apiConnected || repairState === "repairing"}
                        onClick={() => void repairImport()}
                      >
                        <Wrench size={16} aria-hidden="true" />
                        {repairState === "repairing" ? "Regenerating" : "Regenerate"}
                      </button>
                    </div>
                    {repairError && <p className="error-note">{repairError}</p>}
                    {repairSummary && (
                      <div className="repair-followup">
                        <p>{repairSummary}</p>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="button primary"
                            disabled={!apiConnected}
                            onClick={() => void persistDraft()}
                          >
                            <Save size={16} aria-hidden="true" />
                            Save Changes
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId))}
                          >
                            <Save size={16} aria-hidden="true" />
                            Retry Viewer
                          </button>
                        </div>
                      </div>
                    )}
                    <details className="navigation-advanced-settings">
                      <summary>
                        <span>Advanced navigation settings</span>
                        <small>Model scale, detection keywords, exact bounds, and blocker-name tools.</small>
                      </summary>
                      <div className="field-grid">
                        <NumberField
                          label="Model Scale"
                          min={0.0001}
                          max={10}
                          step={0.001}
                          value={manifest.rendering?.modelScale ?? 1}
                          onChange={(value) =>
                            updateRendering((rendering) => ({
                              ...rendering,
                              modelScale: value
                            }))
                          }
                        />
                        <NumberField
                          label="Model Offset X"
                          min={-100000}
                          max={100000}
                          step={0.01}
                          value={manifest.rendering?.modelOffset?.[0] ?? 0}
                          onChange={(value) =>
                            updateRendering((rendering) => {
                              const current = rendering.modelOffset ?? [0, 0, 0];
                              return {
                                ...rendering,
                                modelOffset: [value, current[1] ?? 0, current[2] ?? 0] as Vec3
                              };
                            })
                          }
                        />
                        <NumberField
                          label="Model Offset Y"
                          min={-100000}
                          max={100000}
                          step={0.01}
                          value={manifest.rendering?.modelOffset?.[1] ?? 0}
                          onChange={(value) =>
                            updateRendering((rendering) => {
                              const current = rendering.modelOffset ?? [0, 0, 0];
                              return {
                                ...rendering,
                                modelOffset: [current[0] ?? 0, value, current[2] ?? 0] as Vec3
                              };
                            })
                          }
                        />
                        <NumberField
                          label="Model Offset Z"
                          min={-100000}
                          max={100000}
                          step={0.01}
                          value={manifest.rendering?.modelOffset?.[2] ?? 0}
                          onChange={(value) =>
                            updateRendering((rendering) => {
                              const current = rendering.modelOffset ?? [0, 0, 0];
                              return {
                                ...rendering,
                                modelOffset: [current[0] ?? 0, current[1] ?? 0, value] as Vec3
                              };
                            })
                          }
                        />
                        <div className="model-offset-note">
                          <div>
                            <strong>Runtime model offset</strong>
                            <p>
                              Import Repair uses this to recenter far-away source models without rewriting the GLB. Reset it only if the model was fixed in the source file.
                            </p>
                          </div>
                          <button
                            type="button"
                            className="button secondary compact-button"
                            disabled={!manifest.rendering?.modelOffset?.some((value) => Math.abs(value) > 0.01)}
                            onClick={() =>
                              updateRendering((rendering) => {
                                const { modelOffset: _modelOffset, ...nextRendering } = rendering;
                                return nextRendering;
                              })
                            }
                          >
                            <RotateCcw size={15} aria-hidden="true" />
                            Reset Offset
                          </button>
                        </div>
                        <label className="toggle-row compact-toggle">
                          <input
                            type="checkbox"
                            checked={manifest.rendering?.doubleSidedMaterials ?? false}
                            onChange={(event) =>
                              updateRendering((rendering) => ({
                                ...rendering,
                                doubleSidedMaterials: event.target.checked
                              }))
                            }
                          />
                          <span>Double-sided walls and ceilings</span>
                        </label>
                        <label className="toggle-row compact-toggle">
                          <input
                            type="checkbox"
                            checked={manifest.rendering?.relightUnlitMaterials ?? true}
                            onChange={(event) =>
                              updateRendering((rendering) => ({
                                ...rendering,
                                relightUnlitMaterials: event.target.checked
                              }))
                            }
                          />
                          <span>Relight flat/unlit materials</span>
                        </label>
                        <label>
                          <span>Tone Mapping</span>
                          <select
                            value={manifest.rendering?.toneMapping ?? "aces"}
                            onChange={(event) => {
                              const toneMapping = event.target.value as "none" | "linear" | "reinhard" | "cineon" | "aces";
                              updateRendering((rendering) => ({
                                ...rendering,
                                toneMapping
                              }));
                            }}
                          >
                            <option value="aces">ACES cinematic</option>
                            <option value="linear">Linear match</option>
                            <option value="reinhard">Reinhard soft</option>
                            <option value="cineon">Cineon filmic</option>
                            <option value="none">None/raw</option>
                          </select>
                        </label>
                        <NumberField
                          label="Exposure"
                          min={0.1}
                          max={4}
                          step={0.05}
                          value={manifest.rendering?.exposure ?? 1.05}
                          onChange={(value) =>
                            updateRendering((rendering) => ({
                              ...rendering,
                              exposure: value
                            }))
                          }
                        />
                        <label>
                          <span>Floor Keywords</span>
                          <input
                            value={keywordList(manifest.navigation.floorMeshNames)}
                            onChange={(event) =>
                              updateNavigation((navigation) => ({
                                ...navigation,
                                floorMeshNames: parseKeywordList(event.target.value)
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Collision Keywords</span>
                          <input
                            value={keywordList(manifest.navigation.collisionMeshNames)}
                            onChange={(event) =>
                              updateNavigation((navigation) => ({
                                ...navigation,
                                collisionMeshNames: parseKeywordList(event.target.value)
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Ignored Collision Names</span>
                          <input
                            value={keywordList(manifest.navigation.ignoredCollisionMeshNames)}
                            onChange={(event) =>
                              updateNavigation((navigation) => ({
                                ...navigation,
                                ignoredCollisionMeshNames: parseKeywordList(event.target.value)
                              }))
                            }
                          />
                        </label>
                      </div>

                      <div className="publish-row">
                        <span>Navigation bounds</span>
                        <button type="button" className="button secondary" onClick={applyBoundsFromGraph}>
                          <Wrench size={16} aria-hidden="true" />
                          Use graph bounds
                        </button>
                      </div>
                      {manifest.navigation.bounds ? (
                        <div className="bounds-editor">
                          <VectorEditor
                            label="Bounds Min"
                            value={manifest.navigation.bounds.min}
                            onChange={(value) =>
                              updateNavigation((navigation) => ({
                                ...navigation,
                                bounds: {
                                  min: value,
                                  max: navigation.bounds?.max ?? [5, 3, 5]
                                }
                              }))
                            }
                          />
                          <VectorEditor
                            label="Bounds Max"
                            value={manifest.navigation.bounds.max}
                            onChange={(value) =>
                              updateNavigation((navigation) => ({
                                ...navigation,
                                bounds: {
                                  min: navigation.bounds?.min ?? [-5, 0, -5],
                                  max: value
                                }
                              }))
                            }
                          />
                        </div>
                      ) : (
                        <p className="quiet-note">No navigation bounds are set. Use graph bounds after analysis.</p>
                      )}

                      <div className="publish-action-card">
                        <div>
                          <strong>Ignore blocker from viewer</strong>
                          <p className="quiet-note">
                            Paste the blocker name shown by Navigation blocked, or use Fix in Studio from the viewer.
                          </p>
                        </div>
                        <div className="inline-actions">
                          <input
                            className="compact-input"
                            value={blockerNameDraft}
                            placeholder="Wall_012 or DoorFrame"
                            onChange={(event) => setBlockerNameDraft(event.target.value)}
                          />
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!blockerNameDraft.trim()}
                            onClick={() => ignoreCollisionName(blockerNameDraft)}
                          >
                            Ignore
                          </button>
                        </div>
                      </div>

                      {collisionNameCandidates.length > 0 && (
                        <div className="collision-ignore-panel">
                          <div className="surface-mapper-heading">
                            <strong>Collision candidates</strong>
                            <small>{collisionNameCandidates.length}</small>
                          </div>
                          <div className="collision-candidate-list">
                            {collisionNameCandidates.map((node) => (
                              <button
                                key={node.id}
                                type="button"
                                className="collision-candidate"
                                title={`Ignore ${node.name} for navigation collision`}
                                onClick={() => ignoreCollisionName(node.name)}
                              >
                                <span>{node.name}</span>
                                <small>{node.triangleCount} triangles</small>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {doorPassCandidates.length > 0 && (
                        <div className="collision-ignore-panel">
                          <div className="surface-mapper-heading">
                            <strong>Door/pass candidates</strong>
                            <small>{doorPassCandidates.length}</small>
                          </div>
                          <div className="collision-candidate-list">
                            {doorPassCandidates.map((candidate) => (
                              <button
                                key={candidate.id}
                                type="button"
                                className="collision-candidate pass-candidate"
                                title={`Create a pass zone at ${candidate.name}`}
                                onClick={() => addPassZoneFromCandidate(candidate)}
                              >
                                <span>{candidate.name}</span>
                                <small>
                                  {candidate.center.map((value) => value.toFixed(2)).join(", ")}
                                </small>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </details>

                    <div className="publish-row">
                      <span>Navigation zones</span>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => void saveAndOpenViewer(navigationDebugViewerUrl(activeProjectId))}
                        >
                          <Save size={16} aria-hidden="true" />
                          Preview
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => addNavigationZone("walk")}
                        >
                          <Plus size={16} aria-hidden="true" />
                          Walk
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={manifest.views.filter((view) => view.kind === "walk").length === 0}
                          onClick={createWalkZonesFromViews}
                        >
                          <Wrench size={16} aria-hidden="true" />
                          View Walks
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={(manifest.navigation.zones ?? []).filter((zone) => zone.kind === "walk").length < 2}
                          onClick={createBridgePassZones}
                        >
                          <Wrench size={16} aria-hidden="true" />
                          Bridge
                        </button>
                        <button
                          type="button"
                          className="button primary"
                          disabled={!sceneGraph && !manifest.navigation.bounds && manifest.views.filter((view) => view.kind === "walk").length === 0}
                          onClick={autoRepairNavigation}
                        >
                          <Wrench size={16} aria-hidden="true" />
                          Auto Fix
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => addNavigationZone("block")}
                        >
                          <Plus size={16} aria-hidden="true" />
                          Block
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={!manifest.navigation.bounds}
                          onClick={createBoundaryBlockZones}
                        >
                          <Wrench size={16} aria-hidden="true" />
                          Boundary
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => addNavigationZone("pass")}
                        >
                          <Plus size={16} aria-hidden="true" />
                          Pass
                        </button>
                        {generatedNavigationZoneCount > 0 && (
                          <label className="toggle-row compact-toggle zone-generated-toggle">
                            <input
                              type="checkbox"
                              checked={showGeneratedNavigationZones}
                              onChange={(event) => setShowGeneratedNavigationZones(event.target.checked)}
                            />
                            <span>Auto zones</span>
                          </label>
                        )}
                      </div>
                    </div>
                    {generatedNavigationZoneCount > 0 && !showGeneratedNavigationZones && (
                      <div className="zone-helper-strip">
                        <strong>{generatedNavigationZoneCount} auto-detected zone(s) are active but hidden.</strong>
                        <span>Keep this off for normal repairs; turn it on only when you need to inspect detection.</span>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="button secondary compact-button"
                            onClick={() => setShowGeneratedNavigationZones(true)}
                          >
                            Inspect
                          </button>
                          <button
                            type="button"
                            className="button secondary compact-button"
                            onClick={disableGeneratedNavigationZones}
                          >
                            Disable Auto
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="zone-setup-board" aria-label="Navigation zone setup health">
                      {navigationZoneSetupSteps.map((step) => (
                        <button
                          key={step.id}
                          type="button"
                          className={`zone-setup-card ${step.status}`}
                          onClick={() => {
                            if (step.id === "walk") {
                              if (step.status === "warning") {
                                setNavigationPaintKind("walk");
                                setNavigationPaintShape("polygon");
                                setNavigationPolygonDraft(null);
                              } else {
                                setShowNavigationZoneList(true);
                              }
                              return;
                            }
                            if (step.id === "pass") {
                              if (step.action === "Draw Pass") {
                                setNavigationPaintKind("pass");
                                setNavigationPaintShape("polygon");
                                setNavigationPolygonDraft(null);
                              } else {
                                setShowNavigationZoneList(true);
                              }
                              return;
                            }
                            if (step.id === "block") {
                              if (step.action === "Create Boundary") {
                                createBoundaryBlockZones();
                              } else if (step.action === "Set Bounds") {
                                applyBoundsFromGraph();
                              } else {
                                setNavigationPaintKind("block");
                                setNavigationPaintShape("rectangle");
                                setNavigationPolygonDraft(null);
                                setShowNavigationZoneList(true);
                              }
                              return;
                            }
                            if (step.id === "auto") {
                              if (generatedNavigationZoneCount > 0) {
                                setShowGeneratedNavigationZones(true);
                              } else {
                                autoRepairNavigation();
                              }
                            }
                          }}
                        >
                          <span>
                            {step.status === "ready" ? (
                              <Check size={15} aria-hidden="true" />
                            ) : step.id === "auto" ? (
                              <Wrench size={15} aria-hidden="true" />
                            ) : (
                              <MapPin size={15} aria-hidden="true" />
                            )}
                          </span>
                          <strong>{step.label}</strong>
                          <small>{step.detail}</small>
                          <em>{step.action}</em>
                        </button>
                      ))}
                    </div>
                    {manifest.navigation.bounds && (
                      <div className="zone-map">
                        <div className="zone-map-heading">
                          <div>
                            <strong>Zone map</strong>
                            <small>
                              {navigationPaintKind
                                ? navigationPaintShape === "polygon"
                                  ? `Click points for a ${navigationZoneKindLabel(navigationPaintKind).toLowerCase()} polygon, then finish it.`
                                  : `Click the map to add a ${navigationZoneKindLabel(navigationPaintKind).toLowerCase()}.`
                                : "Drag existing zones, or choose a paint tool to add one."}
                            </small>
                          </div>
                          <div className="zone-map-actions">
                            <div className="zone-paint-tools" aria-label="Paint navigation zone">
                              {(["walk", "pass", "block"] as const).map((kind) => (
                                <button
                                  key={kind}
                                  type="button"
                                  className={navigationPaintKind === kind ? `active ${kind}` : kind}
                                  onClick={() => {
                                    setNavigationPaintKind((current) => (current === kind ? null : kind));
                                    setNavigationPolygonDraft(null);
                                  }}
                                >
                                  {navigationZoneKindLabel(kind)}
                                </button>
                              ))}
                            </div>
                            <div className="zone-shape-tools" aria-label="Paint shape">
                              {(["rectangle", "polygon"] as const).map((shape) => (
                                <button
                                  key={shape}
                                  type="button"
                                  className={navigationPaintShape === shape ? "active" : ""}
                                  onClick={() => {
                                    setNavigationPaintShape(shape);
                                    setNavigationPolygonDraft(null);
                                  }}
                                >
                                  {shape === "rectangle" ? "Rectangle" : "Polygon"}
                                </button>
                              ))}
                            </div>
                            {navigationPolygonDraft && (
                              <div className="zone-draft-actions">
                                <button
                                  type="button"
                                  onClick={finishNavigationPolygonDraft}
                                  disabled={navigationPolygonDraft.points.length < 3}
                                >
                                  Finish
                                </button>
                                <button type="button" onClick={clearNavigationPolygonDraft}>
                                  Clear
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                        <div
                          className={navigationPaintKind ? "zone-map-surface paint-mode" : "zone-map-surface"}
                          onPointerDown={(event) => {
                            if (!navigationPaintKind || event.target !== event.currentTarget) {
                              return;
                            }
                            event.preventDefault();
                            if (navigationPaintShape === "polygon") {
                              addNavigationPolygonDraftPoint(
                                navigationPaintKind,
                                event.currentTarget,
                                event.clientX,
                                event.clientY
                              );
                            } else {
                              paintNavigationZoneOnMap(
                                navigationPaintKind,
                                event.currentTarget,
                                event.clientX,
                                event.clientY
                              );
                            }
                          }}
                        >
                          {navigationRepairDraft?.from && navigationRepairDraft.target && (
                            <span
                              className="zone-map-repair-route"
                              style={repairRouteLineStyle(
                                navigationRepairDraft.from,
                                navigationRepairDraft.target,
                                manifest.navigation.bounds
                              )}
                              title="Viewer attempted route"
                            />
                          )}
                          {navigationRepairDraft?.from && (
                            <span
                              className="zone-map-repair-marker start"
                              style={pointMapStyle(navigationRepairDraft.from, manifest.navigation.bounds)}
                              title="Camera start"
                            >
                              Start
                            </span>
                          )}
                          {navigationRepairDraft?.target && (
                            <span
                              className="zone-map-repair-marker target"
                              style={pointMapStyle(navigationRepairDraft.target, manifest.navigation.bounds)}
                              title="Clicked target"
                            >
                              Target
                            </span>
                          )}
                          {navigationRepairDraft?.point && (
                            <span
                              className="zone-map-repair-marker blocked"
                              style={pointMapStyle(navigationRepairDraft.point, manifest.navigation.bounds)}
                              title="Viewer blocked point"
                            >
                              Blocked
                            </span>
                          )}
                          {navigationPolygonDraft?.points.map(([x, z], pointIndex) => (
                            <span
                              key={`zone-draft-point-${pointIndex}`}
                              className={`zone-map-draft-point ${navigationPolygonDraft.kind}`}
                              style={pointMapStyle([x, manifest.navigation.bounds!.min[1], z], manifest.navigation.bounds!)}
                              title={`Draft point ${pointIndex + 1}`}
                            >
                              {pointIndex + 1}
                            </span>
                          ))}
                          {visibleNavigationZones.map((zone) => (
                            <div key={zone.id}>
                              <button
                                type="button"
                                className={`zone-map-item ${zone.kind}${zone.polygon && zone.polygon.length >= 3 ? " polygon" : ""}${zone.source === "generated" ? " generated" : ""}${zone.enabled === false ? " disabled" : ""}`}
                                style={zoneMapStyle(zone, manifest.navigation.bounds!)}
                                title={[`${zone.label} (${zone.kind})`, navigationZoneOriginLabel(zone)]
                                  .filter(Boolean)
                                  .join(" - ")}
                                onPointerDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  const mapElement = event.currentTarget.closest(".zone-map-surface");
                                  if (mapElement instanceof HTMLElement) {
                                    moveNavigationZoneOnMap(
                                      zone.id,
                                      mapElement,
                                      event.clientX,
                                      event.clientY
                                    );
                                  }
                                }}
                              >
                                <span>{zone.label}</span>
                              </button>
                              {navigationZonePolygonWorldPoints(zone).map(([x, z], pointIndex) => (
                                <div key={`${zone.id}-vertex-group-${pointIndex}`}>
                                  <button
                                    type="button"
                                    className={`zone-map-edge-point ${zone.kind}`}
                                    style={pointMapStyle([
                                      (x + (navigationZonePolygonWorldPoints(zone)[(pointIndex + 1) % navigationZonePolygonWorldPoints(zone).length]?.[0] ?? x)) / 2,
                                      zone.center[1],
                                      (z + (navigationZonePolygonWorldPoints(zone)[(pointIndex + 1) % navigationZonePolygonWorldPoints(zone).length]?.[1] ?? z)) / 2
                                    ], manifest.navigation.bounds!)}
                                    title={`Insert point after ${pointIndex + 1}`}
                                    onPointerDown={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      insertNavigationZonePolygonPoint(zone.id, pointIndex);
                                    }}
                                  >
                                    <Plus size={11} aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    className={`zone-map-vertex ${zone.kind}`}
                                    style={pointMapStyle([x, zone.center[1], z], manifest.navigation.bounds!)}
                                    title={`${zone.label} point ${pointIndex + 1}`}
                                    onPointerDown={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const mapElement = event.currentTarget.closest(".zone-map-surface");
                                      if (mapElement instanceof HTMLElement) {
                                        moveNavigationZonePolygonPointOnMap(
                                          zone.id,
                                          pointIndex,
                                          mapElement,
                                          event.clientX,
                                          event.clientY
                                        );
                                      }
                                    }}
                                  >
                                    <span>{pointIndex + 1}</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="zone-helper-strip zone-details-toggle">
                      <strong>{visibleNavigationZones.length} visible zone(s)</strong>
                      <span>
                        Use the map and guided repair buttons for normal fixes. Open details only for labels, exact
                        sizes, zone roles, or polygon points.
                      </span>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="button secondary compact-button"
                          onClick={() => setShowNavigationZoneList((current) => !current)}
                        >
                          {showNavigationZoneList ? "Hide Details" : "Show Details"}
                        </button>
                      </div>
                    </div>
                    {showNavigationZoneList && (
                    <div className="zone-editor-list">
                      {visibleNavigationZones.map((zone) => {
                        const advancedOpen = expandedNavigationZoneIds.has(zone.id);
                        return (
                          <div key={zone.id} className={`zone-editor-row ${zone.kind}`}>
                            <div className="zone-simple-heading">
                              <div className="zone-kind-icon" aria-hidden="true">
                                {zone.kind === "walk" ? "W" : zone.kind === "pass" ? "P" : "B"}
                              </div>
                              <div className="zone-simple-main">
                                <div className="zone-title-row">
                                  <input
                                    aria-label={`${zone.label} label`}
                                    value={zone.label}
                                    onChange={(event) =>
                                      updateNavigationZone(zone.id, (current) => ({
                                        ...current,
                                        label: event.target.value
                                      }))
                                    }
                                  />
                                  <span className={`zone-kind-pill ${zone.kind}`}>
                                    {navigationZoneKindLabel(zone.kind)}
                                  </span>
                                  {navigationZoneOriginLabel(zone) && (
                                    <span className="zone-origin-pill">{navigationZoneOriginLabel(zone)}</span>
                                  )}
                                </div>
                                <p>{navigationZonePlainSummary(zone)}</p>
                                <small>{navigationZonePlainHelp(zone.kind)}</small>
                              </div>
                              <div className="zone-simple-actions">
                                <label className="toggle-row compact-toggle">
                                  <input
                                    type="checkbox"
                                    checked={zone.enabled !== false}
                                    onChange={(event) =>
                                      updateNavigationZone(zone.id, (current) => ({
                                        ...current,
                                        enabled: event.target.checked
                                      }))
                                    }
                                  />
                                  <span>On</span>
                                </label>
                                <button
                                  type="button"
                                  className="button secondary compact-button"
                                  onClick={() => toggleNavigationZoneAdvanced(zone.id)}
                                >
                                  <Settings2 size={16} aria-hidden="true" />
                                  {advancedOpen ? "Hide" : "Advanced"}
                                </button>
                                <button
                                  type="button"
                                  className="icon-action danger"
                                  title="Delete zone"
                                  onClick={() => removeNavigationZone(zone.id)}
                                >
                                  <Trash2 size={17} aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                            <div className="zone-kind-segmented" aria-label={`Change ${zone.label} zone type`}>
                              {(["walk", "pass", "block"] as const).map((kind) => (
                                <button
                                  key={kind}
                                  type="button"
                                  className={zone.kind === kind ? "active" : ""}
                                  onClick={() => updateNavigationZone(zone.id, (current) => ({ ...current, kind }))}
                                >
                                  {navigationZoneKindLabel(kind)}
                                </button>
                              ))}
                            </div>
                            {advancedOpen && (
                              <div className="zone-advanced-editor">
                                <VectorEditor
                                  label="Center"
                                  value={zone.center}
                                  onChange={(value) =>
                                    updateNavigationZone(zone.id, (current) => ({ ...current, center: value }))
                                  }
                                />
                                <VectorEditor
                                  label="Size"
                                  value={zone.size}
                                  onChange={(value) =>
                                    updateNavigationZone(zone.id, (current) => ({ ...current, size: value }))
                                  }
                                />
                                <NumberField
                                  label="Rotation Y"
                                  min={-3.14}
                                  max={3.14}
                                  step={0.01}
                                  value={zone.rotationY ?? 0}
                                  onChange={(value) =>
                                    updateNavigationZone(zone.id, (current) => ({ ...current, rotationY: value }))
                                  }
                                />
                                <div className="zone-shape-tools">
                                  <div>
                                    <strong>Shape</strong>
                                    <p>
                                      {zone.polygon && zone.polygon.length >= 3
                                        ? `${zone.polygon.length} polygon points stored for this zone.`
                                        : "Rectangular zone. Convert to polygon before detailed vertex editing."}
                                    </p>
                                  </div>
                                  <div className="inline-actions">
                                    <button
                                      type="button"
                                      className="button secondary compact-button"
                                      onClick={() =>
                                        updateNavigationZone(zone.id, (current) => ({
                                          ...current,
                                          polygon: rectangularPolygonForZone(current)
                                        }))
                                      }
                                    >
                                      Polygon
                                    </button>
                                    <button
                                      type="button"
                                      className="button secondary compact-button"
                                      disabled={!zone.polygon}
                                      onClick={() =>
                                        updateNavigationZone(zone.id, (current) => {
                                          const { polygon: _polygon, ...rest } = current;
                                          return rest;
                                        })
                                      }
                                    >
                                      Rectangle
                                    </button>
                                  </div>
                                  {zone.polygon && zone.polygon.length >= 3 && (
                                    <div className="zone-polygon-editor" aria-label={`${zone.label} polygon points`}>
                                      {zone.polygon.map((point, pointIndex) => (
                                        <div key={`${zone.id}-point-${pointIndex}`} className="zone-polygon-point">
                                          <span>Point {pointIndex + 1}</span>
                                          <input
                                            type="number"
                                            step="0.05"
                                            value={point[0]}
                                            aria-label={`Point ${pointIndex + 1} X`}
                                            onChange={(event) =>
                                              updateNavigationZone(zone.id, (current) => ({
                                                ...current,
                                                polygon: (current.polygon ?? []).map((item, index) =>
                                                  index === pointIndex ? [toNumber(event.target.value, item[0]), item[1]] : item
                                                )
                                              }))
                                            }
                                          />
                                          <input
                                            type="number"
                                            step="0.05"
                                            value={point[1]}
                                            aria-label={`Point ${pointIndex + 1} Z`}
                                            onChange={(event) =>
                                              updateNavigationZone(zone.id, (current) => ({
                                                ...current,
                                                polygon: (current.polygon ?? []).map((item, index) =>
                                                  index === pointIndex ? [item[0], toNumber(event.target.value, item[1])] : item
                                                )
                                              }))
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="icon-action danger"
                                            title={`Remove point ${pointIndex + 1}`}
                                            disabled={(zone.polygon?.length ?? 0) <= 3}
                                            onClick={() =>
                                              updateNavigationZone(zone.id, (current) => ({
                                                ...current,
                                                polygon: (current.polygon ?? []).filter((_, index) => index !== pointIndex)
                                              }))
                                            }
                                          >
                                            <Trash2 size={15} aria-hidden="true" />
                                          </button>
                                        </div>
                                      ))}
                                      <button
                                        type="button"
                                        className="button secondary compact-button"
                                        onClick={() =>
                                          updateNavigationZone(zone.id, (current) => {
                                            const polygon = current.polygon ?? rectangularPolygonForZone(current);
                                            const last = polygon[polygon.length - 1] ?? [0, 0];
                                            return {
                                              ...current,
                                              polygon: [...polygon, [last[0] + 0.25, last[1] + 0.25]]
                                            };
                                          })
                                        }
                                      >
                                        <Plus size={15} aria-hidden="true" />
                                        Add Point
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {visibleNavigationZones.length === 0 && navigationZones.length === 0 && (
                        <p className="quiet-note">
                          No explicit zones yet. Add a walk zone to define clickable floor area, block zones for hard
                          boundaries, and pass zones for doors or openings.
                        </p>
                      )}
                      {visibleNavigationZones.length === 0 && navigationZones.length > 0 && (
                        <p className="quiet-note">
                          Only auto-detected zones exist right now. Enable Auto zones to inspect them, or use the repair
                          buttons above to add manual patches.
                        </p>
                      )}
                    </div>
                    )}
                  </div>
                </>
              ) : (
                <p className="quiet-note">No controls document loaded.</p>
              )}
            </div>

            <div className="panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>controls.json</h2>
              </div>
              <details className="json-details">
                <summary>Show raw controls JSON</summary>
                <pre className="json-preview">{JSON.stringify(controlsDoc, null, 2)}</pre>
              </details>
            </div>
          </section>
        )}

        {selectedTab === "environment" && (
          <section className="content-grid">
            <div className="panel">
              <div className="panel-heading">
                <Globe2 size={18} aria-hidden="true" />
                <h2>Environment</h2>
              </div>
              <VisualGuideCard
                title="Exterior and window backdrop"
                detail="Set the outside context before judging whether the model looks hollow or unfinished."
                steps={[
                  "Use Interior for enclosed units, Exterior for grass or landscape outside windows, and Review for scale/debug checks.",
                  "Keep ground and enclosure on when windows or balconies expose empty space.",
                  "Adjust ground height so the landscape sits below floors without cutting through the model."
                ]}
                actionLabel="Exterior"
                onAction={() => applyEnvironmentPreset("exterior")}
                secondaryActionLabel="Repair Center"
                onSecondaryAction={() => setSelectedTab("repair")}
              />
              <div className="environment-preset-card">
                <div>
                  <strong>Environment presets</strong>
                  <p>
                    Use Interior when the model already has floors and walls, Exterior when you want grass outside
                    windows, and Review when a model looks hidden by the background.
                  </p>
                </div>
                <div className="environment-preset-actions">
                  <button type="button" className="button secondary" onClick={() => applyEnvironmentPreset("interior")}>
                    Interior
                  </button>
                  <button type="button" className="button secondary" onClick={() => applyEnvironmentPreset("exterior")}>
                    Exterior
                  </button>
                  <button type="button" className="button secondary" onClick={() => applyEnvironmentPreset("review")}>
                    Review
                  </button>
                </div>
              </div>
              <div className="environment-setup-board" aria-label="Environment setup health">
                {environmentSetupSteps.map((step) => (
                  <button
                    key={step.id}
                    type="button"
                    className={`environment-setup-card ${step.status}`}
                    disabled={step.status === "ready" && step.id !== "review"}
                    onClick={() => {
                      if (step.id === "outside" || step.id === "enclosure") {
                        applyEnvironmentPreset("exterior");
                        return;
                      }
                      if (step.id === "sky") {
                        applyEnvironmentPreset("interior");
                        return;
                      }
                      if (step.id === "height") {
                        updateEnvironment((environment) => ({
                          ...environment,
                          groundY: -0.04
                        }));
                        return;
                      }
                      if (step.id === "review") {
                        applyEnvironmentPreset(step.status === "active" ? "exterior" : "review");
                      }
                    }}
                  >
                    <span>
                      {step.status === "ready" ? (
                        <Check size={15} aria-hidden="true" />
                      ) : step.status === "active" ? (
                        <Eye size={15} aria-hidden="true" />
                      ) : (
                        <Globe2 size={15} aria-hidden="true" />
                      )}
                    </span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                    <em>{step.action}</em>
                  </button>
                ))}
              </div>
              <div className="toggle-grid">
                <label>
                  <input
                    type="checkbox"
                    checked={manifest.environment?.skyBackdropEnabled ?? true}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        skyBackdropEnabled: event.target.checked
                      }))
                    }
                  />
                  <span>Sky backdrop</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={manifest.environment?.groundEnabled ?? true}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        groundEnabled: event.target.checked
                      }))
                    }
                  />
                  <span>Ground enclosure</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={manifest.environment?.enclosureEnabled ?? true}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        enclosureEnabled: event.target.checked
                      }))
                    }
                  />
                  <span>Landscape enclosure</span>
                </label>
              </div>
              <div className="field-grid">
                <label>
                  <span>Background</span>
                  <input
                    value={manifest.environment?.backgroundColor ?? "#d8dde2"}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        backgroundColor: event.target.value
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Sky top</span>
                  <input
                    value={manifest.environment?.skyTopColor ?? "#d8e7f5"}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        skyTopColor: event.target.value
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Sky horizon</span>
                  <input
                    value={manifest.environment?.skyHorizonColor ?? "#f3f6f8"}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        skyHorizonColor: event.target.value
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Ground color</span>
                  <input
                    value={manifest.environment?.groundColor ?? "#6f8f5a"}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        groundColor: event.target.value
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Enclosure color</span>
                  <input
                    value={manifest.environment?.enclosureColor ?? "#5f7f4b"}
                    onChange={(event) =>
                      updateEnvironment((environment) => ({
                        ...environment,
                        enclosureColor: event.target.value
                      }))
                    }
                  />
                </label>
                <NumberField
                  label="Ground size"
                  min={10}
                  max={400}
                  step={5}
                  value={manifest.environment?.groundSize ?? 90}
                  onChange={(value) =>
                    updateEnvironment((environment) => ({
                      ...environment,
                      groundSize: value
                    }))
                  }
                />
                <NumberField
                  label="Enclosure radius"
                  min={8}
                  max={400}
                  step={1}
                  value={manifest.environment?.enclosureRadius ?? 44}
                  onChange={(value) =>
                    updateEnvironment((environment) => ({
                      ...environment,
                      enclosureRadius: value
                    }))
                  }
                />
                <NumberField
                  label="Enclosure height"
                  min={2}
                  max={80}
                  step={1}
                  value={manifest.environment?.enclosureHeight ?? 14}
                  onChange={(value) =>
                    updateEnvironment((environment) => ({
                      ...environment,
                      enclosureHeight: value
                    }))
                  }
                />
                <NumberField
                  label="Ground height"
                  min={-20}
                  max={20}
                  step={0.05}
                  value={manifest.environment?.groundY ?? -0.04}
                  onChange={(value) =>
                    updateEnvironment((environment) => ({
                      ...environment,
                      groundY: value
                    }))
                  }
                />
              </div>
            </div>
            <div className="panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>environment</h2>
              </div>
              <details className="json-details">
                <summary>Show technical environment JSON</summary>
                <pre className="json-preview">{JSON.stringify(manifest.environment ?? {}, null, 2)}</pre>
              </details>
            </div>
          </section>
        )}

        {selectedTab === "bundle" && (
          <section className="content-grid bundle-grid">
            <div className="panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>Manifest</h2>
              </div>
              <div className="bundle-snapshot-board" aria-label="Bundle snapshot">
                <div className="bundle-snapshot-card">
                  <span>Scene</span>
                  <strong>{manifest.sceneUrl}</strong>
                  <small>{formatBytes(bundleStats?.modelBytes ?? 0)} model file</small>
                </div>
                <div className="bundle-snapshot-card">
                  <span>Walkthrough</span>
                  <strong>
                    {manifest.views.length} view{manifest.views.length === 1 ? "" : "s"}
                  </strong>
                  <small>
                    {(manifest.rooms ?? []).length} room{(manifest.rooms ?? []).length === 1 ? "" : "s"} /{" "}
                    {manifest.interactions.length} interaction{manifest.interactions.length === 1 ? "" : "s"}
                  </small>
                </div>
                <div className="bundle-snapshot-card">
                  <span>Movement</span>
                  <strong>{manifest.navigation.bounds ? "Bounds set" : "Needs bounds"}</strong>
                  <small>
                    {(manifest.navigation.zones ?? []).length} zone{(manifest.navigation.zones ?? []).length === 1 ? "" : "s"}
                  </small>
                </div>
                <div className={`bundle-snapshot-card ${bundleStats?.publishReadiness?.status ?? "waiting"}`}>
                  <span>Publish gate</span>
                  <strong>{bundleStats?.publishReadiness?.status ?? "Not analyzed"}</strong>
                  <small>
                    {(bundleStats?.publishReadiness?.blockers.length ?? 0)} blocker
                    {(bundleStats?.publishReadiness?.blockers.length ?? 0) === 1 ? "" : "s"} /{" "}
                    {(bundleStats?.publishReadiness?.warnings.length ?? 0)} warning
                    {(bundleStats?.publishReadiness?.warnings.length ?? 0) === 1 ? "" : "s"}
                  </small>
                </div>
              </div>
              <VisualGuideCard
                title="Technical bundle reference"
                detail="Use this only when debugging deploy scripts, schema issues, or viewer loading. Normal setup should happen from Repair Center, Publish, and the visual Studio tabs."
                steps={[
                  "Check the snapshot first for scene URL, views, rooms, interactions, navigation zones, and publish gate state.",
                  "Open the manifest JSON only when a developer needs exact paths or schema values.",
                  "Use Publish for client links and deployment commands instead of copying paths from this technical view."
                ]}
                actionLabel="Copy Manifest"
                onAction={() => void copyText(JSON.stringify(manifest, null, 2))}
                secondaryActionLabel="Publish"
                onSecondaryAction={() => setSelectedTab("publish")}
              />
              <details className="json-details">
                <summary>Show technical manifest JSON</summary>
                <pre className="json-preview">{JSON.stringify(manifest, null, 2)}</pre>
              </details>
            </div>
            <div className="side-stack">
              <div className="panel stats-panel">
                <div className="panel-heading">
                  <Activity size={18} aria-hidden="true" />
                  <h2>Bundle Stats</h2>
                </div>
                {bundleStats ? (
                  <>
                    <div className="stat-grid">
                      <Stat label="Total" value={formatBytes(bundleStats.totalBytes)} />
                      <Stat label="Model" value={formatBytes(bundleStats.modelBytes)} />
                      <Stat label="Meshes" value={String(bundleStats.meshCount)} />
                      <Stat label="Draw prims" value={String(bundleStats.primitiveCount ?? bundleStats.meshCount)} />
                      <Stat label="Materials" value={String(bundleStats.materialCount)} />
                      <Stat
                        label="Textured mats"
                        value={`${bundleStats.texturedMaterialCount ?? 0}/${bundleStats.materialCount}`}
                      />
                      <Stat label="Triangles" value={String(bundleStats.triangleCount)} />
                      <Stat label="Textures" value={String(bundleStats.textureCount ?? 0)} />
                      <Stat label="Images" value={String(bundleStats.imageCount ?? 0)} />
                      <Stat label="Embedded images" value={String(bundleStats.embeddedImageCount ?? 0)} />
                      <Stat label="Max texture" value={`${bundleStats.maxTextureDimension ?? 0}px`} />
                      <Stat label="Texture RAM" value={formatBytes(bundleStats.estimatedTextureMemoryBytes ?? 0)} />
                      <Stat label="Oversized" value={String(bundleStats.oversizedTextureCount ?? 0)} />
                      <Stat label="Strip textures" value={String(bundleStats.extremeAspectTextureCount ?? 0)} />
                      <Stat label="Loose images" value={String(bundleStats.looseImageCount ?? 0)} />
                      <Stat label="Geometry compression" value={geometryCompressionLabel(bundleStats)} />
                      <Stat label="Texture compression" value={textureCompressionLabel(bundleStats)} />
                      <Stat label="Assets" value={String(bundleStats.assetCount)} />
                    </div>
                    {bundleStats.warnings.length > 0 ? (
                      <ul className="warning-list">
                        {bundleStats.warnings.map((warning) => (
                          <li key={warning.code}>{warning.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="quiet-note">No bundle warnings.</p>
                    )}
                  </>
                ) : (
                  <p className="quiet-note">Stats are not generated yet.</p>
                )}
              </div>

              <div className="panel publish-panel">
                <div className="publish-row">
                  <span>Viewer URL</span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void copyText(viewerUrl(activeProjectId))}
                  >
                    <Copy size={16} aria-hidden="true" />
                    Copy
                  </button>
                </div>
                <code>{viewerUrl(activeProjectId)}</code>
                <div className="publish-row">
                  <span>Embed</span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void copyText(embedSnippet(activeProjectId, manifest.branding.clientName ?? manifest.branding.title))
                    }
                  >
                    <Copy size={16} aria-hidden="true" />
                    Copy
                  </button>
                </div>
                <code>{embedSnippet(activeProjectId, manifest.branding.clientName ?? manifest.branding.title)}</code>
              </div>
            </div>
          </section>
        )}
      </section>

      {notice && (
        <div className="notice" role="status">
          <Check size={16} aria-hidden="true" />
          {notice === "saved" && "Saved"}
          {notice === "copied" && "Copied"}
          {notice === "reset" && "Reset"}
        </div>
      )}
    </main>
  );
}

function NumberField({
  label,
  min = 0,
  max = 1,
  step = 0.05,
  value,
  onChange
}: {
  label: string;
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(toNumber(event.target.value, value))}
      />
    </label>
  );
}

function VisualGuideCard({
  title,
  detail,
  steps,
  actionLabel,
  actionDisabled = false,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  className = ""
}: {
  title: string;
  detail: string;
  steps: readonly string[];
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  className?: string;
}) {
  return (
    <div className={className ? `visual-guide-card ${className}` : "visual-guide-card"}>
      <div className="visual-guide-card-heading">
        <div>
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>
        {(actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) ? (
          <div className="visual-guide-actions">
            {actionLabel && onAction && (
              <button
                type="button"
                className="button primary compact-button"
                disabled={actionDisabled}
                onClick={onAction}
              >
                {actionLabel}
              </button>
            )}
            {secondaryActionLabel && onSecondaryAction && (
              <button type="button" className="button secondary compact-button" onClick={onSecondaryAction}>
                {secondaryActionLabel}
              </button>
            )}
          </div>
        ) : null}
      </div>
      <ol>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DiagnosticList({
  diagnostics,
  onAction
}: {
  diagnostics: NonNullable<BundleStats["diagnostics"]>;
  onAction?: (action: ImportNextStepAction) => void;
}) {
  if (diagnostics.length === 0) {
    return null;
  }
  const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const infoCount = diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
  const diagnosticActionGroups = [
    ...diagnostics
      .filter((diagnostic) => diagnostic.severity !== "info")
      .reduce((groups, diagnostic) => {
        const action = importActionForDiagnostic(diagnostic.code) ?? "review";
        const current = groups.get(action) ?? {
          action,
          errorCount: 0,
          warningCount: 0,
          titles: [] as string[]
        };
        groups.set(action, {
          action,
          errorCount: current.errorCount + (diagnostic.severity === "error" ? 1 : 0),
          warningCount: current.warningCount + (diagnostic.severity === "warning" ? 1 : 0),
          titles: [...current.titles, diagnostic.title]
        });
        return groups;
      }, new Map<ImportNextStepAction, { action: ImportNextStepAction; errorCount: number; warningCount: number; titles: string[] }>())
      .values()
  ].sort((a, b) => b.errorCount - a.errorCount || b.warningCount - a.warningCount || a.action.localeCompare(b.action));
  return (
    <div className="diagnostic-list">
      <div className={errorCount > 0 ? "diagnostic-summary blocking" : "diagnostic-summary"}>
        <strong>{errorCount > 0 ? `${errorCount} blocking issue${errorCount === 1 ? "" : "s"}` : "No blocking issues"}</strong>
        <span>
          {warningCount} warning{warningCount === 1 ? "" : "s"} / {infoCount} info
        </span>
      </div>
      {diagnosticActionGroups.length > 0 && (
        <div className="diagnostic-action-map" aria-label="Diagnostic fix areas">
          {diagnosticActionGroups.map((group) => {
            const actionCopy = nextStepCopy(group.action);
            const total = group.errorCount + group.warningCount;
            const severity = group.errorCount > 0 ? "error" : "warning";
            return (
              <button
                key={group.action}
                type="button"
                className={`diagnostic-action-group ${severity}`}
                disabled={!onAction}
                onClick={() => onAction?.(group.action)}
              >
                <span>{repairCenterIcon(group.action)}</span>
                <strong>{actionCopy.title}</strong>
                <small>
                  {total} issue{total === 1 ? "" : "s"} / {group.titles.slice(0, 2).join("; ")}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {diagnostics.map((diagnostic) => {
        const action = importActionForDiagnostic(diagnostic.code);
        const actionCopy = action ? nextStepCopy(action) : undefined;
        const symptom = diagnosticVisualSymptom(diagnostic.code);
        return (
          <div key={diagnostic.code} className={`diagnostic-card ${diagnostic.severity}`}>
            <AlertTriangle size={17} aria-hidden="true" />
            <div className="diagnostic-card-main">
              <div>
                <strong>{diagnostic.title}</strong>
                <p>{diagnostic.message}</p>
                {symptom && <small className="diagnostic-symptom">Likely symptom: {symptom}</small>}
                {action && (
                  <small className="diagnostic-next-fix">
                    Visual fix: {repairCenterVisualFixForAction(action)}
                  </small>
                )}
                {diagnostic.action && <small>{diagnostic.action}</small>}
              </div>
              {action && actionCopy && onAction && (
                <button
                  type="button"
                  className="button secondary compact-button diagnostic-action"
                  onClick={() => onAction(action)}
                >
                  {action === "repair" && <Wrench size={15} aria-hidden="true" />}
                  {action === "environment" && <Globe2 size={15} aria-hidden="true" />}
                  {action === "materials" && <Palette size={15} aria-hidden="true" />}
                  {action === "views" && <MapPin size={15} aria-hidden="true" />}
                  {action === "navigation" && <MapPin size={15} aria-hidden="true" />}
                  {action === "objects" && <Eye size={15} aria-hidden="true" />}
                  {action === "rooms" && <Layers3 size={15} aria-hidden="true" />}
                  {action === "interactions" && <Video size={15} aria-hidden="true" />}
                  {action === "optimize" && <Activity size={15} aria-hidden="true" />}
                  {action === "bake" && <Palette size={15} aria-hidden="true" />}
                  {action === "review" && <AlertTriangle size={15} aria-hidden="true" />}
                  {actionCopy.button}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type ImportNextStepAction =
  | "repair"
  | "apply-textures"
  | "environment"
  | "materials"
  | "variants"
  | "views"
  | "navigation"
  | "objects"
  | "rooms"
  | "interactions"
  | "optimize"
  | "bake"
  | "review"
  | "test";

interface ImportNextStep {
  action: ImportNextStepAction;
  title: string;
  detail: string;
  button: string;
}

const sceneFramingDiagnosticCodes = new Set([
  "dominant-flat-plane",
  "initial-view-on-dominant-plane",
  "initial-view-misses-focused-model",
  "focused-model-small-in-scene",
  "scene-far-from-origin",
  "large-coordinate-units",
  "missing-scene-bounds"
]);

function isSceneFramingDiagnostic(code: string): boolean {
  return sceneFramingDiagnosticCodes.has(code);
}

function isGreenPlaceholderDiagnostic(code: string): boolean {
  return code === "dominant-green-placeholder-material";
}

function isTextureConnectionDiagnostic(code: string): boolean {
  return [
    "loose-textures-not-referenced",
    "generic-loose-texture-names",
    "image-textures-unused-by-materials",
    "few-materials-use-textures",
    "many-unused-texture-images"
  ].includes(code);
}

function isLightmapArtifactDiagnostic(code: string): boolean {
  return ["missing-lightmap-assets", "tiny-lightmap-assets"].includes(code);
}

function isObjectVisibilityDiagnostic(code: string): boolean {
  return ["no-named-ceiling-meshes", "stale-object-overrides", "invalid-object-navigation-behavior"].includes(code);
}

function isSourceStructureDiagnostic(code: string): boolean {
  return [
    "malformed-model",
    "invalid-default-scene",
    "default-scene-has-no-renderable-meshes",
    "missing-gltf-scene-definitions",
    "meshes-outside-default-scene",
    "non-triangle-primitives",
    "invalid-scene-node-references",
    "invalid-node-child-references",
    "invalid-node-mesh-references",
    "invalid-node-transforms",
    "missing-position-attributes",
    "invalid-accessor-references",
    "invalid-position-accessor-shapes",
    "invalid-index-accessor-shapes",
    "invalid-buffer-view-references",
    "invalid-buffer-view-ranges",
    "invalid-accessor-buffer-views",
    "invalid-accessor-byte-ranges",
    "undersized-model-buffers",
    "missing-position-bounds",
    "invalid-position-bounds",
    "collapsed-position-bounds"
  ].includes(code);
}

interface SourceQaGroup {
  id: string;
  label: string;
  detail: string;
  count: number;
  severity: "error" | "warning" | "ready";
  issues: SourceQaIssue[];
}

interface SourceQaIssue {
  title: string;
  detail: string;
  severity: "error" | "warning";
  symptom: string | null;
  action: string | undefined;
}

function sourceQaIssueEvidenceLines(
  issue: SourceQaIssue,
  options: { index?: number; indent?: string } = {}
): string[] {
  const indent = options.indent ?? "";
  const label = typeof options.index === "number" ? `${options.index}. ` : "- ";
  return [
    `${indent}${label}${issue.title}`,
    `${indent}   Problem: ${issue.detail}`,
    issue.symptom ? `${indent}   Visible symptom: ${issue.symptom}` : "",
    issue.action ? `${indent}   Requested fix: ${issue.action}` : ""
  ].filter(Boolean);
}

function sourceQaIssueGroupEvidenceLines(
  groups: readonly SourceQaGroup[],
  options: { issuesPerGroup?: number; indent?: string } = {}
): string[] {
  const issuesPerGroup = options.issuesPerGroup ?? 4;
  const indent = options.indent ?? "  ";
  return groups.flatMap((group) => {
    const shownIssues = group.issues.slice(0, issuesPerGroup);
    const hiddenIssueCount = Math.max(0, group.issues.length - shownIssues.length);
    return [
      `- ${group.label}: ${group.count} issue${group.count === 1 ? "" : "s"}`,
      ...shownIssues.flatMap((issue, index) =>
        sourceQaIssueEvidenceLines(issue, {
          index: index + 1,
          indent
        })
      ),
      hiddenIssueCount > 0
        ? `${indent}Plus ${hiddenIssueCount} more issue${hiddenIssueCount === 1 ? "" : "s"} in ${group.label}.`
        : ""
    ].filter(Boolean);
  });
}

function sourceQaGroups(stats: BundleStats): SourceQaGroup[] {
  const diagnostics = stats.diagnostics ?? [];
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const unsupportedRequiredExtensions = [
    ...new Set((stats.models ?? []).flatMap((model) => model.unsupportedRequiredExtensions ?? []))
  ];
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const caseMismatchedResources = externalResources.filter((resource) => resource.exists && resource.caseMismatch);
  const decodeFailedResources = externalResources.filter((resource) => resource.kind === "texture" && resource.decodeFailed);
  const unsupportedMimeResources = externalResources.filter(
    (resource) => resource.kind === "texture" && resource.unsupportedMimeType
  );
  const decodeFailedEmbeddedImages = (stats.models ?? [])
    .flatMap((model) => model.embeddedImages ?? [])
    .filter((image) => image.decodeFailed);
  const unsupportedMimeEmbeddedImages = (stats.models ?? [])
    .flatMap((model) => model.embeddedImages ?? [])
    .filter((image) => image.unsupportedMimeType);
  const unsafeResources = (stats.models ?? []).flatMap((model) => model.unsafeLocalResources ?? []);
  const issueFromDiagnostic = (diagnostic: NonNullable<BundleStats["diagnostics"]>[number]): SourceQaIssue => ({
    title: diagnostic.title,
    detail: diagnostic.message,
    severity: diagnostic.severity === "error" ? "error" : "warning",
    symptom: diagnosticVisualSymptom(diagnostic.code),
    action: diagnostic.action
  });
  const unsupportedExtensionIssues: SourceQaIssue[] = unsupportedRequiredExtensions.slice(0, 8).map((extension) => ({
    title: `Unsupported required extension: ${extension}`,
    detail: "The model marks this extension as required, so the viewer must support it before the scene can be safely delivered.",
    severity: "error",
    symptom: "the model may fail to load, skip geometry/material features, or render differently from the source viewer.",
    action: "Re-export without this required extension, bake/flatten the feature into standard glTF data, or add viewer loader support before publishing."
  }));
  const missingResourceIssues: SourceQaIssue[] = missingResources.slice(0, 5).map((resource) => ({
    title: `Missing ${resource.kind}: ${resource.source}`,
    detail: "The model references this external file, but it is not present in the uploaded bundle.",
    severity: "warning",
    symptom: "textures, buffers, or linked model parts may be missing even though the scene opens.",
    action: "Upload the original ZIP/folder with this resource, or re-export as a GLB with resources embedded."
  }));
  const caseMismatchIssues: SourceQaIssue[] = caseMismatchedResources.slice(0, 5).map((resource) => ({
    title: `Case mismatch: ${resource.source}`,
    detail: resource.actualSource
      ? `The model asks for "${resource.source}", but the uploaded file is named "${resource.actualSource}".`
      : "The model resource path differs from the uploaded filename only by letter casing.",
    severity: "warning",
    symptom: "the texture or buffer may load on Windows but fail after publishing to a case-sensitive CDN or Linux host.",
    action: "Rename the file or re-export the source model so referenced resource paths exactly match the uploaded filenames."
  }));
  const unsafeResourceIssues: SourceQaIssue[] = unsafeResources.slice(0, 5).map((resource) => ({
    title: `Unsafe ${resource.kind}: ${resource.source}`,
    detail: "The model points to an absolute path or a path outside the uploaded scene folder.",
    severity: "warning",
    symptom: "the resource cannot be packaged safely and will fail after upload, optimization, or publishing.",
    action: "Re-export with resources beside the GLTF/GLB, use relative paths only, or embed textures and buffers in a self-contained GLB."
  }));
  const decodeFailedIssues: SourceQaIssue[] = [
    ...decodeFailedResources.slice(0, 5).map((resource) => ({
      title: `Unreadable texture: ${resource.source}`,
      detail: "The texture file exists, but Studio could not read it as valid image data.",
      severity: "warning" as const,
      symptom: "the material may render flat, black, missing, or different from the source/reference viewer.",
      action: "Replace this texture with a valid PNG, JPEG, WebP, AVIF, KTX2, or Basis file and re-export/reupload the model."
    })),
    ...decodeFailedEmbeddedImages.slice(0, 5).map((image) => ({
      title: `Unreadable embedded texture: ${image.label}`,
      detail: `${image.source} is embedded in the model but could not be decoded${image.mimeType ? ` as ${image.mimeType}` : ""}.`,
      severity: "warning" as const,
      symptom: "embedded material textures may render flat, black, missing, or different from the source/reference viewer.",
      action: "Re-export the model with valid embedded image data or replace the texture before export."
    }))
  ];
  const unsupportedMimeIssues: SourceQaIssue[] = [
    ...unsupportedMimeResources.slice(0, 5).map((resource) => ({
      title: `Unsupported texture format: ${resource.source}`,
      detail: `This texture uses ${resource.unsupportedMimeType}, which is outside the web delivery formats Studio supports.`,
      severity: "warning" as const,
      symptom: "the material may fail to load after publishing or may be skipped by optimization/compression tools.",
      action: "Convert the texture to PNG, JPEG, WebP, AVIF, KTX2, or Basis and re-export/reupload the model."
    })),
    ...unsupportedMimeEmbeddedImages.slice(0, 5).map((image) => ({
      title: `Unsupported embedded texture format: ${image.label}`,
      detail: `${image.source} uses ${image.unsupportedMimeType}, which is outside the web delivery formats Studio supports.`,
      severity: "warning" as const,
      symptom: "the embedded texture may fail to load after publishing or may be skipped by optimization/compression tools.",
      action: "Replace or convert this texture before export, then re-export the model as a web-safe GLB."
    }))
  ];
  const groupFromDiagnostics = (
    id: string,
    label: string,
    detail: string,
    matches: (code: string) => boolean,
    extraIssues: SourceQaIssue[] = []
  ): SourceQaGroup => {
    const groupDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity !== "info" && matches(diagnostic.code));
    const issues = [...groupDiagnostics.map(issueFromDiagnostic), ...extraIssues];
    const hasError =
      groupDiagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      extraIssues.some((issue) => issue.severity === "error");
    const hasWarning =
      groupDiagnostics.some((diagnostic) => diagnostic.severity === "warning") ||
      extraIssues.some((issue) => issue.severity === "warning");
    const count = issues.length;
    return {
      id,
      label,
      detail,
      count,
      severity: hasError ? "error" : hasWarning || extraIssues.length > 0 ? "warning" : "ready",
      issues
    };
  };

  return [
    groupFromDiagnostics(
      "structure",
      "Export structure",
      "Bad GLB/GLTF structure can make the model open blank, partial, mirrored, or impossible to analyze reliably.",
      isSourceStructureDiagnostic,
      unsupportedExtensionIssues
    ),
    groupFromDiagnostics(
      "resources",
      "Missing resources",
      "Broken texture or buffer paths usually mean the original ZIP/folder needs to be uploaded or the model re-exported with embedded resources.",
      (code) =>
        [
          "missing-model-resources",
          "invalid-image-buffer-references",
          "case-mismatched-model-resources",
          "unsafe-gltf-resource-paths",
          "unsupported-required-extensions",
          "embedded-texture-decode-failed",
          "sidecar-texture-decode-failed",
          "relocatable-texture-resources"
        ].includes(code),
      [...missingResourceIssues, ...caseMismatchIssues, ...unsafeResourceIssues, ...decodeFailedIssues, ...unsupportedMimeIssues]
    ),
    groupFromDiagnostics(
      "framing",
      "Model framing",
      "Far-away terrain, wrong bounds, or missing scene bounds can make first view, top view, rooms, and click targets frame the wrong area.",
      isSceneFramingDiagnostic
    ),
    groupFromDiagnostics(
      "references",
      "Material references",
      "Invalid material, texture, UV, or primitive references can make surfaces appear flat, green, black, or much poorer than the reference viewer.",
      (code) =>
        [
          "invalid-material-references",
          "invalid-texture-references",
          "textures-without-images",
          "invalid-uv-accessor-shapes",
          "invalid-tangent-accessor-shapes",
          "normal-maps-missing-tangents",
          "missing-uv-attributes",
          "textured-primitives-missing-uvs",
          "unassigned-primitive-materials",
          "duplicate-material-names"
        ].includes(code)
    ),
    groupFromDiagnostics(
      "overrides",
      "Saved overrides",
      "Stale object or navigation overrides after reimport can make hidden objects, blockers, top view, or movement roles behave unexpectedly.",
      (code) => ["stale-object-overrides", "invalid-object-navigation-behavior", "duplicate-node-names"].includes(code)
    )
  ];
}

function sourceQaReexportRequestText(projectId: string, group: SourceQaGroup, issues: readonly SourceQaIssue[]): string {
  const selectedIssues = issues.length > 0 ? issues : group.issues;
  const shownIssues = selectedIssues.slice(0, 6);
  const hiddenIssueCount = Math.max(0, selectedIssues.length - shownIssues.length);
  const issueLines = shownIssues.flatMap((issue, index) => sourceQaIssueEvidenceLines(issue, { index: index + 1 }));
  const requestByGroup: Record<string, string> = {
    structure: "Please re-export this as a valid glTF 2.0 GLB with a valid default scene, valid node/mesh/accessor references, and usable geometry bounds.",
    resources: "Please send the original zipped export with all texture/buffer folders preserved, or re-export as a self-contained GLB with resources embedded.",
    framing: "Please export the actual building near world origin and avoid letting large terrain/helper planes drive the scene bounds, first camera, or floorplan framing.",
    references: "Please preserve material texture assignments, UVs, texture image references, and material names so the web viewer can match the reference render.",
    overrides: "The model structure changed after a reimport. Please keep stable object/material names where possible so saved visibility, navigation, and interaction targets can be matched."
  };
  return [
    `Open Space source/export request - ${projectId}`,
    "",
    `Area: ${group.label}`,
    group.detail,
    "",
    "What we need:",
    requestByGroup[group.id] ?? "Please fix the source export issue below and resend the repaired GLB/ZIP.",
    "",
    "Detected issues:",
    ...issueLines.filter(Boolean),
    hiddenIssueCount > 0
      ? `Plus ${hiddenIssueCount} more issue${hiddenIssueCount === 1 ? "" : "s"} in this Source QA area.`
      : "",
    "",
    "After resending, we will reimport and rerun Studio QA before editing materials, rooms, navigation, or publishing."
  ].join("\n");
}

function SourceQaSummary({
  stats,
  projectId,
  apiConnected,
  repairState,
  onCopy,
  onCopyText,
  onRepair,
  onReviewDiagnostics
}: {
  stats: BundleStats;
  projectId: string;
  apiConnected: boolean;
  repairState: RepairState;
  onCopy: () => void;
  onCopyText: (value: string) => void;
  onRepair: () => void;
  onReviewDiagnostics: () => void;
}) {
  const groups = sourceQaGroups(stats);
  const issueGroups = groups.filter((group) => group.count > 0);
  const [selectedGroupId, setSelectedGroupId] = useState(issueGroups[0]?.id ?? groups[0]?.id ?? "");
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? issueGroups[0] ?? groups[0];
  const selectedIssues = selectedGroup?.issues ?? [];
  const hasErrors = groups.some((group) => group.severity === "error");
  const hasWarnings = groups.some((group) => group.severity === "warning");
  const status = hasErrors ? "error" : hasWarnings ? "warning" : "ready";
  const structureGroup = groups.find((group) => group.id === "structure");
  const resourcesGroup = groups.find((group) => group.id === "resources");
  const referencesGroup = groups.find((group) => group.id === "references");
  const framingGroup = groups.find((group) => group.id === "framing");
  const overridesGroup = groups.find((group) => group.id === "overrides");
  const sourcePackageIssueGroup =
    structureGroup && structureGroup.count > 0
      ? structureGroup
      : referencesGroup && referencesGroup.count > 0
        ? referencesGroup
        : undefined;
  const hasResourceIssues = Boolean(resourcesGroup && resourcesGroup.count > 0);
  const repairIssueCount = (framingGroup?.count ?? 0) + (overridesGroup?.count ?? 0);
  const totalIssueCount = issueGroups.reduce((sum, group) => sum + group.count, 0);
  return (
    <div className={`source-qa-card ${status}`}>
      <div className="source-qa-heading">
        <div>
          <strong>Source QA</strong>
          <p>
            {issueGroups.length > 0
              ? `${issueGroups.length} source/export area${issueGroups.length === 1 ? "" : "s"} need review before trusting viewer setup.`
              : "No source/export structure problem is currently flagged."}
          </p>
          <small>{projectId}</small>
        </div>
        <div className="source-qa-actions">
          <button type="button" className="button secondary compact-button" onClick={onCopy}>
            <Copy size={15} aria-hidden="true" />
            Copy QA
          </button>
          <button
            type="button"
            className="button secondary compact-button"
            disabled={!apiConnected || repairState === "repairing"}
            onClick={onRepair}
          >
            <Wrench size={15} aria-hidden="true" />
            {repairState === "repairing" ? "Repairing" : "Repair"}
          </button>
        </div>
      </div>
      <div className="source-qa-decision-board" aria-label="Source QA decision path">
        <div className={`source-qa-decision-card ${sourcePackageIssueGroup ? sourcePackageIssueGroup.severity : "ready"}`}>
          <span>{sourcePackageIssueGroup ? <AlertTriangle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</span>
          <div>
            <strong>Source export</strong>
            <small>
              {sourcePackageIssueGroup
                ? `${sourcePackageIssueGroup.count} source/model issue${sourcePackageIssueGroup.count === 1 ? "" : "s"} need the exporter.`
                : "Model structure and material references look usable."}
            </small>
          </div>
          <button
            type="button"
            className="button secondary compact-button"
            disabled={!sourcePackageIssueGroup}
            onClick={() => {
              if (sourcePackageIssueGroup) {
                setSelectedGroupId(sourcePackageIssueGroup.id);
                onCopyText(sourceQaReexportRequestText(projectId, sourcePackageIssueGroup, sourcePackageIssueGroup.issues));
              }
            }}
          >
            <Copy size={14} aria-hidden="true" />
            Copy Re-export
          </button>
        </div>
        <div className={`source-qa-decision-card ${hasResourceIssues && resourcesGroup ? resourcesGroup.severity : "ready"}`}>
          <span>{hasResourceIssues ? <AlertTriangle size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</span>
          <div>
            <strong>Texture/resource folder</strong>
            <small>
              {hasResourceIssues && resourcesGroup
                ? `${resourcesGroup.count} missing or risky resource${resourcesGroup.count === 1 ? "" : "s"}.`
                : "Referenced resources look present."}
            </small>
          </div>
          <button
            type="button"
            className="button secondary compact-button"
            disabled={!hasResourceIssues || !resourcesGroup}
            onClick={() => {
              if (resourcesGroup && hasResourceIssues) {
                setSelectedGroupId(resourcesGroup.id);
                onCopyText(sourceQaReexportRequestText(projectId, resourcesGroup, resourcesGroup.issues));
              }
            }}
          >
            <Copy size={14} aria-hidden="true" />
            Copy Resource Ask
          </button>
        </div>
        <div className={`source-qa-decision-card ${repairIssueCount > 0 ? "warning" : "ready"}`}>
          <span>{repairIssueCount > 0 ? <Wrench size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</span>
          <div>
            <strong>Studio repair</strong>
            <small>
              {repairIssueCount > 0
                ? `${repairIssueCount} framing or saved-override issue${repairIssueCount === 1 ? "" : "s"} can usually be repaired here.`
                : "No source-side repair issue is blocking Studio setup."}
            </small>
          </div>
          <button
            type="button"
            className="button secondary compact-button"
            disabled={!apiConnected || repairState === "repairing"}
            onClick={onRepair}
          >
            <Wrench size={14} aria-hidden="true" />
            {repairState === "repairing" ? "Repairing" : "Run Repair"}
          </button>
        </div>
        <div className={`source-qa-decision-card ${totalIssueCount > 0 ? "active" : "ready"}`}>
          <span>{totalIssueCount > 0 ? <FileJson size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</span>
          <div>
            <strong>Technical evidence</strong>
            <small>
              {totalIssueCount > 0
                ? `${totalIssueCount} source finding${totalIssueCount === 1 ? "" : "s"} are available if the model author needs proof.`
                : "No technical diagnostic evidence is needed right now."}
            </small>
          </div>
          <button
            type="button"
            className="button secondary compact-button"
            disabled={totalIssueCount === 0}
            onClick={onReviewDiagnostics}
          >
            <FileJson size={14} aria-hidden="true" />
            Evidence
          </button>
        </div>
      </div>
      <div className="source-qa-grid">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={`source-qa-item ${group.severity}${selectedGroup?.id === group.id ? " active" : ""}`}
            onClick={() => setSelectedGroupId(group.id)}
            disabled={group.count === 0}
          >
            <span>{group.count > 0 ? group.count : <Check size={15} aria-hidden="true" />}</span>
            <strong>{group.label}</strong>
            <small>{group.count > 0 ? group.detail : "Looks clear."}</small>
          </button>
        ))}
      </div>
      {selectedGroup && selectedGroup.count > 0 && (
        <div className={`source-qa-detail ${selectedGroup.severity}`}>
          <div className="source-qa-detail-heading">
            <div>
              <span>Selected source issue</span>
              <strong>{selectedGroup.label}</strong>
              <p>{selectedGroup.detail}</p>
            </div>
            <div className="source-qa-detail-actions">
              <button
                type="button"
                className="button secondary compact-button"
                onClick={() => onCopyText(sourceQaReexportRequestText(projectId, selectedGroup, selectedIssues))}
              >
                <Copy size={15} aria-hidden="true" />
                Copy Request
              </button>
              <button type="button" className="button secondary compact-button" onClick={onReviewDiagnostics}>
                <AlertTriangle size={15} aria-hidden="true" />
                Technical Evidence
              </button>
            </div>
          </div>
          <div className="source-qa-issue-list">
            {selectedIssues.slice(0, 4).map((issue, index) => (
              <div key={`${selectedGroup.id}-${issue.title}-${index}`} className={`source-qa-issue ${issue.severity}`}>
                <strong>{issue.title}</strong>
                <p>{issue.detail}</p>
                {issue.symptom && <small>Likely symptom: {issue.symptom}</small>}
                {issue.action && <small>Next action: {issue.action}</small>}
              </div>
            ))}
            {selectedIssues.length > 4 && (
              <p className="quiet-note">
                {selectedIssues.length - 4} more issue{selectedIssues.length - 4 === 1 ? "" : "s"} in this Source QA area.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function importActionForDiagnostic(code: string): ImportNextStepAction | undefined {
  if (isSceneFramingDiagnostic(code)) {
    return "repair";
  }

  if (isGreenPlaceholderDiagnostic(code) || isTextureConnectionDiagnostic(code)) {
    return "materials";
  }
  if (
    [
      "model-has-no-texture-images",
      "case-mismatched-model-resources",
      "embedded-texture-decode-failed",
      "sidecar-texture-decode-failed",
      "textured-primitives-missing-uvs",
      "normal-maps-missing-tangents",
      "unassigned-primitive-materials",
      "invalid-uv-accessor-shapes",
      "invalid-tangent-accessor-shapes",
      "missing-uv-attributes",
      "mostly-unlit-materials",
      "vertex-colors-detected",
      "many-transparent-materials",
      "dominant-transparent-surface",
      "transmission-materials",
      "dominant-untextured-material",
      "extreme-texture-aspect-ratios",
      "tiny-texture-dimensions"
    ].includes(code)
  ) {
    return "materials";
  }
  if (
    [
      "missing-model-resources",
      "relocatable-texture-resources",
    ].includes(code)
  ) {
    return "repair";
  }
  if (["missing-views"].includes(code)) {
    return "views";
  }
  if (
    [
      "no-named-floor-meshes",
      "ambiguous-flat-walk-surfaces",
      "flat-object-surfaces-may-catch-clicks",
      "generated-walk-zones-on-non-floor-objects",
      "multiple-floor-heights-detected",
      "no-named-collision-meshes",
      "missing-walk-zones",
      "missing-pass-zones",
      "disconnected-navigation-zones",
      "orphan-pass-zones",
      "narrow-pass-zones",
      "one-sided-pass-zones",
      "pass-zones-overlap-block-zones",
      "walk-zones-overlap-block-zones",
      "walk-zones-outside-navigation-bounds",
      "pass-zones-outside-navigation-bounds",
      "walk-views-outside-navigation-bounds",
      "walk-views-inside-block-zones",
      "walk-views-outside-walk-zones"
    ].includes(code)
  ) {
    return "navigation";
  }
  if (isObjectVisibilityDiagnostic(code)) {
    return "objects";
  }
  if (
    [
      "material-variants-missing-target",
      "material-variants-target-missing",
      "material-variants-no-options",
      "material-variants-invisible-options",
      "material-variants-generated-textures",
      "material-variants-missing-texture-assets"
    ].includes(code)
  ) {
    return "variants";
  }
  if (
    [
      "missing-room-map",
      "room-map-missing-bounds",
      "partial-room-map",
      "rooms-not-linked-to-views"
    ].includes(code)
  ) {
    return "rooms";
  }
  if (
    [
      "video-textures-missing-source",
      "video-textures-missing-target",
      "video-textures-target-missing",
      "hotspots-missing-content",
      "hotspots-invalid-position",
      "links-missing-url",
      "links-invalid-url",
      "links-invalid-position",
      "object-toggles-missing-target",
      "object-toggles-target-missing",
      "object-toggles-invalid-position"
    ].includes(code)
  ) {
    return "interactions";
  }
  if (
    [
      "missing-geometry-compression",
      "high-draw-primitive-count",
      "high-texture-memory-estimate",
      "missing-texture-compression",
      "oversized-texture-dimensions",
      "many-large-textures"
    ].includes(code)
  ) {
    return "optimize";
  }
  if (
    [
      "missing-normal-attributes",
      "invalid-normal-accessor-shapes",
      "unbaked-materials",
      "partial-lightmap-coverage",
      "lightmaps-missing-secondary-uvs",
      "some-lightmap-secondary-uvs-missing"
    ].includes(code)
  ) {
    return "bake";
  }
  if (isLightmapArtifactDiagnostic(code)) {
    return "bake";
  }
  if (isSourceStructureDiagnostic(code)) {
    return "review";
  }
  if (
    [
      "zero-scale-nodes",
      "negative-scale-nodes",
      "suspicious-node-scales",
      "invalid-material-references",
      "invalid-texture-references",
      "invalid-image-buffer-references",
      "unsafe-gltf-resource-paths",
      "unsupported-required-extensions",
      "unsupported-image-mime-types",
      "duplicate-node-names",
      "duplicate-material-names",
      "repeated-large-mesh-instances"
    ].includes(code)
  ) {
    return "review";
  }
  return undefined;
}

function publishActionForIssue(code: string): ImportNextStepAction | undefined {
  const diagnosticCode = code.startsWith("diagnostic-") ? code.slice("diagnostic-".length) : code;
  const diagnosticAction = importActionForDiagnostic(diagnosticCode);
  if (diagnosticAction) {
    return diagnosticAction;
  }
  if (code === "no-starting-views") {
    return "views";
  }
  if (code === "missing-assets") {
    return "repair";
  }
  if (
    [
      "large-uncompressed-model",
      "mobile-triangle-budget",
      "mobile-mesh-budget",
      "mobile-total-size-budget",
      "missing-gpu-texture-compression",
      "oversized-textures",
      "desktop-triangle-budget"
    ].includes(code)
  ) {
    return "optimize";
  }
  if (code === "missing-navigation-bounds") {
    return "navigation";
  }
  return undefined;
}

function nextStepCopy(action: ImportNextStepAction): ImportNextStep {
  if (action === "apply-textures") {
    return {
      action,
      title: "Apply texture matches",
      detail: "Apply high-confidence texture-folder matches before judging material quality in the viewer.",
      button: "Apply Matches"
    };
  }
  if (action === "repair") {
    return {
      action,
      title: "Repair import first",
      detail: "Regenerate focused bounds, views, rooms, navigation zones, and recover texture paths where possible.",
      button: "Repair Import"
    };
  }
  if (action === "optimize") {
    return {
      action,
      title: "Optimize for web",
      detail: "Review the performance board, then create an optimized GLB artifact when the risk is clear.",
      button: "Review Performance"
    };
  }
  if (action === "bake") {
    return {
      action,
      title: "Improve lighting",
      detail: "Review bake readiness and lightmap risk before running the Blender/Cycles workflow.",
      button: "Review Bake"
    };
  }
  if (action === "review") {
    return {
      action,
      title: "Fix the source export",
      detail: "Review Source QA first, then use the technical diagnostics underneath only as evidence for re-export or source-file fixes.",
      button: "Review Source QA"
    };
  }
  if (action === "environment") {
    return {
      action,
      title: "Fix exterior context",
      detail: "Review ground, enclosure, sky, and first-frame context when the scene opens on grass, terrain, or empty exterior space.",
      button: "Fix Context"
    };
  }
  if (action === "materials") {
    return {
      action,
      title: "Repair materials",
      detail: "Inspect missing, loose, broken, or placeholder texture assignments before judging model quality.",
      button: "Review Materials"
    };
  }
  if (action === "variants") {
    return {
      action,
      title: "Fix finish variants",
      detail: "Target the right mesh/material and add visible color or texture options.",
      button: "Set Finishes"
    };
  }
  if (action === "views") {
    return {
      action,
      title: "Create views",
      detail: "Create a starting camera and client-facing room viewpoints.",
      button: "Set Views"
    };
  }
  if (action === "navigation") {
    return {
      action,
      title: "Fix navigation",
      detail: "Open the guided Controls tools to inspect walk areas, door passes, blockers, and generated zones.",
      button: "Fix Navigation"
    };
  }
  if (action === "objects") {
    return {
      action,
      title: "Review object visibility",
      detail: "Check ceilings, roof shells, helper meshes, and object roles that affect top view or movement.",
      button: "Review Objects"
    };
  }
  if (action === "rooms") {
    return {
      action,
      title: "Map rooms",
      detail: "Create room labels, floorplan areas, and links from room buttons to saved walk views.",
      button: "Map Rooms"
    };
  }
  if (action === "interactions") {
    return {
      action,
      title: "Fix interactions",
      detail: "Finish video screens, hotspots, links, and object toggles.",
      button: "Set Interactions"
    };
  }
  return {
    action,
    title: "Test in viewer",
    detail: "The import report has no blocking action. Open the viewer and test walking, click movement, and room buttons.",
    button: "Open Viewer"
  };
}

type RepairCenterSeverity = "error" | "warning" | "info" | "ready";
const repairCenterStageOrder = [
  "Source",
  "Visuals",
  "Movement",
  "Presentation",
  "Interactions",
  "Lighting",
  "Context",
  "Performance",
  "Delivery"
];

interface RepairCenterItem {
  id: string;
  stage: string;
  title: string;
  detail: string;
  visualFix: string;
  severity: RepairCenterSeverity;
  action: ImportNextStepAction;
  button: string;
}

interface RepairCenterStageSummary {
  stage: string;
  severity: RepairCenterSeverity;
  label: string;
  count: number;
}

function repairCenterStageForAction(action: ImportNextStepAction): string {
  if (action === "repair" || action === "review") {
    return "Source";
  }
  if (action === "materials" || action === "apply-textures") {
    return "Visuals";
  }
  if (action === "variants") {
    return "Visuals";
  }
  if (action === "navigation") {
    return "Movement";
  }
  if (action === "objects") {
    return "Presentation";
  }
  if (action === "rooms" || action === "views") {
    return "Presentation";
  }
  if (action === "interactions") {
    return "Interactions";
  }
  if (action === "bake") {
    return "Lighting";
  }
  if (action === "optimize") {
    return "Performance";
  }
  if (action === "environment") {
    return "Context";
  }
  return "Delivery";
}

function repairCenterSeverityRank(severity: RepairCenterSeverity): number {
  if (severity === "error") {
    return 0;
  }
  if (severity === "warning") {
    return 1;
  }
  if (severity === "info") {
    return 2;
  }
  return 3;
}

function repairCenterStageRank(stage: string): number {
  const index = repairCenterStageOrder.indexOf(stage);
  return index === -1 ? repairCenterStageOrder.length : index;
}

function repairCenterStageSummaries(items: readonly RepairCenterItem[], hasStats: boolean): RepairCenterStageSummary[] {
  return repairCenterStageOrder.map((stage) => {
    const stageItems = items.filter((item) => item.stage === stage);
    const hasError = stageItems.some((item) => item.severity === "error");
    const hasWarning = stageItems.some((item) => item.severity === "warning");
    const hasReady = stageItems.some((item) => item.severity === "ready");
    const severity: RepairCenterSeverity = !hasStats && stage !== "Source"
      ? "info"
      : hasError
        ? "error"
        : hasWarning
          ? "warning"
          : hasReady || stageItems.length === 0
            ? "ready"
            : "info";
    const label = !hasStats && stage !== "Source"
      ? "Waiting"
      : hasError
        ? "Blocked"
        : hasWarning
          ? "Review"
          : hasReady
            ? "Test"
            : stageItems.length === 0
              ? "Clear"
              : "Start";
    return {
      stage,
      severity,
      label,
      count: stageItems.length
    };
  });
}

function repairCenterIcon(action: ImportNextStepAction) {
  if (action === "repair") {
    return <Wrench size={17} aria-hidden="true" />;
  }
  if (action === "materials" || action === "variants" || action === "apply-textures" || action === "bake") {
    return <Palette size={17} aria-hidden="true" />;
  }
  if (action === "navigation" || action === "views") {
    return <MapPin size={17} aria-hidden="true" />;
  }
  if (action === "objects") {
    return <Eye size={17} aria-hidden="true" />;
  }
  if (action === "rooms") {
    return <Layers3 size={17} aria-hidden="true" />;
  }
  if (action === "interactions") {
    return <Video size={17} aria-hidden="true" />;
  }
  if (action === "environment") {
    return <Globe2 size={17} aria-hidden="true" />;
  }
  if (action === "optimize") {
    return <Activity size={17} aria-hidden="true" />;
  }
  if (action === "test") {
    return <ExternalLink size={17} aria-hidden="true" />;
  }
  return <AlertTriangle size={17} aria-hidden="true" />;
}

function repairCenterVisualFixForAction(action: ImportNextStepAction): string {
  if (action === "apply-textures") {
    return "Review the thumbnail match, then apply the suggested image automatically.";
  }
  if (action === "materials") {
    return "Compare texture previews and click Base, Normal, Emissive, or Lightmap on the right image.";
  }
  if (action === "variants") {
    return "Pick the target mesh/material and confirm each finish has a visible swatch or texture.";
  }
  if (action === "navigation") {
    return "Use the zone map to paint walk areas, door passes, and blockers over the floorplan.";
  }
  if (action === "objects") {
    return "Review Objects, check ceiling/roof/top-view meshes, and set visibility or navigation roles from the visual object list.";
  }
  if (action === "rooms") {
    return "Sync walk areas into room regions, then adjust the room map visually.";
  }
  if (action === "interactions") {
    return "Pick detected TV/screen surfaces and attach video, hotspot, or link behavior.";
  }
  if (action === "bake") {
    return "Choose a quality preset, bake, then inspect lightmap thumbnails before publishing.";
  }
  if (action === "environment") {
    return "Toggle ground, enclosure, and exterior context presets while checking the viewer frame.";
  }
  if (action === "views") {
    return "Save a camera viewpoint and use it as the starting or room view.";
  }
  if (action === "optimize") {
    return "Run a visual quality profile, then compare size, texture, and mobile readiness.";
  }
  if (action === "test") {
    return "Open the viewer and test click movement, WASD, wheel movement, rooms, and top view.";
  }
  if (action === "repair") {
    return "Use Import health cards to review the visible symptom, then run repair to rebuild bounds, views, rooms, navigation, and missing paths.";
  }
  return "Use the guided card first; technical diagnostics stay available only when deeper source repair is needed.";
}

function diagnosticVisualSymptom(code: string): string | null {
  if (
    [
      "malformed-model",
      "invalid-default-scene",
      "default-scene-has-no-renderable-meshes",
      "missing-gltf-scene-definitions",
      "meshes-outside-default-scene",
      "invalid-scene-node-references",
      "invalid-node-child-references",
      "invalid-node-mesh-references"
    ].includes(code)
  ) {
    return "the model may open blank, partial, or differently from the source viewer.";
  }
  if (["invalid-node-transforms", "zero-scale-nodes", "negative-scale-nodes", "suspicious-node-scales"].includes(code)) {
    return "parts may look flattened, mirrored, huge, tiny, or the auto bounds/navigation may be wrong.";
  }
  if (isSceneFramingDiagnostic(code)) {
    return "first view, top view, room map, click targets, or movement bounds may frame the wrong area.";
  }
  if (["invalid-position-accessor-shapes", "invalid-index-accessor-shapes"].includes(code)) {
    return "geometry may look missing, torn, spiky, or impossible to click/walk on reliably.";
  }
  if (code === "non-triangle-primitives") {
    return "line, point, strip, or fan geometry may optimize inconsistently or behave unpredictably as a click/collision surface.";
  }
  if (["invalid-material-references", "invalid-texture-references", "textures-without-images"].includes(code)) {
    return "surfaces may render as flat colors, black/green placeholders, or missing textures.";
  }
  if (
    [
      "missing-model-resources",
      "invalid-image-buffer-references",
      "case-mismatched-model-resources",
      "unsafe-gltf-resource-paths",
      "unsupported-required-extensions",
      "embedded-texture-decode-failed",
      "sidecar-texture-decode-failed",
      "unsupported-image-mime-types",
      "relocatable-texture-resources"
    ].includes(code)
  ) {
    return "textures, buffers, or model features may be missing even if the file technically loads.";
  }
  if (
    [
      "model-has-no-texture-images",
      "loose-textures-not-referenced",
      "generic-loose-texture-names",
      "image-textures-unused-by-materials",
      "few-materials-use-textures",
      "many-unused-texture-images",
      "many-transparent-materials",
      "dominant-transparent-surface",
      "transmission-materials",
      "dominant-untextured-material",
      "dominant-green-placeholder-material"
    ].includes(code)
  ) {
    if (code === "transmission-materials") {
      return "windows or glass may look different from the source tool or cost more GPU time on mobile after optimization.";
    }
    if (code === "many-transparent-materials" || code === "dominant-transparent-surface") {
      return "walls, ceilings, floors, or windows may look see-through, hollow, or sorted in the wrong order.";
    }
    if (code === "dominant-green-placeholder-material") {
      return "the viewer may be showing a large grass/placeholder-colored surface instead of the detailed building materials.";
    }
    return "the model can look much poorer than the reference because material images are not actually assigned.";
  }
  if (code === "unbaked-materials") {
    return "the walkthrough may look flat or real-time-lit instead of having soft baked shadows and interior light depth.";
  }
  if (code === "partial-lightmap-coverage") {
    return "some rooms or surfaces may have baked depth while others still look flat or disconnected.";
  }
  if (
    [
      "tiny-texture-dimensions",
      "extreme-texture-aspect-ratios",
      "textured-primitives-missing-uvs",
      "normal-maps-missing-tangents",
      "invalid-tangent-accessor-shapes"
    ].includes(code)
  ) {
    return "textures may look blurry, stretched, shimmering, or mismatched on the surface.";
  }
  if (["no-named-ceiling-meshes"].includes(code)) {
    return "ceiling or roof handling may need manual object review, especially for top view.";
  }
  if (
    [
      "hotspots-missing-content",
      "hotspots-invalid-position",
      "links-missing-url",
      "links-invalid-url",
      "links-invalid-position",
      "object-toggles-invalid-position"
    ].includes(code)
  ) {
    return "the viewer may show dead markers, confusing icons, or links that do nothing during client review.";
  }
  if (["repeated-large-mesh-instances"].includes(code)) {
    return "the scene may load slowly or feel heavy because duplicated geometry dominates the model.";
  }
  if (["duplicate-node-names", "duplicate-material-names"].includes(code)) {
    return "saved object, screen, finish, interaction, or lightmap targets may attach to the wrong surface after import or reimport.";
  }
  if (code === "generated-walk-zones-on-non-floor-objects") {
    return "click-to-move may jump onto furniture, decor, doors, windows, ceilings, or roofs instead of staying on real floors.";
  }
  return null;
}

function diagnosticVisualSymptomSummary(diagnostics: readonly { code: string }[]): string | null {
  for (const diagnostic of diagnostics) {
    const symptom = diagnosticVisualSymptom(diagnostic.code);
    if (symptom) {
      return symptom;
    }
  }
  return null;
}

function repairCenterDestinationForItem(item: RepairCenterItem): string {
  if (item.id === "upload") {
    return "Opens the upload drop zone.";
  }
  if (item.id === "scene-framing") {
    return "Opens scene framing repair.";
  }
  if (item.id === "green-placeholder-material") {
    return "Opens material diagnosis.";
  }
  if (item.id === "texture-connection") {
    return "Opens texture previews.";
  }
  if (item.id === "lightmap-artifacts") {
    return "Opens lightmap preview.";
  }
  if (item.id === "source-structure") {
    return "Opens Source QA.";
  }
  if (item.action === "repair") {
    return "Opens import repair.";
  }
  if (item.action === "apply-textures" || item.action === "materials") {
    return "Opens material diagnosis.";
  }
  if (item.action === "variants") {
    return "Opens finish setup.";
  }
  if (item.action === "navigation") {
    return "Opens guided navigation repair.";
  }
  if (item.action === "objects") {
    return "Opens object visibility and roles.";
  }
  if (item.action === "rooms") {
    return "Opens room map.";
  }
  if (item.action === "interactions") {
    return "Opens screen planner.";
  }
  if (item.action === "bake") {
    return "Opens bake readiness.";
  }
  if (item.action === "environment") {
    return "Opens context preview.";
  }
  if (item.action === "views") {
    return "Opens view setup.";
  }
  if (item.action === "optimize") {
    return "Opens performance review.";
  }
  if (item.action === "test") {
    return "Opens the viewer.";
  }
  return "Opens Source QA.";
}

function repairCenterVerifyForItem(item: RepairCenterItem): string {
  if (item.id === "upload") {
    return "After upload, the progress strip should replace Waiting states with specific repair areas.";
  }
  if (item.id === "scene-framing") {
    return "After repair, first load, top view, room buttons, and click-to-move should frame the actual building.";
  }
  if (item.id === "green-placeholder-material") {
    return "After review, compare against the reference viewer and confirm the building no longer reads as one large green/plain surface.";
  }
  if (item.id === "texture-connection") {
    return "After review, compare against the reference viewer and confirm walls, floors, wood, fabric, and decor textures are actually assigned.";
  }
  if (item.id === "lightmap-artifacts") {
    return "After rebake or relink, inspect thumbnails first, then compare soft shadows and seams in the viewer.";
  }
  if (item.id === "source-structure") {
    return "After re-export, reimport and confirm the card is gone before spending time on materials, rooms, or navigation.";
  }
  if (item.id === "object-visibility") {
    return "After review, top view should show the floor plan clearly and walk clicks should no longer be affected by stale or wrong object roles.";
  }
  if (item.action === "repair") {
    return "After repair, return here and confirm blocker counts or source warnings decreased.";
  }
  if (item.action === "apply-textures" || item.action === "materials") {
    return "After assigning textures, compare the viewer against the reference model and check that flat/plain surfaces improved.";
  }
  if (item.action === "variants") {
    return "After saving, open the viewer and confirm each finish option changes the intended surface.";
  }
  if (item.action === "navigation") {
    return "After saving, open the viewer and click through the doorway or floor area that previously failed.";
  }
  if (item.action === "objects") {
    return "After saving, open top view and walk mode to confirm ceiling/roof visibility and object roles behave correctly.";
  }
  if (item.action === "rooms") {
    return "After mapping rooms, top view should show readable room regions and room buttons should jump to the right view.";
  }
  if (item.action === "interactions") {
    return "After mapping interactions, test the screen/video or hotspot directly in the viewer.";
  }
  if (item.action === "bake") {
    return "After baking, inspect lightmap thumbnails and then compare shadows/lighting in the viewer.";
  }
  if (item.action === "environment") {
    return "After changing context, the first view should no longer open to unwanted grass, empty space, or a confusing exterior.";
  }
  if (item.action === "views") {
    return "After saving views, use the viewer room buttons and top view to confirm the camera framing.";
  }
  if (item.action === "optimize") {
    return "After optimization, rerun analysis and confirm the publish/mobile warnings shrink without visual damage.";
  }
  if (item.action === "test") {
    return "Pass when click-to-move, WASD, wheel movement, rooms, top view, and key interactions work in the viewer.";
  }
  return "After reviewing, return to Repair Center and confirm the card is gone or moved lower priority.";
}

function repairCenterChangeForItem(item: RepairCenterItem): string {
  if (item.id === "upload") {
    return "Adds the model to Studio and creates the first automated repair queue.";
  }
  if (item.id === "source-structure") {
    return "Does not change the current project until a cleaner source export is uploaded.";
  }
  if (item.action === "apply-textures") {
    return "Fills empty material texture slots from high-confidence loose-image matches.";
  }
  if (item.action === "materials") {
    return "Changes only the material or texture slot the user reviews and applies.";
  }
  if (item.action === "variants") {
    return "Updates finish variant targets and visible swatch or texture options.";
  }
  if (item.action === "navigation") {
    return "Updates walk areas, door passes, blockers, or movement bounds.";
  }
  if (item.action === "objects") {
    return "Updates object visibility, top-view cleanup, or navigation roles.";
  }
  if (item.action === "rooms") {
    return "Updates room regions, room labels, and linked room views.";
  }
  if (item.action === "views") {
    return "Updates the saved camera viewpoints clients use to start and switch rooms.";
  }
  if (item.action === "interactions") {
    return "Maps screens, videos, hotspots, links, or object toggles.";
  }
  if (item.action === "bake") {
    return "Creates or reviews baked lightmap assets before they are used in the viewer.";
  }
  if (item.action === "environment") {
    return "Updates the outside ground, sky, enclosure, or review background.";
  }
  if (item.action === "optimize") {
    return "Creates an optimized preview bundle before it is applied to the viewer.";
  }
  if (item.action === "test") {
    return "Saves current Studio edits and opens the viewer for manual QA.";
  }
  if (item.action === "repair") {
    return "Rebuilds generated bounds, focused views, room regions, navigation, and missing-path repair data.";
  }
  return "Routes to the relevant review panel without hiding the technical diagnostic evidence.";
}

function repairCenterRiskForItem(item: RepairCenterItem): { label: string; detail: string; tone: RepairCenterSeverity } {
  if (item.id === "source-structure") {
    return {
      label: "Source fix",
      detail: "Best fixed by re-exporting the original model before editing viewer setup.",
      tone: "error"
    };
  }
  if (item.action === "apply-textures") {
    return {
      label: "Low",
      detail: "Only applies confident empty-slot matches; weaker matches stay for manual review.",
      tone: "ready"
    };
  }
  if (item.action === "materials" || item.action === "variants" || item.action === "objects" || item.action === "interactions" || item.action === "environment") {
    return {
      label: "Manual",
      detail: "User picks the visible target before saving, so the change is controlled.",
      tone: "warning"
    };
  }
  if (item.action === "navigation" || item.action === "rooms" || item.action === "views" || item.action === "repair") {
    return {
      label: "Medium",
      detail: "Can affect movement or framing; save and test the viewer after applying.",
      tone: "warning"
    };
  }
  if (item.action === "bake" || item.action === "optimize") {
    return {
      label: "Preview first",
      detail: "Creates reviewable output before it should be trusted for client delivery.",
      tone: "warning"
    };
  }
  if (item.action === "test") {
    return {
      label: "No edit",
      detail: "Opens the viewer for QA and should not change project data beyond saving draft edits.",
      tone: "ready"
    };
  }
  return {
    label: "Review",
    detail: "Open the guided panel and confirm visually before saving or publishing.",
    tone: "info"
  };
}

function repairCenterFixBriefText({
  projectId,
  title,
  item,
  itemIndex,
  totalItems,
  stats,
  publishChecks
}: {
  projectId: string;
  title: string;
  item: RepairCenterItem;
  itemIndex: number;
  totalItems: number;
  stats: BundleStats | null;
  publishChecks: readonly PublishCheck[];
}): string {
  const risk = repairCenterRiskForItem(item);
  const unresolvedPublishChecks = publishChecks.filter((check) => !check.ready);
  const lines = [
    `Open Space repair brief - ${title}`,
    `Project: ${projectId}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "Priority:",
    `- Queue position: ${itemIndex + 1} of ${Math.max(totalItems, 1)}`,
    `- Stage: ${item.stage}`,
    `- Severity: ${item.severity}`,
    `- Action: ${item.button}`,
    "",
    "Issue:",
    `- ${item.title}`,
    `- ${item.detail}`,
    "",
    "Visual fix:",
    `- ${item.visualFix}`,
    `- Opens: ${repairCenterDestinationForItem(item)}`,
    "",
    "What changes:",
    `- ${repairCenterChangeForItem(item)}`,
    "",
    "Risk:",
    `- ${risk.label}: ${risk.detail}`,
    "",
    "How to verify:",
    `- ${repairCenterVerifyForItem(item)}`,
    "",
    "Scene context:",
    stats
      ? `- Bundle: ${formatBytes(stats.totalBytes)}, model: ${formatBytes(stats.modelBytes)}, triangles: ${stats.triangleCount}, draw primitives: ${stats.primitiveCount ?? stats.meshCount}`
      : "- Bundle analysis has not run yet.",
    stats?.publishReadiness
      ? `- Publish gate: ${stats.publishReadiness.status}, ${stats.publishReadiness.blockers.length} blocker(s), ${stats.publishReadiness.warnings.length} warning(s)`
      : "- Publish gate: not analyzed",
    unresolvedPublishChecks.length > 0
      ? `- Other publish rows needing attention: ${unresolvedPublishChecks.slice(0, 4).map((check) => check.label).join(", ")}`
      : "- Other publish rows needing attention: none",
    "",
    "Operator notes:",
    "- Start from the visual panel named above instead of editing JSON.",
    "- Save and open the viewer after the fix.",
    item.action === "navigation"
      ? "- Use the navigation debug viewer and retest the exact blocked doorway, floor click, or wall boundary."
      : "- Use the normal viewer and compare the result against the original reference or client expectation.",
    "- Return to Repair Center and confirm this card is cleared or lower priority before publishing."
  ];

  return lines.filter(Boolean).join("\n");
}

function buildRepairCenterItems({
  stats,
  manifest,
  publishChecks,
  pendingTextureSuggestionCount,
  reviewTextureSuggestionCount
}: {
  stats: BundleStats | null;
  manifest: SceneManifest;
  publishChecks: readonly PublishCheck[];
  pendingTextureSuggestionCount: number;
  reviewTextureSuggestionCount: number;
}): RepairCenterItem[] {
  const items: RepairCenterItem[] = [];
  const modelOffset = manifest.rendering?.modelOffset;
  const hasModelOffset = Boolean(modelOffset?.some((value) => Math.abs(value) > 0.01));
  if (!stats) {
    return [
      {
        id: "upload",
        stage: "Source",
        title: "Upload a model",
        detail: "Start with a GLB or ZIP so Studio can analyze visual quality, navigation, rooms, and publish readiness.",
        visualFix: "Drop the source file here; Studio will build the repair queue from the analyzed model.",
        severity: "info",
        action: "repair",
        button: "Open Import"
      }
    ];
  }

  if (hasModelOffset && stats.diagnostics?.some((diagnostic) => diagnostic.code === "scene-far-from-origin")) {
    items.push({
      id: "origin-auto-centered",
      stage: "Source",
      title: "Model is auto-centered in the viewer",
      detail: `The source model is far from world origin, but Import Repair now shifts it by ${modelOffset?.map((value) => value.toFixed(1)).join(", ")} in the walkthrough so camera views, room maps, and click movement frame the building.`,
      visualFix: "Open the viewer and confirm the first view, top view, room buttons, and click-to-move land on the actual building.",
      severity: "ready",
      action: "test",
      button: "Open Viewer"
    });
  }

  if (pendingTextureSuggestionCount > 0) {
    items.push({
      id: "texture-ready",
      stage: "Visuals",
      title: "Review confident texture matches",
      detail: `${pendingTextureSuggestionCount} loose texture match${pendingTextureSuggestionCount === 1 ? "" : "es"} can be assigned after checking the image preview.`,
      visualFix: repairCenterVisualFixForAction("apply-textures"),
      severity: "warning",
      action: "apply-textures",
      button: `Review ${pendingTextureSuggestionCount}`
    });
  }
  if (reviewTextureSuggestionCount > 0) {
    items.push({
      id: "texture-review",
      stage: "Visuals",
      title: "Review texture matches",
      detail: `${reviewTextureSuggestionCount} weaker texture match${reviewTextureSuggestionCount === 1 ? "" : "es"} need a human check against the preview.`,
      visualFix: repairCenterVisualFixForAction("materials"),
      severity: "warning",
      action: "materials",
      button: `Review ${reviewTextureSuggestionCount}`
    });
  }

  const diagnosticsByAction = new Map<ImportNextStepAction, NonNullable<BundleStats["diagnostics"]>>();
  const sceneFramingDiagnostics = (stats.diagnostics ?? []).filter(
    (diagnostic) =>
      diagnostic.severity !== "info" &&
      isSceneFramingDiagnostic(diagnostic.code) &&
      !(hasModelOffset && diagnostic.code === "scene-far-from-origin")
  );
  const greenPlaceholderDiagnostic = (stats.diagnostics ?? []).find(
    (diagnostic) => diagnostic.severity !== "info" && isGreenPlaceholderDiagnostic(diagnostic.code)
  );
  const textureConnectionDiagnostics = (stats.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity !== "info" && isTextureConnectionDiagnostic(diagnostic.code)
  );
  const lightmapArtifactDiagnostics = (stats.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity !== "info" && isLightmapArtifactDiagnostic(diagnostic.code)
  );
  const objectVisibilityDiagnostics = (stats.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity !== "info" && isObjectVisibilityDiagnostic(diagnostic.code)
  );
  const sourceStructureDiagnostics = (stats.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity !== "info" && isSourceStructureDiagnostic(diagnostic.code)
  );
  if (sourceStructureDiagnostics.length > 0) {
    const first = sourceStructureDiagnostics[0]!;
    items.push({
      id: "source-structure",
      stage: "Source",
      title: "Re-export source model",
      detail: `${sourceStructureDiagnostics.length} source structure issue${sourceStructureDiagnostics.length === 1 ? "" : "s"} found: ${first.title}. ${first.message}`,
      visualFix: "Use Source QA to copy the exact broken GLB/GLTF evidence, re-export from the source tool as valid glTF 2.0/GLB, then reimport before editing viewer materials, rooms, or navigation.",
      severity: sourceStructureDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning",
      action: "review",
      button: "Review Export"
    });
  }
  if (sceneFramingDiagnostics.length > 0) {
    const first = sceneFramingDiagnostics[0]!;
    items.push({
      id: "scene-framing",
      stage: "Source",
      title: "Repair scene framing",
      detail: `${sceneFramingDiagnostics.length} framing issue${sceneFramingDiagnostics.length === 1 ? "" : "s"} found: ${first.title}. First load, top view, room map, or click targets may be looking at terrain, empty space, or the wrong part of the model.`,
      visualFix: "Open Import, check the Scene Framing card, then run Repair Framing to rebuild focused views, bounds, rooms, and navigation from the actual building footprint.",
      severity: sceneFramingDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning",
      action: "repair",
      button: "Repair Framing"
    });
  }
  if (greenPlaceholderDiagnostic) {
    items.push({
      id: "green-placeholder-material",
      stage: "Visuals",
      title: "Green/plain surface dominates",
      detail: `${greenPlaceholderDiagnostic.title}: ${greenPlaceholderDiagnostic.message}`,
      visualFix: "Review Materials and compare the dominant green/plain material against loose texture previews. If it is only generated grass or exterior context, switch to Environment after confirming the building materials are correct.",
      severity: greenPlaceholderDiagnostic.severity === "error" ? "error" : "warning",
      action: "materials",
      button: "Review Surface"
    });
  }
  if (textureConnectionDiagnostics.length > 0) {
    const first = textureConnectionDiagnostics[0]!;
    const suggestions = pendingTextureSuggestionCount + reviewTextureSuggestionCount;
    items.push({
      id: "texture-connection",
      stage: "Visuals",
      title: suggestions > 0 ? "Connect texture-folder images" : "Texture folder is not connected",
      detail: `${textureConnectionDiagnostics.length} texture connection issue${textureConnectionDiagnostics.length === 1 ? "" : "s"} found: ${first.title}. ${first.message}`,
      visualFix:
        suggestions > 0
          ? "Review Materials, compare the suggested texture thumbnails, then apply or reject them surface by surface before judging visual quality."
          : "Review Materials and inspect loose texture previews. If the filenames are generic or no safe matches appear, ask for the original GLTF ZIP with texture paths preserved or re-export a GLB with embedded textures.",
      severity: textureConnectionDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning",
      action: "materials",
      button: suggestions > 0 ? "Review Matches" : "Review Textures"
    });
  }
  if (lightmapArtifactDiagnostics.length > 0) {
    const first = lightmapArtifactDiagnostics[0]!;
    items.push({
      id: "lightmap-artifacts",
      stage: "Lighting",
      title: "Review baked lightmap output",
      detail: `${lightmapArtifactDiagnostics.length} lightmap issue${lightmapArtifactDiagnostics.length === 1 ? "" : "s"} found: ${first.title}. ${first.message}`,
      visualFix: "Review Bake, inspect the generated lightmap thumbnails for blank/tiny/flat images, then rebake or relink only the failing material lightmaps before publishing.",
      severity: lightmapArtifactDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning",
      action: "bake",
      button: "Review Bake"
    });
  }
  if (objectVisibilityDiagnostics.length > 0) {
    const first = objectVisibilityDiagnostics[0]!;
    const hasCeilingIssue = objectVisibilityDiagnostics.some((diagnostic) => diagnostic.code === "no-named-ceiling-meshes");
    items.push({
      id: "object-visibility",
      stage: "Presentation",
      title: hasCeilingIssue ? "Review ceiling and top-view objects" : "Review object roles",
      detail: `${objectVisibilityDiagnostics.length} object visibility issue${objectVisibilityDiagnostics.length === 1 ? "" : "s"} found: ${first.title}. ${first.message}`,
      visualFix: "Review Objects and use the visual list to hide ceiling/roof shell meshes from top view only, confirm key interior objects stay visible, and fix any stale navigation roles after reimport.",
      severity: objectVisibilityDiagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "warning",
      action: "objects",
      button: "Review Objects"
    });
  }
  for (const diagnostic of stats.diagnostics ?? []) {
    if (diagnostic.severity === "info") {
      continue;
    }
    if (hasModelOffset && diagnostic.code === "scene-far-from-origin") {
      continue;
    }
    if (isSceneFramingDiagnostic(diagnostic.code)) {
      continue;
    }
    if (isGreenPlaceholderDiagnostic(diagnostic.code)) {
      continue;
    }
    if (isTextureConnectionDiagnostic(diagnostic.code)) {
      continue;
    }
    if (isLightmapArtifactDiagnostic(diagnostic.code)) {
      continue;
    }
    if (isObjectVisibilityDiagnostic(diagnostic.code)) {
      continue;
    }
    if (isSourceStructureDiagnostic(diagnostic.code)) {
      continue;
    }
    const action = importActionForDiagnostic(diagnostic.code) ?? "review";
    diagnosticsByAction.set(action, [...(diagnosticsByAction.get(action) ?? []), diagnostic]);
  }
  for (const [action, diagnostics] of diagnosticsByAction) {
    const copy = nextStepCopy(action);
    const sample = diagnostics.slice(0, 2).map((diagnostic) => diagnostic.title).join("; ");
    const symptom = diagnosticVisualSymptomSummary(diagnostics);
    const hasError = diagnostics.some((diagnostic) => diagnostic.severity === "error");
    items.push({
      id: `diagnostics-${action}`,
      stage: repairCenterStageForAction(action),
      title: copy.title,
      detail: `${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"} found${sample ? `: ${sample}` : ""}.${symptom ? ` Likely symptom: ${symptom}` : ""}`,
      visualFix: repairCenterVisualFixForAction(action),
      severity: hasError ? "error" : "warning",
      action,
      button: copy.button
    });
  }

  for (const check of publishChecks.filter((check) => !check.ready).slice(0, 3)) {
    const action = check.action ?? "review";
    const copy = nextStepCopy(action);
    items.push({
      id: `publish-${check.id}`,
      stage: "Delivery",
      title: check.blocking ? `Publish blocker: ${check.label}` : `Publish warning: ${check.label}`,
      detail: check.detail,
      visualFix: repairCenterVisualFixForAction(action),
      severity: check.blocking ? "error" : "warning",
      action,
      button: copy.button
    });
  }

  if (manifest.views.length === 0) {
    items.push({
      id: "missing-views",
      stage: "Presentation",
      title: "Create a starting view",
      detail: "A walkthrough needs at least one saved camera before it feels client-ready.",
      visualFix: repairCenterVisualFixForAction("views"),
      severity: "error",
      action: "views",
      button: "Set Views"
    });
  }

  const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
  if (uniqueItems.length === 0) {
    return [
      {
        id: "test-viewer",
        stage: "Delivery",
        title: "Test the walkthrough",
        detail: "The automated report has no blocking repair items. Open the viewer and test click movement, WASD, rooms, top view, and publish flow.",
        visualFix: repairCenterVisualFixForAction("test"),
        severity: "ready",
        action: "test",
        button: "Open Viewer"
      }
    ];
  }
  return uniqueItems.sort((a, b) => repairCenterSeverityRank(a.severity) - repairCenterSeverityRank(b.severity));
}

function RepairCenter({
  stats,
  manifest,
  publishChecks,
  pendingTextureSuggestionCount,
  reviewTextureSuggestionCount,
  repairState,
  optimizeState,
  bakeState,
  onImport,
  onAction,
  onSaveAndTest,
  onCopyFixBrief
}: {
  stats: BundleStats | null;
  manifest: SceneManifest;
  publishChecks: readonly PublishCheck[];
  pendingTextureSuggestionCount: number;
  reviewTextureSuggestionCount: number;
  repairState: RepairState;
  optimizeState: OptimizeState;
  bakeState: BakeState;
  onImport: () => void;
  onAction: (action: ImportNextStepAction) => void;
  onSaveAndTest: (navigationDebug?: boolean) => void;
  onCopyFixBrief: (item: RepairCenterItem, itemIndex: number, totalItems: number) => void;
}) {
  const items = buildRepairCenterItems({
    stats,
    manifest,
    publishChecks,
    pendingTextureSuggestionCount,
    reviewTextureSuggestionCount
  });
  const blockerCount = items.filter((item) => item.severity === "error").length;
  const warningCount = items.filter((item) => item.severity === "warning").length;
  const groupedItems = [...items.reduce((groups, item) => {
    groups.set(item.stage, [...(groups.get(item.stage) ?? []), item]);
    return groups;
  }, new Map<string, RepairCenterItem[]>())].sort(
    ([stageA], [stageB]) => repairCenterStageRank(stageA) - repairCenterStageRank(stageB)
  );
  const stageSummaries = repairCenterStageSummaries(items, Boolean(stats));
  const stagePreviewItems = stageSummaries.map((summary) => ({
    summary,
    item: items.find((candidate) => candidate.stage === summary.stage)
  }));
  const runRepairCenterItem = (item: RepairCenterItem) => {
    if (item.id === "upload") {
      onImport();
      return;
    }
    if (item.action === "test") {
      onSaveAndTest(false);
      return;
    }
    onAction(item.action);
  };
  const saveAndTestRepairItem = (item: RepairCenterItem) => {
    onSaveAndTest(item.action === "navigation");
  };
  const scrollToRepairStage = (stage: string) => {
    document
      .querySelector(`[data-repair-stage="${stage}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const currentItem = items[0] ?? {
    id: "test-viewer",
    stage: "Delivery",
    title: "Test the walkthrough",
    detail: "The automated report has no blocking repair items.",
    visualFix: repairCenterVisualFixForAction("test"),
    severity: "ready" as const,
    action: "test" as const,
    button: "Open Viewer"
  };
  const currentButtonLabel = currentItem.id === "upload"
    ? "Upload Model"
    : currentItem.action === "test"
      ? "Open Viewer"
      : "Start Visual Fix";
  const currentRisk = repairCenterRiskForItem(currentItem);
  const currentItemIndex = Math.max(0, items.findIndex((item) => item.id === currentItem.id));

  return (
    <section className="repair-center-layout">
      <div className="panel repair-center-hero">
        <div>
          <span className="eyebrow">Guided setup</span>
          <h2>{currentItem.severity === "ready" ? "Walkthrough is ready for manual testing" : currentItem.title}</h2>
          <p>
            {currentItem.severity === "ready"
              ? "Studio found no blocking automated repair item. Run the viewer checklist before publishing."
              : "Fix the first card, save if needed, then come back here for the next item."}
          </p>
        </div>
        <div className="repair-center-side">
          <div className="repair-center-score">
            <strong>{blockerCount}</strong>
            <span>blockers</span>
            <small>{warningCount} warning{warningCount === 1 ? "" : "s"}</small>
          </div>
          <div className="repair-center-side-actions">
            <button
              type="button"
              className="button secondary repair-center-next"
              onClick={() => onCopyFixBrief(currentItem, currentItemIndex, items.length)}
            >
              <Copy size={16} aria-hidden="true" />
              Copy Fix Brief
            </button>
            <button type="button" className="button primary repair-center-next" onClick={() => runRepairCenterItem(currentItem)}>
              {repairCenterIcon(currentItem.action)}
              {currentButtonLabel}
            </button>
            {currentItem.action !== "test" && (
              <button
                type="button"
                className="button secondary repair-center-next"
                disabled={!stats}
                onClick={() => saveAndTestRepairItem(currentItem)}
              >
                <Save size={16} aria-hidden="true" />
                {currentItem.action === "navigation" ? "Save & Test Nav" : "Save & Test"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="repair-center-fix-preview" aria-label="Current visual fix preview">
        <div className={`repair-center-preview-card ${currentItem.severity}`}>
          <span>{repairCenterIcon(currentItem.action)}</span>
          <div>
            <strong>Current fix</strong>
            <p>{currentItem.visualFix}</p>
          </div>
        </div>
        <div className="repair-center-preview-grid">
          <div>
            <small>What changes</small>
            <strong>{repairCenterChangeForItem(currentItem)}</strong>
          </div>
          <div className={`repair-center-risk ${currentRisk.tone}`}>
            <small>Risk</small>
            <strong>{currentRisk.label}</strong>
            <p>{currentRisk.detail}</p>
          </div>
          <div>
            <small>Visual check</small>
            <strong>{repairCenterVerifyForItem(currentItem)}</strong>
          </div>
        </div>
      </div>

      <div className="repair-center-progress" aria-label="Repair Center progress">
        {stageSummaries.map((summary) => (
          <button
            key={summary.stage}
            type="button"
            className={`repair-center-progress-step ${summary.severity}`}
            onClick={() => scrollToRepairStage(summary.stage)}
            disabled={summary.count === 0}
            aria-label={`Show ${summary.stage} repair items: ${summary.label}`}
          >
            <strong>{summary.stage}</strong>
            <span>{summary.label}</span>
            {summary.count > 0 && <small>{summary.count}</small>}
          </button>
        ))}
      </div>

      <div className="repair-center-issue-map" aria-label="Visual repair map">
        {stagePreviewItems.map(({ summary, item }) => (
          <button
            key={summary.stage}
            type="button"
            className={`repair-center-map-card ${summary.severity}`}
            onClick={() => scrollToRepairStage(summary.stage)}
            disabled={!item}
          >
            <span className="repair-center-map-icon">
              {item ? repairCenterIcon(item.action) : <Check size={17} aria-hidden="true" />}
            </span>
            <span className="repair-center-map-main">
              <strong>{summary.stage}</strong>
              <small>{summary.label}</small>
              <p>
                {item
                  ? item.title
                  : stats
                    ? "No visual fix needed here."
                    : summary.stage === "Source"
                      ? "Upload a model first."
                      : "Waiting for analysis."}
              </p>
              {item && <em>{item.visualFix}</em>}
            </span>
          </button>
        ))}
      </div>

      <div className="repair-center-list">
        {groupedItems.map(([stage, stageItems]) => (
          <section key={stage} className="repair-center-stage" data-repair-stage={stage}>
            <div className="repair-center-stage-heading">
              <strong>{stage}</strong>
              <small>
                {stageItems.length} item{stageItems.length === 1 ? "" : "s"}
              </small>
            </div>
            {stageItems.map((item) => {
              const itemIndex = items.findIndex((candidate) => candidate.id === item.id);
              const buttonLabel =
                item.action === "repair" && repairState === "repairing"
                  ? "View Repair"
                  : item.action === "optimize" && optimizeState === "optimizing"
                    ? "View Optimize"
                    : item.action === "bake" && bakeState === "baking"
                      ? "View Bake"
                      : item.button;
              return (
                <div key={item.id} className={`repair-center-card ${item.severity}`}>
                  <div className="repair-center-index">
                    {item.severity === "ready" ? <Check size={18} aria-hidden="true" /> : itemIndex + 1}
                  </div>
                  <div className="repair-center-main">
                    <div className="repair-center-card-heading">
                      <span>{item.stage}</span>
                      <strong>{item.title}</strong>
                    </div>
                    <p>{item.detail}</p>
                    <small className="repair-center-visual-fix">Visual fix: {item.visualFix}</small>
                    <small className="repair-center-verify">Check: {repairCenterVerifyForItem(item)}</small>
                    <small className="repair-center-destination">{repairCenterDestinationForItem(item)}</small>
                  </div>
                  <div className="repair-center-card-actions">
                    <button
                      type="button"
                      className="button secondary repair-center-action"
                      onClick={() => onCopyFixBrief(item, itemIndex, items.length)}
                    >
                      <Copy size={15} aria-hidden="true" />
                      Copy Brief
                    </button>
                    <button
                      type="button"
                      className="button secondary repair-center-action"
                      onClick={() => runRepairCenterItem(item)}
                    >
                      {repairCenterIcon(item.action)}
                      {buttonLabel}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </section>
  );
}

function ImportNextSteps({
  stats,
  apiConnected,
  repairState,
  optimizeState,
  bakeState,
  onRepair,
  onOptimize,
  onBake,
  onEnvironment,
  onMaterials,
  onVariants,
  onViews,
  onNavigation,
  onRooms,
  onInteractions,
  onReviewDiagnostics,
  pendingTextureSuggestionCount = 0,
  reviewTextureSuggestionCount = 0,
  onApplyTextureSuggestions,
  onTest
}: {
  stats: BundleStats | null;
  apiConnected: boolean;
  repairState: RepairState;
  optimizeState: OptimizeState;
  bakeState: BakeState;
  onRepair: () => void;
  onOptimize: () => void;
  onBake: () => void;
  onEnvironment: () => void;
  onMaterials: () => void;
  onVariants: () => void;
  onViews: () => void;
  onNavigation: () => void;
  onRooms: () => void;
  onInteractions: () => void;
  onReviewDiagnostics: () => void;
  pendingTextureSuggestionCount?: number;
  reviewTextureSuggestionCount?: number;
  onApplyTextureSuggestions?: () => void;
  onTest: () => void;
}) {
  const diagnostics = stats?.diagnostics ?? [];
  const priority = diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
  const actions = [
    ...new Set(priority.map((diagnostic) => importActionForDiagnostic(diagnostic.code)).filter(Boolean))
  ] as ImportNextStepAction[];
  const prioritizedActions =
    pendingTextureSuggestionCount > 0 && onApplyTextureSuggestions
      ? (["apply-textures", ...actions.filter((action) => action !== "materials")] as ImportNextStepAction[])
      : reviewTextureSuggestionCount > 0
        ? (["materials", ...actions.filter((action) => action !== "materials")] as ImportNextStepAction[])
      : actions;
  const steps = (prioritizedActions.length > 0 ? prioritizedActions : priority.length > 0 ? ["review" as const] : ["test" as const])
    .slice(0, 3)
    .map((action) => {
      const step = nextStepCopy(action);
      if (action === "apply-textures") {
        return { ...step, button: `Apply ${pendingTextureSuggestionCount}` };
      }
      if (action === "materials" && pendingTextureSuggestionCount === 0 && reviewTextureSuggestionCount > 0) {
        return {
          ...step,
          title: "Review texture matches",
          detail: "Review Materials to inspect lower-confidence texture-folder matches before applying them.",
          button: `Review ${reviewTextureSuggestionCount}`
        };
      }
      return step;
    });
  const firstIssue = priority[0];
  const headingHint =
    pendingTextureSuggestionCount > 0
      ? `${pendingTextureSuggestionCount} texture match${pendingTextureSuggestionCount === 1 ? "" : "es"} ready`
      : reviewTextureSuggestionCount > 0
        ? `${reviewTextureSuggestionCount} texture match${reviewTextureSuggestionCount === 1 ? "" : "es"} need review`
      : firstIssue
        ? firstIssue.title
        : "Import report looks usable";

  return (
    <div className="import-next-steps">
      <div className="compact-panel-heading">
        <strong>Recommended next step</strong>
        <small>{headingHint}</small>
      </div>
      {steps.map((step) => {
        const disabled =
          (step.action === "repair" && (!apiConnected || repairState === "repairing")) ||
          (step.action === "optimize" && (!apiConnected || optimizeState === "optimizing")) ||
          (step.action === "bake" && (!apiConnected || bakeState === "baking"));
        const onClick =
          step.action === "repair"
            ? onRepair
            : step.action === "apply-textures"
              ? onApplyTextureSuggestions ?? onMaterials
            : step.action === "environment"
              ? onEnvironment
            : step.action === "materials"
              ? onMaterials
            : step.action === "variants"
              ? onVariants
            : step.action === "views"
              ? onViews
            : step.action === "navigation"
              ? onNavigation
              : step.action === "rooms"
                ? onRooms
            : step.action === "interactions"
              ? onInteractions
            : step.action === "optimize"
              ? onOptimize
              : step.action === "bake"
                ? onBake
              : step.action === "review"
                ? onReviewDiagnostics
                : onTest;
        return (
          <div key={step.action} className={`import-next-step ${step.action}`}>
            <div>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </div>
            <button type="button" className="button secondary" disabled={disabled} onClick={onClick}>
              {step.action === "repair" && <Wrench size={15} aria-hidden="true" />}
              {step.action === "apply-textures" && <Palette size={15} aria-hidden="true" />}
              {step.action === "environment" && <Globe2 size={15} aria-hidden="true" />}
              {step.action === "materials" && <Palette size={15} aria-hidden="true" />}
              {step.action === "views" && <MapPin size={15} aria-hidden="true" />}
              {step.action === "navigation" && <MapPin size={15} aria-hidden="true" />}
              {step.action === "rooms" && <Layers3 size={15} aria-hidden="true" />}
              {step.action === "interactions" && <Video size={15} aria-hidden="true" />}
              {step.action === "optimize" && <Activity size={15} aria-hidden="true" />}
              {step.action === "bake" && <Palette size={15} aria-hidden="true" />}
              {step.action === "review" && <AlertTriangle size={15} aria-hidden="true" />}
              {step.action === "test" && <ExternalLink size={15} aria-hidden="true" />}
              {step.button}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ViewerQaChecklist({
  manifest,
  controls,
  stats,
  objects,
  viewerUrl,
  navigationViewerUrl,
  onMaterials,
  onEnvironment,
  onNavigation,
  onRooms,
  onViews,
  onBake,
  onInteractions,
  onOptimize,
  onObjects,
  onPublish,
  onReviewDiagnostics,
  onSaveAndTest,
  onSaveAndTestNavigation,
  onCopyReport
}: {
  manifest: SceneManifest;
  controls: SceneControlsDocument | null;
  stats: BundleStats | null;
  objects: ObjectsDocument | null;
  viewerUrl: string;
  navigationViewerUrl: string;
  onMaterials: () => void;
  onEnvironment: () => void;
  onNavigation: () => void;
  onRooms: () => void;
  onViews: () => void;
  onBake: () => void;
  onInteractions: () => void;
  onOptimize: () => void;
  onObjects: () => void;
  onPublish: () => void;
  onReviewDiagnostics: () => void;
  onSaveAndTest: () => void;
  onSaveAndTestNavigation: () => void;
  onCopyReport: () => void;
}) {
  const diagnostics = stats?.diagnostics ?? [];
  const movementComfort = movementComfortStatus(controls, manifest);
  const diagnosticCodes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
  const errorCodes = new Set(
    diagnostics.filter((diagnostic) => diagnostic.severity === "error").map((diagnostic) => diagnostic.code)
  );
  const materialCodes = [
    "model-has-no-texture-images",
    "loose-textures-not-referenced",
    "generic-loose-texture-names",
    "image-textures-unused-by-materials",
    "few-materials-use-textures",
    "many-unused-texture-images",
    "embedded-texture-decode-failed",
    "sidecar-texture-decode-failed",
    "textured-primitives-missing-uvs",
    "dominant-untextured-material",
    "many-transparent-materials",
    "dominant-transparent-surface",
    "transmission-materials",
    "tiny-texture-dimensions",
    "extreme-texture-aspect-ratios",
    "material-variants-missing-target",
    "material-variants-target-missing",
    "material-variants-no-options",
    "material-variants-invisible-options",
    "material-variants-generated-textures",
    "material-variants-missing-texture-assets"
  ];
  const navigationCodes = [
    "missing-walk-zones",
    "missing-pass-zones",
    "disconnected-navigation-zones",
    "orphan-pass-zones",
    "narrow-pass-zones",
    "one-sided-pass-zones",
    "pass-zones-overlap-block-zones",
    "walk-zones-overlap-block-zones",
    "generated-walk-zones-on-non-floor-objects",
    "walk-zones-outside-navigation-bounds",
    "pass-zones-outside-navigation-bounds",
    "walk-views-inside-block-zones",
    "walk-views-outside-walk-zones"
  ];
  const roomCodes = ["missing-room-map", "room-map-missing-bounds", "partial-room-map", "rooms-not-linked-to-views"];
  const lightingCodes = [
    "missing-lightmap-assets",
    "tiny-lightmap-assets",
    "unbaked-materials",
    "partial-lightmap-coverage",
    "lightmaps-missing-secondary-uvs",
    "some-lightmap-secondary-uvs-missing",
    "missing-normal-attributes",
    "invalid-normal-accessor-shapes"
  ];
  const interactionCodes = [
    "hotspots-missing-content",
    "hotspots-invalid-position",
    "links-missing-url",
    "links-invalid-url",
    "links-invalid-position",
    "video-textures-missing-source",
    "video-textures-missing-target",
    "video-textures-target-missing",
    "object-toggles-missing-target",
    "object-toggles-target-missing",
    "object-toggles-invalid-position"
  ];
  const performanceDiagnosticCodes = [
    "missing-geometry-compression",
    "high-draw-primitive-count",
    "high-texture-memory-estimate",
    "missing-texture-compression",
    "oversized-texture-dimensions",
    "many-large-textures",
    "repeated-large-mesh-instances"
  ];
  const performancePublishCodes = [
    "large-uncompressed-model",
    "mobile-triangle-budget",
    "mobile-draw-primitive-budget",
    "mobile-texture-memory-budget",
    "mobile-mesh-budget",
    "mobile-total-size-budget",
    "missing-gpu-texture-compression",
    "oversized-textures",
    "mobile-total-bytes",
    "mobile-model-bytes",
    "mobile-triangles",
    "mobile-draw-primitives",
    "mobile-texture-memory",
    "mobile-materials",
    "mobile-meshes"
  ];
  const sourceExportCodes = [
    "malformed-model",
    "invalid-default-scene",
    "default-scene-has-no-renderable-meshes",
    "missing-gltf-scene-definitions",
    "meshes-outside-default-scene",
    "non-triangle-primitives",
    "invalid-scene-node-references",
    "invalid-node-child-references",
    "invalid-node-mesh-references",
    "invalid-node-transforms",
    "zero-scale-nodes",
    "negative-scale-nodes",
    "suspicious-node-scales",
    "invalid-position-accessor-shapes",
    "invalid-index-accessor-shapes",
    "invalid-material-references",
    "invalid-texture-references",
    "invalid-image-buffer-references",
    "duplicate-node-names",
    "duplicate-material-names",
    "large-coordinate-units",
    "scene-far-from-origin",
    "missing-scene-bounds",
    "missing-model-resources",
    "case-mismatched-model-resources",
    "unsafe-gltf-resource-paths",
    "unsupported-required-extensions",
    "embedded-texture-decode-failed",
    "sidecar-texture-decode-failed",
    "unsupported-image-mime-types",
    "relocatable-texture-resources",
    "stale-object-overrides",
    "invalid-object-navigation-behavior"
  ];
  const environmentCodes = [
    "dominant-flat-plane",
    "initial-view-on-dominant-plane",
    "dominant-green-placeholder-material",
    "focused-model-small-in-scene",
    "initial-view-misses-focused-model"
  ];
  const objectCodes = [
    "no-named-ceiling-meshes",
    "stale-object-overrides",
    "invalid-object-navigation-behavior"
  ];
  const visualIssue = materialCodes.find((code) => diagnosticCodes.has(code));
  const environmentIssue = environmentCodes.find((code) => diagnosticCodes.has(code));
  const objectIssue = objectCodes.find((code) => diagnosticCodes.has(code));
  const lightingIssue = lightingCodes.find((code) => diagnosticCodes.has(code));
  const interactionIssue = interactionCodes.find((code) => diagnosticCodes.has(code));
  const sourceIssue = sourceExportCodes.find((code) => diagnosticCodes.has(code));
  const performanceDiagnosticIssue = performanceDiagnosticCodes.find((code) => diagnosticCodes.has(code));
  const performancePublishIssue = [
    ...(stats?.publishReadiness?.blockers ?? []),
    ...(stats?.publishReadiness?.warnings ?? [])
  ].find((issue) => performancePublishCodes.includes(issue.code));
  const performanceIssue = performanceDiagnosticIssue ?? performancePublishIssue?.code;
  const navigationIssue = navigationCodes.find((code) => diagnosticCodes.has(code));
  const roomIssue = roomCodes.find((code) => diagnosticCodes.has(code));
  const viewPublishIssue = [
    ...(stats?.publishReadiness?.blockers ?? []),
    ...(stats?.publishReadiness?.warnings ?? [])
  ].find((issue) => issue.code === "no-starting-views" || issue.code === "diagnostic-missing-views");
  const viewIssue = diagnosticCodes.has("missing-views") ? "missing-views" : viewPublishIssue?.code;
  const walkViewCount = manifest.views.filter((view) => view.kind === "walk").length;
  const topViewCount = manifest.views.filter((view) => view.kind === "top").length;
  const hiddenTopViewObjectCount = objects?.objects.filter((object) => object.hideInTopView).length ?? 0;
  const navigationRoleObjectCount =
    objects?.objects.filter((object) => object.navigationBehavior && object.navigationBehavior !== "default").length ?? 0;
  const toneMappingLabel = manifest.rendering?.toneMapping ?? "aces";
  const exposureLabel = (manifest.rendering?.exposure ?? 1.05).toFixed(2);
  const videoTextureCount = manifest.interactions.filter((interaction) => interaction.kind === "video-texture").length;
  const hotspotCount = manifest.interactions.filter((interaction) => interaction.kind === "hotspot").length;
  const linkCount = manifest.interactions.filter((interaction) => interaction.kind === "link").length;
  const objectToggleCount = manifest.interactions.filter((interaction) => interaction.kind === "object-toggle").length;
  const interactionCount = videoTextureCount + hotspotCount + linkCount + objectToggleCount;
  const walkZones = enabledNavigationZones(manifest.navigation, "walk");
  const passZones = enabledNavigationZones(manifest.navigation, "pass");
  const hasNavigationSetup = Boolean(manifest.navigation.bounds) && walkZones.length > 0 && manifest.views.some((view) => view.kind === "walk");
  const publishStatus = stats?.publishReadiness?.status;
  const checks = [
    {
      id: "source",
      label: "Source export health",
      detail: sourceIssue
        ? "The GLB/export structure, resources, or saved overrides need source review before repair work is trusted."
        : "No blocking source-export diagnostics are listed for this bundle.",
      status: sourceIssue && errorCodes.has(sourceIssue) ? "blocked" : sourceIssue ? "warn" : "ready",
      button: sourceIssue ? "Review Source QA" : "Open Viewer",
      onClick: sourceIssue ? onReviewDiagnostics : onSaveAndTest
    },
    {
      id: "visuals",
      label: "Visual match",
      detail: visualIssue
        ? "Material or texture diagnostics should be reviewed before judging model quality."
        : "Open the viewer and compare textures, colors, glass, ceiling, and exterior context.",
      status: visualIssue && errorCodes.has(visualIssue) ? "blocked" : visualIssue ? "warn" : "ready",
      button: visualIssue ? "Review Materials" : "Open Viewer",
      onClick: visualIssue ? onMaterials : onSaveAndTest
    },
    {
      id: "render-profile",
      label: "Render profile",
      detail: `Tone mapping is ${toneMappingLabel}; exposure is ${exposureLabel}. If a reference GLB viewer looks closer, try Linear match or None/raw before changing materials.`,
      status: "ready",
      button: "Tune Render",
      onClick: onNavigation
    },
    {
      id: "environment",
      label: "Exterior context",
      detail: environmentIssue
        ? "The first view, terrain plane, or focused building context needs review."
        : manifest.environment?.groundEnabled || manifest.environment?.enclosureEnabled
          ? "Check windows, exterior views, grass/ground, and landscape enclosure scale."
          : "Environment is in neutral/interior mode; confirm windows and outside areas do not look empty.",
      status: environmentIssue && errorCodes.has(environmentIssue) ? "blocked" : environmentIssue ? "warn" : "ready",
      button: environmentIssue ? "Fix Context" : "Open Viewer",
      onClick: environmentIssue ? onEnvironment : onSaveAndTest
    },
    {
      id: "views",
      label: "Views and framing",
      detail: viewIssue
        ? "Starting, walk, or top views need setup before viewer review."
        : `${manifest.views.length} saved view(s): ${walkViewCount} walk, ${topViewCount} top. Check first load, room buttons, and top-view framing.`,
      status: viewIssue ? "blocked" : manifest.views.length === 0 || walkViewCount === 0 ? "warn" : "ready",
      button: viewIssue || manifest.views.length === 0 || walkViewCount === 0 ? "Set Views" : "Open Viewer",
      onClick: viewIssue || manifest.views.length === 0 || walkViewCount === 0 ? onViews : onSaveAndTest
    },
    {
      id: "objects",
      label: "Object visibility and roles",
      detail: objectIssue
        ? "Object diagnostics need review before trusting top view, visibility, or navigation blockers."
        : objects
          ? `${hiddenTopViewObjectCount} object(s) hidden in top view; ${navigationRoleObjectCount} object(s) have explicit navigation roles.`
          : "Object graph is not loaded yet; run analysis before checking top-view hiding or navigation roles.",
      status: objectIssue && errorCodes.has(objectIssue) ? "blocked" : objectIssue || !objects ? "warn" : "ready",
      button: objectIssue || !objects || topViewCount > 0 ? "Review Objects" : "Open Viewer",
      onClick: objectIssue || !objects || topViewCount > 0 ? onObjects : onSaveAndTest
    },
    {
      id: "lighting",
      label: "Baked lighting",
      detail: lightingIssue
        ? "Lighting, normals, or lightmap diagnostics should be reviewed before client visual review."
        : (stats?.lightmapMaterialCount ?? 0) > 0
          ? "Open the viewer and inspect soft shadows, bright seams, blank lightmaps, and flat baked areas."
          : "No lightmapped materials are configured yet; bake lighting when the scene needs Shapespark-like realism.",
      status: lightingIssue && errorCodes.has(lightingIssue) ? "blocked" : lightingIssue || (stats?.lightmapMaterialCount ?? 0) === 0 ? "warn" : "ready",
      button: lightingIssue || (stats?.lightmapMaterialCount ?? 0) === 0 ? "Review Bake" : "Open Viewer",
      onClick: lightingIssue || (stats?.lightmapMaterialCount ?? 0) === 0 ? onBake : onSaveAndTest
    },
    {
      id: "movement",
      label: "Movement basics",
      detail: hasNavigationSetup
        ? `${movementComfort.label}: ${movementComfort.detail}`
        : "Set bounds, walk views, and at least one walk zone before testing movement.",
      status: hasNavigationSetup ? movementComfort.tone : "blocked",
      button: hasNavigationSetup ? "Debug Viewer" : "Fix Navigation",
      onClick: hasNavigationSetup ? onSaveAndTestNavigation : onNavigation
    },
    {
      id: "doors",
      label: "Door and wall rules",
      detail: navigationIssue
        ? "Door passes, blockers, or route islands need review before room entry can be trusted."
        : passZones.length > 0
          ? "Click through doorways and confirm walls, windows, cupboards, and exterior bounds reject movement."
          : "If rooms are separate, draw green door passes before testing entry between rooms.",
      status: navigationIssue && errorCodes.has(navigationIssue) ? "blocked" : navigationIssue || passZones.length === 0 ? "warn" : "ready",
      button: navigationIssue || passZones.length === 0 ? "Fix Navigation" : "Debug Viewer",
      onClick: navigationIssue || passZones.length === 0 ? onNavigation : onSaveAndTestNavigation
    },
    {
      id: "rooms",
      label: "Rooms and top view",
      detail: roomIssue
        ? "Room labels, floorplan regions, or view links need setup."
        : "Check room buttons, minimap position, and top-view readability.",
      status: roomIssue ? "warn" : "ready",
      button: roomIssue ? "Map Rooms" : "Set Views",
      onClick: roomIssue ? onRooms : onViews
    },
    {
      id: "interactions",
      label: "Screens and hotspots",
      detail: interactionIssue
        ? "Video screens have missing media or target surfaces."
        : interactionCount > 0
          ? `Test ${videoTextureCount} video screen(s), ${hotspotCount} hotspot(s), ${linkCount} link(s), and ${objectToggleCount} object toggle(s).`
          : "No TV screens, hotspots, links, or object toggles are configured yet.",
      status: interactionIssue && errorCodes.has(interactionIssue) ? "blocked" : interactionIssue || interactionCount === 0 ? "warn" : "ready",
      button: interactionIssue || interactionCount === 0 ? "Set Interactions" : "Open Viewer",
      onClick: interactionIssue || interactionCount === 0 ? onInteractions : onSaveAndTest
    },
    {
      id: "performance",
      label: "Mobile performance",
      detail: performanceIssue
        ? "Optimization, compression, or mobile budget warnings should be reviewed before sharing."
        : stats
          ? `Check load time and smoothness; ${stats.triangleCount} triangles, ${stats.meshCount} meshes, ${formatBytes(stats.totalBytes)} total bundle.`
          : "Run analysis before checking mobile performance.",
      status: performanceIssue && (performanceDiagnosticIssue ? errorCodes.has(performanceDiagnosticIssue) : false) ? "blocked" : performanceIssue || !stats ? "warn" : "ready",
      button: performanceIssue || !stats ? "Review Performance" : "Open Viewer",
      onClick: performanceIssue || !stats ? onOptimize : onSaveAndTest
    },
    {
      id: "publish",
      label: "Client readiness",
      detail:
        publishStatus === "ready"
          ? "Publish gate is ready; use the Publish tab for versioning and deploy dry-run checks."
          : publishStatus === "blocked"
            ? "Publish has blockers that should be fixed before sharing."
            : publishStatus === "warning"
              ? "Publish has warnings; fix them or treat the build as a draft."
              : "Run analysis before checking publish readiness.",
      status: publishStatus === "ready" ? "ready" : publishStatus === "blocked" ? "blocked" : "warn",
      button: "Publish Checklist",
      onClick: onPublish
    }
  ] as const;

  return (
    <div className="import-next-steps viewer-qa-checklist">
      <div className="compact-panel-heading">
        <strong>Viewer QA checklist</strong>
        <button type="button" className="button secondary compact-button" onClick={onCopyReport}>
          <Copy size={15} aria-hidden="true" />
          Copy Report
        </button>
      </div>
      <p className="quiet-note">Use this after every import or repair.</p>
      <div className="publish-readiness-list">
        {checks.map((check) => (
          <div key={check.id} className={`readiness-row ${check.status}`}>
            <div>
              <span>{check.label}</span>
              <small>{check.detail}</small>
            </div>
            <button type="button" className="button secondary compact-button readiness-action" onClick={check.onClick}>
              {check.button === "Open Viewer" && <ExternalLink size={15} aria-hidden="true" />}
              {check.button === "Debug Viewer" && <ExternalLink size={15} aria-hidden="true" />}
              {check.button === "Review Materials" && <Palette size={15} aria-hidden="true" />}
              {check.button === "Fix Context" && <Globe2 size={15} aria-hidden="true" />}
              {check.button === "Review Bake" && <Palette size={15} aria-hidden="true" />}
              {(check.button === "Tune Render" || check.button === "Fix Navigation") && <MapPin size={15} aria-hidden="true" />}
              {check.button === "Map Rooms" && <Layers3 size={15} aria-hidden="true" />}
              {check.button === "Set Views" && <MapPin size={15} aria-hidden="true" />}
              {check.button === "Review Objects" && <Eye size={15} aria-hidden="true" />}
              {check.button === "Set Interactions" && <Video size={15} aria-hidden="true" />}
              {check.button === "Review Performance" && <Activity size={15} aria-hidden="true" />}
              {check.button === "Publish Checklist" && <ExternalLink size={15} aria-hidden="true" />}
              {check.button === "Review Source QA" && <AlertTriangle size={15} aria-hidden="true" />}
              {check.button}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function viewerQaReportText(
  manifest: SceneManifest,
  controls: SceneControlsDocument | null,
  stats: BundleStats | null,
  objects: ObjectsDocument | null,
  viewerUrl: string,
  navigationViewerUrl: string
): string {
  const diagnostics = stats?.diagnostics ?? [];
  const actionableDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity !== "info").slice(0, 6);
  const sourceExportDiagnostics = diagnostics.filter((diagnostic) =>
    [
      "malformed-model",
      "invalid-default-scene",
      "default-scene-has-no-renderable-meshes",
      "missing-gltf-scene-definitions",
      "meshes-outside-default-scene",
      "non-triangle-primitives",
      "invalid-scene-node-references",
      "invalid-node-child-references",
      "invalid-node-mesh-references",
      "invalid-node-transforms",
      "zero-scale-nodes",
      "negative-scale-nodes",
      "suspicious-node-scales",
      "invalid-position-accessor-shapes",
      "invalid-index-accessor-shapes",
      "invalid-material-references",
      "invalid-texture-references",
      "invalid-image-buffer-references",
      "duplicate-node-names",
      "duplicate-material-names",
      "large-coordinate-units",
      "scene-far-from-origin",
      "missing-scene-bounds",
      "missing-model-resources",
      "unsafe-gltf-resource-paths",
      "unsupported-required-extensions",
      "stale-object-overrides",
      "invalid-object-navigation-behavior"
    ].includes(diagnostic.code)
  );
  const coverage = navigationCoverage(manifest);
  const walkViewCount = manifest.views.filter((view) => view.kind === "walk").length;
  const orbitViewCount = manifest.views.filter((view) => view.kind === "orbit").length;
  const topViewCount = manifest.views.filter((view) => view.kind === "top").length;
  const hiddenTopViewObjectCount = objects?.objects.filter((object) => object.hideInTopView).length ?? 0;
  const forcedWalkObjectCount = objects?.objects.filter((object) => object.navigationBehavior === "walk").length ?? 0;
  const forcedCollisionObjectCount = objects?.objects.filter((object) => object.navigationBehavior === "collision").length ?? 0;
  const ignoredNavigationObjectCount = objects?.objects.filter((object) => object.navigationBehavior === "ignore").length ?? 0;
  const videoTextureCount = manifest.interactions.filter((interaction) => interaction.kind === "video-texture").length;
  const hotspotCount = manifest.interactions.filter((interaction) => interaction.kind === "hotspot").length;
  const linkCount = manifest.interactions.filter((interaction) => interaction.kind === "link").length;
  const objectToggleCount = manifest.interactions.filter((interaction) => interaction.kind === "object-toggle").length;
  const movementComfort = movementComfortStatus(controls, manifest);
  const publishReadiness = stats?.publishReadiness;
  const publishIssues = [
    ...(publishReadiness?.blockers ?? []).map((issue) => `BLOCKER: ${issue.title} - ${issue.message}`),
    ...(publishReadiness?.warnings ?? []).map((issue) => `WARNING: ${issue.title} - ${issue.message}`)
  ].slice(0, 6);
  const lines = [
    `Open Space QA Report - ${manifest.branding.title}`,
    `Viewer: ${viewerUrl}`,
    `Navigation debug viewer: ${navigationViewerUrl}`,
    "",
    "Scene stats:",
    `- Total bundle: ${formatBytes(stats?.totalBytes ?? 0)}`,
    `- Model size: ${formatBytes(stats?.modelBytes ?? 0)}`,
    `- Triangles: ${stats?.triangleCount ?? 0}`,
    `- Draw primitives: ${stats?.primitiveCount ?? stats?.meshCount ?? 0}`,
    `- Meshes: ${stats?.meshCount ?? 0}`,
    `- Materials: ${stats?.materialCount ?? 0}`,
    `- Scene span: ${typeof stats?.sceneLargestDimension === "number" ? `${stats.sceneLargestDimension.toFixed(1)} units` : "unknown"}`,
    `- Scene center from origin: ${typeof stats?.sceneFootprintCenterDistance === "number" ? `${stats.sceneFootprintCenterDistance.toFixed(1)} units` : "unknown"}`,
    `- Focused center from origin: ${typeof stats?.focusedFootprintCenterDistance === "number" ? `${stats.focusedFootprintCenterDistance.toFixed(1)} units` : "unknown"}`,
    stats?.modelOffset
      ? `- Viewer model offset: ${stats.modelOffset.map((value) => value.toFixed(1)).join(", ")} (${(stats.modelOffsetDistance ?? 0).toFixed(1)} units applied)`
      : "",
    `- Textured materials: ${stats?.texturedMaterialCount ?? 0}/${stats?.materialCount ?? 0}`,
    `- Estimated texture RAM: ${formatBytes(stats?.estimatedTextureMemoryBytes ?? 0)}`,
    `- Lightmaps: ${stats?.lightmapAssetCount ?? 0}/${stats?.lightmapMaterialCount ?? 0}`,
    `- Geometry compression: ${stats ? geometryCompressionLabel(stats) : "unknown"}`,
    `- Texture compression: ${stats ? textureCompressionLabel(stats) : "unknown"}`,
    `- Tone mapping: ${manifest.rendering?.toneMapping ?? "aces"}`,
    `- Exposure: ${(manifest.rendering?.exposure ?? 1.05).toFixed(2)}`,
    `- Source/export issues: ${sourceExportDiagnostics.length}`,
    `- Publish gate: ${publishReadiness?.status ?? "not analyzed"}`,
    "",
    "Scene framing:",
    ...sceneFramingReportLines(stats),
    "",
    "Environment:",
    `- Sky backdrop: ${manifest.environment?.skyBackdropEnabled === false ? "off" : "on"}`,
    `- Ground: ${manifest.environment?.groundEnabled === false ? "off" : "on"}`,
    `- Enclosure: ${manifest.environment?.enclosureEnabled === false ? "off" : "on"}`,
    "",
    "Views:",
    `- Total views: ${manifest.views.length}`,
    `- Walk views: ${walkViewCount}`,
    `- Orbit views: ${orbitViewCount}`,
    `- Top views: ${topViewCount}`,
    "",
    "Objects:",
    `- Total object overrides: ${objects?.objects.length ?? 0}`,
    `- Hidden in top view: ${hiddenTopViewObjectCount}`,
    `- Forced walkable: ${forcedWalkObjectCount}`,
    `- Forced collision: ${forcedCollisionObjectCount}`,
    `- Ignored for navigation: ${ignoredNavigationObjectCount}`,
    "",
    "Navigation setup:",
    `- Bounds: ${manifest.navigation.bounds ? "yes" : "no"}`,
    `- Walk zones: ${coverage.walkZones}`,
    `- Door/pass zones: ${coverage.passZones}`,
    `- Route islands: ${coverage.routeComponents}`,
    `- Walk views covered: ${coverage.coveredWalkViews}/${coverage.walkViews}`,
    "",
    "Movement comfort:",
    ...movementComfort.lines,
    "",
    "Interactions:",
    `- Video screens: ${videoTextureCount}`,
    `- Hotspots: ${hotspotCount}`,
    `- Links: ${linkCount}`,
    `- Object toggles: ${objectToggleCount}`,
    "",
    "Top risks:",
    ...(actionableDiagnostics.length > 0
      ? actionableDiagnostics.map(
          (diagnostic) => {
            const symptom = diagnosticVisualSymptom(diagnostic.code);
            return `- ${diagnostic.severity.toUpperCase()}: ${diagnostic.title} - ${diagnostic.message}${symptom ? ` Likely symptom: ${symptom}` : ""}`;
          }
        )
      : ["- No blocking or warning diagnostics listed."]),
    "",
    "Publish issues:",
    ...(publishIssues.length > 0 ? publishIssues.map((issue) => `- ${issue}`) : ["- No publish blockers or warnings listed."]),
    "",
    "Manual test results:",
    "- Source export / model structure: ",
    "- Visual match vs reference viewer: ",
    "- Exterior/window/context: ",
    "- Starting view / saved views / top view: ",
    "- Object visibility / ceiling / navigation roles: ",
    "- Baked lighting / lightmap quality: ",
    "- WASD / mouse drag / wheel movement: ",
    "- Click-to-move floor marker and glide: ",
    "- Doorway entry and wall/window blocking: ",
    "- Room buttons, minimap, and top view: ",
    "- TV screens, hotspots, links, and toggles: ",
    "- Mobile load/performance: ",
    "- Most annoying issue: "
  ];
  return lines.join("\n");
}

function LightmapBakeQuality({
  job,
  materialCount
}: {
  job: LightmapBakeJobDocument;
  materialCount: number;
}) {
  const lightmapCount = job.lightmapCount ?? job.lightmaps?.length ?? 0;
  const expectedCount = Math.min(materialCount, job.maxMaterials ?? materialCount);
  const totalBytes = job.totalLightmapBytes ?? 0;
  const averageBytes = lightmapCount > 0 ? totalBytes / lightmapCount : 0;
  const missingByteCount = (job.lightmaps ?? []).filter((lightmap) => !lightmap.bytes).length;
  const tinyLightmapCount = (job.lightmaps ?? []).filter(
    (lightmap) => typeof lightmap.bytes === "number" && lightmap.bytes > 0 && lightmap.bytes < 4096
  ).length;
  const lowResolutionCount = (job.lightmaps ?? []).filter(
    (lightmap) => typeof lightmap.resolution === "number" && lightmap.resolution < 1024
  ).length;
  const suspiciousFlatLightmapCount = (job.lightmaps ?? []).filter(lightmapLooksFlatOrBlank).length;
  const issues = [
    lightmapCount <= 0 ? "No lightmap textures were generated. Check Blender output and material eligibility." : "",
    job.outputSceneUrl ? "" : "No lightmapped scene artifact was reported.",
    expectedCount > 0 && lightmapCount > 0 && lightmapCount < expectedCount
      ? `${lightmapCount} of ${expectedCount} eligible material(s) received lightmaps. Inspect unbaked materials below.`
      : "",
    totalBytes <= 0 && lightmapCount > 0 ? "Generated lightmaps have no recorded file size." : "",
    averageBytes > 0 && averageBytes < 4096 ? "Average lightmap size is very small, which can indicate an empty or failed bake." : "",
    missingByteCount > 0 ? `${missingByteCount} lightmap(s) have no recorded file size.` : "",
    tinyLightmapCount > 0 ? `${tinyLightmapCount} lightmap(s) are extremely small and should be inspected.` : "",
    suspiciousFlatLightmapCount > 0
      ? `${suspiciousFlatLightmapCount} lightmap(s) are unusually small for their resolution, which can indicate a blank or failed bake.`
      : "",
    lowResolutionCount > 0 ? `${lowResolutionCount} lightmap(s) are below 1024px.` : "",
    (job.resolution ?? 0) > 0 && (job.resolution ?? 0) < 1024 ? "Resolution is below 1024px; expect softer lighting and visible artifacts." : "",
    (job.samples ?? 0) > 0 && (job.samples ?? 0) < 64 ? "Sample count is low; use Medium or higher before client review." : ""
  ].filter(Boolean);
  const recommendedAction =
    lightmapCount <= 0 || !job.outputSceneUrl
      ? "Re-run the bake after checking the Blender output folder and eligible materials."
      : suspiciousFlatLightmapCount > 0 || tinyLightmapCount > 0 || averageBytes < 4096
        ? "Inspect the lightmap previews, then re-run with a higher resolution or sample preset if any preview is blank or flat."
        : lowResolutionCount > 0 || (job.resolution ?? 0) < 1024 || (job.samples ?? 0) < 64
          ? "Use Medium or High bake settings before client review."
          : "Review the flagged materials before publishing.";

  if (job.status !== "completed") {
    return null;
  }

  if (issues.length === 0) {
    return (
      <div className="bake-qa-card pass">
        <strong>Bake QA</strong>
        <p>Lightmap artifact, texture count, resolution, samples, and file sizes look ready for viewer testing.</p>
      </div>
    );
  }

  return (
    <div className="bake-qa-card warning">
      <strong>Bake QA</strong>
      {issues.map((issue) => (
        <p key={issue}>{issue}</p>
      ))}
      <p>
        <strong>Recommended action:</strong> {recommendedAction}
      </p>
    </div>
  );
}

function lightmapPreviewQuality(lightmap: NonNullable<LightmapBakeJobDocument["lightmaps"]>[number]): "pass" | "warning" {
  if (!lightmap.bytes || lightmap.bytes < 4096) {
    return "warning";
  }
  if (lightmapLooksFlatOrBlank(lightmap)) {
    return "warning";
  }
  if (typeof lightmap.resolution === "number" && lightmap.resolution < 1024) {
    return "warning";
  }
  return "pass";
}

function lightmapPreviewIssue(lightmap: NonNullable<LightmapBakeJobDocument["lightmaps"]>[number]): string | null {
  if (!lightmap.bytes) {
    return "No file size recorded; confirm this lightmap exists and loads.";
  }
  if (lightmap.bytes < 4096) {
    return "Extremely small output; this may be blank or failed.";
  }
  if (lightmapLooksFlatOrBlank(lightmap)) {
    return "Very low detail for its resolution; inspect for blank or flat lighting.";
  }
  if (typeof lightmap.resolution === "number" && lightmap.resolution < 1024) {
    return "Below 1024px; shadows may look soft or blurry.";
  }
  return null;
}

function prioritizeLightmapPreviews(
  lightmaps: NonNullable<LightmapBakeJobDocument["lightmaps"]>
): NonNullable<LightmapBakeJobDocument["lightmaps"]> {
  return [...lightmaps].sort((a, b) => {
    const qualityDelta =
      (lightmapPreviewQuality(a) === "warning" ? 0 : 1) - (lightmapPreviewQuality(b) === "warning" ? 0 : 1);
    if (qualityDelta !== 0) {
      return qualityDelta;
    }
    return (a.materialName ?? a.url).localeCompare(b.materialName ?? b.url);
  });
}

function lightmapLooksFlatOrBlank(lightmap: NonNullable<LightmapBakeJobDocument["lightmaps"]>[number]): boolean {
  if (!lightmap.bytes || typeof lightmap.resolution !== "number" || lightmap.resolution <= 0) {
    return false;
  }
  const bytesPerPixel = lightmap.bytes / (lightmap.resolution * lightmap.resolution);
  return lightmap.resolution >= 512 && bytesPerPixel < 0.018;
}

function assetHealthRepairPlanText(stats: BundleStats, projectId: string): string {
  const missingAssets = (stats.assets ?? []).filter((asset) => !asset.exists);
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const looseImages = stats.looseImages ?? [];
  const textureMemoryImages = stats.textureMemoryImages ?? [];
  const lightmapAssets = stats.lightmapAssets ?? [];
  const missingLightmapAssets = lightmapAssets.filter((asset) => !asset.exists);
  const tinyLightmapAssets = lightmapAssets.filter(
    (asset) => asset.exists && typeof asset.bytes === "number" && asset.bytes > 0 && asset.bytes < 4096
  );
  const textureSuggestions = stats.materialTextureSuggestions ?? [];
  const strongSuggestions = textureSuggestions.filter(
    (suggestion) => textureSuggestionConfidence(suggestion.score) === "strong"
  );
  const reviewSuggestions = textureSuggestions.filter(
    (suggestion) => textureSuggestionConfidence(suggestion.score) === "review"
  );
  const textureAssignmentDiagnostic = (stats.diagnostics ?? []).find((diagnostic) =>
    diagnostic.code === "dominant-green-placeholder-material" ||
    isTextureConnectionDiagnostic(diagnostic.code)
  );
  const genericLooseTextureDiagnostic = (stats.diagnostics ?? []).find(
    (diagnostic) => diagnostic.code === "generic-loose-texture-names"
  );
  const textureSourceGroups = sourceQaGroups(stats).filter(
    (group) => group.count > 0 && (group.id === "resources" || group.id === "references")
  );
  const textureSourceIssueLines = sourceQaIssueGroupEvidenceLines(textureSourceGroups, { issuesPerGroup: 4 });

  const lines = [
    `Open Space asset health repair plan - ${projectId}`,
    "",
    "Scene framing:",
    ...sceneFramingReportLines(stats),
    "",
    "Current texture health:",
    `- Materials using textures: ${stats.texturedMaterialCount ?? 0}/${stats.materialCount ?? 0}`,
    `- Images in model: ${stats.imageCount ?? 0}`,
    `- Estimated decoded texture RAM: ${formatBytes(stats.estimatedTextureMemoryBytes ?? 0)}`,
    ...textureMemoryImages.slice(0, 5).map(
      (image) =>
        `  - ${image.source}: ${image.width}x${image.height}, ${formatBytes(image.estimatedBytes)} decoded`
    ),
    `- Loose texture-folder images: ${looseImages.length}`,
    `- Missing referenced GLTF resources: ${missingResources.length}`,
    `- Missing manifest assets: ${missingAssets.length}`,
    `- Auto texture suggestions: ${textureSuggestions.length} (${strongSuggestions.length} apply-ready, ${reviewSuggestions.length} review)`,
    `- Lightmap assets: ${stats.lightmapAssetCount ?? 0}/${stats.lightmapMaterialCount ?? 0}`,
    `- Lightmap bytes: ${formatBytes(stats.lightmapAssetBytes ?? 0)}`,
    "",
    "Source/resource findings:",
    textureSourceIssueLines.length > 0
      ? ""
      : "- No exact source/resource repair issue is currently flagged.",
    ...textureSourceIssueLines,
    "",
    "Recommended order:",
    missingResources.length > 0 || missingAssets.length > 0
      ? "1. Run Import Repair after uploading the original ZIP or texture folder so missing referenced files can be copied into place."
      : "1. Referenced model assets are present; skip path repair unless the model was reimported.",
    strongSuggestions.length > 0
      ? `2. Apply ${strongSuggestions.length} high-confidence texture suggestion${strongSuggestions.length === 1 ? "" : "s"} from Asset Health.`
      : "2. No high-confidence automatic texture matches are waiting.",
    reviewSuggestions.length > 0 || looseImages.length > 0
      ? "3. Review Materials and compare loose texture candidates against the rendered material preview before assigning weaker matches."
      : "3. Materials do not currently need manual loose-texture review.",
    missingLightmapAssets.length > 0 || tinyLightmapAssets.length > 0
      ? "4. Review Bake and re-run or relink lightmaps before publishing."
      : "4. Lightmap asset links do not show missing or tiny file issues.",
    "5. Save changes, reopen the viewer, and compare the model against the source/reference viewer before publishing.",
    "",
    textureAssignmentDiagnostic ? `Texture diagnostic: ${textureAssignmentDiagnostic.title} - ${textureAssignmentDiagnostic.message}` : "",
    missingResources.length > 0 ? "Missing GLTF resources:" : "",
    ...missingResources.slice(0, 8).map((resource) => `- ${resource.source}`),
    missingAssets.length > 0 ? "Missing manifest assets:" : "",
    ...missingAssets.slice(0, 8).map((asset) => `- ${asset.source}`),
    looseImages.length > 0 ? "Loose texture-folder images:" : "",
    ...looseImages.slice(0, 8).map((image) => `- ${image.source} (${formatBytes(image.bytes)})`),
    textureSuggestions.length > 0 ? "Texture suggestions:" : "",
    ...textureSuggestions.slice(0, 12).map(
      (suggestion) =>
        `- ${suggestion.materialName}: ${materialTextureFieldLabels[suggestion.field]} <- ${suggestion.source} (${textureSuggestionConfidenceLabel(suggestion.score)}, score ${suggestion.score})`
    ),
    missingLightmapAssets.length > 0 || tinyLightmapAssets.length > 0 ? "Lightmap issues:" : "",
    ...missingLightmapAssets.slice(0, 8).map((asset) => `- Missing ${asset.source}`),
    ...tinyLightmapAssets.slice(0, 8).map((asset) => `- Tiny ${asset.source} (${formatBytes(asset.bytes ?? 0)})`)
  ];

  return lines.filter(Boolean).join("\n");
}

function assetHealthTextureRequestText(stats: BundleStats, projectId: string): string {
  const looseImages = stats.looseImages ?? [];
  const textureSuggestions = stats.materialTextureSuggestions ?? [];
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const textureDiagnostics = (stats.diagnostics ?? []).filter((diagnostic) =>
    isTextureConnectionDiagnostic(diagnostic.code) ||
    [
      "model-has-no-texture-images",
      "invalid-texture-references",
      "textures-without-images",
      "embedded-texture-decode-failed",
      "sidecar-texture-decode-failed",
      "textured-primitives-missing-uvs",
      "normal-maps-missing-tangents",
      "missing-uv-attributes",
      "invalid-uv-accessor-shapes",
      "invalid-tangent-accessor-shapes"
    ].includes(diagnostic.code)
  );
  const textureSourceGroups = sourceQaGroups(stats).filter(
    (group) => group.count > 0 && (group.id === "resources" || group.id === "references")
  );
  const textureSourceIssueLines = sourceQaIssueGroupEvidenceLines(textureSourceGroups, { issuesPerGroup: 4 });
  return [
    `Open Space texture/source request - ${projectId}`,
    "",
    "Please resend the model export so the web walkthrough can preserve the same texture quality as the reference viewer.",
    "",
    "What we need:",
    "- Prefer one self-contained GLB with textures embedded, or a ZIP that keeps the original GLTF/GLB plus its texture folders exactly as exported.",
    "- Preserve original texture filenames, material names, UVs, and material-to-texture assignments.",
    "- Avoid generic renamed texture files only, such as gltf_embedded_0.png, unless the model itself still references those files correctly.",
    "- Include base color, normal, roughness/metalness, emissive, alpha, and any baked/lightmap textures used by the source render.",
    "",
    "Detected texture symptoms:",
    `- Textured materials: ${stats.texturedMaterialCount ?? 0}/${stats.materialCount ?? 0}`,
    `- Images in model: ${stats.imageCount ?? 0}`,
    `- Loose texture-folder images: ${looseImages.length}`,
    `- Missing referenced resources: ${missingResources.length}`,
    `- Auto texture matches found: ${textureSuggestions.length}`,
    ...textureDiagnostics.slice(0, 6).map((diagnostic) => `- ${diagnostic.title}: ${diagnostic.message}`),
    "",
    "Exact source/resource findings:",
    textureSourceIssueLines.length > 0
      ? ""
      : "- No exact source/resource repair issue is currently flagged.",
    ...textureSourceIssueLines,
    "",
    looseImages.length > 0 ? "Loose images we received:" : "",
    ...looseImages.slice(0, 10).map((image) => `- ${image.source} (${formatBytes(image.bytes)})`),
    missingResources.length > 0 ? "Missing files referenced by the model:" : "",
    ...missingResources.slice(0, 10).map((resource) => `- ${resource.source}`),
    textureSuggestions.length > 0 ? "Potential matches Studio found, but these still need visual confirmation:" : "",
    ...textureSuggestions.slice(0, 10).map(
      (suggestion) =>
        `- ${suggestion.materialName}: ${materialTextureFieldLabels[suggestion.field]} may use ${suggestion.source} (${textureSuggestionConfidenceLabel(suggestion.score)})`
    ),
    "",
    "After resending, we will reimport, rerun texture QA, and only then judge materials or publish."
  ].filter(Boolean).join("\n");
}

function textureDeliveryPlanText(
  plan: NonNullable<OptimizationDocument["texturePlans"]>[number],
  projectId: string
): string {
  const lines = [
    `Open Space texture delivery plan - ${projectId}`,
    "",
    `Profile: ${plan.label}`,
    `Status: ${plan.status}`,
    `Current decoded texture RAM: ${formatBytes(plan.currentBytes)}`,
    `Target decoded texture RAM: ${formatBytes(plan.budgetBytes)}`,
    `Planned decoded texture RAM: ${formatBytes(plan.estimatedAfterBytes)}`,
    `Planned RAM savings: ${formatBytes(plan.estimatedSavingsBytes)}`,
    `Max texture edge target: ${plan.maxDimension}px`,
    "",
    plan.items.length > 0 ? "Resize / compression targets:" : "No texture downscale targets are needed for this profile.",
    ...plan.items.map(
      (item) =>
        `- ${item.source}: ${item.width}x${item.height} -> ${item.targetWidth}x${item.targetHeight}; save ${formatBytes(item.estimatedSavingsBytes)} decoded RAM; ${item.reason}`
    ),
    "",
    "Next steps:",
    "1. Compare the viewer against the source/reference render before resizing textures.",
    "2. Downscale low-importance large textures first, then run optimization again.",
    "3. Use KTX2/Basis for production mobile delivery when available."
  ];
  return lines.filter(Boolean).join("\n");
}

function optimizationJobReportText(job: OptimizationJobDocument, projectId: string): string {
  const blockedSteps = job.steps.filter((step) => step.status === "blocked" || step.status === "failed");
  const skippedSteps = job.steps.filter((step) => step.status === "skipped");
  const lines = [
    `Open Space optimization report - ${projectId}`,
    "",
    `Profile: ${job.profile}`,
    `Status: ${job.status}`,
    `Applied to viewer: ${job.applied ? "yes" : "no"}`,
    `Source model: ${job.sourceSceneUrl ?? "unknown"}`,
    `Optimized model: ${job.optimizedSceneUrl ?? "not generated"}`,
    `Completed: ${job.completedAt ?? job.startedAt ?? "unknown"}`,
    "",
    "Model transfer:",
    `- Before: ${formatBytes(job.before?.modelBytes ?? 0)}`,
    `- After: ${formatBytes(job.after?.modelBytes ?? 0)}`,
    `- Saved: ${formatBytes(job.after?.savedBytes ?? 0)} (${job.after?.savedPercent ?? 0}%)`,
    "",
    "Texture runtime pressure:",
    `- Texture count: ${job.before?.textureCount ?? 0} -> ${job.after?.textureCount ?? 0}`,
    `- Decoded texture RAM: ${formatBytes(job.before?.decodedTextureBytes ?? 0)} -> ${formatBytes(job.after?.decodedTextureBytes ?? 0)}`,
    `- Decoded texture RAM saved: ${formatBytes(job.after?.savedDecodedTextureBytes ?? 0)}`,
    `- Texture file bytes saved: ${formatBytes(job.after?.savedTextureImageBytes ?? 0)}`,
    "",
    "Pipeline steps:",
    ...job.steps.map((step) => `- ${step.status}: ${step.label}${step.note ? ` - ${step.note}` : ""}`),
    "",
    blockedSteps.length > 0 ? "Needs attention:" : "",
    ...blockedSteps.map((step) => `- ${step.label}: ${step.note ?? step.status}`),
    skippedSteps.length > 0 ? "Skipped / no-op steps:" : "",
    ...skippedSteps.map((step) => `- ${step.label}: ${step.note ?? "No change needed."}`),
    "",
    "Next checks:",
    "1. Open the viewer and compare Original vs Optimized.",
    "2. If texture RAM is still high, use the Texture Delivery Plan to downscale the largest images.",
    "3. If KTX2/Basis was blocked, install toktx before production mobile delivery."
  ];
  return lines.filter(Boolean).join("\n");
}

function AssetHealth({
  stats,
  projectId,
  apiConnected,
  repairState,
  pendingTextureSuggestionCount = 0,
  reviewTextureSuggestionCount = 0,
  appliedTextureSuggestionCount = 0,
  onApplyTextureSuggestions,
  onRepair,
  onMaterials,
  onOptimize,
  onBake,
  onReviewTextureSuggestion,
  onCopyPlan,
  onCopyTextureRequest
}: {
  stats: BundleStats;
  projectId: string;
  apiConnected: boolean;
  repairState: RepairState;
  pendingTextureSuggestionCount?: number;
  reviewTextureSuggestionCount?: number;
  appliedTextureSuggestionCount?: number;
  onApplyTextureSuggestions?: () => void;
  onRepair?: () => void;
  onMaterials?: () => void;
  onOptimize?: () => void;
  onBake?: () => void;
  onReviewTextureSuggestion?: (suggestion: MaterialTextureSuggestion) => void;
  onCopyPlan?: () => void;
  onCopyTextureRequest?: () => void;
}) {
  const missingAssets = (stats.assets ?? []).filter((asset) => !asset.exists);
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const looseImages = stats.looseImages ?? [];
  const textureMemoryImages = stats.textureMemoryImages ?? [];
  const lightmapAssets = stats.lightmapAssets ?? [];
  const missingLightmapAssets = lightmapAssets.filter((asset) => !asset.exists);
  const tinyLightmapAssets = lightmapAssets.filter(
    (asset) => asset.exists && typeof asset.bytes === "number" && asset.bytes > 0 && asset.bytes < 4096
  );
  const textureSuggestions = stats.materialTextureSuggestions ?? [];
  const textureAssignmentDiagnostic = (stats.diagnostics ?? []).find((diagnostic) =>
    diagnostic.code === "dominant-green-placeholder-material" ||
    isTextureConnectionDiagnostic(diagnostic.code)
  );
  const genericLooseTextureDiagnostic = (stats.diagnostics ?? []).find(
    (diagnostic) => diagnostic.code === "generic-loose-texture-names"
  );
  const looseTexturesNotReferencedDiagnostic = (stats.diagnostics ?? []).find(
    (diagnostic) => diagnostic.code === "loose-textures-not-referenced"
  );
  const highTextureMemoryDiagnostic = (stats.diagnostics ?? []).find(
    (diagnostic) => diagnostic.code === "high-texture-memory-estimate"
  );
  const sceneFramingDiagnostic = (stats.diagnostics ?? []).find((diagnostic) =>
    isSceneFramingDiagnostic(diagnostic.code)
  );
  const sceneArea = footprintAreaFromSize(stats.sceneBoundsSize);
  const focusedArea = footprintAreaFromSize(stats.focusedBoundsSize);
  const focusedShare =
    typeof sceneArea === "number" && sceneArea > 0 && typeof focusedArea === "number"
      ? Math.min(1, Math.max(0, focusedArea / sceneArea))
      : undefined;
  const hasModelOffset = Boolean(stats.modelOffset?.some((value) => Math.abs(value) > 0.01));
  const hasSceneFramingWork =
    Boolean(sceneFramingDiagnostic) ||
    Boolean(hasModelOffset) ||
    (typeof focusedShare === "number" && typeof sceneArea === "number" && sceneArea > 40 && focusedShare < 0.55);
  const hasTextureAssignmentGap =
    Boolean(textureAssignmentDiagnostic) ||
    ((stats.imageCount ?? 0) > 0 &&
      (stats.materialCount ?? 0) > 0 &&
      (stats.texturedMaterialCount ?? 0) < Math.max(1, Math.ceil((stats.materialCount ?? 0) * 0.2)));
  const canRunRepair = Boolean(onRepair) && apiConnected && repairState !== "repairing";
  const hasTextureRepairWork = missingResources.length > 0 || missingAssets.length > 0;
  const hasLightmapRepairWork = missingLightmapAssets.length > 0 || tinyLightmapAssets.length > 0;
  const needsBakePlanning = (stats.materialCount ?? 0) > 0 && (stats.lightmapMaterialCount ?? 0) === 0;
  const hasPartialLightmapCoverage =
    (stats.lightmapMaterialCount ?? 0) > 0 && (stats.lightmapMaterialCount ?? 0) < (stats.materialCount ?? 0);
  const hasLooseUnmappedTextures = looseImages.length > 0 && textureSuggestions.length === 0;
  const hasDisconnectedTextureFolder = Boolean(looseTexturesNotReferencedDiagnostic);
  const hasDetails =
    hasSceneFramingWork ||
    missingAssets.length > 0 ||
    missingResources.length > 0 ||
    hasLightmapRepairWork ||
    needsBakePlanning ||
    hasPartialLightmapCoverage ||
    Boolean(highTextureMemoryDiagnostic) ||
    looseImages.length > 0 ||
    hasTextureAssignmentGap ||
    textureSuggestions.length > 0 ||
    externalResources.length > 0;
  const assetHealthSteps = [
    {
      id: "paths",
      label: "Texture paths",
      detail: hasTextureRepairWork
        ? `${missingResources.length + missingAssets.length} referenced file${missingResources.length + missingAssets.length === 1 ? "" : "s"} missing`
        : "Referenced model files are present",
      status: hasTextureRepairWork ? "warning" : "ready",
      action: onRepair ? "Repair Paths" : "Review"
    },
    {
      id: "assignments",
      label: "Material maps",
      detail: pendingTextureSuggestionCount > 0
        ? `${pendingTextureSuggestionCount} safe match${pendingTextureSuggestionCount === 1 ? "" : "es"} ready`
        : reviewTextureSuggestionCount > 0
          ? `${reviewTextureSuggestionCount} match${reviewTextureSuggestionCount === 1 ? "" : "es"} need review`
          : hasDisconnectedTextureFolder
            ? "Texture folder not linked"
          : hasTextureAssignmentGap
            ? `${stats.texturedMaterialCount ?? 0}/${stats.materialCount ?? 0} material(s) textured`
            : "Coverage looks usable",
      status: pendingTextureSuggestionCount > 0 ? "active" : reviewTextureSuggestionCount > 0 || hasTextureAssignmentGap ? "warning" : "ready",
      action: pendingTextureSuggestionCount > 0 ? "Apply Matches" : hasDisconnectedTextureFolder ? "Copy Request" : "Review Materials"
    },
    {
      id: "memory",
      label: "Texture memory",
      detail: highTextureMemoryDiagnostic
        ? formatBytes(stats.estimatedTextureMemoryBytes ?? 0)
        : "No high memory warning",
      status: highTextureMemoryDiagnostic ? "warning" : "ready",
      action: "Review Performance"
    },
    {
      id: "lightmaps",
      label: "Lightmaps",
      detail: hasLightmapRepairWork
        ? `${missingLightmapAssets.length + tinyLightmapAssets.length} issue${missingLightmapAssets.length + tinyLightmapAssets.length === 1 ? "" : "s"}`
        : needsBakePlanning
          ? "Not baked yet"
        : hasPartialLightmapCoverage
          ? `${stats.lightmapMaterialCount ?? 0}/${stats.materialCount ?? 0} baked`
        : `${stats.lightmapAssetCount ?? 0}/${stats.lightmapMaterialCount ?? 0} linked`,
      status: hasLightmapRepairWork || needsBakePlanning || hasPartialLightmapCoverage ? "warning" : "ready",
      action: "Review Bake"
    }
  ];

  if (!hasDetails) {
    return (
      <div className="asset-health-card pass">
        <strong>Asset links healthy</strong>
        <p>No missing referenced assets or loose texture-folder images were detected.</p>
      </div>
    );
  }

  return (
    <div className="asset-health-card">
      <div className="asset-health-heading">
        <strong>Asset health</strong>
        {onCopyPlan && (
          <button type="button" className="button secondary compact-button" onClick={onCopyPlan}>
            <Copy size={15} aria-hidden="true" />
            Copy Plan
          </button>
        )}
        {onCopyTextureRequest && (looseImages.length > 0 || textureSuggestions.length > 0 || hasTextureAssignmentGap) && (
          <button type="button" className="button secondary compact-button" onClick={onCopyTextureRequest}>
            <Copy size={15} aria-hidden="true" />
            Copy Texture Request
          </button>
        )}
      </div>
      <div className="asset-health-roadmap" aria-label="Asset repair roadmap">
        {assetHealthSteps.map((step) => (
          <button
            key={step.id}
            type="button"
            className={`asset-health-roadmap-step ${step.status}`}
            disabled={
              (step.id === "paths" && !hasTextureRepairWork) ||
              (step.id === "assignments" && !hasTextureAssignmentGap && textureSuggestions.length === 0) ||
              (step.id === "memory" && !highTextureMemoryDiagnostic) ||
              (step.id === "lightmaps" && !hasLightmapRepairWork && !needsBakePlanning && !hasPartialLightmapCoverage)
            }
            onClick={() => {
              if (step.id === "paths" && hasTextureRepairWork && onRepair) {
                onRepair();
                return;
              }
              if (step.id === "assignments") {
                if (pendingTextureSuggestionCount > 0 && onApplyTextureSuggestions) {
                  onApplyTextureSuggestions();
                  return;
                }
                if (hasDisconnectedTextureFolder && onCopyTextureRequest) {
                  onCopyTextureRequest();
                  return;
                }
                onMaterials?.();
                return;
              }
              if (step.id === "memory") {
                onOptimize?.();
                return;
              }
              if (step.id === "lightmaps") {
                onBake?.();
              }
            }}
          >
            <span>
              {step.status === "ready" ? (
                <Check size={15} aria-hidden="true" />
              ) : step.id === "memory" ? (
                <Activity size={15} aria-hidden="true" />
              ) : (
                <Palette size={15} aria-hidden="true" />
              )}
            </span>
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
            <em>{step.action}</em>
          </button>
        ))}
      </div>
      {(hasTextureRepairWork ||
        hasSceneFramingWork ||
        hasLightmapRepairWork ||
        needsBakePlanning ||
        hasPartialLightmapCoverage ||
        Boolean(highTextureMemoryDiagnostic) ||
        textureSuggestions.length > 0 ||
        hasLooseUnmappedTextures ||
        hasTextureAssignmentGap) && (
        <div className="asset-repair-plan">
          {hasSceneFramingWork && (
            <p>
              {sceneFramingDiagnostic?.message ??
                (hasModelOffset
                  ? `The viewer applies a ${stats.modelOffset?.map((value) => value.toFixed(1)).join(", ")} model offset so camera views and navigation frame the building.`
                  : "The focused building footprint is smaller than the full scene footprint, so exterior terrain or helper planes may affect framing.")}{" "}
              Run repair after import changes to rebuild focused camera views, bounds, rooms, and navigation.
            </p>
          )}
          {highTextureMemoryDiagnostic && (
            <p>
              {highTextureMemoryDiagnostic.message} Review Performance to downscale texture delivery or prepare KTX2/Basis
              compression before publishing.
            </p>
          )}
          {hasTextureRepairWork && (
            <p>
              Some referenced texture files are missing from the paths stored in the model. Run repair after importing
              the model ZIP or texture folder so matching files can be copied into place.
            </p>
          )}
          {hasDisconnectedTextureFolder && !hasTextureRepairWork && (
            <p>
              {looseTexturesNotReferencedDiagnostic?.message ??
                "A texture folder was uploaded, but the active model does not point to those images."}{" "}
              Copy the texture request and ask for the original export with material-to-texture links preserved before
              spending time on manual assignments.
            </p>
          )}
          {hasTextureAssignmentGap && !hasTextureRepairWork && !hasDisconnectedTextureFolder && (
            <p>
              {textureAssignmentDiagnostic?.message ??
                `${stats.texturedMaterialCount ?? 0}/${stats.materialCount ?? 0} material(s) currently use texture maps.`}{" "}
              Review Materials to assign base, normal, or emissive maps before judging visual quality.
            </p>
          )}
          {!hasTextureRepairWork && textureSuggestions.length > 0 && (
            <p>
              {pendingTextureSuggestionCount > 0
                ? `${pendingTextureSuggestionCount} high-confidence texture match${pendingTextureSuggestionCount === 1 ? "" : "es"} can be applied${reviewTextureSuggestionCount > 0 ? `; ${reviewTextureSuggestionCount} lower-confidence match${reviewTextureSuggestionCount === 1 ? "" : "es"} need review.` : "."}`
                : reviewTextureSuggestionCount > 0
                  ? `${reviewTextureSuggestionCount} lower-confidence texture match${reviewTextureSuggestionCount === 1 ? "" : "es"} need visual review in Materials.`
                : `${appliedTextureSuggestionCount} texture match${appliedTextureSuggestionCount === 1 ? "" : "es"} already assigned. Review the material previews before opening the viewer.`}
            </p>
          )}
          {!hasTextureRepairWork && textureSuggestions.length === 0 && hasLooseUnmappedTextures && !hasDisconnectedTextureFolder && (
            <p>
              {genericLooseTextureDiagnostic?.message ??
                "Texture files are present, but the model does not reference them clearly."}{" "}
              Review Materials and assign the right image to each material, or ask for a re-export that preserves original
              texture paths.
            </p>
          )}
          {hasLightmapRepairWork && (
            <p>
              {missingLightmapAssets.length > 0
                ? `${missingLightmapAssets.length} lightmap file${missingLightmapAssets.length === 1 ? "" : "s"} referenced by Materials are missing from the bundle.`
                : `${tinyLightmapAssets.length} lightmap file${tinyLightmapAssets.length === 1 ? "" : "s"} look too small to trust.`}{" "}
              Re-run the bake or relink the material lightmap before publishing.
            </p>
          )}
          {needsBakePlanning && !hasLightmapRepairWork && (
            <p>
              No baked lightmaps are linked yet. Review Bake before client visual review so the scene can get
              Shapespark-style soft shadows and stable lighting instead of relying only on real-time lights.
            </p>
          )}
          {hasPartialLightmapCoverage && !hasLightmapRepairWork && (
            <p>
              {stats.lightmapMaterialCount ?? 0}/{stats.materialCount ?? 0} material(s) currently have baked lightmaps.
              Review Bake and Materials to confirm the remaining unbaked materials are intentional before client delivery.
            </p>
          )}
          <div className="asset-health-actions">
            {hasTextureRepairWork && onRepair && (
              <button type="button" className="button secondary compact-button" disabled={!canRunRepair} onClick={onRepair}>
                <Wrench size={15} aria-hidden="true" />
                {repairState === "repairing" ? "Repairing" : "Repair Paths"}
              </button>
            )}
            {pendingTextureSuggestionCount > 0 && onApplyTextureSuggestions && (
              <button type="button" className="button secondary compact-button" onClick={onApplyTextureSuggestions}>
                <Palette size={15} aria-hidden="true" />
                Apply {pendingTextureSuggestionCount}
              </button>
            )}
            {onMaterials && (
              <button type="button" className="button secondary compact-button" onClick={onMaterials}>
                <Palette size={15} aria-hidden="true" />
                Review Materials
              </button>
            )}
            {highTextureMemoryDiagnostic && onOptimize && (
              <button type="button" className="button secondary compact-button" onClick={onOptimize}>
                <Activity size={15} aria-hidden="true" />
                Review Performance
              </button>
            )}
            {hasLightmapRepairWork && onBake && (
              <button type="button" className="button secondary compact-button" disabled={!apiConnected} onClick={onBake}>
                <Palette size={15} aria-hidden="true" />
                Review Bake
              </button>
            )}
            {hasSceneFramingWork && onRepair && !hasTextureRepairWork && (
              <button type="button" className="button secondary compact-button" disabled={!canRunRepair} onClick={onRepair}>
                <Wrench size={15} aria-hidden="true" />
                {repairState === "repairing" ? "Repairing" : "Repair Framing"}
              </button>
            )}
          </div>
        </div>
      )}
      {hasSceneFramingWork && (
        <div className="asset-health-section scene-framing-section">
          <span>Scene framing</span>
          <div className="scene-framing-grid">
            <div>
              <strong>{formatRuntimeNumber(stats.sceneLargestDimension ?? 0, 1)}</strong>
              <small>full scene span</small>
            </div>
            <div>
              <strong>{formatRuntimeNumber(stats.focusedLargestDimension ?? stats.sceneLargestDimension ?? 0, 1)}</strong>
              <small>focused span</small>
            </div>
            <div>
              <strong>
                {typeof focusedShare === "number" ? `${Math.max(1, Math.round(focusedShare * 100))}%` : "n/a"}
              </strong>
              <small>building share</small>
            </div>
            <div>
              <strong>{formatRuntimeNumber(stats.modelOffsetDistance ?? stats.sceneFootprintCenterDistance ?? 0, 1)}</strong>
              <small>{hasModelOffset ? "offset applied" : "origin distance"}</small>
            </div>
          </div>
          {stats.modelOffset && (
            <code>Runtime offset: {formatRuntimeVec3(stats.modelOffset)}</code>
          )}
        </div>
      )}
      {hasLightmapRepairWork && (
        <div className="asset-health-section">
          <span>Lightmap asset health</span>
          {missingLightmapAssets.slice(0, 5).map((asset) => (
            <code key={`${asset.kind}-${asset.source}`}>{asset.source}</code>
          ))}
          {tinyLightmapAssets.slice(0, 5).map((asset) => (
            <code key={`${asset.kind}-${asset.source}`}>
              {asset.source} - {formatBytes(asset.bytes ?? 0)}
            </code>
          ))}
        </div>
      )}
      {hasTextureAssignmentGap && (
        <div className="asset-health-section">
          <span>Texture assignment coverage</span>
          <div className="asset-coverage-row">
            <strong>
              {stats.texturedMaterialCount ?? 0}/{stats.materialCount ?? 0} material(s)
            </strong>
            <small>
              {textureAssignmentDiagnostic?.title ?? "Few materials use texture images"}
              {typeof stats.unusedTextureImageCount === "number" && (stats.imageCount ?? 0) > 0
                ? ` - ${stats.unusedTextureImageCount}/${stats.imageCount ?? 0} image(s) unused`
                : ""}
            </small>
          </div>
        </div>
      )}
      {highTextureMemoryDiagnostic && textureMemoryImages.length > 0 && (
        <div className="asset-health-section">
          <span>Largest decoded textures</span>
          {textureMemoryImages.slice(0, 5).map((image) => (
            <div key={image.source} className="asset-texture-row">
              {canPreviewTextureAsset(image.source) && (
                <img src={projectAssetPath(projectId, image.source)} alt="" loading="lazy" />
              )}
              <code>
                {image.source} - {image.width}x{image.height} - {formatBytes(image.estimatedBytes)}
              </code>
            </div>
          ))}
        </div>
      )}
      {missingAssets.length > 0 && (
        <div className="asset-health-section">
          <span>Missing manifest assets</span>
          {missingAssets.slice(0, 5).map((asset) => (
            <code key={`${asset.kind}-${asset.source}`}>{asset.source}</code>
          ))}
        </div>
      )}
      {missingResources.length > 0 && (
        <div className="asset-health-section">
          <span>Missing GLTF resources</span>
          {missingResources.slice(0, 5).map((resource) => (
            <code key={`${resource.kind}-${resource.source}`}>{resource.source}</code>
          ))}
        </div>
      )}
      {looseImages.length > 0 && (
        <div className="asset-health-section">
          <span>Loose texture-folder images</span>
          {looseImages.slice(0, 5).map((image) => (
            <div key={image.source} className="asset-texture-row">
              {canPreviewTextureAsset(image.source) && (
                <img src={projectAssetPath(projectId, image.source)} alt="" loading="lazy" />
              )}
              <code>
                {image.source} - {formatBytes(image.bytes)}
              </code>
            </div>
          ))}
        </div>
      )}
      {textureSuggestions.length > 0 && (
        <div className="asset-health-section">
          <span>Auto texture mappings</span>
          {textureSuggestions.slice(0, 5).map((suggestion) => (
            <div
              key={`${suggestion.materialName}-${suggestion.field}-${suggestion.source}`}
              className="asset-suggestion-row"
            >
              {canPreviewTextureAsset(suggestion.source) && (
                <img src={projectAssetPath(projectId, suggestion.source)} alt="" loading="lazy" />
              )}
              <div>
                <strong>{suggestion.materialName}</strong>
                <small>
                  {materialTextureFieldLabels[suggestion.field]} -{" "}
                  {textureSuggestionConfidenceDetail(suggestion.score)} - score {suggestion.score}
                </small>
                <span className={`asset-confidence ${textureSuggestionConfidence(suggestion.score)}`}>
                  {textureSuggestionConfidenceLabel(suggestion.score)}
                </span>
                <code>{suggestion.source}</code>
                {onReviewTextureSuggestion && (
                  <button
                    type="button"
                    className="button secondary compact-button asset-suggestion-action"
                    onClick={() => onReviewTextureSuggestion(suggestion)}
                  >
                    <Palette size={14} aria-hidden="true" />
                    Review
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {externalResources.length > 0 && missingResources.length === 0 && (
        <p>All GLTF external resources referenced by the active model are present.</p>
      )}
    </div>
  );
}

function InteractionHealthBoard({
  title,
  steps,
  onCopyRequest,
  requestLabel = "Copy Setup"
}: {
  title: string;
  steps: readonly InteractionHealthStep[];
  onCopyRequest?: () => void;
  requestLabel?: string;
}) {
  if (steps.length === 0) {
    return null;
  }
  const needsFixCount = steps.filter((step) => step.status === "warning").length;
  return (
    <div className="selected-interaction-health" aria-label={title}>
      <div className="selected-interaction-health-heading">
        <div>
          <strong>{title}</strong>
          <small>
            {needsFixCount > 0
              ? `${needsFixCount} item${needsFixCount === 1 ? "" : "s"} need attention`
              : "Ready for viewer testing"}
          </small>
        </div>
        <div className="selected-interaction-health-actions">
          {onCopyRequest && (
            <button type="button" className="button secondary compact-button" onClick={onCopyRequest}>
              <Copy size={14} aria-hidden="true" />
              {requestLabel}
            </button>
          )}
          <span className={needsFixCount > 0 ? "health-pill warning" : "health-pill ready"}>
            {needsFixCount > 0 ? "Fix" : "Ready"}
          </span>
        </div>
      </div>
      <div className="selected-interaction-health-grid">
        {steps.map((step) => (
          <div key={step.id} className={`selected-interaction-health-card ${step.status}`}>
            <span>
              {step.status === "ready" ? (
                <Check size={15} aria-hidden="true" />
              ) : step.status === "active" ? (
                <MapPin size={15} aria-hidden="true" />
              ) : (
                <AlertTriangle size={15} aria-hidden="true" />
              )}
            </span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </div>
            <em>{step.action}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function InteractionPlacementCard({
  selectedView,
  onUsePosition
}: {
  selectedView: SceneView | undefined;
  onUsePosition: (position: Vec3) => void;
}) {
  return (
    <div className="interaction-placement-card">
      <div>
        <strong>Place marker visually</strong>
        <small>
          {selectedView
            ? `Use ${selectedView.label} instead of typing coordinates.`
            : "Create or select a saved view before using visual placement."}
        </small>
      </div>
      <div className="inline-actions">
        <button
          type="button"
          className="button secondary compact-button"
          disabled={!selectedView}
          onClick={() => selectedView && onUsePosition(selectedView.target)}
        >
          <MapPin size={15} aria-hidden="true" />
          Look Point
        </button>
        <button
          type="button"
          className="button secondary compact-button"
          disabled={!selectedView}
          onClick={() => selectedView && onUsePosition(selectedView.position)}
        >
          <Globe2 size={15} aria-hidden="true" />
          Camera Spot
        </button>
      </div>
    </div>
  );
}

function VectorEditor({
  label,
  value,
  onChange
}: {
  label: string;
  value: Vec3;
  onChange: (value: Vec3) => void;
}) {
  return (
    <fieldset className="vector-field">
      <legend>{label}</legend>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>
          <span>{axis}</span>
          <input
            type="number"
            step="0.05"
            value={value[index]}
            onChange={(event) => onChange(updateVec3(value, index, event.target.value))}
          />
        </label>
      ))}
    </fieldset>
  );
}

export default App;
