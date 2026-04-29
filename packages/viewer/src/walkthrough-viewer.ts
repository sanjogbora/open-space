import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
import { clampToBounds, dampVector, easeOutCubic, toVector3 } from "./math";
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

interface CollisionBlocker {
  box: THREE.Box3;
  name: string;
  kind: "authored" | "named" | "inferred";
}

interface NavigationFailureDetail {
  reason: NavigationFailureReason;
  blockerName?: string;
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
  private readonly moveMarker = createMoveMarker();
  private readonly modelScale: number;
  private readonly manifestScale: number;
  private readonly cameraHeight: number;
  private readonly hotspots: HotspotBinding[] = [];
  private readonly managedTextures: ManagedTexture[] = [];
  private readonly keys = new Set<string>();
  private readonly collisionRadius = 0.28;
  private readonly materialOverrides = new Map<string, MaterialOverride>();
  private readonly objectOverrides = new Map<string, ObjectOverride>();
  private readonly objectToggleStates = new Map<string, boolean>();
  private controls: SceneControlsDocument["movement"] = {
    enabled: true,
    clickToMove: true,
    keyboard: true,
    dragLook: true,
    moveSpeed: 3.8,
    clickMoveSpeed: 1.2,
    lookSensitivityX: 0.004,
    lookSensitivityY: 0.0035,
    clickMoveThresholdPx: 8
  };

  private floorMeshes: THREE.Object3D[] = [];
  private walkableMeshes: THREE.Object3D[] = [];
  private pickableMeshes: THREE.Object3D[] = [];
  private collisionBlockers: CollisionBlocker[] = [];
  private collisionDebugHelpers: THREE.Box3Helper[] = [];
  private navigationZoneMeshes: THREE.Mesh[] = [];
  private walkZoneMeshes: THREE.Mesh[] = [];
  private sceneRoot: THREE.Object3D | undefined;
  private frameId = 0;
  private destroyed = false;
  private cameraTarget = new THREE.Vector3(0, 1.55, 0);
  private moveTarget: THREE.Vector3 | undefined;
  private cameraTween: CameraTween | undefined;
  private pointerDown: { x: number; y: number; time: number } | undefined;
  private yaw = 0;
  private pitch = 0;
  private draggingLook = false;
  private lastPointer: { x: number; y: number } | undefined;
  private quality: ViewerQuality;
  private minBounds: THREE.Vector3 | undefined;
  private maxBounds: THREE.Vector3 | undefined;
  private sunLight: THREE.DirectionalLight | undefined;
  private sunTarget: THREE.Object3D | undefined;
  private environmentTexture: THREE.Texture | undefined;
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
    this.uninstallEvents();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  goToView(viewId: string): void {
    const view = this.manifest.views.find((item) => item.id === viewId);
    if (!view) {
      return;
    }
    this.moveTarget = undefined;
    this.moveMarker.visible = false;
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
      this.pickableMeshes = this.collectPickableMeshes(this.sceneRoot);
      this.configureNavigationSurfaces(this.sceneRoot);
      this.fitLightingToScene(this.sceneRoot);
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
    this.pickableMeshes = this.collectPickableMeshes(demo.root);
    this.configureNavigationSurfaces(demo.root, [demo.floor]);
    this.fitLightingToScene(demo.root);
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
    if (zones.walkMeshes.length > 0) {
      this.floorMeshes = zones.walkMeshes;
      this.walkableMeshes = zones.walkMeshes;
    } else {
      this.floorMeshes = fallbackFloors.length > 0 ? fallbackFloors : this.collectFloorMeshes(root);
      this.walkableMeshes = this.collectWalkableMeshes(root);
    }
    this.collisionBlockers = [...this.collectCollisionBlockers(root), ...zones.blockers];
    this.rebuildCollisionDebugHelpers();
  }

