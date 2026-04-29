import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const outputTargets = [
  "apps/viewer-demo/public/scenes/demo/scene.glb",
  "apps/studio/public/scenes/demo/scene.glb"
];

const materials = [
  { name: "Floor", color: [0.58, 0.51, 0.41, 1], roughness: 0.62 },
  { name: "Wall", color: [0.62, 0.61, 0.56, 1], roughness: 0.84 },
  { name: "Ceiling", color: [0.74, 0.72, 0.66, 1], roughness: 0.9 },
  { name: "Sofa", color: [0.02, 0.12, 0.15, 1], roughness: 0.78 },
  { name: "Wood", color: [0.35, 0.25, 0.17, 1], roughness: 0.7 },
  { name: "Counter", color: [0.76, 0.76, 0.7, 1], roughness: 0.52 },
  { name: "TVBody", color: [0.01, 0.015, 0.02, 1], roughness: 0.45 },
  { name: "TVScreen", color: [0.02, 0.5, 0.9, 1], roughness: 0.25 },
  { name: "Rug", color: [0.54, 0.14, 0.1, 1], roughness: 0.8 }
];

const objects = [
  ["floor_main", [12, 0.08, 9], [0, -0.04, 0], 0],
  ["ceiling", [12, 0.08, 9], [0, 3.1, 0], 2],
  ["wall_back", [12, 3.2, 0.12], [0, 1.55, -4.5], 1],
  ["wall_front_low", [4.2, 1.8, 0.12], [-3.9, 0.85, 4.5], 1],
  ["wall_front_low_2", [4.2, 1.8, 0.12], [3.9, 0.85, 4.5], 1],
  ["wall_left", [0.12, 3.2, 9], [-6, 1.55, 0], 1],
  ["wall_right", [0.12, 3.2, 9], [6, 1.55, 0], 1],
  ["divider_wall", [0.12, 2.6, 3.6], [0.8, 1.25, 2.7], 1],
  ["sofa_base", [2.8, 0.45, 0.95], [-2.5, 0.32, -1.15], 3],
  ["sofa_back", [2.8, 0.85, 0.22], [-2.5, 0.72, -1.68], 3],
  ["sofa_left_arm", [0.22, 0.72, 0.95], [-3.98, 0.58, -1.15], 3],
  ["sofa_right_arm", [0.22, 0.72, 0.95], [-1.02, 0.58, -1.15], 3],
  ["coffee_table", [1.4, 0.16, 0.74], [-2.45, 0.36, 0.18], 4],
  ["kitchen_island", [2.5, 0.92, 0.9], [2.7, 0.46, 1.55], 5],
  ["dining_table", [1.8, 0.16, 1.0], [2.75, 0.74, -1.7], 4],
  ["bed_base", [2.1, 0.45, 1.65], [3.9, 0.32, 3.1], 3],
  ["bed_headboard", [2.2, 1.05, 0.2], [3.9, 0.72, 4.0], 4],
  ["tv_body", [0.08, 1.02, 1.8], [-5.92, 1.42, -1.1], 6],
  ["tv_screen", [0.03, 0.86, 1.62], [-5.86, 1.42, -1.1], 7],
  ["living_room_rug", [2.8, 0.035, 1.7], [-2.45, 0.02, 0.04], 8]
];

function boxGeometry(size, center) {
  const [sx, sy, sz] = size.map((value) => value / 2);
  const [cx, cy, cz] = center;
  const faces = [
    { normal: [1, 0, 0], corners: [[sx, -sy, -sz], [sx, -sy, sz], [sx, sy, sz], [sx, sy, -sz]] },
    { normal: [-1, 0, 0], corners: [[-sx, -sy, sz], [-sx, -sy, -sz], [-sx, sy, -sz], [-sx, sy, sz]] },
    { normal: [0, 1, 0], corners: [[-sx, sy, -sz], [sx, sy, -sz], [sx, sy, sz], [-sx, sy, sz]] },
    { normal: [0, -1, 0], corners: [[-sx, -sy, sz], [sx, -sy, sz], [sx, -sy, -sz], [-sx, -sy, -sz]] },
    { normal: [0, 0, 1], corners: [[sx, -sy, sz], [-sx, -sy, sz], [-sx, sy, sz], [sx, sy, sz]] },
    { normal: [0, 0, -1], corners: [[-sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz], [-sx, sy, -sz]] }
  ];
  const positions = [];
  const normals = [];
  const texcoords = [];
  const indices = [];
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];

  for (const face of faces) {
    const offset = positions.length / 3;
    for (const [index, corner] of face.corners.entries()) {
      positions.push(corner[0] + cx, corner[1] + cy, corner[2] + cz);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
      texcoords.push(uv[index][0], uv[index][1]);
    }
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    texcoords: new Float32Array(texcoords),
    indices: new Uint16Array(indices)
  };
}

