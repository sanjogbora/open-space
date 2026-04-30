import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--")) ?? "apps/viewer-demo/public/scenes/demo";
const writeStats = args.includes("--write");
const manifestPath = target.endsWith(".json")
  ? path.resolve(target)
  : path.resolve(target, "scene.manifest.json");
const bundleDir = path.dirname(manifestPath);
const imageExtensions = new Set([".avif", ".basis", ".jpg", ".jpeg", ".ktx2", ".png", ".webp"]);

const defaultBudget = {
  maxTotalBytes: 160 * 1024 * 1024,
  maxModelBytes: 70 * 1024 * 1024,
  maxVideoBytes: 45 * 1024 * 1024,
  maxInteractionCount: 80,
  maxMobileTriangles: 4_000_000,
  maxMobileMaterials: 180
};

const optimizationProfiles = [
  {
    id: "mobile",
    label: "Mobile",
    budgets: {
      maxTotalBytes: 80 * 1024 * 1024,
      maxModelBytes: 36 * 1024 * 1024,
      maxTriangles: 1_500_000,
      maxMaterials: 80,
      maxMeshes: 300
    }
  },
  {
    id: "balanced",
    label: "Balanced",
    budgets: {
      maxTotalBytes: 140 * 1024 * 1024,
      maxModelBytes: 64 * 1024 * 1024,
      maxTriangles: 4_000_000,
      maxMaterials: 160,
      maxMeshes: 700
    }
  },
  {
    id: "desktop",
    label: "Desktop",
    budgets: {
      maxTotalBytes: 260 * 1024 * 1024,
      maxModelBytes: 120 * 1024 * 1024,
      maxTriangles: 8_000_000,
      maxMaterials: 320,
      maxMeshes: 1400
    }
  }
];

function isExternalAsset(source) {
  return (
    source.startsWith("generated://") ||
    source.startsWith("data:") ||
    source.startsWith("blob:") ||
    source.startsWith("http://") ||
    source.startsWith("https://")
  );
}

function collectAssetReferences(manifest) {
  const assets = [];

  if (manifest.sceneUrl && !isExternalAsset(manifest.sceneUrl)) {
    assets.push({ kind: "model", source: manifest.sceneUrl, label: "Scene model" });
  }

  for (const interaction of manifest.interactions ?? []) {
    if (interaction.kind === "video-texture" && interaction.source && !isExternalAsset(interaction.source)) {
      assets.push({ kind: "video", source: interaction.source, label: interaction.label });
    }
  }

  if (manifest.branding?.logoUrl && !isExternalAsset(manifest.branding.logoUrl)) {
    assets.push({ kind: "image", source: manifest.branding.logoUrl, label: "Brand logo" });
  }

  return assets;
}

async function assetSize(reference) {
  const fullPath = path.resolve(bundleDir, reference.source);
  try {
    await access(fullPath);
    const info = await stat(fullPath);
    return {
      ...reference,
      path: fullPath,
      exists: true,
      bytes: info.size
    };
  } catch {
    return {
      ...reference,
      path: fullPath,
      exists: false,
      bytes: 0
    };
  }
}

function isLocalGltfUri(uri) {
  return (
    typeof uri === "string" &&
    uri.trim().length > 0 &&
    !uri.startsWith("data:") &&
    !uri.startsWith("blob:") &&
    !uri.startsWith("http://") &&
    !uri.startsWith("https://")
  );
}

async function resourceStatus(asset, kind, source, label) {
  const localSource = stripLocalResourceUri(source);
  const fullPath = path.resolve(path.dirname(asset.path), localSource);
  try {
    await access(fullPath);
    const info = await stat(fullPath);
    const metadata = kind === "texture" ? await imageMetadata(fullPath) : undefined;
    return {
      kind,
      source: localSource,
      label,
      exists: true,
      bytes: info.size,
      ...(metadata ? { width: metadata.width, height: metadata.height } : {})
    };
  } catch {
    return {
      kind,
      source: localSource,
      label,
      exists: false,
      bytes: 0
    };
  }
}

async function imageMetadata(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ktx2" || extension === ".basis") {
    return undefined;
  }
  try {
    const metadata = await sharp(filePath).metadata();
    if (typeof metadata.width !== "number" || typeof metadata.height !== "number") {
      return undefined;
    }
    return {
      width: metadata.width,
      height: metadata.height
    };
  } catch {
    return undefined;
  }
}

function stripLocalResourceUri(source) {
  const clean = String(source).split(/[?#]/, 1)[0].replace(/\\/g, "/");
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function normalizeBundlePath(source) {
  return stripLocalResourceUri(source).replace(/^\.?\//, "").toLowerCase();
}

async function listBundleImageFiles(dir = bundleDir, files = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = normalizeBundlePath(path.relative(bundleDir, fullPath));
    if (entry.isDirectory()) {
      if (["dist", "node_modules", ".git"].includes(entry.name)) {
        continue;
      }
      await listBundleImageFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      const info = await stat(fullPath);
      const metadata = await imageMetadata(fullPath);
      files.push({
        source: relativePath,
        bytes: info.size,
        ...(metadata ? { width: metadata.width, height: metadata.height } : {})
      });
    }
  }

  return files;
}

async function looseBundleImages(assets, models) {
  const referenced = new Set(
    [
      ...assets.map((asset) => asset.source),
      ...models.flatMap((model) => (model.externalResources ?? []).map((resource) => resource.source))
    ]
      .filter(Boolean)
      .map(normalizeBundlePath)
  );
  const imageFiles = await listBundleImageFiles();
  return imageFiles.filter((image) => !referenced.has(normalizeBundlePath(image.source)));
}

function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20) {
    throw new Error("GLB is too small to contain a valid header.");
  }
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);

  if (magic !== 0x46546c67 || version !== 2) {
    throw new Error("Invalid GLB header.");
  }
  if (totalLength > bytes.byteLength) {
    throw new Error("GLB header length is larger than the file.");
  }

  let offset = 12;
  let document;
  let binBytes = 0;
  while (offset + 8 <= Math.min(totalLength, bytes.byteLength)) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) {
      throw new Error("GLB chunk length extends past the file end.");
    }
    if (chunkType === 0x4e4f534a) {
      document = JSON.parse(new TextDecoder().decode(bytes.slice(chunkStart, chunkEnd)).trim());
    } else if (chunkType === 0x004e4942) {
      binBytes += chunkLength;
    }
    offset = chunkEnd + (chunkLength % 4 === 0 ? 0 : 4 - (chunkLength % 4));
  }

  if (!document) {
    throw new Error("GLB JSON chunk is missing.");
  }
  return { document, binBytes };
}

function parseGlbJson(bytes) {
  return parseGlb(bytes).document;
}

