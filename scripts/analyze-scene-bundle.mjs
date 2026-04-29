import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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
  const fullPath = path.resolve(path.dirname(asset.path), source);
  try {
    await access(fullPath);
    const info = await stat(fullPath);
    return {
      kind,
      source,
      label,
      exists: true,
      bytes: info.size
    };
  } catch {
    return {
      kind,
      source,
      label,
      exists: false,
      bytes: 0
    };
  }
}

function normalizeBundlePath(source) {
  return source.split(/[?#]/, 1)[0].replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
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
      files.push({
        source: relativePath,
        bytes: info.size
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

function parseGlbJson(bytes) {
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

  return JSON.parse(new TextDecoder().decode(bytes.slice(20, 20 + jsonChunkLength)).trim());
}

async function analyzeGltfDocument(document, format, asset) {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  const extensionsUsed = document.extensionsUsed ?? [];
  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let usesDraco = extensionsUsed.includes("KHR_draco_mesh_compression");

  for (const mesh of meshes) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) {
        usesDraco = true;
      }
      primitiveCount += 1;
      const positionAccessorIndex = primitive.attributes?.POSITION;
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
  const usesMeshopt =
    extensionsUsed.includes("EXT_meshopt_compression") ||
    (document.bufferViews ?? []).some((view) => Boolean(view.extensions?.EXT_meshopt_compression));
  const usesBasisu =
    extensionsUsed.includes("KHR_texture_basisu") ||
    (document.textures ?? []).some((texture) => Boolean(texture.extensions?.KHR_texture_basisu));
  const usesWebp =
    extensionsUsed.includes("EXT_texture_webp") ||
    (document.textures ?? []).some((texture) => Boolean(texture.extensions?.EXT_texture_webp));

  return {
    format,
    version: document.asset?.version,
    generator: document.asset?.generator,
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
    extensionCount: extensionsUsed.length,
    requiredExtensionCount: document.extensionsRequired?.length ?? 0,
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

function extractSceneGraph(document, source) {
  const accessors = document.accessors ?? [];
  const meshes = document.meshes ?? [];
  const materialUsage = new Map();
  const parentByChild = new Map();
  const nodes = [];

  for (const [nodeIndex, node] of (document.nodes ?? []).entries()) {
    for (const childIndex of node.children ?? []) {
      parentByChild.set(childIndex, nodeIndex);
    }
  }

  for (const [sourceIndex, node] of (document.nodes ?? []).entries()) {
    const name = stableName(node.name, `Object ${sourceIndex}`);
    const mesh = typeof node.mesh === "number" ? meshes[node.mesh] : undefined;
    const materialIds = new Set();
    let vertexCount = 0;
    let triangleCount = 0;
    let bounds;

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
      bounds = mergeBounds(bounds, accessorBounds(positionAccessor));

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
  if (extension === ".glb") {
    const bytes = await readFile(asset.path);
    return analyzeGltfDocument(parseGlbJson(bytes), "glb", asset);
  }

  if (extension === ".gltf") {
    return analyzeGltfDocument(JSON.parse(await readFile(asset.path, "utf8")), "gltf", asset);
  }

  return undefined;
}

async function modelGraph(asset) {
  if (!asset.exists || asset.kind !== "model") {
    return undefined;
  }

  const extension = path.extname(asset.source).toLowerCase();
  if (extension === ".glb") {
    const bytes = await readFile(asset.path);
    return extractSceneGraph(parseGlbJson(bytes), asset.source);
  }

  if (extension === ".gltf") {
    return extractSceneGraph(JSON.parse(await readFile(asset.path, "utf8")), asset.source);
  }

  return undefined;
}

async function modelMaterials(asset) {
  if (!asset.exists || asset.kind !== "model") {
    return undefined;
  }

  const extension = path.extname(asset.source).toLowerCase();
  if (extension === ".glb") {
    const bytes = await readFile(asset.path);
    return extractMaterialsDocument(parseGlbJson(bytes), asset.source);
  }

  if (extension === ".gltf") {
    return extractMaterialsDocument(JSON.parse(await readFile(asset.path, "utf8")), asset.source);
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

function keywordMatchCount(graph, keywords) {
  const normalized = keywords.map((keyword) => keyword.toLowerCase());
  return (graph?.nodes ?? []).filter((node) => {
    const name = `${node.name} ${node.meshName ?? ""}`.toLowerCase();
    return normalized.some((keyword) => name.includes(keyword));
  }).length;
}

function createDiagnostics(manifest, report, graphs) {
  const diagnostics = [];
  const graph = graphs[0];
  const bounds = graphBounds(graph);
  const size = boundsSize(bounds);
  const largestDimension = size ? Math.max(...size.map(Math.abs)) : 0;
  const modelScale = manifest.rendering?.modelScale ?? 1;
  const missingExternalResources = report.models.reduce(
    (sum, model) => sum + (model.missingExternalResourceCount ?? 0),
    0
  );
  const floorMatches = keywordMatchCount(graph, manifest.navigation?.floorMeshNames ?? []);
  const collisionMatches = keywordMatchCount(graph, manifest.navigation?.collisionMeshNames ?? []);
  const ceilingMatches = keywordMatchCount(graph, ["ceiling", "roof", "soffit", "false ceiling"]);
  const navigationZones = Array.isArray(manifest.navigation?.zones) ? manifest.navigation.zones : [];
  const hasWalkZones = navigationZones.some((zone) => zone.kind === "walk" && zone.enabled !== false);
  const hasBlockZones = navigationZones.some((zone) => zone.kind === "block" && zone.enabled !== false);

  if (missingExternalResources > 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-model-resources",
      title: "Missing model textures or buffers",
      message: `${missingExternalResources} GLTF resource(s) referenced by the model are not present next to the scene file.`,
      action: "Upload a ZIP containing the GLTF/GLB plus its texture and .bin folders, preserving relative paths."
    });
  }

  if ((report.looseImageCount ?? 0) > 0) {
    diagnostics.push({
      severity: "info",
      code: "loose-texture-files",
      title: "Loose texture files detected",
      message: `${report.looseImageCount} image file(s) exist in the scene folder but are not referenced by the active model.`,
      action: "If these textures should appear in the model, export/upload the original GLTF with its referenced texture paths, or confirm the GLB already embeds the correct textures."
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

function summarize(manifest, assets, models, graphs, looseImages) {
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
  const materialCount = models.reduce((sum, model) => sum + model.materialCount, 0);
  const textureCount = models.reduce((sum, model) => sum + (model.textureCount ?? 0), 0);
  const imageCount = models.reduce((sum, model) => sum + (model.imageCount ?? 0), 0);
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
    materialCount,
    textureCount,
    imageCount,
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

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== "0.1") {
  throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
}

const assets = await Promise.all(collectAssetReferences(manifest).map(assetSize));
const models = (await Promise.all(assets.map(modelStats))).filter(Boolean);
const graphs = (await Promise.all(assets.map(modelGraph))).filter(Boolean);
const materialDocs = (await Promise.all(assets.map(modelMaterials))).filter(Boolean);
const looseImages = await looseBundleImages(assets, models);
const report = summarize(manifest, assets, models, graphs, looseImages);
const optimizationReport = createOptimizationReport(report);

if (writeStats) {
  await writeFile(path.resolve(bundleDir, "stats.json"), `${JSON.stringify(report, null, 2)}\n`);
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

console.log(JSON.stringify(report, null, 2));
