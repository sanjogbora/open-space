import type {
  Bounds3,
  MaterialOverride,
  ObjectOverride,
  SceneGraphDocument,
  SceneGraphMaterial,
  SceneGraphNode,
  SceneMaterialsDocument,
  SceneObjectsDocument,
  Vec3
} from "@walkthrough/scene-schema";

export interface GltfModelStats {
  format: "glb" | "gltf";
  version?: string;
  generator?: string;
  nodeCount: number;
  meshCount: number;
  primitiveCount: number;
  materialCount: number;
  textureCount: number;
  imageCount: number;
  bufferCount: number;
  bufferBytes: number;
  vertexCount: number;
  triangleCount: number;
  extensionCount: number;
  requiredExtensionCount: number;
}

interface GltfAccessor {
  count?: number;
  min?: Vec3;
  max?: Vec3;
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfMesh {
  name?: string;
  primitives?: readonly GltfPrimitive[];
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: readonly number[];
  matrix?: readonly number[];
  translation?: Vec3;
  rotation?: readonly [number, number, number, number];
  scale?: Vec3;
}

interface GltfBuffer {
  byteLength?: number;
}

interface GltfDocument {
  asset?: {
    version?: string;
    generator?: string;
  };
  accessors?: readonly GltfAccessor[];
  buffers?: readonly GltfBuffer[];
  nodes?: readonly GltfNode[];
  meshes?: readonly GltfMesh[];
  materials?: readonly unknown[];
  textures?: readonly unknown[];
  images?: readonly unknown[];
  extensionsUsed?: readonly string[];
  extensionsRequired?: readonly string[];
}

export function parseGlbJson(bytes: Uint8Array): GltfDocument {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);

  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error("Invalid GLB header.");
  }

  const jsonChunkLength = view.getUint32(12, true);
  const jsonChunkType = view.getUint32(16, true);

  if (jsonChunkType !== 0x4e4f534a) {
    throw new Error("GLB JSON chunk is missing.");
  }

  const jsonBytes = bytes.slice(20, 20 + jsonChunkLength);
  const jsonText = new TextDecoder().decode(jsonBytes).trim();
  return JSON.parse(jsonText) as GltfDocument;
}

export function analyzeGltfModel(document: GltfDocument, format: "glb" | "gltf"): GltfModelStats {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;

  for (const mesh of meshes) {
    for (const primitive of mesh.primitives ?? []) {
      primitiveCount += 1;
      const positionAccessorIndex = primitive.attributes?.["POSITION"];
      const positionAccessor =
        typeof positionAccessorIndex === "number" ? accessors[positionAccessorIndex] : undefined;
      const indexAccessor =
        typeof primitive.indices === "number" ? accessors[primitive.indices] : undefined;
      const vertices = positionAccessor?.count ?? 0;
      vertexCount += vertices;

      if (primitive.mode === undefined || primitive.mode === 4) {
        triangleCount += Math.floor((indexAccessor?.count ?? vertices) / 3);
      }
    }
  }

  const stats: GltfModelStats = {
    format,
    nodeCount: document.nodes?.length ?? 0,
    meshCount: meshes.length,
    primitiveCount,
    materialCount: document.materials?.length ?? 0,
    textureCount: document.textures?.length ?? 0,
    imageCount: document.images?.length ?? 0,
    bufferCount: document.buffers?.length ?? 0,
    bufferBytes: (document.buffers ?? []).reduce((sum, buffer) => sum + (buffer.byteLength ?? 0), 0),
    vertexCount,
    triangleCount,
    extensionCount: document.extensionsUsed?.length ?? 0,
    requiredExtensionCount: document.extensionsRequired?.length ?? 0
  };

  if (document.asset?.version) {
    stats.version = document.asset.version;
  }

  if (document.asset?.generator) {
    stats.generator = document.asset.generator;
  }

  return stats;
}

function stableName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function materialId(index: number, name: string): string {
  return `mat-${index}-${slug(name) || "material"}`;
}

