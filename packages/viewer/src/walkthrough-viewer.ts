import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
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
  VideoTextureInteraction
} from "@walkthrough/scene-schema";
import { createDemoScene } from "./demo-scene";
import { createHotspotSprite } from "./hotspot-sprite";
import { clampToBounds, damp, dampAngle, easeOutCubic, toVector3 } from "./math";
import { createMoveMarker } from "./marker";
import type {
  LoadingProgress,
  NavigationFailureReason,
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
  baseVisible: boolean;
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
  private readonly ktx2Loader = new KTX2Loader();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly moveMarker = createMoveMarker();
  private readonly modelScale: number;
  private readonly manifestScale: number;
  private readonly cameraHeight: number;
  private readonly hotspots: HotspotBinding[] = [];
  private readonly managedTextures: ManagedTexture[] = [];
  private readonly keys = new Set<string>();
  private readonly collisionRadius = 0.28;
  private readonly maxStepUp = 0.42;
  private readonly maxStepDown = 0.78;
  private readonly materialOverrides = new Map<string, MaterialOverride>();
  private readonly materialLightMaps: THREE.Texture[] = [];
  private readonly materialTextures: THREE.Texture[] = [];
  private readonly objectOverrides = new Map<string, ObjectOverride>();
  private readonly objectToggleStates = new Map<string, boolean>();
  private readonly topViewHiddenObjects: TopViewHiddenObject[] = [];
  private controls: SceneControlsDocument["movement"] = {
    enabled: true,
    clickToMove: true,
    keyboard: true,
    dragLook: true,
    moveSpeed: 3.8,
    clickMoveSpeed: 1.2,
    maxStepUp: 0.42,
    maxStepDown: 0.78,
    floorBumpTolerance: 0.24,
    floorHeightSmoothing: 1.65,
    lookSensitivityX: 0.004,
    lookSensitivityY: 0.0035,
    clickMoveThresholdPx: 8
  };

  private floorMeshes: THREE.Object3D[] = [];
  private geometryFloorMeshes: THREE.Object3D[] = [];
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
    this.manifestScale = this.manifest.rendering?.modelScale ? 1 : legacyScale;
    this.cameraHeight = this.manifest.navigation.cameraHeight * this.manifestScale;

    const selectedQuality = this.manifest.qualityProfiles.find((item) => item.id === this.quality);
    this.renderer = new THREE.WebGLRenderer({
      antialias: selectedQuality?.antialias ?? true,
      alpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = selectedQuality?.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor("#d8dde2", 1);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "3D walkthrough viewport");
    this.renderer.domElement.className = "walkthrough-canvas";
    this.container.appendChild(this.renderer.domElement);
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
    this.moveTarget = undefined;
    this.movePath = [];
    this.moveMarker.visible = false;
    this.stableFloorY = undefined;
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
    this.geometryFloorMeshes = fallbackFloors.length > 0 ? fallbackFloors : this.collectFloorMeshes(root);
    if (zones.walkMeshes.length > 0) {
      this.floorMeshes = zones.walkMeshes;
      this.walkableMeshes = [...zones.walkMeshes, ...zones.passMeshes];
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
    const materialNames =
      object instanceof THREE.Mesh
        ? (Array.isArray(object.material) ? object.material : [object.material]).map((material) => material.name).join(" ")
        : "";
    const descriptor = `${object.name} ${object.parent?.name ?? ""} ${object.userData["name"] ?? ""} ${materialNames}`.toLowerCase();
    const hideInTopView =
      /(^|[^a-z])(ceiling|false-ceiling|dropped-ceiling|roof|roofing|lid|cover)([^a-z]|$)/.test(descriptor) &&
      !/(^|[^a-z])(fan|light|lamp|fixture|chandelier|downlight|spotlight)([^a-z]|$)/.test(descriptor);
    if (!hideInTopView || this.topViewHiddenObjects.some((entry) => entry.object === object)) {
      return;
    }
    this.topViewHiddenObjects.push({
      object,
      baseVisible: object.visible
    });
  }

  private applyViewObjectVisibility(view: SceneView | undefined): void {
    const hideTopShell = view?.kind === "top";
    this.topViewHiddenObjects.forEach((entry) => {
      entry.object.visible = hideTopShell ? false : entry.baseVisible;
    });
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
    const byName = this.objectOverrides.get(node.name);
    const override = byName;
    if (!override) {
      return;
    }
    node.visible = override.visible;
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
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) {
        return;
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const area = size.x * size.z;
      const name = `${node.name} ${node.parent?.name ?? ""} ${node.userData["name"] ?? ""}`.toLowerCase();
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

  private collectPickableMeshes(root: THREE.Object3D): THREE.Object3D[] {
    const floorNames = this.manifest.navigation.floorMeshNames.map((name) => name.toLowerCase());
    const meshes: THREE.Object3D[] = [];
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
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
      if (node instanceof THREE.Mesh) {
        meshes.add(node);
      }
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
      const name = node.name.toLowerCase();
      if (floorNames.some((floorName) => name.includes(floorName))) {
        return;
      }
      const collisionSearchName = `${node.name} ${node.parent?.name ?? ""} ${node.userData["name"] ?? ""}`.toLowerCase();
      if (ignoredCollisionNames.some((ignoredName) => collisionSearchName.includes(ignoredName))) {
        return;
      }
      if (isDoorwayNavigationPanel(node, collisionSearchName) && !isExplicitPortalCollision(collisionSearchName)) {
        return;
      }
      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) {
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
      const looksLikeWall =
        height >= 0.8 &&
        wideAxis >= 0.75 &&
        thinAxis <= Math.max(0.35, wideAxis * 0.18) &&
        size.x * size.z <= Math.max(8, wideAxis * 0.75);
      if (looksLikeWall) {
        inferredBlockers.push({
          blocker: {
            box,
            name: node.name || node.parent?.name || "Inferred wall",
            kind: "inferred"
          },
          area: wideAxis * height
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
    this.managedTextures.push(managed);
    const material = new THREE.MeshBasicMaterial({ map: managed.texture });
    const matches: THREE.Mesh[] = [];

    this.scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const meshNameMatches = interaction.targetMeshName && node.name === interaction.targetMeshName;
      const materialNameMatches =
        interaction.targetMaterialName &&
        !Array.isArray(node.material) &&
        node.material.name === interaction.targetMaterialName;
      const markedDemoTarget = node.userData["videoTarget"] === true && !interaction.targetMeshName;
      if (meshNameMatches || materialNameMatches || markedDemoTarget) {
        matches.push(node);
      }
    });

    matches.forEach((mesh) => {
      mesh.material = material;
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
      const meshMatches = Boolean(interaction.targetMeshName && node.name === interaction.targetMeshName);
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
        this.cameraTarget.set(sceneCenter.x, position.y - 0.35, sceneCenter.z);
        if (this.camera.position.distanceTo(this.cameraTarget) < 0.5) {
          this.cameraTarget.z -= 1;
        }
        this.updateAnglesFromTarget();
        this.camera.lookAt(this.cameraTarget);
        this.stableFloorY = this.camera.position.y - this.cameraHeight;
        return true;
      }
    }

    return false;
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
  }

  private addLighting(): void {
    if (this.lightRig.children.length > 0) {
      return;
    }

    const hemisphere = new THREE.HemisphereLight("#f7fbff", "#716550", 0.9);
    this.lightRig.add(hemisphere);

    const sun = new THREE.DirectionalLight("#fff6e8", 2.2);
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
      this.moveTarget = undefined;
      this.movePath = [];
      this.moveMarker.visible = false;
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
    if (flatCompletionDistance < 0.035 && verticalDistance < 0.12) {
      this.camera.position.copy(target);
      this.stableFloorY = target.y - this.cameraHeight;
      this.clickMoveVelocity = 0;
      const nextWaypoint = this.movePath.shift();
      if (nextWaypoint) {
        this.moveTarget = nextWaypoint;
      } else {
        this.moveTarget = undefined;
        this.moveMarker.visible = false;
      }
      return;
    }
    const nextPosition = this.camera.position.clone();
    const flatDelta = target.clone().sub(this.camera.position);
    flatDelta.y = 0;
    const flatDistance = flatDelta.length();
    const clickMoveSpeed = this.controls.clickMoveSpeed ?? 1.2;
    if (flatDistance > 0.001) {
      if (!this.draggingLook && flatDistance > 0.15) {
        this.yaw = dampAngle(this.yaw, Math.atan2(flatDelta.x, -flatDelta.z), 2.7, delta);
        this.pitch = damp(this.pitch, THREE.MathUtils.clamp(this.pitch, -0.18, 0.12), 1.4, delta);
      }
      const desiredSpeed = THREE.MathUtils.clamp(flatDistance * 1.1, 0.18, clickMoveSpeed);
      const acceleration = flatDistance < 0.85 ? 4.5 : 2.8;
      this.clickMoveVelocity = damp(this.clickMoveVelocity, desiredSpeed, acceleration, delta);
      const step = Math.min(flatDistance, this.clickMoveVelocity * delta);
      flatDelta.normalize().multiplyScalar(step);
      nextPosition.x += flatDelta.x;
      nextPosition.z += flatDelta.z;
    }
    if (this.geometryFloorMeshes.length === 0) {
      nextPosition.y = damp(nextPosition.y, target.y, 5.5, delta);
    }
    const steppedPosition = this.resolveSteppedMovementPosition(nextPosition, this.camera.position, delta);
    if (steppedPosition && this.canOccupyPosition(steppedPosition, this.camera.position)) {
      this.camera.position.copy(steppedPosition);
      this.snapCameraToFloor(delta);
      this.clampCamera();
      return;
    }
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
    const direct = this.resolveSteppedMovementPosition(this.camera.position.clone().add(delta), this.camera.position);
    if (direct && this.canOccupyPosition(direct, this.camera.position)) {
      this.camera.position.copy(direct);
      this.snapCameraToFloor();
      this.clampCamera();
      return true;
    }

    let moved = false;
    const slideX = this.resolveSteppedMovementPosition(
      this.camera.position.clone().add(new THREE.Vector3(delta.x, 0, 0)),
      this.camera.position
    );
    if (slideX && this.canOccupyPosition(slideX, this.camera.position)) {
      this.camera.position.copy(slideX);
      this.snapCameraToFloor();
      this.clampCamera();
      moved = true;
    }

    const slideZ = this.resolveSteppedMovementPosition(
      this.camera.position.clone().add(new THREE.Vector3(0, 0, delta.z)),
      this.camera.position
    );
    if (slideZ && this.canOccupyPosition(slideZ, this.camera.position)) {
      this.camera.position.copy(slideZ);
      this.snapCameraToFloor();
      this.clampCamera();
      moved = true;
    }
    return moved;
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
    const targetFloorY = Math.abs(heightDelta) <= bumpTolerance ? originFloorY : floorY;
    const targetY = targetFloorY + this.cameraHeight;
    const floorHeightSmoothing = this.floorHeightSmoothing();
    const smoothing = Math.abs(heightDelta) <= bumpTolerance ? floorHeightSmoothing * 2.8 : floorHeightSmoothing;
    next.y = damp(position.y, targetY, smoothing, delta);
    return next;
  }

  private canOccupyPosition(position: THREE.Vector3, origin?: THREE.Vector3): boolean {
    return !this.navigationFailureDetail(position, origin);
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

    const cameraSphere = new THREE.Sphere(candidate, this.collisionRadius);
    const insidePassZone = this.isInsidePassZone(candidate);
    if (
      this.walkZoneMeshes.length > 0 &&
      !this.isInsideWalkZone(candidate) &&
      !insidePassZone
    ) {
      const generatedZoneMissOnFloor = this.generatedWalkZonesOnly && this.canStandOnGeometryFloor(candidate);
      if (!generatedZoneMissOnFloor) {
        return { reason: "outside-walk-zone", point: candidate.clone() };
      }
    }

    const originProbe = origin ? this.navigationProbePosition(origin) : undefined;
    const originSphere = originProbe ? new THREE.Sphere(originProbe, this.collisionRadius) : undefined;
    const originBlockedBlockers = originSphere
      ? this.collisionBlockers.filter((blocker) => blocker.box.intersectsSphere(originSphere))
      : [];
    const bridgePassesInferredBlockers = Boolean(
      originProbe && this.isPassZoneBridgeSegment(originProbe, candidate)
    );
    const blockedBlockers = this.collisionBlockers.filter((blocker) => blocker.box.intersectsSphere(cameraSphere));
    const effectiveBlockers = insidePassZone
      ? blockedBlockers.filter((blocker) => blocker.kind === "authored")
      : blockedBlockers;
    if (originProbe) {
      const sweptBlocker = this.navigationSegmentBlocker(originProbe, candidate, {
        ignoreBlockers: originBlockedBlockers,
        ignoreInferredBlockers: bridgePassesInferredBlockers,
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
      effectiveBlockers.every((blocker) => blocker.kind === "inferred") &&
      bridgePassesInferredBlockers
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
      authoredOnly?: boolean;
    } = {}
  ): CollisionBlocker | undefined {
    if (origin.distanceToSquared(target) < 0.0001) {
      return undefined;
    }
    const ignored = new Set(options.ignoreBlockers ?? []);
    const minY = Math.min(origin.y, target.y) - this.collisionRadius;
    const maxY = Math.max(origin.y, target.y) + this.collisionRadius;
    return this.collisionBlockers.find((blocker) => {
      if (ignored.has(blocker)) {
        return false;
      }
      if (options.authoredOnly && blocker.kind !== "authored") {
        return false;
      }
      if (options.ignoreInferredBlockers && blocker.kind === "inferred") {
        return false;
      }
      if (maxY < blocker.box.min.y || minY > blocker.box.max.y) {
        return false;
      }
      return segmentIntersectsInflatedBox2D(origin, target, blocker.box, this.collisionRadius);
    });
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
    const steps = Math.max(2, Math.ceil(distance / Math.max(0.18, this.collisionRadius * 0.75)));
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

  private findNavigationRoute(target: THREE.Vector3, origin: THREE.Vector3): THREE.Vector3[] | undefined {
    const route = this.findVisibilityNavigationRoute(target, origin) ?? this.findGridNavigationRoute(target, origin);
    return route ? this.smoothNavigationRoute(route, origin) ?? route : undefined;
  }

  private smoothNavigationRoute(route: THREE.Vector3[], origin: THREE.Vector3): THREE.Vector3[] | undefined {
    if (route.length <= 1) {
      return route;
    }
    return this.simplifyNavigationRoute([origin.clone(), ...route.map((point) => point.clone())]);
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
        if (this.navigationRouteFailureDetail(node.point, current.point)) {
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
    let step = Math.max(0.24, this.collisionRadius * 0.9);
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
        const nextKey = keyFor(nextX, nextZ);
        const nextCost = current.cost + step * multiplier + Math.abs(floorDelta) * 1.8;
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
    const x = Math.max(0, halfSize.x - this.collisionRadius * 1.15) * 0.72;
    const z = Math.max(0, halfSize.z - this.collisionRadius * 1.15) * 0.72;
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
        this.isInsideNavigationZoneWithPadding(mesh, point, Math.max(0.42, this.collisionRadius * 1.75))
      )
    );
  }

  private isInsideNavigationZone(mesh: THREE.Mesh, position: THREE.Vector3): boolean {
    return this.isInsideNavigationZoneWithPadding(mesh, position, this.collisionRadius);
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

  private snapCameraToFloor(delta = 1 / 60): void {
    const floorY = this.sampleGeometryFloorY(this.camera.position, { maxDelta: Math.max(0.28, this.cameraHeight * 0.18) });
    if (typeof floorY !== "number") {
      return;
    }
    const currentFloorY = this.camera.position.y - this.cameraHeight;
    const previousFloorY = this.stableFloorY ?? currentFloorY;
    const bumpTolerance = this.floorBumpTolerance();
    const levelDelta = floorY - previousFloorY;
    const targetFloorY = Math.abs(levelDelta) <= bumpTolerance ? previousFloorY : floorY;
    const nextY = targetFloorY + this.cameraHeight;
    const difference = Math.abs(nextY - this.camera.position.y);
    if (difference <= Math.max(0.62, this.cameraHeight * 0.38)) {
      const floorHeightSmoothing = this.floorHeightSmoothing();
      const smoothing = Math.abs(levelDelta) <= bumpTolerance ? floorHeightSmoothing * 2.8 : floorHeightSmoothing;
      this.camera.position.y = damp(this.camera.position.y, nextY, smoothing, delta);
      this.stableFloorY = damp(previousFloorY, targetFloorY, smoothing, delta);
    } else {
      this.stableFloorY = currentFloorY;
    }
  }

  private floorBumpTolerance(): number {
    return THREE.MathUtils.clamp(
      this.controls.floorBumpTolerance ?? Math.max(0.24, this.cameraHeight * 0.14),
      0.02,
      0.8
    );
  }

  private floorHeightSmoothing(): number {
    return THREE.MathUtils.clamp(this.controls.floorHeightSmoothing ?? 1.65, 0.5, 8);
  }

  private sampleGeometryFloorY(
    position: THREE.Vector3,
    options: { maxDelta?: number } = {}
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
    const hit = stableHit ?? hits[0];
    return hit?.point.y;
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
    for (const offset of probes) {
      const origin = hit.point.clone().add(offset);
      origin.y = Math.max(hit.point.y + 1.1, this.camera.position.y + 0.25);
      raycaster.set(origin, direction);
      const floorHit = raycaster
        .intersectObjects(this.walkableMeshes, true)
        .find((candidate) => this.isWalkableHit(candidate));
      if (floorHit) {
        return floorHit;
      }
    }
    return undefined;
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

  private tryMoveToFloorHit(floorHit: THREE.Intersection, event: PointerEvent): boolean {
    const nextTarget = floorHit.point.clone();
    nextTarget.y = floorHit.point.y + this.cameraHeight;
    if (this.minBounds && this.maxBounds) {
      clampToBounds(nextTarget, this.minBounds, this.maxBounds);
    }
    const failureDetail = this.navigationFailureDetail(nextTarget, this.camera.position);
    if (failureDetail) {
      const recoveredTarget = this.findReachableTargetNear(nextTarget, this.camera.position);
      if (recoveredTarget) {
        if (recoveredTarget.route) {
          this.startClickRoute(recoveredTarget.route, recoveredTarget.target);
        } else {
          this.startClickMove(recoveredTarget.target, recoveredTarget.target);
        }
        return true;
      }
      this.emitNavigationFailure(
        failureDetail.reason,
        event,
        failureDetail.point ?? floorHit.point,
        undefined,
        failureDetail.blockerName
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
      this.emitNavigationFailure(
        routeFailureDetail.reason === "blocked-step" ? "blocked-step" : "route-not-found",
        event,
        routeFailureDetail.point ?? floorHit.point,
        undefined,
        routeFailureDetail.blockerName
      );
      return true;
    }
    this.startClickMove(nextTarget, floorHit.point);
    return true;
  }

  private startClickMove(target: THREE.Vector3, markerPoint: THREE.Vector3): void {
    this.moveTarget = target;
    this.movePath = [];
    this.clickMoveVelocity = 0;
    this.cameraTween = undefined;
    this.moveMarker.visible = true;
    this.moveMarker.position.copy(markerPoint);
    this.moveMarker.position.y += 0.035;
  }

  private startClickRoute(route: THREE.Vector3[], markerPoint: THREE.Vector3): void {
    const [firstWaypoint, ...remainingWaypoints] = route;
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

  private findReachableTargetNear(
    target: THREE.Vector3,
    origin: THREE.Vector3
  ): RecoveredNavigationTarget | undefined {
    const candidates = this.nearbyNavigationCandidates(target);
    for (const candidate of candidates) {
      if (this.navigationFailureDetail(candidate, origin)) {
        continue;
      }
      if (!this.navigationRouteFailureDetail(candidate, origin)) {
        return { target: candidate };
      }
      const route = this.findNavigationRoute(candidate, origin);
      if (route) {
        return { target: candidate, route };
      }
    }
    return undefined;
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

  private navigationFailureMessage(
    reason: NavigationFailureReason,
    objectName?: string,
    blockerName?: string
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
      return blockerName
        ? `Move target is blocked by collision geometry: ${blockerName}.`
        : "Move target is blocked by collision geometry near the route.";
    }
    return objectName
      ? `Clicked ${objectName}, but no walkable floor was found there.`
      : "No walkable floor was found at the clicked point.";
  }

  private emitNavigationFailure(
    reason: NavigationFailureReason,
    event: PointerEvent,
    point?: THREE.Vector3,
    objectName?: string,
    blockerName?: string
  ): void {
    this.options.onNavigationFailure?.({
      reason,
      message: this.navigationFailureMessage(reason, objectName, blockerName),
      ...(point ? { point: [point.x, point.y, point.z] } : {}),
      cameraPosition: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      ...(objectName ? { objectName } : {}),
      ...(blockerName ? { blockerName } : {}),
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
    this.draggingLook =
      this.controls.enabled &&
      this.controls.dragLook &&
      (event.button === 2 || event.pointerType === "touch");
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.lastPointer) {
      return;
    }

    if (!this.draggingLook && this.pointerDown) {
      const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
      if (moved > 4) {
        this.draggingLook = this.controls.enabled && this.controls.dragLook;
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
      const nearbyFloorHit = this.findWalkableHitNearObject(objectHit);
      if (nearbyFloorHit && this.tryMoveToFloorHit(nearbyFloorHit, event)) {
        return;
      }
      const portalFloorHit = this.findWalkableHitBeyondPortalObject(objectHit, objectName);
      if (portalFloorHit && this.tryMoveToFloorHit(portalFloorHit, event)) {
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
    const currentState = this.objectToggleStates.get(interaction.id) ?? targets.some((target) => target.visible);
    const nextState = !currentState;
    this.objectToggleStates.set(interaction.id, nextState);
    targets.forEach((target) => {
      target.visible = nextState;
    });
  }

  private setObjectToggleVisibility(interaction: ObjectToggleInteraction, visible: boolean): void {
    this.findObjectToggleTargets(interaction).forEach((target) => {
      target.visible = visible;
    });
  }

  private findObjectToggleTargets(interaction: ObjectToggleInteraction): THREE.Object3D[] {
    const names = new Set<string>();
    if (interaction.targetObjectName) {
      names.add(interaction.targetObjectName);
    }
    if (interaction.targetObjectId) {
      const override = this.objectOverrides.get(interaction.targetObjectId);
      if (override?.name) {
        names.add(override.name);
      }
    }
    if (names.size === 0) {
      return [];
    }

    const targets: THREE.Object3D[] = [];
    this.scene.traverse((node) => {
      if (names.has(node.name)) {
        targets.push(node);
      }
    });
    return targets;
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
    this.moveTarget = undefined;
    this.movePath = [];
    this.moveMarker.visible = false;
    const intent = -Math.sign(event.deltaY || 0);
    const impulse = THREE.MathUtils.clamp(Math.abs(event.deltaY) * 0.035, 0.45, 3.2);
    this.wheelVelocity = THREE.MathUtils.clamp(this.wheelVelocity + intent * impulse, -5.5, 5.5);
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
