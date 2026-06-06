import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type {
  HotspotInteraction,
  LinkInteraction,
  MaterialVariantInteraction,
  MaterialOverride,
  NavigationZone,
  ObjectOverride,
  ObjectToggleInteraction,
  SceneControlsDocument,
  SceneInteraction,
  SceneManifest,
  SceneView,
  Vec2,
  VideoTextureInteraction
} from "@walkthrough/scene-schema";
import {
  closestPolygonPointPair2D,
  navigationZoneConnectionPadding,
  pointToPolygonDistance2D,
  polygonDistance2D
} from "@walkthrough/scene-schema";
import { createDemoScene } from "./demo-scene";
import { createHotspotSprite } from "./hotspot-sprite";
import { clampToBounds, damp, dampAngle, easeOutCubic, toVector3 } from "./math";
import { createMoveMarker } from "./marker";
import type {
  LoadingProgress,
  NavigationFailureReason,
  NavigationRepairAction,
  ViewerCameraPose,
  ViewerOptions,
  ViewerQuality
} from "./types";
import { createManagedVideoTexture, type ManagedTexture } from "./video-textures";

interface CameraTween {
  fromPosition: THREE.Vector3;
  toPosition: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  elapsed: number;
  duration: number;
  view?: SceneView;
}

interface HotspotBinding {
  interaction: HotspotInteraction | LinkInteraction | ObjectToggleInteraction;
  sprite: THREE.Sprite;
}

interface TopViewHiddenObject {
  object: THREE.Object3D;
  visibleOutsideTopView: boolean;
}

interface CollisionBlocker {
  box: THREE.Box3;
  name: string;
  kind: "authored" | "named" | "inferred";
}

interface NavigationFailureDetail {
  reason: NavigationFailureReason;
  blockerName?: string;
  blockerKind?: CollisionBlocker["kind"];
  point?: THREE.Vector3;
}

interface RouteNode {
  point: THREE.Vector3;
  previous: number;
  cost: number;
  visited: boolean;
}

interface GridRouteNode {
  x: number;
  z: number;
  previous?: string;
  cost: number;
  estimate: number;
  closed: boolean;
}

interface GridRouteCell {
  point: THREE.Vector3;
  floorY?: number;
  clearance: number;
  onPassZone: boolean;
}

interface ZoneRouteNode {
  mesh: THREE.Mesh;
  center: THREE.Vector3;
  previous: number;
  cost: number;
  estimate: number;
  closed: boolean;
}

interface NavigationMeshBounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface RecoveredNavigationTarget {
  target: THREE.Vector3;
  route?: THREE.Vector3[];
}

