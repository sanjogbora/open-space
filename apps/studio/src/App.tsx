import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Box,
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  FileJson,
  Globe2,
  Layers3,
  MapPin,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  Video
} from "lucide-react";
import {
  parseSceneManifest,
  type HotspotInteraction,
  type LinkInteraction,
  type MaterialOverride,
  type MaterialVariant,
  type MaterialVariantInteraction,
  type ObjectOverride,
  type ObjectToggleInteraction,
  type SceneControlsDocument,
  type SceneGraphDocument,
  type SceneInteraction,
  type SceneManifest,
  type SceneView,
  type Vec3
} from "@walkthrough/scene-schema";

type StudioTab =
  | "overview"
  | "import"
  | "optimization"
  | "publish"
  | "views"
  | "interactions"
  | "materials"
  | "variants"
  | "objects"
  | "controls"
  | "bundle";
type Notice = "saved" | "copied" | "reset" | null;
type UploadState = "idle" | "uploading" | "done" | "error";
type PublishState = "idle" | "publishing" | "done" | "error";
type OptimizeState = "idle" | "optimizing" | "done" | "error";
type HotspotIcon = NonNullable<HotspotInteraction["icon"]>;
type MovementToggle = "enabled" | "keyboard" | "clickToMove" | "dragLook";

interface MaterialsDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  materials: MaterialOverride[];
}

interface ObjectsDocument {
  schemaVersion: "0.1";
  generator: string;
  source: string;
  objects: ObjectOverride[];
}

interface BundleStats {
  generatedAt: string;
  viewCount: number;
  interactionCount: number;
  assetCount: number;
  missingAssetCount: number;
  totalBytes: number;
  modelBytes: number;
  videoBytes: number;
  triangleCount: number;
  meshCount: number;
  materialCount: number;
  warnings: readonly {
    code: string;
    message: string;
  }[];
}

interface OptimizationDocument {
  schemaVersion: "0.1";
  generatedAt: string;
  source: string;
  profiles: readonly {
    id: string;
    label: string;
    status: "pass" | "warn";
    budgets: {
      maxTotalBytes: number;
      maxModelBytes: number;
      maxTriangles: number;
      maxMaterials: number;
      maxMeshes: number;
    };
    metrics: {
      totalBytes: number;
      modelBytes: number;
      triangles: number;
      materials: number;
      meshes: number;
    };
    warnings: readonly {
      code: string;
      message: string;
    }[];
  }[];
  recommendations: readonly {
    priority: "high" | "medium" | "low";
    action: string;
    reason: string;
  }[];
}

interface OptimizationJobDocument {
  schemaVersion: "0.1";
  id: string;
  status: "idle" | "completed" | "failed";
  profile: "mobile" | "balanced" | "desktop";
  applied: boolean;
  startedAt?: string;
  completedAt?: string;
  sourceSceneUrl?: string;
  optimizedSceneUrl?: string;
  before?: {
    modelBytes: number;
  };
  after?: {
    modelBytes: number;
    savedBytes: number;
    savedPercent: number;
  };
  steps: readonly {
    id: string;
    label: string;
    status: "completed" | "pending" | "failed";
  }[];
}

interface OptimizationHistoryDocument {
  schemaVersion: "0.1";
  jobs: OptimizationJobDocument[];
}

interface ProjectSummary {
  id: string;
  title: string;
  clientName?: string;
  viewCount: number;
  triangleCount: number;
  updatedAt: string;
  publishCount?: number;
  lastPublishedAt?: string;
}

interface PublishEntry {
  version: string;
  publishedAt: string;
  scenePath: string;
}

interface PublishHistoryDocument {
  schemaVersion: "0.1";
  projectId: string;
  versions: PublishEntry[];
}

const viewerBaseUrl = "http://127.0.0.1:5173";
const apiBaseUrl = "http://127.0.0.1:5175";
const movementToggles: readonly { field: MovementToggle; label: string }[] = [
  { field: "enabled", label: "Movement" },
  { field: "keyboard", label: "WASD" },
  { field: "clickToMove", label: "Click to move" },
  { field: "dragLook", label: "Mouse drag look" }
];

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function updateVec3(value: Vec3, index: number, next: string): Vec3 {
  const draft = [...value] as [number, number, number];
  draft[index] = toNumber(next, value[index] ?? 0);
  return draft;
}

function isHotspot(interaction: SceneInteraction): interaction is HotspotInteraction {
  return interaction.kind === "hotspot";
}

function isLink(interaction: SceneInteraction): interaction is LinkInteraction {
  return interaction.kind === "link";
}

function isMaterialVariantInteraction(
  interaction: SceneInteraction
): interaction is MaterialVariantInteraction {
  return interaction.kind === "material-variant";
}

function isObjectToggle(interaction: SceneInteraction): interaction is ObjectToggleInteraction {
  return interaction.kind === "object-toggle";
}

function createView(index: number): SceneView {
  return {
    id: `view-${index}`,
    label: `View ${index}`,
    kind: "walk",
    position: [0, 1.65, 3],
    target: [0, 1.3, 0],
    fov: 62
  };
}

function createMaterialVariantInteraction(index: number, materialName: string): MaterialVariantInteraction {
  return {
    id: `finish-${index}`,
    kind: "material-variant",
    label: `${materialName || "Material"} Finish`,
    targetMaterialName: materialName,
    variants: [
      {
        id: "option-1",
        label: "Option 1",
        color: "#07333d"
      },
      {
        id: "option-2",
        label: "Option 2",
        color: "#8d8376"
      }
    ]
  };
}

function createHotspot(index: number): HotspotInteraction {
  return {
    id: `hotspot-${index}`,
    kind: "hotspot",
    label: `Hotspot ${index}`,
    position: [0, 1.25, 0],
    title: `Hotspot ${index}`,
    body: "",
    icon: "info"
  };
}

function createLink(index: number): LinkInteraction {
  return {
    id: `link-${index}`,
    kind: "link",
    label: `Link ${index}`,
    position: [0, 1.25, 0],
    url: "https://example.com",
    openInNewTab: true
  };
}

function createObjectToggle(index: number, object?: ObjectOverride): ObjectToggleInteraction {
  return {
    id: `object-toggle-${index}`,
    kind: "object-toggle",
    label: object ? `Toggle ${object.name}` : `Object Toggle ${index}`,
    position: [0, 1.25, 0],
    ...(object ? { targetObjectId: object.id, targetObjectName: object.name } : {}),
    initiallyVisible: true
  };
}

function projectScenePath(projectId: string): string {
  return `/scenes/${projectId}/scene.manifest.json`;
}

function projectAssetPath(projectId: string, asset: string): string {
  return `/scenes/${projectId}/${asset}`;
}

function draftKey(projectId: string, document: string): string {
  return `walkthrough-studio.${projectId}-${document}`;
}

function viewerUrl(projectId: string): string {
  return `${viewerBaseUrl}/?scene=${encodeURIComponent(projectScenePath(projectId))}`;
}

function publishedViewerUrl(entry: PublishEntry): string {
  return `${viewerBaseUrl}/?scene=${encodeURIComponent(entry.scenePath)}`;
}

function embedSnippet(projectId: string, title: string): string {
  return `<script src="${viewerBaseUrl}/embed.js" data-scene="${projectScenePath(projectId)}" data-title="${title}" data-height="640px"></script>`;
}

