export type Vec3 = readonly [number, number, number];
export type Euler3 = readonly [number, number, number];

export type ViewKind = "walk" | "orbit" | "top";

export interface SceneView {
  id: string;
  label: string;
  kind: ViewKind;
  position: Vec3;
  target: Vec3;
  fov?: number;
  thumbnail?: string;
}

export type InteractionKind =
  | "hotspot"
  | "link"
  | "video-texture"
  | "material-variant"
  | "object-toggle";

export interface BaseInteraction {
  id: string;
  kind: InteractionKind;
  label: string;
  enabled?: boolean;
}

export interface HotspotInteraction extends BaseInteraction {
  kind: "hotspot";
  position: Vec3;
  title: string;
  body?: string;
  icon?: "info" | "media" | "link";
}

export interface LinkInteraction extends BaseInteraction {
  kind: "link";
  position: Vec3;
  url: string;
  openInNewTab?: boolean;
}

export interface VideoTextureInteraction extends BaseInteraction {
  kind: "video-texture";
  source: string;
  targetMeshName?: string;
  targetMaterialName?: string;
  autoplay?: boolean;
  muted?: boolean;
  loop?: boolean;
  triggerDistance?: number;
}

export interface MaterialVariant {
  id: string;
  label: string;
  color?: string;
  texture?: string;
}

export interface MaterialVariantInteraction extends BaseInteraction {
  kind: "material-variant";
  targetMeshName?: string;
  targetMaterialName?: string;
  variants: readonly MaterialVariant[];
}

export interface ObjectToggleInteraction extends BaseInteraction {
  kind: "object-toggle";
  position: Vec3;
  targetObjectId?: string;
  targetObjectName?: string;
  initiallyVisible?: boolean;
}

export type SceneInteraction =
  | HotspotInteraction
  | LinkInteraction
  | VideoTextureInteraction
  | MaterialVariantInteraction
  | ObjectToggleInteraction;

export interface NavigationConfig {
  cameraHeight: number;
  moveSpeed: number;
  turnSpeed: number;
  floorMeshNames: readonly string[];
  collisionMeshNames: readonly string[];
  bounds?: {
    min: Vec3;
    max: Vec3;
  };
}

export interface BrandingConfig {
  title: string;
  clientName?: string;
  logoUrl?: string;
  theme: "light" | "dark" | "system";
  accentColor: string;
  showBranding?: boolean;
}

export interface QualityProfile {
  id: "mobile" | "balanced" | "desktop";
  label: string;
  maxPixelRatio: number;
  shadows: boolean;
  antialias: boolean;
}

export interface SceneManifest {
  schemaVersion: "0.1";
  sceneUrl?: string;
  graphUrl?: string;
  materialsUrl?: string;
  objectsUrl?: string;
  controlsUrl?: string;
  views: readonly SceneView[];
  interactions: readonly SceneInteraction[];
  navigation: NavigationConfig;
  branding: BrandingConfig;
  qualityProfiles: readonly QualityProfile[];
}

export interface SceneControlsDocument {
  schemaVersion: "0.1";
  movement: {
    enabled: boolean;
    clickToMove: boolean;
    keyboard: boolean;
    dragLook: boolean;
    moveSpeed: number;
    lookSensitivityX: number;
    lookSensitivityY: number;
    clickMoveThresholdPx: number;
  };
}

export interface ObjectOverride {
  id: string;
  name: string;
  visible: boolean;
  locked?: boolean;
}

export interface SceneObjectsDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  objects: readonly ObjectOverride[];
}

export interface MaterialOverride {
  id: string;
  name: string;
  baseColor?: string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
}

export interface SceneMaterialsDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  materials: readonly MaterialOverride[];
}

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export interface SceneGraphMaterial {
  id: string;
  name: string;
  meshCount: number;
  primitiveCount: number;
  triangleCount: number;
}

export interface SceneGraphNode {
  id: string;
  name: string;
  sourceIndex: number;
  parentId?: string;
  meshIndex?: number;
  meshName?: string;
  materialIds: readonly string[];
  vertexCount: number;
  triangleCount: number;
  bounds?: Bounds3;
}

export interface SceneGraphDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  nodes: readonly SceneGraphNode[];
  materials: readonly SceneGraphMaterial[];
}

export const defaultQualityProfiles: readonly QualityProfile[] = [
  {
    id: "mobile",
    label: "Mobile",
    maxPixelRatio: 1.25,
    shadows: false,
    antialias: false
  },
  {
    id: "balanced",
    label: "Balanced",
    maxPixelRatio: 1.5,
    shadows: true,
    antialias: true
  },
  {
    id: "desktop",
    label: "Desktop",
    maxPixelRatio: 2,
    shadows: true,
    antialias: true
  }
] as const;

