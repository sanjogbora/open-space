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
type HotspotIcon = NonNullable<HotspotInteraction["icon"]>;
type MovementToggle = "enabled" | "keyboard" | "clickToMove" | "dragLook";

interface NavigationRepairDraft {
  reason: string;
  blockerName: string;
  point?: Vec3;
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
  textureCount?: number;
  imageCount?: number;
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
  models?: readonly {
    format: string;
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
    status: "completed" | "pending" | "failed" | "skipped";
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
  message?: string;
  startedAt?: string;
  completedAt?: string;
  steps: readonly {
    id: string;
    label: string;
    status: "completed" | "pending" | "failed" | "skipped";
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
  deploymentPath?: string;
  cdnBasePath?: string;
  assetCount?: number;
  totalBytes?: number;
}

interface VideoSurfaceCandidate {
  id: string;
  meshName: string;
  materialName?: string;
  triangleCount: number;
  label: string;
  score: number;
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
  const reason = params.get("reason") ?? "";
  const point = parsePointParam(params.get("point"));
  if (!blockerName && !reason && !point) {
    return null;
  }
  return {
    reason,
    blockerName,
    ...(point ? { point } : {})
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
  return {
    left: `${((zone.center[0] - bounds.min[0]) / width) * 100}%`,
    top: `${100 - ((zone.center[2] - bounds.min[2]) / depth) * 100}%`,
    width: `${clampNumber((zone.size[0] / width) * 100, 2, 100)}%`,
    height: `${clampNumber((zone.size[2] / depth) * 100, 2, 100)}%`,
    transform: `translate(-50%, -50%) rotate(${zone.rotationY ?? 0}rad)`
  };
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
  const localCorners: Array<[number, number]> = [
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

function navigationZonesOverlap(a: NavigationZone, b: NavigationZone, padding = 0.2): boolean {
  const boxA = navigationZoneAabb(a);
  const boxB = navigationZoneAabb(b);
  return (
    boxA.minX - padding <= boxB.maxX &&
    boxA.maxX + padding >= boxB.minX &&
    boxA.minZ - padding <= boxB.maxZ &&
    boxA.maxZ + padding >= boxB.minZ
  );
}

function countNavigationComponents(zones: readonly NavigationZone[]): number {
  if (zones.length === 0) {
    return 0;
  }
  const seen = new Set<string>();
  let components = 0;
  for (const zone of zones) {
    if (seen.has(zone.id)) {
      continue;
    }
    components += 1;
    const queue = [zone];
    seen.add(zone.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const candidate of zones) {
        if (!seen.has(candidate.id) && navigationZonesOverlap(current, candidate)) {
          seen.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
  }
  return components;
}

function navigationQaIssues(manifest: SceneManifest): NavigationQaIssue[] {
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

  const componentCount = countNavigationComponents(routeZones);
  if (componentCount > 1) {
    issues.push({
      id: "disconnected-route-zones",
      severity: "warning",
      title: "Walkable areas are disconnected",
      detail: `${componentCount} separate navigation islands were detected across walk/pass zones.`,
      action: "Add or resize pass zones until connected rooms touch through doorways."
    });
  }

  passZones.forEach((zone) => {
    const touchesWalkZone = walkZones.some((walkZone) => navigationZonesOverlap(zone, walkZone));
    if (!touchesWalkZone) {
      issues.push({
        id: `orphan-pass-${zone.id}`,
        severity: "warning",
        title: `Pass zone is isolated: ${zone.label}`,
        detail: "This doorway pass does not overlap any walk zone, so pathfinding cannot use it.",
        action: "Move or resize the pass zone so it overlaps the room floor walk zones on both sides."
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
  if (normalized.includes("video") || normalized.includes("media")) {
    score += 5;
  }
  if (normalized.includes("rendertexture") || normalized.includes("emissive")) {
    score += 4;
  }
  if (normalized.includes("glass") || normalized.includes("black")) {
    score += 1;
  }
  return score;
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
  if (normalized.includes("frame") || normalized.includes("threshold")) {
    score += 5;
  }
  if (normalized.includes("entry") || normalized.includes("entrance")) {
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
    enabled: true
  };
}

function projectScenePath(projectId: string): string {
  return `/scenes/${projectId}/scene.manifest.json`;
}

function projectAssetPath(projectId: string, asset: string): string {
  return `/scenes/${projectId}/${asset}`;
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
  return `${viewerBaseUrl}/?scene=${encodeURIComponent(entry.scenePath)}`;
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
  return `node scripts/deploy-published-bundle.mjs ${shellQuote(entry.deploymentPath)} --out=dist/published`;
}

function publishedBucketDeployCommand(entry: PublishEntry): string {
  if (!entry.deploymentPath) {
    return "";
  }
  return `node scripts/deploy-published-bundle.mjs ${shellQuote(entry.deploymentPath)} --s3=s3://your-bucket/open-space/${entry.version}`;
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
  const [publishError, setPublishError] = useState("");
  const [optimizeState, setOptimizeState] = useState<OptimizeState>("idle");
  const [optimizeError, setOptimizeError] = useState("");
  const [bakeState, setBakeState] = useState<BakeState>("idle");
  const [bakeError, setBakeError] = useState("");
  const [repairState, setRepairState] = useState<RepairState>("idle");
  const [repairError, setRepairError] = useState("");
  const [repairSummary, setRepairSummary] = useState("");
  const [blockerNameDraft, setBlockerNameDraft] = useState("");
  const [navigationRepairDraft, setNavigationRepairDraft] = useState<NavigationRepairDraft | null>(
    initialNavigationRepairDraft
  );
  const [optimizationProfile, setOptimizationProfile] =
    useState<OptimizationJobDocument["profile"]>("balanced");

  useEffect(() => {
    if (!navigationRepairDraft) {
      return;
    }
    setSelectedTab("controls");
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
  const publishChecks = useMemo(() => {
    const errorDiagnostics = bundleStats?.diagnostics?.filter((diagnostic) => diagnostic.severity === "error") ?? [];
    return [
      {
        id: "views",
        label: "Starting views",
        ready: (manifest?.views.length ?? 0) > 0,
        detail: `${manifest?.views.length ?? 0} configured`
      },
      {
        id: "assets",
        label: "Referenced assets",
        ready: (bundleStats?.missingAssetCount ?? 0) === 0,
        detail:
          bundleStats && bundleStats.missingAssetCount > 0
            ? `${bundleStats.missingAssetCount} missing`
            : "All present"
      },
      {
        id: "diagnostics",
        label: "Blocking diagnostics",
        ready: errorDiagnostics.length === 0,
        detail: errorDiagnostics.length > 0 ? `${errorDiagnostics.length} error(s)` : "No errors"
      },
      {
        id: "geometry",
        label: "Geometry compression",
        ready: geometryCompressionLabel(bundleStats) !== "None",
        detail: geometryCompressionLabel(bundleStats)
      },
      {
        id: "texture",
        label: "Texture transfer compression",
        ready: textureCompressionLabel(bundleStats) !== "None" || (bundleStats?.imageCount ?? 0) === 0,
        detail: (bundleStats?.imageCount ?? 0) === 0 ? "No textures" : textureCompressionLabel(bundleStats)
      }
    ];
  }, [bundleStats, manifest]);
  const navigationIssues = useMemo(() => (manifest ? navigationQaIssues(manifest) : []), [manifest]);
  const navigationCoverageSummary = useMemo(() => (manifest ? navigationCoverage(manifest) : null), [manifest]);
  const hasBlockingPublishErrors = publishChecks.some((check) => check.id === "diagnostics" && !check.ready);

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
      const score = videoSurfaceScore(searchName);
      return {
        id: node.id,
        meshName: node.name,
        ...(materialName ? { materialName } : {}),
        triangleCount: node.triangleCount,
        label: materialName ? `${node.name} / ${materialName}` : node.name,
        score
      };
    });
    const likely = candidates.filter((candidate) => candidate.score > 0);
    return (likely.length > 0 ? likely : candidates)
      .sort((a, b) => b.score - a.score || b.triangleCount - a.triangleCount)
      .slice(0, 12);
  }, [sceneGraph]);

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
        const score = doorPassScore(`${node.name} ${node.meshName ?? ""}`);
        if (!node.bounds || score <= 0) {
          return null;
        }
        const min: Vec3 = [
          node.bounds.min[0] * modelScale,
          node.bounds.min[1] * modelScale,
          node.bounds.min[2] * modelScale
        ];
        const max: Vec3 = [
          node.bounds.max[0] * modelScale,
          node.bounds.max[1] * modelScale,
          node.bounds.max[2] * modelScale
        ];
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

  const applyBoundsFromGraph = () => {
    if (!sceneGraph) {
      return;
    }
    const nodeBounds = sceneGraph.nodes
      .map((node) => node.bounds)
      .filter((bounds): bounds is NonNullable<SceneGraphDocument["nodes"][number]["bounds"]> =>
        Boolean(bounds)
      );
    const firstBounds = nodeBounds[0];
    if (!firstBounds) {
      return;
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
    updateNavigation((navigation) => ({
      ...navigation,
      bounds: {
        min: [
          bounds.min[0] * scale - margin,
          Math.min(0.2, bounds.min[1] * scale - 0.1),
          bounds.min[2] * scale - margin
        ],
        max: [
          bounds.max[0] * scale + margin,
          Math.max(bounds.max[1] * scale + 0.5, navigation.cameraHeight + 0.5),
          bounds.max[2] * scale + margin
        ]
      }
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

  const createBoundaryBlockZones = () => {
    updateNavigation((navigation) => {
      const bounds = navigation.bounds;
      if (!bounds) {
        return navigation;
      }
      const width = Math.max(1, bounds.max[0] - bounds.min[0]);
      const depth = Math.max(1, bounds.max[2] - bounds.min[2]);
      const height = Math.max(1.8, bounds.max[1] - bounds.min[1]);
      const y = bounds.min[1] + height / 2;
      const thickness = Math.max(0.35, Math.min(width, depth) * 0.035);
      const existing = (navigation.zones ?? []).filter((zone) => !zone.id.startsWith("boundary-block-"));
      const boundaryZones: NavigationZone[] = [
        {
          id: "boundary-block-north",
          label: "Boundary North",
          kind: "block",
          center: [(bounds.min[0] + bounds.max[0]) / 2, y, bounds.max[2] + thickness / 2],
          size: [width + thickness * 2, height, thickness],
          rotationY: 0,
          enabled: true
        },
        {
          id: "boundary-block-south",
          label: "Boundary South",
          kind: "block",
          center: [(bounds.min[0] + bounds.max[0]) / 2, y, bounds.min[2] - thickness / 2],
          size: [width + thickness * 2, height, thickness],
          rotationY: 0,
          enabled: true
        },
        {
          id: "boundary-block-east",
          label: "Boundary East",
          kind: "block",
          center: [bounds.max[0] + thickness / 2, y, (bounds.min[2] + bounds.max[2]) / 2],
          size: [thickness, height, depth + thickness * 2],
          rotationY: 0,
          enabled: true
        },
        {
          id: "boundary-block-west",
          label: "Boundary West",
          kind: "block",
          center: [bounds.min[0] - thickness / 2, y, (bounds.min[2] + bounds.max[2]) / 2],
          size: [thickness, height, depth + thickness * 2],
          rotationY: 0,
          enabled: true
        }
      ];
      return {
        ...navigation,
        zones: [...existing, ...boundaryZones]
      };
    });
    setNotice("saved");
  };

  const createWalkZonesFromViews = () => {
    const walkViews = manifest?.views.filter((view) => view.kind === "walk") ?? [];
    if (walkViews.length === 0) {
      return;
    }
    updateNavigation((navigation) => {
      const bounds = navigation.bounds;
      const existing = (navigation.zones ?? []).filter((zone) => !zone.id.startsWith("walk-view-"));
      const floorY = bounds ? bounds.min[1] + 0.03 : 0.03;
      const patchSize = bounds
        ? Math.max(1.6, Math.min(4, Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) * 0.16))
        : 2.4;
      const viewZones: NavigationZone[] = walkViews.map((view) => ({
        id: `walk-view-${view.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64),
        label: `${view.label} walk patch`,
        kind: "walk",
        center: [Number(view.position[0].toFixed(3)), Number(floorY.toFixed(3)), Number(view.position[2].toFixed(3))],
        size: [patchSize, 0.08, patchSize],
        rotationY: 0,
        enabled: true
      }));
      return {
        ...navigation,
        zones: [...existing, ...viewZones]
      };
    });
    setNotice("saved");
  };

  const addNavigationRepairZone = (kind: "walk" | "pass") => {
    const point = navigationRepairDraft?.point;
    if (!point) {
      return;
    }
    updateNavigation((navigation) => {
      const zones = [...(navigation.zones ?? [])];
      const idSuffix = `${Date.now()}`.slice(-6);
      const isWalk = kind === "walk";
      const floorY = navigation.bounds ? navigation.bounds.min[1] + 0.03 : 0.03;
      const zone: NavigationZone = {
        id: `${kind}-repair-${idSuffix}`,
        label: isWalk ? "Walk repair" : "Door pass repair",
        kind,
        center: [
          Number(point[0].toFixed(3)),
          isWalk ? Number(floorY.toFixed(3)) : Math.max(0.8, navigation.cameraHeight * 0.55),
          Number(point[2].toFixed(3))
        ],
        size: isWalk
          ? [2.2, 0.08, 2.2]
          : [0.9, Math.max(1.8, navigation.cameraHeight + 0.6), 1.35],
        rotationY: 0,
        enabled: true
      };
      return {
        ...navigation,
        zones: [...zones, zone]
      };
    });
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
      const zone: NavigationZone = {
        id: nextId,
        label: `Pass ${candidate.name}`.slice(0, 80),
        kind: "pass",
        center: candidate.center,
        size: candidate.size,
        rotationY: 0,
        enabled: true
      };
      return {
        ...navigation,
        zones: [...zones, zone]
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
      zones: (navigation.zones ?? []).map((zone) => (zone.id === zoneId ? updater(zone) : zone))
    }));
  };

  const removeNavigationZone = (zoneId: string) => {
    updateNavigation((navigation) => ({
      ...navigation,
      zones: (navigation.zones ?? []).filter((zone) => zone.id !== zoneId)
    }));
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
  };

  const moveNavigationZoneOnMap = (
    zoneId: string,
    mapElement: HTMLElement,
    clientX: number,
    clientY: number
  ) => {
    const bounds = manifest?.navigation.bounds;
    if (!bounds) {
      return;
    }
    const applyPosition = (x: number, y: number) => {
      const rect = mapElement.getBoundingClientRect();
      const ratioX = clampNumber((x - rect.left) / Math.max(1, rect.width), 0, 1);
      const ratioY = clampNumber((y - rect.top) / Math.max(1, rect.height), 0, 1);
      const nextX = bounds.min[0] + ratioX * (bounds.max[0] - bounds.min[0]);
      const nextZ = bounds.max[2] - ratioY * (bounds.max[2] - bounds.min[2]);
      updateNavigationZone(zoneId, (zone) => ({
        ...zone,
        center: [Number(nextX.toFixed(3)), zone.center[1], Number(nextZ.toFixed(3))]
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
        method: "POST"
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Lightmap bake failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        lightmapBakeJob: LightmapBakeJobDocument;
      };
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
      };
      setManifest(result.manifest);
      setControlsDoc(result.controls);
      setBundleStats(result.stats);
      setOptimizationDoc(result.optimization);
      setSelectedViewId(result.manifest.views[0]?.id ?? "");
      setRepairSummary(
        result.repairedExternalResources
          ? `Copied ${result.repairedExternalResources} missing texture resource(s) into the expected model paths.`
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
    if (!isGlb && !isZip) {
      setUploadState("error");
      setUploadError("Upload a GLB file or a ZIP containing a GLB/GLTF plus its textures.");
      return;
    }

    setUploadState("uploading");
    setUploadError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/model`, {
        method: "POST",
        headers: {
          "content-type": isZip ? "application/zip" : "model/gltf-binary",
          "x-file-name": file.name
        },
        body: file
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Upload failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest?: SceneManifest;
        controls?: SceneControlsDocument;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
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
      setUploadState("done");
      setNotice("saved");
    } catch (error) {
      setUploadState("error");
      setUploadError(error instanceof Error ? error.message : "Upload failed.");
    }
  };

  const uploadMaterialLightmap = async (materialId: string, file: File | undefined) => {
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
      setLightmapUploadError("Upload a PNG, JPEG, WebP, AVIF, or KTX2 lightmap.");
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
      updateMaterial(materialId, (material) => ({
        ...material,
        lightMapUrl: assetPath,
        lightMapIntensity: material.lightMapIntensity ?? 1,
        lightMapUvSet: material.lightMapUvSet ?? 1
      }));
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
      setLightmapUploadError(error instanceof Error ? error.message : "Lightmap upload failed.");
    }
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
      window.setTimeout(() => setSelectedRoomId(nextRooms[0]?.id ?? ""), 0);
      return {
        ...current,
        rooms: nextRooms
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
              <DiagnosticList diagnostics={bundleStats?.diagnostics ?? []} />
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
                  accept=".glb,.zip,model/gltf-binary,model/gltf+json,application/zip"
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
                    <Stat label="Loose images" value={String(bundleStats.looseImageCount ?? 0)} />
                    <Stat label="Geometry compression" value={geometryCompressionLabel(bundleStats)} />
                    <Stat label="Texture compression" value={textureCompressionLabel(bundleStats)} />
                  </div>
                  <AssetHealth stats={bundleStats} />
                  <DiagnosticList diagnostics={bundleStats.diagnostics ?? []} />
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
                  <div key={check.id} className={check.ready ? "readiness-row ready" : "readiness-row warn"}>
                    <span>{check.label}</span>
                    <strong>{check.detail}</strong>
                  </div>
                ))}
              </div>

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
                          <strong>{entry.version}</strong>
                          <span>{entry.publishedAt}</span>
                          {typeof entry.assetCount === "number" && (
                            <small>
                              {entry.assetCount} assets / {formatBytes(entry.totalBytes ?? 0)}
                            </small>
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
                        </div>
                        {entry.cdnBasePath && <code>{entry.cdnBasePath}</code>}
                        <code>{publishedEmbedSnippet(entry, manifest.branding.clientName ?? manifest.branding.title)}</code>
                        {entry.deploymentPath && (
                          <div className="deploy-command-list">
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
                  <button type="button" className="icon-action" title="Add room" onClick={addRoom}>
                    <Plus size={17} aria-hidden="true" />
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
                </div>
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
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!apiConnected || bakeState === "baking"}
                    onClick={() => void bakeLightmaps()}
                  >
                    <Activity size={16} aria-hidden="true" />
                    {bakeState === "baking" ? "Baking" : "Bake"}
                  </button>
                </div>
                {bakeError && <p className="error-note">{bakeError}</p>}
                {lightmapBakeJob && lightmapBakeJob.status !== "idle" && (
                  <div className="job-step-list">
                    <div className={`job-step-row ${lightmapBakeJob.status === "blocked" ? "failed" : "completed"}`}>
                      <div className="job-step-main">
                        <span>{lightmapBakeJob.engine}</span>
                        {lightmapBakeJob.message && <small>{lightmapBakeJob.message}</small>}
                      </div>
                      <strong>{lightmapBakeJob.status}</strong>
                    </div>
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
                      accept=".avif,.jpg,.jpeg,.ktx2,.png,.webp,image/avif,image/jpeg,image/png,image/webp"
                      disabled={!apiConnected || lightmapUploadState === "uploading"}
                      onChange={(event) => void uploadMaterialLightmap(selectedMaterial.id, event.target.files?.[0])}
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
              {sceneGraph?.nodes.map((node) => (
                <div
                  key={node.id}
                  className={selectedObjectId === node.id ? "list-row active" : "list-row"}
                >
                  <button type="button" className="list-row-main" onClick={() => setSelectedObjectId(node.id)}>
                    <span>{node.name}</span>
                    <small>{node.triangleCount} triangles</small>
                  </button>
                  <button
                    type="button"
                    className="visibility-button"
                    title={
                      objectsDoc?.objects.find((object) => object.id === node.id)?.visible === false
                        ? "Show object"
                        : "Hide object"
                    }
                    onClick={() =>
                      updateObject(node.id, (object) => ({
                        ...object,
                        visible: !object.visible
                      }))
                    }
                  >
                    {objectsDoc?.objects.find((object) => object.id === node.id)?.visible === false ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                  </button>
                </div>
              ))}
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
                </div>

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
                      label="Click Glide"
                      min={0.4}
                      max={6}
                      step={0.1}
                      value={controlsDoc.movement.clickMoveSpeed ?? 1.2}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, clickMoveSpeed: value }
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
                    {navigationRepairDraft && (
                      <div className="repair-card">
                        <div>
                          <strong>Viewer navigation repair</strong>
                          <p className="quiet-note">
                            This came from the viewer block toast. Add a pass zone for a doorway/opening, add a walk
                            patch when the floor is missing from the walkable area, or ignore a wrongly detected blocker.
                          </p>
                        </div>
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
                          {navigationRepairDraft.point && (
                            <div>
                              <dt>Point</dt>
                              <dd>{navigationRepairDraft.point.map((value) => value.toFixed(2)).join(", ")}</dd>
                            </div>
                          )}
                        </dl>
                        <div className="inline-actions">
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!navigationRepairDraft.point}
                            onClick={() => addNavigationRepairZone("pass")}
                          >
                            <Plus size={16} aria-hidden="true" />
                            Door Pass
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!navigationRepairDraft.point}
                            onClick={() => addNavigationRepairZone("walk")}
                          >
                            <Plus size={16} aria-hidden="true" />
                            Walk Patch
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={!navigationRepairDraft.blockerName}
                            onClick={() => ignoreCollisionName(navigationRepairDraft.blockerName)}
                          >
                            Ignore Blocker
                          </button>
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => setNavigationRepairDraft(null)}
                          >
                            Dismiss
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="navigation-qa-list" aria-label="Navigation QA">
                      {navigationIssues.map((issue) => (
                        <div key={issue.id} className={`navigation-qa-card ${issue.severity}`}>
                          <div>
                            <strong>{issue.title}</strong>
                            <p>{issue.detail}</p>
                            {issue.action && <small>{issue.action}</small>}
                          </div>
                        </div>
                      ))}
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
                      </div>
                    </div>
                    {manifest.navigation.bounds && (manifest.navigation.zones ?? []).length > 0 && (
                      <div className="zone-map">
                        <div className="zone-map-heading">
                          <strong>Zone map</strong>
                          <small>Drag a zone to move its center on X/Z</small>
                        </div>
                        <div className="zone-map-surface">
                          {navigationRepairDraft?.point && (
                            <span
                              className="zone-map-repair-point"
                              style={pointMapStyle(navigationRepairDraft.point, manifest.navigation.bounds!)}
                              title="Viewer blocked point"
                            />
                          )}
                          {(manifest.navigation.zones ?? []).map((zone) => (
                            <button
                              key={zone.id}
                              type="button"
                              className={`zone-map-item ${zone.kind}${zone.enabled === false ? " disabled" : ""}`}
                              style={zoneMapStyle(zone, manifest.navigation.bounds!)}
                              title={`${zone.label} (${zone.kind})`}
                              onPointerDown={(event) => {
                                event.preventDefault();
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
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="zone-editor-list">
                      {(manifest.navigation.zones ?? []).map((zone) => (
                        <div key={zone.id} className="zone-editor-row">
                          <div className="zone-editor-heading">
                            <label>
                              <span>Label</span>
                              <input
                                value={zone.label}
                                onChange={(event) =>
                                  updateNavigationZone(zone.id, (current) => ({
                                    ...current,
                                    label: event.target.value
                                  }))
                                }
                              />
                            </label>
                            <label>
                              <span>Kind</span>
                              <select
                                value={zone.kind}
                                onChange={(event) =>
                                  updateNavigationZone(zone.id, (current) => ({
                                    ...current,
                                    kind: event.target.value as NavigationZone["kind"]
                                  }))
                                }
                              >
                                <option value="walk">Walk</option>
                                <option value="block">Block</option>
                                <option value="pass">Pass</option>
                              </select>
                            </label>
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
                              <span>Enabled</span>
                            </label>
                            <button
                              type="button"
                              className="icon-action danger"
                              title="Delete zone"
                              onClick={() => removeNavigationZone(zone.id)}
                            >
                              <Trash2 size={17} aria-hidden="true" />
                            </button>
                          </div>
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
                        </div>
                      ))}
                      {(manifest.navigation.zones ?? []).length === 0 && (
                        <p className="quiet-note">
                          No explicit zones yet. Add a walk zone to define clickable floor area, block zones for hard
                          boundaries, and pass zones for doors or openings.
                        </p>
                      )}
                    </div>
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
              <pre className="json-preview">{JSON.stringify(controlsDoc, null, 2)}</pre>
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
  diagnostics
}: {
  diagnostics: NonNullable<BundleStats["diagnostics"]>;
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
      {diagnostics.map((diagnostic) => (
        <div key={diagnostic.code} className={`diagnostic-card ${diagnostic.severity}`}>
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{diagnostic.title}</strong>
            <p>{diagnostic.message}</p>
            {diagnostic.action && <small>{diagnostic.action}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function AssetHealth({ stats }: { stats: BundleStats }) {
  const missingAssets = (stats.assets ?? []).filter((asset) => !asset.exists);
  const externalResources = (stats.models ?? []).flatMap((model) => model.externalResources ?? []);
  const missingResources = externalResources.filter((resource) => !resource.exists);
  const looseImages = stats.looseImages ?? [];
  const hasDetails =
    missingAssets.length > 0 || missingResources.length > 0 || looseImages.length > 0 || externalResources.length > 0;

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
            <code key={image.source}>
              {image.source} · {formatBytes(image.bytes)}
            </code>
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