function minMax(values) {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < values.length; index += 3) {
    min[0] = Math.min(min[0], values[index]);
    min[1] = Math.min(min[1], values[index + 1]);
    min[2] = Math.min(min[2], values[index + 2]);
    max[0] = Math.max(max[0], values[index]);
    max[1] = Math.max(max[1], values[index + 1]);
    max[2] = Math.max(max[2], values[index + 2]);
  }
  return { min, max };
}

function align4(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function pushBufferView(binaryParts, buffer, target) {
  const byteOffset = binaryParts.reduce((sum, part) => sum + part.length, 0);
  const padded = align4(buffer);
  binaryParts.push(padded);
  return {
    buffer: 0,
    byteOffset,
    byteLength: buffer.length,
    target
  };
}

function typedBuffer(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

const binaryParts = [];
const bufferViews = [];
const accessors = [];
const meshes = [];
const nodes = [];

for (const [name, size, position, material] of objects) {
  const geometry = boxGeometry(size, position);
  const positionStats = minMax(geometry.positions);

  const positionBufferView = bufferViews.push(
    pushBufferView(binaryParts, typedBuffer(geometry.positions), 34962)
  ) - 1;
  const normalBufferView = bufferViews.push(
    pushBufferView(binaryParts, typedBuffer(geometry.normals), 34962)
  ) - 1;
  const uvBufferView = bufferViews.push(
    pushBufferView(binaryParts, typedBuffer(geometry.texcoords), 34962)
  ) - 1;
  const indexBufferView = bufferViews.push(
    pushBufferView(binaryParts, typedBuffer(geometry.indices), 34963)
  ) - 1;

  const positionAccessor = accessors.push({
    bufferView: positionBufferView,
    byteOffset: 0,
    componentType: 5126,
    count: geometry.positions.length / 3,
    type: "VEC3",
    min: positionStats.min,
    max: positionStats.max
  }) - 1;
  const normalAccessor = accessors.push({
    bufferView: normalBufferView,
    byteOffset: 0,
    componentType: 5126,
    count: geometry.normals.length / 3,
    type: "VEC3"
  }) - 1;
  const uvAccessor = accessors.push({
    bufferView: uvBufferView,
    byteOffset: 0,
    componentType: 5126,
    count: geometry.texcoords.length / 2,
    type: "VEC2"
  }) - 1;
  const indexAccessor = accessors.push({
    bufferView: indexBufferView,
    byteOffset: 0,
    componentType: 5123,
    count: geometry.indices.length,
    type: "SCALAR"
  }) - 1;

  const meshIndex = meshes.push({
    name,
    primitives: [
      {
        attributes: {
          POSITION: positionAccessor,
          NORMAL: normalAccessor,
          TEXCOORD_0: uvAccessor
        },
        indices: indexAccessor,
        material
      }
    ]
  }) - 1;

  nodes.push({
    name,
    mesh: meshIndex
  });
}

const binary = Buffer.concat(binaryParts);
const gltf = {
  asset: {
    version: "2.0",
    generator: "Walkthrough Studio demo generator"
  },
  scene: 0,
  scenes: [{ name: "Demo Residence", nodes: nodes.map((_, index) => index) }],
  nodes,
  meshes,
  materials: materials.map((material) => ({
    name: material.name,
    pbrMetallicRoughness: {
      baseColorFactor: material.color,
      metallicFactor: 0,
      roughnessFactor: material.roughness
    }
  })),
  accessors,
  bufferViews,
  buffers: [{ byteLength: binary.length }]
};

const json = align4(Buffer.from(JSON.stringify(gltf), "utf8"));
const bin = align4(binary);
const totalLength = 12 + 8 + json.length + 8 + bin.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

const glb = Buffer.concat([header, jsonHeader, json, binHeader, bin]);

for (const target of outputTargets) {
  const outputPath = path.resolve(target);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, glb);
  console.log(`Wrote ${outputPath} (${glb.length} bytes)`);
}

