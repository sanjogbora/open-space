import * as THREE from "three";

export function createMoveMarker(): THREE.Group {
  const group = new THREE.Group();
  group.name = "move-marker";

  const base = new THREE.Mesh(
    new THREE.CircleGeometry(0.052, 36),
    new THREE.MeshBasicMaterial({
      color: "#075177",
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide
    })
  );
  base.name = "move-marker-base";
  base.scale.set(1.18, 0.34, 1);
  base.rotation.x = -Math.PI / 2;
  group.add(base);

  const baseHighlight = new THREE.Mesh(
    new THREE.RingGeometry(0.038, 0.055, 36),
    new THREE.MeshBasicMaterial({
      color: "#2aa8ff",
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide
    })
  );
  baseHighlight.name = "move-marker-base-highlight";
  baseHighlight.scale.set(1.16, 0.34, 1);
  baseHighlight.rotation.x = -Math.PI / 2;
  baseHighlight.position.y = 0.004;
  group.add(baseHighlight);

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.046, 0.22, 32, 1, true),
    new THREE.MeshStandardMaterial({
      color: "#0c7fbe",
      emissive: "#04395f",
      emissiveIntensity: 0.28,
      roughness: 0.36,
      metalness: 0.04,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    })
  );
  cone.name = "move-marker-cone";
  cone.position.y = 0.122;
  cone.rotation.x = Math.PI;
  group.add(cone);

  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.027, 0.18, 32, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#8ed9ff",
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide
    })
  );
  core.name = "move-marker-cone-core";
  core.position.y = 0.124;
  core.rotation.x = Math.PI;
  group.add(core);

  group.visible = false;
  return group;
}