async function analyzeGltfDocument(document, format, asset, metadata = {}) {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  const materials = document.materials ?? [];
  const extensionsUsed = document.extensionsUsed ?? [];
  const extensionsRequired = document.extensionsRequired ?? [];
  const supportedRequiredExtensions = new Set([
    "KHR_draco_mesh_compression",
    "KHR_lights_punctual",
    "KHR_materials_clearcoat",
    "KHR_materials_emissive_strength",
    "KHR_materials_ior",
    "KHR_materials_iridescence",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_transmission",
    "KHR_materials_unlit",
    "KHR_materials_variants",
    "KHR_materials_volume",
    "KHR_mesh_quantization",
    "KHR_texture_basisu",
    "KHR_texture_transform",
    "EXT_meshopt_compression",
    "EXT_texture_webp"
  ]);
  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let usesDraco = extensionsUsed.includes("KHR_draco_mesh_compression");
  let missingPositionPrimitiveCount = 0;
  let missingNormalPrimitiveCount = 0;
  let missingUvPrimitiveCount = 0;
  let uv1PrimitiveCount = 0;
  let texturedMissingUvPrimitiveCount = 0;
  let missingPositionBoundsPrimitiveCount = 0;
  let invalidAccessorReferenceCount = 0;
  let invalidTextureReferenceCount = 0;
  let undersizedBufferCount = 0;
  let texturesMissingImageCount = 0;
  let nonTrianglePrimitiveCount = 0;
  let vertexColorPrimitiveCount = 0;
  const texturedMaterialIndices = new Set(
    materials
      .map((material, index) => (materialUsesTexture(material) ? index : undefined))
      .filter((index) => typeof index === "number")
  );

  for (const mesh of meshes) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) {
        usesDraco = true;
      }
      primitiveCount += 1;
      const positionAccessorIndex = primitive.attributes?.POSITION;
      const attributeIndices = Object.values(primitive.attributes ?? {});
      for (const accessorIndex of [
        ...attributeIndices,
        ...(typeof primitive.indices === "number" ? [primitive.indices] : [])
      ]) {
        if (
          typeof accessorIndex !== "number" ||
          accessorIndex < 0 ||
          accessorIndex >= accessors.length
        ) {
          invalidAccessorReferenceCount += 1;
        }
      }
      if (typeof positionAccessorIndex !== "number") {
        missingPositionPrimitiveCount += 1;
      }
      if (typeof primitive.attributes?.NORMAL !== "number") {
        missingNormalPrimitiveCount += 1;
      }
      if (typeof primitive.attributes?.TEXCOORD_0 !== "number") {
        missingUvPrimitiveCount += 1;
        if (typeof primitive.material === "number" && texturedMaterialIndices.has(primitive.material)) {
          texturedMissingUvPrimitiveCount += 1;
        }
      }
      if (typeof primitive.attributes?.TEXCOORD_1 === "number") {
        uv1PrimitiveCount += 1;
      }
      if (typeof primitive.attributes?.COLOR_0 === "number") {
        vertexColorPrimitiveCount += 1;
      }
      const positionAccessor =
        typeof positionAccessorIndex === "number" ? accessors[positionAccessorIndex] : undefined;
      const indexAccessor =
        typeof primitive.indices === "number" ? accessors[primitive.indices] : undefined;
      if (positionAccessor && (!Array.isArray(positionAccessor.min) || !Array.isArray(positionAccessor.max))) {
        missingPositionBoundsPrimitiveCount += 1;
      }
      const vertices = positionAccessor?.count ?? 0;
      vertexCount += vertices;

      if (primitive.mode === undefined || primitive.mode === 4) {
        triangleCount += Math.floor((indexAccessor?.count ?? vertices) / 3);
      } else {
        nonTrianglePrimitiveCount += 1;
      }
    }
  }

  const externalResourceRefs = [
    ...(document.images ?? [])
      .map((image, index) => ({
        kind: "texture",
        source: image.uri,
        label: image.name || `Image ${index}`
      }))
      .filter((reference) => isLocalGltfUri(reference.source)),
    ...(document.buffers ?? [])
      .map((buffer, index) => ({
        kind: "buffer",
        source: buffer.uri,
        label: buffer.name || `Buffer ${index}`
      }))
      .filter((reference) => isLocalGltfUri(reference.source))
  ];
  const externalResources = await Promise.all(
    externalResourceRefs.map((reference) =>
      resourceStatus(asset, reference.kind, reference.source, reference.label)
    )
  );
  const externalResourceBySource = new Map(
    externalResources.map((resource) => [normalizeBundlePath(resource.source), resource])
  );
  for (const [bufferIndex, buffer] of (document.buffers ?? []).entries()) {
    if (isLocalGltfUri(buffer.uri)) {
      const resource = externalResourceBySource.get(normalizeBundlePath(buffer.uri));
      if (resource?.exists && typeof buffer.byteLength === "number" && resource.bytes < buffer.byteLength) {
        undersizedBufferCount += 1;
      }
      continue;
    }
    if (!buffer.uri && format === "glb" && bufferIndex === 0 && typeof buffer.byteLength === "number") {
      if ((metadata.glbBinBytes ?? 0) < buffer.byteLength) {
        undersizedBufferCount += 1;
      }
    }
    if (!buffer.uri && format === "gltf") {
      undersizedBufferCount += 1;
    }
  }
  const usesMeshopt =
    extensionsUsed.includes("EXT_meshopt_compression") ||
    (document.bufferViews ?? []).some((view) => Boolean(view.extensions?.EXT_meshopt_compression));
  const usesBasisu =
    extensionsUsed.includes("KHR_texture_basisu") ||
    (document.textures ?? []).some((texture) => Boolean(texture.extensions?.KHR_texture_basisu));
  const usesWebp =
    extensionsUsed.includes("EXT_texture_webp") ||
    (document.textures ?? []).some((texture) => Boolean(texture.extensions?.EXT_texture_webp));
  for (const texture of document.textures ?? []) {
    const imageRefs = [
      texture?.source,
      texture?.extensions?.KHR_texture_basisu?.source,
      texture?.extensions?.EXT_texture_webp?.source
    ].filter((source) => typeof source === "number");
    if (imageRefs.length === 0) {
      texturesMissingImageCount += 1;
      continue;
    }
    invalidTextureReferenceCount += imageRefs.filter(
      (source) => source < 0 || source >= (document.images?.length ?? 0)
    ).length;
  }
  for (const material of materials) {
    for (const textureIndex of materialTextureIndices(material)) {
      if (textureIndex < 0 || textureIndex >= (document.textures?.length ?? 0)) {
        invalidTextureReferenceCount += 1;
      }
    }
  }

  return {
    format,
    version: document.asset?.version,
    generator: document.asset?.generator,
    nodeCount: document.nodes?.length ?? 0,
    meshCount: meshes.length,
    primitiveCount,
    materialCount: materials.length,
    textureCount: document.textures?.length ?? 0,
    imageCount: document.images?.length ?? 0,
    bufferCount: document.buffers?.length ?? 0,
    bufferBytes: (document.buffers ?? []).reduce((sum, buffer) => sum + (buffer.byteLength ?? 0), 0),
    vertexCount,
    triangleCount,
    extensionCount: extensionsUsed.length,
    requiredExtensionCount: document.extensionsRequired?.length ?? 0,
    unsupportedRequiredExtensions: extensionsRequired.filter((extension) => !supportedRequiredExtensions.has(extension)),
    missingPositionPrimitiveCount,
    missingNormalPrimitiveCount,
    missingUvPrimitiveCount,
    uv1PrimitiveCount,
    texturedMissingUvPrimitiveCount,
    missingPositionBoundsPrimitiveCount,
    invalidAccessorReferenceCount,
    invalidTextureReferenceCount,
    undersizedBufferCount,
    texturesMissingImageCount,
    nonTrianglePrimitiveCount,
    vertexColorPrimitiveCount,
    transparentMaterialCount: materials.filter(materialIsTransparent).length,
    doubleSidedMaterialCount: materials.filter((material) => material?.doubleSided === true).length,
    unlitMaterialCount: materials.filter((material) => Boolean(material?.extensions?.KHR_materials_unlit)).length,
    transmissionMaterialCount: materials.filter((material) =>
      Boolean(material?.extensions?.KHR_materials_transmission || material?.extensions?.KHR_materials_volume)
    ).length,
    compression: {
      meshopt: usesMeshopt,
      draco: usesDraco,
      basisu: usesBasisu,
      webp: usesWebp
    },
    externalResourceCount: externalResources.length,
    missingExternalResourceCount: externalResources.filter((resource) => !resource.exists).length,
    externalResources
  };
}

function materialUsesTexture(material) {
  if (!material || typeof material !== "object") {
    return false;
  }
  const pbr = material.pbrMetallicRoughness ?? {};
  return Boolean(
    pbr.baseColorTexture ||
      pbr.metallicRoughnessTexture ||
      material.normalTexture ||
      material.occlusionTexture ||
      material.emissiveTexture ||
      Object.values(material.extensions ?? {}).some((extension) =>
        extension && typeof extension === "object" && Object.keys(extension).some((key) => key.endsWith("Texture"))
      )
  );
}

function materialTextureIndices(value, indices = []) {
  if (!value || typeof value !== "object") {
    return indices;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("Texture") && child && typeof child === "object" && typeof child.index === "number") {
      indices.push(child.index);
    }
    if (child && typeof child === "object") {
      materialTextureIndices(child, indices);
    }
  }
  return indices;
}

function materialIsTransparent(material) {
  if (!material || typeof material !== "object") {
    return false;
  }
  if (material.alphaMode === "BLEND" || material.alphaMode === "MASK") {
    return true;
  }
  const baseColor = material.pbrMetallicRoughness?.baseColorFactor;
  return Array.isArray(baseColor) && typeof baseColor[3] === "number" && baseColor[3] < 0.999;
}

