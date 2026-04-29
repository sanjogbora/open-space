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

export function extractSceneGraph(document: GltfDocument, source: string): SceneGraphDocument {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  const materialUsage = new Map<number, SceneGraphMaterial>();
  const nodes: SceneGraphNode[] = [];
  const parentByChild = new Map<number, number>();

  (document.nodes ?? []).forEach((node, nodeIndex) => {
    for (const childIndex of node.children ?? []) {
      parentByChild.set(childIndex, nodeIndex);
    }
  });

  (document.nodes ?? []).forEach((node, sourceIndex) => {
    const name = stableName(node.name, `Object ${sourceIndex}`);
    const mesh = typeof node.mesh === "number" ? meshes[node.mesh] : undefined;
    const materialIds = new Set<string>();
    let vertexCount = 0;
    let triangleCount = 0;
    let bounds: Bounds3 | undefined;

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
      bounds = mergeBounds(bounds, accessorBounds(positionAccessor));

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
    visible: true
  }));

  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    objects
  };
}
