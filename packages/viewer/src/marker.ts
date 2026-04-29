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

  const shape = new THREE.Shape();
  shape.moveTo(0, 0.32);
  shape.lineTo(-0.24, -0.22);
  shape.lineTo(0.24, -0.22);
  shape.closePath();

  const triangle = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({
      color: "#08a5ff",
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide
    })
  );
  triangle.rotation.x = -Math.PI / 2;
  triangle.position.y = 0.01;
  group.add(triangle);

  group.visible = false;
  return group;
}