export class WalkthroughViewer {
  private readonly container: HTMLElement;
  private readonly manifest: SceneManifest;
  private readonly options: ViewerOptions;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 250);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly lightRig = new THREE.Group();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly loader = new GLTFLoader();
  private readonly dracoLoader = new DRACOLoader();
  private readonly ktx2Loader = new KTX2Loader();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly moveMarker = createMoveMarker();
  private readonly modelScale: number;
  private readonly modelOffset: THREE.Vector3;
  private readonly manifestScale: number;
  private readonly cameraHeight: number;
  private readonly hotspots: HotspotBinding[] = [];
  private readonly managedTextures: ManagedTexture[] = [];
  private readonly keys = new Set<string>();
  private readonly defaultCollisionRadius = 0.28;
  private readonly maxStepUp = 0.38;
  private readonly maxStepDown = 0.72;
  private readonly materialOverrides = new Map<string, MaterialOverride>();
  private readonly materialLightMaps: THREE.Texture[] = [];
  private readonly materialTextures: THREE.Texture[] = [];
  private readonly objectOverrides = new Map<string, ObjectOverride>();
  private readonly objectToggleStates = new Map<string, boolean>();
  private readonly topViewHiddenObjects: TopViewHiddenObject[] = [];
  private topViewShellHidden = false;
  private controls: SceneControlsDocument["movement"] = {
    enabled: true,
    clickToMove: true,
    keyboard: true,
    dragLook: true,
    moveSpeed: 3.8,
    clickMoveSpeed: 1.05,
    wheelMoveSpeed: 1,
    collisionRadius: 0.28,
    maxStepUp: 0.38,
    maxStepDown: 0.72,
    floorBumpTolerance: 0.48,
    floorHeightSmoothing: 0.9,
    lookSensitivityX: 0.004,
    lookSensitivityY: 0.0035,
    clickMoveThresholdPx: 8
  };

  private floorMeshes: THREE.Object3D[] = [];
  private geometryFloorMeshes: THREE.Object3D[] = [];
  private explicitWalkMeshes: THREE.Object3D[] = [];
  private walkableMeshes: THREE.Object3D[] = [];
  private pickableMeshes: THREE.Object3D[] = [];
  private collisionBlockers: CollisionBlocker[] = [];
  private collisionDebugHelpers: THREE.Box3Helper[] = [];
  private navigationZoneMeshes: THREE.Mesh[] = [];
  private walkZoneMeshes: THREE.Mesh[] = [];
  private passZoneMeshes: THREE.Mesh[] = [];
  private generatedWalkZonesOnly = false;
  private sceneRoot: THREE.Object3D | undefined;
  private frameId = 0;
  private destroyed = false;
  private cameraTarget = new THREE.Vector3(0, 1.55, 0);
  private moveTarget: THREE.Vector3 | undefined;
  private movePath: THREE.Vector3[] = [];
  private clickMoveVelocity = 0;
  private cameraTween: CameraTween | undefined;
  private stableFloorY: number | undefined;
  private pendingFloorY: number | undefined;
  private pendingFloorSamples = 0;
  private routeSearchFailureDetail: NavigationFailureDetail | undefined;
  private activeView: SceneView | undefined;
  private pointerDown: { x: number; y: number; time: number } | undefined;
  private yaw = 0;
  private pitch = 0;
  private wheelVelocity = 0;
  private draggingLook = false;
  private lastPointer: { x: number; y: number } | undefined;
  private quality: ViewerQuality;
  private minBounds: THREE.Vector3 | undefined;
  private maxBounds: THREE.Vector3 | undefined;
  private sunLight: THREE.DirectionalLight | undefined;
  private sunTarget: THREE.Object3D | undefined;
  private environmentTexture: THREE.Texture | undefined;
  private skyTexture: THREE.Texture | undefined;
  private groundTexture: THREE.Texture | undefined;
  private enclosureTexture: THREE.Texture | undefined;
  private pmremGenerator: THREE.PMREMGenerator | undefined;
  private debug: boolean;

  constructor(options: ViewerOptions) {
    this.container = options.container;
    this.manifest = options.manifest;
    this.options = options;
    this.quality = options.quality ?? "balanced";
    this.debug = options.debug ?? false;
    const legacyScale = this.resolveLegacyCoordinateScale();
    this.modelScale = this.manifest.rendering?.modelScale ?? legacyScale;
    this.modelOffset = toVector3(this.manifest.rendering?.modelOffset ?? [0, 0, 0]);
    this.manifestScale = this.manifest.rendering?.modelScale ? 1 : legacyScale;
    this.cameraHeight = this.manifest.navigation.cameraHeight * this.manifestScale;

    const selectedQuality = this.manifest.qualityProfiles.find((item) => item.id === this.quality);
    this.renderer = new THREE.WebGLRenderer({
      antialias: selectedQuality?.antialias ?? true,
      alpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = this.rendererToneMapping();
    this.renderer.toneMappingExposure = this.rendererExposure();
    this.renderer.shadowMap.enabled = selectedQuality?.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor("#d8dde2", 1);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "3D walkthrough viewport");
    this.renderer.domElement.className = "walkthrough-canvas";
    this.container.appendChild(this.renderer.domElement);
    this.dracoLoader.setDecoderPath("/draco/");
    this.dracoLoader.preload();
    this.loader.setDRACOLoader(this.dracoLoader);
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    this.ktx2Loader.setTranscoderPath("/basis/");
    this.ktx2Loader.detectSupport(this.renderer);
    this.loader.setKTX2Loader(this.ktx2Loader);

    this.scene.name = "walkthrough-scene";
    this.applyEnvironment();
    this.scene.add(this.lightRig);
    this.scene.add(this.moveMarker);
    this.applyBounds();
    this.installEvents();
    this.resize();
    this.applyInitialCamera();
  }

  private rendererToneMapping(): THREE.ToneMapping {
    switch (this.manifest.rendering?.toneMapping) {
      case "none":
        return THREE.NoToneMapping;
      case "linear":
        return THREE.LinearToneMapping;
      case "reinhard":
        return THREE.ReinhardToneMapping;
      case "cineon":
        return THREE.CineonToneMapping;
      case "aces":
      default:
        return THREE.ACESFilmicToneMapping;
    }
  }

  private rendererExposure(): number {
    const exposure = this.manifest.rendering?.exposure;
    return typeof exposure === "number" && Number.isFinite(exposure)
      ? THREE.MathUtils.clamp(exposure, 0.1, 4)
      : 1.05;
  }

  async start(): Promise<void> {
    this.emitProgress({ loaded: 0, total: 1, ratio: 0, label: "Preparing scene" });
    await Promise.all([this.loadMaterialOverrides(), this.loadObjectOverrides(), this.loadControls()]);
    await this.loadScene();
    this.configureInteractions();
    this.options.onReady?.();
    this.animate();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    this.managedTextures.forEach((item) => item.destroy?.());
    this.materialLightMaps.forEach((texture) => texture.dispose());
    this.materialTextures.forEach((texture) => texture.dispose());
    this.skyTexture?.dispose();
    this.groundTexture?.dispose();
    this.enclosureTexture?.dispose();
    this.collisionDebugHelpers.forEach((helper) => {
      helper.geometry.dispose();
      if (Array.isArray(helper.material)) {
        helper.material.forEach((material) => material.dispose());
      } else {
        helper.material.dispose();
      }
    });
    this.navigationZoneMeshes.forEach((mesh) => {
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => material.dispose());
      } else {
        mesh.material.dispose();
      }
    });
    this.environmentTexture?.dispose();
    this.pmremGenerator?.dispose();
    this.dracoLoader.dispose();
    this.ktx2Loader.dispose();
    this.uninstallEvents();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  goToView(viewId: string): void {
    const view = this.manifest.views.find((item) => item.id === viewId);
    if (!view) {
      return;
    }
    this.activeView = view;
    this.applyViewObjectVisibility(view);
    this.cancelClickMove();
    this.stableFloorY = undefined;
    this.resetPendingFloorTransition();
    this.cameraTween = {
      fromPosition: this.camera.position.clone(),
      toPosition: this.toSceneVector(view.position, { preserveMeterY: true }),
      fromTarget: this.cameraTarget.clone(),
      toTarget: this.toSceneVector(view.target, { preserveMeterY: true }),
      elapsed: 0,
      duration: view.kind === "top" ? 1.1 : 0.85,
      view
    };
  }

  setQuality(quality: ViewerQuality): void {
    this.quality = quality;
    const selectedQuality = this.manifest.qualityProfiles.find((item) => item.id === quality);
    const pixelRatio = Math.min(window.devicePixelRatio, selectedQuality?.maxPixelRatio ?? 1.5);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.shadowMap.enabled = selectedQuality?.shadows ?? true;
    this.resize();
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
    this.updateNavigationZoneVisibility();
  }

  captureScreenshot(type = "image/png", quality = 0.92): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL(type, quality);
  }

  getCameraPose(): ViewerCameraPose {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.cameraTarget.x, this.cameraTarget.y, this.cameraTarget.z],
      yaw: this.yaw,
      pitch: this.pitch
    };
  }

  applyMaterialVariant(interactionId: string, variantId: string): void {
    const interaction = this.manifest.interactions.find(
      (item): item is MaterialVariantInteraction =>
        item.kind === "material-variant" && item.id === interactionId
    );
    const variant = interaction?.variants.find((item) => item.id === variantId);
    if (!interaction || !variant) {
      return;
    }

    const targets = this.findMaterialVariantTargets(interaction);
    targets.forEach((target) => {
      const nextMaterial = target.material.clone();
      nextMaterial.name = target.material.name;
      if ("color" in nextMaterial && nextMaterial.color instanceof THREE.Color && variant.color) {
        nextMaterial.color.set(variant.color);
      }
      if ("map" in nextMaterial && variant.texture) {
        const texturedMaterial = nextMaterial as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
        texturedMaterial.map = this.loadMaterialTexture(
          variant.texture,
          `${nextMaterial.name || variant.label}-variant-map`,
          THREE.SRGBColorSpace
        );
      }
      nextMaterial.needsUpdate = true;
      if (Array.isArray(target.mesh.material)) {
        target.mesh.material = target.mesh.material.map((material, index) =>
          index === target.materialIndex ? nextMaterial : material
        );
      } else {
        target.mesh.material = nextMaterial;
      }
    });
  }

  private async loadScene(): Promise<void> {
    this.addLighting();

    if (!this.manifest.sceneUrl) {
      this.installDemoScene();
      return;
    }

    try {
      const gltf = await this.loader.loadAsync(this.manifest.sceneUrl, (event) => {
        const total = event.total || 1;
        const progress: LoadingProgress = {
          loaded: event.loaded,
          total,
          ratio: Math.min(1, event.loaded / total),
          label: "Loading model"
        };
        this.emitProgress(progress);
      });
      this.sceneRoot = gltf.scene;
      this.sceneRoot.name = "source-scene";
      if (this.modelScale !== 1) {
        this.sceneRoot.scale.multiplyScalar(this.modelScale);
      }
      if (this.modelOffset.lengthSq() > 0) {
        this.sceneRoot.position.add(this.modelOffset);
      }
      this.prepareLoadedScene(this.sceneRoot);
      this.scene.add(this.sceneRoot);
      this.sceneRoot.updateMatrixWorld(true);
      this.applyViewObjectVisibility(this.activeView);
      this.pickableMeshes = this.collectPickableMeshes(this.sceneRoot);
      this.configureNavigationSurfaces(this.sceneRoot);
      this.fitLightingToScene(this.sceneRoot);
      this.repairInitialCameraIfNeeded(this.sceneRoot);
      if (this.floorMeshes.length === 0) {
        this.installFallbackFloor();
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Scene failed to load.");
      this.options.onError?.(normalized);
      this.installDemoScene();
    }
  }

  private async loadMaterialOverrides(): Promise<void> {
    if (!this.manifest.materialsUrl) {
      return;
    }

    try {
      const response = await fetch(this.manifest.materialsUrl);
      if (!response.ok) {
        return;
      }
      const document = (await response.json()) as { materials?: readonly MaterialOverride[] };
      for (const material of document.materials ?? []) {
        this.materialOverrides.set(material.id, material);
        this.materialOverrides.set(material.name, material);
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Material overrides failed to load.");
      this.options.onError?.(normalized);
    }
  }

  private async loadObjectOverrides(): Promise<void> {
    if (!this.manifest.objectsUrl) {
      return;
    }

    try {
      const response = await fetch(this.manifest.objectsUrl);
      if (!response.ok) {
        return;
      }
      const document = (await response.json()) as { objects?: readonly ObjectOverride[] };
      for (const object of document.objects ?? []) {
        this.objectOverrides.set(object.id, object);
        this.objectOverrides.set(object.name, object);
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Object overrides failed to load.");
      this.options.onError?.(normalized);
    }
  }

  private async loadControls(): Promise<void> {
    if (!this.manifest.controlsUrl) {
      return;
    }

    try {
      const response = await fetch(this.manifest.controlsUrl);
      if (!response.ok) {
        return;
      }
      const document = (await response.json()) as SceneControlsDocument;
      if (document.schemaVersion === "0.1" && document.movement) {
        this.controls = {
          ...this.controls,
          ...document.movement
        };
      }
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Controls failed to load.");
      this.options.onError?.(normalized);
    }
  }

  private installDemoScene(): void {
    const demo = createDemoScene();
    this.sceneRoot = demo.root;
    this.scene.add(demo.root);
    demo.root.updateMatrixWorld(true);
    this.applyViewObjectVisibility(this.activeView);
    this.pickableMeshes = this.collectPickableMeshes(demo.root);
    this.configureNavigationSurfaces(demo.root, [demo.floor]);
    this.fitLightingToScene(demo.root);
    this.repairInitialCameraIfNeeded(demo.root);
  }

  private installFallbackFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: "#bfb7a6", roughness: 0.86 })
    );
    floor.name = "fallback_floor";
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floorMeshes = [floor];
    this.walkableMeshes = [floor];
  }

  private configureNavigationSurfaces(
    root: THREE.Object3D,
    fallbackFloors: THREE.Object3D[] = []
  ): void {
    const zones = this.createNavigationZones();
    this.walkZoneMeshes = zones.walkMeshes;
    this.passZoneMeshes = zones.passMeshes;
    this.generatedWalkZonesOnly = zones.hasWalkZones && !zones.hasAuthoredWalkZones;
    this.explicitWalkMeshes = this.collectExplicitWalkMeshes(root);
    this.geometryFloorMeshes =
      fallbackFloors.length > 0
        ? fallbackFloors
        : uniqueObjectList([...this.explicitWalkMeshes, ...this.collectFloorMeshes(root)]);
    if (zones.walkMeshes.length > 0) {
      this.floorMeshes = zones.walkMeshes;
      this.walkableMeshes = uniqueObjectList([...zones.walkMeshes, ...zones.passMeshes, ...this.explicitWalkMeshes]);
    } else {
      this.floorMeshes = this.geometryFloorMeshes;
      this.walkableMeshes = this.collectWalkableMeshes(root);
    }
    this.collisionBlockers = [...this.collectCollisionBlockers(root), ...zones.blockers];
    this.rebuildCollisionDebugHelpers();
  }

  private createNavigationZones(): {
    walkMeshes: THREE.Mesh[];
    passMeshes: THREE.Mesh[];
    blockers: CollisionBlocker[];
    hasWalkZones: boolean;
    hasAuthoredWalkZones: boolean;
  } {
    const walkMeshes: THREE.Mesh[] = [];
    const passMeshes: THREE.Mesh[] = [];
    const blockers: CollisionBlocker[] = [];
    let hasAuthoredWalkZones = false;
    const zones = this.manifest.navigation.zones ?? [];
    if (zones.length === 0) {
      return { walkMeshes, passMeshes, blockers, hasWalkZones: false, hasAuthoredWalkZones: false };
    }

    zones.forEach((zone) => {
      if (zone.enabled === false) {
        return;
      }
      const mesh = this.createNavigationZoneMesh(zone);
      this.scene.add(mesh);
      this.navigationZoneMeshes.push(mesh);
      mesh.updateMatrixWorld(true);
      if (zone.kind === "walk") {
        walkMeshes.push(mesh);
        if (!isGeneratedViewerNavigationZone(zone)) {
          hasAuthoredWalkZones = true;
        }
        return;
      }
      if (zone.kind === "pass") {
        passMeshes.push(mesh);
        return;
      }
      const box = new THREE.Box3().setFromObject(mesh);
      if (!box.isEmpty()) {
        blockers.push({
          box,
          name: zone.label || zone.id,
          kind: "authored"
        });
      }
    });

    return { walkMeshes, passMeshes, blockers, hasWalkZones: walkMeshes.length > 0, hasAuthoredWalkZones };
  }

  private createNavigationZoneMesh(zone: NavigationZone): THREE.Mesh {
    const center = this.toSceneVector(zone.center);
    const size = this.toSceneSize(zone.size);
    const polygon =
      zone.polygon && zone.polygon.length >= 3
        ? zone.polygon.map(([x, z]) => new THREE.Vector2(x * this.manifestScale, z * this.manifestScale))
        : undefined;
    const geometry = polygon
      ? this.createNavigationPolygonGeometry(polygon)
      : new THREE.BoxGeometry(
          Math.max(0.05, size.x),
          Math.max(0.04, size.y),
          Math.max(0.05, size.z)
        );
    const material = new THREE.MeshBasicMaterial({
      color: zone.kind === "walk" ? "#1b8fff" : zone.kind === "pass" ? "#25c07b" : "#ff5f57",
      transparent: true,
      opacity: this.debug ? (zone.kind === "walk" ? 0.22 : zone.kind === "pass" ? 0.3 : 0.34) : 0,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    material.colorWrite = this.debug;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `navigation_${zone.kind}_${zone.id}`;
    mesh.renderOrder = this.debug ? 8 : 0;
    mesh.position.copy(center);
    mesh.rotation.y = zone.rotationY ?? 0;
    mesh.userData["navigationZoneId"] = zone.id;
    mesh.userData["navigationZoneKind"] = zone.kind;
    mesh.userData["navigationHalfSize"] = new THREE.Vector3(
      Math.max(0.05, size.x) / 2,
      Math.max(0.04, size.y) / 2,
      Math.max(0.05, size.z) / 2
    );
    if (polygon) {
      mesh.userData["navigationPolygon"] = polygon;
      mesh.userData["navigationHalfHeight"] = Math.max(0.04, size.y) / 2;
    }
    return mesh;
  }

  private createNavigationPolygonGeometry(points: readonly THREE.Vector2[]): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    points.forEach((point) => {
      vertices.push(point.x, 0, point.y);
    });
    const indices: number[] = [];
    for (let index = 1; index < points.length - 1; index += 1) {
      indices.push(0, index, index + 1);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private updateNavigationZoneVisibility(): void {
    this.navigationZoneMeshes.forEach((mesh) => {
      const kind = mesh.userData["navigationZoneKind"];
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = this.debug ? (kind === "walk" ? 0.22 : kind === "pass" ? 0.3 : 0.34) : 0;
        material.colorWrite = this.debug;
        material.needsUpdate = true;
      }
      mesh.renderOrder = this.debug ? 8 : 0;
    });
    this.collisionDebugHelpers.forEach((helper) => {
      helper.visible = this.debug;
    });
  }

  private rebuildCollisionDebugHelpers(): void {
    this.collisionDebugHelpers.forEach((helper) => {
      this.scene.remove(helper);
      helper.geometry.dispose();
      if (Array.isArray(helper.material)) {
        helper.material.forEach((material) => material.dispose());
      } else {
        helper.material.dispose();
      }
    });
    this.collisionDebugHelpers = this.collisionBlockers.slice(0, 220).map((blocker) => {
      const color =
        blocker.kind === "authored"
          ? new THREE.Color("#ff4d4d")
          : blocker.kind === "named"
            ? new THREE.Color("#ff9f1c")
            : new THREE.Color("#d14dff");
      const helper = new THREE.Box3Helper(blocker.box, color);
      helper.name = `collision_debug_${blocker.name}`;
      helper.visible = this.debug;
      helper.renderOrder = 9;
      this.scene.add(helper);
      return helper;
    });
  }

  private applyEnvironment(): void {
    const environment = this.manifest.environment;
    const backgroundColor = environment?.backgroundColor ?? "#d8dde2";
    this.renderer.setClearColor(backgroundColor, 1);
    this.scene.background = new THREE.Color(backgroundColor);
    const roomEnvironment = new RoomEnvironment();
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = this.pmremGenerator.fromScene(roomEnvironment, 0.04).texture;
    this.scene.environment = this.environmentTexture;
    roomEnvironment.dispose();

    if (environment?.skyBackdropEnabled !== false) {
      this.addSkyBackdrop();
    }

    if (environment?.groundEnabled === false) {
      return;
    }

    const groundSize = (environment?.groundSize ?? 90) * this.manifestScale;
    this.groundTexture = this.createGroundTexture(environment?.groundColor);
    this.groundTexture.repeat.set(Math.max(1, groundSize / 8), Math.max(1, groundSize / 8));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({
        color: "#ffffff",
        map: this.groundTexture,
        roughness: 0.95,
        metalness: 0
      })
    );
    ground.name = "environment_ground";
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = (environment?.groundY ?? -0.04) * this.manifestScale;
    ground.receiveShadow = true;
    this.scene.add(ground);

    if (environment?.enclosureEnabled !== false) {
      this.addLandscapeEnclosure();
    }
  }

  private createGroundTexture(baseColor = "#6f8f5a"): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext("2d");
    if (!context) {
      return new THREE.CanvasTexture(canvas);
    }

    const base = new THREE.Color(baseColor);
    context.fillStyle = base.getStyle();
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < canvas.height; y += 3) {
      for (let x = 0; x < canvas.width; x += 3) {
        const wave = Math.sin(x * 0.19 + y * 0.07) * 0.035 + Math.sin(x * 0.031 - y * 0.13) * 0.04;
        const tone = base.clone().offsetHSL(0.015, 0.08, wave);
        context.fillStyle = tone.getStyle();
        context.globalAlpha = 0.45;
        context.fillRect(x, y, 3, 3);
      }
    }

    context.globalAlpha = 0.28;
    for (let i = 0; i < 700; i += 1) {
      const x = (i * 53) % canvas.width;
      const y = (i * 97) % canvas.height;
      const length = 4 + ((i * 7) % 13);
      const tone = base.clone().offsetHSL(0.01, 0.16, i % 3 === 0 ? 0.12 : -0.08);
      context.strokeStyle = tone.getStyle();
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + length, y + Math.sin(i) * 2);
      context.stroke();
    }
    context.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  private addLandscapeEnclosure(): void {
    const environment = this.manifest.environment;
    const radius = (environment?.enclosureRadius ?? (environment?.groundSize ?? 90) * 0.48) * this.manifestScale;
    const height = (environment?.enclosureHeight ?? 14) * this.manifestScale;
    const groundY = (environment?.groundY ?? -0.04) * this.manifestScale;
    if (radius < 5 || height < 2) {
      return;
    }

    this.enclosureTexture = this.createLandscapeTexture(environment?.enclosureColor ?? environment?.groundColor);
    const enclosure = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, height, 96, 1, true),
      new THREE.MeshBasicMaterial({
        map: this.enclosureTexture,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        fog: false
      })
    );
    enclosure.name = "environment_landscape_enclosure";
    enclosure.position.y = groundY + height / 2;
    enclosure.renderOrder = -9;
    this.scene.add(enclosure);
  }

  private createLandscapeTexture(baseColor = "#5f7f4b"): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) {
      return new THREE.CanvasTexture(canvas);
    }

    const sky = new THREE.Color(this.manifest.environment?.skyHorizonColor ?? "#f3f6f8");
    const base = new THREE.Color(baseColor);
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, sky.getStyle());
    gradient.addColorStop(0.34, sky.clone().lerp(base, 0.18).getStyle());
    gradient.addColorStop(1, base.clone().offsetHSL(0, 0.08, -0.18).getStyle());
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < 180; i += 1) {
      const x = (i * 97) % canvas.width;
      const width = 18 + ((i * 37) % 46);
      const treeHeight = 42 + ((i * 53) % 96);
      const y = canvas.height - treeHeight * 0.72;
      const tone = base.clone().offsetHSL((i % 9) * 0.004, 0.12, i % 2 === 0 ? -0.1 : 0.05);
      context.globalAlpha = 0.42;
      context.fillStyle = tone.getStyle();
      context.beginPath();
      context.ellipse(x, y, width, treeHeight, 0, 0, Math.PI * 2);
      context.fill();
    }

    context.globalAlpha = 0.88;
    context.fillStyle = base.clone().offsetHSL(0.01, 0.2, -0.22).getStyle();
    context.fillRect(0, canvas.height * 0.76, canvas.width, canvas.height * 0.24);
    context.globalAlpha = 1;

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(2, 1);
    texture.needsUpdate = true;
    return texture;
  }

  private addSkyBackdrop(): void {
    const environment = this.manifest.environment;
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, environment?.skyTopColor ?? "#d8e7f5");
    gradient.addColorStop(0.62, environment?.skyHorizonColor ?? "#f3f6f8");
    gradient.addColorStop(1, environment?.backgroundColor ?? "#d8dde2");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.skyTexture = new THREE.CanvasTexture(canvas);
    this.skyTexture.colorSpace = THREE.SRGBColorSpace;
    const radius = Math.max(120, (environment?.groundSize ?? 90) * this.manifestScale * 1.7);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 32, 16),
      new THREE.MeshBasicMaterial({
        map: this.skyTexture,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
      })
    );
    sky.name = "environment_sky_backdrop";
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  private prepareLoadedScene(root: THREE.Object3D): void {
    const forceDoubleSided = this.manifest.rendering?.doubleSidedMaterials === true;
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        this.applyObjectOverride(node);
        this.prepareGeometry(node);
        const name = node.name.toLowerCase();
        this.registerTopViewHiddenObject(node);
        const architecturalShell =
          name.includes("wall") || name.includes("floor") || name.includes("ceiling");
        node.castShadow = !architecturalShell;
        node.receiveShadow = true;
        if (Array.isArray(node.material)) {
          node.material = node.material.map((sourceMaterial) => {
            const material = this.normalizeLoadedMaterial(sourceMaterial);
            this.applyMaterialOverride(material);
            this.prepareMaterial(material, name);
            if (forceDoubleSided || architecturalShell) {
              material.side = THREE.DoubleSide;
            }
            material.needsUpdate = true;
            return material;
          });
        } else {
          node.material = this.normalizeLoadedMaterial(node.material);
          this.applyMaterialOverride(node.material);
          this.prepareMaterial(node.material, name);
          if (forceDoubleSided || architecturalShell) {
            node.material.side = THREE.DoubleSide;
          }
          node.material.needsUpdate = true;
        }
      }
    });
  }

  private prepareGeometry(mesh: THREE.Mesh): void {
    const geometry = mesh.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) {
      return;
    }
    if (!geometry.getAttribute("position") || geometry.getAttribute("normal")) {
      return;
    }
    geometry.computeVertexNormals();
    geometry.userData = { ...geometry.userData, generatedNormals: true };
  }

  private normalizeLoadedMaterial(material: THREE.Material): THREE.Material {
    const relightUnlit = this.manifest.rendering?.relightUnlitMaterials !== false;
    if (!relightUnlit || !(material instanceof THREE.MeshBasicMaterial)) {
      return material;
    }
    const nextMaterial = new THREE.MeshStandardMaterial({
      name: material.name,
      color: material.color.clone(),
      map: material.map ?? null,
      alphaMap: material.alphaMap ?? null,
      transparent: material.transparent,
      opacity: material.opacity,
      alphaTest: material.alphaTest,
      side: material.side,
      vertexColors: material.vertexColors,
      roughness: 0.78,
      metalness: 0
    });
    nextMaterial.userData = { ...material.userData, relitFromUnlit: true };
    if (material.map) {
      material.map.colorSpace = THREE.SRGBColorSpace;
    }
    return nextMaterial;
  }

  private registerTopViewHiddenObject(object: THREE.Object3D): void {
    const override = this.objectOverrideForNode(object);
    const materialNames =
      object instanceof THREE.Mesh
        ? (Array.isArray(object.material) ? object.material : [object.material]).map((material) => material.name).join(" ")
        : "";
    const descriptor = `${object.name} ${object.parent?.name ?? ""} ${object.userData["name"] ?? ""} ${materialNames}`.toLowerCase();
    const hideInTopView =
      typeof override?.hideInTopView === "boolean"
        ? override.hideInTopView
        : /(^|[^a-z])(ceiling|false-ceiling|dropped-ceiling|roof|roofing|lid|cover)([^a-z]|$)/.test(descriptor) &&
          !/(^|[^a-z])(fan|light|lamp|fixture|chandelier|downlight|spotlight)([^a-z]|$)/.test(descriptor);
    if (!hideInTopView || this.topViewHiddenObjects.some((entry) => entry.object === object)) {
      return;
    }
    this.topViewHiddenObjects.push({
      object,
      visibleOutsideTopView: object.visible
    });
  }

  private applyViewObjectVisibility(view: SceneView | undefined): void {
    const hideTopShell = view?.kind === "top";
    if (hideTopShell) {
      if (!this.topViewShellHidden) {
        this.topViewHiddenObjects.forEach((entry) => {
          entry.visibleOutsideTopView = entry.object.visible;
        });
      }
      this.topViewHiddenObjects.forEach((entry) => {
        entry.object.visible = false;
      });
      this.topViewShellHidden = true;
      return;
    }

    if (!this.topViewShellHidden) {
      return;
    }
    this.topViewHiddenObjects.forEach((entry) => {
      entry.object.visible = entry.visibleOutsideTopView;
    });
    this.topViewShellHidden = false;
  }

  private setObjectRuntimeVisibility(object: THREE.Object3D, visible: boolean): void {
    const topViewHiddenEntry = this.topViewHiddenObjects.find((entry) => entry.object === object);
    if (topViewHiddenEntry) {
      topViewHiddenEntry.visibleOutsideTopView = visible;
    }
    object.visible = this.topViewShellHidden && topViewHiddenEntry ? false : visible;
  }

  private isObjectRuntimeVisible(object: THREE.Object3D): boolean {
    return this.topViewHiddenObjects.find((entry) => entry.object === object)?.visibleOutsideTopView ?? object.visible;
  }

  private applyMaterialOverride(material: THREE.Material): void {
    const override = this.materialOverrides.get(material.name);
    if (!override) {
      return;
    }

    if (override.mapUrl && "map" in material) {
      const texturedMaterial = material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
      texturedMaterial.map = this.loadMaterialTexture(
        override.mapUrl,
        `${material.name || override.name}-map`,
        THREE.SRGBColorSpace,
        override
      );
      texturedMaterial.needsUpdate = true;
    }

    if ("color" in material && material.color instanceof THREE.Color && override.baseColor) {
      material.color.set(override.baseColor);
    }

    if (override.normalMapUrl && "normalMap" in material) {
      const normalMappedMaterial = material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
      normalMappedMaterial.normalMap = this.loadMaterialTexture(
        override.normalMapUrl,
        `${material.name || override.name}-normal`,
        THREE.NoColorSpace,
        override
      );
      normalMappedMaterial.needsUpdate = true;
    }

    if (override.emissiveMapUrl && "emissiveMap" in material) {
      const emissiveMaterial = material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
      emissiveMaterial.emissiveMap = this.loadMaterialTexture(
        override.emissiveMapUrl,
        `${material.name || override.name}-emissive`,
        THREE.SRGBColorSpace,
        override
      );
      emissiveMaterial.emissiveIntensity = override.emissiveIntensity ?? emissiveMaterial.emissiveIntensity ?? 1;
      if (emissiveMaterial.emissive instanceof THREE.Color) {
        emissiveMaterial.emissive.set("#ffffff");
      }
      emissiveMaterial.needsUpdate = true;
    } else if (typeof override.emissiveIntensity === "number" && "emissiveIntensity" in material) {
      const emissiveMaterial = material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
      emissiveMaterial.emissiveIntensity = override.emissiveIntensity;
    }

    if ("roughness" in material && typeof override.roughness === "number") {
      material.roughness = override.roughness;
    }

    if ("metalness" in material && typeof override.metalness === "number") {
      material.metalness = override.metalness;
    }

    if (typeof override.opacity === "number") {
      material.opacity = override.opacity;
      material.transparent = override.opacity < 1;
    }

    if (override.lightMapUrl && "lightMap" in material) {
      const lightMappedMaterial = material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
      const lightMapUrl = this.resolveMaterialAssetUrl(override.lightMapUrl);
      const lightMap = this.textureLoader.load(lightMapUrl, () => {
        material.needsUpdate = true;
      });
      lightMap.name = `${material.name || override.name}-lightmap`;
      lightMap.colorSpace = THREE.SRGBColorSpace;
      lightMap.flipY = false;
      if ("channel" in lightMap && typeof override.lightMapUvSet === "number") {
        lightMap.channel = Math.max(0, Math.floor(override.lightMapUvSet));
      }
      lightMappedMaterial.lightMap = lightMap;
      lightMappedMaterial.lightMapIntensity = override.lightMapIntensity ?? 1;
      this.materialLightMaps.push(lightMap);
    }
  }

  private loadMaterialTexture(
    source: string,
    name: string,
    colorSpace: THREE.ColorSpace,
    override?: MaterialOverride
  ): THREE.Texture {
    const textureUrl = this.resolveMaterialAssetUrl(source);
    const texture = this.textureLoader.load(textureUrl, () => {
      texture.needsUpdate = true;
    });
    texture.name = name;
    texture.colorSpace = colorSpace;
    texture.flipY = false;
    if (override) {
      this.applyMaterialTextureTransform(texture, override);
    }
    this.materialTextures.push(texture);
    return texture;
  }

  private applyMaterialTextureTransform(texture: THREE.Texture, override: MaterialOverride): void {
    if (override.textureRepeat) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(
        Math.max(0.001, override.textureRepeat[0] ?? 1),
        Math.max(0.001, override.textureRepeat[1] ?? 1)
      );
    }
    if (override.textureOffset) {
      texture.offset.set(override.textureOffset[0] ?? 0, override.textureOffset[1] ?? 0);
    }
    if (typeof override.textureRotation === "number") {
      texture.center.set(0.5, 0.5);
      texture.rotation = override.textureRotation;
    }
  }

  private resolveMaterialAssetUrl(source: string): string {
    if (
      source.startsWith("generated://") ||
      source.startsWith("data:") ||
      source.startsWith("blob:") ||
      source.startsWith("http://") ||
      source.startsWith("https://") ||
      source.startsWith("/")
    ) {
      return source;
    }
    return new URL(source, this.manifest.materialsUrl ?? window.location.href).href;
  }

  private prepareMaterial(material: THREE.Material, meshName: string): void {
    const materialName = material.name.toLowerCase();
    const looksLikeGlass =
      meshName.includes("glass") ||
      materialName.includes("glass") ||
      materialName.includes("transparent");
    const looksLikeWindow = meshName.includes("window") || materialName.includes("window");

    if ("envMapIntensity" in material && typeof material.envMapIntensity === "number") {
      material.envMapIntensity = material.envMapIntensity || 1.15;
    }

    if ("roughness" in material && typeof material.roughness === "number") {
      material.roughness = THREE.MathUtils.clamp(material.roughness, 0.04, 1);
    }

    if ("metalness" in material && typeof material.metalness === "number") {
      material.metalness = THREE.MathUtils.clamp(material.metalness, 0, 1);
    }

    if (looksLikeGlass && "opacity" in material && typeof material.opacity === "number") {
      material.transparent = true;
      material.opacity = Math.min(material.opacity, 0.48);
    } else if (
      looksLikeWindow &&
      material.transparent &&
      "opacity" in material &&
      typeof material.opacity === "number"
    ) {
      material.opacity = Math.min(material.opacity, 0.68);
    }

    if (material.transparent || ("opacity" in material && typeof material.opacity === "number" && material.opacity < 1)) {
      material.depthWrite = false;
    }
  }

  private applyObjectOverride(node: THREE.Object3D): void {
    const override = this.objectOverrideForNode(node);
    if (!override) {
      return;
    }
    node.visible = override.visible;
  }

  private objectNavigationBehavior(node: THREE.Object3D): ObjectOverride["navigationBehavior"] {
    const override = this.objectOverrideForNode(node);
    return override?.navigationBehavior && override.navigationBehavior !== "default"
      ? override.navigationBehavior
      : undefined;
  }

  private objectOverrideForNode(node: THREE.Object3D): ObjectOverride | undefined {
    const direct = this.objectOverrideBySceneName(node);
    if (direct) {
      return direct;
    }
    let current = node.parent;
    while (current) {
      const inherited = this.objectOverrideBySceneName(current);
      if (inherited) {
        return inherited;
      }
      current = current.parent;
    }
    return this.objectOverrideByLooseName(node);
  }

  private objectOverrideBySceneName(node: THREE.Object3D): ObjectOverride | undefined {
    const candidates = [
      node.name,
      typeof node.userData["name"] === "string" ? node.userData["name"] : ""
    ].filter((name) => name.trim().length > 0);
    for (const name of candidates) {
      const override = this.objectOverrides.get(name);
      if (override) {
        return override;
      }
    }
    return undefined;
  }

  private objectOverrideByLooseName(node: THREE.Object3D): ObjectOverride | undefined {
    const names = [node.name, node.parent?.name ?? "", `${node.userData["name"] ?? ""}`]
      .map(normalizedObjectOverrideName)
      .filter((name) => name.length >= 4);
    if (names.length === 0) {
      return undefined;
    }
    const uniqueOverrides = new Set(this.objectOverrides.values());
    for (const override of uniqueOverrides) {
      const overrideNames = [override.id, override.name].map(normalizedObjectOverrideName);
      if (
        overrideNames.some((overrideName) =>
          names.some(
            (name) =>
              overrideName === name ||
              (overrideName.length >= 4 && name.includes(overrideName)) ||
              (name.length >= 4 && overrideName.includes(name))
          )
        )
      ) {
        return override;
      }
    }
    return undefined;
  }

  private isLikelyExteriorSurfaceName(name: string): boolean {
    return [
      "terrain",
      "landscape",
      "grass",
      "lawn",
      "site",
      "environment",
      "background",
      "plot"
    ].some((keyword) => name.includes(keyword));
  }

  private collectFloorMeshes(root: THREE.Object3D): THREE.Object3D[] {
    const floorNames = this.manifest.navigation.floorMeshNames.map((name) => name.toLowerCase());
    const meshes: THREE.Object3D[] = [];
    const fallbackCandidates: { mesh: THREE.Mesh; area: number; exterior: boolean }[] = [];
    const rootBox = new THREE.Box3().setFromObject(root);
    const sceneHeight = Math.max(0.001, rootBox.max.y - rootBox.min.y);
    const lowBand = rootBox.min.y + Math.max(0.75, sceneHeight * 0.22);
    const sceneFootprint = Math.max(1, (rootBox.max.x - rootBox.min.x) * (rootBox.max.z - rootBox.min.z));

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      if (!node.visible) {
        return;
      }
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) {
        return;
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const area = size.x * size.z;
      const name = `${node.name} ${node.parent?.name ?? ""} ${node.userData["name"] ?? ""}`.toLowerCase();
      const navigationBehavior = this.objectNavigationBehavior(node);
      if (navigationBehavior === "ignore" || navigationBehavior === "collision") {
        return;
      }
      if (navigationBehavior === "walk") {
        return;
      }
      const exteriorName = this.isLikelyExteriorSurfaceName(name);
      const nonWalkName = isLikelyNonWalkSurfaceName(name);
      const hugeExteriorPlane = exteriorName && area > sceneFootprint * 0.25;
      if (floorNames.some((floorName) => name.includes(floorName)) && !hugeExteriorPlane && !nonWalkName) {
        meshes.push(node);
        return;
      }

      const flatEnough = size.y <= Math.max(0.2, Math.min(size.x, size.z) * 0.16);
      const lowEnough = center.y <= lowBand;
      if (flatEnough && lowEnough && area > 0.75 && !nonWalkName) {
        fallbackCandidates.push({ mesh: node, area, exterior: exteriorName || hugeExteriorPlane });
      }
    });
    if (meshes.length > 0) {
      return meshes;
    }
    return fallbackCandidates
      .sort((a, b) => Number(a.exterior) - Number(b.exterior) || b.area - a.area)
      .slice(0, 48)
      .map((candidate) => candidate.mesh);
  }

  private collectExplicitWalkMeshes(root: THREE.Object3D): THREE.Object3D[] {
    const meshes: THREE.Object3D[] = [];
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || !node.visible) {
        return;
      }
      if (this.objectNavigationBehavior(node) === "walk") {
        meshes.push(node);
      }
    });
    return meshes;
  }

  private collectPickableMeshes(root: THREE.Object3D): THREE.Object3D[] {
    const floorNames = this.manifest.navigation.floorMeshNames.map((name) => name.toLowerCase());
    const meshes: THREE.Object3D[] = [];
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      if (!node.visible) {
        return;
      }
      const navigationBehavior = this.objectNavigationBehavior(node);
      if (navigationBehavior === "ignore" || navigationBehavior === "walk") {
        return;
      }
      const name = node.name.toLowerCase();
      if (floorNames.some((floorName) => name.includes(floorName))) {
        return;
      }
      meshes.push(node);
    });
    return meshes;
  }

  private collectWalkableMeshes(root: THREE.Object3D): THREE.Object3D[] {
    const meshes = new Set<THREE.Object3D>(this.floorMeshes);
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      if (!node.visible) {
        return;
      }
      const navigationBehavior = this.objectNavigationBehavior(node);
      if (navigationBehavior === "ignore" || navigationBehavior === "collision") {
        return;
      }
      meshes.add(node);
    });
    return [...meshes];
  }

  private collectCollisionBlockers(root: THREE.Object3D): CollisionBlocker[] {
    const collisionNames = this.manifest.navigation.collisionMeshNames.map((name) => name.toLowerCase());
    const ignoredCollisionNames = (this.manifest.navigation.ignoredCollisionMeshNames ?? []).map((name) =>
      name.toLowerCase()
    );
    const floorNames = this.manifest.navigation.floorMeshNames.map((name) => name.toLowerCase());
    const blockers: CollisionBlocker[] = [];
    const inferredBlockers: { blocker: CollisionBlocker; area: number }[] = [];
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      if (!node.visible) {
        return;
      }
      const navigationBehavior = this.objectNavigationBehavior(node);
      if (navigationBehavior === "ignore" || navigationBehavior === "walk") {
        return;
      }
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) {
        return;
      }
      if (navigationBehavior === "collision") {
        blockers.push({
          box,
          name: node.name || node.parent?.name || "Authored collision",
          kind: "authored"
        });
        return;
      }
      const name = node.name.toLowerCase();
      const collisionSearchName = `${node.name} ${node.parent?.name ?? ""} ${node.userData["name"] ?? ""}`.toLowerCase();
      if (floorNames.some((floorName) => collisionSearchName.includes(floorName))) {
        return;
      }
      if (ignoredCollisionNames.some((ignoredName) => collisionSearchName.includes(ignoredName))) {
        return;
      }
      if (isDoorwayNavigationPanel(node, collisionSearchName) && !isExplicitPortalCollision(collisionSearchName)) {
        return;
      }
      const isCollisionMesh = collisionNames.some((collisionName) => name.includes(collisionName));
      if (isCollisionMesh) {
        blockers.push({
          box,
          name: node.name || node.parent?.name || "Named collision",
          kind: "named"
        });
        return;
      }

      const size = box.getSize(new THREE.Vector3());
      const height = size.y;
      const wideAxis = Math.max(size.x, size.z);
      const thinAxis = Math.min(size.x, size.z);
      const footprintArea = size.x * size.z;
      const looksLikeWall =
        height >= 0.8 &&
        wideAxis >= 0.75 &&
        thinAxis <= Math.max(0.35, wideAxis * 0.18) &&
        footprintArea <= Math.max(8, wideAxis * 0.75);
      if (looksLikeWall) {
        inferredBlockers.push({
          blocker: {
            box,
            name: node.name || node.parent?.name || "Inferred wall",
            kind: "inferred"
          },
          area: wideAxis * height
        });
        return;
      }
      const lowObstacleHeight = Math.max(this.maxStepUp + 0.12, this.cameraHeight * 0.22);
      const looksLikeLowObstacle =
        height >= lowObstacleHeight &&
        height <= Math.max(1.65, this.cameraHeight * 0.95) &&
        footprintArea >= 0.06 &&
        footprintArea <= Math.max(14, wideAxis * 3.2) &&
        wideAxis >= 0.18 &&
        !this.isLikelyExteriorSurfaceName(collisionSearchName);
      if (looksLikeLowObstacle) {
        inferredBlockers.push({
          blocker: {
            box,
            name: node.name || node.parent?.name || "Inferred obstacle",
            kind: "inferred"
          },
          area: footprintArea * height * (isLikelyNonWalkSurfaceName(collisionSearchName) ? 1.4 : 0.7)
        });
      }
    });
    const inferred = inferredBlockers
      .sort((a, b) => b.area - a.area)
      .slice(0, Math.max(0, 180 - blockers.length))
      .map((item) => item.blocker);
    return [...blockers, ...inferred];
  }

  private configureInteractions(): void {
    this.manifest.interactions.forEach((interaction) => {
      if (interaction.enabled === false) {
        return;
      }
      if (interaction.kind === "hotspot") {
        this.addHotspot(interaction);
      }
      if (interaction.kind === "link") {
        this.addLink(interaction);
      }
      if (interaction.kind === "object-toggle") {
        this.addObjectToggle(interaction);
      }
      if (interaction.kind === "video-texture") {
        this.addVideoTexture(interaction);
      }
    });
  }

  private addHotspot(interaction: HotspotInteraction): void {
    const sprite = createHotspotSprite(interaction.icon === "media" ? "play" : "i");
    sprite.position.copy(this.toSceneVector(interaction.position));
    sprite.userData["interactionId"] = interaction.id;
    this.scene.add(sprite);
    this.hotspots.push({ interaction, sprite });
  }

  private addLink(interaction: LinkInteraction): void {
    const sprite = createHotspotSprite("L");
    sprite.position.copy(this.toSceneVector(interaction.position));
    sprite.userData["interactionId"] = interaction.id;
    this.scene.add(sprite);
    this.hotspots.push({ interaction, sprite });
  }

  private addObjectToggle(interaction: ObjectToggleInteraction): void {
    if (typeof interaction.initiallyVisible === "boolean") {
      this.setObjectToggleVisibility(interaction, interaction.initiallyVisible);
      this.objectToggleStates.set(interaction.id, interaction.initiallyVisible);
    }
    const sprite = createHotspotSprite("O");
    sprite.position.copy(this.toSceneVector(interaction.position));
    sprite.userData["interactionId"] = interaction.id;
    this.scene.add(sprite);
    this.hotspots.push({ interaction, sprite });
  }

  private addVideoTexture(interaction: VideoTextureInteraction): void {
    const managed = createManagedVideoTexture(interaction);
    const material = new THREE.MeshBasicMaterial({ map: managed.texture });
    const matches: { mesh: THREE.Mesh; materialIndex?: number }[] = [];

    this.scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const meshNameMatches = interaction.targetMeshName && node.name === interaction.targetMeshName;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      const materialIndex = interaction.targetMaterialName
        ? materials.findIndex((sourceMaterial) => sourceMaterial.name === interaction.targetMaterialName)
        : -1;
      const materialNameMatches = materialIndex >= 0;
      const markedDemoTarget = node.userData["videoTarget"] === true && !interaction.targetMeshName;
      if (meshNameMatches || markedDemoTarget) {
        matches.push({ mesh: node });
      } else if (materialNameMatches) {
        matches.push({ mesh: node, materialIndex });
      }
    });

    if (matches.length === 0) {
      managed.destroy?.();
      return;
    }

    const targetBox = new THREE.Box3();
    matches.forEach(({ mesh, materialIndex }) => {
      targetBox.union(new THREE.Box3().setFromObject(mesh));
      if (typeof materialIndex === "number" && Array.isArray(mesh.material)) {
        const nextMaterials = [...mesh.material];
        nextMaterials[materialIndex] = material;
        mesh.material = nextMaterials;
        return;
      }
      mesh.material = material;
    });

    const triggerDistance =
      typeof interaction.triggerDistance === "number" && interaction.triggerDistance > 0
        ? interaction.triggerDistance * this.manifestScale
        : undefined;
    if (!triggerDistance || targetBox.isEmpty()) {
      this.managedTextures.push(managed);
      return;
    }

    const targetCenter = targetBox.getCenter(new THREE.Vector3());
    managed.setActive?.(false);
    this.managedTextures.push({
      ...managed,
      update: (elapsed) => {
        managed.update?.(elapsed);
        managed.setActive?.(this.camera.position.distanceTo(targetCenter) <= triggerDistance);
      }
    });
  }

  private findMaterialVariantTargets(interaction: MaterialVariantInteraction): {
    mesh: THREE.Mesh;
    material: THREE.Material;
    materialIndex: number;
  }[] {
    const targets: { mesh: THREE.Mesh; material: THREE.Material; materialIndex: number }[] = [];

    this.scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const meshMatches = this.meshMatchesVariantTarget(node, interaction.targetMeshName);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material, materialIndex) => {
        const materialMatches = Boolean(
          interaction.targetMaterialName && material.name === interaction.targetMaterialName
        );
        if (meshMatches || materialMatches) {
          targets.push({ mesh: node, material, materialIndex });
        }
      });
    });

    return targets;
  }

  private meshMatchesVariantTarget(mesh: THREE.Mesh, targetMeshName: string | undefined): boolean {
    if (!targetMeshName?.trim()) {
      return false;
    }
    const exactNames = [
      mesh.name,
      mesh.parent?.name ?? "",
      typeof mesh.userData["name"] === "string" ? mesh.userData["name"] : ""
    ].filter((name) => name.trim().length > 0);
    if (exactNames.includes(targetMeshName)) {
      return true;
    }
    const normalizedTarget = normalizedObjectOverrideName(targetMeshName);
    if (normalizedTarget.length < 4) {
      return false;
    }
    return exactNames
      .map(normalizedObjectOverrideName)
      .filter((name) => name.length >= 4)
      .some(
        (name) =>
          name === normalizedTarget ||
          name.includes(normalizedTarget) ||
          normalizedTarget.includes(name)
      );
  }

  private resolveLegacyCoordinateScale(): number {
    if (this.manifest.rendering?.modelScale) {
      return 1;
    }

    const bounds = this.manifest.navigation.bounds;
    if (!bounds) {
      return 1;
    }

    const width = Math.abs(bounds.max[0] - bounds.min[0]);
    const height = Math.abs(bounds.max[1] - bounds.min[1]);
    const depth = Math.abs(bounds.max[2] - bounds.min[2]);
    const largestDimension = Math.max(width, height, depth);
    if (largestDimension > 10_000) {
      return 0.001;
    }
    if (largestDimension > 500) {
      return 0.01;
    }
    return 1;
  }

  private toSceneVector(
    value: readonly [number, number, number],
    options: { preserveMeterY?: boolean } = {}
  ): THREE.Vector3 {
    const vector = toVector3(value);
    if (this.manifestScale === 1) {
      return vector;
    }
    return new THREE.Vector3(
      vector.x * this.manifestScale,
      options.preserveMeterY && Math.abs(vector.y) < 20 ? vector.y : vector.y * this.manifestScale,
      vector.z * this.manifestScale
    );
  }

  private toSceneSize(value: readonly [number, number, number]): THREE.Vector3 {
    const vector = toVector3(value);
    if (this.manifestScale === 1) {
      return vector;
    }
    return vector.multiplyScalar(this.manifestScale);
  }

  private applyInitialCamera(): void {
    const firstView = this.manifest.views[0];
    if (firstView) {
      this.activeView = firstView;
      this.camera.position.copy(this.toSceneVector(firstView.position, { preserveMeterY: true }));
      this.cameraTarget.copy(this.toSceneVector(firstView.target, { preserveMeterY: true }));
      this.camera.fov = firstView.fov ?? 62;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.position.set(-4, 1.65, 4);
      this.cameraTarget.set(0, 1.35, 0);
    }
    this.stableFloorY = this.camera.position.y - this.cameraHeight;
    this.resetPendingFloorTransition();
    this.updateAnglesFromTarget();
    this.camera.lookAt(this.cameraTarget);
  }

  private repairInitialCameraIfNeeded(root: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) {
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, size.length() * 0.5);
    const firstView = this.manifest.views[0];
    const cameraOffset = this.camera.position.distanceTo(center);
    const targetOffset = this.cameraTarget.distanceTo(center);
    const invalidCamera =
      !Number.isFinite(this.camera.position.x) ||
      !Number.isFinite(this.camera.position.y) ||
      !Number.isFinite(this.camera.position.z) ||
      !Number.isFinite(this.cameraTarget.x) ||
      !Number.isFinite(this.cameraTarget.y) ||
      !Number.isFinite(this.cameraTarget.z);
    const yTooFarBelow = this.camera.position.y < box.min.y - Math.max(1, size.y * 0.5);
    const yTooFarAbove = this.camera.position.y > box.max.y + Math.max(12, size.y * 5);
    const cameraTooFar = cameraOffset > Math.max(40, radius * 7);
    const targetTooFar = targetOffset > Math.max(30, radius * 5);
    const navigationInvalid = Boolean(this.navigationFailureDetail(this.camera.position));
    const startsOnExteriorPlane = this.cameraStartsOnLikelyExteriorSurface(box);
    if (
      firstView &&
      !invalidCamera &&
      !yTooFarBelow &&
      !yTooFarAbove &&
      !cameraTooFar &&
      !targetTooFar &&
      !navigationInvalid &&
      !startsOnExteriorPlane
    ) {
      return;
    }

    if (!this.fitCameraToNavigationSurface(box)) {
      this.fitCameraToBox(box);
    }
  }

  private fitCameraToNavigationSurface(sceneBox: THREE.Box3): boolean {
    const sceneFootprint = Math.max(
      1,
      (sceneBox.max.x - sceneBox.min.x) * (sceneBox.max.z - sceneBox.min.z)
    );
    const surfaces = (this.walkZoneMeshes.length > 0 ? this.walkZoneMeshes : this.floorMeshes)
      .map((mesh) => {
        const box = new THREE.Box3().setFromObject(mesh);
        const size = box.getSize(new THREE.Vector3());
        const name = `${mesh.name} ${mesh.parent?.name ?? ""} ${mesh.userData["name"] ?? ""}`.toLowerCase();
        const exterior =
          this.isLikelyExteriorSurfaceName(name) ||
          (this.walkZoneMeshes.length === 0 && Math.abs(size.x * size.z) > sceneFootprint * 0.55);
        return {
          box,
          size,
          area: Math.abs(size.x * size.z),
          exterior
        };
      })
      .filter((surface) => !surface.box.isEmpty() && surface.area > 0.2)
      .sort((a, b) => Number(a.exterior) - Number(b.exterior) || b.area - a.area);

    const sceneCenter = sceneBox.getCenter(new THREE.Vector3());
    for (const surface of surfaces) {
      const center = surface.box.getCenter(new THREE.Vector3());
      const offsets = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(surface.size.x * 0.25, 0, 0),
        new THREE.Vector3(surface.size.x * -0.25, 0, 0),
        new THREE.Vector3(0, 0, surface.size.z * 0.25),
        new THREE.Vector3(0, 0, surface.size.z * -0.25)
      ];

      for (const offset of offsets) {
        const position = center.clone().add(offset);
        position.y = surface.box.max.y + this.cameraHeight;
        if (this.navigationFailureDetail(position)) {
          continue;
        }
        this.camera.position.copy(position);
        this.cameraTarget.copy(this.navigationSurfaceLookTarget(surface.box, position, sceneCenter));
        this.updateAnglesFromTarget();
        this.camera.lookAt(this.cameraTarget);
        this.stableFloorY = this.camera.position.y - this.cameraHeight;
        this.resetPendingFloorTransition();
        return true;
      }
    }

    return false;
  }

  private navigationSurfaceLookTarget(
    surfaceBox: THREE.Box3,
    position: THREE.Vector3,
    sceneCenter: THREE.Vector3
  ): THREE.Vector3 {
    const size = surfaceBox.getSize(new THREE.Vector3());
    const target = new THREE.Vector3(
      THREE.MathUtils.clamp(sceneCenter.x, surfaceBox.min.x, surfaceBox.max.x),
      position.y - 0.35,
      THREE.MathUtils.clamp(sceneCenter.z, surfaceBox.min.z, surfaceBox.max.z)
    );

    if (position.distanceTo(target) >= 0.8) {
      return target;
    }

    const forward = new THREE.Vector3(sceneCenter.x - position.x, 0, sceneCenter.z - position.z);
    if (forward.lengthSq() < 0.01) {
      if (size.z >= size.x) {
        forward.set(0, 0, -1);
      } else {
        forward.set(-1, 0, 0);
      }
    }
    forward.normalize().multiplyScalar(THREE.MathUtils.clamp(Math.max(size.x, size.z) * 0.32, 1, 3.5));
    target.x = THREE.MathUtils.clamp(position.x + forward.x, surfaceBox.min.x, surfaceBox.max.x);
    target.z = THREE.MathUtils.clamp(position.z + forward.z, surfaceBox.min.z, surfaceBox.max.z);

    if (position.distanceTo(target) < 0.5) {
      target.z = THREE.MathUtils.clamp(
        position.z + (size.z >= size.x ? -1 : 0),
        surfaceBox.min.z,
        surfaceBox.max.z
      );
      target.x = THREE.MathUtils.clamp(
        position.x + (size.x > size.z ? -1 : 0),
        surfaceBox.min.x,
        surfaceBox.max.x
      );
    }

    return target;
  }

  private cameraStartsOnLikelyExteriorSurface(sceneBox: THREE.Box3): boolean {
    if (this.floorMeshes.length === 0) {
      return false;
    }
    const raycaster = new THREE.Raycaster(
      this.camera.position.clone(),
      new THREE.Vector3(0, -1, 0),
      0,
      Math.max(4, this.cameraHeight + 2)
    );
    const hit = raycaster.intersectObjects(this.floorMeshes, true)[0];
    if (!hit) {
      return false;
    }
    const object = hit.object;
    if (this.walkZoneMeshes.length > 0 && this.objectBelongsToCollection(object, this.walkZoneMeshes)) {
      return false;
    }
    const name = `${object.name} ${object.parent?.name ?? ""} ${object.userData["name"] ?? ""}`.toLowerCase();
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) {
      return false;
    }
    const size = box.getSize(new THREE.Vector3());
    const area = Math.abs(size.x * size.z);
    const sceneFootprint = Math.max(
      1,
      (sceneBox.max.x - sceneBox.min.x) * (sceneBox.max.z - sceneBox.min.z)
    );
    return this.isLikelyExteriorSurfaceName(name) || area > sceneFootprint * 0.6;
  }

  private fitCameraToBox(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const footprint = Math.max(size.x, size.z, 1);
    const height = Math.max(size.y, 1);
    const distance = Math.max(3.5, footprint * 1.15, height * 1.4);
    const eyeY = Math.max(box.min.y + this.cameraHeight, center.y + Math.min(height * 0.22, 1.2));
    const targetY = THREE.MathUtils.clamp(eyeY - 0.35, box.min.y + 0.8, box.max.y);

    this.camera.position.set(center.x, eyeY, center.z + distance);
    this.cameraTarget.set(center.x, targetY, center.z);
    this.camera.near = Math.max(0.02, distance / 1000);
    this.camera.far = Math.max(this.camera.far, distance * 8, size.length() * 4);
    this.camera.updateProjectionMatrix();
    this.updateAnglesFromTarget();
    this.camera.lookAt(this.cameraTarget);
    this.stableFloorY = this.camera.position.y - this.cameraHeight;
    this.resetPendingFloorTransition();
  }

  private addLighting(): void {
    if (this.lightRig.children.length > 0) {
      return;
    }

    const ambientIntensity = this.manifest.rendering?.ambientIntensity ?? 1.0;

    const hemisphere = new THREE.HemisphereLight("#f7fbff", "#716550", 0.9 * ambientIntensity);
    this.lightRig.add(hemisphere);

    const sun = new THREE.DirectionalLight("#fff6e8", 2.2 * ambientIntensity);
    sun.position.set(-3.5, 6.5, 3.2);
    sun.castShadow = true;
    sun.shadow.bias = -0.00005;
    sun.shadow.normalBias = 0.035;
    sun.shadow.mapSize.set(2048, 2048);
    this.sunTarget = new THREE.Object3D();
    sun.target = this.sunTarget;
    this.sunLight = sun;
    this.lightRig.add(sun);
    this.lightRig.add(this.sunTarget);
  }

  private fitLightingToScene(root: THREE.Object3D): void {
    if (!this.sunLight || !this.sunTarget) {
      return;
    }
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) {
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(6, size.length() * 0.55);
    this.sunLight.position.set(
      center.x - radius * 0.45,
      center.y + radius * 1.15,
      center.z + radius * 0.55
    );
    this.sunTarget.position.copy(center);
    const shadowCamera = this.sunLight.shadow.camera;
    shadowCamera.left = -radius;
    shadowCamera.right = radius;
    shadowCamera.top = radius;
    shadowCamera.bottom = -radius;
    shadowCamera.near = 0.1;
    shadowCamera.far = radius * 4;
    shadowCamera.updateProjectionMatrix();
  }

  private applyBounds(): void {
    const bounds = this.manifest.navigation.bounds;
    if (!bounds) {
      return;
    }
    this.minBounds = this.toSceneVector(bounds.min);
    this.maxBounds = this.toSceneVector(bounds.max);
    const size = this.maxBounds.clone().sub(this.minBounds);
    this.camera.far = Math.max(250, size.length() * 4);
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    if (this.destroyed) {
      return;
    }
    const delta = Math.min(0.05, this.clock.getDelta());
    const elapsed = this.clock.elapsedTime;
    this.updateControls(delta);
    this.updateTweens(delta);
    this.updateMovement(delta);
    this.updateMarker(elapsed);
    this.managedTextures.forEach((item) => item.update?.(elapsed));
    this.renderer.render(this.scene, this.camera);
    this.frameId = requestAnimationFrame(this.animate);
  };

  private updateControls(delta: number): void {
    if (this.cameraTween) {
      return;
    }
    if (!this.controls.enabled) {
      this.applyYawPitch();
      return;
    }
    if (!this.controls.keyboard) {
      this.updateWheelMovement(delta);
      this.applyYawPitch();
      return;
    }
    const direction = new THREE.Vector3();
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw) * -1);
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) {
      direction.add(forward);
    }
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) {
      direction.sub(forward);
    }
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) {
      direction.add(right);
    }
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) {
      direction.sub(right);
    }

    if (direction.lengthSq() > 0) {
      direction.normalize().multiplyScalar(this.controls.moveSpeed * delta);
      this.moveCameraBy(direction);
      this.cancelClickMove();
    }

    this.updateWheelMovement(delta);
    this.applyYawPitch();
  }

  private updateWheelMovement(delta: number): void {
    if (!this.controls.enabled || Math.abs(this.wheelVelocity) < 0.01) {
      this.wheelVelocity = 0;
      return;
    }
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.001) {
      this.wheelVelocity = 0;
      return;
    }
    this.cancelClickMove();
    forward.normalize().multiplyScalar(this.wheelVelocity * delta);
    const moved = this.moveCameraBy(forward);
    this.wheelVelocity *= moved ? Math.exp(-7 * delta) : Math.exp(-22 * delta);
  }

  private updateTweens(delta: number): void {
    if (!this.cameraTween) {
      return;
    }
    this.cameraTween.elapsed += delta;
    const t = Math.min(1, this.cameraTween.elapsed / this.cameraTween.duration);
    const eased = easeOutCubic(t);
    this.camera.position.lerpVectors(this.cameraTween.fromPosition, this.cameraTween.toPosition, eased);
    this.cameraTarget.lerpVectors(this.cameraTween.fromTarget, this.cameraTween.toTarget, eased);
    this.camera.lookAt(this.cameraTarget);
    if (t >= 1) {
      const view = this.cameraTween.view;
      this.cameraTween = undefined;
      this.updateAnglesFromTarget();
      if (view) {
        this.options.onViewChange?.(view);
      }
    }
  }

  private updateMovement(delta: number): void {
    if (!this.moveTarget || this.cameraTween) {
      return;
    }
    const target = this.moveTarget.clone();
    const verticalDistance = Math.abs(this.camera.position.y - target.y);
    const flatCompletionDelta = target.clone().sub(this.camera.position);
    flatCompletionDelta.y = 0;
    const flatCompletionDistance = flatCompletionDelta.length();
    const hasIntermediateWaypoint = this.movePath.length > 0;
    const arrivalRadius = hasIntermediateWaypoint
      ? Math.max(0.18, this.collisionBodyRadius() * 0.72)
      : Math.max(0.075, this.collisionBodyRadius() * 0.28);
    const flatReached = flatCompletionDistance < arrivalRadius;
    const verticalSnapThreshold = 0.025;
    const verticalSettleThreshold = hasIntermediateWaypoint ? Math.max(0.18, this.floorBumpTolerance() * 0.65) : 0.12;
    if (flatReached && (verticalDistance < verticalSettleThreshold || hasIntermediateWaypoint)) {
      if (!hasIntermediateWaypoint) {
        this.camera.position.x = target.x;
        this.camera.position.z = target.z;
      }
      const verticalSettled = verticalDistance <= verticalSnapThreshold;
      if (verticalSettled) {
        if (!hasIntermediateWaypoint) {
          this.camera.position.y = target.y;
          this.stableFloorY = target.y - this.cameraHeight;
        }
        this.resetPendingFloorTransition();
      } else {
        const smoothing = this.floorHeightSmoothing();
        const previousFloorY = this.stableFloorY ?? this.camera.position.y - this.cameraHeight;
        const targetFloorY = target.y - this.cameraHeight;
        this.camera.position.y = this.clampVerticalCameraDelta(
          this.camera.position.y,
          damp(this.camera.position.y, target.y, smoothing, delta),
          delta
        );
        this.stableFloorY = damp(previousFloorY, targetFloorY, smoothing, delta);
      }
      if (!verticalSettled && !hasIntermediateWaypoint) {
        return;
      }
      const nextWaypoint = this.movePath.shift();
      if (nextWaypoint) {
        this.moveTarget = nextWaypoint;
        this.clickMoveVelocity = Math.max(0.16, this.clickMoveVelocity * 0.72);
      } else {
        this.clickMoveVelocity = 0;
        this.moveTarget = undefined;
        this.moveMarker.visible = false;
      }
      return;
    }
    const nextPosition = this.camera.position.clone();
    const flatDelta = target.clone().sub(this.camera.position);
    flatDelta.y = 0;
    const flatDistance = flatDelta.length();
    const clickMoveSpeed = this.controls.clickMoveSpeed ?? 1.05;
    if (flatDistance > 0.001) {
      if (!this.draggingLook && flatDistance > 0.15) {
        this.yaw = dampAngle(this.yaw, Math.atan2(flatDelta.x, -flatDelta.z), 2.7, delta);
        this.pitch = damp(this.pitch, THREE.MathUtils.clamp(this.pitch, -0.18, 0.12), 1.4, delta);
      }
      const minimumSpeed = hasIntermediateWaypoint ? 0.18 : 0.045;
      const desiredSpeed = THREE.MathUtils.clamp(flatDistance * 1.15, minimumSpeed, clickMoveSpeed);
      const acceleration = flatDistance < 0.85 ? (hasIntermediateWaypoint ? 4.5 : 3.25) : 2.8;
      this.clickMoveVelocity = damp(this.clickMoveVelocity, desiredSpeed, acceleration, delta);
      const step = Math.min(flatDistance, this.clickMoveVelocity * delta);
      flatDelta.normalize().multiplyScalar(step);
      nextPosition.x += flatDelta.x;
      nextPosition.z += flatDelta.z;
    }
    if (this.geometryFloorMeshes.length === 0) {
      nextPosition.y = damp(nextPosition.y, target.y, 5.5, delta);
    }
    const origin = this.camera.position.clone();
    if (this.commitCameraPosition(nextPosition, origin, delta)) {
      return;
    }
    const slideDelta = nextPosition.clone().sub(origin);
    if (this.slideCameraBy(slideDelta, delta)) {
      return;
    }
    this.cancelClickMove();
  }

  private cancelClickMove(): void {
    this.moveTarget = undefined;
    this.movePath = [];
    this.clickMoveVelocity = 0;
    this.moveMarker.visible = false;
  }

  private updateMarker(elapsed: number): void {
    if (!this.moveMarker.visible) {
      return;
    }
    const pulse = 1 + Math.sin(elapsed * 6) * 0.08;
    this.moveMarker.scale.setScalar(pulse);
    this.moveMarker.rotation.y = Math.sin(elapsed * 2.2) * 0.08;
  }

  private applyYawPitch(): void {
    const direction = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    this.cameraTarget.copy(this.camera.position).add(direction);
    this.camera.lookAt(this.cameraTarget);
  }

  private updateAnglesFromTarget(): void {
    const direction = this.cameraTarget.clone().sub(this.camera.position).normalize();
    this.pitch = Math.asin(THREE.MathUtils.clamp(direction.y, -0.98, 0.98));
    this.yaw = Math.atan2(direction.x, -direction.z);
  }

  private clampCamera(): void {
    if (this.minBounds && this.maxBounds) {
      clampToBounds(this.camera.position, this.minBounds, this.maxBounds);
    }
    this.camera.position.y = Math.max(0.2, this.camera.position.y);
  }

  private moveCameraBy(delta: THREE.Vector3): boolean {
    if (this.commitCameraPosition(this.camera.position.clone().add(delta), this.camera.position)) {
      return true;
    }
    return this.slideCameraBy(delta);
  }

  private slideCameraBy(delta: THREE.Vector3, frameDelta = 1 / 60): boolean {
    let moved = false;
    const slideXTarget = this.camera.position.clone().add(new THREE.Vector3(delta.x, 0, 0));
    if (Math.abs(delta.x) > 0.0001 && this.commitCameraPosition(slideXTarget, this.camera.position, frameDelta)) {
      moved = true;
    }

    const slideZTarget = this.camera.position.clone().add(new THREE.Vector3(0, 0, delta.z));
    if (Math.abs(delta.z) > 0.0001 && this.commitCameraPosition(slideZTarget, this.camera.position, frameDelta)) {
      moved = true;
    }
    return moved;
  }

  private commitCameraPosition(position: THREE.Vector3, origin: THREE.Vector3, delta = 1 / 60): boolean {
    const resolved = this.resolveSteppedMovementPosition(position, origin, delta);
    if (!resolved || !this.canOccupyPosition(resolved, origin)) {
      return false;
    }
    this.camera.position.copy(resolved);
    this.snapCameraToFloor(delta);
    this.clampCamera();
    return true;
  }

  private resolveSteppedMovementPosition(
    position: THREE.Vector3,
    origin: THREE.Vector3,
    delta = 1 / 60
  ): THREE.Vector3 | undefined {
    if (this.geometryFloorMeshes.length === 0) {
      return position;
    }
    const floorY = this.sampleGeometryFloorY(position, {
      maxDelta: Math.max(
        this.controls.maxStepDown ?? this.maxStepDown,
        this.controls.maxStepUp ?? this.maxStepUp,
        this.cameraHeight * 0.5
      )
    });
    if (typeof floorY !== "number") {
      return position;
    }
    const originFloorY = (this.stableFloorY ?? origin.y - this.cameraHeight);
    const heightDelta = floorY - originFloorY;
    const maxStepUp = this.controls.maxStepUp ?? this.maxStepUp;
    const maxStepDown = this.controls.maxStepDown ?? this.maxStepDown;
    if (heightDelta > maxStepUp || heightDelta < -maxStepDown) {
      return undefined;
    }
    const next = position.clone();
    const bumpTolerance = this.floorBumpTolerance();
    const targetFloorY = this.floorHeightTargetForSample(position, floorY, originFloorY);
    const targetY = targetFloorY + this.cameraHeight;
    const floorHeightSmoothing = this.floorHeightSmoothing();
    const smoothing = Math.abs(heightDelta) <= bumpTolerance ? floorHeightSmoothing * 2.8 : floorHeightSmoothing;
    next.y = this.clampVerticalCameraDelta(position.y, damp(position.y, targetY, smoothing, delta), delta);
    return next;
  }

  private canOccupyPosition(position: THREE.Vector3, origin?: THREE.Vector3): boolean {
    return !this.navigationFailureDetail(position, origin);
  }

  private floorHeightTargetForSample(position: THREE.Vector3, floorY: number, referenceFloorY: number): number {
    const bumpTolerance = this.floorBumpTolerance();
    const levelDelta = floorY - referenceFloorY;
    if (Math.abs(levelDelta) <= bumpTolerance) {
      this.resetPendingFloorTransition();
      return referenceFloorY;
    }
    if (Math.abs(levelDelta) <= Math.max(0.48, this.cameraHeight * 0.2)) {
      this.resetPendingFloorTransition();
      return referenceFloorY;
    }
    if (this.shouldHoldClickMoveFloorHeight(floorY, referenceFloorY)) {
      this.resetPendingFloorTransition();
      return referenceFloorY;
    }
    if (!this.isSupportedFloorHeight(position, floorY, { referenceFloorY, sampledFloorY: floorY })) {
      this.resetPendingFloorTransition();
      return referenceFloorY;
    }
    const transitionTolerance = Math.max(0.08, bumpTolerance * 0.55);
    if (
      typeof this.pendingFloorY !== "number" ||
      Math.abs(this.pendingFloorY - floorY) > transitionTolerance
    ) {
      this.pendingFloorY = floorY;
      this.pendingFloorSamples = 1;
    } else {
      this.pendingFloorSamples += 1;
    }
    const activeNavigation =
      Boolean(this.moveTarget) || this.movePath.length > 0 || Math.abs(this.wheelVelocity) > 0.01 || this.keys.size > 0;
    const largeLevelChange = Math.abs(levelDelta) >= Math.max(0.55, this.cameraHeight * 0.32);
    const requiredSamples = activeNavigation ? (largeLevelChange ? 5 : 8) : largeLevelChange ? 3 : 5;
    return this.pendingFloorSamples >= requiredSamples ? floorY : referenceFloorY;
  }

  private shouldHoldClickMoveFloorHeight(floorY: number, referenceFloorY: number): boolean {
    if (!this.moveTarget || this.keys.size > 0 || Math.abs(this.wheelVelocity) > 0.01) {
      return false;
    }
    const targetFloorY = this.moveTarget.y - this.cameraHeight;
    const targetMatchesCurrentFloor =
      Math.abs(targetFloorY - referenceFloorY) <= Math.max(this.floorBumpTolerance(), this.cameraHeight * 0.22);
    const sampleMatchesTarget =
      Math.abs(floorY - targetFloorY) <= Math.max(0.16, this.floorBumpTolerance() * 0.5);
    return targetMatchesCurrentFloor && !sampleMatchesTarget;
  }

  private resetPendingFloorTransition(): void {
    this.pendingFloorY = undefined;
    this.pendingFloorSamples = 0;
  }

  private navigationFailureDetail(
    position: THREE.Vector3,
    origin?: THREE.Vector3
  ): NavigationFailureDetail | undefined {
    const candidate = this.navigationProbePosition(position);
    if (this.minBounds && this.maxBounds) {
      if (
        candidate.x < this.minBounds.x ||
        candidate.x > this.maxBounds.x ||
        candidate.z < this.minBounds.z ||
        candidate.z > this.maxBounds.z
      ) {
        return { reason: "outside-bounds", point: candidate.clone() };
      }
      clampToBounds(candidate, this.minBounds, this.maxBounds);
    }

    const insidePassZone = this.isInsidePassZone(candidate);
    if (
      this.walkZoneMeshes.length > 0 &&
      !this.isInsideWalkZone(candidate) &&
      !insidePassZone
    ) {
      const generatedZoneMissOnFloor = this.generatedWalkZonesOnly && this.canStandOnGeometryFloor(candidate);
      const explicitWalkMissOnFloor = this.canStandOnExplicitWalkMesh(candidate);
      if (!generatedZoneMissOnFloor) {
        if (!explicitWalkMissOnFloor) {
          return { reason: "outside-walk-zone", point: candidate.clone() };
        }
      }
    }

    const originProbe = origin ? this.navigationProbePosition(origin) : undefined;
    const originBlockedBlockers = originProbe ? this.collisionBlockersAtPosition(originProbe) : [];
    const bridgePassesObjectBlockers = Boolean(
      originProbe && this.isPassZoneBridgeSegment(originProbe, candidate)
    );
    const blockedBlockers = this.collisionBlockersAtPosition(candidate);
    const effectiveBlockers = insidePassZone
      ? blockedBlockers.filter((blocker) => blocker.kind === "authored")
      : blockedBlockers;
    if (originProbe) {
      const sweptBlocker = this.navigationSegmentBlocker(originProbe, candidate, {
        ignoreBlockers: originBlockedBlockers,
        ignoreInferredBlockers: bridgePassesObjectBlockers,
        ignoreNonAuthoredBlockers: bridgePassesObjectBlockers,
        authoredOnly: insidePassZone
      });
      if (sweptBlocker) {
        return {
          reason: "blocked-collision",
          blockerName: sweptBlocker.name,
          blockerKind: sweptBlocker.kind,
          point: candidate.clone()
        };
      }
    }
    if (effectiveBlockers.length === 0) {
      return undefined;
    }
    if (!origin) {
      const blocker = effectiveBlockers[0];
      return blocker?.name
        ? { reason: "blocked-collision", blockerName: blocker.name, blockerKind: blocker.kind, point: candidate.clone() }
        : { reason: "blocked-collision", point: candidate.clone() };
    }
    if (
      effectiveBlockers.every((blocker) => blocker.kind !== "authored") &&
      bridgePassesObjectBlockers
    ) {
      return undefined;
    }
    const newlyBlocked = effectiveBlockers.find((blocker) => !originBlockedBlockers.includes(blocker));
    return newlyBlocked
      ? { reason: "blocked-collision", blockerName: newlyBlocked.name, blockerKind: newlyBlocked.kind, point: candidate.clone() }
      : undefined;
  }

  private navigationSegmentBlocker(
    origin: THREE.Vector3,
    target: THREE.Vector3,
    options: {
      ignoreBlockers?: readonly CollisionBlocker[];
      ignoreInferredBlockers?: boolean;
      ignoreNonAuthoredBlockers?: boolean;
      authoredOnly?: boolean;
    } = {}
  ): CollisionBlocker | undefined {
    if (origin.distanceToSquared(target) < 0.0001) {
      return undefined;
    }
    const ignored = new Set(options.ignoreBlockers ?? []);
    const originVertical = this.bodyVerticalRangeAt(origin);
    const targetVertical = this.bodyVerticalRangeAt(target);
    const minY = Math.min(originVertical.min, targetVertical.min);
    const maxY = Math.max(originVertical.max, targetVertical.max);
    return this.collisionBlockers.find((blocker) => {
      if (ignored.has(blocker)) {
        return false;
      }
      if (options.authoredOnly && blocker.kind !== "authored") {
        return false;
      }
      if (options.ignoreNonAuthoredBlockers && blocker.kind !== "authored") {
        return false;
      }
      if (options.ignoreInferredBlockers && blocker.kind === "inferred") {
        return false;
      }
      if (maxY < blocker.box.min.y || minY > blocker.box.max.y) {
        return false;
      }
      return segmentIntersectsInflatedBox2D(origin, target, blocker.box, this.collisionBodyRadius());
    });
  }

  private collisionBlockersAtPosition(position: THREE.Vector3): CollisionBlocker[] {
    return this.collisionBlockers.filter((blocker) => this.blockerIntersectsBodyAtPosition(blocker, position));
  }

  private blockerIntersectsBodyAtPosition(blocker: CollisionBlocker, position: THREE.Vector3): boolean {
    const vertical = this.bodyVerticalRangeAt(position);
    if (vertical.max < blocker.box.min.y || vertical.min > blocker.box.max.y) {
      return false;
    }
    return pointInsideInflatedBox2D(position, blocker.box, this.collisionBodyRadius());
  }

  private bodyVerticalRangeAt(position: THREE.Vector3): { min: number; max: number } {
    const floorY = position.y - this.cameraHeight;
    return {
      min: floorY + Math.max(0.08, this.cameraHeight * 0.06),
      max: position.y + Math.max(0.08, this.cameraHeight * 0.06)
    };
  }

  private navigationClearanceAtPosition(position: THREE.Vector3): number {
    const vertical = this.bodyVerticalRangeAt(position);
    let clearance = Number.POSITIVE_INFINITY;
    for (const blocker of this.collisionBlockers) {
      if (vertical.max < blocker.box.min.y || vertical.min > blocker.box.max.y) {
        continue;
      }
      clearance = Math.min(clearance, distanceToInflatedBox2D(position, blocker.box, this.collisionBodyRadius()));
    }
    return clearance;
  }

  private navigationProbePosition(position: THREE.Vector3): THREE.Vector3 {
    const candidate = position.clone();
    if (!this.generatedWalkZonesOnly || this.geometryFloorMeshes.length === 0) {
      return candidate;
    }
    const floorY = this.sampleGeometryFloorY(candidate, { maxDelta: Math.max(0.75, this.cameraHeight * 0.45) });
    if (typeof floorY !== "number") {
      return candidate;
    }
    const expectedFloorY = candidate.y - this.cameraHeight;
    if (Math.abs(floorY - expectedFloorY) <= Math.max(1.1, this.cameraHeight * 0.65)) {
      candidate.y = floorY + this.cameraHeight;
    }
    return candidate;
  }

  private navigationRouteFailureDetail(
    target: THREE.Vector3,
    origin: THREE.Vector3
  ): NavigationFailureDetail | undefined {
    const route = target.clone().sub(origin);
    route.y = 0;
    const distance = route.length();
    if (distance < 0.001) {
      return undefined;
    }
    const steps = Math.max(2, Math.ceil(distance / Math.max(0.18, this.collisionBodyRadius() * 0.75)));
    let previous = origin.clone();
    let previousFloorY = this.stableFloorY ?? origin.y - this.cameraHeight;
    const maxStepUp = this.controls.maxStepUp ?? this.maxStepUp;
    const maxStepDown = this.controls.maxStepDown ?? this.maxStepDown;
    for (let index = 1; index <= steps; index += 1) {
      const point = this.navigationProbePosition(origin.clone().lerp(target, index / steps));
      const floorY = this.sampleGeometryFloorY(point, {
        maxDelta: Math.max(maxStepDown, maxStepUp, this.cameraHeight * 0.5)
      });
      if (typeof floorY === "number") {
        const heightDelta = floorY - previousFloorY;
        if (heightDelta > maxStepUp || heightDelta < -maxStepDown) {
          return { reason: "blocked-step", point: point.clone() };
        }
        previousFloorY = floorY;
        point.y = floorY + this.cameraHeight;
      }
      const failure = this.navigationFailureDetail(point, previous);
      if (failure) {
        return { ...failure, point: failure.point ?? point.clone() };
      }
      previous = point;
    }
    return undefined;
  }

  private rememberRouteFailureDetail(detail: NavigationFailureDetail | undefined): void {
    if (!detail) {
      return;
    }
    const priority: Record<NavigationFailureReason, number> = {
      "blocked-collision": 5,
      "blocked-step": 4,
      "route-not-found": 3,
      "outside-walk-zone": 2,
      "outside-bounds": 1,
      "no-walkable-hit": 1
    };
    const current = this.routeSearchFailureDetail;
    if (!current || priority[detail.reason] > priority[current.reason]) {
      this.routeSearchFailureDetail = detail;
    }
  }

  private findNavigationRoute(target: THREE.Vector3, origin: THREE.Vector3): THREE.Vector3[] | undefined {
    this.routeSearchFailureDetail = undefined;
    const zoneRoute = this.findZoneNavigationRoute(target, origin);
    const route =
      (zoneRoute && this.navigationRouteSegmentsPass(zoneRoute, origin) ? zoneRoute : undefined) ??
      this.findVisibilityNavigationRoute(target, origin) ??
      this.findGridNavigationRoute(target, origin);
    return route ? this.smoothNavigationRoute(route, origin) ?? route : undefined;
  }

  private smoothNavigationRoute(route: THREE.Vector3[], origin: THREE.Vector3): THREE.Vector3[] | undefined {
    if (route.length <= 1) {
      return route;
    }
    return this.simplifyNavigationRoute([origin.clone(), ...route.map((point) => point.clone())]);
  }

  private navigationRouteSegmentsPass(route: readonly THREE.Vector3[], origin: THREE.Vector3): boolean {
    let previous = origin;
    for (const waypoint of route) {
      const failure = this.navigationRouteFailureDetail(waypoint, previous);
      if (failure) {
        this.rememberRouteFailureDetail(failure);
        return false;
      }
      previous = waypoint;
    }
    return true;
  }

  private findVisibilityNavigationRoute(target: THREE.Vector3, origin: THREE.Vector3): THREE.Vector3[] | undefined {
    const routeMeshes = this.navigationRouteMeshes(origin, target);
    if (routeMeshes.length === 0) {
      return undefined;
    }

    const nodes: RouteNode[] = [
      { point: origin.clone(), previous: -1, cost: 0, visited: false },
      ...routeMeshes.flatMap((mesh) =>
        this.navigationRoutePointsForMesh(mesh, target.y).map((point) => ({
          point: this.navigationProbePosition(point),
          previous: -1,
          cost: Number.POSITIVE_INFINITY,
          visited: false
        }))
      ),
      { point: target.clone(), previous: -1, cost: Number.POSITIVE_INFINITY, visited: false }
    ];

    for (let index = 1; index < nodes.length - 1; index += 1) {
      const node = nodes[index];
      if (node && this.navigationFailureDetail(node.point, origin)) {
        node.visited = true;
      }
    }

    const targetIndex = nodes.length - 1;
    while (true) {
      let currentIndex = -1;
      let currentCost = Number.POSITIVE_INFINITY;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node && !node.visited && node.cost < currentCost) {
          currentIndex = index;
          currentCost = node.cost;
        }
      }
      if (currentIndex === -1 || currentIndex === targetIndex) {
        break;
      }

      const current = nodes[currentIndex];
      if (!current) {
        break;
      }
      current.visited = true;
      for (let index = 1; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!node || node.visited || index === currentIndex) {
          continue;
        }
        const failure = this.navigationRouteFailureDetail(node.point, current.point);
        if (failure) {
          this.rememberRouteFailureDetail(failure);
          continue;
        }
        const nextCost = current.cost + current.point.distanceTo(node.point);
        if (nextCost < node.cost) {
          node.cost = nextCost;
          node.previous = currentIndex;
        }
      }
    }

    const targetNode = nodes[targetIndex];
    if (!targetNode || !Number.isFinite(targetNode.cost)) {
      return undefined;
    }

    const route: THREE.Vector3[] = [];
    let index = targetIndex;
    while (index > 0) {
      const node = nodes[index];
      if (!node) {
        return undefined;
      }
      route.unshift(node.point.clone());
      index = node.previous;
      if (index < 0) {
        return undefined;
      }
    }

    return route;
  }

  private findZoneNavigationRoute(target: THREE.Vector3, origin: THREE.Vector3): THREE.Vector3[] | undefined {
    const routeMeshes = [...this.walkZoneMeshes, ...this.passZoneMeshes];
    if (routeMeshes.length < 2) {
      return undefined;
    }
    const originMeshes = this.navigationMeshesContainingPoint(routeMeshes, origin);
    const targetMeshes = this.navigationMeshesContainingPoint(routeMeshes, target);
    if (originMeshes.length === 0 || targetMeshes.length === 0) {
      return undefined;
    }
    if (originMeshes.some((mesh) => targetMeshes.includes(mesh))) {
      return undefined;
    }

    const targetMeshSet = new Set(targetMeshes);
    const targetCenter = target.clone();
    const nodes: ZoneRouteNode[] = routeMeshes.map((mesh) => {
      const center = this.navigationMeshCenter(mesh, target.y);
      return {
        mesh,
        center,
        previous: -1,
        cost: Number.POSITIVE_INFINITY,
        estimate: Number.POSITIVE_INFINITY,
        closed: false
      };
    });
    const meshIndex = new Map(nodes.map((node, index) => [node.mesh, index]));
    const targetIndexes = new Set(targetMeshes.map((mesh) => meshIndex.get(mesh)).filter((index): index is number => typeof index === "number"));
    const heuristic = (point: THREE.Vector3) => Math.hypot(point.x - targetCenter.x, point.z - targetCenter.z);
    for (const mesh of originMeshes) {
      const index = meshIndex.get(mesh);
      const node = typeof index === "number" ? nodes[index] : undefined;
      if (!node) {
        continue;
      }
      node.cost = Math.hypot(node.center.x - origin.x, node.center.z - origin.z);
      node.estimate = node.cost + heuristic(node.center);
    }

    while (true) {
      let currentIndex = -1;
      let bestEstimate = Number.POSITIVE_INFINITY;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node && !node.closed && node.estimate < bestEstimate) {
          currentIndex = index;
          bestEstimate = node.estimate;
        }
      }
      if (currentIndex < 0) {
        break;
      }
      const current = nodes[currentIndex];
      if (!current) {
        break;
      }
      current.closed = true;
      if (targetIndexes.has(currentIndex)) {
        const route = this.zoneRoutePoints(nodes, currentIndex, origin, target, targetMeshSet);
        return route ? this.simplifyNavigationRoute(route) : undefined;
      }

      for (let index = 0; index < nodes.length; index += 1) {
        const next = nodes[index];
        if (!next || next.closed || index === currentIndex || !this.navigationMeshesConnect(current.mesh, next.mesh)) {
          continue;
        }
        const bridgePoint = this.navigationMeshBridgePoint(current.mesh, next.mesh, target.y);
        const passZoneBias = this.navigationMeshIsPass(next.mesh) ? -0.2 : 0;
        const nextCost =
          current.cost +
          Math.hypot(current.center.x - bridgePoint.x, current.center.z - bridgePoint.z) +
          Math.hypot(bridgePoint.x - next.center.x, bridgePoint.z - next.center.z) +
          passZoneBias;
        if (nextCost >= next.cost) {
          continue;
        }
        next.cost = nextCost;
        next.estimate = nextCost + heuristic(next.center);
        next.previous = currentIndex;
      }
    }
    return undefined;
  }

  private zoneRoutePoints(
    nodes: readonly ZoneRouteNode[],
    targetIndex: number,
    origin: THREE.Vector3,
    target: THREE.Vector3,
    targetMeshes: ReadonlySet<THREE.Mesh>
  ): THREE.Vector3[] | undefined {
    const indexes: number[] = [];
    let index = targetIndex;
    while (index >= 0) {
      indexes.unshift(index);
      const node = nodes[index];
      if (!node) {
        return undefined;
      }
      index = node.previous;
    }
    const points: THREE.Vector3[] = [origin.clone()];
    for (let routeIndex = 0; routeIndex < indexes.length; routeIndex += 1) {
      const current = nodes[indexes[routeIndex]!];
      const next = nodes[indexes[routeIndex + 1]!];
      if (!current) {
        return undefined;
      }
      if (next) {
        points.push(this.navigationMeshBridgePoint(current.mesh, next.mesh, target.y));
        if (this.navigationMeshIsPass(next.mesh)) {
          points.push(next.center.clone());
        }
        continue;
      }
      if (!targetMeshes.has(current.mesh)) {
        points.push(current.center.clone());
      }
    }
    points.push(target.clone());
    return points;
  }

  private navigationMeshesContainingPoint(meshes: readonly THREE.Mesh[], point: THREE.Vector3): THREE.Mesh[] {
    const containing = meshes.filter((mesh) =>
      this.isInsideNavigationZoneWithPadding(mesh, point, Math.max(0.18, this.collisionBodyRadius() * 1.25))
    );
    if (containing.length > 0) {
      return containing;
    }
    return meshes
      .map((mesh) => ({ mesh, distance: this.navigationMeshDistanceToPoint(mesh, point) }))
      .filter((entry) => entry.distance <= Math.max(0.75, this.collisionBodyRadius() * 2.5))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2)
      .map((entry) => entry.mesh);
  }

  private navigationMeshesConnect(a: THREE.Mesh, b: THREE.Mesh): boolean {
    const boxA = this.navigationMeshBounds2D(a);
    const boxB = this.navigationMeshBounds2D(b);
    const padding = this.navigationMeshConnectionPadding(a, b);
    const boundsMayTouch =
      boxA.minX - padding <= boxB.maxX &&
      boxA.maxX + padding >= boxB.minX &&
      boxA.minZ - padding <= boxB.maxZ &&
      boxA.maxZ + padding >= boxB.minZ;
    if (!boundsMayTouch) {
      return false;
    }
    const footprintA = this.navigationMeshFootprint2D(a);
    const footprintB = this.navigationMeshFootprint2D(b);
    if (footprintA.length >= 3 && footprintB.length >= 3) {
      return polygonDistance2D(footprintA, footprintB) <= padding;
    }
    return true;
  }

  private navigationMeshConnectionPadding(a: THREE.Mesh, b: THREE.Mesh): number {
    // Door/pass zones are often drawn from a top view and can miss the walk
    // patch by a small threshold or frame thickness. Keep the graph tolerant
    // here, then let swept collision/step checks reject unsafe routes.
    return navigationZoneConnectionPadding(
      `${a.userData["navigationZoneKind"] ?? ""}`,
      `${b.userData["navigationZoneKind"] ?? ""}`,
      this.collisionBodyRadius()
    );
  }

  private navigationMeshIsPass(mesh: THREE.Mesh): boolean {
    return mesh.userData["navigationZoneKind"] === "pass";
  }

  private navigationMeshBridgePoint(a: THREE.Mesh, b: THREE.Mesh, y: number): THREE.Vector3 {
    const boxA = this.navigationMeshBounds2D(a);
    const boxB = this.navigationMeshBounds2D(b);
    const overlapMinX = Math.max(boxA.minX, boxB.minX);
    const overlapMaxX = Math.min(boxA.maxX, boxB.maxX);
    const overlapMinZ = Math.max(boxA.minZ, boxB.minZ);
    const overlapMaxZ = Math.min(boxA.maxZ, boxB.maxZ);
    const centerA = this.navigationMeshCenter(a, y);
    const centerB = this.navigationMeshCenter(b, y);
    const x =
      overlapMinX <= overlapMaxX
        ? (overlapMinX + overlapMaxX) / 2
        : (Math.max(boxA.minX, boxB.minX) + Math.min(boxA.maxX, boxB.maxX)) / 2;
    const z =
      overlapMinZ <= overlapMaxZ
        ? (overlapMinZ + overlapMaxZ) / 2
        : (Math.max(boxA.minZ, boxB.minZ) + Math.min(boxA.maxZ, boxB.maxZ)) / 2;
    const point = new THREE.Vector3(
      Number.isFinite(x) ? x : (centerA.x + centerB.x) / 2,
      y,
      Number.isFinite(z) ? z : (centerA.z + centerB.z) / 2
    );
    if (overlapMinX > overlapMaxX || overlapMinZ > overlapMaxZ) {
      const footprintA = this.navigationMeshFootprint2D(a);
      const footprintB = this.navigationMeshFootprint2D(b);
      const bridgePair =
        footprintA.length >= 3 && footprintB.length >= 3
          ? closestPolygonPointPair2D(footprintA, footprintB)
          : undefined;
      if (bridgePair) {
        point.set((bridgePair.a[0] + bridgePair.b[0]) / 2, y, (bridgePair.a[1] + bridgePair.b[1]) / 2);
      }
    }
    return this.navigationProbePosition(point);
  }

  private navigationMeshCenter(mesh: THREE.Mesh, y: number): THREE.Vector3 {
    const point = new THREE.Vector3();
    mesh.getWorldPosition(point);
    point.y = y;
    return this.navigationProbePosition(point);
  }

  private navigationMeshDistanceToPoint(mesh: THREE.Mesh, point: THREE.Vector3): number {
    const footprint = this.navigationMeshFootprint2D(mesh);
    if (footprint.length >= 3) {
      return pointToPolygonDistance2D([point.x, point.z], footprint);
    }
    const box = this.navigationMeshBounds2D(mesh);
    const dx = point.x < box.minX ? box.minX - point.x : point.x > box.maxX ? point.x - box.maxX : 0;
    const dz = point.z < box.minZ ? box.minZ - point.z : point.z > box.maxZ ? point.z - box.maxZ : 0;
    return Math.hypot(dx, dz);
  }

  private navigationMeshFootprint2D(mesh: THREE.Mesh): Vec2[] {
    const polygon = mesh.userData["navigationPolygon"];
    if (Array.isArray(polygon) && polygon.every((point) => point instanceof THREE.Vector2)) {
      return polygon.map((point) => {
        const world = mesh.localToWorld(new THREE.Vector3(point.x, 0, point.y));
        return [world.x, world.z];
      });
    }
    const halfSize = mesh.userData["navigationHalfSize"];
    if (halfSize instanceof THREE.Vector3) {
      return [
        new THREE.Vector3(-halfSize.x, 0, -halfSize.z),
        new THREE.Vector3(halfSize.x, 0, -halfSize.z),
        new THREE.Vector3(halfSize.x, 0, halfSize.z),
        new THREE.Vector3(-halfSize.x, 0, halfSize.z)
      ].map((point) => {
        const world = mesh.localToWorld(point);
        return [world.x, world.z];
      });
    }
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) {
      return [];
    }
    return [
      [box.min.x, box.min.z],
      [box.max.x, box.min.z],
      [box.max.x, box.max.z],
      [box.min.x, box.max.z]
    ];
  }

  private navigationMeshBounds2D(mesh: THREE.Mesh): NavigationMeshBounds2D {
    const halfSize = mesh.userData["navigationHalfSize"];
    const polygon = mesh.userData["navigationPolygon"];
    if (Array.isArray(polygon) && polygon.every((point) => point instanceof THREE.Vector2)) {
      const points = polygon.map((point) => mesh.localToWorld(new THREE.Vector3(point.x, 0, point.y)));
      return {
        minX: Math.min(...points.map((point) => point.x)),
        maxX: Math.max(...points.map((point) => point.x)),
        minZ: Math.min(...points.map((point) => point.z)),
        maxZ: Math.max(...points.map((point) => point.z))
      };
    }
    if (halfSize instanceof THREE.Vector3) {
      const corners = [
        new THREE.Vector3(-halfSize.x, 0, -halfSize.z),
        new THREE.Vector3(halfSize.x, 0, -halfSize.z),
        new THREE.Vector3(halfSize.x, 0, halfSize.z),
        new THREE.Vector3(-halfSize.x, 0, halfSize.z)
      ].map((point) => mesh.localToWorld(point));
      return {
        minX: Math.min(...corners.map((point) => point.x)),
        maxX: Math.max(...corners.map((point) => point.x)),
        minZ: Math.min(...corners.map((point) => point.z)),
        maxZ: Math.max(...corners.map((point) => point.z))
      };
    }
    const box = new THREE.Box3().setFromObject(mesh);
    return {
      minX: box.min.x,
      maxX: box.max.x,
      minZ: box.min.z,
      maxZ: box.max.z
    };
  }

  private findGridNavigationRoute(target: THREE.Vector3, origin: THREE.Vector3): THREE.Vector3[] | undefined {
    const flatDistance = Math.hypot(target.x - origin.x, target.z - origin.z);
    const hasRouteSurface = this.walkZoneMeshes.length > 0 || this.geometryFloorMeshes.length > 0;
    if (flatDistance < 0.001 || !hasRouteSurface) {
      return undefined;
    }

    const margin = THREE.MathUtils.clamp(flatDistance * 0.55, 3, 9);
    const globalMinX = this.minBounds?.x ?? Math.min(origin.x, target.x) - margin;
    const globalMaxX = this.maxBounds?.x ?? Math.max(origin.x, target.x) + margin;
    const globalMinZ = this.minBounds?.z ?? Math.min(origin.z, target.z) - margin;
    const globalMaxZ = this.maxBounds?.z ?? Math.max(origin.z, target.z) + margin;
    let minX = Math.max(globalMinX, Math.min(origin.x, target.x) - margin);
    let maxX = Math.min(globalMaxX, Math.max(origin.x, target.x) + margin);
    let minZ = Math.max(globalMinZ, Math.min(origin.z, target.z) - margin);
    let maxZ = Math.min(globalMaxZ, Math.max(origin.z, target.z) + margin);
    let step = Math.max(0.24, this.collisionBodyRadius() * 0.9);
    let columns = Math.max(2, Math.ceil((maxX - minX) / step) + 1);
    let rows = Math.max(2, Math.ceil((maxZ - minZ) / step) + 1);
    const maxCells = 14000;

    if (columns * rows > maxCells) {
      step = Math.sqrt(((maxX - minX) * (maxZ - minZ)) / maxCells);
      step = THREE.MathUtils.clamp(step, 0.28, 0.85);
      columns = Math.max(2, Math.ceil((maxX - minX) / step) + 1);
      rows = Math.max(2, Math.ceil((maxZ - minZ) / step) + 1);
    }

    maxX = minX + (columns - 1) * step;
    maxZ = minZ + (rows - 1) * step;

    const maxStepUp = this.controls.maxStepUp ?? this.maxStepUp;
    const maxStepDown = this.controls.maxStepDown ?? this.maxStepDown;
    const floorSampleMaxDelta = Math.max(maxStepDown, maxStepUp, this.cameraHeight * 0.5);
    const keyFor = (x: number, z: number) => `${x}:${z}`;
    const pointFor = (x: number, z: number) =>
      this.navigationProbePosition(new THREE.Vector3(minX + x * step, target.y, minZ + z * step));
    const cellCache = new Map<string, GridRouteCell | undefined>();
    const cellFor = (x: number, z: number): GridRouteCell | undefined => {
      if (x < 0 || z < 0 || x >= columns || z >= rows) {
        return undefined;
      }
      const key = keyFor(x, z);
      if (cellCache.has(key)) {
        return cellCache.get(key);
      }
      const point = pointFor(x, z);
      const floorY = this.sampleGeometryFloorY(point, { maxDelta: floorSampleMaxDelta });
      if (typeof floorY === "number") {
        point.y = floorY + this.cameraHeight;
      }
      const hasExplicitWalkZones = this.walkZoneMeshes.length > 0;
      const onDetectedFloor = !hasExplicitWalkZones && typeof floorY === "number";
      const cell: GridRouteCell | undefined = (hasExplicitWalkZones || onDetectedFloor) && !this.navigationFailureDetail(point)
        ? {
            point,
            clearance: this.navigationClearanceAtPosition(point),
            onPassZone: this.isInsidePassZone(point),
            ...(typeof floorY === "number" ? { floorY } : {})
          }
        : undefined;
      cellCache.set(key, cell);
      return cell;
    };
    const isPassable = (x: number, z: number): boolean => {
      return Boolean(cellFor(x, z));
    };
    const nearestPassableCell = (point: THREE.Vector3): { x: number; z: number } | undefined => {
      const baseX = THREE.MathUtils.clamp(Math.round((point.x - minX) / step), 0, columns - 1);
      const baseZ = THREE.MathUtils.clamp(Math.round((point.z - minZ) / step), 0, rows - 1);
      const maxSearchRadius = this.generatedWalkZonesOnly ? 9 : 6;
      for (let radius = 0; radius <= maxSearchRadius; radius += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
              continue;
            }
            const x = baseX + dx;
            const z = baseZ + dz;
            if (isPassable(x, z)) {
              return { x, z };
            }
          }
        }
      }
      return undefined;
    };

    const start = nearestPassableCell(origin);
    const goal = nearestPassableCell(target);
    if (!start || !goal) {
      return undefined;
    }

    const heuristic = (x: number, z: number) => Math.hypot(goal.x - x, goal.z - z) * step;
    const startKey = keyFor(start.x, start.z);
    const nodes = new Map<string, GridRouteNode>([
      [startKey, { x: start.x, z: start.z, cost: 0, estimate: heuristic(start.x, start.z), closed: false }]
    ]);
    const open = [startKey];
    const offsets = [
      [-1, 0, 1],
      [1, 0, 1],
      [0, -1, 1],
      [0, 1, 1],
      [-1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [1, 1, Math.SQRT2]
    ] as const;
    let goalKey: string | undefined;
    let iterations = 0;

    while (open.length > 0 && iterations < maxCells) {
      iterations += 1;
      let bestOpenIndex = 0;
      let bestEstimate = Number.POSITIVE_INFINITY;
      for (let index = 0; index < open.length; index += 1) {
        const openKey = open[index];
        if (!openKey) {
          continue;
        }
        const node = nodes.get(openKey);
        if (node && node.estimate < bestEstimate) {
          bestEstimate = node.estimate;
          bestOpenIndex = index;
        }
      }
      const currentKey = open.splice(bestOpenIndex, 1)[0];
      if (!currentKey) {
        continue;
      }
      const current = nodes.get(currentKey);
      if (!current || current.closed) {
        continue;
      }
      current.closed = true;
      if (current.x === goal.x && current.z === goal.z) {
        goalKey = currentKey;
        break;
      }

      for (const [dx, dz, multiplier] of offsets) {
        const nextX = current.x + dx;
        const nextZ = current.z + dz;
        const currentCell = cellFor(current.x, current.z);
        const nextCell = cellFor(nextX, nextZ);
        if (!currentCell || !nextCell) {
          continue;
        }
        if (dx !== 0 && dz !== 0 && (!isPassable(current.x + dx, current.z) || !isPassable(current.x, current.z + dz))) {
          continue;
        }
        const floorDelta =
          typeof currentCell.floorY === "number" && typeof nextCell.floorY === "number"
            ? nextCell.floorY - currentCell.floorY
            : 0;
        if (floorDelta > maxStepUp || floorDelta < -maxStepDown) {
          continue;
        }
        const failure = this.navigationRouteFailureDetail(nextCell.point, currentCell.point);
        if (failure) {
          this.rememberRouteFailureDetail(failure);
          continue;
        }
        const nextKey = keyFor(nextX, nextZ);
        const desiredClearance = Math.max(0.42, this.collisionBodyRadius() * 2.2);
        const effectiveClearance = Number.isFinite(nextCell.clearance) ? nextCell.clearance : desiredClearance;
        const clearancePenalty = Math.max(0, desiredClearance - effectiveClearance) * 2.4;
        const passZoneBias = nextCell.onPassZone ? step * -0.18 : 0;
        const nextCost =
          current.cost + step * multiplier + Math.abs(floorDelta) * 1.8 + clearancePenalty + passZoneBias;
        const existing = nodes.get(nextKey);
        if (existing && (existing.closed || existing.cost <= nextCost)) {
          continue;
        }
        nodes.set(nextKey, {
          x: nextX,
          z: nextZ,
          previous: currentKey,
          cost: nextCost,
          estimate: nextCost + heuristic(nextX, nextZ),
          closed: false
        });
        open.push(nextKey);
      }
    }

    if (!goalKey) {
      return undefined;
    }

    const points: THREE.Vector3[] = [target.clone()];
    let currentKey: string | undefined = goalKey;
    while (currentKey && currentKey !== startKey) {
      const node = nodes.get(currentKey);
      if (!node) {
        return undefined;
      }
      const cell = cellFor(node.x, node.z);
      points.unshift(cell?.point.clone() ?? pointFor(node.x, node.z));
      currentKey = node.previous;
    }
    points.unshift(origin.clone());
    return this.simplifyNavigationRoute(points);
  }

  private simplifyNavigationRoute(points: THREE.Vector3[]): THREE.Vector3[] | undefined {
    if (points.length < 2) {
      return undefined;
    }
    const route: THREE.Vector3[] = [];
    let anchorIndex = 0;
    while (anchorIndex < points.length - 1) {
      let nextIndex = anchorIndex + 1;
      for (let candidateIndex = points.length - 1; candidateIndex > anchorIndex; candidateIndex -= 1) {
        const candidate = points[candidateIndex];
        const anchor = points[anchorIndex];
        if (candidate && anchor && !this.navigationRouteFailureDetail(candidate, anchor)) {
          nextIndex = candidateIndex;
          break;
        }
      }
      const nextPoint = points[nextIndex];
      if (!nextPoint) {
        return undefined;
      }
      route.push(nextPoint.clone());
      anchorIndex = nextIndex;
    }
    return route.length > 0 ? route : undefined;
  }

  private navigationRouteMeshes(origin: THREE.Vector3, target: THREE.Vector3): THREE.Mesh[] {
    const routeMeshes = [...this.passZoneMeshes, ...this.walkZoneMeshes];
    if (routeMeshes.length <= 96) {
      return routeMeshes;
    }

    const passMeshes = this.passZoneMeshes.slice(0, 48);
    const included = new Set(passMeshes);
    const remainingWalkMeshes = this.walkZoneMeshes
      .filter((mesh) => !included.has(mesh))
      .sort((a, b) => this.navigationMeshRouteScore(a, origin, target) - this.navigationMeshRouteScore(b, origin, target));
    return [...passMeshes, ...remainingWalkMeshes].slice(0, 96);
  }

  private navigationMeshRouteScore(mesh: THREE.Mesh, origin: THREE.Vector3, target: THREE.Vector3): number {
    const center = new THREE.Vector3();
    mesh.getWorldPosition(center);
    const originDistance = Math.hypot(center.x - origin.x, center.z - origin.z);
    const targetDistance = Math.hypot(center.x - target.x, center.z - target.z);
    return Math.min(originDistance, targetDistance) + distanceToSegment2D(center, origin, target) * 0.65;
  }

  private navigationRoutePointsForMesh(mesh: THREE.Mesh, y: number): THREE.Vector3[] {
    const polygon = mesh.userData["navigationPolygon"];
    if (Array.isArray(polygon) && polygon.every((point) => point instanceof THREE.Vector2)) {
      const centroid = polygon
        .reduce((sum, point) => sum.add(point), new THREE.Vector2())
        .multiplyScalar(1 / Math.max(1, polygon.length));
      const localPoints = [
        new THREE.Vector3(centroid.x, 0, centroid.y),
        ...polygon.map((point) => point.clone().lerp(centroid, 0.28)).map((point) => new THREE.Vector3(point.x, 0, point.y)),
        ...polygon.map((point, index) => {
          const next = polygon[(index + 1) % polygon.length] ?? point;
          const midpoint = point.clone().add(next).multiplyScalar(0.5).lerp(centroid, 0.18);
          return new THREE.Vector3(midpoint.x, 0, midpoint.y);
        })
      ];
      return this.uniqueNavigationRoutePoints(
        localPoints.map((localPoint) => {
          const point = mesh.localToWorld(localPoint.clone());
          point.y = y;
          return point;
        })
      );
    }
    const halfSize = mesh.userData["navigationHalfSize"];
    if (!(halfSize instanceof THREE.Vector3)) {
      const point = new THREE.Vector3();
      mesh.getWorldPosition(point);
      point.y = y;
      return [point];
    }
    const x = Math.max(0, halfSize.x - this.collisionBodyRadius() * 1.15) * 0.72;
    const z = Math.max(0, halfSize.z - this.collisionBodyRadius() * 1.15) * 0.72;
    const xs = x > 0.05 ? [-x, 0, x] : [0];
    const zs = z > 0.05 ? [-z, 0, z] : [0];
    const localPoints = xs.flatMap((localX) => zs.map((localZ) => new THREE.Vector3(localX, 0, localZ)));
    return this.uniqueNavigationRoutePoints(
      localPoints
        .map((localPoint) => mesh.localToWorld(localPoint.clone()))
        .map((point) => {
          point.y = y;
          return point;
        })
    );
  }

  private uniqueNavigationRoutePoints(points: THREE.Vector3[]): THREE.Vector3[] {
    const seen = new Set<string>();
    return points.filter((point) => {
      const key = `${point.x.toFixed(2)}:${point.z.toFixed(2)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  private isInsideWalkZone(position: THREE.Vector3): boolean {
    return this.walkZoneMeshes.some((mesh) => this.isInsideNavigationZone(mesh, position));
  }

  private isInsidePassZone(position: THREE.Vector3): boolean {
    return this.passZoneMeshes.some((mesh) => this.isInsideNavigationZone(mesh, position));
  }

  private isPassZoneBridgeSegment(origin: THREE.Vector3, target: THREE.Vector3): boolean {
    if (this.passZoneMeshes.length === 0) {
      return false;
    }
    const midpoint = origin.clone().lerp(target, 0.5);
    return [origin, midpoint, target].some((point) =>
      this.passZoneMeshes.some((mesh) =>
        this.isInsideNavigationZoneWithPadding(mesh, point, Math.max(0.42, this.collisionBodyRadius() * 1.75))
      )
    );
  }

  private isInsideNavigationZone(mesh: THREE.Mesh, position: THREE.Vector3): boolean {
    return this.isInsideNavigationZoneWithPadding(mesh, position, this.collisionBodyRadius());
  }

  private isInsideNavigationZoneWithPadding(mesh: THREE.Mesh, position: THREE.Vector3, padding: number): boolean {
    const halfSize = mesh.userData["navigationHalfSize"];
    if (!(halfSize instanceof THREE.Vector3)) {
      return false;
    }
    const local = mesh.worldToLocal(position.clone());
    const polygon = mesh.userData["navigationPolygon"];
    if (Array.isArray(polygon) && polygon.every((point) => point instanceof THREE.Vector2)) {
      const halfHeight = typeof mesh.userData["navigationHalfHeight"] === "number" ? mesh.userData["navigationHalfHeight"] : halfSize.y;
      return (
        Math.abs(local.y) <= halfHeight + padding &&
        this.pointInNavigationPolygon(new THREE.Vector2(local.x, local.z), polygon, padding)
      );
    }
    return (
      Math.abs(local.x) <= halfSize.x + padding &&
      Math.abs(local.z) <= halfSize.z + padding
    );
  }

  private pointInNavigationPolygon(
    point: THREE.Vector2,
    polygon: readonly THREE.Vector2[],
    padding: number
  ): boolean {
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
      const a = polygon[current]!;
      const b = polygon[previous]!;
      if ((a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
        inside = !inside;
      }
      if (padding > 0 && pointToSegmentDistance(point, a, b) <= padding) {
        return true;
      }
    }
    return inside;
  }

  private canStandOnGeometryFloor(position: THREE.Vector3): boolean {
    const floorY = this.sampleGeometryFloorY(position, { maxDelta: Math.max(0.75, this.cameraHeight * 0.45) });
    if (typeof floorY !== "number") {
      return false;
    }
    const expectedFloorY = position.y - this.cameraHeight;
    return Math.abs(floorY - expectedFloorY) <= Math.max(0.45, this.cameraHeight * 0.35);
  }

  private canStandOnExplicitWalkMesh(position: THREE.Vector3): boolean {
    if (this.explicitWalkMeshes.length === 0) {
      return false;
    }
    const expectedFloorY = position.y - this.cameraHeight;
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(position.x, position.y + 1.2, position.z),
      new THREE.Vector3(0, -1, 0),
      0,
      Math.max(3.2, this.cameraHeight + 2.4)
    );
    const hit = raycaster.intersectObjects(this.explicitWalkMeshes, true).find((candidate) => {
      if (!(candidate.object instanceof THREE.Mesh) || !candidate.face) {
        return false;
      }
      const normal = candidate.face.normal.clone().transformDirection(candidate.object.matrixWorld);
      return Math.abs(normal.y) >= 0.45 && Math.abs(candidate.point.y - expectedFloorY) <= Math.max(0.45, this.cameraHeight * 0.35);
    });
    return Boolean(hit);
  }

  private snapCameraToFloor(delta = 1 / 60): void {
    const floorY = this.sampleGeometryFloorY(this.camera.position, { maxDelta: Math.max(0.28, this.cameraHeight * 0.18) });
    if (typeof floorY !== "number") {
      return;
    }
    const currentFloorY = this.camera.position.y - this.cameraHeight;
    const previousFloorY = this.stableFloorY ?? currentFloorY;
    const bumpTolerance = this.floorBumpTolerance();
    const levelDelta = floorY - previousFloorY;
    const targetFloorY = this.floorHeightTargetForSample(this.camera.position, floorY, previousFloorY);
    const nextY = targetFloorY + this.cameraHeight;
    const difference = Math.abs(nextY - this.camera.position.y);
    if (difference <= Math.max(0.62, this.cameraHeight * 0.38)) {
      const floorHeightSmoothing = this.floorHeightSmoothing();
      const smoothing = Math.abs(levelDelta) <= bumpTolerance ? floorHeightSmoothing * 2.8 : floorHeightSmoothing;
      this.camera.position.y = this.clampVerticalCameraDelta(
        this.camera.position.y,
        damp(this.camera.position.y, nextY, smoothing, delta),
        delta
      );
      this.stableFloorY = damp(previousFloorY, targetFloorY, smoothing, delta);
    } else {
      this.stableFloorY = currentFloorY;
    }
  }

  private floorBumpTolerance(): number {
    return THREE.MathUtils.clamp(
      this.controls.floorBumpTolerance ?? Math.max(0.48, this.cameraHeight * 0.18),
      0.02,
      0.8
    );
  }

  private floorHeightSmoothing(): number {
    return THREE.MathUtils.clamp(this.controls.floorHeightSmoothing ?? 0.9, 0.5, 8);
  }

  private wheelMoveSpeed(): number {
    return THREE.MathUtils.clamp(this.controls.wheelMoveSpeed ?? 1, 0.1, 4);
  }

  private clampVerticalCameraDelta(currentY: number, targetY: number, delta: number): number {
    if (delta <= 0 || Math.abs(targetY - currentY) < 0.0001) {
      return targetY;
    }
    const maxRise = Math.max(0.22, this.cameraHeight * 0.22) * delta;
    const maxDrop = Math.max(0.34, this.cameraHeight * 0.32) * delta;
    return THREE.MathUtils.clamp(targetY, currentY - maxDrop, currentY + maxRise);
  }

  private collisionBodyRadius(): number {
    return THREE.MathUtils.clamp(this.controls.collisionRadius ?? this.defaultCollisionRadius, 0.12, 0.6);
  }

  private sampleGeometryFloorY(
    position: THREE.Vector3,
    options: { maxDelta?: number; allowFallbackHit?: boolean } = {}
  ): number | undefined {
    if (this.geometryFloorMeshes.length === 0) {
      return undefined;
    }
    const expectedFloorY = position.y - this.cameraHeight;
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(position.x, position.y + 1.2, position.z),
      new THREE.Vector3(0, -1, 0),
      0,
      Math.max(3.2, this.cameraHeight + 2.4)
    );
    const hits = raycaster.intersectObjects(this.geometryFloorMeshes, true).filter((candidate) => {
      if (!(candidate.object instanceof THREE.Mesh) || !candidate.face) {
        return false;
      }
      const normal = candidate.face.normal.clone().transformDirection(candidate.object.matrixWorld);
      return Math.abs(normal.y) >= 0.45 && candidate.point.y <= position.y + 0.35;
    });
    const maxDelta = options.maxDelta ?? Math.max(0.6, this.cameraHeight * 0.35);
    const stableHit = hits
      .filter((candidate) => Math.abs(candidate.point.y - expectedFloorY) <= maxDelta)
      .sort(
        (a, b) => Math.abs(a.point.y - expectedFloorY) - Math.abs(b.point.y - expectedFloorY)
      )[0];
    const hit = stableHit ?? (options.allowFallbackHit ? hits[0] : undefined);
    return hit?.point.y;
  }

  private isSupportedFloorHeight(
    position: THREE.Vector3,
    floorY: number,
    options: { referenceFloorY?: number; sampledFloorY?: number } = {}
  ): boolean {
    const supportRadius = THREE.MathUtils.clamp(this.collisionBodyRadius() * 1.6, 0.22, 0.55);
    const tolerance = Math.max(0.08, this.floorBumpTolerance() * 0.55);
    const referenceDelta =
      typeof options.referenceFloorY === "number" ? Math.abs(floorY - options.referenceFloorY) : Number.POSITIVE_INFINITY;
    const isSmallRaisedFeature = referenceDelta <= Math.max(0.72, this.cameraHeight * 0.36);
    const centerSupported = typeof options.sampledFloorY !== "number" || Math.abs(options.sampledFloorY - floorY) <= tolerance;
    const offsets = [
      [supportRadius, 0],
      [-supportRadius, 0],
      [0, supportRadius],
      [0, -supportRadius]
    ] as const;
    let supported = 0;
    let referenceMatches = 0;
    for (const [x, z] of offsets) {
      const probe = new THREE.Vector3(position.x + x, floorY + this.cameraHeight, position.z + z);
      const sampleY = this.sampleGeometryFloorY(probe, { maxDelta: Math.max(0.35, this.cameraHeight * 0.24) });
      if (typeof sampleY !== "number") {
        continue;
      }
      if (Math.abs(sampleY - floorY) <= tolerance) {
        supported += 1;
      }
      if (
        typeof options.referenceFloorY === "number" &&
        Math.abs(sampleY - options.referenceFloorY) <= tolerance
      ) {
        referenceMatches += 1;
      }
    }
    if (supported >= 3) {
      return true;
    }
    if (isSmallRaisedFeature) {
      return false;
    }
    return centerSupported && supported >= 2 && referenceMatches <= 1;
  }

  private isWalkableHit(hit: THREE.Intersection): boolean {
    if (!(hit.object instanceof THREE.Mesh) || !hit.face) {
      return false;
    }
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const horizontalEnough = Math.abs(normal.y) >= 0.45;
    const belowEye = hit.point.y <= this.camera.position.y + 0.25;
    if (!horizontalEnough || !belowEye) {
      return false;
    }
    if (
      this.objectBelongsToCollection(hit.object, this.walkZoneMeshes) ||
      this.objectBelongsToCollection(hit.object, this.passZoneMeshes) ||
      this.objectBelongsToCollection(hit.object, this.geometryFloorMeshes)
    ) {
      return true;
    }
    if (this.geometryFloorMeshes.length === 0) {
      return true;
    }
    const probe = hit.point.clone();
    probe.y = hit.point.y + this.cameraHeight;
    const floorY = this.sampleGeometryFloorY(probe, { maxDelta: Math.max(0.3, this.cameraHeight * 0.2) });
    return typeof floorY === "number" && Math.abs(floorY - hit.point.y) <= this.floorBumpTolerance();
  }

  private objectBelongsToCollection(object: THREE.Object3D, collection: readonly THREE.Object3D[]): boolean {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (collection.includes(current)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private findWalkableHit(): THREE.Intersection | undefined {
    const hits = this.raycaster.intersectObjects(this.walkableMeshes, true);
    return hits.find((hit) => this.isWalkableHit(hit));
  }

  private findWalkableHitNearObject(hit: THREE.Intersection): THREE.Intersection | undefined {
    const horizontal = hit.point.clone().sub(this.camera.position);
    horizontal.y = 0;
    if (horizontal.lengthSq() < 0.001) {
      horizontal.set(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    }
    horizontal.normalize();
    const sideways = new THREE.Vector3(-horizontal.z, 0, horizontal.x);
    const directions = [
      new THREE.Vector3(0, 0, 0),
      horizontal.clone(),
      horizontal.clone().multiplyScalar(-1),
      sideways.clone(),
      sideways.clone().multiplyScalar(-1),
      horizontal.clone().add(sideways).normalize(),
      horizontal.clone().sub(sideways).normalize(),
      horizontal.clone().multiplyScalar(-1).add(sideways).normalize(),
      horizontal.clone().multiplyScalar(-1).sub(sideways).normalize()
    ];
    const probes = [
      new THREE.Vector3(0, 0, 0),
      ...[0.35, 0.7, 1.1, 1.55].flatMap((radius) =>
        directions.slice(1).map((direction) => direction.clone().multiplyScalar(radius))
      )
    ];
    const direction = new THREE.Vector3(0, -1, 0);
    const raycaster = new THREE.Raycaster(undefined, direction, 0, Math.max(4, this.cameraHeight + 3));
    let fallbackFloorHit: THREE.Intersection | undefined;
    for (const offset of probes) {
      const origin = hit.point.clone().add(offset);
      origin.y = Math.max(hit.point.y + 1.1, this.camera.position.y + 0.25);
      raycaster.set(origin, direction);
      const floorHit = raycaster
        .intersectObjects(this.walkableMeshes, true)
        .find((candidate) => this.isWalkableHit(candidate));
      if (floorHit) {
        fallbackFloorHit ??= floorHit;
        if (this.floorHitHasReachableTarget(floorHit)) {
          return floorHit;
        }
      }
    }
    return fallbackFloorHit;
  }

  private floorHitHasReachableTarget(floorHit: THREE.Intersection): boolean {
    const target = floorHit.point.clone();
    target.y = floorHit.point.y + this.cameraHeight;
    if (this.minBounds && this.maxBounds) {
      clampToBounds(target, this.minBounds, this.maxBounds);
    }
    const failure = this.navigationFailureDetail(target, this.camera.position);
    if (failure) {
      if (
        (failure.reason === "blocked-collision" || failure.reason === "blocked-step") &&
        this.findNavigationRoute(target, this.camera.position)
      ) {
        return true;
      }
      return Boolean(this.findReachableTargetNear(target, this.camera.position));
    }
    return !this.navigationRouteFailureDetail(target, this.camera.position) ||
      Boolean(this.findNavigationRoute(target, this.camera.position));
  }

  private findWalkableHitBeyondPortalObject(
    hit: THREE.Intersection,
    objectName: string
  ): THREE.Intersection | undefined {
    if (!(hit.object instanceof THREE.Mesh) || !isDoorwayNavigationPanel(hit.object, objectName)) {
      return undefined;
    }

    const direction = this.raycaster.ray.direction.clone().normalize();
    if (Math.abs(direction.y) > 0.75) {
      return undefined;
    }

    const baseDistance = Number.isFinite(hit.distance)
      ? hit.distance
      : this.camera.position.distanceTo(hit.point);
    const raycaster = new THREE.Raycaster(
      undefined,
      new THREE.Vector3(0, -1, 0),
      0,
      Math.max(4.5, this.cameraHeight + 3.2)
    );
    const offsets = [0.45, 0.8, 1.25, 1.8, 2.5, 3.4, 4.6, 5.8];
    let fallbackFloorHit: THREE.Intersection | undefined;
    for (const offset of offsets) {
      const probe = this.camera.position.clone().addScaledVector(direction, baseDistance + offset);
      const origin = probe.clone();
      origin.y = Math.max(this.camera.position.y + 0.3, probe.y + this.cameraHeight + 1.2);
      raycaster.set(origin, new THREE.Vector3(0, -1, 0));
      const floorHit = raycaster
        .intersectObjects(this.walkableMeshes, true)
        .find((candidate) => this.isWalkableHit(candidate));
      if (!floorHit) {
        continue;
      }
      fallbackFloorHit ??= floorHit;
      const target = floorHit.point.clone();
      target.y = floorHit.point.y + this.cameraHeight;
      if (!this.navigationFailureDetail(target, this.camera.position)) {
        return floorHit;
      }
    }
    return fallbackFloorHit;
  }

  private findProjectedWalkableHitFromObjectClick(hit: THREE.Intersection): THREE.Intersection | undefined {
    const rayDirection = this.raycaster.ray.direction.clone().normalize();
    if (Math.abs(rayDirection.y) > 0.78) {
      return undefined;
    }
    const baseDistance = Number.isFinite(hit.distance)
      ? hit.distance
      : this.camera.position.distanceTo(hit.point);
    const right = new THREE.Vector3().crossVectors(rayDirection, new THREE.Vector3(0, 1, 0)).normalize();
    if (right.lengthSq() < 0.001) {
      right.set(1, 0, 0);
    }
    const downRay = new THREE.Raycaster(
      undefined,
      new THREE.Vector3(0, -1, 0),
      0,
      Math.max(5, this.cameraHeight + 3.4)
    );
    const depthOffsets = [0, 0.35, 0.75, 1.25, 1.9, 2.7, 3.8];
    const sideOffsets = [0, -0.28, 0.28, -0.55, 0.55];
    let fallbackFloorHit: THREE.Intersection | undefined;
    for (const depthOffset of depthOffsets) {
      const rayPoint = this.camera.position.clone().addScaledVector(rayDirection, baseDistance + depthOffset);
      for (const sideOffset of sideOffsets) {
        const origin = rayPoint.clone().addScaledVector(right, sideOffset);
        origin.y = Math.max(this.camera.position.y + 0.35, origin.y + this.cameraHeight + 1.25);
        downRay.set(origin, new THREE.Vector3(0, -1, 0));
        const floorHit = downRay
          .intersectObjects(this.walkableMeshes, true)
          .find((candidate) => this.isWalkableHit(candidate));
        if (!floorHit) {
          continue;
        }
        fallbackFloorHit ??= floorHit;
        if (this.floorHitHasReachableTarget(floorHit)) {
          return floorHit;
        }
      }
    }
    return fallbackFloorHit;
  }

  private tryMoveToFloorHit(
    floorHit: THREE.Intersection,
    event: PointerEvent,
    sourceObjectName?: string
  ): boolean {
    const nextTarget = floorHit.point.clone();
    nextTarget.y = floorHit.point.y + this.cameraHeight;
    if (this.minBounds && this.maxBounds) {
      clampToBounds(nextTarget, this.minBounds, this.maxBounds);
    }
    const failureDetail = this.navigationFailureDetail(nextTarget, this.camera.position);
    if (failureDetail) {
      if (failureDetail.reason === "blocked-collision" || failureDetail.reason === "blocked-step") {
        const navigationRoute = this.findNavigationRoute(nextTarget, this.camera.position);
        if (navigationRoute) {
          this.startClickRoute(navigationRoute, floorHit.point);
          return true;
        }
      }
      const recoveredTarget = this.findReachableTargetNear(nextTarget, this.camera.position);
      if (recoveredTarget) {
        this.startRecoveredNavigationTarget(recoveredTarget);
        return true;
      }
      const approachTarget = this.findReachableApproachTarget(nextTarget, this.camera.position);
      if (approachTarget) {
        this.startRecoveredNavigationTarget(approachTarget);
        return true;
      }
      this.emitNavigationFailure(
        failureDetail.reason,
        event,
        failureDetail.point ?? floorHit.point,
        sourceObjectName,
        failureDetail.blockerName,
        failureDetail.blockerKind,
        nextTarget
      );
      return true;
    }
    const routeFailureDetail = this.navigationRouteFailureDetail(nextTarget, this.camera.position);
    if (routeFailureDetail) {
      const navigationRoute = this.findNavigationRoute(nextTarget, this.camera.position);
      if (navigationRoute) {
        this.startClickRoute(navigationRoute, floorHit.point);
        return true;
      }
      const recoveredTarget = this.findReachableTargetNear(nextTarget, this.camera.position);
      if (recoveredTarget) {
        this.startRecoveredNavigationTarget(recoveredTarget);
        return true;
      }
      const approachTarget = this.findReachableApproachTarget(nextTarget, this.camera.position);
      if (approachTarget) {
        this.startRecoveredNavigationTarget(approachTarget);
        return true;
      }
      const bestFailureDetail = this.routeSearchFailureDetail ?? routeFailureDetail;
      const reason =
        bestFailureDetail.reason === "blocked-step" || bestFailureDetail.reason === "blocked-collision"
          ? bestFailureDetail.reason
          : "route-not-found";
      this.emitNavigationFailure(
        reason,
        event,
        bestFailureDetail.point ?? floorHit.point,
        sourceObjectName,
        bestFailureDetail.blockerName,
        bestFailureDetail.blockerKind,
        nextTarget
      );
      return true;
    }
    this.startClickMove(nextTarget, floorHit.point);
    return true;
  }

  private startClickMove(target: THREE.Vector3, markerPoint: THREE.Vector3): void {
    this.moveTarget = this.normalizeClickTargetHeight(target, this.camera.position);
    this.movePath = [];
    this.clickMoveVelocity = 0;
    this.cameraTween = undefined;
    this.moveMarker.visible = true;
    this.moveMarker.position.copy(markerPoint);
    this.moveMarker.position.y += 0.035;
  }

  private startClickRoute(route: THREE.Vector3[], markerPoint: THREE.Vector3): void {
    const [firstWaypoint, ...remainingWaypoints] = this.normalizeClickRouteHeights(route);
    if (!firstWaypoint) {
      return;
    }
    this.moveTarget = firstWaypoint;
    this.movePath = remainingWaypoints;
    this.clickMoveVelocity = 0;
    this.cameraTween = undefined;
    this.moveMarker.visible = true;
    this.moveMarker.position.copy(markerPoint);
    this.moveMarker.position.y += 0.035;
  }

  private floorMarkerPointForTarget(target: THREE.Vector3): THREE.Vector3 {
    const markerPoint = target.clone();
    const floorY = this.sampleGeometryFloorY(target, {
      maxDelta: Math.max(
        this.controls.maxStepDown ?? this.maxStepDown,
        this.controls.maxStepUp ?? this.maxStepUp,
        this.cameraHeight * 0.5
      )
    });
    markerPoint.y = typeof floorY === "number" ? floorY : target.y - this.cameraHeight;
    return markerPoint;
  }

  private startRecoveredNavigationTarget(recoveredTarget: RecoveredNavigationTarget): void {
    const markerPoint = this.floorMarkerPointForTarget(recoveredTarget.target);
    if (recoveredTarget.route) {
      this.startClickRoute(recoveredTarget.route, markerPoint);
    } else {
      this.startClickMove(recoveredTarget.target, markerPoint);
    }
  }

  private normalizeClickRouteHeights(route: THREE.Vector3[]): THREE.Vector3[] {
    const normalized: THREE.Vector3[] = [];
    let origin = this.camera.position;
    route.forEach((waypoint, index) => {
      const next = this.normalizeClickTargetHeight(waypoint, origin, {
        intermediateRoutePoint: index < route.length - 1
      });
      normalized.push(next);
      origin = next;
    });
    return normalized;
  }

  private normalizeClickTargetHeight(
    target: THREE.Vector3,
    origin: THREE.Vector3,
    options: { intermediateRoutePoint?: boolean } = {}
  ): THREE.Vector3 {
    if (this.geometryFloorMeshes.length === 0) {
      return target.clone();
    }
    const next = target.clone();
    const floorY = this.sampleGeometryFloorY(next, {
      maxDelta: Math.max(
        this.controls.maxStepDown ?? this.maxStepDown,
        this.controls.maxStepUp ?? this.maxStepUp,
        this.cameraHeight * 0.5
      )
    });
    const targetFloorY = typeof floorY === "number" ? floorY : next.y - this.cameraHeight;
    const originFloorY = this.stableFloorY ?? origin.y - this.cameraHeight;
    const bumpTolerance = this.floorBumpTolerance();
    const floorDelta = targetFloorY - originFloorY;
    let resolvedFloorY = Math.abs(floorDelta) <= bumpTolerance * 1.5 ? originFloorY : targetFloorY;
    if (resolvedFloorY !== originFloorY) {
      const supportedLevel = this.isSupportedFloorHeight(next, targetFloorY, { referenceFloorY: originFloorY });
      const intermediateStepLikeChange =
        options.intermediateRoutePoint &&
        Math.abs(floorDelta) <= Math.max(this.controls.maxStepUp ?? this.maxStepUp, bumpTolerance * 2.2);
      if (!supportedLevel || intermediateStepLikeChange) {
        resolvedFloorY = originFloorY;
      }
    }
    next.y = resolvedFloorY + this.cameraHeight;
    return next;
  }

  private findReachableTargetNear(
    target: THREE.Vector3,
    origin: THREE.Vector3
  ): RecoveredNavigationTarget | undefined {
    const candidates = this.nearbyNavigationCandidates(target);
    for (const candidate of candidates) {
      const reachable = this.reachableNavigationTargetForCandidate(candidate, origin);
      if (reachable) {
        return reachable;
      }
    }
    return undefined;
  }

  private findReachableApproachTarget(
    target: THREE.Vector3,
    origin: THREE.Vector3
  ): RecoveredNavigationTarget | undefined {
    const flatDelta = target.clone().sub(origin);
    flatDelta.y = 0;
    const distance = flatDelta.length();
    if (distance < Math.max(0.9, this.collisionBodyRadius() * 3.5)) {
      return undefined;
    }

    for (const fraction of [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34, 0.26, 0.18]) {
      const candidate = origin.clone().add(flatDelta.clone().multiplyScalar(fraction));
      candidate.y = target.y;
      const floorY = this.sampleGeometryFloorY(candidate, {
        maxDelta: Math.max(
          this.controls.maxStepDown ?? this.maxStepDown,
          this.controls.maxStepUp ?? this.maxStepUp,
          this.cameraHeight * 0.5
        )
      });
      if (typeof floorY === "number") {
        candidate.y = floorY + this.cameraHeight;
      }
      const reachable = this.reachableNavigationTargetForCandidate(candidate, origin);
      if (reachable) {
        return reachable;
      }
    }
    return undefined;
  }

  private reachableNavigationTargetForCandidate(
    candidate: THREE.Vector3,
    origin: THREE.Vector3
  ): RecoveredNavigationTarget | undefined {
    const directFailure = this.navigationFailureDetail(candidate, origin);
    if (directFailure) {
      if (directFailure.reason === "blocked-collision" || directFailure.reason === "blocked-step") {
        const route = this.findNavigationRoute(candidate, origin);
        if (route) {
          return { target: candidate, route };
        }
      }
      return undefined;
    }
    if (!this.navigationRouteFailureDetail(candidate, origin)) {
      return { target: candidate };
    }
    const route = this.findNavigationRoute(candidate, origin);
    return route ? { target: candidate, route } : undefined;
  }

  private nearbyNavigationCandidates(target: THREE.Vector3): THREE.Vector3[] {
    const candidates: THREE.Vector3[] = [];
    const seen = new Set<string>();
    const addCandidate = (candidate: THREE.Vector3) => {
      const probed = this.navigationProbePosition(candidate);
      if (this.minBounds && this.maxBounds) {
        clampToBounds(probed, this.minBounds, this.maxBounds);
      }
      const key = `${probed.x.toFixed(2)}:${probed.y.toFixed(2)}:${probed.z.toFixed(2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(probed);
      }
    };

    addCandidate(target.clone());
    const snapDistance = Math.max(2.8, this.collisionBodyRadius() * 8);
    [...this.walkZoneMeshes, ...this.passZoneMeshes]
      .map((mesh) => ({
        mesh,
        distance: this.navigationMeshDistanceToPoint(mesh, target)
      }))
      .filter((entry) => entry.distance <= snapDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8)
      .forEach(({ mesh }) => {
        const snapped = this.closestPointOnNavigationMesh(mesh, target);
        if (snapped) {
          addCandidate(snapped);
        }
        addCandidate(this.navigationMeshCenter(mesh, target.y));
      });

    const rings = [0.22, 0.4, 0.65, 0.95, 1.35, 1.8, 2.35];
    const slices = 16;
    for (const radius of rings) {
      for (let index = 0; index < slices; index += 1) {
        const angle = (index / slices) * Math.PI * 2;
        addCandidate(
          new THREE.Vector3(
            target.x + Math.cos(angle) * radius,
            target.y,
            target.z + Math.sin(angle) * radius
          )
        );
      }
    }

    return candidates.sort((a, b) => a.distanceToSquared(target) - b.distanceToSquared(target));
  }

  private closestPointOnNavigationMesh(mesh: THREE.Mesh, target: THREE.Vector3): THREE.Vector3 | undefined {
    const halfSize = mesh.userData["navigationHalfSize"];
    if (!(halfSize instanceof THREE.Vector3)) {
      return undefined;
    }
    const local = mesh.worldToLocal(target.clone());
    const polygon = mesh.userData["navigationPolygon"];
    let closestLocal: THREE.Vector3;
    if (Array.isArray(polygon) && polygon.every((point) => point instanceof THREE.Vector2)) {
      const point = new THREE.Vector2(local.x, local.z);
      const closest = this.pointInNavigationPolygon(point, polygon, 0)
        ? point
        : closestPointOnPolygon2D(point, polygon);
      closestLocal = new THREE.Vector3(closest.x, local.y, closest.y);
    } else {
      closestLocal = new THREE.Vector3(
        THREE.MathUtils.clamp(local.x, -halfSize.x, halfSize.x),
        local.y,
        THREE.MathUtils.clamp(local.z, -halfSize.z, halfSize.z)
      );
    }
    const world = mesh.localToWorld(closestLocal);
    world.y = target.y;
    return world;
  }

  private navigationFailureMessage(
    reason: NavigationFailureReason,
    objectName?: string,
    blockerName?: string,
    blockerKind?: CollisionBlocker["kind"]
  ): string {
    if (reason === "outside-bounds") {
      return "Move target is outside the navigation bounds.";
    }
    if (reason === "outside-walk-zone") {
      return "Move target is outside the authored walk zone.";
    }
    if (reason === "route-not-found") {
      return blockerName
        ? `No connected walk/pass route reaches the clicked floor point because ${blockerName} blocks the route.`
        : "No connected walk/pass route reaches the clicked floor point.";
    }
    if (reason === "blocked-step") {
      return "The route crosses a height change larger than the configured step limits.";
    }
    if (reason === "blocked-collision") {
      if (blockerName && blockerKind === "authored") {
        return `The route hits a Studio block zone: ${blockerName}.`;
      }
      if (blockerName && blockerKind === "named") {
        return `The route hits a model object marked as collision: ${blockerName}.`;
      }
      if (blockerName && blockerKind === "inferred") {
        return `The route hits a wall-like model object: ${blockerName}.`;
      }
      return blockerName
        ? `The route is blocked by collision geometry: ${blockerName}.`
        : "The route is blocked by collision geometry near the clicked spot.";
    }
    return objectName
      ? `Clicked ${objectName}, but no walkable floor was found there.`
      : "No walkable floor was found at the clicked point.";
  }

  private navigationRepairAction(
    reason: NavigationFailureReason,
    blockerKind?: CollisionBlocker["kind"]
  ): NavigationRepairAction {
    if (reason === "outside-walk-zone" || reason === "no-walkable-hit") {
      return "add-walk-zone";
    }
    if (reason === "route-not-found") {
      return "add-door-pass";
    }
    if (reason === "blocked-step") {
      return "tune-steps";
    }
    if (reason === "blocked-collision") {
      return blockerKind === "authored" ? "adjust-blocker" : "add-door-pass";
    }
    return "inspect-click";
  }

  private navigationRepairHint(
    reason: NavigationFailureReason,
    blockerKind?: CollisionBlocker["kind"],
    bodyRadius = this.collisionBodyRadius()
  ): string {
    if (reason === "outside-bounds") {
      return "In Studio, expand the navigation bounds or add a closer view before testing this click.";
    }
    if (reason === "outside-walk-zone") {
      return "Add a walk patch on this floor area if users should be allowed to stand there.";
    }
    if (reason === "route-not-found") {
      return "Add or expand a door pass between the current walk island and the clicked room.";
    }
    if (reason === "blocked-step") {
      return "If this is a stair or threshold, tune Step Up and Step Down or add a cleaner stair walk patch.";
    }
    if (reason === "blocked-collision") {
      if (blockerKind === "authored") {
        return "Resize, split, or remove the Studio block zone around the opening.";
      }
      if (blockerKind === "named") {
        return `Change the matched object role, add a door pass if the opening is valid, or reduce Body Radius from ${bodyRadius.toFixed(2)} if the doorway is narrow.`;
      }
      return `Add a door pass through the opening, reduce Body Radius from ${bodyRadius.toFixed(2)} if the doorway is narrow, or mark the detected object as ignored if it is not a wall.`;
    }
    return "Click an exposed floor surface, or add a walk patch in Studio if the floor is not detected.";
  }

  private emitNavigationFailure(
    reason: NavigationFailureReason,
    event: PointerEvent,
    point?: THREE.Vector3,
    objectName?: string,
    blockerName?: string,
    blockerKind?: CollisionBlocker["kind"],
    targetPoint?: THREE.Vector3
  ): void {
    this.options.onNavigationFailure?.({
      reason,
      message: this.navigationFailureMessage(reason, objectName, blockerName, blockerKind),
      repairHint: this.navigationRepairHint(reason, blockerKind),
      repairAction: this.navigationRepairAction(reason, blockerKind),
      ...(point ? { point: [point.x, point.y, point.z] } : {}),
      ...(targetPoint ? { targetPoint: [targetPoint.x, targetPoint.y, targetPoint.z] } : {}),
      cameraPosition: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      bodyRadius: this.collisionBodyRadius(),
      ...(objectName ? { objectName } : {}),
      ...(blockerName ? { blockerName } : {}),
      ...(blockerKind ? { blockerKind } : {}),
      screen: {
        x: event.clientX,
        y: event.clientY
      }
    });
  }

  private setPointerFromEvent(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.renderer.domElement.focus();
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
    this.lastPointer = { x: event.clientX, y: event.clientY };
    if (this.controls.enabled && this.controls.dragLook && (event.button === 2 || event.pointerType === "touch")) {
      this.beginDragLook();
    } else {
      this.draggingLook = false;
    }
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.lastPointer) {
      return;
    }

    if (!this.draggingLook && this.pointerDown) {
      const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      if (moved > 4) {
        if (this.controls.enabled && this.controls.dragLook) {
          this.beginDragLook();
        }
      }
    }

    if (!this.draggingLook) {
      return;
    }

    const dx = event.clientX - this.lastPointer.x;
    const dy = event.clientY - this.lastPointer.y;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.yaw -= dx * this.controls.lookSensitivityX;
    this.pitch -= dy * this.controls.lookSensitivityY;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.15, 1.15);
  };

  private beginDragLook(): void {
    this.draggingLook = true;
    this.cameraTween = undefined;
    this.cancelClickMove();
  }

  private handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = undefined;
    this.draggingLook = false;
    this.lastPointer = undefined;
    if (!down) {
      return;
    }
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    const elapsed = performance.now() - down.time;
    if (moved < this.controls.clickMoveThresholdPx && elapsed < 450) {
      this.handleTap(event);
    }
  };

  private handleTap(event: PointerEvent): void {
    if (!this.controls.enabled || !this.controls.clickToMove) {
      return;
    }
    this.setPointerFromEvent(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hotspotIntersections = this.raycaster.intersectObjects(
      this.hotspots.map((item) => item.sprite),
      false
    );
    const hotspotHit = hotspotIntersections[0];
    if (hotspotHit) {
      const binding = this.hotspots.find((item) => item.sprite === hotspotHit.object);
      if (binding) {
        if (binding.interaction.kind === "hotspot") {
          this.options.onHotspot?.({
            interaction: binding.interaction,
            screen: {
              x: event.clientX,
              y: event.clientY
            }
          });
        } else if (binding.interaction.kind === "link") {
          this.openLink(binding.interaction);
        } else {
          this.toggleObjectInteraction(binding.interaction);
        }
        return;
      }
    }

    const floorHit = this.findWalkableHit();
    if (floorHit) {
      this.tryMoveToFloorHit(floorHit, event);
      return;
    }

    const objectHit = this.raycaster.intersectObjects(this.pickableMeshes, true)[0];
    if (objectHit && objectHit.object instanceof THREE.Mesh) {
      const objectName = objectHit.object.name || objectHit.object.parent?.name || "Object";
      const portalFloorHit = this.findWalkableHitBeyondPortalObject(objectHit, objectName);
      if (portalFloorHit && this.tryMoveToFloorHit(portalFloorHit, event, objectName)) {
        return;
      }
      const projectedFloorHit = this.findProjectedWalkableHitFromObjectClick(objectHit);
      if (projectedFloorHit && this.tryMoveToFloorHit(projectedFloorHit, event, objectName)) {
        return;
      }
      const nearbyFloorHit = this.findWalkableHitNearObject(objectHit);
      if (nearbyFloorHit && this.tryMoveToFloorHit(nearbyFloorHit, event, objectName)) {
        return;
      }
      this.emitNavigationFailure("no-walkable-hit", event, objectHit.point, objectName);
      this.options.onObjectPick?.({
        objectName,
        materialNames: this.materialNames(objectHit.object.material),
        point: [objectHit.point.x, objectHit.point.y, objectHit.point.z],
        screen: {
          x: event.clientX,
          y: event.clientY
        }
      });
      return;
    }
    this.emitNavigationFailure("no-walkable-hit", event);
  }

  private materialNames(material: THREE.Material | THREE.Material[]): string[] {
    const materials = Array.isArray(material) ? material : [material];
    return materials.map((item) => item.name).filter((name) => name.trim().length > 0);
  }

  private openLink(interaction: LinkInteraction): void {
    if (interaction.openInNewTab === false) {
      window.location.href = interaction.url;
      return;
    }
    window.open(interaction.url, "_blank", "noopener,noreferrer");
  }

  private toggleObjectInteraction(interaction: ObjectToggleInteraction): void {
    const targets = this.findObjectToggleTargets(interaction);
    if (targets.length === 0) {
      return;
    }
    const currentState = this.objectToggleStates.get(interaction.id) ?? targets.some((target) => this.isObjectRuntimeVisible(target));
    const nextState = !currentState;
    this.objectToggleStates.set(interaction.id, nextState);
    targets.forEach((target) => {
      this.setObjectRuntimeVisibility(target, nextState);
    });
  }

  private setObjectToggleVisibility(interaction: ObjectToggleInteraction, visible: boolean): void {
    this.findObjectToggleTargets(interaction).forEach((target) => {
      this.setObjectRuntimeVisibility(target, visible);
    });
  }

  private findObjectToggleTargets(interaction: ObjectToggleInteraction): THREE.Object3D[] {
    const names = new Set<string>();
    if (interaction.targetObjectName) {
      names.add(interaction.targetObjectName);
    }
    if (interaction.targetObjectId) {
      names.add(interaction.targetObjectId);
      const override = this.objectOverrides.get(interaction.targetObjectId);
      if (override?.id) {
        names.add(override.id);
      }
      if (override?.name) {
        names.add(override.name);
      }
    }
    if (names.size === 0) {
      return [];
    }

    const normalizedNames = [...names].map(normalizedObjectOverrideName).filter((name) => name.length >= 4);
    const targets: THREE.Object3D[] = [];
    this.scene.traverse((node) => {
      if (this.objectMatchesToggleTarget(node, names, normalizedNames)) {
        targets.push(node);
      }
    });
    return uniqueObjectList(targets);
  }

  private objectMatchesToggleTarget(
    node: THREE.Object3D,
    exactNames: ReadonlySet<string>,
    normalizedNames: readonly string[]
  ): boolean {
    const override = this.objectOverrideForNode(node);
    const directNames = [
      node.name,
      typeof node.userData["name"] === "string" ? node.userData["name"] : "",
      override?.id ?? "",
      override?.name ?? ""
    ].filter((name) => name.trim().length > 0);
    if (directNames.some((name) => exactNames.has(name))) {
      return true;
    }

    const sceneNames = [node.name, node.parent?.name ?? "", `${node.userData["name"] ?? ""}`]
      .map(normalizedObjectOverrideName)
      .filter((name) => name.length >= 4);
    if (sceneNames.length === 0 || normalizedNames.length === 0) {
      return false;
    }

    return normalizedNames.some((targetName) =>
      sceneNames.some(
        (sceneName) =>
          sceneName === targetName ||
          (targetName.length >= 4 && sceneName.includes(targetName)) ||
          (sceneName.length >= 4 && targetName.includes(sceneName))
      )
    );
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.controls.enabled) {
      return;
    }
    event.preventDefault();
    this.renderer.domElement.focus();
    this.cameraTween = undefined;
    this.cancelClickMove();
    const intent = -Math.sign(event.deltaY || 0);
    const wheelMoveSpeed = this.wheelMoveSpeed();
    const impulse = THREE.MathUtils.clamp(Math.abs(event.deltaY) * 0.035 * wheelMoveSpeed, 0.25, 3.2 * wheelMoveSpeed);
    const maxVelocity = 5.5 * wheelMoveSpeed;
    this.wheelVelocity = THREE.MathUtils.clamp(this.wheelVelocity + intent * impulse, -maxVelocity, maxVelocity);
  };

  private resize = (): void => {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const selectedQuality = this.manifest.qualityProfiles.find((item) => item.id === this.quality);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, selectedQuality?.maxPixelRatio ?? 1.5));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private installEvents(): void {
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.addEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.addEventListener("contextmenu", this.handleContextMenu);
    this.renderer.domElement.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private uninstallEvents(): void {
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.removeEventListener("contextmenu", this.handleContextMenu);
    this.renderer.domElement.removeEventListener("wheel", this.handleWheel);
  }

  private emitProgress(progress: LoadingProgress): void {
    this.options.onProgress?.(progress);
  }
}