function factorToHex(factor: unknown): string | undefined {
  if (!Array.isArray(factor) || factor.length < 3) {
    return undefined;
  }
  const channels = factor.slice(0, 3).map((channel) => {
    const value = typeof channel === "number" ? channel : 1;
    return Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function nodeId(index: number, name: string): string {
  return `node-${index}-${slug(name) || "object"}`;
}

function mergeBounds(current: Bounds3 | undefined, next: Bounds3 | undefined): Bounds3 | undefined {
  if (!next) {
    return current;
  }
  if (!current) {
    return {
      min: [...next.min] as unknown as Vec3,
      max: [...next.max] as unknown as Vec3
    };
  }
  return {
    min: [
      Math.min(current.min[0], next.min[0]),
      Math.min(current.min[1], next.min[1]),
      Math.min(current.min[2], next.min[2])
    ],
    max: [
      Math.max(current.max[0], next.max[0]),
      Math.max(current.max[1], next.max[1]),
      Math.max(current.max[2], next.max[2])
    ]
  };
}

function accessorBounds(accessor: GltfAccessor | undefined): Bounds3 | undefined {
  if (!accessor?.min || !accessor.max) {
    return undefined;
  }
  return {
    min: accessor.min,
    max: accessor.max
  };
}

type Mat4 = readonly number[];

const identityMatrix: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function matrixValue(matrix: Mat4, index: number): number {
  return matrix[index] ?? 0;
}

function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        matrixValue(a, 0 * 4 + row) * matrixValue(b, column * 4 + 0) +
        matrixValue(a, 1 * 4 + row) * matrixValue(b, column * 4 + 1) +
        matrixValue(a, 2 * 4 + row) * matrixValue(b, column * 4 + 2) +
        matrixValue(a, 3 * 4 + row) * matrixValue(b, column * 4 + 3);
    }
  }
  return result;
}

function nodeLocalMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) {
    return [...node.matrix];
  }
  const translation = node.translation ?? [0, 0, 0];
  const scale = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = scale[0];
  const sy = scale[1];
  const sz = scale[2];
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    translation[0],
    translation[1],
    translation[2],
    1
  ];
}

function transformPoint(matrix: Mat4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    matrixValue(matrix, 0) * x + matrixValue(matrix, 4) * y + matrixValue(matrix, 8) * z + matrixValue(matrix, 12),
    matrixValue(matrix, 1) * x + matrixValue(matrix, 5) * y + matrixValue(matrix, 9) * z + matrixValue(matrix, 13),
    matrixValue(matrix, 2) * x + matrixValue(matrix, 6) * y + matrixValue(matrix, 10) * z + matrixValue(matrix, 14)
  ];
}

function transformBounds(bounds: Bounds3 | undefined, matrix: Mat4): Bounds3 | undefined {
  if (!bounds) {
    return undefined;
  }
  const localCorners: Vec3[] = [
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.min[2]],
    [bounds.min[0], bounds.max[1], bounds.min[2]],
    [bounds.max[0], bounds.max[1], bounds.min[2]],
    [bounds.min[0], bounds.min[1], bounds.max[2]],
    [bounds.max[0], bounds.min[1], bounds.max[2]],
    [bounds.min[0], bounds.max[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]]
  ];
  const corners = localCorners.map((corner) => transformPoint(matrix, corner));
  return corners.reduce(
    (current, point) => mergeBounds(current, { min: point, max: point })!,
    undefined as Bounds3 | undefined
  );
}