function publishedEmbedSnippet(entry: PublishEntry, title: string): string {
  return `<script src="${viewerBaseUrl}/embed.js" data-scene="${entry.scenePath}" data-title="${title}" data-height="640px"></script>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function App() {
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("demo");
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [selectedTab, setSelectedTab] = useState<StudioTab>("overview");
  const [selectedViewId, setSelectedViewId] = useState("");
  const [selectedInteractionId, setSelectedInteractionId] = useState("");
  const [selectedVariantInteractionId, setSelectedVariantInteractionId] = useState("");
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [bundleStats, setBundleStats] = useState<BundleStats | null>(null);
  const [optimizationDoc, setOptimizationDoc] = useState<OptimizationDocument | null>(null);
  const [optimizationJob, setOptimizationJob] = useState<OptimizationJobDocument | null>(null);
  const [optimizationHistory, setOptimizationHistory] = useState<OptimizationHistoryDocument | null>(null);
  const [publishHistory, setPublishHistory] = useState<PublishHistoryDocument | null>(null);
  const [sceneGraph, setSceneGraph] = useState<SceneGraphDocument | null>(null);
  const [materialsDoc, setMaterialsDoc] = useState<MaterialsDocument | null>(null);
  const [objectsDoc, setObjectsDoc] = useState<ObjectsDocument | null>(null);
  const [controlsDoc, setControlsDoc] = useState<SceneControlsDocument | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = useState("");
  const [selectedObjectId, setSelectedObjectId] = useState("");
  const [apiConnected, setApiConnected] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState("");
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const [publishError, setPublishError] = useState("");
  const [optimizeState, setOptimizeState] = useState<OptimizeState>("idle");
  const [optimizeError, setOptimizeError] = useState("");
  const [optimizationProfile, setOptimizationProfile] =
    useState<OptimizationJobDocument["profile"]>("balanced");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        try {
          const listResponse = await fetch(`${apiBaseUrl}/api/projects`);
          if (listResponse.ok) {
            const list = (await listResponse.json()) as { projects: ProjectSummary[] };
            if (!cancelled) {
              setProjectSummaries(list.projects);
            }
          }

          const apiResponse = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}`);
          if (apiResponse.ok) {
            const project = (await apiResponse.json()) as {
              id: string;
              manifest: SceneManifest;
              materials: MaterialsDocument;
              objects: ObjectsDocument;
              controls: SceneControlsDocument;
              graph: SceneGraphDocument;
              stats: BundleStats;
              optimization: OptimizationDocument;
              optimizationJob: OptimizationJobDocument;
              optimizationHistory: OptimizationHistoryDocument;
              publishHistory: PublishHistoryDocument;
            };
            if (!cancelled) {
              setApiConnected(true);
              setActiveProjectId(project.id);
              setManifest(project.manifest);
              setMaterialsDoc(project.materials);
              setObjectsDoc(project.objects);
              setControlsDoc(project.controls);
              setSceneGraph(project.graph);
              setBundleStats(project.stats);
              setOptimizationDoc(project.optimization);
              setOptimizationJob(project.optimizationJob);
              setOptimizationHistory(project.optimizationHistory);
              setPublishHistory(project.publishHistory);
              setSelectedViewId(project.manifest.views[0]?.id ?? "");
              setSelectedInteractionId(
                (
                  project.manifest.interactions.find(isHotspot) ??
                  project.manifest.interactions.find(isLink) ??
                  project.manifest.interactions.find(isObjectToggle)
                )?.id ?? ""
              );
              setSelectedVariantInteractionId(
                project.manifest.interactions.find(isMaterialVariantInteraction)?.id ?? ""
              );
              setSelectedMaterialId(project.materials.materials[0]?.id ?? "");
              setSelectedObjectId(project.graph.nodes[0]?.id ?? "");
            }
            return;
          }
        } catch {
          setApiConnected(false);
        }

        const stored = localStorage.getItem(draftKey(activeProjectId, "manifest"));
        if (stored) {
          const parsed = parseSceneManifest(JSON.parse(stored));
          if (!cancelled) {
            setManifest(parsed);
            setSelectedViewId(parsed.views[0]?.id ?? "");
            setSelectedInteractionId(
              (
                parsed.interactions.find(isHotspot) ??
                parsed.interactions.find(isLink) ??
                parsed.interactions.find(isObjectToggle)
              )?.id ?? ""
            );
            setSelectedVariantInteractionId(parsed.interactions.find(isMaterialVariantInteraction)?.id ?? "");
          }
          return;
        }

        const response = await fetch(projectScenePath(activeProjectId));
        if (!response.ok) {
          throw new Error(`Manifest request failed with ${response.status}.`);
        }
        const parsed = parseSceneManifest(await response.json());
        if (!cancelled) {
          setManifest(parsed);
          setSelectedViewId(parsed.views[0]?.id ?? "");
          setSelectedInteractionId(
            (
              parsed.interactions.find(isHotspot) ??
              parsed.interactions.find(isLink) ??
              parsed.interactions.find(isObjectToggle)
            )?.id ?? ""
          );
          setSelectedVariantInteractionId(parsed.interactions.find(isMaterialVariantInteraction)?.id ?? "");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Manifest failed to load.";
        if (!cancelled) {
          setLoadingError(message);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadPublishHistory() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, "publish-history.json"));
        if (!response.ok) {
          if (!cancelled) {
            setPublishHistory({ schemaVersion: "0.1", projectId: activeProjectId, versions: [] });
          }
          return;
        }
        const document = (await response.json()) as PublishHistoryDocument;
        if (!cancelled) {
          setPublishHistory(document);
        }
      } catch {
        if (!cancelled) {
          setPublishHistory({ schemaVersion: "0.1", projectId: activeProjectId, versions: [] });
        }
      }
    }

    void loadPublishHistory();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setSceneGraph(null);
      return;
    }

    let cancelled = false;
    const graphUrl = manifest.graphUrl ?? "scene.graph.json";

    async function loadGraph() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, graphUrl));
        if (!response.ok) {
          return;
        }
        const graph = (await response.json()) as SceneGraphDocument;
        if (!cancelled) {
          setSceneGraph(graph);
          setSelectedObjectId(graph.nodes[0]?.id ?? "");
        }
      } catch {
        if (!cancelled) {
          setSceneGraph(null);
        }
      }
    }

    void loadGraph();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setMaterialsDoc(null);
      return;
    }

    let cancelled = false;
    const materialsUrl = manifest.materialsUrl ?? "materials.json";

    async function loadMaterials() {
      try {
        const stored = localStorage.getItem(draftKey(activeProjectId, "materials"));
        if (stored) {
          const parsed = JSON.parse(stored) as MaterialsDocument;
          if (!cancelled) {
            setMaterialsDoc(parsed);
            setSelectedMaterialId(parsed.materials[0]?.id ?? "");
          }
          return;
        }

        const response = await fetch(projectAssetPath(activeProjectId, materialsUrl));
        if (!response.ok) {
          return;
        }
        const document = (await response.json()) as MaterialsDocument;
        if (!cancelled) {
          setMaterialsDoc(document);
          setSelectedMaterialId(document.materials[0]?.id ?? "");
        }
      } catch {
        if (!cancelled) {
          setMaterialsDoc(null);
        }
      }
    }

    void loadMaterials();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setObjectsDoc(null);
      return;
    }

    let cancelled = false;
    const objectsUrl = manifest.objectsUrl ?? "objects.json";

    async function loadObjects() {
      try {
        const stored = localStorage.getItem(draftKey(activeProjectId, "objects"));
        if (stored) {
          const parsed = JSON.parse(stored) as ObjectsDocument;
          if (!cancelled) {
            setObjectsDoc(parsed);
          }
          return;
        }

        const response = await fetch(projectAssetPath(activeProjectId, objectsUrl));
        if (!response.ok) {
          return;
        }
        const document = (await response.json()) as ObjectsDocument;
        if (!cancelled) {
          setObjectsDoc(document);
        }
      } catch {
        if (!cancelled) {
          setObjectsDoc(null);
        }
      }
    }

    void loadObjects();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    if (!manifest) {
      setControlsDoc(null);
      return;
    }

    let cancelled = false;
    const controlsUrl = manifest.controlsUrl ?? "controls.json";

    async function loadControls() {
      try {
        const stored = localStorage.getItem(draftKey(activeProjectId, "controls"));
        if (stored) {
          const parsed = JSON.parse(stored) as SceneControlsDocument;
          if (!cancelled) {
            setControlsDoc(parsed);
          }
          return;
        }

        const response = await fetch(projectAssetPath(activeProjectId, controlsUrl));
        if (!response.ok) {
          return;
        }
        const document = (await response.json()) as SceneControlsDocument;
        if (!cancelled) {
          setControlsDoc(document);
        }
      } catch {
        if (!cancelled) {
          setControlsDoc(null);
        }
      }
    }

    void loadControls();

    return () => {
      cancelled = true;
    };
  }, [manifest, activeProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, "stats.json"));
        if (!response.ok) {
          return;
        }
        const stats = (await response.json()) as BundleStats;
        if (!cancelled) {
          setBundleStats(stats);
        }
      } catch {
        if (!cancelled) {
          setBundleStats(null);
        }
      }
    }

    void loadStats();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    let cancelled = false;

    async function loadOptimization() {
      try {
        const response = await fetch(projectAssetPath(activeProjectId, "optimization.json"));
        if (!response.ok) {
          return;
        }
        const optimization = (await response.json()) as OptimizationDocument;
        if (!cancelled) {
          setOptimizationDoc(optimization);
        }
      } catch {
        if (!cancelled) {
          setOptimizationDoc(null);
        }
      }
    }

    void loadOptimization();

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), 1400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedView = useMemo(
    () => manifest?.views.find((view) => view.id === selectedViewId),
    [manifest, selectedViewId]
  );

  const hotspotInteractions = useMemo(
    () => manifest?.interactions.filter(isHotspot) ?? [],
    [manifest]
  );

  const linkInteractions = useMemo(
    () => manifest?.interactions.filter(isLink) ?? [],
    [manifest]
  );

  const objectToggleInteractions = useMemo(
    () => manifest?.interactions.filter(isObjectToggle) ?? [],
    [manifest]
  );

  const materialVariantInteractions = useMemo(
    () => manifest?.interactions.filter(isMaterialVariantInteraction) ?? [],
    [manifest]
  );

  const selectedHotspot = useMemo(
    () => hotspotInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [hotspotInteractions, selectedInteractionId]
  );

  const selectedLink = useMemo(
    () => linkInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [linkInteractions, selectedInteractionId]
  );

  const selectedObjectToggle = useMemo(
    () => objectToggleInteractions.find((interaction) => interaction.id === selectedInteractionId),
    [objectToggleInteractions, selectedInteractionId]
  );

  const selectedVariantInteraction = useMemo(
    () => materialVariantInteractions.find((interaction) => interaction.id === selectedVariantInteractionId),
    [materialVariantInteractions, selectedVariantInteractionId]
  );

  const selectedObject = useMemo(
    () => sceneGraph?.nodes.find((node) => node.id === selectedObjectId),
    [sceneGraph, selectedObjectId]
  );

  const selectedObjectOverride = useMemo(
    () => objectsDoc?.objects.find((object) => object.id === selectedObjectId),
    [objectsDoc, selectedObjectId]
  );

  const selectedMaterial = useMemo(
    () => materialsDoc?.materials.find((material) => material.id === selectedMaterialId),
    [materialsDoc, selectedMaterialId]
  );

  const updateManifest = (updater: (manifest: SceneManifest) => SceneManifest) => {
    setManifest((current) => (current ? updater(current) : current));
  };

  const updateBranding = (field: "title" | "clientName" | "accentColor", value: string) => {
    updateManifest((current) => ({
      ...current,
      branding: {
        ...current.branding,
        [field]: value
      }
    }));
  };

  const updateView = (viewId: string, updater: (view: SceneView) => SceneView) => {
    updateManifest((current) => ({
      ...current,
      views: current.views.map((view) => (view.id === viewId ? updater(view) : view))
    }));
  };

  const updateHotspot = (
    interactionId: string,
    updater: (interaction: HotspotInteraction) => HotspotInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isHotspot(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const updateLink = (
    interactionId: string,
    updater: (interaction: LinkInteraction) => LinkInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isLink(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const updateObjectToggle = (
    interactionId: string,
    updater: (interaction: ObjectToggleInteraction) => ObjectToggleInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isObjectToggle(interaction) ? updater(interaction) : interaction
      )
    }));
  };

  const updateMaterialVariantInteraction = (
    interactionId: string,
    updater: (interaction: MaterialVariantInteraction) => MaterialVariantInteraction
  ) => {
    updateManifest((current) => ({
      ...current,
      interactions: current.interactions.map((interaction) =>
        interaction.id === interactionId && isMaterialVariantInteraction(interaction)
          ? updater(interaction)
          : interaction
      )
    }));
  };

  const updateMaterial = (
    materialId: string,
    updater: (material: MaterialOverride) => MaterialOverride
  ) => {
    setMaterialsDoc((current) =>
      current
        ? {
            ...current,
            materials: current.materials.map((material) =>
              material.id === materialId ? updater(material) : material
            )
          }
        : current
    );
  };

  const updateObject = (
    objectId: string,
    updater: (object: ObjectOverride) => ObjectOverride
  ) => {
    setObjectsDoc((current) =>
      current
        ? {
            ...current,
            objects: current.objects.map((object) =>
              object.id === objectId ? updater(object) : object
            )
          }
        : current
    );
  };

  const updateControls = (updater: (controls: SceneControlsDocument) => SceneControlsDocument) => {
    setControlsDoc((current) => (current ? updater(current) : current));
  };

  const saveDraft = () => {
    if (!manifest) {
      return;
    }

    if (apiConnected) {
      void saveToApi();
      return;
    }
    localStorage.setItem(draftKey(activeProjectId, "manifest"), JSON.stringify(manifest, null, 2));
    if (materialsDoc) {
      localStorage.setItem(draftKey(activeProjectId, "materials"), JSON.stringify(materialsDoc, null, 2));
    }
    if (objectsDoc) {
      localStorage.setItem(draftKey(activeProjectId, "objects"), JSON.stringify(objectsDoc, null, 2));
    }
    if (controlsDoc) {
      localStorage.setItem(draftKey(activeProjectId, "controls"), JSON.stringify(controlsDoc, null, 2));
    }
    setNotice("saved");
  };

  const saveToApi = async () => {
    if (!manifest) {
      return;
    }

    await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/manifest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest)
    });

    if (materialsDoc) {
      await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/materials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(materialsDoc)
      });
    }

    if (objectsDoc) {
      await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/objects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(objectsDoc)
      });
    }

    if (controlsDoc) {
      await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/controls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(controlsDoc)
      });
    }

    const analyzeResponse = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/analyze`, {
      method: "POST"
    });
    if (analyzeResponse.ok) {
      const result = (await analyzeResponse.json()) as {
        stats?: BundleStats;
        optimization?: OptimizationDocument;
      };
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
    }

    setNotice("saved");
  };

  const resetDraft = async () => {
    localStorage.removeItem(draftKey(activeProjectId, "manifest"));
    localStorage.removeItem(draftKey(activeProjectId, "materials"));
    localStorage.removeItem(draftKey(activeProjectId, "objects"));
    localStorage.removeItem(draftKey(activeProjectId, "controls"));
    const response = await fetch(projectScenePath(activeProjectId));
    const parsed = parseSceneManifest(await response.json());
    setManifest(parsed);
    setSelectedViewId(parsed.views[0]?.id ?? "");
    setSelectedInteractionId(
      (
        parsed.interactions.find(isHotspot) ??
        parsed.interactions.find(isLink) ??
        parsed.interactions.find(isObjectToggle)
      )?.id ?? ""
    );
    setSelectedVariantInteractionId(parsed.interactions.find(isMaterialVariantInteraction)?.id ?? "");
    setMaterialsDoc(null);
    setObjectsDoc(null);
    setControlsDoc(null);
    setNotice("reset");
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setNotice("copied");
  };

  const createProject = async () => {
    const name = window.prompt("Project name", "New Residence");
    if (!name?.trim()) {
      return;
    }
    const response = await fetch(`${apiBaseUrl}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!response.ok) {
      return;
    }
    const project = (await response.json()) as {
      id: string;
      manifest: SceneManifest;
      stats: BundleStats;
    };
    const summary: ProjectSummary = {
      id: project.id,
      title: project.manifest.branding.title,
      viewCount: project.manifest.views.length,
      triangleCount: project.stats.triangleCount,
      updatedAt: project.stats.generatedAt
    };
    if (project.manifest.branding.clientName) {
      summary.clientName = project.manifest.branding.clientName;
    }
    setProjectSummaries((current) => [...current.filter((item) => item.id !== project.id), summary]);
    setActiveProjectId(project.id);
    setNotice("saved");
  };

  const publishProject = async () => {
    if (!apiConnected) {
      setPublishState("error");
      setPublishError("API is not connected.");
      return;
    }

    setPublishState("publishing");
    setPublishError("");
    try {
      if (manifest) {
        await saveToApi();
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/publish`, {
        method: "POST"
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Publish failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        publishHistory: PublishHistoryDocument;
      };
      setPublishHistory(result.publishHistory);
      setProjectSummaries((current) =>
        current.map((project) => {
          if (project.id !== activeProjectId) {
            return project;
          }
          const nextProject: ProjectSummary = {
            ...project,
            publishCount: result.publishHistory.versions.length
          };
          const lastPublishedAt = result.publishHistory.versions[0]?.publishedAt;
          if (lastPublishedAt) {
            nextProject.lastPublishedAt = lastPublishedAt;
          }
          return nextProject;
        })
      );
      setPublishState("done");
      setNotice("saved");
    } catch (error) {
      setPublishState("error");
      setPublishError(error instanceof Error ? error.message : "Publish failed.");
    }
  };

  const optimizeProject = async () => {
    if (!apiConnected) {
      setOptimizeState("error");
      setOptimizeError("API is not connected.");
      return;
    }

    setOptimizeState("optimizing");
    setOptimizeError("");
    try {
      if (manifest) {
        await saveToApi();
      }
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: optimizationProfile, apply: true })
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Optimization failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest: SceneManifest;
        stats: BundleStats;
        optimization: OptimizationDocument;
        optimizationJob: OptimizationJobDocument;
        optimizationHistory: OptimizationHistoryDocument;
      };
      setManifest(result.manifest);
      setBundleStats(result.stats);
      setOptimizationDoc(result.optimization);
      setOptimizationJob(result.optimizationJob);
      setOptimizationHistory(result.optimizationHistory);
      setOptimizeState("done");
      setNotice("saved");
    } catch (error) {
      setOptimizeState("error");
      setOptimizeError(error instanceof Error ? error.message : "Optimization failed.");
    }
  };

  const switchModelSource = async (sceneUrl: "scene.glb" | "scene.optimized.glb") => {
    if (!apiConnected) {
      setOptimizeState("error");
      setOptimizeError("API is not connected.");
      return;
    }

    setOptimizeState("optimizing");
    setOptimizeError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/model-source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneUrl })
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Model switch failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest: SceneManifest;
        stats: BundleStats;
        optimization: OptimizationDocument;
      };
      setManifest(result.manifest);
      setBundleStats(result.stats);
      setOptimizationDoc(result.optimization);
      setOptimizeState("done");
      setNotice("saved");
    } catch (error) {
      setOptimizeState("error");
      setOptimizeError(error instanceof Error ? error.message : "Model switch failed.");
    }
  };

  const uploadModel = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    if (!apiConnected) {
      setUploadState("error");
      setUploadError("API is not connected.");
      return;
    }
    const lowerName = file.name.toLowerCase();
    const isZip = lowerName.endsWith(".zip");
    const isGlb = lowerName.endsWith(".glb");
    if (!isGlb && !isZip) {
      setUploadState("error");
      setUploadError("Upload a GLB file or a ZIP containing a GLB plus its textures.");
      return;
    }

    setUploadState("uploading");
    setUploadError("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/projects/${activeProjectId}/model`, {
        method: "POST",
        headers: {
          "content-type": isZip ? "application/zip" : "model/gltf-binary",
          "x-file-name": file.name
        },
        body: file
      });
      if (!response.ok) {
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `Upload failed with ${response.status}.`);
      }
      const result = (await response.json()) as {
        manifest?: SceneManifest;
        stats?: BundleStats;
        optimization?: OptimizationDocument;
      };
      if (result.manifest) {
        setManifest(result.manifest);
        setSelectedViewId(result.manifest.views[0]?.id ?? "");
        setSelectedInteractionId("");
        setSelectedVariantInteractionId("");
      }
      if (result.stats) {
        setBundleStats(result.stats);
      }
      if (result.optimization) {
        setOptimizationDoc(result.optimization);
      }
      setUploadState("done");
      setNotice("saved");
    } catch (error) {
      setUploadState("error");
      setUploadError(error instanceof Error ? error.message : "Upload failed.");
    }
  };

  const addView = () => {
    updateManifest((current) => {
      const nextView = createView(current.views.length + 1);
      window.setTimeout(() => setSelectedViewId(nextView.id), 0);
      return {
        ...current,
        views: [...current.views, nextView]
      };
    });
  };

  const removeView = (viewId: string) => {
    updateManifest((current) => {
      const views = current.views.filter((view) => view.id !== viewId);
      window.setTimeout(() => setSelectedViewId(views[0]?.id ?? ""), 0);
      return {
        ...current,
        views
      };
    });
  };

  const addHotspot = () => {
    updateManifest((current) => {
      const nextHotspot = createHotspot(hotspotInteractions.length + 1);
      window.setTimeout(() => setSelectedInteractionId(nextHotspot.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextHotspot]
      };
    });
  };

  const removeHotspot = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isHotspot) ?? interactions.find(isLink) ?? interactions.find(isObjectToggle);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const addLink = () => {
    updateManifest((current) => {
      const nextLink = createLink(linkInteractions.length + 1);
      window.setTimeout(() => setSelectedInteractionId(nextLink.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextLink]
      };
    });
  };

  const removeLink = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isHotspot) ?? interactions.find(isLink) ?? interactions.find(isObjectToggle);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const addObjectToggle = () => {
    updateManifest((current) => {
      const selectedOverride = objectsDoc?.objects.find((object) => object.id === selectedObjectId);
      const nextToggle = createObjectToggle(objectToggleInteractions.length + 1, selectedOverride);
      window.setTimeout(() => setSelectedInteractionId(nextToggle.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextToggle]
      };
    });
  };

  const removeObjectToggle = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isHotspot) ?? interactions.find(isLink) ?? interactions.find(isObjectToggle);
      window.setTimeout(() => setSelectedInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const addMaterialVariantInteraction = () => {
    updateManifest((current) => {
      const materialName = selectedMaterial?.name ?? materialsDoc?.materials[0]?.name ?? "";
      const nextInteraction = createMaterialVariantInteraction(
        materialVariantInteractions.length + 1,
        materialName
      );
      window.setTimeout(() => setSelectedVariantInteractionId(nextInteraction.id), 0);
      return {
        ...current,
        interactions: [...current.interactions, nextInteraction]
      };
    });
  };

  const removeMaterialVariantInteraction = (interactionId: string) => {
    updateManifest((current) => {
      const interactions = current.interactions.filter((interaction) => interaction.id !== interactionId);
      const nextInteraction = interactions.find(isMaterialVariantInteraction);
      window.setTimeout(() => setSelectedVariantInteractionId(nextInteraction?.id ?? ""), 0);
      return {
        ...current,
        interactions
      };
    });
  };

  const updateMaterialVariantOption = (
    interactionId: string,
    variantId: string,
    updater: (variant: MaterialVariant) => MaterialVariant
  ) => {
    updateMaterialVariantInteraction(interactionId, (interaction) => ({
      ...interaction,
      variants: interaction.variants.map((variant) =>
        variant.id === variantId ? updater(variant) : variant
      )
    }));
  };

  const addMaterialVariantOption = (interactionId: string) => {
    updateMaterialVariantInteraction(interactionId, (interaction) => ({
      ...interaction,
      variants: [
        ...interaction.variants,
        {
          id: `option-${interaction.variants.length + 1}`,
          label: `Option ${interaction.variants.length + 1}`,
          color: "#ffffff"
        }
      ]
    }));
  };

  const removeMaterialVariantOption = (interactionId: string, variantId: string) => {
    updateMaterialVariantInteraction(interactionId, (interaction) => ({
      ...interaction,
      variants: interaction.variants.filter((variant) => variant.id !== variantId)
    }));
  };

  if (loadingError) {
    return (
      <main className="studio-shell">
        <section className="load-state">
          <FileJson size={28} aria-hidden="true" />
          <strong>Manifest Error</strong>
          <p>{loadingError}</p>
        </section>
      </main>
    );
  }

  if (!manifest) {
    return (
      <main className="studio-shell">
        <section className="load-state">
          <FileJson size={28} aria-hidden="true" />
          <strong>Loading Project</strong>
        </section>
      </main>
    );
  }

  const videoCount = manifest.interactions.filter((interaction) => interaction.kind === "video-texture").length;
  const variantCount = materialVariantInteractions.reduce(
    (sum, interaction) => sum + interaction.variants.length,
    0
  );

  return (
    <main className="studio-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <Box size={22} aria-hidden="true" />
          <div>
            <span>Walkthrough</span>
            <strong>Studio</strong>
          </div>
        </div>

        <div className="project-list">
          {(projectSummaries.length > 0 ? projectSummaries : (() => {
            const fallback: ProjectSummary = {
              id: activeProjectId,
              title: manifest.branding.title,
              viewCount: manifest.views.length,
              triangleCount: bundleStats?.triangleCount ?? 0,
              updatedAt: bundleStats?.generatedAt ?? ""
            };
            if (manifest.branding.clientName) {
              fallback.clientName = manifest.branding.clientName;
            }
            return [fallback];
          })()).map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === activeProjectId ? "project-row active" : "project-row"}
              onClick={() => setActiveProjectId(project.id)}
            >
              <span>{project.clientName ?? project.title}</span>
              <small>
                {project.viewCount} views
                {typeof project.publishCount === "number" ? ` / ${project.publishCount} published` : ""}
              </small>
            </button>
          ))}
        </div>

        <button type="button" className="project-create" onClick={() => void createProject()}>
          <Plus size={16} aria-hidden="true" />
          New Project
        </button>
      </aside>

      <section className="workbench">
        <header className="studio-header">
          <div>
            <span className="eyebrow">Project</span>
            <h1>{manifest.branding.clientName ?? manifest.branding.title}</h1>
          </div>

          <div className="header-actions">
            <span className={apiConnected ? "api-pill connected" : "api-pill"}>
              {apiConnected ? "API" : "Local"}
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={() => void copyText(embedSnippet(activeProjectId, manifest.branding.clientName ?? manifest.branding.title))}
            >
              <Copy size={16} aria-hidden="true" />
              Embed
            </button>
            <a className="button secondary" href={viewerUrl(activeProjectId)} target="_blank" rel="noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              Viewer
            </a>
            <button type="button" className="button secondary" onClick={() => void resetDraft()}>
              <RotateCcw size={16} aria-hidden="true" />
              Reset
            </button>
            <button type="button" className="button primary" onClick={saveDraft}>
              <Save size={16} aria-hidden="true" />
              Save
            </button>
          </div>
        </header>

        <nav className="tabs" aria-label="Studio sections">
          {[
            ["overview", "Overview"],
            ["import", "Import"],
            ["optimization", "Optimization"],
            ["publish", "Publish"],
            ["views", "Views"],
            ["interactions", "Interactions"],
            ["materials", "Materials"],
            ["variants", "Variants"],
            ["objects", "Objects"],
            ["controls", "Controls"],
            ["bundle", "Bundle"]
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={selectedTab === id ? "tab active" : "tab"}
              onClick={() => setSelectedTab(id as StudioTab)}
            >
              {label}
            </button>
          ))}
        </nav>

        {selectedTab === "overview" && (
          <section className="content-grid">
            <div className="panel">
              <div className="panel-heading">
                <Layers3 size={18} aria-hidden="true" />
                <h2>Project</h2>
              </div>
              <div className="field-grid">
                <label>
                  <span>Title</span>
                  <input
                    value={manifest.branding.title}
                    onChange={(event) => updateBranding("title", event.target.value)}
                  />
                </label>
                <label>
                  <span>Client</span>
                  <input
                    value={manifest.branding.clientName ?? ""}
                    onChange={(event) => updateBranding("clientName", event.target.value)}
                  />
                </label>
                <label>
                  <span>Accent</span>
                  <input
                    value={manifest.branding.accentColor}
                    onChange={(event) => updateBranding("accentColor", event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="panel metrics-panel">
              <div className="metric-row">
                <MapPin size={18} aria-hidden="true" />
                <span>Views</span>
                <strong>{manifest.views.length}</strong>
              </div>
              <div className="metric-row">
                <Globe2 size={18} aria-hidden="true" />
                <span>Hotspots</span>
                <strong>{hotspotInteractions.length}</strong>
              </div>
              <div className="metric-row">
                <ExternalLink size={18} aria-hidden="true" />
                <span>Links</span>
                <strong>{linkInteractions.length}</strong>
              </div>
              <div className="metric-row">
                <Eye size={18} aria-hidden="true" />
                <span>Object Toggles</span>
                <strong>{objectToggleInteractions.length}</strong>
              </div>
              <div className="metric-row">
                <Video size={18} aria-hidden="true" />
                <span>Video Textures</span>
                <strong>{videoCount}</strong>
              </div>
              <div className="metric-row">
                <Palette size={18} aria-hidden="true" />
                <span>Variants</span>
                <strong>{variantCount}</strong>
              </div>
              <div className="metric-row">
                <Activity size={18} aria-hidden="true" />
                <span>Triangles</span>
                <strong>{bundleStats?.triangleCount ?? 0}</strong>
              </div>
            </div>
          </section>
        )}

        {selectedTab === "import" && (
          <section className="content-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>Model Import</h2>
              </div>

              <label className="file-drop">
                <input
                  type="file"
                  accept=".glb,.zip,model/gltf-binary,application/zip"
                  disabled={!apiConnected || uploadState === "uploading"}
                  onChange={(event) => void uploadModel(event.target.files?.[0])}
                />
                <span>Upload GLB</span>
                <strong>
                  {uploadState === "uploading" && "Uploading"}
                  {uploadState === "done" && "Imported"}
                  {uploadState === "error" && "Failed"}
                  {uploadState === "idle" && "Choose file"}
                </strong>
              </label>

              {uploadError && <p className="error-note">{uploadError}</p>}
              {!apiConnected && <p className="quiet-note">Start the local API before importing models.</p>}
            </div>

            <div className="panel stats-panel">
              <div className="panel-heading">
                <Activity size={18} aria-hidden="true" />
                <h2>Imported Scene Stats</h2>
              </div>
              {bundleStats ? (
                <div className="stat-grid">
                  <Stat label="Model" value={formatBytes(bundleStats.modelBytes)} />
                  <Stat label="Meshes" value={String(bundleStats.meshCount)} />
                  <Stat label="Materials" value={String(bundleStats.materialCount)} />
                  <Stat label="Triangles" value={String(bundleStats.triangleCount)} />
                </div>
              ) : (
                <p className="quiet-note">Stats will appear after import.</p>
              )}
            </div>
          </section>
        )}

        {selectedTab === "optimization" && (
          <section className="content-grid bundle-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <Activity size={18} aria-hidden="true" />
                <h2>Optimization Profiles</h2>
              </div>

              <div className="publish-action-card">
                <div>
                  <strong>Optimize Scene Bundle</strong>
                  <p className="quiet-note">
                    Generate an optimized GLB artifact, apply it to the manifest, and refresh bundle stats.
                  </p>
                </div>
                <div className="optimization-action-controls">
                  <select
                    value={optimizationProfile}
                    disabled={optimizeState === "optimizing"}
                    onChange={(event) =>
                      setOptimizationProfile(event.target.value as OptimizationJobDocument["profile"])
                    }
                    aria-label="Optimization profile"
                  >
                    <option value="mobile">Mobile</option>
                    <option value="balanced">Balanced</option>
                    <option value="desktop">Desktop</option>
                  </select>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!apiConnected || optimizeState === "optimizing"}
                    onClick={() => void optimizeProject()}
                  >
                    <Activity size={16} aria-hidden="true" />
                    {optimizeState === "optimizing" ? "Optimizing" : "Run"}
                  </button>
                </div>
              </div>

              {optimizeError && <p className="error-note">{optimizeError}</p>}

              {optimizationDoc ? (
                <div className="optimization-grid">
                  {optimizationDoc.profiles.map((profile) => (
                    <div key={profile.id} className="optimization-card">
                      <div className="optimization-card-heading">
                        <strong>{profile.label}</strong>
                        <span className={profile.status === "pass" ? "status-pill pass" : "status-pill warn"}>
                          {profile.status === "pass" ? "Ready" : "Needs work"}
                        </span>
                      </div>
                      <div className="stat-grid">
                        <Stat label="Model" value={formatBytes(profile.metrics.modelBytes)} />
                        <Stat label="Triangles" value={String(profile.metrics.triangles)} />
                        <Stat label="Meshes" value={String(profile.metrics.meshes)} />
                        <Stat label="Materials" value={String(profile.metrics.materials)} />
                      </div>
                      {profile.warnings.length > 0 ? (
                        <ul className="warning-list">
                          {profile.warnings.map((warning) => (
                            <li key={warning.code}>{warning.message}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="quiet-note">Within current profile budgets.</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="quiet-note">Run analysis to generate optimization profiles.</p>
              )}
            </div>

            <div className="side-stack">
              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Recommendations</h2>
                </div>
                {optimizationDoc ? (
                  <div className="recommendation-list">
                    {optimizationDoc.recommendations.map((item) => (
                      <div key={`${item.priority}-${item.action}`} className="recommendation-row">
                        <span className={`priority-pill ${item.priority}`}>{item.priority}</span>
                        <strong>{item.action}</strong>
                        <p>{item.reason}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="quiet-note">No recommendations generated.</p>
                )}
              </div>

              <div className="panel publish-panel">
                <div className="publish-row">
                  <span>Generated</span>
                </div>
                <code>{optimizationDoc?.generatedAt ?? "Not generated"}</code>
                <div className="publish-row">
                  <span>Current Model</span>
                </div>
                <code>{manifest.sceneUrl ?? "scene.glb"}</code>
                <div className="model-source-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!apiConnected || optimizeState === "optimizing" || (manifest.sceneUrl ?? "scene.glb") === "scene.glb"}
                    onClick={() => void switchModelSource("scene.glb")}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!apiConnected || optimizeState === "optimizing" || manifest.sceneUrl === "scene.optimized.glb"}
                    onClick={() => void switchModelSource("scene.optimized.glb")}
                  >
                    Optimized
                  </button>
                </div>
              </div>

              <div className="panel stats-panel">
                <div className="panel-heading">
                  <Activity size={18} aria-hidden="true" />
                  <h2>Last Optimization Job</h2>
                </div>
                {optimizationJob && optimizationJob.status !== "idle" ? (
                  <>
                    <div className="stat-grid">
                      <Stat label="Profile" value={optimizationJob.profile} />
                      <Stat label="Status" value={optimizationJob.status} />
                      <Stat label="Before" value={formatBytes(optimizationJob.before?.modelBytes ?? 0)} />
                      <Stat label="After" value={formatBytes(optimizationJob.after?.modelBytes ?? 0)} />
                    </div>
                    <div className="publish-row">
                      <span>Artifact</span>
                    </div>
                    <code>{optimizationJob.optimizedSceneUrl ?? "Not generated"}</code>
                    <div className="job-step-list">
                      {optimizationJob.steps.map((step) => (
                        <div key={step.id} className={`job-step-row ${step.status}`}>
                          <span>{step.label}</span>
                          <strong>{step.status}</strong>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="quiet-note">No optimization job has run for this project yet.</p>
                )}
              </div>

              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Optimization History</h2>
                </div>
                {optimizationHistory && optimizationHistory.jobs.length > 0 ? (
                  <div className="job-history-list">
                    {optimizationHistory.jobs.slice(0, 5).map((job) => (
                      <div key={job.id} className="job-history-row">
                        <div>
                          <strong>{job.profile}</strong>
                          <span>{job.completedAt ?? job.startedAt ?? job.id}</span>
                        </div>
                        <small>{formatBytes(job.after?.savedBytes ?? 0)} saved</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="quiet-note">No optimization history yet.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {selectedTab === "publish" && (
          <section className="content-grid bundle-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <Globe2 size={18} aria-hidden="true" />
                <h2>Publish</h2>
              </div>

              <div className="publish-action-card">
                <div>
                  <strong>{manifest.branding.clientName ?? manifest.branding.title}</strong>
                  <p className="quiet-note">Create a static versioned bundle for sharing or embedding.</p>
                </div>
                <button
                  type="button"
                  className="button primary"
                  disabled={publishState === "publishing"}
                  onClick={() => void publishProject()}
                >
                  <Globe2 size={16} aria-hidden="true" />
                  {publishState === "publishing" ? "Publishing" : "Publish"}
                </button>
              </div>

              {publishError && <p className="error-note">{publishError}</p>}

              <div className="publish-row">
                <span>Draft Viewer</span>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void copyText(viewerUrl(activeProjectId))}
                >
                  <Copy size={16} aria-hidden="true" />
                  Copy
                </button>
              </div>
              <code>{viewerUrl(activeProjectId)}</code>
            </div>

            <div className="side-stack">
              <div className="panel stats-panel">
                <div className="panel-heading">
                  <FileJson size={18} aria-hidden="true" />
                  <h2>Versions</h2>
                </div>
                {publishHistory && publishHistory.versions.length > 0 ? (
                  <div className="publish-version-list">
                    {publishHistory.versions.map((entry) => (
                      <div key={entry.version} className="publish-version-row">
                        <div>
                          <strong>{entry.version}</strong>
                          <span>{entry.publishedAt}</span>
                        </div>
                        <div className="publish-version-actions">
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => void copyText(publishedViewerUrl(entry))}
                          >
                            <Copy size={16} aria-hidden="true" />
                            URL
                          </button>
                          <a
                            className="button secondary"
                            href={publishedViewerUrl(entry)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={16} aria-hidden="true" />
                            Open
                          </a>
                        </div>
                        <code>{publishedEmbedSnippet(entry, manifest.branding.clientName ?? manifest.branding.title)}</code>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="quiet-note">No published versions yet.</p>
                )}
              </div>
            </div>
          </section>
        )}

        {selectedTab === "views" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Views</h2>
                <button type="button" className="icon-action" title="Add view" onClick={addView}>
                  <Plus size={17} aria-hidden="true" />
                </button>
              </div>
              {manifest.views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={selectedViewId === view.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedViewId(view.id)}
                >
                  <span>{view.label}</span>
                  <small>{view.kind}</small>
                </button>
              ))}
            </div>

            {selectedView && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <MapPin size={18} aria-hidden="true" />
                  <h2>{selectedView.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete view"
                    onClick={() => removeView(selectedView.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedView.label}
                      onChange={(event) =>
                        updateView(selectedView.id, (view) => ({ ...view, label: event.target.value }))
                      }
                    />
                  </label>
                  <label>
                    <span>Kind</span>
                    <select
                      value={selectedView.kind}
                      onChange={(event) =>
                        updateView(selectedView.id, (view) => ({
                          ...view,
                          kind: event.target.value as SceneView["kind"]
                        }))
                      }
                    >
                      <option value="walk">Walk</option>
                      <option value="orbit">Orbit</option>
                      <option value="top">Top</option>
                    </select>
                  </label>
                  <label>
                    <span>FOV</span>
                    <input
                      type="number"
                      value={selectedView.fov ?? 62}
                      onChange={(event) =>
                        updateView(selectedView.id, (view) => ({
                          ...view,
                          fov: toNumber(event.target.value, view.fov ?? 62)
                        }))
                      }
                    />
                  </label>
                </div>

                <VectorEditor
                  label="Position"
                  value={selectedView.position}
                  onChange={(next) => updateView(selectedView.id, (view) => ({ ...view, position: next }))}
                />
                <VectorEditor
                  label="Target"
                  value={selectedView.target}
                  onChange={(next) => updateView(selectedView.id, (view) => ({ ...view, target: next }))}
                />
              </div>
            )}
          </section>
        )}

        {selectedTab === "interactions" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Interactions</h2>
                <div className="mini-actions">
                  <button type="button" className="icon-action" title="Add hotspot" onClick={addHotspot}>
                    <Plus size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add link" onClick={addLink}>
                    <ExternalLink size={17} aria-hidden="true" />
                  </button>
                  <button type="button" className="icon-action" title="Add object toggle" onClick={addObjectToggle}>
                    <Eye size={17} aria-hidden="true" />
                  </button>
                </div>
              </div>
              {hotspotInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.title}</span>
                  <small>{interaction.icon ?? "info"}</small>
                </button>
              ))}
              {linkInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>link</small>
                </button>
              ))}
              {objectToggleInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>object toggle</small>
                </button>
              ))}
            </div>

            {selectedHotspot && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Globe2 size={18} aria-hidden="true" />
                  <h2>{selectedHotspot.title}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete hotspot"
                    onClick={() => removeHotspot(selectedHotspot.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <div className="field-grid">
                  <label>
                    <span>Title</span>
                    <input
                      value={selectedHotspot.title}
                      onChange={(event) =>
                        updateHotspot(selectedHotspot.id, (interaction) => ({
                          ...interaction,
                          title: event.target.value,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Icon</span>
                    <select
                      value={selectedHotspot.icon ?? "info"}
                      onChange={(event) =>
                        updateHotspot(selectedHotspot.id, (interaction) => ({
                          ...interaction,
                          icon: event.target.value as HotspotIcon
                        }))
                      }
                    >
                      <option value="info">Info</option>
                      <option value="media">Media</option>
                      <option value="link">Link</option>
                    </select>
                  </label>
                </div>

                <label className="textarea-field">
                  <span>Body</span>
                  <textarea
                    value={selectedHotspot.body ?? ""}
                    onChange={(event) =>
                      updateHotspot(selectedHotspot.id, (interaction) => ({
                        ...interaction,
                        body: event.target.value
                      }))
                    }
                  />
                </label>

                <VectorEditor
                  label="Position"
                  value={selectedHotspot.position}
                  onChange={(next) =>
                    updateHotspot(selectedHotspot.id, (interaction) => ({ ...interaction, position: next }))
                  }
                />
              </div>
            )}

            {selectedLink && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <ExternalLink size={18} aria-hidden="true" />
                  <h2>{selectedLink.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete link"
                    onClick={() => removeLink(selectedLink.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedLink.label}
                      onChange={(event) =>
                        updateLink(selectedLink.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>URL</span>
                    <input
                      value={selectedLink.url}
                      onChange={(event) =>
                        updateLink(selectedLink.id, (interaction) => ({
                          ...interaction,
                          url: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label className="toggle-row compact-toggle">
                    <input
                      type="checkbox"
                      checked={selectedLink.openInNewTab !== false}
                      onChange={(event) =>
                        updateLink(selectedLink.id, (interaction) => ({
                          ...interaction,
                          openInNewTab: event.target.checked
                        }))
                      }
                    />
                    <span>New tab</span>
                  </label>
                </div>

                <VectorEditor
                  label="Position"
                  value={selectedLink.position}
                  onChange={(next) => updateLink(selectedLink.id, (interaction) => ({ ...interaction, position: next }))}
                />
              </div>
            )}

            {selectedObjectToggle && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Eye size={18} aria-hidden="true" />
                  <h2>{selectedObjectToggle.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete object toggle"
                    onClick={() => removeObjectToggle(selectedObjectToggle.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedObjectToggle.label}
                      onChange={(event) =>
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Target Object</span>
                    <select
                      value={selectedObjectToggle.targetObjectId ?? ""}
                      onChange={(event) => {
                        const object = objectsDoc?.objects.find((item) => item.id === event.target.value);
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          targetObjectId: object?.id ?? "",
                          targetObjectName: object?.name ?? ""
                        }));
                      }}
                    >
                      <option value="">Select object</option>
                      {objectsDoc?.objects.map((object) => (
                        <option key={object.id} value={object.id}>
                          {object.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="toggle-row compact-toggle">
                    <input
                      type="checkbox"
                      checked={selectedObjectToggle.initiallyVisible !== false}
                      onChange={(event) =>
                        updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                          ...interaction,
                          initiallyVisible: event.target.checked
                        }))
                      }
                    />
                    <span>Initially visible</span>
                  </label>
                </div>

                <VectorEditor
                  label="Position"
                  value={selectedObjectToggle.position}
                  onChange={(next) =>
                    updateObjectToggle(selectedObjectToggle.id, (interaction) => ({
                      ...interaction,
                      position: next
                    }))
                  }
                />
              </div>
            )}
          </section>
        )}

        {selectedTab === "materials" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Materials</h2>
                <small>{materialsDoc?.materials.length ?? 0}</small>
              </div>
              {materialsDoc?.materials.map((material) => (
                <button
                  key={material.id}
                  type="button"
                  className={selectedMaterialId === material.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedMaterialId(material.id)}
                >
                  <span>{material.name}</span>
                  <small>{material.baseColor ?? "no color"}</small>
                </button>
              ))}
              {!materialsDoc && <p className="empty-list">No materials generated.</p>}
            </div>

            {selectedMaterial && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>{selectedMaterial.name}</h2>
                </div>

                <div className="field-grid">
                  <label>
                    <span>Name</span>
                    <input
                      value={selectedMaterial.name}
                      onChange={(event) =>
                        updateMaterial(selectedMaterial.id, (material) => ({
                          ...material,
                          name: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Base Color</span>
                    <div className="color-control">
                      <input
                        type="color"
                        value={selectedMaterial.baseColor ?? "#ffffff"}
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => ({
                            ...material,
                            baseColor: event.target.value
                          }))
                        }
                      />
                      <input
                        value={selectedMaterial.baseColor ?? ""}
                        onChange={(event) =>
                          updateMaterial(selectedMaterial.id, (material) => ({
                            ...material,
                            baseColor: event.target.value
                          }))
                        }
                      />
                    </div>
                  </label>
                </div>

                <div className="field-grid">
                  <NumberField
                    label="Roughness"
                    value={selectedMaterial.roughness ?? 0.5}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        roughness: value
                      }))
                    }
                  />
                  <NumberField
                    label="Metalness"
                    value={selectedMaterial.metalness ?? 0}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        metalness: value
                      }))
                    }
                  />
                  <NumberField
                    label="Opacity"
                    value={selectedMaterial.opacity ?? 1}
                    onChange={(value) =>
                      updateMaterial(selectedMaterial.id, (material) => ({
                        ...material,
                        opacity: value
                      }))
                    }
                  />
                </div>

                <div className="object-detail">
                  <h3>Used By</h3>
                  <div className="chip-row">
                    {sceneGraph?.nodes
                      .filter((node) => node.materialIds.includes(selectedMaterial.id))
                      .slice(0, 12)
                      .map((node) => <span key={node.id}>{node.name}</span>)}
                    {sceneGraph?.nodes.filter((node) => node.materialIds.includes(selectedMaterial.id)).length ===
                      0 && <span>None</span>}
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "variants" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Variant Sets</h2>
                <button
                  type="button"
                  className="icon-action"
                  title="Add variant set"
                  onClick={addMaterialVariantInteraction}
                >
                  <Plus size={17} aria-hidden="true" />
                </button>
              </div>
              {materialVariantInteractions.map((interaction) => (
                <button
                  key={interaction.id}
                  type="button"
                  className={selectedVariantInteractionId === interaction.id ? "list-row active" : "list-row"}
                  onClick={() => setSelectedVariantInteractionId(interaction.id)}
                >
                  <span>{interaction.label}</span>
                  <small>{interaction.targetMaterialName ?? interaction.targetMeshName ?? "untargeted"}</small>
                </button>
              ))}
              {materialVariantInteractions.length === 0 && (
                <p className="empty-list">No material variant sets configured.</p>
              )}
            </div>

            {selectedVariantInteraction && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Palette size={18} aria-hidden="true" />
                  <h2>{selectedVariantInteraction.label}</h2>
                  <button
                    type="button"
                    className="icon-action danger"
                    title="Delete variant set"
                    onClick={() => removeMaterialVariantInteraction(selectedVariantInteraction.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>

                <div className="field-grid">
                  <label>
                    <span>Label</span>
                    <input
                      value={selectedVariantInteraction.label}
                      onChange={(event) =>
                        updateMaterialVariantInteraction(selectedVariantInteraction.id, (interaction) => ({
                          ...interaction,
                          label: event.target.value
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Target Material</span>
                    <select
                      value={selectedVariantInteraction.targetMaterialName ?? ""}
                      onChange={(event) =>
                        updateMaterialVariantInteraction(selectedVariantInteraction.id, (interaction) => {
                          const { targetMeshName, ...rest } = interaction;
                          return {
                            ...rest,
                            targetMaterialName: event.target.value
                          };
                        })
                      }
                    >
                      <option value="">Select material</option>
                      {materialsDoc?.materials.map((material) => (
                        <option key={material.id} value={material.name}>
                          {material.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Target Mesh</span>
                    <input
                      value={selectedVariantInteraction.targetMeshName ?? ""}
                      onChange={(event) =>
                        updateMaterialVariantInteraction(selectedVariantInteraction.id, (interaction) => {
                          const { targetMeshName, ...rest } = interaction;
                          return event.target.value
                            ? { ...rest, targetMeshName: event.target.value }
                            : rest;
                        })
                      }
                    />
                  </label>
                </div>

                <div className="variant-editor-list">
                  <div className="publish-row">
                    <span>Options</span>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => addMaterialVariantOption(selectedVariantInteraction.id)}
                    >
                      <Plus size={16} aria-hidden="true" />
                      Add
                    </button>
                  </div>

                  {selectedVariantInteraction.variants.map((variant) => (
                    <div key={variant.id} className="variant-editor-row">
                      <label>
                        <span>Label</span>
                        <input
                          value={variant.label}
                          onChange={(event) =>
                            updateMaterialVariantOption(
                              selectedVariantInteraction.id,
                              variant.id,
                              (current) => ({ ...current, label: event.target.value })
                            )
                          }
                        />
                      </label>
                      <label>
                        <span>Color</span>
                        <div className="color-control">
                          <input
                            type="color"
                            value={variant.color ?? "#ffffff"}
                            onChange={(event) =>
                              updateMaterialVariantOption(
                                selectedVariantInteraction.id,
                                variant.id,
                                (current) => ({ ...current, color: event.target.value })
                              )
                            }
                          />
                          <input
                            value={variant.color ?? ""}
                            onChange={(event) =>
                              updateMaterialVariantOption(
                                selectedVariantInteraction.id,
                                variant.id,
                                (current) => ({ ...current, color: event.target.value })
                              )
                            }
                          />
                        </div>
                      </label>
                      <button
                        type="button"
                        className="icon-action danger"
                        title="Delete option"
                        onClick={() => removeMaterialVariantOption(selectedVariantInteraction.id, variant.id)}
                      >
                        <Trash2 size={17} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "objects" && (
          <section className="editor-layout">
            <div className="list-panel">
              <div className="list-heading">
                <h2>Objects</h2>
                <small>{sceneGraph?.nodes.length ?? 0}</small>
              </div>
              {sceneGraph?.nodes.map((node) => (
                <div
                  key={node.id}
                  className={selectedObjectId === node.id ? "list-row active" : "list-row"}
                >
                  <button type="button" className="list-row-main" onClick={() => setSelectedObjectId(node.id)}>
                    <span>{node.name}</span>
                    <small>{node.triangleCount} triangles</small>
                  </button>
                  <button
                    type="button"
                    className="visibility-button"
                    title={
                      objectsDoc?.objects.find((object) => object.id === node.id)?.visible === false
                        ? "Show object"
                        : "Hide object"
                    }
                    onClick={() =>
                      updateObject(node.id, (object) => ({
                        ...object,
                        visible: !object.visible
                      }))
                    }
                  >
                    {objectsDoc?.objects.find((object) => object.id === node.id)?.visible === false ? (
                      <EyeOff size={16} aria-hidden="true" />
                    ) : (
                      <Eye size={16} aria-hidden="true" />
                    )}
                  </button>
                </div>
              ))}
              {!sceneGraph && <p className="empty-list">No scene graph generated.</p>}
            </div>

            {selectedObject && sceneGraph && (
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <Layers3 size={18} aria-hidden="true" />
                  <h2>{selectedObject.name}</h2>
                </div>

                <div className="stat-grid">
                  <Stat label="Mesh" value={selectedObject.meshName ?? "None"} />
                  <Stat label="Triangles" value={String(selectedObject.triangleCount)} />
                  <Stat label="Vertices" value={String(selectedObject.vertexCount)} />
                  <Stat
                    label="Visible"
                    value={selectedObjectOverride?.visible === false ? "Hidden" : "Visible"}
                  />
                </div>

                <div className="object-detail">
                  <h3>Material Usage</h3>
                  <div className="chip-row">
                    {selectedObject.materialIds.map((materialId) => {
                      const material = sceneGraph.materials.find((item) => item.id === materialId);
                      return <span key={materialId}>{material?.name ?? materialId}</span>;
                    })}
                    {selectedObject.materialIds.length === 0 && <span>None</span>}
                  </div>
                </div>

                <div className="object-detail">
                  <h3>Bounds</h3>
                  {selectedObject.bounds ? (
                    <code>
                      min [{selectedObject.bounds.min.join(", ")}] max [{selectedObject.bounds.max.join(", ")}]
                    </code>
                  ) : (
                    <p className="quiet-note">No bounds available.</p>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {selectedTab === "controls" && (
          <section className="content-grid">
            <div className="panel editor-panel">
              <div className="panel-heading">
                <Settings2 size={18} aria-hidden="true" />
                <h2>Movement Controls</h2>
              </div>

              {controlsDoc ? (
                <>
                  <div className="toggle-grid">
                    {movementToggles.map(({ field, label }) => (
                      <label key={field} className="toggle-row">
                        <input
                          type="checkbox"
                          checked={controlsDoc.movement[field]}
                          onChange={(event) =>
                            updateControls((current) => ({
                              ...current,
                              movement: {
                                ...current.movement,
                                [field]: event.target.checked
                              }
                            }))
                          }
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>

                  <div className="field-grid">
                    <NumberField
                      label="Move Speed"
                      min={0.5}
                      max={12}
                      step={0.1}
                      value={controlsDoc.movement.moveSpeed}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, moveSpeed: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Horizontal Look"
                      min={0.001}
                      max={0.02}
                      step={0.001}
                      value={controlsDoc.movement.lookSensitivityX}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, lookSensitivityX: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Vertical Look"
                      min={0.001}
                      max={0.02}
                      step={0.001}
                      value={controlsDoc.movement.lookSensitivityY}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, lookSensitivityY: value }
                        }))
                      }
                    />
                    <NumberField
                      label="Click Threshold"
                      min={2}
                      max={24}
                      step={1}
                      value={controlsDoc.movement.clickMoveThresholdPx}
                      onChange={(value) =>
                        updateControls((current) => ({
                          ...current,
                          movement: { ...current.movement, clickMoveThresholdPx: value }
                        }))
                      }
                    />
                  </div>
                </>
              ) : (
                <p className="quiet-note">No controls document loaded.</p>
              )}
            </div>

            <div className="panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>controls.json</h2>
              </div>
              <pre className="json-preview">{JSON.stringify(controlsDoc, null, 2)}</pre>
            </div>
          </section>
        )}

        {selectedTab === "bundle" && (
          <section className="content-grid bundle-grid">
            <div className="panel">
              <div className="panel-heading">
                <FileJson size={18} aria-hidden="true" />
                <h2>Manifest</h2>
              </div>
              <pre className="json-preview">{JSON.stringify(manifest, null, 2)}</pre>
            </div>
            <div className="side-stack">
              <div className="panel stats-panel">
                <div className="panel-heading">
                  <Activity size={18} aria-hidden="true" />
                  <h2>Bundle Stats</h2>
                </div>
                {bundleStats ? (
                  <>
                    <div className="stat-grid">
                      <Stat label="Total" value={formatBytes(bundleStats.totalBytes)} />
                      <Stat label="Model" value={formatBytes(bundleStats.modelBytes)} />
                      <Stat label="Meshes" value={String(bundleStats.meshCount)} />
                      <Stat label="Materials" value={String(bundleStats.materialCount)} />
                      <Stat label="Triangles" value={String(bundleStats.triangleCount)} />
                      <Stat label="Assets" value={String(bundleStats.assetCount)} />
                    </div>
                    {bundleStats.warnings.length > 0 ? (
                      <ul className="warning-list">
                        {bundleStats.warnings.map((warning) => (
                          <li key={warning.code}>{warning.message}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="quiet-note">No bundle warnings.</p>
                    )}
                  </>
                ) : (
                  <p className="quiet-note">Stats are not generated yet.</p>
                )}
              </div>

              <div className="panel publish-panel">
                <div className="publish-row">
                  <span>Viewer URL</span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void copyText(viewerUrl(activeProjectId))}
                  >
                    <Copy size={16} aria-hidden="true" />
                    Copy
                  </button>
                </div>
                <code>{viewerUrl(activeProjectId)}</code>
                <div className="publish-row">
                  <span>Embed</span>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void copyText(embedSnippet(activeProjectId, manifest.branding.clientName ?? manifest.branding.title))
                    }
                  >
                    <Copy size={16} aria-hidden="true" />
                    Copy
                  </button>
                </div>
                <code>{embedSnippet(activeProjectId, manifest.branding.clientName ?? manifest.branding.title)}</code>
              </div>
            </div>
          </section>
        )}
      </section>

      {notice && (
        <div className="notice" role="status">
          <Check size={16} aria-hidden="true" />
          {notice === "saved" && "Saved"}
          {notice === "copied" && "Copied"}
          {notice === "reset" && "Reset"}
        </div>
      )}
    </main>
  );
}

function NumberField({
  label,
  min = 0,
  max = 1,
  step = 0.05,
  value,
  onChange
}: {
  label: string;
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(toNumber(event.target.value, value))}
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function VectorEditor({
  label,
  value,
  onChange
}: {
  label: string;
  value: Vec3;
  onChange: (value: Vec3) => void;
}) {
  return (
    <fieldset className="vector-field">
      <legend>{label}</legend>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>
          <span>{axis}</span>
          <input
            type="number"
            step="0.05"
            value={value[index]}
            onChange={(event) => onChange(updateVec3(value, index, event.target.value))}
          />
        </label>
      ))}
    </fieldset>
  );
}

export default App;