function distanceToSegment2D(point: THREE.Vector3, start: THREE.Vector3, end: THREE.Vector3): number {
  const segmentX = end.x - start.x;
  const segmentZ = end.z - start.z;
  const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
  if (segmentLengthSq < 0.0001) {
    return Math.hypot(point.x - start.x, point.z - start.z);
  }
  const t = THREE.MathUtils.clamp(
    ((point.x - start.x) * segmentX + (point.z - start.z) * segmentZ) / segmentLengthSq,
    0,
    1
  );
  const closestX = start.x + segmentX * t;
  const closestZ = start.z + segmentZ * t;
  return Math.hypot(point.x - closestX, point.z - closestZ);
}

function segmentIntersectsInflatedBox2D(
  start: THREE.Vector3,
  end: THREE.Vector3,
  box: THREE.Box3,
  padding: number
): boolean {
  const minX = box.min.x - padding;
  const maxX = box.max.x + padding;
  const minZ = box.min.z - padding;
  const maxZ = box.max.z + padding;
  let minT = 0;
  let maxT = 1;

  const clipAxis = (startValue: number, endValue: number, minValue: number, maxValue: number): boolean => {
    const delta = endValue - startValue;
    if (Math.abs(delta) < 0.000001) {
      return startValue >= minValue && startValue <= maxValue;
    }
    let axisMinT = (minValue - startValue) / delta;
    let axisMaxT = (maxValue - startValue) / delta;
    if (axisMinT > axisMaxT) {
      [axisMinT, axisMaxT] = [axisMaxT, axisMinT];
    }
    minT = Math.max(minT, axisMinT);
    maxT = Math.min(maxT, axisMaxT);
    return minT <= maxT;
  };

  return clipAxis(start.x, end.x, minX, maxX) && clipAxis(start.z, end.z, minZ, maxZ);
}