export function extractSceneGraph(document: GltfDocument, source: string): SceneGraphDocument {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  const documentNodes = document.nodes ?? [];
  const materialUsage = new Map<number, SceneGraphMaterial>();
  const nodes: SceneGraphNode[] = [];
  const parentByChild = new Map<number, number>();

  documentNodes.forEach((node, nodeIndex) => {
    for (const childIndex of node.children ?? []) {
      parentByChild.set(childIndex, nodeIndex);
    }
  });

  const worldMatrixByNode = new Map<number, Mat4>();
  const worldMatrix = (nodeIndex: number): Mat4 => {
    const cached = worldMatrixByNode.get(nodeIndex);
    if (cached) {
      return cached;
    }
    const node = documentNodes[nodeIndex];
    if (!node) {
      return identityMatrix;
    }
    const local = nodeLocalMatrix(node);
    const parentIndex = parentByChild.get(nodeIndex);
    const matrix = typeof parentIndex === "number" ? multiplyMat4(worldMatrix(parentIndex), local) : local;
    worldMatrixByNode.set(nodeIndex, matrix);
    return matrix;
  };

  documentNodes.forEach((node, sourceIndex) => {
    const name = stableName(node.name, `Object ${sourceIndex}`);
    const mesh = typeof node.mesh === "number" ? meshes[node.mesh] : undefined;
    const materialIds = new Set<string>();
    let vertexCount = 0;
    let triangleCount = 0;
    let bounds: Bounds3 | undefined;
    const matrix = worldMatrix(sourceIndex);

    for (const primitive of mesh?.primitives ?? []) {
      const positionAccessorIndex = primitive.attributes?.["POSITION"];
      const positionAccessor =
        typeof positionAccessorIndex === "number" ? accessors[positionAccessorIndex] : undefined;
      const indexAccessor =
        typeof primitive.indices === "number" ? accessors[primitive.indices] : undefined;
      const vertices = positionAccessor?.count ?? 0;
      const triangles =
        primitive.mode === undefined || primitive.mode === 4
          ? Math.floor((indexAccessor?.count ?? vertices) / 3)
          : 0;
      vertexCount += vertices;
      triangleCount += triangles;
      bounds = mergeBounds(bounds, transformBounds(accessorBounds(positionAccessor), matrix));

      if (typeof primitive.material === "number") {
        const materialName = stableName(
          (document.materials?.[primitive.material] as { name?: string } | undefined)?.name,
          `Material ${primitive.material}`
        );
        const id = materialId(primitive.material, materialName);
        materialIds.add(id);
        const current = materialUsage.get(primitive.material) ?? {
          id,
          name: materialName,
          meshCount: 0,
          primitiveCount: 0,
          triangleCount: 0
        };
        materialUsage.set(primitive.material, {
          ...current,
          meshCount: current.meshCount + 1,
          primitiveCount: current.primitiveCount + 1,
          triangleCount: current.triangleCount + triangles
        });
      }
    }

    const parentIndex = parentByChild.get(sourceIndex);
    const graphNode: SceneGraphNode = {
      id: nodeId(sourceIndex, name),
      name,
      sourceIndex,
      materialIds: [...materialIds],
      vertexCount,
      triangleCount
    };

    if (typeof parentIndex === "number") {
      const parent = document.nodes?.[parentIndex];
      graphNode.parentId = nodeId(parentIndex, stableName(parent?.name, `Object ${parentIndex}`));
    }

    if (typeof node.mesh === "number") {
      graphNode.meshIndex = node.mesh;
      graphNode.meshName = stableName(mesh?.name, `Mesh ${node.mesh}`);
    }

    if (bounds) {
      graphNode.bounds = bounds;
    }

    nodes.push(graphNode);
  });

  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    nodes,
    materials: [...materialUsage.values()]
  };
}

export function extractMaterialsDocument(
  document: GltfDocument,
  source: string
): SceneMaterialsDocument {
  const materials = (document.materials ?? []).map((material, index): MaterialOverride => {
    const record = material as {
      name?: string;
      pbrMetallicRoughness?: {
        baseColorFactor?: unknown;
        roughnessFactor?: number;
        metallicFactor?: number;
      };
      alphaMode?: string;
    };
    const name = stableName(record.name, `Material ${index}`);
    const override: MaterialOverride = {
      id: materialId(index, name),
      name
    };

    const baseColor = factorToHex(record.pbrMetallicRoughness?.baseColorFactor);
    if (baseColor) {
      override.baseColor = baseColor;
    }

    if (typeof record.pbrMetallicRoughness?.roughnessFactor === "number") {
      override.roughness = record.pbrMetallicRoughness.roughnessFactor;
    }

    if (typeof record.pbrMetallicRoughness?.metallicFactor === "number") {
      override.metalness = record.pbrMetallicRoughness.metallicFactor;
    }

    return override;
  });

  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    materials
  };
}

export function extractObjectsDocument(
  graph: SceneGraphDocument,
  source: string
): SceneObjectsDocument {
  const objects = graph.nodes.map((node): ObjectOverride => ({
    id: node.id,
    name: node.name,
    visible: true,
    hideInTopView: objectShouldHideInTopView(node.name)
  }));

  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    objects
  };
}

function objectShouldHideInTopView(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    /(^|[^a-z])(ceiling|false-ceiling|dropped-ceiling|roof|roofing|lid|cover)([^a-z]|$)/.test(normalized) &&
    !/(^|[^a-z])(fan|light|lamp|fixture|chandelier|downlight|spotlight)([^a-z]|$)/.test(normalized)
  );
}