function stableName(value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : fallback;
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function materialId(index, name) {
  return `mat-${index}-${slug(name) || "material"}`;
}

function factorToHex(factor) {
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

function nodeId(index, name) {
  return `node-${index}-${slug(name) || "object"}`;
}

function accessorBounds(accessor) {
  if (!accessor?.min || !accessor.max) {
    return undefined;
  }
  return {
    min: accessor.min,
    max: accessor.max
  };
}

function mergeBounds(current, next) {
  if (!next) {
    return current;
  }
  if (!current) {
    return {
      min: [...next.min],
      max: [...next.max]
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

const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiplyMat4(a, b) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      result[column * 4 + row] =
        a[0 * 4 + row] * b[column * 4 + 0] +
        a[1 * 4 + row] * b[column * 4 + 1] +
        a[2 * 4 + row] * b[column * 4 + 2] +
        a[3 * 4 + row] * b[column * 4 + 3];
    }
  }
  return result;
}

function nodeLocalMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) {
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

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  ];
}

function transformBounds(bounds, matrix) {
  if (!bounds) {
    return undefined;
  }
  return [
    [bounds.min[0], bounds.min[1], bounds.min[2]],
    [bounds.max[0], bounds.min[1], bounds.min[2]],
    [bounds.min[0], bounds.max[1], bounds.min[2]],
    [bounds.max[0], bounds.max[1], bounds.min[2]],
    [bounds.min[0], bounds.min[1], bounds.max[2]],
    [bounds.max[0], bounds.min[1], bounds.max[2]],
    [bounds.min[0], bounds.max[1], bounds.max[2]],
    [bounds.max[0], bounds.max[1], bounds.max[2]]
  ]
    .map((corner) => transformPoint(matrix, corner))
    .reduce((current, point) => mergeBounds(current, { min: point, max: point }), undefined);
}

function extractSceneGraph(document, source) {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  const documentNodes = document.nodes ?? [];
  const materialUsage = new Map();
  const parentByChild = new Map();
  const nodes = [];

  for (const [nodeIndex, node] of documentNodes.entries()) {
    for (const childIndex of node.children ?? []) {
      parentByChild.set(childIndex, nodeIndex);
    }
  }

  const worldMatrixByNode = new Map();
  const worldMatrix = (nodeIndex) => {
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

  for (const [sourceIndex, node] of documentNodes.entries()) {
    const name = stableName(node.name, `Object ${sourceIndex}`);
    const mesh = typeof node.mesh === "number" ? meshes[node.mesh] : undefined;
    const materialIds = new Set();
    let vertexCount = 0;
    let triangleCount = 0;
    let bounds;
    const matrix = worldMatrix(sourceIndex);

    for (const primitive of mesh?.primitives ?? []) {
      const positionAccessorIndex = primitive.attributes?.POSITION;
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
          document.materials?.[primitive.material]?.name,
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

    const graphNode = {
      id: nodeId(sourceIndex, name),
      name,
      sourceIndex,
      materialIds: [...materialIds],
      vertexCount,
      triangleCount
    };

    const parentIndex = parentByChild.get(sourceIndex);
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
  }

  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    nodes,
    materials: [...materialUsage.values()]
  };
}

function extractMaterialsDocument(document, source) {
  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    materials: (document.materials ?? []).map((material, index) => {
      const name = stableName(material.name, `Material ${index}`);
      const result = {
        id: materialId(index, name),
        name
      };
      const baseColor = factorToHex(material.pbrMetallicRoughness?.baseColorFactor);
      if (baseColor) {
        result.baseColor = baseColor;
      }
      if (typeof material.pbrMetallicRoughness?.roughnessFactor === "number") {
        result.roughness = material.pbrMetallicRoughness.roughnessFactor;
      }
      if (typeof material.pbrMetallicRoughness?.metallicFactor === "number") {
        result.metalness = material.pbrMetallicRoughness.metallicFactor;
      }
      return result;
    })
  };
}

function extractObjectsDocument(graph, source) {
  return {
    schemaVersion: "0.1",
    generator: "Walkthrough Studio analyzer",
    source,
    objects: graph.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      visible: true
    }))
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function mergeMaterialEdits(generated, existing) {
  if (!existing?.materials) {
    return generated;
  }
  const existingByName = new Map(existing.materials.map((material) => [material.name, material]));
  return {
    ...generated,
    materials: generated.materials.map((material) => {
      const previous = existingByName.get(material.name);
      if (!previous) {
        return material;
      }
      return {
        ...material,
        ...(previous.baseColor ? { baseColor: previous.baseColor } : {}),
        ...(typeof previous.roughness === "number" ? { roughness: previous.roughness } : {}),
        ...(typeof previous.metalness === "number" ? { metalness: previous.metalness } : {}),
        ...(typeof previous.opacity === "number" ? { opacity: previous.opacity } : {})
      };
    })
  };
}

function mergeObjectEdits(generated, existing) {
  if (!existing?.objects) {
    return generated;
  }
  const existingByName = new Map(existing.objects.map((object) => [object.name, object]));
  return {
    ...generated,
    objects: generated.objects.map((object) => {
      const previous = existingByName.get(object.name);
      if (!previous) {
        return object;
      }
      return {
        ...object,
        visible: previous.visible,
        ...(typeof previous.locked === "boolean" ? { locked: previous.locked } : {})
      };
    })
  };
}

async function modelStats(asset) {
  if (!asset.exists || asset.kind !== "model") {
    return undefined;
  }

  const extension = path.extname(asset.source).toLowerCase();
  try {
    if (extension === ".glb") {
      const bytes = await readFile(asset.path);
      const parsed = parseGlb(bytes);
      return analyzeGltfDocument(parsed.document, "glb", asset, { glbBinBytes: parsed.binBytes });
    }

    if (extension === ".gltf") {
      return analyzeGltfDocument(JSON.parse(await readFile(asset.path, "utf8")), "gltf", asset);
    }
  } catch (error) {
    return {
      format: extension === ".gltf" ? "gltf" : "glb",
      source: asset.source,
      parseError: error instanceof Error ? error.message : "Model could not be parsed.",
      nodeCount: 0,
      meshCount: 0,
      primitiveCount: 0,
      materialCount: 0,
      textureCount: 0,
      imageCount: 0,
      bufferCount: 0,
      bufferBytes: 0,
      vertexCount: 0,
      triangleCount: 0,
      extensionCount: 0,
      requiredExtensionCount: 0,
      externalResourceCount: 0,
      missingExternalResourceCount: 0,
      externalResources: [],
      compression: {
        meshopt: false,
        draco: false,
        basisu: false,
        webp: false
      }
    };
  }

  return undefined;
}

