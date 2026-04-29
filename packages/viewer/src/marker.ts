import * as THREE from "three";

export function createMoveMarker(): THREE.Group {
  const group = new THREE.Group();
  group.name = "move-marker";

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.18, 0.26, 40),
    new THREE.MeshBasicMaterial({
      color: "#0787ff",
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide
    })
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.23, 0.58, 3, 1),
    new THREE.MeshStandardMaterial({
      color: "#0787ff",
      emissive: "#034f9f",
      emissiveIntensity: 0.35,
      roughness: 0.42,
      metalness: 0.08
    })
  );
  cone.name = "move-marker-cone";
  cone.position.y = 0.32;
  cone.rotation.y = Math.PI / 3;
  group.add(cone);

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 18, 12),
    new THREE.MeshBasicMaterial({ color: "#9ed7ff" })
  );
  cap.position.y = 0.62;
  group.add(cap);

  group.visible = false;
  return group;
}
