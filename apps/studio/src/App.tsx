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
type BakePreset = "draft" | "medium" | "high" | "super";
type BakePreflightIssue = {
  severity: "error" | "warning";
  message: string;
};
type HotspotIcon = NonNullable<HotspotInteraction["icon"]>;
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
  materialCount: number;
  texturedMaterialCount?: number;
  textureCount?: number;
  imageCount?: number;
  embeddedImageCount?: number;
  maxTextureDimension?: number;
  oversizedTextureCount?: number;
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
    externalResourceCount?: number;
    missingExternalResourceCount?: number;
    externalResources?: readonly {
      kind: string;
      source: string;
      exists: boolean;
      bytes?: number;
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
      maxMaterials: number;
      maxMeshes: number;
    };
    metrics: {
      totalBytes: number;
      modelBytes: number;
      triangles: number;
      materials: number;
      meshes: number;
    };
    warnings: readonly {
      code: string;
      message: string;
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
  };
  after?: {
    modelBytes: number;
    savedBytes: number;
    savedPercent: number;
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
  qualityGate?: {
    status: "ready" | "warning" | "blocked";
    analyzedAt?: string;
    blockerCount?: number;
    warningCount?: number;
    diagnosticCount?: number;
  };
}

interface PublishCheck {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
  blocking?: boolean;
  action?: ImportNextStepAction;
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

const viewerBaseUrl = "http://127.0.0.1:5173";
const apiBaseUrl = "http://127.0.0.1:5175";
const studioTabIds: readonly StudioTab[] = [
  "overview",
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
      collisionRadius: 0.26,
      maxStepUp: 0.38,
      maxStepDown: 0.72,
      floorHeightSmoothing: 0.9,
      floorBumpTolerance: 0.48
    }
  },
  {
    id: "steps",
    label: "Steps",
    detail: "More forgiving for thresholds and simple stairs.",
    movement: {
      clickMoveSpeed: 1.15,
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
      collisionRadius: 0.32,
      maxStepUp: 0.28,
      maxStepDown: 0.55,
      floorHeightSmoothing: 2.15,
      floorBumpTolerance: 0.08
    }
  }
];

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
  if (!blockerName && !reason && !action && !hint && !point && !target && !from && bodyRadius === undefined) {
    return null;
  }
  return {
    reason,
    blockerName,
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
        "The clicked spot is not inside any walk area. Add a blue walk patch there if a person should be allowed to stand on that part of the model.",
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

function navigationComponents(zones: readonly NavigationZone[]): NavigationZone[][] {
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
        if (!seen.has(candidate.id) && navigationZonesOverlap(current, candidate)) {
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

  const routeComponents = navigationComponents(routeZones);
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
    const touchingWalkZones = walkZones.filter((walkZone) => navigationZonesOverlap(zone, walkZone));
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
  if (issue.id.startsWith("blocked-pass-")) {
    return {
      title: "Open the blocker at the door",
      detail: "A door pass exists, but a block zone still overlaps it. Use the zone map to split, shrink, or move the blocker around the opening.",
      button: "Review Blockers",
      action: "review-zones"
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

function semanticRoomLabelFromZoneGroup(
  zones: readonly NavigationZone[],
  graph: SceneGraphDocument | null,
  modelScale: number
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
    const center: Vec3 = [
      ((node.bounds.min[0] + node.bounds.max[0]) / 2) * modelScale,
      ((node.bounds.min[1] + node.bounds.max[1]) / 2) * modelScale,
      ((node.bounds.min[2] + node.bounds.max[2]) / 2) * modelScale
    ];
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
  modelScale = 1
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
  const semanticLabel = semanticRoomLabelFromZoneGroup(sortedZones, graph, modelScale);
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
  modelScale = 1
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
    .map((component, index) => createRoomFromNavigationZoneGroup(component, index + 1, views, graph, modelScale));
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
  return command ? `${command} --fail-on-warning` : "";
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [apiConnected, setApiConnected] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState("");
  const [lightmapUploadState, setLightmapUploadState] = useState<UploadState>("idle");
  const [lightmapUploadError, setLightmapUploadError] = useState("");
  const [mediaUploadState, setMediaUploadState] = useState<UploadState>("idle");
  const [mediaUploadError, setMediaUploadError] = useState("");
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const [activePublishVersion, setActivePublishVersion] = useState("");
  const [publishError, setPublishError] = useState("");
  const [optimizeState, setOptimizeState] = useState<OptimizeState>("idle");
  const [optimizeError, setOptimizeError] = useState("");
  const [bakeState, setBakeState] = useState<BakeState>("idle");
  const [bakeError, setBakeError] = useState("");
  const [bakeSettings, setBakeSettings] = useState({
    preset: "medium" as BakePreset,
    resolution: 1024,
    samples: 96,
    margin: 16,
    maxMaterials: 160,
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
  const [optimizationProfile, setOptimizationProfile] =
    useState<OptimizationJobDocument["profile"]>("balanced");

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
  const linkedRoomViewCount = useMemo(() => {
    const linkedViewIds = new Set(rooms.map((room) => room.viewId).filter(Boolean));
    return manifest?.views.filter((view) => view.kind === "walk" && linkedViewIds.has(view.id)).length ?? 0;
  }, [manifest, rooms]);

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
    if (!navigationRepairDraft?.blockerName || !objectsDoc) {
      return null;
    }
    const blockerName = navigationRepairDraft.blockerName;
    const blocker = normalizedObjectMatchName(blockerName);
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
    const objectByName = objectsDoc.objects.find((object) => objectMatchesBlockerName(object, blockerName));
    const object = objectBySceneNode ?? objectByName;
    return object ? { object, sceneNode } : null;
  }, [navigationRepairDraft?.blockerName, objectsDoc, sceneGraph]);
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
  const navigationQuickFix = useMemo(
    () => navigationQuickFixForIssue(primaryNavigationIssue),
    [primaryNavigationIssue]
  );
  const publishChecks = useMemo<PublishCheck[]>(() => {
    const errorDiagnostics = bundleStats?.diagnostics?.filter((diagnostic) => diagnostic.severity === "error") ?? [];
    const publishBlockers = bundleStats?.publishReadiness?.blockers ?? [];
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
  const firstPublishCheckIssue = publishChecks.find((check) => check.blocking && !check.ready) ?? publishChecks.find((check) => !check.ready);
  const firstPublishGateIssue =
    bundleStats?.publishReadiness?.blockers[0] ?? bundleStats?.publishReadiness?.warnings[0];
  const blenderTool = toolStatus?.tools.blender;
  const materialCountForBake = bundleStats?.materialCount ?? materialsDoc?.materials.length ?? 0;
  const estimatedBakeMaterialCount = Math.min(materialCountForBake, bakeSettings.maxMaterials);
  const estimatedBakeTextureBytes =
    estimatedBakeMaterialCount * bakeSettings.resolution * bakeSettings.resolution * 4;
  const bakeMaterialLimitExceeded = materialCountForBake > bakeSettings.maxMaterials;
  const activeBakePresetDefaults = bakePresetDefaults[bakeSettings.preset];
  const bakePresetModified =
    bakeSettings.resolution !== activeBakePresetDefaults.resolution ||
    bakeSettings.samples !== activeBakePresetDefaults.samples ||
    bakeSettings.margin !== activeBakePresetDefaults.margin;
  const bakePreflightIssues: BakePreflightIssue[] = [
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
    const cameraHeight = manifest.navigation.cameraHeight;
    return sceneGraph.nodes
      .map((node) => {
        if (!node.bounds) {
          return null;
        }
        const scaledBounds = {
          min: [
            node.bounds.min[0] * modelScale,
            node.bounds.min[1] * modelScale,
            node.bounds.min[2] * modelScale
          ] as Vec3,
          max: [
            node.bounds.max[0] * modelScale,
            node.bounds.max[1] * modelScale,
            node.bounds.max[2] * modelScale
          ] as Vec3
        };
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

  const selectedObject = useMemo(
    () => sceneGraph?.nodes.find((node) => node.id === selectedObjectId),
    [sceneGraph, selectedObjectId]
  );

  const selectedObjectOverride = useMemo(
    () => objectsDoc?.objects.find((object) => object.id === selectedObjectId),
    [objectsDoc, selectedObjectId]
  );

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
  const appliedMaterialTextureSuggestionCount = Math.max(
    0,
    (bundleStats?.materialTextureSuggestions?.length ?? 0) -
      pendingMaterialTextureSuggestionCount -
      reviewMaterialTextureSuggestionCount
  );

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
    updater: (object: ObjectOverride) => ObjectOverride
  ) => {
    setObjectsDoc((current) =>
      current
        ? {
            ...current,
            objects: current.objects.map((object) =>
              object.id === objectId ? updater(object) : object
            )
          }
        : current
    );
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
    const margin = 0.75;
    return {
      min: [
        bounds.min[0] * scale - margin,
        Math.min(0.2, bounds.min[1] * scale - 0.1),
        bounds.min[2] * scale - margin
      ],
      max: [
        bounds.max[0] * scale + margin,
        Math.max(bounds.max[1] * scale + 0.5, (manifest?.navigation.cameraHeight ?? 1.65) + 0.5),
        bounds.max[2] * scale + margin
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
      window.setTimeout(() => document.querySelector(".zone-map")?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
      return;
    }
    window.open(navigationDebugViewerUrl(activeProjectId), "_blank", "noopener,noreferrer");
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
    updateObject(match.object.id, (object) => ({
      ...object,
      navigationBehavior: behavior
    }));
    if (behavior === "ignore") {
      updateNavigation((navigation) => {
        const existing = navigation.ignoredCollisionMeshNames ?? [];
        const next = [...existing];
        [blockerName, match.object.name].filter((name): name is string => Boolean(name)).forEach((name) => {
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

  const saveDraft = () => {
    if (!manifest) {
      return;
    }

    if (apiConnected) {
      void saveToApi();
      return;
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
  };

  const saveToApi = async () => {
    if (!manifest) {
      return;
    }

    await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/manifest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest)
    });

    if (materialsDoc) {
      await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/materials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(materialsDoc)
      });
    }

    if (objectsDoc) {
      await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/objects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(objectsDoc)
      });
    }

    if (controlsDoc) {
      await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/controls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(controlsDoc)
      });
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
    try {
      if (manifest) {
        await saveToApi();
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/publish`, {
        method: "POST"
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Publish failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
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
      setNotice("saved");
    } catch (error) {
      setPublishState("error");
      setPublishError(error instanceof Error ? error.message : "Publish failed.");
    }
  };

  const activatePublishedVersion = async (entry: PublishEntry) => {
    if (!apiConnected) {
      setPublishError("API is not connected.");
      return;
    }
    setActivePublishVersion(entry.version);
    setPublishError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/publish/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: entry.version })
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Activate failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        publishHistory: PublishHistoryDocument;
      };
      setPublishHistory(result.publishHistory);
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
      if (manifest) {
        await saveToApi();
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: optimizationProfile, apply: true })
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
      if (manifest) {
        await saveToApi();
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
      if (manifest) {
        await saveToApi();
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

  const applyMaterialTextureSuggestions = () => {
    const suggestions = (bundleStats?.materialTextureSuggestions ?? []).filter(
      (suggestion) => textureSuggestionConfidence(suggestion.score) === "strong"
    );
    if (suggestions.length === 0) {
      setRepairSummary("No high-confidence texture suggestions are ready to apply. Open Materials to review weaker matches manually.");
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
        ? `Applied ${appliedCount} high-confidence texture suggestion(s). Save changes, then re-open the viewer to inspect materials.`
        : "No high-confidence texture suggestions were applied because the suggested material fields are already filled."
    );
    setNotice("saved");
  };

  const reviewMaterialTextureSuggestion = (suggestion: MaterialTextureSuggestion) => {
    const material = materialsDoc?.materials.find((item) => item.name === suggestion.materialName);
    if (material) {
      setSelectedMaterialId(material.id);
    }
    setSelectedTab("materials");
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
        window.setTimeout(() => setSelectedTab("controls"), 0);
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
        current.rendering?.modelScale ?? 1
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
      const selectedOverride = objectsDoc?.objects.find((object) => object.id === selectedObjectId);
      const nextToggle = createObjectToggle(objectToggleInteractions.length + 1, selectedOverride);
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
  const variantCount = materialVariantInteractions.reduce(
    (sum, interaction) => sum + interaction.variants.length,
    0
  );
  const originalSceneUrl =
    manifest.originalSceneUrl ??
    optimizationJob?.sourceSceneUrl ??
    (manifest.sceneUrl && manifest.sceneUrl !== "scene.optimized.glb" ? manifest.sceneUrl : "scene.glb");
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
      setSelectedTab("environment");
      return;
    }
    if (action === "materials") {
      setSelectedTab("materials");
      return;
    }
    if (action === "views") {
      setSelectedTab("views");
      return;
    }
    if (action === "navigation") {
      setSelectedTab("controls");
      return;
    }
    if (action === "rooms") {
      setSelectedTab("rooms");
      return;
    }
    if (action === "interactions") {
      setSelectedTab("interactions");
      return;
    }
    if (action === "optimize") {
      void optimizeProject();
      return;
    }
    if (action === "bake") {
      void bakeLightmaps();
      return;
    }
    if (action === "review") {
      document.querySelector(".diagnostic-list")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    window.open(viewerUrl(activeProjectId), "_blank", "noopener,noreferrer");
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

        <nav className="tabs" aria-label="Studio sections">
          {[
            ["overview", "Overview"],
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

        {selectedTab === "import" && (
          <section className="content-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>Model Import</h2>
              </div>

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
              <div className="publish-action-card">
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
                viewerUrl={`http://127.0.0.1:5173/?scene=${encodeURIComponent(projectScenePath(activeProjectId))}`}
                repairState={repairState}
                optimizeState={optimizeState}
                bakeState={bakeState}
                onRepair={() => void repairImport()}
                onOptimize={() => void optimizeProject()}
                onBake={() => void bakeLightmaps()}
                onEnvironment={() => setSelectedTab("environment")}
                onMaterials={() => setSelectedTab("materials")}
                onViews={() => setSelectedTab("views")}
                onNavigation={() => setSelectedTab("controls")}
                onRooms={() => setSelectedTab("rooms")}
                onInteractions={() => setSelectedTab("interactions")}
                pendingTextureSuggestionCount={pendingMaterialTextureSuggestionCount}
                reviewTextureSuggestionCount={reviewMaterialTextureSuggestionCount}
                onApplyTextureSuggestions={applyMaterialTextureSuggestions}
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
                    <Stat label="Materials" value={String(bundleStats.materialCount)} />
                    <Stat label="Triangles" value={String(bundleStats.triangleCount)} />
                    <Stat label="Images" value={String(bundleStats.imageCount ?? 0)} />
                    <Stat label="Embedded images" value={String(bundleStats.embeddedImageCount ?? 0)} />
                    <Stat label="Max texture" value={`${bundleStats.maxTextureDimension ?? 0}px`} />
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
                    onMaterials={() => setSelectedTab("materials")}
                    onReviewTextureSuggestion={reviewMaterialTextureSuggestion}
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

              <div className="publish-action-card">
                <div>
                  <strong>Optimize Scene Bundle</strong>
                  <p className="quiet-note">
                    Generate an optimized GLB artifact, apply it to the manifest, and refresh bundle stats.
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
                  <button
                    type="button"
                    className="button primary"
                    disabled={!apiConnected || optimizeState === "optimizing"}
                    onClick={() => void optimizeProject()}
                  >
                    <Activity size={16} aria-hidden="true" />
                    {optimizeState === "optimizing" ? "Optimizing" : "Run"}
                  </button>
                </div>
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
                </div>
                {optimizationJob && optimizationJob.status !== "idle" ? (
                  <>
                    <div className="stat-grid">
                      <Stat label="Profile" value={optimizationJob.profile} />
                      <Stat label="Status" value={optimizationJob.status} />
                      <Stat label="Before" value={formatBytes(optimizationJob.before?.modelBytes ?? 0)} />
                      <Stat label="After" value={formatBytes(optimizationJob.after?.modelBytes ?? 0)} />
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
                        <small>{formatBytes(job.after?.savedBytes ?? 0)} saved</small>
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
              </div>

              <div className="publish-action-card">
                <div>
                  <strong>{manifest.branding.clientName ?? manifest.branding.title}</strong>
                  <p className="quiet-note">Create a static versioned bundle for sharing or embedding.</p>
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
                  {publishState === "publishing" ? "Publishing" : "Publish"}
                </button>
              </div>

              {publishError && <p className="error-note">{publishError}</p>}

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
                            {publishHistory.activeVersion === entry.version && (
                              <span className="publish-live-pill">Live</span>
                            )}
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
                                : "Set Live"}
                          </button>
                        </div>
                        {entry.cdnBasePath && <code>{entry.cdnBasePath}</code>}
                        <code>{publishedEmbedSnippet(entry, manifest.branding.clientName ?? manifest.branding.title)}</code>
                        {entry.deploymentPath && (
                          <div className="deploy-command-list">
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
                  <small>{view.kind}</small>
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
              {rooms.map((room) => (
                <button
                  key={room.id}
                  type="button"
                  className={selectedRoom?.id === room.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedRoomId(room.id)}
                >
                  <span>{room.label}</span>
                  <small>{room.dimensions ?? room.viewId ?? "room"}</small>
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
                    <button type="button" className="button secondary" onClick={() => setSelectedTab("controls")}>
                      <Wrench size={16} aria-hidden="true" />
                      Controls
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
                  <small>video surface</small>
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
                        const object = objectsDoc?.objects.find((item) => item.id === event.target.value);
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          targetObjectId: object?.id ?? "",
                          targetObjectName: object?.name ?? ""
                        }));
                      }}
                    >
                      <option value="">Select object</option>
                      {objectsDoc?.objects.map((object) => (
                        <option key={object.id} value={object.id}>
                          {object.name}
                        </option>
                      ))}
                    </select>
                  </label>
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
                <small>{materialsDoc?.materials.length ?? 0}</small>
              </div>
              {materialsDoc?.materials.map((material) => (
                <button
                  key={material.id}
                  type="button"
                  className={selectedMaterialId === material.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedMaterialId(material.id)}
                >
                  <span>{material.name}</span>
                  <small>{material.baseColor ?? "no color"}</small>
                </button>
              ))}
              {!materialsDoc && <p className="empty-list">No materials generated.</p>}
            </div>

            {selectedMaterial && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>{selectedMaterial.name}</h2>
                </div>

                <div className="publish-action-card">
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
                {!canRunLightmapBake && lightmapBakeBlockedReason && bakeState !== "baking" && !bakePreflightBlocked && (
                  <p className={blenderTool && !blenderTool.ready ? "error-note" : "quiet-note"}>
                    {lightmapBakeBlockedReason}
                  </p>
                )}
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
                    <div className={`job-step-row ${lightmapBakeJob.status === "blocked" ? "failed" : "completed"}`}>
                      <div className="job-step-main">
                        <span>{lightmapBakeJob.engine}</span>
                        {lightmapBakeJob.message && <small>{lightmapBakeJob.message}</small>}
                        {lightmapBakeJob.bakeMode && <small>{lightmapBakeJob.bakeMode} bake</small>}
                        {lightmapBakeJob.preset && <small>{lightmapBakeJob.preset} quality</small>}
                        {lightmapBakeJob.outputSceneUrl && <small>{lightmapBakeJob.outputSceneUrl}</small>}
                      </div>
                      <strong>{lightmapBakeJob.status}</strong>
                    </div>
                    {lightmapBakeJob.status === "completed" && (
                      <>
                        <div className="stat-grid compact-stat-grid">
                          <Stat label="Lightmaps" value={String(lightmapBakeJob.lightmapCount ?? lightmapBakeJob.lightmaps?.length ?? 0)} />
                          <Stat label="Total" value={formatBytes(lightmapBakeJob.totalLightmapBytes ?? 0)} />
                          <Stat label="Max px" value={String(lightmapBakeJob.resolution ?? bakeSettings.resolution)} />
                          <Stat label="Samples" value={String(lightmapBakeJob.samples ?? bakeSettings.samples)} />
                        </div>
                        <LightmapBakeQuality job={lightmapBakeJob} materialCount={materialCountForBake} />
                      </>
                    )}
                    {lightmapBakeJob.lightmaps && lightmapBakeJob.lightmaps.length > 0 && (
                      <div className="job-history-list">
                        {lightmapBakeJob.lightmaps
                          .slice(0, 8)
                          .map((lightmap) => {
                            const quality = lightmapPreviewQuality(lightmap);
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
                                  <span>{lightmap.url}</span>
                                </div>
                                <small>
                                  <span className={`lightmap-quality-pill ${quality}`}>
                                    {quality === "warning" ? "Review" : "OK"}
                                  </span>
                                  {lightmap.resolution ? `${lightmap.resolution}px / ` : ""}
                                  {formatBytes(lightmap.bytes ?? 0)}
                                </small>
                              </div>
                            );
                          })}
                      </div>
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
                        {selectedMaterialTextureCandidates.map((candidate) => (
                          <button
                            key={`${candidate.field}-${candidate.source}`}
                            type="button"
                            className={
                              selectedMaterial[candidate.field] === candidate.source
                                ? "surface-candidate active"
                                : "surface-candidate"
                            }
                            onClick={() => applyMaterialTextureCandidate(selectedMaterial.id, candidate)}
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
                              Use as {materialTextureFieldLabels[candidate.field]} / {formatBytes(candidate.bytes)} /{" "}
                              {textureSuggestionConfidenceDetail(candidate.score)} / score {candidate.score}
                            </small>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="field-grid">
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
                  <small>{interaction.targetMaterialName ?? interaction.targetMeshName ?? "untargeted"}</small>
                </button>
              ))}
              {materialVariantInteractions.length === 0 && (
                <p className="empty-list">No material variant sets configured.</p>
              )}
            </div>

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
                      {materialsDoc?.materials.map((material) => (
                        <option key={material.id} value={material.name}>
                          {material.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Target Mesh</span>
                    <input
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
                  </label>
                </div>

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

                  {selectedVariantInteraction.variants.map((variant) => (
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
                      <label>
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
                  ))}
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
                <small>{sceneGraph?.nodes.length ?? 0}</small>
              </div>
              {sceneGraph?.nodes.map((node) => {
                const override = objectsDoc?.objects.find((object) => object.id === node.id);
                return (
                  <div
                    key={node.id}
                    className={selectedObjectId === node.id ? "list-row active" : "list-row"}
                  >
                    <button type="button" className="list-row-main" onClick={() => setSelectedObjectId(node.id)}>
                      <span>{node.name}</span>
                      <small>
                        {node.triangleCount} triangles
                        {override?.hideInTopView ? " · hidden in top" : ""}
                      </small>
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
                        }))
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
                    value={selectedObjectOverride?.visible === false ? "Hidden" : "Visible"}
                  />
                  <Stat
                    label="Top View"
                    value={selectedObjectOverride?.hideInTopView ? "Hidden" : "Visible"}
                  />
                  <Stat
                    label="Navigation"
                    value={objectNavigationBehaviorLabel(selectedObjectOverride?.navigationBehavior)}
                  />
                </div>

                {selectedObjectOverride && (
                  <div className="object-detail">
                    <h3>View Visibility</h3>
                    <div className="toggle-grid">
                      <label className="toggle-row">
                        <input
                          type="checkbox"
                          checked={selectedObjectOverride.hideInTopView === true}
                          onChange={(event) =>
                            updateObject(selectedObjectOverride.id, (object) => ({
                              ...object,
                              hideInTopView: event.target.checked
                            }))
                          }
                        />
                        <span>Hide in top view</span>
                      </label>
                    </div>
                  </div>
                )}

                {selectedObjectOverride && (
                  <div className="object-detail">
                    <h3>Navigation Behavior</h3>
                    <label>
                      <span>Object role</span>
                      <select
                        value={selectedObjectOverride.navigationBehavior ?? "default"}
                        onChange={(event) =>
                          updateObject(selectedObjectOverride.id, (object) => ({
                            ...object,
                            navigationBehavior: event.target.value as NonNullable<ObjectOverride["navigationBehavior"]>
                          }))
                        }
                      >
                        <option value="default">Default detection</option>
                        <option value="walk">Walk on</option>
                        <option value="collision">Collision</option>
                        <option value="ignore">Ignore navigation</option>
                      </select>
                    </label>
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

              {controlsDoc ? (
                <>
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
                        <a
                          className="button secondary"
                          href={navigationDebugViewerUrl(activeProjectId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={16} aria-hidden="true" />
                          Test
                        </a>
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
                                {navigationRepairObjectMatch.object.name} is the likely object stopping movement.
                                Choose a role here instead of editing coordinates.
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
                                  setSelectedTab("objects");
                                }}
                              >
                                Open Object
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
                        return (
                          <div key={issue.id} className={`navigation-qa-card ${issue.severity}`}>
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
                            onClick={() => void saveToApi()}
                          >
                            <Save size={16} aria-hidden="true" />
                            Save Changes
                          </button>
                          <a
                            className="button secondary"
                            href={navigationDebugViewerUrl(activeProjectId)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={16} aria-hidden="true" />
                            Retry Viewer
                          </a>
                        </div>
                      </div>
                    )}
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

                    <div className="publish-row">
                      <span>Navigation zones</span>
                      <div className="inline-actions">
                        <a
                          className="button secondary"
                          href={navigationDebugViewerUrl(activeProjectId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={16} aria-hidden="true" />
                          Preview
                        </a>
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
                          {navigationRepairDraft?.point && (
                            <span
                              className="zone-map-repair-point"
                              style={pointMapStyle(navigationRepairDraft.point, manifest.navigation.bounds!)}
                              title="Viewer blocked point"
                            />
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
              <pre className="json-preview">{JSON.stringify(manifest.environment ?? {}, null, 2)}</pre>
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
              <pre className="json-preview">{JSON.stringify(manifest, null, 2)}</pre>
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
                      <Stat label="Materials" value={String(bundleStats.materialCount)} />
                      <Stat label="Triangles" value={String(bundleStats.triangleCount)} />
                      <Stat label="Textures" value={String(bundleStats.textureCount ?? 0)} />
                      <Stat label="Images" value={String(bundleStats.imageCount ?? 0)} />
                      <Stat label="Embedded images" value={String(bundleStats.embeddedImageCount ?? 0)} />
                      <Stat label="Max texture" value={`${bundleStats.maxTextureDimension ?? 0}px`} />
                      <Stat label="Oversized" value={String(bundleStats.oversizedTextureCount ?? 0)} />
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
  return (
    <div className="diagnostic-list">
      <div className={errorCount > 0 ? "diagnostic-summary blocking" : "diagnostic-summary"}>
        <strong>{errorCount > 0 ? `${errorCount} blocking issue${errorCount === 1 ? "" : "s"}` : "No blocking issues"}</strong>
        <span>
          {warningCount} warning{warningCount === 1 ? "" : "s"} / {infoCount} info
        </span>
      </div>
      {diagnostics.map((diagnostic) => {
        const action = importActionForDiagnostic(diagnostic.code);
        const actionCopy = action ? nextStepCopy(action) : undefined;
        return (
          <div key={diagnostic.code} className={`diagnostic-card ${diagnostic.severity}`}>
            <AlertTriangle size={17} aria-hidden="true" />
            <div className="diagnostic-card-main">
              <div>
                <strong>{diagnostic.title}</strong>
                <p>{diagnostic.message}</p>
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
  | "views"
  | "navigation"
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

function importActionForDiagnostic(code: string): ImportNextStepAction | undefined {
  if (
    [
      "dominant-flat-plane",
      "initial-view-on-dominant-plane",
    ].includes(code)
  ) {
    return "environment";
  }
  if (
    [
      "dominant-green-placeholder-material",
      "model-has-no-texture-images",
      "loose-textures-not-referenced",
      "image-textures-unused-by-materials",
      "few-materials-use-textures",
      "case-mismatched-model-resources",
      "embedded-texture-decode-failed",
      "sidecar-texture-decode-failed",
      "textured-primitives-missing-uvs",
      "unassigned-primitive-materials",
      "invalid-uv-accessor-shapes",
      "missing-uv-attributes",
      "mostly-unlit-materials",
      "vertex-colors-detected",
      "dominant-untextured-material",
      "tiny-texture-dimensions"
    ].includes(code)
  ) {
    return "materials";
  }
  if (
    [
      "focused-model-small-in-scene",
      "initial-view-misses-focused-model",
      "large-coordinate-units",
      "missing-scene-bounds",
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
      "flat-object-surfaces-may-catch-clicks",
      "multiple-floor-heights-detected",
      "no-named-collision-meshes",
      "missing-walk-zones",
      "missing-pass-zones",
      "disconnected-navigation-zones",
      "orphan-pass-zones",
      "narrow-pass-zones",
      "one-sided-pass-zones",
      "pass-zones-overlap-block-zones",
      "walk-views-outside-navigation-bounds",
      "walk-views-inside-block-zones",
      "walk-views-outside-walk-zones"
    ].includes(code)
  ) {
    return "navigation";
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
      "video-textures-target-missing"
    ].includes(code)
  ) {
    return "interactions";
  }
  if (
    [
      "missing-geometry-compression",
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
      "lightmaps-missing-secondary-uvs",
      "some-lightmap-secondary-uvs-missing"
    ].includes(code)
  ) {
    return "bake";
  }
  if (
    [
      "malformed-model",
      "invalid-default-scene",
      "default-scene-has-no-renderable-meshes",
      "invalid-scene-node-references",
      "invalid-node-child-references",
      "invalid-node-mesh-references",
      "invalid-position-accessor-shapes",
      "invalid-index-accessor-shapes",
      "invalid-material-references",
      "invalid-texture-references",
      "stale-object-overrides",
      "invalid-object-navigation-behavior",
      "unsafe-gltf-resource-paths",
      "unsupported-required-extensions",
      "repeated-large-mesh-instances",
      "no-named-ceiling-meshes"
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
      detail: "Create the optimized GLB artifact, apply compression, refresh stats, and reduce mobile loading risk.",
      button: "Optimize"
    };
  }
  if (action === "bake") {
    return {
      action,
      title: "Improve lighting",
      detail: "Run the Blender/Cycles lightmap workflow when Blender is installed, then inspect the viewer result.",
      button: "Bake Lightmaps"
    };
  }
  if (action === "review") {
    return {
      action,
      title: "Fix the source export",
      detail: "The model report found an issue that needs the original export, texture ZIP, or source model to be corrected.",
      button: "Review Diagnostics"
    };
  }
  if (action === "environment") {
    return {
      action,
      title: "Fix exterior context",
      detail: "Open Environment to disable generated ground/enclosure or choose a neutral review preset when the scene opens on grass, terrain, or empty exterior space.",
      button: "Open Environment"
    };
  }
  if (action === "materials") {
    return {
      action,
      title: "Repair materials",
      detail: "Open Materials to inspect missing, loose, broken, or placeholder texture assignments before judging the model quality.",
      button: "Open Materials"
    };
  }
  if (action === "views") {
    return {
      action,
      title: "Create views",
      detail: "Open Views to create a starting camera and client-facing room viewpoints.",
      button: "Open Views"
    };
  }
  if (action === "navigation") {
    return {
      action,
      title: "Fix navigation",
      detail: "Open the guided Controls tools to inspect walk areas, door passes, blockers, and generated zones.",
      button: "Open Controls"
    };
  }
  if (action === "rooms") {
    return {
      action,
      title: "Map rooms",
      detail: "Open Rooms to create room labels, floorplan areas, and links from room buttons to saved walk views.",
      button: "Open Rooms"
    };
  }
  if (action === "interactions") {
    return {
      action,
      title: "Fix interactions",
      detail: "Open Interactions to finish video screens, hotspots, links, and object toggles.",
      button: "Open Interactions"
    };
  }
  return {
    action,
    title: "Test in viewer",
    detail: "The import report has no blocking action. Open the viewer and test walking, click movement, and room buttons.",
    button: "Open Viewer"
  };
}

function ImportNextSteps({
  stats,
  apiConnected,
  viewerUrl,
  repairState,
  optimizeState,
  bakeState,
  onRepair,
  onOptimize,
  onBake,
  onEnvironment,
  onMaterials,
  onViews,
  onNavigation,
  onRooms,
  onInteractions,
  pendingTextureSuggestionCount = 0,
  reviewTextureSuggestionCount = 0,
  onApplyTextureSuggestions
}: {
  stats: BundleStats | null;
  apiConnected: boolean;
  viewerUrl: string;
  repairState: RepairState;
  optimizeState: OptimizeState;
  bakeState: BakeState;
  onRepair: () => void;
  onOptimize: () => void;
  onBake: () => void;
  onEnvironment: () => void;
  onMaterials: () => void;
  onViews: () => void;
  onNavigation: () => void;
  onRooms: () => void;
  onInteractions: () => void;
  pendingTextureSuggestionCount?: number;
  reviewTextureSuggestionCount?: number;
  onApplyTextureSuggestions?: () => void;
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
          detail: "Open Materials to inspect lower-confidence texture-folder matches before applying them.",
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
                  ? () => document.querySelector(".diagnostic-list")?.scrollIntoView({ behavior: "smooth" })
                  : () => window.open(viewerUrl, "_blank", "noopener,noreferrer");
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
    lowResolutionCount > 0 ? `${lowResolutionCount} lightmap(s) are below 1024px.` : "",
    (job.resolution ?? 0) > 0 && (job.resolution ?? 0) < 1024 ? "Resolution is below 1024px; expect softer lighting and visible artifacts." : "",
    (job.samples ?? 0) > 0 && (job.samples ?? 0) < 64 ? "Sample count is low; use Medium or higher before client review." : ""
  ].filter(Boolean);

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
    </div>
  );
}

function lightmapPreviewQuality(lightmap: NonNullable<LightmapBakeJobDocument["lightmaps"]>[number]): "pass" | "warning" {
  if (!lightmap.bytes || lightmap.bytes < 4096) {
    return "warning";
  }
  if (typeof lightmap.resolution === "number" && lightmap.resolution < 1024) {
    return "warning";
  }
  return "pass";
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
  onReviewTextureSuggestion
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
  onReviewTextureSuggestion?: (suggestion: MaterialTextureSuggestion) => void;
}) {
  const missingAssets = (stats.assets ?? []).filter((asset) => !asset.exists);
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const looseImages = stats.looseImages ?? [];
  const textureSuggestions = stats.materialTextureSuggestions ?? [];
  const canRunRepair = Boolean(onRepair) && apiConnected && repairState !== "repairing";
  const hasTextureRepairWork = missingResources.length > 0 || missingAssets.length > 0;
  const hasLooseUnmappedTextures = looseImages.length > 0 && textureSuggestions.length === 0;
  const hasDetails =
    missingAssets.length > 0 ||
    missingResources.length > 0 ||
    looseImages.length > 0 ||
    textureSuggestions.length > 0 ||
    externalResources.length > 0;

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
      <strong>Asset health</strong>
      {(hasTextureRepairWork || textureSuggestions.length > 0 || hasLooseUnmappedTextures) && (
        <div className="asset-repair-plan">
          {hasTextureRepairWork && (
            <p>
              Some referenced texture files are missing from the paths stored in the model. Run repair after importing
              the model ZIP or texture folder so matching files can be copied into place.
            </p>
          )}
          {!hasTextureRepairWork && textureSuggestions.length > 0 && (
            <p>
              {pendingTextureSuggestionCount > 0
                ? `${pendingTextureSuggestionCount} high-confidence texture match${pendingTextureSuggestionCount === 1 ? "" : "es"} can be applied${reviewTextureSuggestionCount > 0 ? `; ${reviewTextureSuggestionCount} lower-confidence match${reviewTextureSuggestionCount === 1 ? "" : "es"} need review.` : "."}`
                : reviewTextureSuggestionCount > 0
                  ? `${reviewTextureSuggestionCount} lower-confidence texture match${reviewTextureSuggestionCount === 1 ? "" : "es"} need manual review in Materials.`
                : `${appliedTextureSuggestionCount} texture match${appliedTextureSuggestionCount === 1 ? "" : "es"} already assigned. Review the material previews before opening the viewer.`}
            </p>
          )}
          {!hasTextureRepairWork && textureSuggestions.length === 0 && hasLooseUnmappedTextures && (
            <p>
              Texture files are present, but the model does not reference them clearly. Open Materials and assign the
              right image to each material.
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
                Open Materials
              </button>
            )}
          </div>
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