async function modelGraph(asset) {
  if (!asset.exists || asset.kind !== "model") {
    return undefined;
  }

  const extension = path.extname(asset.source).toLowerCase();
  try {
    if (extension === ".glb") {
      const bytes = await readFile(asset.path);
      return extractSceneGraph(parseGlbJson(bytes), asset.source);
    }

    if (extension === ".gltf") {
      return extractSceneGraph(JSON.parse(await readFile(asset.path, "utf8")), asset.source);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function modelMaterials(asset) {
  if (!asset.exists || asset.kind !== "model") {
    return undefined;
  }

  const extension = path.extname(asset.source).toLowerCase();
  try {
    if (extension === ".glb") {
      const bytes = await readFile(asset.path);
      return extractMaterialsDocument(parseGlbJson(bytes), asset.source);
    }

    if (extension === ".gltf") {
      return extractMaterialsDocument(JSON.parse(await readFile(asset.path, "utf8")), asset.source);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function graphBounds(graph) {
  const bounds = (graph?.nodes ?? []).map((node) => node.bounds).filter(Boolean);
  if (bounds.length === 0) {
    return undefined;
  }
  return bounds.reduce(
    (current, next) => ({
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
    }),
    { min: [...bounds[0].min], max: [...bounds[0].max] }
  );
}

function boundsSize(bounds) {
  if (!bounds) {
    return undefined;
  }
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];
}

function boundsArea(bounds) {
  const size = boundsSize(bounds);
  return size ? Math.abs(size[0] * size[2]) : 0;
}

function likelyExteriorPlaneName(name) {
  const normalized = String(name || "").toLowerCase();
  return [
    "terrain",
    "landscape",
    "grass",
    "lawn",
    "site",
    "environment",
    "background",
    "plane",
    "plot"
  ].some((keyword) => normalized.includes(keyword));
}

function dominantFlatPlane(graph, sceneBounds) {
  if (!graph || !sceneBounds) {
    return undefined;
  }
  const sceneArea = Math.max(1, boundsArea(sceneBounds));
  return (graph.nodes ?? [])
    .map((node) => {
      if (!node.bounds) {
        return undefined;
      }
      const size = boundsSize(node.bounds);
      if (!size) {
        return undefined;
      }
      const area = Math.abs(size[0] * size[2]);
      const flat = Math.abs(size[1]) <= Math.max(0.08, Math.min(Math.abs(size[0]), Math.abs(size[2])) * 0.04);
      const name = `${node.name} ${node.meshName ?? ""}`;
      const exteriorNamed = likelyExteriorPlaneName(name);
      if (!flat || area < sceneArea * (exteriorNamed ? 0.18 : 0.42)) {
        return undefined;
      }
      return {
        name: node.name || node.meshName || "Flat surface",
        area,
        sceneArea,
        exteriorNamed
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.area - a.area)[0];
}

function graphFocusBounds(graph) {
  const rawBounds = graphBounds(graph);
  if (!graph || !rawBounds) {
    return undefined;
  }
  const fullArea = Math.max(1, boundsArea(rawBounds));
  const focusBounds = (graph.nodes ?? [])
    .filter((node) => {
      if (!node.bounds) {
        return false;
      }
      const size = boundsSize(node.bounds);
      if (!size) {
        return false;
      }
      const [width, height, depth] = size.map(Math.abs);
      const area = Math.max(0, width * depth);
      const flat = height <= Math.max(0.08, Math.min(width, depth) * 0.04);
      const name = `${node.name} ${node.meshName ?? ""}`;
      const hugeRelativePlane = flat && area > fullArea * 0.45;
      if (likelyExteriorPlaneName(name) && (flat || area > fullArea * 0.25)) {
        return false;
      }
      if (hugeRelativePlane && area > 25) {
        return false;
      }
      return height > 0.15 || area < fullArea * 0.35;
    })
    .map((node) => node.bounds);
  if (focusBounds.length === 0) {
    return rawBounds;
  }
  return graphBounds({ nodes: focusBounds.map((bounds, index) => ({ id: `focus-${index}`, bounds })) });
}

function keywordMatchCount(graph, keywords) {
  const normalized = keywords.map((keyword) => keyword.toLowerCase());
  return (graph?.nodes ?? []).filter((node) => {
    const name = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
    return normalized.some((keyword) => name.includes(keyword));
  }).length;
}

function enabledNavigationZones(navigation, kind) {
  return (navigation?.zones ?? []).filter((zone) => {
    if (zone.enabled === false) {
      return false;
    }
    if (kind && zone.kind !== kind) {
      return false;
    }
    return Array.isArray(zone.center) && Array.isArray(zone.size) && zone.center.length >= 3 && zone.size.length >= 3;
  });
}

function pointInNavigationBounds(point, bounds, padding = 0) {
  if (!bounds) {
    return true;
  }
  return (
    point[0] >= bounds.min[0] - padding &&
    point[0] <= bounds.max[0] + padding &&
    point[1] >= bounds.min[1] - padding &&
    point[1] <= bounds.max[1] + padding &&
    point[2] >= bounds.min[2] - padding &&
    point[2] <= bounds.max[2] + padding
  );
}

function pointInNavigationZone(zone, point, padding = 0) {
  const rotation = -(zone.rotationY ?? 0);
  const dx = point[0] - zone.center[0];
  const dz = point[2] - zone.center[2];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return (
    Math.abs(localX) <= zone.size[0] / 2 + padding &&
    Math.abs(point[1] - zone.center[1]) <= zone.size[1] / 2 + padding &&
    Math.abs(localZ) <= zone.size[2] / 2 + padding
  );
}

function navigationZoneAabb(zone) {
  const halfX = zone.size[0] / 2;
  const halfZ = zone.size[2] / 2;
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localCorners = [
    [-halfX, -halfZ],
    [halfX, -halfZ],
    [halfX, halfZ],
    [-halfX, halfZ]
  ];
  const corners = localCorners.map(([x, z]) => [
    zone.center[0] + x * cos - z * sin,
    zone.center[2] + x * sin + z * cos
  ]);
  return {
    minX: Math.min(...corners.map(([x]) => x)),
    maxX: Math.max(...corners.map(([x]) => x)),
    minZ: Math.min(...corners.map(([, z]) => z)),
    maxZ: Math.max(...corners.map(([, z]) => z))
  };
}

function navigationZonesOverlap(a, b, padding = 0.2) {
  const boxA = navigationZoneAabb(a);
  const boxB = navigationZoneAabb(b);
  return (
    boxA.minX - padding <= boxB.maxX &&
    boxA.maxX + padding >= boxB.minX &&
    boxA.minZ - padding <= boxB.maxZ &&
    boxA.maxZ + padding >= boxB.minZ
  );
}

function navigationComponents(zones) {
  if (zones.length === 0) {
    return [];
  }
  const seen = new Set();
  const components = [];
  for (const zone of zones) {
    if (seen.has(zone.id)) {
      continue;
    }
    const component = [];
    const queue = [zone];
    seen.add(zone.id);
    while (queue.length > 0) {
      const current = queue.shift();
      component.push(current);
      for (const candidate of zones) {
        if (!seen.has(candidate.id) && navigationZonesOverlap(current, candidate)) {
          seen.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function navigationTopology(manifest) {
  const navigation = manifest.navigation ?? {};
  const walkZones = enabledNavigationZones(navigation, "walk");
  const passZones = enabledNavigationZones(navigation, "pass");
  const blockZones = enabledNavigationZones(navigation, "block");
  const routeZones = [...walkZones, ...passZones];
  const routeComponents = navigationComponents(routeZones);
  const orphanPassZones = passZones.filter(
    (zone) => !walkZones.some((walkZone) => navigationZonesOverlap(zone, walkZone))
  );
  const walkViews = (manifest.views ?? []).filter(
    (view) => view.kind === "walk" && Array.isArray(view.position) && view.position.length >= 3
  );
  const outOfBoundsWalkViews = walkViews.filter(
    (view) => !pointInNavigationBounds(view.position, navigation.bounds, 0.1)
  );
  const blockedWalkViews = walkViews.filter((view) =>
    blockZones.some((zone) => pointInNavigationZone(zone, view.position, 0.15))
  );
  const uncoveredWalkViews = walkZones.length > 0
    ? walkViews.filter((view) => !routeZones.some((zone) => pointInNavigationZone(zone, view.position, 0.25)))
    : [];

  return {
    walkZones,
    passZones,
    blockZones,
    routeZones,
    routeComponents,
    orphanPassZones,
    walkViews,
    outOfBoundsWalkViews,
    blockedWalkViews,
    uncoveredWalkViews
  };
}

function createDiagnostics(manifest, report, graphs) {
  const diagnostics = [];
  const graph = graphs[0];
  const bounds = graphBounds(graph);
  const size = boundsSize(bounds);
  const largestDimension = size ? Math.max(...size.map(Math.abs)) : 0;
  const flatPlane = dominantFlatPlane(graph, bounds);
  const focusedBounds = graphFocusBounds(graph);
  const modelScale = manifest.rendering?.modelScale ?? 1;
  const missingExternalResources = report.models.reduce(
    (sum, model) => sum + (model.missingExternalResourceCount ?? 0),
    0
  );
  const parseFailures = report.models.filter((model) => model.parseError);
  const unsupportedRequiredExtensions = [
    ...new Set(report.models.flatMap((model) => model.unsupportedRequiredExtensions ?? []))
  ];
  const missingPositionPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.missingPositionPrimitiveCount ?? 0),
    0
  );
  const missingNormalPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.missingNormalPrimitiveCount ?? 0),
    0
  );
  const missingUvPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.missingUvPrimitiveCount ?? 0),
    0
  );
  const uv1PrimitiveCount = report.models.reduce((sum, model) => sum + (model.uv1PrimitiveCount ?? 0), 0);
  const texturedMissingUvPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.texturedMissingUvPrimitiveCount ?? 0),
    0
  );
  const missingPositionBoundsPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.missingPositionBoundsPrimitiveCount ?? 0),
    0
  );
  const invalidAccessorReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidAccessorReferenceCount ?? 0),
    0
  );
  const invalidTextureReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidTextureReferenceCount ?? 0),
    0
  );
  const undersizedBufferCount = report.models.reduce(
    (sum, model) => sum + (model.undersizedBufferCount ?? 0),
    0
  );
  const texturesMissingImageCount = report.models.reduce(
    (sum, model) => sum + (model.texturesMissingImageCount ?? 0),
    0
  );
  const nonTrianglePrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.nonTrianglePrimitiveCount ?? 0),
    0
  );
  const transparentMaterialCount = report.models.reduce(
    (sum, model) => sum + (model.transparentMaterialCount ?? 0),
    0
  );
  const transmissionMaterialCount = report.models.reduce(
    (sum, model) => sum + (model.transmissionMaterialCount ?? 0),
    0
  );
  const vertexColorPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.vertexColorPrimitiveCount ?? 0),
    0
  );
  const floorMatches = keywordMatchCount(graph, manifest.navigation?.floorMeshNames ?? []);
  const collisionMatches = keywordMatchCount(graph, manifest.navigation?.collisionMeshNames ?? []);
  const ceilingMatches = keywordMatchCount(graph, ["ceiling", "roof", "soffit", "false ceiling"]);
  const navigationZones = Array.isArray(manifest.navigation?.zones) ? manifest.navigation.zones : [];
  const hasWalkZones = navigationZones.some((zone) => zone.kind === "walk" && zone.enabled !== false);
  const hasBlockZones = navigationZones.some((zone) => zone.kind === "block" && zone.enabled !== false);
  const topology = navigationTopology(manifest);
  const textureImages = [
    ...report.looseImages,
    ...report.models.flatMap((model) => model.externalResources ?? []).filter((resource) => resource.kind === "texture")
  ].filter((image) => typeof image.width === "number" && typeof image.height === "number");
  const oversizedTextures = textureImages.filter((image) => Math.max(image.width, image.height) > 4096);
  const largeTextures = textureImages.filter((image) => Math.max(image.width, image.height) > 2048);

  if (parseFailures.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "malformed-model",
      title: "Model could not be parsed",
      message: parseFailures.map((model) => `${model.source ?? model.format}: ${model.parseError}`).join("; "),
      action: "Re-export the file as glTF 2.0/GLB from Blender or your CAD/DCC tool, then upload the repaired ZIP/GLB."
    });
  }

  if (unsupportedRequiredExtensions.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "unsupported-required-extensions",
      title: "Unsupported required glTF extensions",
      message: `The model requires ${unsupportedRequiredExtensions.join(", ")}.`,
      action: "Re-export without those required extensions, or add loader support before publishing."
    });
  }

  if (missingPositionPrimitiveCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-position-attributes",
      title: "Mesh primitives missing positions",
      message: `${missingPositionPrimitiveCount} primitive(s) do not include POSITION attributes, so bounds/navigation can be wrong.`,
      action: "Repair or re-export the model so every renderable mesh primitive has POSITION data."
    });
  }

  if (invalidAccessorReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-accessor-references",
      title: "Invalid mesh accessor references",
      message: `${invalidAccessorReferenceCount} primitive attribute/index reference(s) point outside the accessor list.`,
      action: "Repair or re-export the GLB/GLTF; invalid accessors can make geometry disappear or render incorrectly."
    });
  }

  if (invalidTextureReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-texture-references",
      title: "Invalid texture references",
      message: `${invalidTextureReferenceCount} texture/material reference(s) point outside the image or texture lists.`,
      action: "Repair or re-export the GLB/GLTF; broken texture references can make surfaces render flat, green, black, or missing."
    });
  }

  if (undersizedBufferCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "undersized-model-buffers",
      title: "Model buffer data is incomplete",
      message: `${undersizedBufferCount} buffer(s) are shorter than the byteLength declared by the GLTF/GLB.`,
      action: "Re-export or re-upload the model; incomplete buffers can make geometry disappear, render as a flat surface, or fail on some devices."
    });
  }

  if (texturesMissingImageCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "textures-without-images",
      title: "Textures without image sources",
      message: `${texturesMissingImageCount} texture definition(s) do not point at an embedded or external image.`,
      action: "Re-export with embedded textures or upload the original GLTF ZIP with all texture files."
    });
  }

  if (missingPositionBoundsPrimitiveCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-position-bounds",
      title: "Position accessor bounds missing",
      message: `${missingPositionBoundsPrimitiveCount} primitive(s) have POSITION data without min/max bounds.`,
      action: "Re-export with accessor bounds, or run the optimizer/repair pass so framing, floor detection, and navigation can be generated reliably."
    });
  }

  if (missingNormalPrimitiveCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-normal-attributes",
      title: "Mesh normals missing",
      message: `${missingNormalPrimitiveCount} primitive(s) do not include NORMAL attributes, which can make lighting look poor.`,
      action: "Recalculate normals in Blender before export."
    });
  }

  if (texturedMissingUvPrimitiveCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "textured-primitives-missing-uvs",
      title: "Textured meshes missing UVs",
      message: `${texturedMissingUvPrimitiveCount} textured primitive(s) do not include TEXCOORD_0 attributes.`,
      action: "Unwrap UVs or rebake those textures; affected surfaces can appear flat, plain, or incorrectly colored."
    });
  } else if (missingUvPrimitiveCount > 0 && (report.imageCount ?? 0) > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-uv-attributes",
      title: "Texture UVs missing",
      message: `${missingUvPrimitiveCount} primitive(s) do not include TEXCOORD_0 attributes even though the model uses images.`,
      action: "Unwrap UVs or bake textures into a GLB with valid TEXCOORD_0 attributes."
    });
  }

  if ((report.secondaryUvLightmapMaterialCount ?? 0) > 0 && uv1PrimitiveCount === 0) {
    diagnostics.push({
      severity: "error",
      code: "lightmaps-missing-secondary-uvs",
      title: "Lightmaps need secondary UVs",
      message: `${report.secondaryUvLightmapMaterialCount} lightmapped material(s) expect TEXCOORD_1, but no mesh primitives expose a secondary UV set.`,
      action: "Re-run Blender lightmap baking or export the model with secondary lightmap UVs before publishing."
    });
  } else if ((report.secondaryUvLightmapMaterialCount ?? 0) > 0 && uv1PrimitiveCount < (report.primitiveCount ?? 0)) {
    diagnostics.push({
      severity: "warning",
      code: "some-lightmap-secondary-uvs-missing",
      title: "Some meshes may miss lightmap UVs",
      message: `${uv1PrimitiveCount}/${report.primitiveCount} primitive(s) expose TEXCOORD_1 while lightmapped materials are configured.`,
      action: "Inspect baked lighting in the viewer; rebake or unwrap any surfaces where lightmaps appear stretched or missing."
    });
  }

  if (nonTrianglePrimitiveCount > 0) {
    diagnostics.push({
      severity: "info",
      code: "non-triangle-primitives",
      title: "Non-triangle primitive modes detected",
      message: `${nonTrianglePrimitiveCount} primitive(s) use line, point, strip, or fan modes.`,
      action: "Confirm these are intended; architectural walkthroughs should generally use triangle meshes for predictable optimization and collision."
    });
  }

  if (transparentMaterialCount > 24) {
    diagnostics.push({
      severity: "warning",
      code: "many-transparent-materials",
      title: "Many transparent materials",
      message: `${transparentMaterialCount} material(s) use alpha blending/masking or opacity below 1.`,
      action: "Check glass/window materials in the viewer; heavy transparency can cause sorting artifacts and slower mobile rendering."
    });
  }

  if (transmissionMaterialCount > 0) {
    diagnostics.push({
      severity: "info",
      code: "transmission-materials",
      title: "Physical glass/transmission materials detected",
      message: `${transmissionMaterialCount} material(s) use transmission or volume extensions.`,
      action: "Compare glass in the viewer after optimization; browser viewers may need simpler glass settings for stable performance."
    });
  }

  if (vertexColorPrimitiveCount > 0) {
    diagnostics.push({
      severity: "info",
      code: "vertex-colors-detected",
      title: "Vertex colors detected",
      message: `${vertexColorPrimitiveCount} primitive(s) include COLOR_0 vertex colors.`,
      action: "If colors look different from the source tool, check whether vertex colors are intentionally mixed with material textures."
    });
  }

  if (missingExternalResources > 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-model-resources",
      title: "Missing model textures or buffers",
      message: `${missingExternalResources} GLTF resource(s) referenced by the model are not present next to the scene file.`,
      action: "Upload a ZIP containing the GLTF/GLB plus its texture and .bin folders, preserving relative paths."
    });
  }

  if ((report.imageCount ?? 0) === 0 && (report.looseImageCount ?? 0) > 0) {
    diagnostics.push({
      severity: "warning",
      code: "loose-textures-not-referenced",
      title: "Texture folder is not connected to the model",
      message: `${report.looseImageCount} loose image file(s) were found, but the active model does not reference image textures.`,
      action: "Ask for the original GLTF/GLB export with embedded or correctly linked textures, or upload a ZIP that preserves the exact texture paths used by the model."
    });
  } else if ((report.looseImageCount ?? 0) > 0) {
    diagnostics.push({
      severity: "info",
      code: "loose-texture-files",
      title: "Loose texture files detected",
      message: `${report.looseImageCount} image file(s) exist in the scene folder but are not referenced by the active model.`,
      action: "If these textures should appear in the model, export/upload the original GLTF with its referenced texture paths, or confirm the GLB already embeds the correct textures."
    });
  }

  if (oversizedTextures.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "oversized-texture-dimensions",
      title: "Oversized texture dimensions",
      message: `${oversizedTextures.length} texture image(s) are larger than 4096px on one side.`,
      action: "Resize or compress oversized textures before publishing; large textures can exhaust mobile GPU memory."
    });
  } else if (largeTextures.length > 8) {
    diagnostics.push({
      severity: "info",
      code: "many-large-textures",
      title: "Many large textures",
      message: `${largeTextures.length} texture image(s) are larger than 2048px on one side.`,
      action: "Run optimization or downscale less visible textures for faster mobile loading."
    });
  }

  if (!bounds) {
    diagnostics.push({
      severity: "warning",
      code: "missing-scene-bounds",
      title: "Scene bounds unavailable",
      message: "The analyzer could not derive object bounds, so imported camera views and navigation limits may be poor.",
      action: "Check that the model contains mesh POSITION attributes, then re-run analysis."
    });
  } else if (largestDimension > 500 && modelScale === 1) {
    diagnostics.push({
      severity: "warning",
      code: "large-coordinate-units",
      title: "Large scene coordinates",
      message: `The model spans about ${largestDimension.toFixed(1)} units. This often means the file was exported in centimeters or millimeters.`,
      action: "Set rendering.modelScale to 0.01 or 0.001, then regenerate views."
    });
  } else if (modelScale !== 1) {
    diagnostics.push({
      severity: "info",
      code: "model-scale-normalized",
      title: "Model scale normalized",
      message: `The viewer applies a ${modelScale} scale factor so navigation uses meter-like units.`,
      action: "Keep this value unless the model appears too small or too large."
    });
  }

  if (flatPlane) {
    const percent = Math.min(100, Math.round((flatPlane.area / flatPlane.sceneArea) * 100));
    diagnostics.push({
      severity: flatPlane.exteriorNamed ? "warning" : "info",
      code: "dominant-flat-plane",
      title: "Large flat plane detected",
      message: `${flatPlane.name} covers about ${percent}% of the scene footprint and can dominate camera framing, top views, and click-floor detection.`,
      action: "Run model repair to regenerate focused views, or add explicit walk zones and hide/rename exterior terrain if it should not drive navigation."
    });
  }

  if (bounds && focusedBounds) {
    const sceneArea = Math.max(1, boundsArea(bounds));
    const focusArea = boundsArea(focusedBounds);
    const focusRatio = focusArea / sceneArea;
    if (sceneArea > 40 && focusRatio > 0 && focusRatio < 0.32) {
      diagnostics.push({
        severity: "warning",
        code: "focused-model-small-in-scene",
        title: "Building occupies a small part of the scene bounds",
        message: `The focused model footprint is about ${Math.max(1, Math.round(focusRatio * 100))}% of the full scene footprint.`,
        action: "Run import repair so cameras, ground, and navigation use the focused building bounds; hide or rename site/terrain geometry if it should not drive framing."
      });
    }
  }

  if (floorMatches === 0 && !hasWalkZones) {
    diagnostics.push({
      severity: "warning",
      code: "no-named-floor-meshes",
      title: "No named floor meshes found",
      message: "Click-to-move will fall back to geometric floor detection, which can include tabletops, roofs, or large flat objects.",
      action: "Add floor keywords that match your model object names, create a dedicated navmesh object, or add a walk zone in Controls."
    });
  }

  if (collisionMatches === 0 && !hasBlockZones) {
    diagnostics.push({
      severity: "warning",
      code: "no-named-collision-meshes",
      title: "No named collision meshes found",
      message: "Wall collision will be inferred from thin tall geometry and may miss cupboards, railings, or exterior boundaries.",
      action: "Add collision keywords for walls, windows, doors, partitions, columns, and boundary meshes, or add block zones in Controls."
    });
  }

  if (ceilingMatches === 0) {
    diagnostics.push({
      severity: "info",
      code: "no-named-ceiling-meshes",
      title: "No named ceiling or roof meshes found",
      message: "The model may be open at the top, or ceiling geometry may use generic object names.",
      action: "Check the model in top/inside views. If ceilings exist but are invisible, enable double-sided materials or rename ceiling objects before import."
    });
  }

  if (topology.walkZones.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-walk-zones",
      title: "No explicit walk zones",
      message: "Click-to-move will fall back to detected floor meshes, which can include roofs, counters, terrain, or tabletops.",
      action: "Add walk zones for the real floor areas users should be allowed to stand on."
    });
  }

  if (topology.walkZones.length > 1 && topology.passZones.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-pass-zones",
      title: "Multiple walk zones without door passes",
      message: "Separate rooms may behave like separate islands, so clicking through a doorway can stop at the threshold.",
      action: "Add pass zones at doorways/openings between room walk zones."
    });
  }

  if (topology.routeComponents.length > 1) {
    diagnostics.push({
      severity: "warning",
      code: "disconnected-navigation-zones",
      title: "Walkable areas are disconnected",
      message: `${topology.routeComponents.length} separate navigation islands were detected across walk/pass zones.`,
      action: "Add or resize pass zones until connected rooms touch through doorways."
    });
  }

  if (topology.orphanPassZones.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "orphan-pass-zones",
      title: "Door pass zones do not touch walk zones",
      message: `${topology.orphanPassZones.length} pass zone(s) do not overlap a walk zone, so pathfinding cannot use them.`,
      action: "Move or resize each pass zone so it overlaps the floor walk zones on both sides of the opening."
    });
  }

  if (topology.outOfBoundsWalkViews.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "walk-views-outside-navigation-bounds",
      title: "Walk views start outside navigation bounds",
      message: `${topology.outOfBoundsWalkViews.length} walk view(s) start outside the configured movement bounds.`,
      action: "Move those views inside the model or expand the navigation bounds."
    });
  }

  if (topology.blockedWalkViews.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "walk-views-inside-block-zones",
      title: "Walk views start inside block zones",
      message: `${topology.blockedWalkViews.length} walk view(s) start inside a wall/boundary blocker.`,
      action: "Move those views, reduce the block zones, or split blockers around doorways."
    });
  }

  if (topology.uncoveredWalkViews.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "walk-views-outside-walk-zones",
      title: "Walk views are outside walkable zones",
      message: `${topology.uncoveredWalkViews.length} walk view(s) can load there, but click routing may not continue from that position.`,
      action: "Add a walk patch around each view or move the view into an existing walk zone."
    });
  }

  if ((manifest.views?.length ?? 0) === 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-views",
      title: "No camera views",
      message: "The viewer needs at least one starting view.",
      action: "Create an entry view before publishing."
    });
  }

  if (report.modelBytes > 10 * 1024 * 1024 && !report.compression?.meshopt && !report.compression?.draco) {
    diagnostics.push({
      severity: "warning",
      code: "missing-geometry-compression",
      title: "Geometry compression missing",
      message: "The scene model is large and does not advertise Meshopt or Draco compression.",
      action: "Run optimization before publishing, then keep the optimized model active for web delivery."
    });
  }

  if ((report.imageCount ?? 0) > 0 && !report.compression?.basisu && !report.compression?.webp) {
    diagnostics.push({
      severity: "warning",
      code: "missing-texture-compression",
      title: "Texture compression missing",
      message: "The model uses texture images but does not advertise KHR_texture_basisu/KTX2 textures.",
      action: "Convert large textures to KTX2/Basis during the production optimization pass."
    });
  }

  if (report.warnings.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      severity: "info",
      code: "import-healthy",
      title: "Import looks healthy",
      message: "No blocking import, navigation, or bundle issues were detected.",
      action: "Open the viewer and test click movement on the expected floor surfaces."
    });
  }

  return diagnostics;
}

