import * as THREE from "three";

export function createMoveMarker(): THREE.Group {
  const group = new THREE.Group();
  group.name = "move-marker";

  const base = new THREE.Mesh(
    new THREE.CircleGeometry(0.08, 36),
    new THREE.MeshBasicMaterial({
      color: "#075177",
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide
    })
  );
  base.name = "move-marker-base";
  base.scale.set(1.15, 0.38, 1);
  base.rotation.x = -Math.PI / 2;
  group.add(base);

  const baseHighlight = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.085, 36),
    new THREE.MeshBasicMaterial({
      color: "#2aa8ff",
      transparent: true,
      opacity: 0.68,
      side: THREE.DoubleSide
    })
  );
  baseHighlight.name = "move-marker-base-highlight";
  baseHighlight.scale.set(1.12, 0.38, 1);
  baseHighlight.rotation.x = -Math.PI / 2;
  baseHighlight.position.y = 0.004;
  group.add(baseHighlight);

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.36, 32, 1, true),
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
  cone.position.y = 0.195;
  cone.rotation.x = Math.PI;
  group.add(cone);

  const core = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.31, 32, 1, true),
    new THREE.MeshBasicMaterial({
      color: "#8ed9ff",
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide
    })
  );
  core.name = "move-marker-cone-core";
  core.position.y = 0.2;
  core.rotation.x = Math.PI;
  group.add(core);

  group.visible = false;
  return group;
}