function pointInsideInflatedBox2D(point: THREE.Vector3, box: THREE.Box3, padding: number): boolean {
  return (
    point.x >= box.min.x - padding &&
    point.x <= box.max.x + padding &&
    point.z >= box.min.z - padding &&
    point.z <= box.max.z + padding
  );
}

function distanceToInflatedBox2D(point: THREE.Vector3, box: THREE.Box3, padding: number): number {
  const minX = box.min.x - padding;
  const maxX = box.max.x + padding;
  const minZ = box.min.z - padding;
  const maxZ = box.max.z + padding;
  const dx = point.x < minX ? minX - point.x : point.x > maxX ? point.x - maxX : 0;
  const dz = point.z < minZ ? minZ - point.z : point.z > maxZ ? point.z - maxZ : 0;
  return Math.hypot(dx, dz);
}

function pointToSegmentDistance(point: THREE.Vector2, start: THREE.Vector2, end: THREE.Vector2): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSq < 0.0001) {
    return point.distanceTo(start);
  }
  const t = THREE.MathUtils.clamp(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / segmentLengthSq,
    0,
    1
  );
  return Math.hypot(point.x - (start.x + segmentX * t), point.y - (start.y + segmentY * t));
}

function closestPointOnSegment2D(point: THREE.Vector2, start: THREE.Vector2, end: THREE.Vector2): THREE.Vector2 {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
  if (segmentLengthSq < 0.0001) {
    return start.clone();
  }
  const t = THREE.MathUtils.clamp(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / segmentLengthSq,
    0,
    1
  );
  return new THREE.Vector2(start.x + segmentX * t, start.y + segmentY * t);
}