function summarize(manifest, assets, models, graphs, looseImages, materialOverrides) {
  const totalBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const missingAssetCount = assets.filter((asset) => !asset.exists).length;
  const modelBytes = assets
    .filter((asset) => /\.(glb|gltf)$/i.test(asset.source))
    .reduce((sum, asset) => sum + asset.bytes, 0);
  const videoBytes = assets
    .filter((asset) => /\.(mp4|webm|mov)$/i.test(asset.source))
    .reduce((sum, asset) => sum + asset.bytes, 0);
  const warnings = [];
  const triangleCount = models.reduce((sum, model) => sum + model.triangleCount, 0);
  const meshCount = models.reduce((sum, model) => sum + model.meshCount, 0);
  const primitiveCount = models.reduce((sum, model) => sum + (model.primitiveCount ?? 0), 0);
  const materialCount = models.reduce((sum, model) => sum + model.materialCount, 0);
  const textureCount = models.reduce((sum, model) => sum + (model.textureCount ?? 0), 0);
  const imageCount = models.reduce((sum, model) => sum + (model.imageCount ?? 0), 0);
  const lightmapMaterials = (materialOverrides?.materials ?? []).filter((material) => material?.lightMapUrl);
  const secondaryUvLightmapMaterialCount = lightmapMaterials.filter(
    (material) => material.lightMapUvSet !== 0
  ).length;
  const textureImages = [
    ...looseImages,
    ...models.flatMap((model) => model.externalResources ?? []).filter((resource) => resource.kind === "texture")
  ].filter((image) => typeof image.width === "number" && typeof image.height === "number");
  const maxTextureDimension = textureImages.reduce(
    (max, image) => Math.max(max, image.width ?? 0, image.height ?? 0),
    0
  );
  const oversizedTextureCount = textureImages.filter((image) => Math.max(image.width, image.height) > 4096).length;
  const compression = {
    meshopt: models.some((model) => model.compression?.meshopt),
    draco: models.some((model) => model.compression?.draco),
    basisu: models.some((model) => model.compression?.basisu),
    webp: models.some((model) => model.compression?.webp)
  };

  if (missingAssetCount > 0) {
    warnings.push({
      code: "missing-assets",
      message: `${missingAssetCount} referenced asset(s) are missing.`
    });
  }

  if (totalBytes > defaultBudget.maxTotalBytes) {
    warnings.push({
      code: "total-size-budget",
      message: `Bundle size exceeds ${(defaultBudget.maxTotalBytes / 1024 / 1024).toFixed(0)} MB.`
    });
  }

  if (modelBytes > defaultBudget.maxModelBytes) {
    warnings.push({
      code: "model-size-budget",
      message: `Model assets exceed ${(defaultBudget.maxModelBytes / 1024 / 1024).toFixed(0)} MB.`
    });
  }

  if (videoBytes > defaultBudget.maxVideoBytes) {
    warnings.push({
      code: "video-size-budget",
      message: `Video assets exceed ${(defaultBudget.maxVideoBytes / 1024 / 1024).toFixed(0)} MB.`
    });
  }

  if ((manifest.interactions?.length ?? 0) > defaultBudget.maxInteractionCount) {
    warnings.push({
      code: "interaction-count-budget",
      message: `Interaction count exceeds ${defaultBudget.maxInteractionCount}.`
    });
  }

  if (triangleCount > defaultBudget.maxMobileTriangles) {
    warnings.push({
      code: "mobile-triangle-budget",
      message: `Triangle count exceeds mobile target of ${defaultBudget.maxMobileTriangles.toLocaleString()}.`
    });
  }

  if (materialCount > defaultBudget.maxMobileMaterials) {
    warnings.push({
      code: "mobile-material-budget",
      message: `Material count exceeds mobile target of ${defaultBudget.maxMobileMaterials}.`
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    manifestPath,
    bundleDir,
    viewCount: manifest.views?.length ?? 0,
    interactionCount: manifest.interactions?.length ?? 0,
    assetCount: assets.length,
    missingAssetCount,
    totalBytes,
    modelBytes,
    videoBytes,
    triangleCount,
    meshCount,
    primitiveCount,
    materialCount,
    textureCount,
    imageCount,
    lightmapMaterialCount: lightmapMaterials.length,
    secondaryUvLightmapMaterialCount,
    maxTextureDimension,
    oversizedTextureCount,
    looseImageCount: looseImages.length,
    looseImages: looseImages.slice(0, 40),
    compression,
    warnings,
    assets,
    models
  };
  return {
    ...report,
    diagnostics: createDiagnostics(manifest, report, graphs)
  };
}

function profileWarnings(report, profile) {
  const warnings = [];
  const { budgets } = profile;
  if (report.totalBytes > budgets.maxTotalBytes) {
    warnings.push({
      code: "total-bytes",
      message: `Bundle size is over the ${profile.label} budget.`
    });
  }
  if (report.modelBytes > budgets.maxModelBytes) {
    warnings.push({
      code: "model-bytes",
      message: `Model size is over the ${profile.label} budget.`
    });
  }
  if (report.triangleCount > budgets.maxTriangles) {
    warnings.push({
      code: "triangles",
      message: `Triangle count is over the ${profile.label} budget.`
    });
  }
  if (report.materialCount > budgets.maxMaterials) {
    warnings.push({
      code: "materials",
      message: `Material count is over the ${profile.label} budget.`
    });
  }
  if (report.meshCount > budgets.maxMeshes) {
    warnings.push({
      code: "meshes",
      message: `Mesh count is over the ${profile.label} budget.`
    });
  }
  return warnings;
}

function recommendationList(report) {
  const recommendations = [];
  const hasGeometryCompression = Boolean(report.compression?.meshopt || report.compression?.draco);

  if (report.triangleCount > optimizationProfiles[0].budgets.maxTriangles) {
    recommendations.push({
      priority: "high",
      action: "Run mesh simplification for mobile profile.",
      reason: "Mobile triangle budget is exceeded."
    });
  }

  if (report.meshCount > optimizationProfiles[0].budgets.maxMeshes) {
    recommendations.push({
      priority: "high",
      action: "Merge static meshes that share materials.",
      reason: "High mesh count increases draw calls."
    });
  }

  if (report.materialCount > optimizationProfiles[0].budgets.maxMaterials) {
    recommendations.push({
      priority: "medium",
      action: "Consolidate duplicate materials and atlas small repeated textures.",
      reason: "Material count is a draw-call and memory pressure signal."
    });
  }

  if (report.modelBytes > optimizationProfiles[0].budgets.maxModelBytes && hasGeometryCompression) {
    recommendations.push({
      priority: "medium",
      action: "Reduce model transfer size further.",
      reason: "The model is already compressed but remains larger than the mobile transfer budget."
    });
  }

  if (report.modelBytes > 10 * 1024 * 1024 && !hasGeometryCompression) {
    recommendations.push({
      priority: "medium",
      action: "Enable geometry compression before publishing.",
      reason: "The GLB does not advertise Meshopt or Draco compression."
    });
  }

  if ((report.imageCount ?? 0) > 0 && !report.compression?.basisu) {
    recommendations.push({
      priority: "medium",
      action: report.compression?.webp
        ? "Add KTX2/Basis texture compression for production delivery."
        : "Convert large textures to WebP now, then KTX2/Basis for production delivery.",
      reason: report.compression?.webp
        ? "WebP reduces transfer size, but KTX2/Basis is still better for GPU memory."
        : "The model has texture images but does not advertise WebP or KHR_texture_basisu."
    });
  }

  if (report.totalBytes > optimizationProfiles[0].budgets.maxTotalBytes) {
    recommendations.push({
      priority: "medium",
      action: "Move large media into lazy-loaded assets.",
      reason: "Initial bundle size is above the mobile target."
    });
  }

  if (report.warnings.length === 0 && recommendations.length === 0) {
    recommendations.push({
      priority: "low",
      action: "No immediate optimization action needed for this demo scene.",
      reason: "The scene is currently within all early budgets."
    });
  }

  return recommendations;
}

function createOptimizationReport(report) {
  const profiles = optimizationProfiles.map((profile) => {
    const warnings = profileWarnings(report, profile);
    return {
      id: profile.id,
      label: profile.label,
      status: warnings.length === 0 ? "pass" : "warn",
      budgets: profile.budgets,
      metrics: {
        totalBytes: report.totalBytes,
        modelBytes: report.modelBytes,
        triangles: report.triangleCount,
        materials: report.materialCount,
        meshes: report.meshCount
      },
      warnings
    };
  });

  return {
    schemaVersion: "0.1",
    generatedAt: report.generatedAt,
    source: path.basename(manifestPath),
    profiles,
    recommendations: recommendationList(report)
  };
}

function publishReadinessIssue(code, title, message, action) {
  return { code, title, message, action };
}

function createPublishReadiness(manifest, report, optimizationReport) {
  const blockers = [];
  const warnings = [];
  const diagnostics = report.diagnostics ?? [];
  const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const hasGeometryCompression = Boolean(report.compression?.meshopt || report.compression?.draco);

  if ((manifest.views?.length ?? 0) === 0) {
    blockers.push(
      publishReadinessIssue(
        "no-starting-views",
        "No starting views",
        "The viewer has no configured camera views.",
        "Create at least one walk view before publishing."
      )
    );
  }

  if ((report.missingAssetCount ?? 0) > 0) {
    blockers.push(
      publishReadinessIssue(
        "missing-assets",
        "Missing referenced assets",
        `${report.missingAssetCount} referenced asset(s) are missing from the bundle.`,
        "Upload or relink missing assets, then run analysis again."
      )
    );
  }

  for (const diagnostic of errorDiagnostics) {
    blockers.push(
      publishReadinessIssue(
        `diagnostic-${diagnostic.code}`,
        diagnostic.title,
        diagnostic.message,
        diagnostic.action
      )
    );
  }

  if (report.modelBytes > 10 * 1024 * 1024 && !hasGeometryCompression) {
    blockers.push(
      publishReadinessIssue(
        "large-uncompressed-model",
        "Large model is not geometry-compressed",
        "The active scene model is over 10 MB and does not advertise Meshopt or Draco compression.",
        "Run the optimizer and keep scene.optimized.glb active before publishing."
      )
    );
  }

  if (report.triangleCount > optimizationProfiles[0].budgets.maxTriangles) {
    warnings.push(
      publishReadinessIssue(
        "mobile-triangle-budget",
        "Over mobile triangle budget",
        `Triangle count exceeds ${optimizationProfiles[0].budgets.maxTriangles.toLocaleString()} triangles.`,
        "Simplify meshes or split heavy content before mobile delivery."
      )
    );
  }

  if (report.meshCount > optimizationProfiles[0].budgets.maxMeshes) {
    warnings.push(
      publishReadinessIssue(
        "mobile-mesh-budget",
        "High mesh count",
        "The model is over the mobile mesh-count budget, which can increase draw calls.",
        "Merge static meshes that share materials."
      )
    );
  }

  if (report.totalBytes > optimizationProfiles[0].budgets.maxTotalBytes) {
    warnings.push(
      publishReadinessIssue(
        "mobile-total-size-budget",
        "Large initial bundle",
        "The bundle is over the mobile transfer-size target.",
        "Optimize model/textures and lazy-load large media."
      )
    );
  }

  if ((report.imageCount ?? 0) > 0 && !report.compression?.basisu) {
    warnings.push(
      publishReadinessIssue(
        "missing-gpu-texture-compression",
        "No KTX2/Basis texture compression",
        "Texture images are present but the model does not advertise GPU texture compression.",
        "Install KTX-Software/toktx and run the production texture-compression pass."
      )
    );
  }

  if ((report.oversizedTextureCount ?? 0) > 0) {
    warnings.push(
      publishReadinessIssue(
        "oversized-textures",
        "Oversized textures detected",
        `${report.oversizedTextureCount} texture image(s) are larger than 4096px.`,
        "Run optimization or resize source textures before client/mobile delivery."
      )
    );
  }

  if (!manifest.navigation?.bounds) {
    warnings.push(
      publishReadinessIssue(
        "missing-navigation-bounds",
        "Navigation bounds are missing",
        "Users may be able to move into empty exterior space without bounds.",
        "Use graph bounds and add boundary block zones before client delivery."
      )
    );
  }

  const publishWarningDiagnostics = new Set([
    "missing-walk-zones",
    "disconnected-navigation-zones",
    "missing-pass-zones",
    "orphan-pass-zones",
    "walk-views-inside-block-zones",
    "walk-views-outside-walk-zones",
    "some-lightmap-secondary-uvs-missing"
  ]);
  for (const diagnostic of diagnostics) {
    if (!publishWarningDiagnostics.has(diagnostic.code)) {
      continue;
    }
    if (warnings.some((warning) => warning.code === `diagnostic-${diagnostic.code}`)) {
      continue;
    }
    warnings.push(
      publishReadinessIssue(
        `diagnostic-${diagnostic.code}`,
        diagnostic.title,
        diagnostic.message,
        diagnostic.action
      )
    );
  }

  const mobileProfile = optimizationReport.profiles.find((profile) => profile.id === "mobile");
  for (const warning of mobileProfile?.warnings ?? []) {
    if (warnings.some((item) => item.code === `mobile-${warning.code}` || item.code === warning.code)) {
      continue;
    }
    warnings.push(
      publishReadinessIssue(
        `mobile-${warning.code}`,
        "Mobile profile warning",
        warning.message,
        "Run the optimizer or reduce the source scene before publishing for mobile."
      )
    );
  }

  return {
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "ready",
    blockers,
    warnings
  };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "0.1") {
  throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
}

const assets = await Promise.all(collectAssetReferences(manifest).map(assetSize));
const models = (await Promise.all(assets.map(modelStats))).filter(Boolean);
const graphs = (await Promise.all(assets.map(modelGraph))).filter(Boolean);
const materialDocs = (await Promise.all(assets.map(modelMaterials))).filter(Boolean);
const looseImages = await looseBundleImages(assets, models);
const materialOverrides = await readJsonIfExists(path.resolve(bundleDir, "materials.json"));
const report = summarize(manifest, assets, models, graphs, looseImages, materialOverrides);
const optimizationReport = createOptimizationReport(report);
const finalReport = {
  ...report,
  publishReadiness: createPublishReadiness(manifest, report, optimizationReport)
};

if (writeStats) {
  await writeFile(path.resolve(bundleDir, "stats.json"), `${JSON.stringify(finalReport, null, 2)}\n`);
  await writeFile(
    path.resolve(bundleDir, "optimization.json"),
    `${JSON.stringify(optimizationReport, null, 2)}\n`
  );
  if (graphs[0]) {
    await writeFile(path.resolve(bundleDir, "scene.graph.json"), `${JSON.stringify(graphs[0], null, 2)}\n`);
    const existingObjects = await readJsonIfExists(path.resolve(bundleDir, "objects.json"));
    const objectsDocument = mergeObjectEdits(
      extractObjectsDocument(graphs[0], graphs[0].source),
      existingObjects
    );
    await writeFile(
      path.resolve(bundleDir, "objects.json"),
      `${JSON.stringify(objectsDocument, null, 2)}\n`
    );
  }
  if (materialDocs[0]) {
    const existingMaterials = await readJsonIfExists(path.resolve(bundleDir, "materials.json"));
    const materialsDocument = mergeMaterialEdits(materialDocs[0], existingMaterials);
    await writeFile(
      path.resolve(bundleDir, "materials.json"),
      `${JSON.stringify(materialsDocument, null, 2)}\n`
    );
  }
}

console.log(JSON.stringify(finalReport, null, 2));