export const defaultNavigationConfig: NavigationConfig = {
  cameraHeight: 1.65,
  moveSpeed: 3.8,
  turnSpeed: 1.5,
  floorMeshNames: ["floor", "ground", "navmesh", "walkable"],
  collisionMeshNames: ["wall", "glass", "door", "collision"]
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVec3(value: unknown): value is Vec3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isSceneView(value: unknown): value is SceneView {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["id"] === "string" &&
    typeof value["label"] === "string" &&
    (value["kind"] === "walk" || value["kind"] === "orbit" || value["kind"] === "top") &&
    isVec3(value["position"]) &&
    isVec3(value["target"]) &&
    (value["fov"] === undefined || typeof value["fov"] === "number")
  );
}

export function isSceneInteraction(value: unknown): value is SceneInteraction {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["label"] !== "string") {
    return false;
  }

  if (value["kind"] === "hotspot") {
    return isVec3(value["position"]) && typeof value["title"] === "string";
  }

  if (value["kind"] === "link") {
    return isVec3(value["position"]) && typeof value["url"] === "string";
  }

  if (value["kind"] === "video-texture") {
    return (
      typeof value["source"] === "string" &&
      (value["targetMeshName"] === undefined || typeof value["targetMeshName"] === "string") &&
      (value["targetMaterialName"] === undefined || typeof value["targetMaterialName"] === "string")
    );
  }

  if (value["kind"] === "material-variant") {
    return Array.isArray(value["variants"]);
  }

  if (value["kind"] === "object-toggle") {
    return (
      isVec3(value["position"]) &&
      (value["targetObjectId"] === undefined || typeof value["targetObjectId"] === "string") &&
      (value["targetObjectName"] === undefined || typeof value["targetObjectName"] === "string")
    );
  }

  return false;
}

export function isNavigationConfig(value: unknown): value is NavigationConfig {
  if (!isRecord(value)) {
    return false;
  }

  const bounds = value["bounds"];
  const boundsValid =
    bounds === undefined ||
    (isRecord(bounds) && isVec3(bounds["min"]) && isVec3(bounds["max"]));

  return (
    typeof value["cameraHeight"] === "number" &&
    typeof value["moveSpeed"] === "number" &&
    typeof value["turnSpeed"] === "number" &&
    isStringArray(value["floorMeshNames"]) &&
    isStringArray(value["collisionMeshNames"]) &&
    boundsValid
  );
}

export function isBrandingConfig(value: unknown): value is BrandingConfig {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["title"] === "string" &&
    (value["theme"] === "light" || value["theme"] === "dark" || value["theme"] === "system") &&
    typeof value["accentColor"] === "string"
  );
}

export function isQualityProfile(value: unknown): value is QualityProfile {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value["id"] === "mobile" || value["id"] === "balanced" || value["id"] === "desktop") &&
    typeof value["label"] === "string" &&
    typeof value["maxPixelRatio"] === "number" &&
    typeof value["shadows"] === "boolean" &&
    typeof value["antialias"] === "boolean"
  );
}

export function isSceneManifest(value: unknown): value is SceneManifest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value["schemaVersion"] === "0.1" &&
    (value["sceneUrl"] === undefined || typeof value["sceneUrl"] === "string") &&
    (value["graphUrl"] === undefined || typeof value["graphUrl"] === "string") &&
    (value["materialsUrl"] === undefined || typeof value["materialsUrl"] === "string") &&
    (value["objectsUrl"] === undefined || typeof value["objectsUrl"] === "string") &&
    (value["controlsUrl"] === undefined || typeof value["controlsUrl"] === "string") &&
    Array.isArray(value["views"]) &&
    value["views"].every(isSceneView) &&
    Array.isArray(value["interactions"]) &&
    value["interactions"].every(isSceneInteraction) &&
    isNavigationConfig(value["navigation"]) &&
    isBrandingConfig(value["branding"]) &&
    Array.isArray(value["qualityProfiles"]) &&
    value["qualityProfiles"].every(isQualityProfile)
  );
}

export function parseSceneManifest(value: unknown): SceneManifest {
  if (!isSceneManifest(value)) {
    throw new Error("Invalid scene manifest. Expected schemaVersion 0.1 with valid views, interactions, navigation, branding, and quality profiles.");
  }
  return value;
}