function closestPointOnPolygon2D(point: THREE.Vector2, polygon: readonly THREE.Vector2[]): THREE.Vector2 {
  let closest = polygon[0]?.clone() ?? point.clone();
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[previous];
    const b = polygon[current];
    if (!a || !b) {
      continue;
    }
    const candidate = closestPointOnSegment2D(point, a, b);
    const distance = candidate.distanceToSquared(point);
    if (distance < bestDistance) {
      bestDistance = distance;
      closest = candidate;
    }
  }
  return closest;
}

function normalizedObjectOverrideName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueObjectList<T extends THREE.Object3D>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isGeneratedViewerNavigationZone(zone: NavigationZone): boolean {
  if (zone.source === "generated") {
    return true;
  }
  if (zone.source === "authored") {
    return false;
  }
  const id = zone.id;
  return (
    id === "walk-main" ||
    id.startsWith("walk-node-") ||
    id.startsWith("walk-auto-view-") ||
    id.startsWith("pass-node-") ||
    id.startsWith("pass-auto-") ||
    id.startsWith("pass-bridge-") ||
    id.startsWith("walk-Object") ||
    id.startsWith("pass-Object")
  );
}

function isLikelyNonWalkSurfaceName(name: string): boolean {
  return [
    "plant",
    "tree",
    "chair",
    "table",
    "sofa",
    "couch",
    "bed",
    "cabinet",
    "cupboard",
    "wardrobe",
    "counter",
    "worktop",
    "shelf",
    "tv",
    "screen",
    "monitor",
    "appliance",
    "fridge",
    "oven",
    "sink",
    "toilet",
    "vanity",
    "decor",
    "vase",
    "lamp",
    "light",
    "fan",
    "door",
    "window",
    "glass",
    "wall",
    "partition",
    "ceiling",
    "roof"
  ].some((keyword) => name.includes(keyword));
}

