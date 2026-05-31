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
const supportedImageMimeTypes = new Set([
  "image/avif",
  "image/basis",
  "image/jpeg",
  "image/ktx2",
  "image/png",
  "image/webp"
]);

const defaultBudget = {
  maxTotalBytes: 160 * 1024 * 1024,
  maxModelBytes: 70 * 1024 * 1024,
  maxVideoBytes: 45 * 1024 * 1024,
  maxInteractionCount: 80,
  maxMobileTriangles: 4_000_000,
  maxMobileDrawPrimitives: 500,
  maxMobileTextureMemoryBytes: 256 * 1024 * 1024,
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
      maxDrawPrimitives: 500,
      maxTextureMemoryBytes: 256 * 1024 * 1024,
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
      maxDrawPrimitives: 900,
      maxTextureMemoryBytes: 512 * 1024 * 1024,
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
      maxDrawPrimitives: 1800,
      maxTextureMemoryBytes: 1024 * 1024 * 1024,
      maxMaterials: 320,
      maxMeshes: 1400
    }
  }
];

function formatMegabytes(bytes) {
  const value = bytes / 1024 / 1024;
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} MB`;
}

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
    if (interaction.kind === "material-variant") {
      for (const variant of interaction.variants ?? []) {
        if (variant.texture && !isExternalAsset(variant.texture)) {
          assets.push({
            kind: "variant-texture",
            source: variant.texture,
            label: `${interaction.label ?? "Finish variant"}: ${variant.label ?? variant.id ?? "texture"}`
          });
        }
      }
    }
  }

  if (manifest.branding?.logoUrl && !isExternalAsset(manifest.branding.logoUrl)) {
    assets.push({ kind: "image", source: manifest.branding.logoUrl, label: "Brand logo" });
  }

  return assets;
}

function collectMaterialLightmapReferences(materialOverrides) {
  const assets = [];
  const seen = new Set();
  for (const material of materialOverrides?.materials ?? []) {
    const source = material?.lightMapUrl;
    if (!source || isExternalAsset(source)) {
      continue;
    }
    const key = source.replace(/\\/g, "/");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    assets.push({
      kind: "lightmap",
      source,
      label: material.name ? `${material.name} lightmap` : "Material lightmap"
    });
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

function isPotentialLocalGltfUri(uri) {
  return (
    typeof uri === "string" &&
    uri.trim().length > 0 &&
    !uri.startsWith("data:") &&
    !uri.startsWith("blob:") &&
    !uri.startsWith("http://") &&
    !uri.startsWith("https://")
  );
}

function isSafeLocalResourcePath(source) {
  const clean = stripLocalResourceUri(source);
  if (!clean || /^[a-zA-Z]:/.test(clean)) {
    return false;
  }
  const normalized = path.posix.normalize(clean);
  return (
    normalized !== "." &&
    !normalized.startsWith("/") &&
    !normalized.startsWith("../") &&
    normalized !== ".." &&
    !/^[a-zA-Z]:/.test(normalized)
  );
}

function isUnsafeLocalGltfUri(uri) {
  return isPotentialLocalGltfUri(uri) && !isSafeLocalResourcePath(uri);
}

function isLocalGltfUri(uri) {
  return isPotentialLocalGltfUri(uri) && isSafeLocalResourcePath(uri);
}

async function resourceStatus(asset, kind, source, label) {
  const localSource = stripLocalResourceUri(source);
  const fullPath = path.resolve(path.dirname(asset.path), localSource);
  const mimeType = kind === "texture" ? mimeTypeFromUri(localSource) : undefined;
  const unsupportedMimeType = Boolean(mimeType && !supportedImageMimeTypes.has(mimeType));
  try {
    await access(fullPath);
    const info = await stat(fullPath);
    const metadataStatus = kind === "texture" ? await imageMetadataStatus(fullPath) : undefined;
    const metadata = metadataStatus?.metadata;
    const exactSource = await exactCaseRelativePath(path.dirname(asset.path), localSource);
    const caseMismatch = Boolean(exactSource && exactSource !== localSource.replace(/\\/g, "/"));
    return {
      kind,
      source: localSource,
      label,
      exists: true,
      bytes: info.size,
      ...(unsupportedMimeType ? { unsupportedMimeType: mimeType } : {}),
      ...(caseMismatch ? { caseMismatch, actualSource: exactSource } : {}),
      ...(metadataStatus?.decodeFailed ? { decodeFailed: true } : {}),
      ...(metadata ? { width: metadata.width, height: metadata.height } : {})
    };
  } catch {
    return {
      kind,
      source: localSource,
      label,
      exists: false,
      bytes: 0,
      ...(unsupportedMimeType ? { unsupportedMimeType: mimeType } : {})
    };
  }
}

async function exactCaseRelativePath(baseDir, source) {
  const cleanSource = stripLocalResourceUri(source);
  const parts = cleanSource.split(/[\\/]+/).filter(Boolean);
  let currentDir = baseDir;
  const exactParts = [];
  for (const part of parts) {
    if (part === ".") {
      continue;
    }
    if (part === "..") {
      currentDir = path.dirname(currentDir);
      exactParts.push(part);
      continue;
    }
    let entries = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const match = entries.find((entry) => entry.name.toLowerCase() === part.toLowerCase());
    if (!match) {
      return undefined;
    }
    exactParts.push(match.name);
    currentDir = path.join(currentDir, match.name);
  }
  return exactParts.join("/");
}

async function imageMetadata(filePath) {
  return (await imageMetadataStatus(filePath)).metadata;
}

async function imageMetadataStatus(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ktx2" || extension === ".basis") {
    return { metadata: undefined, decodeFailed: false };
  }
  try {
    const metadata = await sharp(filePath).metadata();
    if (typeof metadata.width !== "number" || typeof metadata.height !== "number") {
      return { metadata: undefined, decodeFailed: true };
    }
    return {
      metadata: {
        width: metadata.width,
        height: metadata.height
      },
      decodeFailed: false
    };
  } catch {
    return { metadata: undefined, decodeFailed: true };
  }
}

async function imageMetadataFromBuffer(buffer, mimeType) {
  if (mimeType === "image/ktx2" || mimeType === "image/basis") {
    return undefined;
  }
  try {
    const metadata = await sharp(buffer).metadata();
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

function displayBundlePath(source) {
  return stripLocalResourceUri(String(source ?? "").replace(/\\/g, "/")).replace(/^\.?\//, "");
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
    if (entry.isDirectory()) {
      if (["dist", "node_modules", ".git"].includes(entry.name)) {
        continue;
      }
      await listBundleImageFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) {
      const info = await stat(fullPath);
      const metadataStatus = await imageMetadataStatus(fullPath);
      const metadata = metadataStatus.metadata;
      files.push({
        source: displayBundlePath(path.relative(bundleDir, fullPath)),
        bytes: info.size,
        ...(metadataStatus.decodeFailed ? { decodeFailed: true } : {}),
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

function missingResourceRelocationCandidates(models, looseImages) {
  const looseByName = new Map();
  for (const image of looseImages) {
    const name = path.posix.basename(normalizeBundlePath(image.source));
    const matches = looseByName.get(name) ?? [];
    matches.push(image);
    looseByName.set(name, matches);
  }

  const candidates = [];
  for (const resource of models.flatMap((model) => model.externalResources ?? [])) {
    if (resource.exists || resource.kind !== "texture") {
      continue;
    }
    const name = path.posix.basename(normalizeBundlePath(resource.source));
    const matches = looseByName.get(name) ?? [];
    if (matches.length === 0) {
      continue;
    }
    candidates.push({
      source: resource.source,
      matches: matches.map((match) => match.source).slice(0, 6),
      ambiguous: matches.length > 1
    });
  }
  return candidates;
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
  let binData;
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
      binData = bytes.slice(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkLength % 4 === 0 ? 0 : 4 - (chunkLength % 4));
  }

  if (!document) {
    throw new Error("GLB JSON chunk is missing.");
  }
  return { document, binBytes, binData };
}

function parseGlbJson(bytes) {
  return parseGlb(bytes).document;
}

function mimeTypeFromUri(uri) {
  if (typeof uri !== "string") {
    return undefined;
  }
  const extension = path.extname(stripLocalResourceUri(uri)).toLowerCase();
  switch (extension) {
    case ".avif":
      return "image/avif";
    case ".basis":
      return "image/basis";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ktx2":
      return "image/ktx2";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function decodeDataImageUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("data:")) {
    return undefined;
  }
  const match = uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    return { error: "Invalid data URI." };
  }
  const mimeType = match[1] || undefined;
  const encoded = match[3] ?? "";
  try {
    const bytes = match[2] === ";base64"
      ? Buffer.from(encoded, "base64")
      : Buffer.from(decodeURIComponent(encoded), "utf8");
    return { bytes, mimeType };
  } catch {
    return { error: "Data URI could not be decoded." };
  }
}

function embeddedImagePayload(image, document, metadata) {
  if (typeof image?.bufferView === "number") {
    const view = document.bufferViews?.[image.bufferView];
    if (!view || typeof view.byteLength !== "number") {
      return { error: "Image bufferView is missing or invalid." };
    }
    if (typeof view.buffer === "number" && view.buffer !== 0) {
      return { error: "Image bufferView points at an external buffer that must be inspected separately." };
    }
    if (!metadata.glbBinData) {
      return { error: "Embedded image bufferView exists, but no GLB BIN chunk is available." };
    }
    const start = view.byteOffset ?? 0;
    const end = start + view.byteLength;
    if (start < 0 || end > metadata.glbBinData.length) {
      return { error: "Image bufferView extends past the GLB BIN chunk." };
    }
    return { bytes: metadata.glbBinData.slice(start, end), mimeType: image.mimeType };
  }

  if (typeof image?.uri === "string" && image.uri.startsWith("data:")) {
    return decodeDataImageUri(image.uri);
  }

  return undefined;
}

function defaultSceneStats(document) {
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const scenes = document.scenes ?? [];
  const nodeTransformStats = nodes.reduce(
    (stats, node) => {
      const matrixValues = Array.isArray(node.matrix) ? node.matrix : [];
      const translationValues = Array.isArray(node.translation) ? node.translation : [];
      const rotationValues = Array.isArray(node.rotation) ? node.rotation : [];
      const scaleValues = Array.isArray(node.scale) ? node.scale : [];
      if (
        (matrixValues.length > 0 && matrixValues.length !== 16) ||
        (translationValues.length > 0 && translationValues.length !== 3) ||
        (rotationValues.length > 0 && rotationValues.length !== 4) ||
        (scaleValues.length > 0 && scaleValues.length !== 3) ||
        [...matrixValues, ...translationValues, ...rotationValues, ...scaleValues].some((value) => !Number.isFinite(value))
      ) {
        stats.invalidLocalTransformCount += 1;
      }
      const scale = scaleValues.length === 3 ? scaleValues : [1, 1, 1];
      if (scale.some((value) => value === 0)) {
        stats.zeroScaleNodeCount += 1;
      }
      if (scale.some((value) => value < 0)) {
        stats.negativeScaleNodeCount += 1;
      }
      const absScale = scale.map((value) => Math.abs(value)).filter((value) => value > 0);
      const maxScale = absScale.length ? Math.max(...absScale) : 1;
      const minScale = absScale.length ? Math.min(...absScale) : 1;
      if (maxScale >= 100 || minScale <= 0.01) {
        stats.extremeScaleNodeCount += 1;
      }
      if (maxScale / Math.max(minScale, Number.EPSILON) >= 25) {
        stats.nonUniformScaleNodeCount += 1;
      }
      return stats;
    },
    {
      invalidLocalTransformCount: 0,
      zeroScaleNodeCount: 0,
      negativeScaleNodeCount: 0,
      extremeScaleNodeCount: 0,
      nonUniformScaleNodeCount: 0
    }
  );
  const explicitDefaultScene = typeof document.scene === "number";
  const defaultSceneIndex = explicitDefaultScene ? document.scene : scenes.length > 0 ? 0 : undefined;
  const defaultScene =
    typeof defaultSceneIndex === "number" && defaultSceneIndex >= 0 && defaultSceneIndex < scenes.length
      ? scenes[defaultSceneIndex]
      : undefined;
  const invalidDefaultScene = explicitDefaultScene && !defaultScene;
  const rootNodeReferences = Array.isArray(defaultScene?.nodes) ? defaultScene.nodes : [];
  const invalidRootNodeReferenceCount = rootNodeReferences.filter(
    (index) => typeof index !== "number" || index < 0 || index >= nodes.length
  ).length;
  const rootNodeIndices = Array.isArray(defaultScene?.nodes)
    ? defaultScene.nodes.filter((index) => typeof index === "number" && index >= 0 && index < nodes.length)
    : [];
  const invalidNodeChildReferenceCount = nodes.reduce(
    (sum, node) =>
      sum +
      (node.children ?? []).filter((index) => typeof index !== "number" || index < 0 || index >= nodes.length).length,
    0
  );
  const invalidNodeMeshReferenceCount = nodes.filter(
    (node) => typeof node.mesh === "number" && (node.mesh < 0 || node.mesh >= meshes.length)
  ).length;
  const reachableNodes = new Set();
  const visitNode = (nodeIndex) => {
    if (reachableNodes.has(nodeIndex) || nodeIndex < 0 || nodeIndex >= nodes.length) {
      return;
    }
    reachableNodes.add(nodeIndex);
    for (const childIndex of nodes[nodeIndex]?.children ?? []) {
      if (typeof childIndex === "number") {
        visitNode(childIndex);
      }
    }
  };
  rootNodeIndices.forEach(visitNode);

  const nodeMeshIndices = new Set(
    nodes
      .map((node) => node.mesh)
      .filter((index) => typeof index === "number" && index >= 0 && index < meshes.length)
  );
  const renderableNodeCount = nodes.filter(
    (node) => typeof node.mesh === "number" && node.mesh >= 0 && node.mesh < meshes.length
  ).length;
  const defaultSceneRenderableNodeCount = [...reachableNodes].filter((nodeIndex) => {
    const meshIndex = nodes[nodeIndex]?.mesh;
    return typeof meshIndex === "number" && meshIndex >= 0 && meshIndex < meshes.length;
  }).length;
  const defaultSceneMeshIndices = new Set(
    [...reachableNodes]
      .map((nodeIndex) => nodes[nodeIndex]?.mesh)
      .filter((index) => typeof index === "number" && index >= 0 && index < meshes.length)
  );

  return {
    sceneCount: scenes.length,
    defaultSceneIndex,
    invalidDefaultScene,
    invalidRootNodeReferenceCount,
    invalidNodeChildReferenceCount,
    invalidNodeMeshReferenceCount,
    ...nodeTransformStats,
    defaultSceneRootNodeCount: rootNodeIndices.length,
    defaultSceneReachableNodeCount: reachableNodes.size,
    renderableNodeCount,
    defaultSceneRenderableNodeCount,
    unusedMeshCount: meshes.filter((_, index) => !nodeMeshIndices.has(index)).length,
    unreferencedDefaultSceneMeshCount: meshes.filter((_, index) => !defaultSceneMeshIndices.has(index)).length
  };
}

function componentTypeByteSize(componentType) {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      return 0;
  }
}

function accessorTypeComponentCount(type) {
  switch (type) {
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
    case "MAT2":
      return 4;
    case "MAT3":
      return 9;
    case "MAT4":
      return 16;
    default:
      return 0;
  }
}

function accessorElementByteSize(accessor) {
  return componentTypeByteSize(accessor?.componentType) * accessorTypeComponentCount(accessor?.type);
}

function accessorRequiredByteLength(accessor, bufferView) {
  const count = accessor?.count ?? 0;
  const elementBytes = accessorElementByteSize(accessor);
  if (count <= 0 || elementBytes <= 0) {
    return 0;
  }
  const stride = typeof bufferView?.byteStride === "number" && bufferView.byteStride > 0
    ? bufferView.byteStride
    : elementBytes;
  return (count - 1) * stride + elementBytes;
}

function accessorHasShape(accessor, type, componentTypes) {
  if (!accessor || accessor.type !== type || componentTypeByteSize(accessor.componentType) === 0) {
    return false;
  }
  return !componentTypes || componentTypes.includes(accessor.componentType);
}

async function analyzeGltfDocument(document, format, asset, metadata = {}) {
  const accessors = document.accessors ?? [];
  const bufferViews = document.bufferViews ?? [];
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
  let missingTangentNormalMapPrimitiveCount = 0;
  let missingUvPrimitiveCount = 0;
  let uv1PrimitiveCount = 0;
  let texturedMissingUvPrimitiveCount = 0;
  let missingPositionBoundsPrimitiveCount = 0;
  let invalidPositionBoundsPrimitiveCount = 0;
  let collapsedPositionBoundsPrimitiveCount = 0;
  let invalidPositionAccessorShapeCount = 0;
  let invalidNormalAccessorShapeCount = 0;
  let invalidTangentAccessorShapeCount = 0;
  let invalidUvAccessorShapeCount = 0;
  let invalidIndexAccessorShapeCount = 0;
  let invalidAccessorReferenceCount = 0;
  let invalidBufferViewReferenceCount = 0;
  let invalidBufferViewRangeCount = 0;
  let invalidAccessorBufferViewCount = 0;
  let invalidAccessorByteRangeCount = 0;
  let invalidMaterialReferenceCount = 0;
  let unassignedMaterialPrimitiveCount = 0;
  let invalidTextureReferenceCount = 0;
  let undersizedBufferCount = 0;
  let texturesMissingImageCount = 0;
  let invalidImageReferenceCount = 0;
  let embeddedImageDecodeFailureCount = 0;
  let unsupportedImageMimeCount = 0;
  let nonTrianglePrimitiveCount = 0;
  let vertexColorPrimitiveCount = 0;
  const materialTriangleCounts = new Array(materials.length).fill(0);
  const embeddedImages = [];
  const texturedMaterialCount = materials.filter((material) => materialUsesTexture(material)).length;
  const texturedMaterialIndices = new Set(
    materials
      .map((material, index) => (materialUsesTexture(material) ? index : undefined))
      .filter((index) => typeof index === "number")
  );
  const materialTextureIndexSet = new Set(
    materials
      .flatMap((material) => materialTextureIndices(material))
      .filter((index) => typeof index === "number")
  );
  const normalMappedMaterialIndices = new Set(
    materials
      .map((material, index) => (materialUsesNormalMap(material) ? index : undefined))
      .filter((index) => typeof index === "number")
  );
  const materialImageIndexSet = new Set();
  for (const textureIndex of materialTextureIndexSet) {
    const texture = document.textures?.[textureIndex];
    if (!texture) {
      continue;
    }
    for (const imageIndex of textureImageSourceIndices(texture)) {
      if (imageIndex >= 0 && imageIndex < (document.images?.length ?? 0)) {
        materialImageIndexSet.add(imageIndex);
      }
    }
  }

  for (const mesh of meshes) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) {
        usesDraco = true;
      }
      primitiveCount += 1;
      const positionAccessorIndex = primitive.attributes?.POSITION;
      const normalAccessorIndex = primitive.attributes?.NORMAL;
      const tangentAccessorIndex = primitive.attributes?.TANGENT;
      const uvAccessorIndices = [
        primitive.attributes?.TEXCOORD_0,
        primitive.attributes?.TEXCOORD_1
      ].filter((index) => typeof index === "number");
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
      if (typeof normalAccessorIndex !== "number") {
        missingNormalPrimitiveCount += 1;
      }
      if (
        typeof primitive.material === "number" &&
        normalMappedMaterialIndices.has(primitive.material) &&
        typeof tangentAccessorIndex !== "number"
      ) {
        missingTangentNormalMapPrimitiveCount += 1;
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
      const normalAccessor =
        typeof normalAccessorIndex === "number" ? accessors[normalAccessorIndex] : undefined;
      const tangentAccessor =
        typeof tangentAccessorIndex === "number" ? accessors[tangentAccessorIndex] : undefined;
      const indexAccessor =
        typeof primitive.indices === "number" ? accessors[primitive.indices] : undefined;
      if (positionAccessor && !accessorHasShape(positionAccessor, "VEC3")) {
        invalidPositionAccessorShapeCount += 1;
      }
      if (normalAccessor && !accessorHasShape(normalAccessor, "VEC3")) {
        invalidNormalAccessorShapeCount += 1;
      }
      if (tangentAccessor && !accessorHasShape(tangentAccessor, "VEC4", [5126])) {
        invalidTangentAccessorShapeCount += 1;
      }
      for (const uvAccessorIndex of uvAccessorIndices) {
        const uvAccessor = accessors[uvAccessorIndex];
        if (uvAccessor && !accessorHasShape(uvAccessor, "VEC2")) {
          invalidUvAccessorShapeCount += 1;
        }
      }
      if (indexAccessor && !accessorHasShape(indexAccessor, "SCALAR", [5121, 5123, 5125])) {
        invalidIndexAccessorShapeCount += 1;
      }
      if (positionAccessor && (!Array.isArray(positionAccessor.min) || !Array.isArray(positionAccessor.max))) {
        missingPositionBoundsPrimitiveCount += 1;
      } else if (positionAccessor && !validAccessorBounds(positionAccessor)) {
        invalidPositionBoundsPrimitiveCount += 1;
      } else if (positionAccessor && accessorBoundsVolume(positionAccessor) < 1e-12 && (positionAccessor.count ?? 0) > 3) {
        collapsedPositionBoundsPrimitiveCount += 1;
      }
      const vertices = positionAccessor?.count ?? 0;
      vertexCount += vertices;

      let primitiveTriangles = 0;
      if (primitive.mode === undefined || primitive.mode === 4) {
        primitiveTriangles = Math.floor((indexAccessor?.count ?? vertices) / 3);
        triangleCount += primitiveTriangles;
      } else {
        nonTrianglePrimitiveCount += 1;
      }
      if (
        primitiveTriangles > 0 &&
        typeof primitive.material === "number" &&
        primitive.material >= 0 &&
        primitive.material < materialTriangleCounts.length
      ) {
        materialTriangleCounts[primitive.material] += primitiveTriangles;
      }
      if (typeof primitive.material !== "number") {
        unassignedMaterialPrimitiveCount += 1;
      } else if (primitive.material < 0 || primitive.material >= materials.length) {
        invalidMaterialReferenceCount += 1;
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
  const unsafeLocalResourceRefs = [
    ...(document.images ?? [])
      .map((image, index) => ({
        kind: "texture",
        source: image.uri,
        label: image.name || `Image ${index}`
      }))
      .filter((reference) => isUnsafeLocalGltfUri(reference.source)),
    ...(document.buffers ?? [])
      .map((buffer, index) => ({
        kind: "buffer",
        source: buffer.uri,
        label: buffer.name || `Buffer ${index}`
      }))
      .filter((reference) => isUnsafeLocalGltfUri(reference.source))
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
  const bufferByteLengths = (document.buffers ?? []).map((buffer, bufferIndex) => {
    if (isLocalGltfUri(buffer.uri)) {
      const resource = externalResourceBySource.get(normalizeBundlePath(buffer.uri));
      return resource?.exists ? resource.bytes : buffer.byteLength;
    }
    if (!buffer.uri && format === "glb" && bufferIndex === 0) {
      return metadata.glbBinBytes ?? buffer.byteLength;
    }
    return buffer.byteLength;
  });
  for (const bufferView of bufferViews) {
    const bufferIndex = bufferView?.buffer;
    const bufferLength = typeof bufferIndex === "number" ? bufferByteLengths[bufferIndex] : undefined;
    if (typeof bufferIndex !== "number" || bufferIndex < 0 || bufferIndex >= bufferByteLengths.length) {
      invalidBufferViewReferenceCount += 1;
      continue;
    }
    const byteOffset = bufferView.byteOffset ?? 0;
    const byteLength = bufferView.byteLength ?? 0;
    if (
      !Number.isFinite(byteOffset) ||
      !Number.isFinite(byteLength) ||
      byteOffset < 0 ||
      byteLength < 0 ||
      typeof bufferLength !== "number" ||
      byteOffset + byteLength > bufferLength
    ) {
      invalidBufferViewRangeCount += 1;
    }
  }
  for (const accessor of accessors) {
    if (typeof accessor?.bufferView === "number") {
      const bufferView = bufferViews[accessor.bufferView];
      if (!bufferView) {
        invalidAccessorBufferViewCount += 1;
      } else if (!bufferView.extensions?.EXT_meshopt_compression) {
        const byteOffset = accessor.byteOffset ?? 0;
        const requiredBytes = accessorRequiredByteLength(accessor, bufferView);
        const viewBytes = bufferView.byteLength ?? 0;
        if (
          !Number.isFinite(byteOffset) ||
          byteOffset < 0 ||
          requiredBytes < 0 ||
          byteOffset + requiredBytes > viewBytes
        ) {
          invalidAccessorByteRangeCount += 1;
        }
      }
    }
    const sparseIndicesView = accessor?.sparse?.indices?.bufferView;
    if (typeof sparseIndicesView === "number" && (sparseIndicesView < 0 || sparseIndicesView >= bufferViews.length)) {
      invalidAccessorBufferViewCount += 1;
    }
    const sparseValuesView = accessor?.sparse?.values?.bufferView;
    if (typeof sparseValuesView === "number" && (sparseValuesView < 0 || sparseValuesView >= bufferViews.length)) {
      invalidAccessorBufferViewCount += 1;
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
  for (const [index, image] of (document.images ?? []).entries()) {
    const label = image.name || `Image ${index}`;
    const mimeType = image.mimeType ?? mimeTypeFromUri(image.uri);
    const unsupportedMimeType = Boolean(mimeType && !supportedImageMimeTypes.has(mimeType));
    if (unsupportedMimeType) {
      unsupportedImageMimeCount += 1;
    }

    const payload = embeddedImagePayload(image, document, metadata);
    if (!payload) {
      continue;
    }
    if (payload.error || !payload.bytes) {
      invalidImageReferenceCount += 1;
      continue;
    }
    const resolvedMimeType = payload.mimeType ?? mimeType;
    const metadataImage = await imageMetadataFromBuffer(payload.bytes, resolvedMimeType);
    const decodeFailed = !metadataImage && isInspectableRasterMimeType(resolvedMimeType);
    if (decodeFailed) {
      embeddedImageDecodeFailureCount += 1;
    }
    embeddedImages.push({
      source: image.uri?.startsWith("data:") ? `data:${label}` : `bufferView:${image.bufferView}`,
      label,
      bytes: payload.bytes.byteLength,
      ...(resolvedMimeType ? { mimeType: resolvedMimeType } : {}),
      ...(unsupportedMimeType ? { unsupportedMimeType: resolvedMimeType ?? mimeType } : {}),
      ...(decodeFailed ? { decodeFailed: true } : {}),
      ...(metadataImage ? { width: metadataImage.width, height: metadataImage.height } : {})
    });
  }

  const sceneStats = defaultSceneStats(document);
  const dominantMaterial = materialTriangleCounts
    .map((count, index) => ({ count, index }))
    .sort((a, b) => b.count - a.count)[0];
  const dominantMaterialInfo =
    dominantMaterial && dominantMaterial.count > 0 && triangleCount > 0
      ? (() => {
          const material = materials[dominantMaterial.index] ?? {};
          return {
            index: dominantMaterial.index,
            name: material.name || `Material ${dominantMaterial.index}`,
            triangleCount: dominantMaterial.count,
            triangleShare: dominantMaterial.count / triangleCount,
            textured: materialUsesTexture(material),
            baseColor: factorToHex(material.pbrMetallicRoughness?.baseColorFactor)
          };
        })()
      : undefined;
  const transparentMaterialIndices = new Set(
    materials
      .map((material, index) => (materialIsTransparent(material) ? index : undefined))
      .filter((index) => typeof index === "number")
  );
  const transparentTriangleCount = materialTriangleCounts.reduce(
    (sum, count, index) => sum + (transparentMaterialIndices.has(index) ? count : 0),
    0
  );
  const dominantTransparentMaterial = materialTriangleCounts
    .map((count, index) => ({ count, index }))
    .filter((item) => item.count > 0 && transparentMaterialIndices.has(item.index))
    .sort((a, b) => b.count - a.count)[0];
  const dominantTransparentMaterialInfo =
    dominantTransparentMaterial && triangleCount > 0
      ? (() => {
          const material = materials[dominantTransparentMaterial.index] ?? {};
          return {
            index: dominantTransparentMaterial.index,
            name: material.name || `Material ${dominantTransparentMaterial.index}`,
            triangleCount: dominantTransparentMaterial.count,
            triangleShare: dominantTransparentMaterial.count / triangleCount,
            baseColor: factorToHex(material.pbrMetallicRoughness?.baseColorFactor)
          };
        })()
      : undefined;

  return {
    format,
    version: document.asset?.version,
    generator: document.asset?.generator,
    ...sceneStats,
    nodeCount: document.nodes?.length ?? 0,
    meshCount: meshes.length,
    primitiveCount,
    materialCount: materials.length,
    texturedMaterialCount,
    textureCount: document.textures?.length ?? 0,
    imageCount: document.images?.length ?? 0,
    materialTextureImageCount: materialImageIndexSet.size,
    unusedTextureImageCount: Math.max(0, (document.images?.length ?? 0) - materialImageIndexSet.size),
    bufferCount: document.buffers?.length ?? 0,
    bufferBytes: (document.buffers ?? []).reduce((sum, buffer) => sum + (buffer.byteLength ?? 0), 0),
    vertexCount,
    triangleCount,
    extensionCount: extensionsUsed.length,
    requiredExtensionCount: document.extensionsRequired?.length ?? 0,
    unsupportedRequiredExtensions: extensionsRequired.filter((extension) => !supportedRequiredExtensions.has(extension)),
    missingPositionPrimitiveCount,
    missingNormalPrimitiveCount,
    missingTangentNormalMapPrimitiveCount,
    missingUvPrimitiveCount,
    uv1PrimitiveCount,
    texturedMissingUvPrimitiveCount,
    missingPositionBoundsPrimitiveCount,
    invalidPositionBoundsPrimitiveCount,
    collapsedPositionBoundsPrimitiveCount,
    invalidPositionAccessorShapeCount,
    invalidNormalAccessorShapeCount,
    invalidTangentAccessorShapeCount,
    invalidUvAccessorShapeCount,
    invalidIndexAccessorShapeCount,
    invalidAccessorReferenceCount,
    invalidBufferViewReferenceCount,
    invalidBufferViewRangeCount,
    invalidAccessorBufferViewCount,
    invalidAccessorByteRangeCount,
    invalidMaterialReferenceCount,
    unassignedMaterialPrimitiveCount,
    invalidTextureReferenceCount,
    undersizedBufferCount,
    texturesMissingImageCount,
    invalidImageReferenceCount,
    embeddedImageDecodeFailureCount,
    unsupportedImageMimeCount,
    unsafeLocalResourceCount: unsafeLocalResourceRefs.length,
    unsafeLocalResources: unsafeLocalResourceRefs.map((reference) => ({
      kind: reference.kind,
      source: stripLocalResourceUri(reference.source),
      label: reference.label
    })),
    embeddedImageCount: embeddedImages.length,
    nonTrianglePrimitiveCount,
    vertexColorPrimitiveCount,
    ...(dominantMaterialInfo ? { dominantMaterial: dominantMaterialInfo } : {}),
    ...(dominantTransparentMaterialInfo ? { dominantTransparentMaterial: dominantTransparentMaterialInfo } : {}),
    transparentMaterialCount: transparentMaterialIndices.size,
    transparentTriangleCount,
    transparentTriangleShare: triangleCount > 0 ? transparentTriangleCount / triangleCount : 0,
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
    externalResources,
    embeddedImages
  };
}

function isInspectableRasterMimeType(mimeType) {
  return ["image/avif", "image/jpeg", "image/png", "image/webp"].includes(String(mimeType ?? "").toLowerCase());
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

function materialUsesNormalMap(material) {
  return Boolean(material && typeof material === "object" && material.normalTexture);
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

function textureImageSourceIndices(texture) {
  return [
    texture?.source,
    texture?.extensions?.KHR_texture_basisu?.source,
    texture?.extensions?.EXT_texture_webp?.source
  ].filter((source) => typeof source === "number");
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

function validAccessorBounds(accessor) {
  if (!Array.isArray(accessor?.min) || !Array.isArray(accessor.max) || accessor.min.length < 3 || accessor.max.length < 3) {
    return false;
  }
  return [0, 1, 2].every(
    (index) =>
      Number.isFinite(accessor.min[index]) &&
      Number.isFinite(accessor.max[index]) &&
      accessor.min[index] <= accessor.max[index]
  );
}

function accessorBoundsVolume(accessor) {
  if (!validAccessorBounds(accessor)) {
    return 0;
  }
  return (
    Math.abs(accessor.max[0] - accessor.min[0]) *
    Math.abs(accessor.max[1] - accessor.min[1]) *
    Math.abs(accessor.max[2] - accessor.min[2])
  );
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
      visible: true,
      hideInTopView: objectShouldHideInTopView(node.name)
    }))
  };
}

function objectShouldHideInTopView(name) {
  const normalized = String(name ?? "").toLowerCase();
  return (
    /(^|[^a-z])(ceiling|false-ceiling|dropped-ceiling|roof|roofing|lid|cover)([^a-z]|$)/.test(normalized) &&
    !/(^|[^a-z])(fan|light|lamp|fixture|chandelier|downlight|spotlight)([^a-z]|$)/.test(normalized)
  );
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
      const { id: _previousId, name: _previousName, ...previousEdits } = previous;
      return {
        ...material,
        ...previousEdits
      };
    })
  };
}

function normalizeTextureMatchName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeObjectTargetName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looseTextureHasGenericName(source) {
  const name = normalizeTextureMatchName(path.posix.basename(String(source ?? "").replace(/\\/g, "/")));
  if (!name) {
    return false;
  }
  return (
    /^(gltf )?embedded \d+$/.test(name) ||
    /^(image|texture|tex|map|material|mat) \d+$/.test(name) ||
    /^(gltf )?(image|texture|tex|map|material|mat) embedded \d+$/.test(name) ||
    /^gltf embedded (image|texture|tex|map|material|mat)? ?\d+$/.test(name)
  );
}

function hasFiniteVec3(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((coordinate) => Number.isFinite(Number(coordinate)))
  );
}

function isProbablyValidLinkUrl(value) {
  const source = String(value ?? "").trim();
  if (!source) {
    return false;
  }
  if (/^(https?:|mailto:|tel:)/i.test(source)) {
    try {
      new URL(source);
      return true;
    } catch {
      return false;
    }
  }
  if (/^(#|\/|\.\/|\.\.\/)/.test(source)) {
    return true;
  }
  return false;
}

function inferMaterialTextureField(source) {
  const normalized = normalizeTextureMatchName(source);
  if (/\b(lightmap|light map|bake|baked|shadow)\b/.test(normalized)) {
    return "lightMapUrl";
  }
  if (/\b(normal|nrm|bump)\b/.test(normalized)) {
    return "normalMapUrl";
  }
  if (/\b(emissive|emission|emit|glow|screen|display)\b/.test(normalized)) {
    return "emissiveMapUrl";
  }
  return "mapUrl";
}

const genericMaterialTextureTokens = new Set([
  "mat",
  "material",
  "materials",
  "texture",
  "textures",
  "map",
  "maps",
  "base",
  "basecolor",
  "color",
  "colour",
  "diffuse",
  "albedo",
  "image",
  "gltf",
  "embedded"
]);

const materialTextureSemanticGroups = [
  ["wood", "timber", "oak", "walnut", "veneer", "plywood"],
  ["brick", "stone", "concrete", "cement", "plaster", "stucco", "marble", "granite", "tile", "tiles"],
  ["grass", "lawn", "terrain", "ground", "soil", "garden"],
  ["glass", "window", "mirror", "glazing"],
  ["fabric", "cloth", "sofa", "cushion", "carpet", "rug", "curtain"],
  ["metal", "steel", "aluminium", "aluminum", "chrome", "iron"],
  ["wall", "paint", "wallpaper"],
  ["floor", "flooring", "parquet"],
  ["screen", "tv", "display", "emissive", "emission"]
];

function usefulTextureTokens(value) {
  return normalizeTextureMatchName(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !genericMaterialTextureTokens.has(token));
}

function semanticTextureScore(materialTokens, textureTokens) {
  let score = 0;
  for (const group of materialTextureSemanticGroups) {
    const materialHit = group.some((token) => materialTokens.includes(token));
    const textureHit = group.some((token) => textureTokens.includes(token));
    if (materialHit && textureHit) {
      score += 10;
    }
  }
  return score;
}

function materialTextureCandidateScore(materialName, source) {
  const material = normalizeTextureMatchName(materialName);
  const texture = normalizeTextureMatchName(path.posix.basename(String(source ?? "").replace(/\\/g, "/")));
  const pathName = normalizeTextureMatchName(source);
  const materialTokens = usefulTextureTokens(materialName);
  const textureTokens = usefulTextureTokens(source);
  let score = 0;
  if (!material || !texture) {
    return score;
  }
  if (texture === material || pathName.endsWith(material)) {
    score += 42;
  }
  for (const token of materialTokens) {
    if (texture.includes(token)) {
      score += 8;
    } else if (pathName.includes(token)) {
      score += 3;
    }
  }
  score += semanticTextureScore(materialTokens, textureTokens);
  if (/\b(base|basecolor|color|diffuse|albedo|map|texture)\b/.test(texture)) {
    score += 4;
  }
  if (/\b(texture|textures|material|materials|maps)\b/.test(pathName)) {
    score += 2;
  }
  return score;
}

function applyLooseTextureSuggestions(materialsDocument, looseImages, existingMaterials, suggestions = []) {
  if (!Array.isArray(looseImages) || looseImages.length === 0) {
    return materialsDocument;
  }
  const existingByName = new Map((existingMaterials?.materials ?? []).map((material) => [material.name, material]));
  return {
    ...materialsDocument,
    materials: materialsDocument.materials.map((material) => {
      const previous = existingByName.get(material.name);
      const next = { ...material };
      const candidates = looseImages
        .map((image) => ({
          source: image.source,
          field: inferMaterialTextureField(image.source),
          score: materialTextureCandidateScore(material.name, image.source)
        }))
        .filter((candidate) => candidate.score >= 14)
        .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
      for (const candidate of candidates) {
        if (previous?.[candidate.field] || next[candidate.field]) {
          continue;
        }
        const tied = candidates.some(
          (other) =>
            other !== candidate &&
            other.field === candidate.field &&
            other.score === candidate.score
        );
        if (tied && candidate.score < 28) {
          continue;
        }
        next[candidate.field] = candidate.source;
        suggestions.push({
          materialName: material.name,
          field: candidate.field,
          source: candidate.source,
          score: candidate.score
        });
      }
      return next;
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
        ...(typeof previous.hideInTopView === "boolean" ? { hideInTopView: previous.hideInTopView } : {}),
        ...(isObjectNavigationBehavior(previous.navigationBehavior)
          ? { navigationBehavior: previous.navigationBehavior }
          : {}),
        ...(typeof previous.locked === "boolean" ? { locked: previous.locked } : {})
      };
    })
  };
}

function isObjectNavigationBehavior(value) {
  return value === "default" || value === "walk" || value === "collision" || value === "ignore";
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
      return analyzeGltfDocument(parsed.document, "glb", asset, {
        glbBinBytes: parsed.binBytes,
        glbBinData: parsed.binData
      });
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

function likelyNonWalkSurfaceName(name) {
  const normalized = String(name || "").toLowerCase();
  return [
    "plant",
    "tree",
    "chair",
    "table",
    "sofa",
    "couch",
    "bed",
    "cabinet",
    "cupboard",
    "wardrobe",
    "counter",
    "worktop",
    "shelf",
    "tv",
    "screen",
    "monitor",
    "appliance",
    "fridge",
    "oven",
    "sink",
    "toilet",
    "vanity",
    "decor",
    "vase",
    "lamp",
    "light",
    "fan",
    "door",
    "window",
    "glass",
    "wall",
    "partition",
    "ceiling",
    "roof"
  ].some((keyword) => normalized.includes(keyword));
}

function likelyWalkSurfaceName(name) {
  const normalized = String(name || "").toLowerCase();
  return [
    "floor",
    "flooring",
    "ground",
    "slab",
    "tile",
    "tiles",
    "parquet",
    "woodfloor",
    "pavement",
    "patio",
    "terrace",
    "balcony",
    "deck",
    "walk",
    "navmesh"
  ].some((keyword) => normalized.includes(keyword));
}

function flatSurfaceNavigationRisk(graph, sceneBounds) {
  if (!graph || !sceneBounds) {
    return undefined;
  }
  const sceneArea = Math.max(1, boundsArea(sceneBounds));
  const sceneHeight = Math.max(0.001, sceneBounds.max[1] - sceneBounds.min[1]);
  const lowBandTop = sceneBounds.min[1] + Math.max(1.4, sceneHeight * 0.45);
  const flatSurfaces = [];
  const flatNonWalkSurfaces = [];
  const ambiguousFlatSurfaces = [];
  const walkLikeLevels = new Map();
  for (const node of graph.nodes ?? []) {
    if (!node.bounds) {
      continue;
    }
    const size = boundsSize(node.bounds);
    if (!size) {
      continue;
    }
    const width = Math.abs(size[0]);
    const height = Math.abs(size[1]);
    const depth = Math.abs(size[2]);
    const area = width * depth;
    const minAxis = Math.min(width, depth);
    const centerY = (node.bounds.min[1] + node.bounds.max[1]) / 2;
    const flat = height <= Math.max(0.12, minAxis * 0.08);
    if (!flat || area < 0.08 || centerY > lowBandTop) {
      continue;
    }
    const name = `${node.name ?? ""} ${node.meshName ?? ""}`;
    const exterior = likelyExteriorPlaneName(name) && area > sceneArea * 0.18;
    if (exterior) {
      continue;
    }
    const entry = {
      name: node.name || node.meshName || "Flat surface",
      area,
      centerY,
      walkLike: likelyWalkSurfaceName(name),
      nonWalk: likelyNonWalkSurfaceName(name)
    };
    flatSurfaces.push(entry);
    if (entry.nonWalk && !entry.walkLike) {
      flatNonWalkSurfaces.push(entry);
    }
    if (!entry.walkLike && !entry.nonWalk) {
      ambiguousFlatSurfaces.push(entry);
    }
    if (entry.walkLike && !entry.nonWalk && area >= Math.max(0.45, sceneArea * 0.004)) {
      const level = Math.round(centerY / 0.18) * 0.18;
      const current = walkLikeLevels.get(level) ?? { level, count: 0, area: 0 };
      current.count += 1;
      current.area += area;
      walkLikeLevels.set(level, current);
    }
  }
  return {
    flatSurfaceCount: flatSurfaces.length,
    flatNonWalkSurfaceCount: flatNonWalkSurfaces.length,
    ambiguousFlatSurfaceCount: ambiguousFlatSurfaces.length,
    ambiguousFlatSurfaceExamples: ambiguousFlatSurfaces
      .sort((a, b) => b.area - a.area)
      .slice(0, 4)
      .map((surface) => surface.name),
    flatNonWalkExamples: flatNonWalkSurfaces
      .sort((a, b) => b.area - a.area)
      .slice(0, 4)
      .map((surface) => surface.name),
    walkLikeLevels: [...walkLikeLevels.values()]
      .filter((level) => level.area >= 0.45)
      .sort((a, b) => a.level - b.level)
  };
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
        bounds: node.bounds,
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

function duplicateNames(values) {
  const counts = new Map();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

function pointInBoundsFootprint(point, bounds, padding = 0) {
  if (!point || !bounds) {
    return false;
  }
  return (
    point[0] >= bounds.min[0] - padding &&
    point[0] <= bounds.max[0] + padding &&
    point[2] >= bounds.min[2] - padding &&
    point[2] <= bounds.max[2] + padding
  );
}

function boundsFootprintCenter(bounds) {
  if (!bounds) {
    return undefined;
  }
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
}

function footprintDistanceToBounds(point, bounds) {
  if (!point || !bounds) {
    return 0;
  }
  const dx =
    point[0] < bounds.min[0]
      ? bounds.min[0] - point[0]
      : point[0] > bounds.max[0]
        ? point[0] - bounds.max[0]
        : 0;
  const dz =
    point[2] < bounds.min[2]
      ? bounds.min[2] - point[2]
      : point[2] > bounds.max[2]
        ? point[2] - bounds.max[2]
        : 0;
  return Math.hypot(dx, dz);
}

function pointInNavigationZone(zone, point, padding = 0) {
  const rotation = -(zone.rotationY ?? 0);
  const dx = point[0] - zone.center[0];
  const dz = point[2] - zone.center[2];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  if (Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
    return (
      Math.abs(point[1] - zone.center[1]) <= zone.size[1] / 2 + padding &&
      pointInPolygonWithPadding([localX, localZ], zone.polygon, padding)
    );
  }
  return (
    Math.abs(localX) <= zone.size[0] / 2 + padding &&
    Math.abs(point[1] - zone.center[1]) <= zone.size[1] / 2 + padding &&
    Math.abs(localZ) <= zone.size[2] / 2 + padding
  );
}

function pointInPolygonWithPadding(point, polygon, padding) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current];
    const b = polygon[previous];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
    if (padding > 0 && pointToSegmentDistance2D(point, a, b) <= padding) {
      return true;
    }
  }
  return inside;
}

function pointToSegmentDistance2D(point, start, end) {
  const segmentX = end[0] - start[0];
  const segmentZ = end[1] - start[1];
  const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
  if (segmentLengthSq < 0.0001) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }
  const t = Math.min(
    1,
    Math.max(0, ((point[0] - start[0]) * segmentX + (point[1] - start[1]) * segmentZ) / segmentLengthSq)
  );
  return Math.hypot(point[0] - (start[0] + segmentX * t), point[1] - (start[1] + segmentZ * t));
}

function segmentOrientation2D(a, b, c) {
  return (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
}

function pointOnSegment2D(point, start, end) {
  return (
    point[0] <= Math.max(start[0], end[0]) + 0.000001 &&
    point[0] + 0.000001 >= Math.min(start[0], end[0]) &&
    point[1] <= Math.max(start[1], end[1]) + 0.000001 &&
    point[1] + 0.000001 >= Math.min(start[1], end[1])
  );
}

function segmentsIntersect2D(aStart, aEnd, bStart, bEnd) {
  const o1 = segmentOrientation2D(aStart, aEnd, bStart);
  const o2 = segmentOrientation2D(aStart, aEnd, bEnd);
  const o3 = segmentOrientation2D(bStart, bEnd, aStart);
  const o4 = segmentOrientation2D(bStart, bEnd, aEnd);
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    return true;
  }
  return (
    (Math.abs(o1) < 0.000001 && pointOnSegment2D(bStart, aStart, aEnd)) ||
    (Math.abs(o2) < 0.000001 && pointOnSegment2D(bEnd, aStart, aEnd)) ||
    (Math.abs(o3) < 0.000001 && pointOnSegment2D(aStart, bStart, bEnd)) ||
    (Math.abs(o4) < 0.000001 && pointOnSegment2D(aEnd, bStart, bEnd))
  );
}

function pointToPolygonDistance2D(point, polygon) {
  if (polygon.length < 3 || pointInPolygonWithPadding(point, polygon, 0)) {
    return 0;
  }
  return polygon.reduce((distance, start, index) => {
    const end = polygon[(index + 1) % polygon.length];
    return Math.min(distance, pointToSegmentDistance2D(point, start, end));
  }, Number.POSITIVE_INFINITY);
}

function polygonDistance2D(a, b) {
  if (a.length < 3 || b.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (a.some((point) => pointInPolygonWithPadding(point, b, 0)) || b.some((point) => pointInPolygonWithPadding(point, a, 0))) {
    return 0;
  }
  let distance = Number.POSITIVE_INFINITY;
  for (let aIndex = 0; aIndex < a.length; aIndex += 1) {
    const aStart = a[aIndex];
    const aEnd = a[(aIndex + 1) % a.length];
    for (let bIndex = 0; bIndex < b.length; bIndex += 1) {
      const bStart = b[bIndex];
      const bEnd = b[(bIndex + 1) % b.length];
      if (segmentsIntersect2D(aStart, aEnd, bStart, bEnd)) {
        return 0;
      }
      distance = Math.min(
        distance,
        pointToSegmentDistance2D(aStart, bStart, bEnd),
        pointToSegmentDistance2D(aEnd, bStart, bEnd),
        pointToSegmentDistance2D(bStart, aStart, aEnd),
        pointToSegmentDistance2D(bEnd, aStart, aEnd)
      );
    }
  }
  return distance;
}

function navigationZoneAabb(zone) {
  const halfX = zone.size[0] / 2;
  const halfZ = zone.size[2] / 2;
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localCorners =
    Array.isArray(zone.polygon) && zone.polygon.length >= 3
      ? zone.polygon
      : [
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

function navigationZoneFootprint(zone) {
  const halfX = zone.size[0] / 2;
  const halfZ = zone.size[2] / 2;
  const rotation = zone.rotationY ?? 0;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localCorners =
    Array.isArray(zone.polygon) && zone.polygon.length >= 3
      ? zone.polygon
      : [
          [-halfX, -halfZ],
          [halfX, -halfZ],
          [halfX, halfZ],
          [-halfX, halfZ]
        ];
  return localCorners.map(([x, z]) => [
    zone.center[0] + x * cos - z * sin,
    zone.center[2] + x * sin + z * cos
  ]);
}

function navigationZoneNarrowestSpan(zone) {
  if (Array.isArray(zone.polygon) && zone.polygon.length >= 3) {
    const xs = zone.polygon.map(([x]) => x);
    const zs = zone.polygon.map(([, z]) => z);
    return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  }
  return Math.min(Math.abs(zone.size[0]), Math.abs(zone.size[2]));
}

function navigationZonesOverlap(a, b, padding = 0.2) {
  const boxA = navigationZoneAabb(a);
  const boxB = navigationZoneAabb(b);
  const boundsMayTouch =
    boxA.minX - padding <= boxB.maxX &&
    boxA.maxX + padding >= boxB.minX &&
    boxA.minZ - padding <= boxB.maxZ &&
    boxA.maxZ + padding >= boxB.minZ;
  if (!boundsMayTouch) {
    return false;
  }
  return polygonDistance2D(navigationZoneFootprint(a), navigationZoneFootprint(b)) <= padding;
}

function navigationZoneConnectionPadding(a, b, bodyRadius = 0.28) {
  const basePadding = Math.max(0.22, bodyRadius * 1.35);
  if (a.kind !== "pass" && b.kind !== "pass") {
    return basePadding;
  }
  return Math.max(basePadding, Math.min(1.15, bodyRadius * 2.8));
}

function navigationZonesConnect(a, b, bodyRadius = 0.28) {
  return navigationZonesOverlap(a, b, navigationZoneConnectionPadding(a, b, bodyRadius));
}

function navigationZoneOutsideBounds(zone, bounds, padding = 0.05) {
  if (!bounds) {
    return false;
  }
  const box = navigationZoneAabb(zone);
  return (
    box.minX < bounds.min[0] - padding ||
    box.maxX > bounds.max[0] + padding ||
    box.minZ < bounds.min[2] - padding ||
    box.maxZ > bounds.max[2] + padding ||
    zone.center[1] < bounds.min[1] - Math.max(0.25, zone.size[1]) ||
    zone.center[1] > bounds.max[1] + Math.max(0.25, zone.size[1])
  );
}

function navigationComponents(zones, bodyRadius = 0.28) {
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
        if (!seen.has(candidate.id) && navigationZonesConnect(current, candidate, bodyRadius)) {
          seen.add(candidate.id);
          queue.push(candidate);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function navigationZoneDisplayName(zone) {
  return String(zone.label ?? zone.id ?? "Unnamed zone").trim() || "Unnamed zone";
}

function navigationComponentSummary(components, maxComponents = 3, maxZonesPerComponent = 3) {
  return [...components]
    .sort((a, b) => b.length - a.length)
    .slice(0, maxComponents)
    .map((component, index) => {
      const zoneNames = component
        .slice(0, maxZonesPerComponent)
        .map(navigationZoneDisplayName)
        .join(", ");
      const hiddenCount = Math.max(0, component.length - maxZonesPerComponent);
      const suffix = hiddenCount > 0 ? ` +${hiddenCount} more` : "";
      const zoneCount = `${component.length} zone${component.length === 1 ? "" : "s"}`;
      return `island ${index + 1}: ${zoneCount}${zoneNames ? ` (${zoneNames}${suffix})` : ""}`;
    })
    .join("; ");
}

function navigationTopology(manifest, bodyRadius = 0.28) {
  const navigation = manifest.navigation ?? {};
  const walkZones = enabledNavigationZones(navigation, "walk");
  const passZones = enabledNavigationZones(navigation, "pass");
  const blockZones = enabledNavigationZones(navigation, "block");
  const routeZones = [...walkZones, ...passZones];
  const routeComponents = navigationComponents(routeZones, bodyRadius);
  const orphanPassZones = passZones.filter(
    (zone) => !walkZones.some((walkZone) => navigationZonesConnect(zone, walkZone, bodyRadius))
  );
  const oneSidedPassZones = passZones.filter((zone) => {
    const touchingWalkZones = walkZones.filter((walkZone) => navigationZonesConnect(zone, walkZone, bodyRadius));
    return touchingWalkZones.length === 1 && walkZones.length > 1;
  });
  const blockedPassZones = passZones.filter((zone) =>
    blockZones.some((blockZone) => navigationZonesOverlap(zone, blockZone, 0.05))
  );
  const blockedWalkZones = walkZones.filter((zone) =>
    blockZones.some((blockZone) => navigationZonesOverlap(zone, blockZone, 0.05))
  );
  const narrowPassZones = passZones.filter(
    (zone) => navigationZoneNarrowestSpan(zone) < Math.max(0.42, bodyRadius * 2)
  );
  const outOfBoundsWalkZones = walkZones.filter((zone) =>
    navigationZoneOutsideBounds(zone, navigation.bounds)
  );
  const outOfBoundsPassZones = passZones.filter((zone) =>
    navigationZoneOutsideBounds(zone, navigation.bounds)
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
    oneSidedPassZones,
    blockedPassZones,
    blockedWalkZones,
    narrowPassZones,
    outOfBoundsWalkZones,
    outOfBoundsPassZones,
    walkViews,
    outOfBoundsWalkViews,
    blockedWalkViews,
    uncoveredWalkViews
  };
}

function hexColorLooksGreen(value) {
  const match = /^#?([a-f0-9]{6})$/i.exec(String(value ?? "").trim());
  if (!match) {
    return false;
  }
  const hex = match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return green > 70 && green > red * 1.15 && green > blue * 1.12;
}

function repeatedLargeMeshInstances(graph, sceneBounds) {
  if (!graph || !sceneBounds) {
    return undefined;
  }
  const nodes = (graph.nodes ?? []).filter(
    (node) => typeof node.meshIndex === "number" && node.triangleCount > 0 && node.bounds
  );
  const totalTriangles = nodes.reduce((sum, node) => sum + (node.triangleCount ?? 0), 0);
  if (totalTriangles <= 0) {
    return undefined;
  }
  const sceneArea = Math.max(1, boundsArea(sceneBounds));
  const groupsByMesh = new Map();
  for (const node of nodes) {
    groupsByMesh.set(node.meshIndex, [...(groupsByMesh.get(node.meshIndex) ?? []), node]);
  }
  const repeatedGroups = [...groupsByMesh.values()].flatMap((groupNodes) => {
    if (groupNodes.length < 2) {
      return [];
    }
    const triangles = groupNodes
      .map((node) => node.triangleCount ?? 0)
      .sort((a, b) => b - a);
    const repeatedTriangles = triangles.slice(1).reduce((sum, count) => sum + count, 0);
    const groupBounds = graphBounds({ nodes: groupNodes });
    const footprintArea = boundsArea(groupBounds);
    if (
      repeatedTriangles < 200 ||
      (repeatedTriangles / totalTriangles < 0.02 && footprintArea / sceneArea < 0.01)
    ) {
      return [];
    }
    return [
      {
        meshIndex: groupNodes[0].meshIndex,
        count: groupNodes.length,
        repeatedTriangles,
        footprintArea,
        names: groupNodes.slice(0, 3).map((node) => node.name).filter(Boolean)
      }
    ];
  });
  const repeatedTriangles = repeatedGroups.reduce((sum, group) => sum + group.repeatedTriangles, 0);
  const repeatedShare = repeatedTriangles / totalTriangles;
  if (
    repeatedGroups.length < 8 &&
    !(repeatedGroups.length >= 4 && repeatedShare >= 0.35)
  ) {
    return undefined;
  }
  if (repeatedShare < 0.18) {
    return undefined;
  }
  return {
    groupCount: repeatedGroups.length,
    repeatedShare,
    repeatedTriangles,
    examples: repeatedGroups
      .sort((a, b) => b.repeatedTriangles - a.repeatedTriangles)
      .slice(0, 3)
  };
}

function createDiagnostics(manifest, report, graphs, controls) {
  const diagnostics = [];
  const graph = graphs[0];
  const bounds = graphBounds(graph);
  const size = boundsSize(bounds);
  const largestDimension = size ? Math.max(...size.map(Math.abs)) : 0;
  const footprintCenter = boundsFootprintCenter(bounds);
  const footprintCenterDistance = footprintCenter ? Math.hypot(footprintCenter[0], footprintCenter[1]) : 0;
  const modelOffset = Array.isArray(manifest.rendering?.modelOffset) ? manifest.rendering.modelOffset : undefined;
  const hasModelOffset = Boolean(modelOffset?.some((value) => Math.abs(value) > 0.01));
  const flatPlane = dominantFlatPlane(graph, bounds);
  const flatSurfaceRisk = flatSurfaceNavigationRisk(graph, bounds);
  const focusedBounds = graphFocusBounds(graph);
  const repeatedInstances = repeatedLargeMeshInstances(graph, bounds);
  const modelScale = manifest.rendering?.modelScale ?? 1;
  const missingExternalResources = report.models.reduce(
    (sum, model) => sum + (model.missingExternalResourceCount ?? 0),
    0
  );
  const caseMismatchedExternalResources = report.models
    .flatMap((model) => model.externalResources ?? [])
    .filter((resource) => resource.exists && resource.caseMismatch);
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
  const missingTangentNormalMapPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.missingTangentNormalMapPrimitiveCount ?? 0),
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
  const invalidPositionBoundsPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.invalidPositionBoundsPrimitiveCount ?? 0),
    0
  );
  const collapsedPositionBoundsPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.collapsedPositionBoundsPrimitiveCount ?? 0),
    0
  );
  const invalidAccessorReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidAccessorReferenceCount ?? 0),
    0
  );
  const invalidBufferViewReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidBufferViewReferenceCount ?? 0),
    0
  );
  const invalidBufferViewRangeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidBufferViewRangeCount ?? 0),
    0
  );
  const invalidAccessorBufferViewCount = report.models.reduce(
    (sum, model) => sum + (model.invalidAccessorBufferViewCount ?? 0),
    0
  );
  const invalidAccessorByteRangeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidAccessorByteRangeCount ?? 0),
    0
  );
  const invalidTextureReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidTextureReferenceCount ?? 0),
    0
  );
  const invalidImageReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidImageReferenceCount ?? 0),
    0
  );
  const embeddedImageDecodeFailureCount = report.models.reduce(
    (sum, model) => sum + (model.embeddedImageDecodeFailureCount ?? 0),
    0
  );
  const sidecarTextureDecodeFailureCount = [
    ...report.looseImages,
    ...report.models
      .flatMap((model) => model.externalResources ?? [])
      .filter((resource) => resource.kind === "texture" && resource.exists)
  ].filter((resource) => resource.decodeFailed).length;
  const unsupportedImageMimeCount = report.models.reduce(
    (sum, model) => sum + (model.unsupportedImageMimeCount ?? 0),
    0
  );
  const unsafeLocalResourceCount = report.models.reduce(
    (sum, model) => sum + (model.unsafeLocalResourceCount ?? 0),
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
  const unusedTextureImageCount = report.models.reduce(
    (sum, model) => sum + (model.unusedTextureImageCount ?? 0),
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
  const dominantTransparentSurfaceModels = report.models
    .filter((model) => (model.transparentTriangleShare ?? 0) >= 0.45 && (model.triangleCount ?? 0) > 1000)
    .sort((a, b) => (b.transparentTriangleShare ?? 0) - (a.transparentTriangleShare ?? 0));
  const transmissionMaterialCount = report.models.reduce(
    (sum, model) => sum + (model.transmissionMaterialCount ?? 0),
    0
  );
  const unlitMaterialCount = report.models.reduce(
    (sum, model) => sum + (model.unlitMaterialCount ?? 0),
    0
  );
  const texturedMaterialCount = report.models.reduce(
    (sum, model) => sum + (model.texturedMaterialCount ?? 0),
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
  const bodyRadius = Number.isFinite(Number(controls?.movement?.collisionRadius))
    ? Math.min(0.6, Math.max(0.12, Number(controls.movement.collisionRadius)))
    : 0.28;
  const topology = navigationTopology(manifest, bodyRadius);
  const rooms = Array.isArray(manifest.rooms) ? manifest.rooms : [];
  const roomsWithBounds = rooms.filter((room) => room?.bounds);
  const linkedRoomViewIds = new Set(rooms.map((room) => room?.viewId).filter(Boolean));
  const linkedWalkRoomCount = topology.walkViews.filter((view) => linkedRoomViewIds.has(view.id)).length;
  const hotspots = (manifest.interactions ?? []).filter((interaction) => interaction.kind === "hotspot");
  const links = (manifest.interactions ?? []).filter((interaction) => interaction.kind === "link");
  const videoTextures = (manifest.interactions ?? []).filter((interaction) => interaction.kind === "video-texture");
  const materialVariants = (manifest.interactions ?? []).filter((interaction) => interaction.kind === "material-variant");
  const objectToggles = (manifest.interactions ?? []).filter((interaction) => interaction.kind === "object-toggle");
  const graphNodeNames = new Set((graph?.nodes ?? []).map((node) => node.name).filter(Boolean));
  const graphNodeIds = new Set((graph?.nodes ?? []).map((node) => node.id).filter(Boolean));
  const graphNodeTargetNames = new Set(
    (graph?.nodes ?? [])
      .flatMap((node) => [node.name, node.meshName])
      .map(normalizeObjectTargetName)
      .filter(Boolean)
  );
  const graphMaterialNames = new Set((graph?.materials ?? []).map((material) => material.name).filter(Boolean));
  const hasGraphMeshTarget = (targetName) => {
    const target = String(targetName ?? "").trim();
    if (!target || !graph) {
      return true;
    }
    return graphNodeNames.has(target) || graphNodeTargetNames.has(normalizeObjectTargetName(target));
  };
  const hasGraphMaterialTarget = (targetName) => {
    const target = String(targetName ?? "").trim();
    if (!target || !graph) {
      return true;
    }
    return graphMaterialNames.has(target);
  };
  const duplicateNodeNames = duplicateNames((graph?.nodes ?? []).map((node) => node.name)).slice(0, 8);
  const duplicateMaterialNames = duplicateNames((graph?.materials ?? []).map((material) => material.name)).slice(0, 8);
  const hotspotsMissingContent = hotspots.filter(
    (interaction) => !String(interaction.title ?? interaction.label ?? "").trim()
  );
  const hotspotsWithBadPositions = hotspots.filter((interaction) => !hasFiniteVec3(interaction.position));
  const linksMissingUrl = links.filter((interaction) => !String(interaction.url ?? "").trim());
  const linksWithInvalidUrl = links.filter(
    (interaction) => String(interaction.url ?? "").trim() && !isProbablyValidLinkUrl(interaction.url)
  );
  const linksWithBadPositions = links.filter((interaction) => !hasFiniteVec3(interaction.position));
  const videoTexturesMissingSource = videoTextures.filter(
    (interaction) => !String(interaction.source ?? "").trim()
  );
  const videoTexturesMissingTarget = videoTextures.filter(
    (interaction) => !interaction.targetMeshName && !interaction.targetMaterialName
  );
  const videoTexturesWithMissingTargets = videoTextures.filter(
    (interaction) =>
      (interaction.targetMeshName && !hasGraphMeshTarget(interaction.targetMeshName)) ||
      (interaction.targetMaterialName && !hasGraphMaterialTarget(interaction.targetMaterialName))
  );
  const materialVariantsMissingTarget = materialVariants.filter(
    (interaction) => !interaction.targetMeshName && !interaction.targetMaterialName
  );
  const materialVariantsWithMissingTargets = materialVariants.filter(
    (interaction) =>
      (interaction.targetMeshName && !hasGraphMeshTarget(interaction.targetMeshName)) ||
      (interaction.targetMaterialName && !hasGraphMaterialTarget(interaction.targetMaterialName))
  );
  const materialVariantsWithoutOptions = materialVariants.filter(
    (interaction) => !Array.isArray(interaction.variants) || interaction.variants.length === 0
  );
  const materialVariantsWithInvisibleOptions = materialVariants.filter((interaction) =>
    (interaction.variants ?? []).some((variant) => !String(variant.color ?? "").trim() && !String(variant.texture ?? "").trim())
  );
  const materialVariantsWithInvalidTextureUrls = materialVariants.filter((interaction) =>
    (interaction.variants ?? []).some((variant) => String(variant.texture ?? "").trim().startsWith("generated://"))
  );
  const missingMaterialVariantTextureAssets = (report.assets ?? []).filter(
    (asset) => asset.kind === "variant-texture" && !asset.exists
  );
  const objectTogglesMissingTarget = objectToggles.filter(
    (interaction) => !String(interaction.targetObjectId ?? "").trim() && !String(interaction.targetObjectName ?? "").trim()
  );
  const objectTogglesWithBadPositions = objectToggles.filter((interaction) => !hasFiniteVec3(interaction.position));
  const objectTogglesWithMissingTargets = objectToggles.filter((interaction) => {
    const targetObjectId = String(interaction.targetObjectId ?? "").trim();
    const targetObjectName = normalizeObjectTargetName(interaction.targetObjectName);
    if (!graph || (!targetObjectId && !targetObjectName)) {
      return false;
    }
    return !(
      (targetObjectId && graphNodeIds.has(targetObjectId)) ||
      (targetObjectName && graphNodeTargetNames.has(targetObjectName))
    );
  });
  const textureImages = [
    ...report.looseImages,
    ...report.models.flatMap((model) => model.externalResources ?? []).filter((resource) => resource.kind === "texture")
  ].filter((image) => typeof image.width === "number" && typeof image.height === "number");
  const genericLooseTextureImages = (report.looseImages ?? []).filter((image) => looseTextureHasGenericName(image.source));
  const oversizedTextures = textureImages.filter((image) => Math.max(image.width, image.height) > 4096);
  const largeTextures = textureImages.filter((image) => Math.max(image.width, image.height) > 2048);
  const tinyTextures = textureImages.filter((image) => Math.max(image.width, image.height) > 0 && Math.max(image.width, image.height) <= 256);
  const extremeAspectTextures = textureImages.filter((image) => {
    const width = image.width ?? 0;
    const height = image.height ?? 0;
    const shortestSide = Math.min(width, height);
    return shortestSide > 0 && Math.max(width, height) / shortestSide >= 8;
  });
  const invalidDefaultSceneModels = report.models.filter((model) => model.invalidDefaultScene);
  const emptyDefaultSceneModels = report.models.filter(
    (model) =>
      (model.meshCount ?? 0) > 0 &&
      (model.sceneCount ?? 0) > 0 &&
      !model.invalidDefaultScene &&
      (model.defaultSceneRenderableNodeCount ?? 0) === 0
  );
  const missingSceneDefinitionModels = report.models.filter(
    (model) => (model.meshCount ?? 0) > 0 && (model.sceneCount ?? 0) === 0
  );
  const invalidRootNodeReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidRootNodeReferenceCount ?? 0),
    0
  );
  const invalidNodeChildReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidNodeChildReferenceCount ?? 0),
    0
  );
  const invalidNodeMeshReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidNodeMeshReferenceCount ?? 0),
    0
  );
  const invalidLocalTransformCount = report.models.reduce(
    (sum, model) => sum + (model.invalidLocalTransformCount ?? 0),
    0
  );
  const zeroScaleNodeCount = report.models.reduce((sum, model) => sum + (model.zeroScaleNodeCount ?? 0), 0);
  const negativeScaleNodeCount = report.models.reduce((sum, model) => sum + (model.negativeScaleNodeCount ?? 0), 0);
  const extremeScaleNodeCount = report.models.reduce((sum, model) => sum + (model.extremeScaleNodeCount ?? 0), 0);
  const nonUniformScaleNodeCount = report.models.reduce(
    (sum, model) => sum + (model.nonUniformScaleNodeCount ?? 0),
    0
  );
  const unreferencedDefaultSceneMeshCount = report.models.reduce(
    (sum, model) => sum + (model.unreferencedDefaultSceneMeshCount ?? 0),
    0
  );
  const invalidMaterialReferenceCount = report.models.reduce(
    (sum, model) => sum + (model.invalidMaterialReferenceCount ?? 0),
    0
  );
  const unassignedMaterialPrimitiveCount = report.models.reduce(
    (sum, model) => sum + (model.unassignedMaterialPrimitiveCount ?? 0),
    0
  );
  const invalidPositionAccessorShapeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidPositionAccessorShapeCount ?? 0),
    0
  );
  const invalidNormalAccessorShapeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidNormalAccessorShapeCount ?? 0),
    0
  );
  const invalidTangentAccessorShapeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidTangentAccessorShapeCount ?? 0),
    0
  );
  const invalidUvAccessorShapeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidUvAccessorShapeCount ?? 0),
    0
  );
  const invalidIndexAccessorShapeCount = report.models.reduce(
    (sum, model) => sum + (model.invalidIndexAccessorShapeCount ?? 0),
    0
  );
  const meshCount = report.models.reduce((sum, model) => sum + (model.meshCount ?? 0), 0);
  const dominantUntexturedMaterials = report.models.filter(
    (model) =>
      model.dominantMaterial &&
      model.dominantMaterial.triangleShare >= 0.68 &&
      !model.dominantMaterial.textured &&
      (model.triangleCount ?? 0) > 100
  );
  const dominantGreenMaterials = dominantUntexturedMaterials.filter((model) =>
    hexColorLooksGreen(model.dominantMaterial?.baseColor)
  );
  const materialTextureUsageRatio =
    (report.materialCount ?? 0) > 0 ? texturedMaterialCount / (report.materialCount ?? 1) : 1;

  if (parseFailures.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "malformed-model",
      title: "Model could not be parsed",
      message: parseFailures.map((model) => `${model.source ?? model.format}: ${model.parseError}`).join("; "),
      action: "Re-export the file as glTF 2.0/GLB from Blender or your CAD/DCC tool, then upload the repaired ZIP/GLB."
    });
  }

  if (invalidDefaultSceneModels.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-default-scene",
      title: "Default scene index is invalid",
      message: `${invalidDefaultSceneModels.length} model file(s) point to a default scene that does not exist.`,
      action: "Open the model in Blender, ensure the intended objects are in the active scene, then re-export as glTF 2.0/GLB."
    });
  }

  if (emptyDefaultSceneModels.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "default-scene-has-no-renderable-meshes",
      title: "Default scene has no visible meshes",
      message: `${emptyDefaultSceneModels.length} model file(s) contain meshes, but no renderable mesh nodes are reachable from the default scene.`,
      action: "Re-export with the building objects linked to the exported scene; otherwise viewers may show an empty model or only helper geometry."
    });
  }

  if (missingSceneDefinitionModels.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-gltf-scene-definitions",
      title: "Scene definitions are missing",
      message: `${missingSceneDefinitionModels.length} model file(s) contain meshes but no glTF scene list.`,
      action: "Re-export with a valid default scene so browsers, optimizers, and publishing builds load the same objects consistently."
    });
  }

  if (invalidRootNodeReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-scene-node-references",
      title: "Scene references missing nodes",
      message: `${invalidRootNodeReferenceCount} default-scene node reference(s) point outside the node list.`,
      action: "Repair or re-export the GLB/GLTF so the default scene points only to existing building nodes."
    });
  }

  if (invalidNodeChildReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-node-child-references",
      title: "Node hierarchy references missing children",
      message: `${invalidNodeChildReferenceCount} node child reference(s) point outside the node list.`,
      action: "Repair or re-export the model; broken hierarchy links can make rooms or objects disappear from the viewer."
    });
  }

  if (invalidNodeMeshReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-node-mesh-references",
      title: "Nodes reference missing meshes",
      message: `${invalidNodeMeshReferenceCount} node mesh reference(s) point outside the mesh list.`,
      action: "Repair or re-export the model; invalid mesh references can produce blank, partial, or incorrectly framed imports."
    });
  }

  if (invalidLocalTransformCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-node-transforms",
      title: "Node transforms are invalid",
      message: `${invalidLocalTransformCount} node transform(s) have invalid vector/matrix lengths or non-finite values.`,
      action: "Repair or re-export the model; invalid transforms can make geometry disappear, explode, or generate unusable navigation bounds."
    });
  }

  if (zeroScaleNodeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "zero-scale-nodes",
      title: "Some nodes have zero scale",
      message: `${zeroScaleNodeCount} node(s) include a zero scale axis, which can flatten or hide geometry in the viewer.`,
      action: "Apply transforms in the source model and re-export, or remove intentionally hidden zero-scale helper objects before import."
    });
  }

  if (negativeScaleNodeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "negative-scale-nodes",
      title: "Mirrored node scales detected",
      message: `${negativeScaleNodeCount} node(s) use negative scale, which can flip normals, lighting, culling, or navigation surface orientation.`,
      action: "Apply transforms and recalculate normals in the source model before exporting the client walkthrough."
    });
  }

  if (extremeScaleNodeCount > 0 || nonUniformScaleNodeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "suspicious-node-scales",
      title: "Suspicious node scales detected",
      message: `${extremeScaleNodeCount} node(s) have very large/tiny scale and ${nonUniformScaleNodeCount} node(s) have strongly non-uniform scale.`,
      action: "Apply object transforms in Blender/CAD before export so camera framing, click targets, lighting, and bounds use stable geometry."
    });
  }

  if (
    meshCount > 0 &&
    unreferencedDefaultSceneMeshCount > 0 &&
    unreferencedDefaultSceneMeshCount < meshCount &&
    unreferencedDefaultSceneMeshCount / meshCount > 0.25
  ) {
    diagnostics.push({
      severity: "warning",
      code: "meshes-outside-default-scene",
      title: "Meshes exist outside the default scene",
      message: `${unreferencedDefaultSceneMeshCount}/${meshCount} mesh definition(s) are not reachable from the default scene.`,
      action: "Confirm these are unused library meshes. If important objects are missing, link them into the exported scene before import."
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

  if (invalidPositionAccessorShapeCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-position-accessor-shapes",
      title: "Position accessors have invalid shapes",
      message: `${invalidPositionAccessorShapeCount} POSITION accessor(s) are not valid VEC3 geometry attributes.`,
      action: "Repair or re-export the GLB/GLTF; invalid position accessors can make geometry disappear, collapse, or generate wrong navigation bounds."
    });
  }

  if (invalidIndexAccessorShapeCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-index-accessor-shapes",
      title: "Index accessors have invalid shapes",
      message: `${invalidIndexAccessorShapeCount} index accessor(s) are not valid scalar unsigned integer attributes.`,
      action: "Repair or re-export the GLB/GLTF; invalid indices can make surfaces render as broken triangles or fail in mobile browsers."
    });
  }

  if (invalidBufferViewReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-buffer-view-references",
      title: "Invalid bufferView references",
      message: `${invalidBufferViewReferenceCount} bufferView definition(s) point outside the buffer list.`,
      action: "Repair or re-export the GLB/GLTF; broken bufferViews can make geometry, UVs, or images disappear."
    });
  }

  if (invalidBufferViewRangeCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-buffer-view-ranges",
      title: "bufferView byte ranges are invalid",
      message: `${invalidBufferViewRangeCount} bufferView definition(s) extend beyond their declared or actual buffer data.`,
      action: "Re-export or re-upload the model; invalid buffer ranges commonly render as missing, exploded, or flat geometry."
    });
  }

  if (invalidAccessorBufferViewCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-accessor-buffer-views",
      title: "Accessors reference invalid bufferViews",
      message: `${invalidAccessorBufferViewCount} accessor or sparse accessor bufferView reference(s) are invalid.`,
      action: "Repair or re-export the model; mesh attributes must point at valid bufferViews for reliable rendering and navigation analysis."
    });
  }

  if (invalidAccessorByteRangeCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-accessor-byte-ranges",
      title: "Accessor byte ranges are invalid",
      message: `${invalidAccessorByteRangeCount} accessor definition(s) read beyond their bufferView byte range.`,
      action: "Re-export the model from the source tool or run it through a glTF repair pipeline before importing."
    });
  }

  if (invalidMaterialReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-material-references",
      title: "Mesh primitives reference missing materials",
      message: `${invalidMaterialReferenceCount} primitive material reference(s) point outside the material list.`,
      action: "Repair or re-export the GLB/GLTF; invalid material references can make surfaces render with fallback colors or disappear in some viewers."
    });
  }

  if (unassignedMaterialPrimitiveCount > 0 && (report.materialCount ?? 0) > 0) {
    diagnostics.push({
      severity: "warning",
      code: "unassigned-primitive-materials",
      title: "Some mesh primitives have no material",
      message: `${unassignedMaterialPrimitiveCount} primitive(s) have no material assignment even though the model defines materials.`,
      action: "Assign materials to those meshes in the source model or use Studio Materials only after confirming the plain fallback surfaces are intentional."
    });
  }

  if (invalidNormalAccessorShapeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-normal-accessor-shapes",
      title: "Normal accessors have invalid shapes",
      message: `${invalidNormalAccessorShapeCount} NORMAL accessor(s) are not valid VEC3 attributes.`,
      action: "Recalculate normals in Blender before export; invalid normals can make lighting look faceted, black, or flat."
    });
  }

  if (invalidTangentAccessorShapeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-tangent-accessor-shapes",
      title: "Tangent accessors have invalid shapes",
      message: `${invalidTangentAccessorShapeCount} TANGENT accessor(s) are not valid VEC4 float attributes.`,
      action: "Regenerate tangents in Blender before export; invalid tangents can make normal maps shade seams, corners, or walls incorrectly."
    });
  }

  if (invalidUvAccessorShapeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-uv-accessor-shapes",
      title: "UV accessors have invalid shapes",
      message: `${invalidUvAccessorShapeCount} TEXCOORD accessor(s) are not valid VEC2 attributes.`,
      action: "Unwrap or rebake UVs before export; invalid UVs can make textures appear stretched, missing, or mismatched."
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

  if (invalidImageReferenceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-image-buffer-references",
      title: "Invalid embedded image data",
      message: `${invalidImageReferenceCount} embedded image reference(s) point at missing or incomplete GLB image buffer data.`,
      action: "Re-export the GLB with embedded textures, or upload the original GLTF ZIP with valid image files."
    });
  }

  if (embeddedImageDecodeFailureCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "embedded-texture-decode-failed",
      title: "Embedded textures could not be decoded",
      message: `${embeddedImageDecodeFailureCount} embedded texture image(s) could not be read by the analyzer.`,
      action: "Re-export the GLB with valid PNG, JPEG, WebP, or AVIF images, or upload the original GLTF ZIP with intact texture files."
    });
  }

  if (sidecarTextureDecodeFailureCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "sidecar-texture-decode-failed",
      title: "Texture files could not be decoded",
      message: `${sidecarTextureDecodeFailureCount} texture file(s) exist in the bundle but could not be read as valid image data.`,
      action: "Replace those files from the source export, or re-upload a ZIP with intact PNG, JPEG, WebP, or AVIF textures."
    });
  }

  if (unsupportedImageMimeCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "unsupported-image-mime-types",
      title: "Unsupported image formats detected",
      message: `${unsupportedImageMimeCount} image definition(s) use a MIME type outside PNG, JPEG, WebP, AVIF, Basis, or KTX2.`,
      action: "Convert those textures to a web-supported format before publishing."
    });
  }

  if (unsafeLocalResourceCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "unsafe-gltf-resource-paths",
      title: "Unsafe GLTF resource paths",
      message: `${unsafeLocalResourceCount} texture or buffer URI(s) point outside the uploaded scene folder or use absolute paths.`,
      action: "Re-export or ZIP the model so every texture and .bin file is referenced with a bundle-local relative path such as textures/wall.png."
    });
  }

  if (duplicateNodeNames.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "duplicate-node-names",
      title: "Duplicate object names detected",
      message: `${duplicateNodeNames.length} repeated object name(s) were found, including ${duplicateNodeNames
        .slice(0, 3)
        .map((item) => `${item.name} (${item.count})`)
        .join(", ")}.`,
      action: "Rename duplicate meshes/objects before export or use more specific material targets for interactions."
    });
  }

  if (duplicateMaterialNames.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "duplicate-material-names",
      title: "Duplicate material names detected",
      message: `${duplicateMaterialNames.length} repeated material name(s) were found, including ${duplicateMaterialNames
        .slice(0, 3)
        .map((item) => `${item.name} (${item.count})`)
        .join(", ")}.`,
      action: "Rename duplicate materials before export so video screens, finish variants, and lightmaps target the intended surfaces."
    });
  }

  if (repeatedInstances) {
    const example = repeatedInstances.examples?.[0];
    diagnostics.push({
      severity: "warning",
      code: "repeated-large-mesh-instances",
      title: "Possible duplicated model instances",
      message: `${repeatedInstances.groupCount} repeated mesh group(s) account for about ${Math.round(repeatedInstances.repeatedShare * 100)}% of analyzed triangles${example?.names?.length ? `, including ${example.names.join(", ")}` : ""}.`,
      action: "Inspect the source export for duplicated building groups or linked copies. If the duplicates are intentional furniture/modules, keep them; otherwise remove duplicate scene objects and re-import."
    });
  }

  if ((report.primitiveCount ?? 0) > defaultBudget.maxMobileDrawPrimitives) {
    diagnostics.push({
      severity: "warning",
      code: "high-draw-primitive-count",
      title: "High draw primitive count",
      message: `${report.primitiveCount.toLocaleString()} draw primitive(s) exceed the mobile target of ${defaultBudget.maxMobileDrawPrimitives.toLocaleString()}.`,
      action: "Run Optimization with the Mobile or Balanced profile and inspect the draw-call join result before client/mobile delivery."
    });
  }

  if ((report.staleObjectOverrideCount ?? 0) > 0) {
    diagnostics.push({
      severity: "warning",
      code: "stale-object-overrides",
      title: "Object edits reference missing model objects",
      message: `${report.staleObjectOverrideCount} object override(s) no longer match the current model graph by id or name.`,
      action: "Re-run analysis with write enabled to prune stale object edits, then reapply any intended visibility or navigation behavior changes."
    });
  }

  if ((report.invalidObjectNavigationBehaviorCount ?? 0) > 0) {
    diagnostics.push({
      severity: "warning",
      code: "invalid-object-navigation-behavior",
      title: "Object navigation behavior values are invalid",
      message: `${report.invalidObjectNavigationBehaviorCount} object override(s) use a navigation behavior other than default, walk, collision, or ignore.`,
      action: "Open Objects and choose a valid navigation role before publishing."
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

  if (invalidPositionBoundsPrimitiveCount > 0) {
    diagnostics.push({
      severity: "error",
      code: "invalid-position-bounds",
      title: "Invalid mesh bounds",
      message: `${invalidPositionBoundsPrimitiveCount} POSITION accessor bound(s) contain non-finite values or min values greater than max values.`,
      action: "Repair or re-export the model; invalid bounds break framing, room detection, and navigation generation."
    });
  }

  if (collapsedPositionBoundsPrimitiveCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "collapsed-position-bounds",
      title: "Collapsed mesh bounds detected",
      message: `${collapsedPositionBoundsPrimitiveCount} primitive(s) have near-zero POSITION bounds despite containing several vertices.`,
      action: "Check whether those meshes are helper geometry or an export issue; collapsed bounds can hide objects from generated views and floor detection."
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

  if (missingTangentNormalMapPrimitiveCount > 0) {
    diagnostics.push({
      severity: "warning",
      code: "normal-maps-missing-tangents",
      title: "Normal-mapped surfaces are missing tangents",
      message: `${missingTangentNormalMapPrimitiveCount} primitive(s) use materials with normal maps but do not include TANGENT attributes.`,
      action: "Export tangents with the model or regenerate tangents before publishing; affected walls, floors, fabrics, or tiles can look flat, inverted, or seam-heavy in WebGL."
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

  if ((report.missingLightmapAssetCount ?? 0) > 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-lightmap-assets",
      title: "Lightmap files are missing",
      message: `${report.missingLightmapAssetCount} material lightmap file(s) referenced in Materials could not be found in the bundle.`,
      action: "Re-run the lightmap bake or relink the missing lightmap textures in Materials before publishing."
    });
  }

  if ((report.tinyLightmapAssetCount ?? 0) > 0) {
    diagnostics.push({
      severity: "warning",
      code: "tiny-lightmap-assets",
      title: "Tiny lightmap files detected",
      message: `${report.tinyLightmapAssetCount} material lightmap file(s) are under 4 KB, which can indicate an empty or failed bake.`,
      action: "Open Bake, inspect the lightmap thumbnails, and rebake at a higher quality if the previews look blank or flat."
    });
  }

  if ((report.materialCount ?? 0) > 0 && (report.lightmapMaterialCount ?? 0) === 0) {
    diagnostics.push({
      severity: "warning",
      code: "unbaked-materials",
      title: "Baked lighting is not linked",
      message: `${report.materialCount} material(s) are present, but none have linked lightmap textures.`,
      action: "Use Bake to generate and review lightmaps before treating the scene as a Shapespark-style client walkthrough."
    });
  } else if ((report.lightmapMaterialCount ?? 0) > 0 && (report.lightmapMaterialCount ?? 0) < (report.materialCount ?? 0)) {
    diagnostics.push({
      severity: "warning",
      code: "partial-lightmap-coverage",
      title: "Some materials are not baked",
      message: `${report.lightmapMaterialCount}/${report.materialCount} material(s) have linked lightmap textures.`,
      action: "Review Bake and Materials to confirm unbaked glass, video, or helper materials are intentional before client delivery."
    });
  }

  if (nonTrianglePrimitiveCount > 0) {
    diagnostics.push({
      severity: "warning",
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

  if (dominantTransparentSurfaceModels.length > 0) {
    const model = dominantTransparentSurfaceModels[0];
    const material = model.dominantTransparentMaterial;
    diagnostics.push({
      severity: "warning",
      code: "dominant-transparent-surface",
      title: "Large transparent surface coverage",
      message: `${Math.round((model.transparentTriangleShare ?? 0) * 100)}% of model triangles use transparent materials${material?.name ? `, led by ${material.name}` : ""}.`,
      action: "Open Materials and inspect glass, wall, ceiling, and floor opacity. If opaque surfaces look see-through or hollow, set opacity back to 1 or re-export with correct alpha settings."
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

  if (unlitMaterialCount > 0 && unlitMaterialCount / Math.max(1, report.materialCount ?? 0) >= 0.5) {
    diagnostics.push({
      severity: "info",
      code: "mostly-unlit-materials",
      title: "Most materials are exported as unlit",
      message: `${unlitMaterialCount}/${report.materialCount ?? 0} material(s) use KHR_materials_unlit, which can make architectural models look flat under viewer lighting.`,
      action: "Keep Relight flat/unlit materials enabled in Controls unless the source intentionally uses flat/emissive rendering."
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

  if (caseMismatchedExternalResources.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "case-mismatched-model-resources",
      title: "Texture or buffer path casing may fail when published",
      message: `${caseMismatchedExternalResources.length} external model resource path(s) differ only by letter case from the files on disk.`,
      action: "Rename files or update GLTF resource paths so casing matches exactly before deploying to Linux/CDN hosting."
    });
  }

  if ((report.relocatedTextureCandidateCount ?? 0) > 0) {
    const ambiguous = report.ambiguousRelocatedTextureCandidateCount ?? 0;
    diagnostics.push({
      severity: ambiguous > 0 ? "warning" : "info",
      code: "relocatable-texture-resources",
      title: "Missing textures may be recoverable",
      message:
        ambiguous > 0
          ? `${report.relocatedTextureCandidateCount} missing texture reference(s) have same-named files elsewhere in the bundle, but ${ambiguous} name match(es) are ambiguous.`
          : `${report.relocatedTextureCandidateCount} missing texture reference(s) have same-named files elsewhere in the bundle.`,
      action:
        ambiguous > 0
          ? "Keep the original texture folder structure if possible; otherwise choose the intended texture manually before repair."
          : "Run import repair to copy the loose texture files into the exact paths expected by the model."
    });
  }

  if (
    genericLooseTextureImages.length >= 2 &&
    genericLooseTextureImages.length / Math.max(1, report.looseImageCount ?? 0) >= 0.5 &&
    ((report.imageCount ?? 0) === 0 || materialTextureUsageRatio < 0.25)
  ) {
    const examples = genericLooseTextureImages
      .slice(0, 4)
      .map((image) => image.source)
      .join(", ");
    diagnostics.push({
      severity: "warning",
      code: "generic-loose-texture-names",
      title: "Loose texture names are not self-describing",
      message: `${genericLooseTextureImages.length} loose texture file(s) use generic export names${examples ? ` such as ${examples}` : ""}, so automatic material matching cannot safely know which surface each image belongs to.`,
      action: "Ask for the original GLTF ZIP with the texture paths preserved, re-export a GLB with embedded textures, or review each candidate manually in Materials."
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
  } else if ((report.materialCount ?? 0) > 0 && (report.textureCount ?? 0) === 0 && (report.imageCount ?? 0) === 0) {
    diagnostics.push({
      severity: "warning",
      code: "model-has-no-texture-images",
      title: "Model has no texture images",
      message: "The active model has materials but no texture/image definitions, so surfaces will rely only on flat material colors.",
      action: "If the source render has brick, fabric, wood, or wall textures, upload the GLTF ZIP with its texture folder or re-export a GLB with embedded textures."
    });
  } else if ((report.imageCount ?? 0) > 0 && (report.materialCount ?? 0) > 0 && texturedMaterialCount === 0) {
    diagnostics.push({
      severity: "warning",
      code: "image-textures-unused-by-materials",
      title: "Texture images are not assigned",
      message: `${report.imageCount ?? 0} image(s) are present in the active model, but none of the ${report.materialCount ?? 0} material(s) reference texture maps.`,
      action: "Open Materials to assign the intended base, normal, or emissive maps, or re-export the source model with textures connected to material slots."
    });
  } else if ((report.imageCount ?? 0) >= 3 && (report.materialCount ?? 0) >= 8 && materialTextureUsageRatio < 0.15) {
    diagnostics.push({
      severity: "info",
      code: "few-materials-use-textures",
      title: "Few materials use texture images",
      message: `${texturedMaterialCount}/${report.materialCount ?? 0} material(s) reference texture maps even though ${report.imageCount ?? 0} image(s) are present.`,
      action: "Compare against the reference viewer. If detailed surfaces are missing, map textures in Materials or re-export with material texture slots intact."
    });
  } else if (
    (report.imageCount ?? 0) >= 4 &&
    unusedTextureImageCount >= 2 &&
    unusedTextureImageCount / (report.imageCount ?? 1) >= 0.5
  ) {
    diagnostics.push({
      severity: "warning",
      code: "many-unused-texture-images",
      title: "Many texture images are unused",
      message: `${unusedTextureImageCount}/${report.imageCount ?? 0} image texture(s) are present but not connected to any material texture slot.`,
      action: "Open Materials to map the unused images, or re-export the source model with texture nodes connected before judging visual quality."
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
  if (dominantUntexturedMaterials.length > 0) {
    const dominant = dominantUntexturedMaterials[0].dominantMaterial;
    diagnostics.push({
      severity: "warning",
      code: "dominant-untextured-material",
      title: "One plain material dominates the model",
      message: `${dominant.name} covers ${Math.round(dominant.triangleShare * 100)}% of analyzed triangles without an image texture${dominant.baseColor ? ` (${dominant.baseColor})` : ""}.`,
      action: "If the online/reference viewer looks detailed, upload the original texture folder or re-export with embedded textures; otherwise map loose textures in Materials before publishing."
    });
  }
  if (dominantGreenMaterials.length > 0) {
    const dominant = dominantGreenMaterials[0].dominantMaterial;
    diagnostics.push({
      severity: "warning",
      code: "dominant-green-placeholder-material",
      title: "Green/plain surface dominates the model",
      message: `${dominant.name} is a plain green-like material covering ${Math.round(dominant.triangleShare * 100)}% of analyzed triangles.`,
      action: "If this should be only exterior grass/terrain, disable the generated ground and move the first view to the building. If the model should be detailed, re-export with textures or map the loose texture images in Materials."
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
  } else if (extremeAspectTextures.length > 0) {
    diagnostics.push({
      severity: extremeAspectTextures.length > 4 ? "warning" : "info",
      code: "extreme-texture-aspect-ratios",
      title: "Extreme texture aspect ratios",
      message: `${extremeAspectTextures.length} texture image(s) are very wide or tall strips, which can blur, shimmer, or compress poorly in web delivery.`,
      action: "Inspect these textures in Materials and compare against the source viewer. If they are baked strips or atlases, keep enough resolution before optimization."
    });
  } else if (tinyTextures.length > 0 && (report.imageCount ?? 0) > 0) {
    diagnostics.push({
      severity: tinyTextures.length > 4 ? "warning" : "info",
      code: "tiny-texture-dimensions",
      title: "Very small texture images detected",
      message: `${tinyTextures.length} texture image(s) are 256px or smaller on their largest side.`,
      action: "Compare the model against the source/reference viewer. If surfaces look blurry or flat, re-export with higher-resolution textures before optimization."
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

  if ((report.estimatedTextureMemoryBytes ?? 0) > defaultBudget.maxMobileTextureMemoryBytes) {
    diagnostics.push({
      severity: "warning",
      code: "high-texture-memory-estimate",
      title: "High estimated texture memory",
      message: `${formatMegabytes(report.estimatedTextureMemoryBytes)} estimated decoded RGBA texture memory exceeds the mobile target of ${formatMegabytes(defaultBudget.maxMobileTextureMemoryBytes)}.`,
      action: "Downscale less visible textures, remove unused texture images, or run KTX2/Basis compression before mobile delivery."
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
  } else if (
    largestDimension > 1 &&
    footprintCenterDistance > Math.max(250, largestDimension * 8) &&
    modelScale === 1 &&
    !hasModelOffset
  ) {
    diagnostics.push({
      severity: "warning",
      code: "scene-far-from-origin",
      title: "Model is far from the origin",
      message: `The model center is about ${footprintCenterDistance.toFixed(1)} units from world origin while the model spans about ${largestDimension.toFixed(1)} units.`,
      action: "Move the source model near 0,0,0 or run import repair to regenerate focused bounds, camera views, rooms, and navigation from the building footprint."
    });
  } else if (hasModelOffset) {
    diagnostics.push({
      severity: "info",
      code: "model-origin-offset-applied",
      title: "Model origin offset applied",
      message: `The source model is shifted by ${modelOffset.map((value) => value.toFixed(2)).join(", ")} in the viewer so camera views, room maps, and navigation use the focused building area.`,
      action: "Open the viewer and confirm the first view, top view, room buttons, and click-to-move land on the intended building."
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
    const dominatesScene = flatPlane.area / Math.max(1, flatPlane.sceneArea) > 0.55;
    diagnostics.push({
      severity: flatPlane.exteriorNamed || dominatesScene ? "warning" : "info",
      code: "dominant-flat-plane",
      title: "Large flat plane detected",
      message: `${flatPlane.name} covers about ${percent}% of the scene footprint and can dominate camera framing, top views, and click-floor detection.`,
      action: "Run model repair to regenerate focused views, or add explicit walk zones and hide/rename exterior terrain if it should not drive navigation."
    });
  }

  const firstWalkView = (manifest.views ?? []).find((view) => view.kind === "walk") ?? manifest.views?.[0];
  if (
    flatPlane &&
    firstWalkView?.position &&
    pointInBoundsFootprint(firstWalkView.position, flatPlane.bounds, 0.2) &&
    (flatPlane.exteriorNamed || flatPlane.area / Math.max(1, flatPlane.sceneArea) > 0.55)
  ) {
    diagnostics.push({
      severity: "warning",
      code: "initial-view-on-dominant-plane",
      title: "First camera may start on exterior terrain",
      message: `${firstWalkView.label ?? "The first view"} is positioned over ${flatPlane.name}, a large flat surface that can make the viewer open to grass or empty space.`,
      action: "Run import repair or move the first walk view onto the intended interior floor before publishing."
    });
  }

  if (bounds && focusedBounds && firstWalkView?.position) {
    const sceneArea = Math.max(1, boundsArea(bounds));
    const focusArea = boundsArea(focusedBounds);
    const focusRatio = focusArea / sceneArea;
    const focusCenter = boundsFootprintCenter(focusedBounds);
    const focusSpan = Math.max(
      1,
      Math.max(
        Math.abs(focusedBounds.max[0] - focusedBounds.min[0]),
        Math.abs(focusedBounds.max[2] - focusedBounds.min[2])
      )
    );
    const cameraDistance = footprintDistanceToBounds(firstWalkView.position, focusedBounds);
    const targetDistance = footprintDistanceToBounds(firstWalkView.target, focusedBounds);
    const cameraOutsideFocus = !pointInBoundsFootprint(firstWalkView.position, focusedBounds, Math.min(2, focusSpan * 0.18));
    const targetOutsideFocus = firstWalkView.target
      ? !pointInBoundsFootprint(firstWalkView.target, focusedBounds, Math.min(2, focusSpan * 0.18))
      : false;
    if (
      focusRatio > 0 &&
      focusRatio < 0.55 &&
      cameraOutsideFocus &&
      targetOutsideFocus &&
      Math.min(cameraDistance, targetDistance) > Math.max(1.5, focusSpan * 0.22)
    ) {
      diagnostics.push({
        severity: "warning",
        code: "initial-view-misses-focused-model",
        title: "First camera may miss the building",
        message: `${firstWalkView.label ?? "The first view"} starts and looks outside the focused model footprint${focusCenter ? ` near ${focusCenter.map((value) => value.toFixed(1)).join(", ")}` : ""}.`,
        action: "Run import repair to rebuild focused camera views, or move the first walk view and target onto the actual building floor."
      });
    }
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

  if (
    floorMatches === 0 &&
    !hasWalkZones &&
    (flatSurfaceRisk?.ambiguousFlatSurfaceCount ?? 0) >= 6
  ) {
    const examples = flatSurfaceRisk.ambiguousFlatSurfaceExamples.join(", ");
    diagnostics.push({
      severity: "warning",
      code: "ambiguous-flat-walk-surfaces",
      title: "Flat surfaces need explicit walk zones",
      message: `${flatSurfaceRisk.ambiguousFlatSurfaceCount} low flat surface(s) have generic names, so the viewer may not know which ones are real floors${examples ? `, including ${examples}` : ""}.`,
      action: "Use Controls to draw walk zones over the real floor areas, or rename/export actual floor meshes with clear floor/navmesh names."
    });
  }

  if ((flatSurfaceRisk?.flatNonWalkSurfaceCount ?? 0) >= 4 && !hasWalkZones) {
    const examples = flatSurfaceRisk.flatNonWalkExamples.join(", ");
    diagnostics.push({
      severity: "warning",
      code: "flat-object-surfaces-may-catch-clicks",
      title: "Flat furniture/object surfaces may catch clicks",
      message: `${flatSurfaceRisk.flatNonWalkSurfaceCount} low flat object surface(s) look like tabletops, counters, beds, cabinets, or decor${examples ? `, including ${examples}` : ""}.`,
      action: "Add explicit walk zones for real floors or mark those objects as collision/ignored in Objects so click-to-move does not treat them like walkable floor."
    });
  }

  if ((flatSurfaceRisk?.walkLikeLevels?.length ?? 0) >= 3 && !hasWalkZones) {
    const levels = flatSurfaceRisk.walkLikeLevels
      .slice(0, 5)
      .map((level) => level.level.toFixed(2))
      .join(", ");
    diagnostics.push({
      severity: "info",
      code: "multiple-floor-heights-detected",
      title: "Multiple floor heights detected",
      message: `Floor-like surfaces appear at ${flatSurfaceRisk.walkLikeLevels.length} height levels${levels ? ` (${levels})` : ""}.`,
      action: "Use explicit walk zones and door/step passes for stairs, thresholds, balconies, or split levels so click navigation does not hop between unrelated surfaces."
    });
  }

  if (collisionMatches === 0 && !hasBlockZones) {
    diagnostics.push({
      severity: "warning",
      code: "no-named-collision-meshes",
      title: "No named collision meshes found",
      message: "Wall collision will be inferred from thin tall geometry and may miss cupboards, railings, or exterior boundaries.",
      action: "Add collision keywords for walls, windows, partitions, columns, and boundary meshes, or add block zones in Controls."
    });
  }

  if (ceilingMatches === 0) {
    const likelyArchitecturalScene = floorMatches > 0 || collisionMatches > 0 || hasWalkZones || rooms.length > 0;
    diagnostics.push({
      severity: likelyArchitecturalScene ? "warning" : "info",
      code: "no-named-ceiling-meshes",
      title: "No named ceiling or roof meshes found",
      message: "The model may be open at the top, or ceiling geometry may use generic object names.",
      action: "Check the model in top and interior views before client delivery. If ceilings exist but are invisible, enable double-sided materials or rename ceiling/roof objects before import."
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

  const suspiciousGeneratedWalkZones = topology.walkZones.filter((zone) => {
    if (zone.source !== "generated") {
      return false;
    }
    return likelyNonWalkSurfaceName(`${zone.label ?? ""} ${zone.id ?? ""}`);
  });
  if (suspiciousGeneratedWalkZones.length > 0) {
    const examples = suspiciousGeneratedWalkZones
      .slice(0, 4)
      .map((zone) => zone.label ?? zone.id)
      .join(", ");
    diagnostics.push({
      severity: "warning",
      code: "generated-walk-zones-on-non-floor-objects",
      title: "Generated walk zones may include non-floor objects",
      message: `${suspiciousGeneratedWalkZones.length} generated walk zone(s) look like furniture, decor, doors, windows, ceilings, or roofs${examples ? `: ${examples}` : ""}.`,
      action: "Open Controls > Navigation repair, disable those generated walk zones, then add walk patches only on the real floor surfaces."
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
    const islandSummary = navigationComponentSummary(topology.routeComponents);
    diagnostics.push({
      severity: "warning",
      code: "disconnected-navigation-zones",
      title: "Walkable areas are disconnected",
      message: `${topology.routeComponents.length} separate navigation islands were detected across walk/pass zones${
        islandSummary ? `: ${islandSummary}.` : "."
      }`,
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

  if (topology.oneSidedPassZones.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "one-sided-pass-zones",
      title: "Door pass zones touch only one room",
      message: `${topology.oneSidedPassZones.length} pass zone(s) overlap one walk zone but do not reach a second walk zone.`,
      action: "Extend each door pass through the opening, or add a walk patch inside the target room so routing can cross the doorway."
    });
  }

  if (topology.blockedPassZones.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "pass-zones-overlap-block-zones",
      title: "Door pass zones overlap blockers",
      message: `${topology.blockedPassZones.length} pass zone(s) overlap a wall or boundary block zone, so the door connector may still be blocked.`,
      action: "Split, shrink, or move the block zone around each doorway pass; the pass should bridge walk areas without sitting inside a blocker."
    });
  }

  if (topology.blockedWalkZones.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "walk-zones-overlap-block-zones",
      title: "Walk zones overlap blockers",
      message: `${topology.blockedWalkZones.length} walk zone(s) overlap a wall, boundary, or custom blocker, so users may see valid floor areas that still refuse movement.`,
      action: "Shrink or split the block zones around the room floor, or trim the walk zone so the allowed walking area does not sit inside blockers."
    });
  }

  if (topology.narrowPassZones.length > 0) {
    const requiredSpan = Math.max(0.42, bodyRadius * 2);
    diagnostics.push({
      severity: "warning",
      code: "narrow-pass-zones",
      title: "Door pass zones may be too narrow",
      message: `${topology.narrowPassZones.length} pass zone(s) are narrower than the ${requiredSpan.toFixed(2)}m clearance needed by the current Body Radius.`,
      action: "Widen the pass zones or reduce Body Radius in Controls before relying on these doorways."
    });
  }

  if (topology.outOfBoundsWalkZones.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "walk-zones-outside-navigation-bounds",
      title: "Walk zones extend outside movement bounds",
      message: `${topology.outOfBoundsWalkZones.length} walk zone(s) extend outside the configured movement bounds, so those floor areas may look valid but refuse movement.`,
      action: "Expand the navigation bounds or trim the walk zones so all reachable floor areas sit inside the movement bounds."
    });
  }

  if (topology.outOfBoundsPassZones.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "pass-zones-outside-navigation-bounds",
      title: "Door pass zones extend outside movement bounds",
      message: `${topology.outOfBoundsPassZones.length} pass zone(s) extend outside the configured movement bounds, so doorway routing may stop at the edge of the allowed area.`,
      action: "Expand the navigation bounds or move the door pass zones fully inside the movement bounds."
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

  if (topology.walkZones.length > 0 && rooms.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-room-map",
      title: "No room map configured",
      message: "Walk zones exist, but the scene has no room/floorplan entries for room buttons or client-facing area labels.",
      action: "Open Rooms and sync from walk areas or saved views, then rename the generated room entries."
    });
  } else if (rooms.length > 0 && roomsWithBounds.length === 0 && topology.walkZones.length > 0) {
    diagnostics.push({
      severity: "info",
      code: "room-map-missing-bounds",
      title: "Rooms need floorplan areas",
      message: `${rooms.length} room entry(s) exist, but none have bounds for the floorplan map.`,
      action: "Use Rooms > From Walks to create draggable room areas from authored walk zones."
    });
  } else if (roomsWithBounds.length > 0 && roomsWithBounds.length < Math.min(topology.walkZones.length, 3)) {
    diagnostics.push({
      severity: "info",
      code: "partial-room-map",
      title: "Room map covers only part of navigation",
      message: `${roomsWithBounds.length} room area(s) are mapped for ${topology.walkZones.length} walk zone(s).`,
      action: "Sync rooms from walk areas, then remove or merge any extra areas that are not actual rooms."
    });
  }

  if (rooms.length > 0 && topology.walkViews.length > 0 && linkedWalkRoomCount === 0) {
    diagnostics.push({
      severity: "info",
      code: "rooms-not-linked-to-views",
      title: "Rooms are not linked to camera views",
      message: `${rooms.length} room entry(s) exist, but none link to a saved walk view.`,
      action: "Link each room to its closest saved walk view so floorplan clicks and room buttons land in useful positions."
    });
  }

  if (hotspotsMissingContent.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "hotspots-missing-content",
      title: "Hotspots need visible content",
      message: `${hotspotsMissingContent.length} hotspot interaction(s) have no title or label to show users.`,
      action: "Open Interactions and add a short hotspot title, or remove unused placeholder hotspots."
    });
  }

  if (hotspotsWithBadPositions.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "hotspots-invalid-position",
      title: "Hotspots have invalid positions",
      message: `${hotspotsWithBadPositions.length} hotspot interaction(s) do not have a valid 3D position.`,
      action: "Open Interactions and place each hotspot visually on the model before publishing."
    });
  }

  if (linksMissingUrl.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "links-missing-url",
      title: "Links have no destination",
      message: `${linksMissingUrl.length} link interaction(s) are placed in the scene but have no URL.`,
      action: "Open Interactions and add the destination URL, or remove unused link markers."
    });
  }

  if (linksWithInvalidUrl.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "links-invalid-url",
      title: "Links use unsupported URLs",
      message: `${linksWithInvalidUrl.length} link interaction(s) have URLs that may not open reliably in the viewer.`,
      action: "Use https://, http://, mailto:, tel:, or a relative path for scene links."
    });
  }

  if (linksWithBadPositions.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "links-invalid-position",
      title: "Links have invalid positions",
      message: `${linksWithBadPositions.length} link interaction(s) do not have a valid 3D position.`,
      action: "Open Interactions and place each link marker visually on the model before publishing."
    });
  }

  if (videoTexturesMissingSource.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "video-textures-missing-source",
      title: "Video screens have no video source",
      message: `${videoTexturesMissingSource.length} video screen interaction(s) are mapped but have no uploaded video or URL.`,
      action: "Upload a video in Interactions or remove unused planned screens before publishing."
    });
  }

  if (videoTexturesMissingTarget.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "video-textures-missing-target",
      title: "Video screens are not mapped to surfaces",
      message: `${videoTexturesMissingTarget.length} video screen interaction(s) do not target a mesh or material.`,
      action: "Use Interactions > TV screens > Map Likely, or select a target mesh/material manually."
    });
  }

  if (videoTexturesWithMissingTargets.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "video-textures-target-missing",
      title: "Video screen target was not found",
      message: `${videoTexturesWithMissingTargets.length} video screen interaction(s) reference mesh/material names that were not found in the current model graph.`,
      action: "Remap those video screens after re-importing or repairing the model."
    });
  }

  if (materialVariantsMissingTarget.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "material-variants-missing-target",
      title: "Finish variants are not mapped to surfaces",
      message: `${materialVariantsMissingTarget.length} finish variant set(s) do not target a mesh or material.`,
      action: "Open Variants and choose the material or mesh each finish set should control."
    });
  }

  if (materialVariantsWithMissingTargets.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "material-variants-target-missing",
      title: "Finish variant target was not found",
      message: `${materialVariantsWithMissingTargets.length} finish variant set(s) reference mesh/material names that were not found in the current model graph.`,
      action: "Open Variants and pick the finish target again after reimporting or repairing the model."
    });
  }

  if (materialVariantsWithoutOptions.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "material-variants-no-options",
      title: "Finish variants have no visible options",
      message: `${materialVariantsWithoutOptions.length} finish variant set(s) have no color or texture options to show in the viewer.`,
      action: "Open Variants and add at least one finish option or remove unused variant sets."
    });
  }

  if (materialVariantsWithInvisibleOptions.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "material-variants-invisible-options",
      title: "Finish options do not change visuals",
      message: `${materialVariantsWithInvisibleOptions.length} finish variant set(s) include option(s) with no color or texture.`,
      action: "Open Variants and give every finish option a color swatch or texture thumbnail before publishing."
    });
  }

  if (materialVariantsWithInvalidTextureUrls.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "material-variants-generated-textures",
      title: "Finish textures are placeholders",
      message: `${materialVariantsWithInvalidTextureUrls.length} finish variant set(s) reference generated texture placeholders that the published viewer cannot load as files.`,
      action: "Open Variants and replace generated placeholders with saved image files or color swatches."
    });
  }

  if (missingMaterialVariantTextureAssets.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "material-variants-missing-texture-assets",
      title: "Finish texture files are missing",
      message: `${missingMaterialVariantTextureAssets.length} finish texture file(s) are referenced but missing from the scene bundle.`,
      action: "Open Variants and replace the missing texture path with an uploaded texture file or a color swatch."
    });
  }

  if (objectTogglesMissingTarget.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "object-toggles-missing-target",
      title: "Object toggles are not mapped to objects",
      message: `${objectTogglesMissingTarget.length} object toggle interaction(s) do not target a scene object.`,
      action: "Open Interactions and choose the object each toggle should show or hide before publishing."
    });
  }

  if (objectTogglesWithMissingTargets.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "object-toggles-target-missing",
      title: "Object toggle target was not found",
      message: `${objectTogglesWithMissingTargets.length} object toggle interaction(s) reference objects that were not found in the current model graph.`,
      action: "Open Interactions and pick the target object again after reimporting or repairing the model."
    });
  }

  if (objectTogglesWithBadPositions.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "object-toggles-invalid-position",
      title: "Object toggles have invalid positions",
      message: `${objectTogglesWithBadPositions.length} object toggle interaction(s) do not have a valid 3D marker position.`,
      action: "Open Interactions and place each toggle marker visually near the object it controls."
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
      title: "Texture transfer compression missing",
      message: "The model uses texture images but does not advertise WebP transfer textures or KHR_texture_basisu/KTX2 GPU textures.",
      action: "Run optimization to create WebP transfer textures, then enable KTX2/Basis for production GPU-memory savings."
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

function summarize(manifest, assets, models, graphs, looseImages, materialOverrides, objectOverrides, controls, materialLightmapAssets) {
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
  const texturedMaterialCount = models.reduce((sum, model) => sum + (model.texturedMaterialCount ?? 0), 0);
  const textureCount = models.reduce((sum, model) => sum + (model.textureCount ?? 0), 0);
  const imageCount = models.reduce((sum, model) => sum + (model.imageCount ?? 0), 0);
  const materialTextureImageCount = models.reduce((sum, model) => sum + (model.materialTextureImageCount ?? 0), 0);
  const unusedTextureImageCount = models.reduce((sum, model) => sum + (model.unusedTextureImageCount ?? 0), 0);
  const lightmapMaterials = (materialOverrides?.materials ?? []).filter((material) => material?.lightMapUrl);
  const lightmapAssetList = materialLightmapAssets ?? [];
  const missingLightmapAssetCount = lightmapAssetList.filter((asset) => !asset.exists).length;
  const tinyLightmapAssetCount = lightmapAssetList.filter(
    (asset) => asset.exists && asset.bytes > 0 && asset.bytes < 4096
  ).length;
  const lightmapAssetBytes = lightmapAssetList.reduce((sum, asset) => sum + asset.bytes, 0);
  const objectOverrideList = objectOverrides?.objects ?? [];
  const graphNodeNames = new Set((graphs[0]?.nodes ?? []).map((node) => node.name).filter(Boolean));
  const graphNodeIds = new Set((graphs[0]?.nodes ?? []).map((node) => node.id).filter(Boolean));
  const staleObjectOverrideCount = objectOverrideList.filter(
    (object) => !graphNodeNames.has(object.name) && !graphNodeIds.has(object.id)
  ).length;
  const invalidObjectNavigationBehaviorCount = objectOverrideList.filter(
    (object) =>
      object.navigationBehavior !== undefined && !isObjectNavigationBehavior(object.navigationBehavior)
  ).length;
  const secondaryUvLightmapMaterialCount = lightmapMaterials.filter(
    (material) => material.lightMapUvSet !== 0
  ).length;
  const textureImages = [
    ...looseImages,
    ...models.flatMap((model) => model.embeddedImages ?? []),
    ...models.flatMap((model) => model.externalResources ?? []).filter((resource) => resource.kind === "texture")
  ].filter((image) => typeof image.width === "number" && typeof image.height === "number");
  const estimatedTexturePixels = textureImages.reduce(
    (sum, image) => sum + Math.max(0, image.width ?? 0) * Math.max(0, image.height ?? 0),
    0
  );
  const estimatedTextureMemoryBytes = estimatedTexturePixels * 4;
  const textureMemoryImages = textureImages
    .map((image) => {
      const width = Math.max(0, image.width ?? 0);
      const height = Math.max(0, image.height ?? 0);
      return {
        source: image.source ?? image.label ?? "Embedded texture",
        width,
        height,
        estimatedBytes: width * height * 4,
        ...(typeof image.bytes === "number" ? { bytes: image.bytes } : {})
      };
    })
    .filter((image) => image.estimatedBytes > 0)
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes || a.source.localeCompare(b.source));
  const relocatedTextureCandidates = missingResourceRelocationCandidates(models, looseImages);
  const maxTextureDimension = textureImages.reduce(
    (max, image) => Math.max(max, image.width ?? 0, image.height ?? 0),
    0
  );
  const oversizedTextureCount = textureImages.filter((image) => Math.max(image.width, image.height) > 4096).length;
  const extremeAspectTextureCount = textureImages.filter((image) => {
    const width = image.width ?? 0;
    const height = image.height ?? 0;
    const shortestSide = Math.min(width, height);
    return shortestSide > 0 && Math.max(width, height) / shortestSide >= 8;
  }).length;
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

  if (primitiveCount > defaultBudget.maxMobileDrawPrimitives) {
    warnings.push({
      code: "mobile-draw-primitive-budget",
      message: `Draw primitive count exceeds mobile target of ${defaultBudget.maxMobileDrawPrimitives.toLocaleString()}.`
    });
  }

  if (estimatedTextureMemoryBytes > defaultBudget.maxMobileTextureMemoryBytes) {
    warnings.push({
      code: "mobile-texture-memory-budget",
      message: `Estimated decoded texture memory exceeds mobile target of ${formatMegabytes(defaultBudget.maxMobileTextureMemoryBytes)}.`
    });
  }

  if (materialCount > defaultBudget.maxMobileMaterials) {
    warnings.push({
      code: "mobile-material-budget",
      message: `Material count exceeds mobile target of ${defaultBudget.maxMobileMaterials}.`
    });
  }

  const sceneBounds = graphBounds(graphs[0]);
  const focusedModelBounds = graphFocusBounds(graphs[0]);
  const sceneBoundsSize = boundsSize(sceneBounds);
  const focusedBoundsSize = boundsSize(focusedModelBounds);
  const sceneFootprintCenter = boundsFootprintCenter(sceneBounds);
  const focusedFootprintCenter = boundsFootprintCenter(focusedModelBounds);
  const sceneFootprintCenterDistance = sceneFootprintCenter ? Math.hypot(sceneFootprintCenter[0], sceneFootprintCenter[1]) : undefined;
  const focusedFootprintCenterDistance = focusedFootprintCenter ? Math.hypot(focusedFootprintCenter[0], focusedFootprintCenter[1]) : undefined;
  const modelOffset = Array.isArray(manifest.rendering?.modelOffset) ? manifest.rendering.modelOffset : undefined;
  const modelOffsetDistance = modelOffset ? Math.hypot(modelOffset[0], modelOffset[2]) : undefined;

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
    texturedMaterialCount,
    textureCount,
    imageCount,
    materialTextureImageCount,
    unusedTextureImageCount,
    lightmapMaterialCount: lightmapMaterials.length,
    secondaryUvLightmapMaterialCount,
    lightmapAssetCount: lightmapAssetList.length,
    missingLightmapAssetCount,
    tinyLightmapAssetCount,
    lightmapAssetBytes,
    lightmapAssets: lightmapAssetList.slice(0, 40),
    objectOverrideCount: objectOverrideList.length,
    staleObjectOverrideCount,
    invalidObjectNavigationBehaviorCount,
    maxTextureDimension,
    oversizedTextureCount,
    extremeAspectTextureCount,
    estimatedTexturePixels,
    estimatedTextureMemoryBytes,
    textureMemoryImages: textureMemoryImages.slice(0, 40),
    ...(modelOffset
      ? {
          modelOffset,
          modelOffsetDistance
        }
      : {}),
    embeddedImageCount: models.reduce((sum, model) => sum + (model.embeddedImageCount ?? 0), 0),
    looseImageCount: looseImages.length,
    looseImages: looseImages.slice(0, 40),
    relocatedTextureCandidateCount: relocatedTextureCandidates.length,
    ambiguousRelocatedTextureCandidateCount: relocatedTextureCandidates.filter((candidate) => candidate.ambiguous).length,
    relocatedTextureCandidates: relocatedTextureCandidates.slice(0, 20),
    ...(sceneBounds
      ? {
          sceneBounds,
          sceneBoundsSize,
          sceneLargestDimension: sceneBoundsSize ? Math.max(...sceneBoundsSize.map(Math.abs)) : 0,
          sceneFootprintCenter,
          sceneFootprintCenterDistance
        }
      : {}),
    ...(focusedModelBounds
      ? {
          focusedModelBounds,
          focusedBoundsSize,
          focusedLargestDimension: focusedBoundsSize ? Math.max(...focusedBoundsSize.map(Math.abs)) : 0,
          focusedFootprintCenter,
          focusedFootprintCenterDistance
        }
      : {}),
    compression,
    warnings,
    assets,
    models
  };
  return {
    ...report,
    diagnostics: createDiagnostics(manifest, report, graphs, controls)
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
  if (report.primitiveCount > budgets.maxDrawPrimitives) {
    warnings.push({
      code: "draw-primitives",
      message: `Draw primitive count is over the ${profile.label} budget.`
    });
  }
  if ((report.estimatedTextureMemoryBytes ?? 0) > budgets.maxTextureMemoryBytes) {
    warnings.push({
      code: "texture-memory",
      message: `Estimated decoded texture memory is over the ${profile.label} budget.`
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

  if (report.primitiveCount > optimizationProfiles[0].budgets.maxDrawPrimitives) {
    recommendations.push({
      priority: "high",
      action: "Join compatible primitives and merge safe static batches.",
      reason: "High draw primitive count can bottleneck mobile GPUs even when triangle count is acceptable."
    });
  }

  if ((report.estimatedTextureMemoryBytes ?? 0) > optimizationProfiles[0].budgets.maxTextureMemoryBytes) {
    recommendations.push({
      priority: "high",
      action: "Downscale oversized texture sets and convert delivery textures to KTX2/Basis.",
      reason: "Decoded texture memory is above the mobile GPU target."
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
        : "The model has texture images but does not advertise WebP transfer textures or KHR_texture_basisu GPU textures."
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

function texturePlanForProfile(report, profile) {
  const currentBytes = report.estimatedTextureMemoryBytes ?? 0;
  const budgetBytes = profile.budgets.maxTextureMemoryBytes;
  const textureImages = report.textureMemoryImages ?? [];
  const profileMaxDimension = profile.id === "mobile" ? 1024 : profile.id === "balanced" ? 2048 : 4096;
  const globalScale = currentBytes > budgetBytes && currentBytes > 0 ? Math.sqrt(budgetBytes / currentBytes) : 1;
  const items = textureImages
    .map((image) => {
      const maxDimension = Math.max(image.width, image.height);
      if (maxDimension <= 0 || image.estimatedBytes <= 0) {
        return undefined;
      }
      const scaledTarget = Math.floor((maxDimension * globalScale) / 128) * 128;
      const targetMaxDimension = Math.max(512, Math.min(maxDimension, profileMaxDimension, scaledTarget || maxDimension));
      const scale = targetMaxDimension / maxDimension;
      const targetWidth = Math.max(1, Math.round(image.width * scale));
      const targetHeight = Math.max(1, Math.round(image.height * scale));
      const estimatedBytesAfter = targetWidth * targetHeight * 4;
      const estimatedSavingsBytes = Math.max(0, image.estimatedBytes - estimatedBytesAfter);
      if (estimatedSavingsBytes < 1024 * 1024 && maxDimension <= profileMaxDimension) {
        return undefined;
      }
      return {
        source: image.source,
        width: image.width,
        height: image.height,
        currentBytes: image.estimatedBytes,
        targetWidth,
        targetHeight,
        targetMaxDimension,
        estimatedBytesAfter,
        estimatedSavingsBytes,
        reason:
          maxDimension > profileMaxDimension
            ? `Over ${profile.label} ${profileMaxDimension}px edge target`
            : "Part of decoded texture-memory reduction"
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.estimatedSavingsBytes - a.estimatedSavingsBytes || b.currentBytes - a.currentBytes)
    .slice(0, 12);
  const estimatedAfterBytes = Math.max(
    0,
    currentBytes - items.reduce((sum, item) => sum + item.estimatedSavingsBytes, 0)
  );
  return {
    profileId: profile.id,
    label: profile.label,
    status: currentBytes <= budgetBytes ? "ready" : estimatedAfterBytes <= budgetBytes ? "planned" : "needs-review",
    budgetBytes,
    currentBytes,
    estimatedAfterBytes,
    estimatedSavingsBytes: Math.max(0, currentBytes - estimatedAfterBytes),
    maxDimension: profileMaxDimension,
    items
  };
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
        drawPrimitives: report.primitiveCount,
        textureMemoryBytes: report.estimatedTextureMemoryBytes,
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
    texturePlans: optimizationProfiles.map((profile) => texturePlanForProfile(report, profile)),
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

  if (report.primitiveCount > optimizationProfiles[0].budgets.maxDrawPrimitives) {
    warnings.push(
      publishReadinessIssue(
        "mobile-draw-primitive-budget",
        "High draw primitive count",
        `Draw primitive count exceeds ${optimizationProfiles[0].budgets.maxDrawPrimitives.toLocaleString()} draw primitives.`,
        "Run draw-call optimization or merge compatible static primitives before mobile delivery."
      )
    );
  }

  if ((report.estimatedTextureMemoryBytes ?? 0) > optimizationProfiles[0].budgets.maxTextureMemoryBytes) {
    warnings.push(
      publishReadinessIssue(
        "mobile-texture-memory-budget",
        "High decoded texture memory",
        `Estimated decoded texture memory is ${formatMegabytes(report.estimatedTextureMemoryBytes)}, above the ${formatMegabytes(optimizationProfiles[0].budgets.maxTextureMemoryBytes)} mobile target.`,
        "Downscale large texture sets and run KTX2/Basis texture compression before mobile delivery."
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
    "dominant-flat-plane",
    "initial-view-on-dominant-plane",
    "focused-model-small-in-scene",
    "missing-scene-bounds",
    "missing-gltf-scene-definitions",
    "meshes-outside-default-scene",
    "non-triangle-primitives",
    "large-coordinate-units",
    "scene-far-from-origin",
    "no-named-floor-meshes",
    "ambiguous-flat-walk-surfaces",
    "flat-object-surfaces-may-catch-clicks",
    "multiple-floor-heights-detected",
    "no-named-collision-meshes",
    "no-named-ceiling-meshes",
    "missing-walk-zones",
    "generated-walk-zones-on-non-floor-objects",
    "disconnected-navigation-zones",
    "missing-pass-zones",
    "orphan-pass-zones",
    "narrow-pass-zones",
    "one-sided-pass-zones",
    "pass-zones-overlap-block-zones",
    "walk-zones-overlap-block-zones",
    "walk-zones-outside-navigation-bounds",
    "pass-zones-outside-navigation-bounds",
    "walk-views-inside-block-zones",
    "walk-views-outside-walk-zones",
    "missing-room-map",
    "textured-primitives-missing-uvs",
    "unassigned-primitive-materials",
    "invalid-normal-accessor-shapes",
    "invalid-uv-accessor-shapes",
    "mostly-unlit-materials",
    "vertex-colors-detected",
    "dominant-transparent-surface",
    "case-mismatched-model-resources",
    "unsupported-image-mime-types",
    "relocatable-texture-resources",
    "loose-textures-not-referenced",
    "generic-loose-texture-names",
    "model-has-no-texture-images",
    "image-textures-unused-by-materials",
    "few-materials-use-textures",
    "many-unused-texture-images",
    "loose-texture-files",
    "dominant-untextured-material",
    "dominant-green-placeholder-material",
    "oversized-texture-dimensions",
    "extreme-texture-aspect-ratios",
    "tiny-texture-dimensions",
    "many-large-textures",
    "high-texture-memory-estimate",
    "missing-texture-compression",
    "unbaked-materials",
    "partial-lightmap-coverage",
    "some-lightmap-secondary-uvs-missing",
    "tiny-lightmap-assets",
    "hotspots-missing-content",
    "hotspots-invalid-position",
    "links-missing-url",
    "links-invalid-url",
    "links-invalid-position",
    "video-textures-missing-source",
    "video-textures-missing-target",
    "video-textures-target-missing",
    "material-variants-missing-target",
    "material-variants-target-missing",
    "material-variants-no-options",
    "material-variants-invisible-options",
    "material-variants-generated-textures",
    "material-variants-missing-texture-assets",
    "object-toggles-missing-target",
    "object-toggles-target-missing",
    "object-toggles-invalid-position",
    "duplicate-node-names",
    "duplicate-material-names",
    "repeated-large-mesh-instances",
    "zero-scale-nodes",
    "negative-scale-nodes",
    "suspicious-node-scales",
    "high-draw-primitive-count",
    "stale-object-overrides",
    "invalid-object-navigation-behavior"
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
const materialLightmapAssets = await Promise.all(collectMaterialLightmapReferences(materialOverrides).map(assetSize));
const objectOverrides = await readJsonIfExists(path.resolve(bundleDir, "objects.json"));
const controls = await readJsonIfExists(path.resolve(bundleDir, "controls.json"));
const materialTextureSuggestions = [];
const materialsDocument = materialDocs[0]
  ? applyLooseTextureSuggestions(
      mergeMaterialEdits(materialDocs[0], materialOverrides),
      looseImages,
      materialOverrides,
      materialTextureSuggestions
    )
  : undefined;
const report = summarize(
  manifest,
  assets,
  models,
  graphs,
  looseImages,
  materialOverrides,
  objectOverrides,
  controls,
  materialLightmapAssets
);
const optimizationReport = createOptimizationReport(report);
const finalReport = {
  ...report,
  materialTextureSuggestionCount: materialTextureSuggestions.length,
  materialTextureSuggestions: materialTextureSuggestions.slice(0, 40),
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
  if (materialsDocument) {
    await writeFile(
      path.resolve(bundleDir, "materials.json"),
      `${JSON.stringify(materialsDocument, null, 2)}\n`
    );
  }
}

console.log(JSON.stringify(finalReport, null, 2));
