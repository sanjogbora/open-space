import * as THREE from "three";

export interface DemoSceneResult {
  root: THREE.Group;
  floor: THREE.Mesh;
  videoSurface: THREE.Mesh;
}

const wallMaterial = new THREE.MeshStandardMaterial({
  color: "#e8e3da",
  roughness: 0.84
});

const accentMaterial = new THREE.MeshStandardMaterial({
  color: "#8d6f57",
  roughness: 0.7
});

const floorMaterial = new THREE.MeshStandardMaterial({
  color: "#cbb89a",
  roughness: 0.62
});

const ceilingMaterial = new THREE.MeshStandardMaterial({
  color: "#f2f0eb",
  roughness: 0.9
});

const sofaMaterial = new THREE.MeshStandardMaterial({
  color: "#324f59",
  roughness: 0.78
});

const counterMaterial = new THREE.MeshStandardMaterial({
  color: "#f0f0ec",
  roughness: 0.52
});

function box(
  name: string,
  size: THREE.Vector3Tuple,
  position: THREE.Vector3Tuple,
  material: THREE.Material
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function createDemoScene(): DemoSceneResult {
  const root = new THREE.Group();
  root.name = "demo-apartment";

  const floor = box("floor_main", [12, 0.08, 9], [0, -0.04, 0], floorMaterial);
  floor.receiveShadow = true;
  floor.userData["walkable"] = true;
  root.add(floor);

  root.add(box("ceiling", [12, 0.08, 9], [0, 3.1, 0], ceilingMaterial));
  root.add(box("wall_back", [12, 3.2, 0.12], [0, 1.55, -4.5], wallMaterial));
  root.add(box("wall_front_low", [4.2, 1.8, 0.12], [-3.9, 0.85, 4.5], wallMaterial));
  root.add(box("wall_front_low_2", [4.2, 1.8, 0.12], [3.9, 0.85, 4.5], wallMaterial));
  root.add(box("wall_left", [0.12, 3.2, 9], [-6, 1.55, 0], wallMaterial));
  root.add(box("wall_right", [0.12, 3.2, 9], [6, 1.55, 0], wallMaterial));
  root.add(box("divider_wall", [0.12, 2.6, 3.6], [0.8, 1.25, 2.7], wallMaterial));

  root.add(box("sofa_base", [2.8, 0.45, 0.95], [-2.5, 0.32, -1.15], sofaMaterial));
  root.add(box("sofa_back", [2.8, 0.85, 0.22], [-2.5, 0.72, -1.68], sofaMaterial));
  root.add(box("sofa_left_arm", [0.22, 0.72, 0.95], [-3.98, 0.58, -1.15], sofaMaterial));
  root.add(box("sofa_right_arm", [0.22, 0.72, 0.95], [-1.02, 0.58, -1.15], sofaMaterial));
  root.add(box("coffee_table", [1.4, 0.16, 0.74], [-2.45, 0.36, 0.18], accentMaterial));
  root.add(box("kitchen_island", [2.5, 0.92, 0.9], [2.7, 0.46, 1.55], counterMaterial));
  root.add(box("dining_table", [1.8, 0.16, 1.0], [2.75, 0.74, -1.7], accentMaterial));
  root.add(box("bed_base", [2.1, 0.45, 1.65], [3.9, 0.32, 3.1], sofaMaterial));
  root.add(box("bed_headboard", [2.2, 1.05, 0.2], [3.9, 0.72, 4.0], accentMaterial));

  const tvBody = box("tv_body", [1.8, 1.02, 0.08], [-5.92, 1.42, -1.1], new THREE.MeshStandardMaterial({ color: "#16191d", roughness: 0.45 }));
  tvBody.rotation.y = Math.PI / 2;
  root.add(tvBody);

  const videoSurface = box(
    "tv_screen",
    [1.62, 0.86, 0.03],
    [-5.86, 1.42, -1.1],
    new THREE.MeshBasicMaterial({ color: "#1d9bd7" })
  );
  videoSurface.rotation.y = Math.PI / 2;
  videoSurface.userData["videoTarget"] = true;
  root.add(videoSurface);

  const rug = new THREE.Mesh(
    new THREE.PlaneGeometry(2.8, 1.7),
    new THREE.MeshStandardMaterial({ color: "#b64d3d", roughness: 0.8 })
  );
  rug.name = "living_room_rug";
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(-2.45, 0.012, 0.04);
  rug.receiveShadow = true;
  root.add(rug);

  return {
    root,
    floor,
    videoSurface
  };
}