function isPortalLikeObject(mesh: THREE.Mesh, objectName: string): boolean {
  const parentName = mesh.parent?.name ?? "";
  const materialNames = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    .map((material) => material.name)
    .join(" ");
  const descriptor = `${objectName} ${mesh.name} ${parentName} ${materialNames}`.toLowerCase();
  return /(^|[^a-z])(door|doorway|opening|entrance|entry|passage|corridor|balcony|terrace|patio|slider|sliding)([^a-z]|$)/.test(
    descriptor
  );
}

function isDoorwayNavigationPanel(mesh: THREE.Mesh, objectName: string): boolean {
  if (isPortalLikeObject(mesh, objectName)) {
    return true;
  }
  const parentName = mesh.parent?.name ?? "";
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const materialNames = materials.map((material) => material.name).join(" ");
  const descriptor = `${objectName} ${mesh.name} ${parentName} ${materialNames}`.toLowerCase();
  const panelNamedAsOpening =
    /(^|[^a-z])(glass|glazing|pane|partition|screen|shutter|gate|french|sliding)([^a-z]|$)/.test(descriptor) &&
    /(^|[^a-z])(door|opening|entry|entrance|balcony|terrace|patio|passage|corridor)([^a-z]|$)/.test(descriptor);
  const materialLooksTransparent = materials.some(
    (material) =>
      material.transparent ||
      ("opacity" in material && typeof material.opacity === "number" && material.opacity < 0.82)
  );
  return panelNamedAsOpening || (materialLooksTransparent && isPortalLikeObject(mesh, descriptor));
}

function isExplicitPortalCollision(name: string): boolean {
  return /(^|[^a-z])(collision|collider|blocker|blocking|occluder)([^a-z]|$)/.test(name.toLowerCase());
}

export function createInteractionFilter(kind: SceneInteraction["kind"]) {
  return (interaction: SceneInteraction) => interaction.kind === kind;
}
