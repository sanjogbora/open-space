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
  ignoredCollisionMeshNames?: readonly string[];
  zones?: readonly NavigationZone[];
  bounds?: {
    min: Vec3;
    max: Vec3;
  };
}

export type NavigationZoneKind = "walk" | "block" | "pass";

export interface NavigationZone {
  id: string;
  label: string;
  kind: NavigationZoneKind;
  center: Vec3;
  size: Vec3;
  rotationY?: number;
  enabled?: boolean;
  source?: "authored" | "generated";
  generatedBy?: string;
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

export interface RenderingConfig {
  doubleSidedMaterials?: boolean;
  modelScale?: number;
}

export interface EnvironmentConfig {
  backgroundColor?: string;
  skyBackdropEnabled?: boolean;
  skyTopColor?: string;
  skyHorizonColor?: string;
  groundEnabled?: boolean;
  groundColor?: string;
  groundSize?: number;
  groundY?: number;
  enclosureEnabled?: boolean;
  enclosureColor?: string;
  enclosureHeight?: number;
  enclosureRadius?: number;
}

export interface RoomDefinition {
  id: string;
  label: string;
  viewId?: string;
  dimensions?: string;
  center?: Vec3;
  bounds?: {
    min: Vec3;
    max: Vec3;
  };
}

export interface SceneManifest {
  schemaVersion: "0.1";
  sceneUrl?: string;
  originalSceneUrl?: string;
  graphUrl?: string;
  materialsUrl?: string;
  objectsUrl?: string;
  controlsUrl?: string;
  rendering?: RenderingConfig;
  environment?: EnvironmentConfig;
  rooms?: readonly RoomDefinition[];
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
    clickMoveSpeed?: number;
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
  lightMapUrl?: string;
  lightMapIntensity?: number;
  lightMapUvSet?: number;
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
  collisionMeshNames: ["wall", "glass", "door", "collision"],
  ignoredCollisionMeshNames: [],
  zones: []
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
  const zones = value["zones"];
  const zonesValid = zones === undefined || (Array.isArray(zones) && zones.every(isNavigationZone));

  return (
    typeof value["cameraHeight"] === "number" &&
    typeof value["moveSpeed"] === "number" &&
    typeof value["turnSpeed"] === "number" &&
    isStringArray(value["floorMeshNames"]) &&
    isStringArray(value["collisionMeshNames"]) &&
    (value["ignoredCollisionMeshNames"] === undefined ||
      isStringArray(value["ignoredCollisionMeshNames"])) &&
    zonesValid &&
    boundsValid
  );
}

export function isNavigationZone(value: unknown): value is NavigationZone {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["id"] === "string" &&
    typeof value["label"] === "string" &&
    (value["kind"] === "walk" || value["kind"] === "block" || value["kind"] === "pass") &&
    isVec3(value["center"]) &&
    isVec3(value["size"]) &&
    (value["rotationY"] === undefined || typeof value["rotationY"] === "number") &&
    (value["enabled"] === undefined || typeof value["enabled"] === "boolean") &&
    (value["source"] === undefined || value["source"] === "authored" || value["source"] === "generated") &&
    (value["generatedBy"] === undefined || typeof value["generatedBy"] === "string")
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

export function isRenderingConfig(value: unknown): value is RenderingConfig {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value["doubleSidedMaterials"] === undefined || typeof value["doubleSidedMaterials"] === "boolean") &&
    (value["modelScale"] === undefined ||
      (typeof value["modelScale"] === "number" &&
        Number.isFinite(value["modelScale"]) &&
        value["modelScale"] > 0))
  );
}

export function isEnvironmentConfig(value: unknown): value is EnvironmentConfig {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value["backgroundColor"] === undefined || typeof value["backgroundColor"] === "string") &&
    (value["skyBackdropEnabled"] === undefined || typeof value["skyBackdropEnabled"] === "boolean") &&
    (value["skyTopColor"] === undefined || typeof value["skyTopColor"] === "string") &&
    (value["skyHorizonColor"] === undefined || typeof value["skyHorizonColor"] === "string") &&
    (value["groundEnabled"] === undefined || typeof value["groundEnabled"] === "boolean") &&
    (value["groundColor"] === undefined || typeof value["groundColor"] === "string") &&
    (value["groundSize"] === undefined || typeof value["groundSize"] === "number") &&
    (value["groundY"] === undefined || typeof value["groundY"] === "number") &&
    (value["enclosureEnabled"] === undefined || typeof value["enclosureEnabled"] === "boolean") &&
    (value["enclosureColor"] === undefined || typeof value["enclosureColor"] === "string") &&
    (value["enclosureHeight"] === undefined || typeof value["enclosureHeight"] === "number") &&
    (value["enclosureRadius"] === undefined || typeof value["enclosureRadius"] === "number")
  );
}

export function isRoomDefinition(value: unknown): value is RoomDefinition {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["id"] === "string" &&
    typeof value["label"] === "string" &&
    (value["viewId"] === undefined || typeof value["viewId"] === "string") &&
    (value["dimensions"] === undefined || typeof value["dimensions"] === "string") &&
    (value["center"] === undefined || isVec3(value["center"])) &&
    (value["bounds"] === undefined ||
      (isRecord(value["bounds"]) && isVec3(value["bounds"]["min"]) && isVec3(value["bounds"]["max"])))
  );
}

export function isSceneManifest(value: unknown): value is SceneManifest {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value["schemaVersion"] === "0.1" &&
    (value["sceneUrl"] === undefined || typeof value["sceneUrl"] === "string") &&
    (value["originalSceneUrl"] === undefined || typeof value["originalSceneUrl"] === "string") &&
    (value["graphUrl"] === undefined || typeof value["graphUrl"] === "string") &&
    (value["materialsUrl"] === undefined || typeof value["materialsUrl"] === "string") &&
    (value["objectsUrl"] === undefined || typeof value["objectsUrl"] === "string") &&
    (value["controlsUrl"] === undefined || typeof value["controlsUrl"] === "string") &&
    (value["rendering"] === undefined || isRenderingConfig(value["rendering"])) &&
    (value["environment"] === undefined || isEnvironmentConfig(value["environment"])) &&
    (value["rooms"] === undefined || (Array.isArray(value["rooms"]) && value["rooms"].every(isRoomDefinition))) &&
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
