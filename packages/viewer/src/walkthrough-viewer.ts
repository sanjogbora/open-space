import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type {
  HotspotInteraction,
  LinkInteraction,
  MaterialVariantInteraction,
  MaterialOverride,
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
import type { LoadingProgress, ViewerCameraPose, ViewerOptions, ViewerQuality } from "./types";
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

export class WalkthroughViewer {
  private readonly container: HTMLElement;
  private readonly manifest: SceneManifest;
  private readonly options: ViewerOptions;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.05, 250);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly loader = new GLTFLoader();
  private readonly moveMarker = createMoveMarker();
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
    lookSensitivityX: 0.004,
    lookSensitivityY: 0.0035,
    clickMoveThresholdPx: 8
  };

  private floorMeshes: THREE.Object3D[] = [];
  private pickableMeshes: THREE.Object3D[] = [];
  private collisionBoxes: THREE.Box3[] = [];
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

  constructor(options: ViewerOptions) {
    this.container = options.container;
    this.manifest = options.manifest;
    this.options = options;
    this.quality = options.quality ?? "balanced";

    const selectedQuality = this.manifest.qualityProfiles.find((item) => item.id === this.quality);
    this.renderer = new THREE.WebGLRenderer({
      antialias: selectedQuality?.antialias ?? true,
      alpha: false,
      powerPreference: "high-performance"
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = selectedQuality?.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor("#d8dde2", 1);
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "3D walkthrough viewport");
    this.renderer.domElement.className = "walkthrough-canvas";
    this.container.appendChild(this.renderer.domElement);

    this.scene.name = "walkthrough-scene";
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
      toPosition: toVector3(view.position),
      fromTarget: this.cameraTarget.clone(),
      toTarget: toVector3(view.target),
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
      this.prepareLoadedScene(this.sceneRoot);
      this.scene.add(this.sceneRoot);
      this.sceneRoot.updateMatrixWorld(true);
      this.floorMeshes = this.collectFloorMeshes(this.sceneRoot);
      this.pickableMeshes = this.collectPickableMeshes(this.sceneRoot);
      this.collisionBoxes = this.collectCollisionBoxes(this.sceneRoot);
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
    this.floorMeshes = [demo.floor];
    this.pickableMeshes = this.collectPickableMeshes(demo.root);
    this.collisionBoxes = this.collectCollisionBoxes(demo.root);
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
  }

  private prepareLoadedScene(root: THREE.Object3D): void {
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
            material.needsUpdate = true;
          });
        } else {
          this.applyMaterialOverride(node.material);
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
    root.traverse((node) => {
      const name = node.name.toLowerCase();
      if (floorNames.some((floorName) => name.includes(floorName))) {
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
      const name = node.name.toLowerCase();
      if (floorNames.some((floorName) => name.includes(floorName))) {
        return;
      }
      meshes.push(node);
    });
    return meshes;
  }

  private collectCollisionBoxes(root: THREE.Object3D): THREE.Box3[] {
    const collisionNames = this.manifest.navigation.collisionMeshNames.map((name) => name.toLowerCase());
    const boxes: THREE.Box3[] = [];
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) {
        return;
      }
      const name = node.name.toLowerCase();
      const isCollisionMesh = collisionNames.some((collisionName) => name.includes(collisionName));
      if (!isCollisionMesh) {
        return;
      }
      const box = new THREE.Box3().setFromObject(node);
      if (!box.isEmpty()) {
        boxes.push(box);
      }
    });
    return boxes;
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
    sprite.position.copy(toVector3(interaction.position));
    sprite.userData["interactionId"] = interaction.id;
    this.scene.add(sprite);
    this.hotspots.push({ interaction, sprite });
  }

  private addLink(interaction: LinkInteraction): void {
    const sprite = createHotspotSprite("L");
    sprite.position.copy(toVector3(interaction.position));
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
    sprite.position.copy(toVector3(interaction.position));
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

  private applyInitialCamera(): void {
    const firstView = this.manifest.views[0];
    if (firstView) {
      this.camera.position.copy(toVector3(firstView.position));
      this.cameraTarget.copy(toVector3(firstView.target));
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
    const hemisphere = new THREE.HemisphereLight("#f7fbff", "#716550", 1.25);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight("#fff6e8", 2.5);
    sun.position.set(-3.5, 6.5, 3.2);
    sun.castShadow = true;
    sun.shadow.bias = -0.00005;
    sun.shadow.normalBias = 0.035;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -8;
    sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 8;
    sun.shadow.camera.bottom = -8;
    this.scene.add(sun);
  }

  private applyBounds(): void {
    const bounds = this.manifest.navigation.bounds;
    if (!bounds) {
      return;
    }
    this.minBounds = toVector3(bounds.min);
    this.maxBounds = toVector3(bounds.max);
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
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

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
    target.y = this.manifest.navigation.cameraHeight;
    const distance = this.camera.position.distanceTo(target);
    if (distance < 0.035) {
      this.camera.position.copy(target);
      this.moveTarget = undefined;
      this.moveMarker.visible = false;
      return;
    }
    const nextPosition = this.camera.position.clone();
    dampVector(nextPosition, target, this.manifest.navigation.moveSpeed, delta);
    if (this.canOccupyPosition(nextPosition)) {
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
    if (this.canOccupyPosition(direct)) {
      this.camera.position.copy(direct);
      this.clampCamera();
      return;
    }

    const slideX = this.camera.position.clone().add(new THREE.Vector3(delta.x, 0, 0));
    if (this.canOccupyPosition(slideX)) {
      this.camera.position.copy(slideX);
      this.clampCamera();
    }

    const slideZ = this.camera.position.clone().add(new THREE.Vector3(0, 0, delta.z));
    if (this.canOccupyPosition(slideZ)) {
      this.camera.position.copy(slideZ);
      this.clampCamera();
    }
  }

  private canOccupyPosition(position: THREE.Vector3): boolean {
    const candidate = position.clone();
    if (this.minBounds && this.maxBounds) {
      clampToBounds(candidate, this.minBounds, this.maxBounds);
    }

    const cameraSphere = new THREE.Sphere(candidate, this.collisionRadius);
    return !this.collisionBoxes.some((box) => box.intersectsSphere(cameraSphere));
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

    const objectHit = this.raycaster.intersectObjects(this.pickableMeshes, true)[0];
    if (objectHit && objectHit.object instanceof THREE.Mesh) {
      this.options.onObjectPick?.({
        objectName: objectHit.object.name || objectHit.object.parent?.name || "Object",
        materialNames: this.materialNames(objectHit.object.material),
        point: [objectHit.point.x, objectHit.point.y, objectHit.point.z],
        screen: {
          x: event.clientX,
          y: event.clientY
        }
      });
      return;
    }

    const floorHits = this.raycaster.intersectObjects(this.floorMeshes, true);
    const floorHit = floorHits[0];
    if (!floorHit) {
      return;
    }
    const nextTarget = floorHit.point.clone();
    nextTarget.y = this.manifest.navigation.cameraHeight;
    if (this.minBounds && this.maxBounds) {
      clampToBounds(nextTarget, this.minBounds, this.maxBounds);
    }
    if (!this.canOccupyPosition(nextTarget)) {
      return;
    }
    this.moveTarget = nextTarget;
    this.cameraTween = undefined;
    this.moveMarker.visible = true;
    this.moveMarker.position.copy(floorHit.point);
    this.moveMarker.position.y += 0.035;
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
  }

  private uninstallEvents(): void {
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.handlePointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.handlePointerUp);
    this.renderer.domElement.removeEventListener("contextmenu", this.handleContextMenu);
  }

  private emitProgress(progress: LoadingProgress): void {
    this.options.onProgress?.(progress);
  }
}

export function createInteractionFilter(kind: SceneInteraction["kind"]) {
  return (interaction: SceneInteraction) => interaction.kind === kind;
}