  private createNavigationZones(): { walkMeshes: THREE.Mesh[]; blockers: CollisionBlocker[] } {
    const walkMeshes: THREE.Mesh[] = [];
    const blockers: CollisionBlocker[] = [];
    const zones = this.manifest.navigation.zones ?? [];
    if (zones.length === 0) {
      return { walkMeshes, blockers };
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

    return { walkMeshes, blockers };
  }

  private createNavigationZoneMesh(zone: NavigationZone): THREE.Mesh {
    const center = this.toSceneVector(zone.center);
    const size = this.toSceneSize(zone.size);
    const geometry = new THREE.BoxGeometry(
      Math.max(0.05, size.x),
      Math.max(0.04, size.y),
      Math.max(0.05, size.z)
    );
    const material = new THREE.MeshBasicMaterial({
      color: zone.kind === "walk" ? "#1b8fff" : "#ff5f57",
      transparent: true,
      opacity: this.debug ? (zone.kind === "walk" ? 0.22 : 0.34) : 0,
      depthWrite: false
    });
    material.colorWrite = this.debug;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `navigation_${zone.kind}_${zone.id}`;
    mesh.renderOrder = this.debug ? 8 : 0;
    mesh.position.copy(center);
    mesh.rotation.y = zone.rotationY ?? 0;
    mesh.userData["navigationZoneKind"] = zone.kind;
    mesh.userData["navigationHalfSize"] = new THREE.Vector3(
      Math.max(0.05, size.x) / 2,
      Math.max(0.04, size.y) / 2,
      Math.max(0.05, size.z) / 2
    );
    return mesh;
  }

  private updateNavigationZoneVisibility(): void {
    this.navigationZoneMeshes.forEach((mesh) => {
      const kind = mesh.userData["navigationZoneKind"];
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = this.debug ? (kind === "walk" ? 0.22 : 0.34) : 0;
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

    if (environment?.groundEnabled === false) {
      return;
    }

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(
        (environment?.groundSize ?? 90) * this.manifestScale,
        (environment?.groundSize ?? 90) * this.manifestScale
      ),
      new THREE.MeshStandardMaterial({
        color: environment?.groundColor ?? "#6f8f5a",
        roughness: 0.95,
        metalness: 0
      })
    );
    ground.name = "environment_ground";
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = (environment?.groundY ?? -0.04) * this.manifestScale;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private prepareLoadedScene(root: THREE.Object3D): void {
    const forceDoubleSided = this.manifest.rendering?.doubleSidedMaterials === true;
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        this.applyObjectOverride(node);
        const name = node.name.toLowerCase();
        const architecturalShell =
          name.includes("wall") || name.includes("floor") || name.includes("ceiling");
        node.castShadow = !architecturalShell;
        node.receiveShadow = true;
        if (Array.isArray(node.material)) {
          node.material.forEach((material) => {
            this.applyMaterialOverride(material);
            this.prepareMaterial(material, name);
            if (forceDoubleSided || architecturalShell) {
              material.side = THREE.DoubleSide;
            }
            material.needsUpdate = true;
          });
        } else {
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

  private applyMaterialOverride(material: THREE.Material): void {
    const override = this.materialOverrides.get(material.name);
    if (!override) {
      return;
    }

    if ("color" in material && material.color instanceof THREE.Color && override.baseColor) {
      material.color.set(override.baseColor);
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

  private collectFloorMeshes(root: THREE.Object3D): THREE.Object3D[] {
    const floorNames = this.manifest.navigation.floorMeshNames.map((name) => name.toLowerCase());
    const meshes: THREE.Object3D[] = [];
    const fallbackCandidates: { mesh: THREE.Mesh; area: number }[] = [];
    const rootBox = new THREE.Box3().setFromObject(root);
    const sceneHeight = Math.max(0.001, rootBox.max.y - rootBox.min.y);
    const lowBand = rootBox.min.y + Math.max(0.75, sceneHeight * 0.22);

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const name = node.name.toLowerCase();
      if (floorNames.some((floorName) => name.includes(floorName))) {
        meshes.push(node);
        return;
      }

      const box = new THREE.Box3().setFromObject(node);
      if (box.isEmpty()) {
        return;
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const area = size.x * size.z;
      const flatEnough = size.y <= Math.max(0.2, Math.min(size.x, size.z) * 0.16);
      const lowEnough = center.y <= lowBand;
      if (flatEnough && lowEnough && area > 0.75) {
        fallbackCandidates.push({ mesh: node, area });
      }
    });
    if (meshes.length > 0) {
      return meshes;
    }
    return fallbackCandidates
      .sort((a, b) => b.area - a.area)
      .slice(0, 8)
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
    if (blockers.length > 0) {
      return blockers;
    }
    return inferredBlockers
      .sort((a, b) => b.area - a.area)
      .slice(0, 160)
      .map((item) => item.blocker);
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
      this.camera.position.copy(this.toSceneVector(firstView.position, { preserveMeterY: true }));
      this.cameraTarget.copy(this.toSceneVector(firstView.target, { preserveMeterY: true }));
      this.camera.fov = firstView.fov ?? 62;
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.position.set(-4, 1.65, 4);
      this.cameraTarget.set(0, 1.35, 0);
    }
    this.updateAnglesFromTarget();
    this.camera.lookAt(this.cameraTarget);
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
    if (!this.controls.enabled || !this.controls.keyboard) {
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
      this.moveMarker.visible = false;
    }

    this.applyYawPitch();
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
    const distance = this.camera.position.distanceTo(target);
    if (distance < 0.035) {
      this.camera.position.copy(target);
      this.moveTarget = undefined;
      this.moveMarker.visible = false;
      return;
    }
    const nextPosition = this.camera.position.clone();
    const clickMoveSpeed = this.controls.clickMoveSpeed ?? 1.9;
    dampVector(nextPosition, target, clickMoveSpeed, delta);
    if (this.canOccupyPosition(nextPosition, this.camera.position)) {
      this.camera.position.copy(nextPosition);
      this.clampCamera();
      return;
    }
    this.moveTarget = undefined;
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

  private moveCameraBy(delta: THREE.Vector3): void {
    const direct = this.camera.position.clone().add(delta);
    if (this.canOccupyPosition(direct, this.camera.position)) {
      this.camera.position.copy(direct);
      this.clampCamera();
      return;
    }

    const slideX = this.camera.position.clone().add(new THREE.Vector3(delta.x, 0, 0));
    if (this.canOccupyPosition(slideX, this.camera.position)) {
      this.camera.position.copy(slideX);
      this.clampCamera();
    }

    const slideZ = this.camera.position.clone().add(new THREE.Vector3(0, 0, delta.z));
    if (this.canOccupyPosition(slideZ, this.camera.position)) {
      this.camera.position.copy(slideZ);
      this.clampCamera();
    }
  }

  private canOccupyPosition(position: THREE.Vector3, origin?: THREE.Vector3): boolean {
    return !this.navigationFailureDetail(position, origin);
  }

  private navigationFailureDetail(
    position: THREE.Vector3,
    origin?: THREE.Vector3
  ): NavigationFailureDetail | undefined {
    const candidate = position.clone();
    if (this.minBounds && this.maxBounds) {
      if (
        candidate.x < this.minBounds.x ||
        candidate.x > this.maxBounds.x ||
        candidate.z < this.minBounds.z ||
        candidate.z > this.maxBounds.z
      ) {
        return { reason: "outside-bounds" };
      }
      clampToBounds(candidate, this.minBounds, this.maxBounds);
    }

    const cameraSphere = new THREE.Sphere(candidate, this.collisionRadius);
    if (this.walkZoneMeshes.length > 0 && !this.isInsideWalkZone(candidate)) {
      return { reason: "outside-walk-zone" };
    }

    const blockedBlockers = this.collisionBlockers.filter((blocker) => blocker.box.intersectsSphere(cameraSphere));
    if (blockedBlockers.length === 0) {
      return undefined;
    }
    if (!origin) {
      const blockerName = blockedBlockers[0]?.name;
      return blockerName
        ? { reason: "blocked-collision", blockerName }
        : { reason: "blocked-collision" };
    }
    const originSphere = new THREE.Sphere(origin, this.collisionRadius);
    const originBlockedBlockers = this.collisionBlockers.filter((blocker) => blocker.box.intersectsSphere(originSphere));
    const newlyBlocked = blockedBlockers.find((blocker) => !originBlockedBlockers.includes(blocker));
    return newlyBlocked
      ? { reason: "blocked-collision", blockerName: newlyBlocked.name }
      : undefined;
  }

  private isInsideWalkZone(position: THREE.Vector3): boolean {
    return this.walkZoneMeshes.some((mesh) => {
      const halfSize = mesh.userData["navigationHalfSize"];
      if (!(halfSize instanceof THREE.Vector3)) {
        return false;
      }
      const local = mesh.worldToLocal(position.clone());
      return (
        Math.abs(local.x) <= halfSize.x + this.collisionRadius &&
        Math.abs(local.z) <= halfSize.z + this.collisionRadius
      );
    });
  }

  private isWalkableHit(hit: THREE.Intersection): boolean {
    if (!(hit.object instanceof THREE.Mesh) || !hit.face) {
      return false;
    }
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const horizontalEnough = Math.abs(normal.y) >= 0.45;
    const belowEye = hit.point.y <= this.camera.position.y + 0.25;
    return horizontalEnough && belowEye;
  }

  private findWalkableHit(): THREE.Intersection | undefined {
    const hits = this.raycaster.intersectObjects(this.walkableMeshes, true);
    return hits.find((hit) => this.isWalkableHit(hit));
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
      const nextTarget = floorHit.point.clone();
      nextTarget.y = floorHit.point.y + this.cameraHeight;
      if (this.minBounds && this.maxBounds) {
        clampToBounds(nextTarget, this.minBounds, this.maxBounds);
      }
      const failureDetail = this.navigationFailureDetail(nextTarget, this.camera.position);
      if (failureDetail) {
        this.emitNavigationFailure(
          failureDetail.reason,
          event,
          floorHit.point,
          undefined,
          failureDetail.blockerName
        );
        return;
      }
      this.moveTarget = nextTarget;
      this.cameraTween = undefined;
      this.moveMarker.visible = true;
      this.moveMarker.position.copy(floorHit.point);
      this.moveMarker.position.y += 0.035;
      return;
    }

    const objectHit = this.raycaster.intersectObjects(this.pickableMeshes, true)[0];
    if (objectHit && objectHit.object instanceof THREE.Mesh) {
      const objectName = objectHit.object.name || objectHit.object.parent?.name || "Object";
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
    const delta = Math.sign(event.deltaY);
    const step = THREE.MathUtils.clamp(Math.abs(event.deltaY) * 0.025, 1.5, 7);
    this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + delta * step, 34, 82);
    this.camera.updateProjectionMatrix();
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

export function createInteractionFilter(kind: SceneInteraction["kind"]) {
  return (interaction: SceneInteraction) => interaction.kind === kind;
}
