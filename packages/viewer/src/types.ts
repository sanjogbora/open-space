import type {
  HotspotInteraction,
  SceneManifest,
  SceneView
} from "@walkthrough/scene-schema";

export type ViewerQuality = "mobile" | "balanced" | "desktop";

export interface LoadingProgress {
  loaded: number;
  total: number;
  ratio: number;
  label: string;
}

export interface HotspotActivation {
  interaction: HotspotInteraction;
  screen: {
    x: number;
    y: number;
  };
}

export interface ObjectPickActivation {
  objectName: string;
  materialNames: readonly string[];
  point: [number, number, number];
  screen: {
    x: number;
    y: number;
  };
}

export type NavigationFailureReason =
  | "no-walkable-hit"
  | "outside-bounds"
  | "outside-walk-zone"
  | "route-not-found"
  | "blocked-step"
  | "blocked-collision";

export interface NavigationFailure {
  reason: NavigationFailureReason;
  message: string;
  point?: [number, number, number];
  cameraPosition?: [number, number, number];
  objectName?: string;
  blockerName?: string;
  blockerKind?: "authored" | "named" | "inferred";
  screen: {
    x: number;
    y: number;
  };
}

export interface ViewerCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  yaw: number;
  pitch: number;
}

export interface ViewerEventMap {
  ready: undefined;
  progress: LoadingProgress;
  viewchange: SceneView;
  hotspot: HotspotActivation;
  objectpick: ObjectPickActivation;
  navigationfailure: NavigationFailure;
  error: Error;
}

export interface ViewerOptions {
  container: HTMLElement;
  manifest: SceneManifest;
  quality?: ViewerQuality;
  debug?: boolean;
  onReady?: () => void;
  onProgress?: (progress: LoadingProgress) => void;
  onViewChange?: (view: SceneView) => void;
  onHotspot?: (activation: HotspotActivation) => void;
  onObjectPick?: (activation: ObjectPickActivation) => void;
  onNavigationFailure?: (failure: NavigationFailure) => void;
  onError?: (error: Error) => void;
}
