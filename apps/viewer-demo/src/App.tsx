import { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgeInfo,
  Camera,
  Gauge,
  Map,
  Maximize2,
  MonitorPlay,
  Palette,
  Share2,
  X
} from "lucide-react";
import {
  WalkthroughViewer,
  type ViewerCameraPose,
  type HotspotActivation,
  type ObjectPickActivation,
  type ViewerQuality
} from "@walkthrough/viewer";
import {
  parseSceneManifest,
  type MaterialVariantInteraction,
  type SceneInteraction,
  type SceneManifest,
  type SceneView
} from "@walkthrough/scene-schema";
import "./styles.css";

const defaultManifestUrl = "/scenes/demo/scene.manifest.json";

const qualityOptions: readonly { id: ViewerQuality; label: string }[] = [
  { id: "mobile", label: "Mobile" },
  { id: "balanced", label: "Balanced" },
  { id: "desktop", label: "Desktop" }
];

function getInitialManifestUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("scene") ?? defaultManifestUrl;
}

function isGeneratedOrAbsoluteUrl(value: string): boolean {
  return (
    value.startsWith("generated://") ||
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("/")
  );
}

function resolveBundleUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value || isGeneratedOrAbsoluteUrl(value)) {
    return value;
  }
  return new URL(value, baseUrl).href;
}

function resolveInteractionAssets(interaction: SceneInteraction, baseUrl: string): SceneInteraction {
  if (interaction.kind !== "video-texture") {
    return interaction;
  }
  return {
    ...interaction,
    source: resolveBundleUrl(interaction.source, baseUrl) ?? interaction.source
  };
}

function resolveManifestAssets(manifest: SceneManifest, manifestUrl: string): SceneManifest {
  const absoluteManifestUrl = new URL(manifestUrl, window.location.href).href;
  const sceneUrl = resolveBundleUrl(manifest.sceneUrl, absoluteManifestUrl);
  const graphUrl = resolveBundleUrl(manifest.graphUrl, absoluteManifestUrl);
  const materialsUrl = resolveBundleUrl(manifest.materialsUrl, absoluteManifestUrl);
  const objectsUrl = resolveBundleUrl(manifest.objectsUrl, absoluteManifestUrl);
  const controlsUrl = resolveBundleUrl(manifest.controlsUrl, absoluteManifestUrl);
  return {
    ...manifest,
    ...(sceneUrl ? { sceneUrl } : {}),
    ...(graphUrl ? { graphUrl } : {}),
    ...(materialsUrl ? { materialsUrl } : {}),
    ...(objectsUrl ? { objectsUrl } : {}),
    ...(controlsUrl ? { controlsUrl } : {}),
    interactions: manifest.interactions.map((interaction) =>
      resolveInteractionAssets(interaction, absoluteManifestUrl)
    )
  };
}

function isMaterialVariantInteraction(
  interaction: SceneInteraction
): interaction is MaterialVariantInteraction {
  return interaction.kind === "material-variant";
}

interface MinimapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function sceneToMinimap(position: readonly [number, number, number], bounds: MinimapBounds) {
  const width = Math.max(0.001, bounds.maxX - bounds.minX);
  const depth = Math.max(0.001, bounds.maxZ - bounds.minZ);
  return {
    left: `${((position[0] - bounds.minX) / width) * 100}%`,
    top: `${100 - ((position[2] - bounds.minZ) / depth) * 100}%`
  };
}

function App() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<WalkthroughViewer | null>(null);
  const [manifestUrl] = useState(getInitialManifestUrl);
  const [manifest, setManifest] = useState<SceneManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [activeViewId, setActiveViewId] = useState("");
  const [activeHotspot, setActiveHotspot] = useState<HotspotActivation | null>(null);
  const [activeObject, setActiveObject] = useState<ObjectPickActivation | null>(null);
  const [quality, setQuality] = useState<ViewerQuality>("balanced");
  const [shareState, setShareState] = useState<"idle" | "copied">("idle");
  const [screenshotState, setScreenshotState] = useState<"idle" | "saved" | "failed">("idle");
  const [cameraPose, setCameraPose] = useState<ViewerCameraPose | null>(null);
  const [activeVariants, setActiveVariants] = useState<Record<string, string>>({});
  const [embedMode] = useState(() => new URLSearchParams(window.location.search).get("embed") === "1");

  const views = useMemo(() => manifest?.views ?? [], [manifest]);
  const rooms = useMemo(() => manifest?.rooms ?? [], [manifest]);
  const materialVariantInteractions = useMemo(
    () => manifest?.interactions.filter(isMaterialVariantInteraction) ?? [],
    [manifest]
  );
  const minimapBounds = useMemo((): MinimapBounds | null => {
    if (!manifest) {
      return null;
    }
    const bounds = manifest.navigation.bounds;
    if (bounds) {
      return {
        minX: bounds.min[0],
        maxX: bounds.max[0],
        minZ: bounds.min[2],
        maxZ: bounds.max[2]
      };
    }
    const points = manifest.views.map((view) => view.position);
    if (points.length === 0) {
      return null;
    }
    const xs = points.map((point) => point[0]);
    const zs = points.map((point) => point[2]);
    return {
      minX: Math.min(...xs) - 1,
      maxX: Math.max(...xs) + 1,
      minZ: Math.min(...zs) - 1,
      maxZ: Math.max(...zs) + 1
    };
  }, [manifest]);

  useEffect(() => {
    let cancelled = false;

    async function loadManifest() {
      setReady(false);
      setProgress(0);
      setManifestError(null);

      try {
        const response = await fetch(manifestUrl);
        if (!response.ok) {
          throw new Error(`Manifest request failed with ${response.status}.`);
        }
        const parsed = parseSceneManifest(await response.json());
        const resolved = resolveManifestAssets(parsed, manifestUrl);

        if (!cancelled) {
          setManifest(resolved);
          setActiveViewId(resolved.views[0]?.id ?? "");
          document.title = resolved.branding.clientName
            ? `${resolved.branding.clientName} | ${resolved.branding.title}`
            : resolved.branding.title;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Scene manifest failed to load.";
        if (!cancelled) {
          setManifestError(message);
        }
      }
    }

    void loadManifest();

    return () => {
      cancelled = true;
    };
  }, [manifestUrl]);

  useEffect(() => {
    if (!viewportRef.current || !manifest) {
      return;
    }

    const viewer = new WalkthroughViewer({
      container: viewportRef.current,
      manifest,
      quality,
      onReady: () => {
        setReady(true);
        setProgress(1);
      },
      onProgress: (event) => {
        setProgress(event.ratio);
      },
      onViewChange: (view) => {
        setActiveViewId(view.id);
      },
      onHotspot: (activation) => {
        setActiveHotspot(activation);
        setActiveObject(null);
      },
      onObjectPick: (activation) => {
        setActiveObject(activation);
        setActiveHotspot(null);
      },
      onError: (error) => {
        console.error(error);
      }
    });

    viewerRef.current = viewer;
    void viewer.start();

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [manifest]);

  useEffect(() => {
    viewerRef.current?.setQuality(quality);
  }, [quality]);

  useEffect(() => {
    if (!ready) {
      setCameraPose(null);
      return;
    }
    let frame = 0;
    let lastUpdate = 0;
    const update = (time: number) => {
      if (time - lastUpdate > 120) {
        const pose = viewerRef.current?.getCameraPose();
        if (pose) {
          setCameraPose(pose);
        }
        lastUpdate = time;
      }
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);

  const activateView = (view: SceneView) => {
    setActiveViewId(view.id);
    setActiveHotspot(null);
    setActiveObject(null);
    viewerRef.current?.goToView(view.id);
  };

  const activateVariant = (interaction: MaterialVariantInteraction, variantId: string) => {
    setActiveVariants((current) => ({ ...current, [interaction.id]: variantId }));
    viewerRef.current?.applyMaterialVariant(interaction.id, variantId);
  };

  const toggleFullscreen = () => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    void element.requestFullscreen();
  };

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      await navigator.share({ title: manifest?.branding.title ?? "Walkthrough", url });
      return;
    }
    await navigator.clipboard.writeText(url);
    setShareState("copied");
    window.setTimeout(() => setShareState("idle"), 1300);
  };

  const embedSnippet = `<iframe title="${manifest?.branding.clientName ?? "Walkthrough"}" src="${window.location.origin}/?scene=${encodeURIComponent(manifestUrl)}&embed=1" allow="fullscreen; autoplay" allowfullscreen></iframe>`;

  const copyEmbed = async () => {
    await navigator.clipboard.writeText(embedSnippet);
    setShareState("copied");
    window.setTimeout(() => setShareState("idle"), 1300);
  };

  const captureScreenshot = () => {
    try {
      const imageUrl = viewerRef.current?.captureScreenshot();
      if (!imageUrl) {
        throw new Error("Viewer is not ready.");
      }
      const filenameSource = manifest?.branding.clientName || manifest?.branding.title || "walkthrough";
      const filename = `${filenameSource.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "walkthrough"}-screenshot.png`;
      const link = document.createElement("a");
      link.href = imageUrl;
      link.download = filename;
      link.click();
      setScreenshotState("saved");
    } catch {
      setScreenshotState("failed");
    }
    window.setTimeout(() => setScreenshotState("idle"), 1500);
  };

  return (
    <main className={embedMode ? "app-shell embed-mode" : "app-shell"}>
      <section className="viewer-shell" ref={viewportRef} aria-label="Walkthrough viewer">
        {(!ready || manifestError) && (
          <div className="loading-layer" role="status" aria-live="polite">
            <div className={manifestError ? "loading-content error" : "loading-content"}>
              <MonitorPlay aria-hidden="true" size={28} />
              <div>
                <div className="loading-title">
                  {manifestError ? "Scene failed to load" : manifest?.branding.clientName ?? "Loading scene"}
                </div>
                {manifestError ? (
                  <p className="loading-error">{manifestError}</p>
                ) : (
                  <div className="progress-track">
                    <div className="progress-value" style={{ width: `${Math.max(8, progress * 100)}%` }} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <header className="topbar">
          <div className="project-title">
            <span>{manifest?.branding.title ?? "Walkthrough Studio"}</span>
            <strong>{manifest?.branding.clientName ?? "Scene Bundle"}</strong>
          </div>

          <div className="toolbar" aria-label="Viewer tools">
            <label className="quality-select">
              <Gauge size={16} aria-hidden="true" />
              <select
                value={quality}
                onChange={(event) => setQuality(event.target.value as ViewerQuality)}
                aria-label="Quality"
              >
                {qualityOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="icon-button" title="Share" onClick={() => void share()}>
              <Share2 size={18} aria-hidden="true" />
              <span className="sr-only">Share</span>
            </button>
            {!embedMode && (
              <button type="button" className="icon-button" title="Copy embed" onClick={() => void copyEmbed()}>
                <MonitorPlay size={18} aria-hidden="true" />
                <span className="sr-only">Copy embed</span>
              </button>
            )}
            <button type="button" className="icon-button" title="Screenshot" onClick={captureScreenshot}>
              <Camera size={18} aria-hidden="true" />
              <span className="sr-only">Screenshot</span>
            </button>
            <button type="button" className="icon-button" title="Fullscreen" onClick={toggleFullscreen}>
              <Maximize2 size={18} aria-hidden="true" />
              <span className="sr-only">Fullscreen</span>
            </button>
          </div>
        </header>

        <nav className="view-rail" aria-label="Views">
          {views.map((view) => (
            <button
              key={view.id}
              type="button"
              className={activeViewId === view.id ? "view-button active" : "view-button"}
              onClick={() => activateView(view)}
            >
              {view.label}
            </button>
          ))}
        </nav>

        {manifest && minimapBounds && cameraPose && (
          <aside className="minimap" aria-label="Floorplan">
            <div className="minimap-heading">
              <Map size={15} aria-hidden="true" />
              <strong>Floorplan</strong>
            </div>
            <div className="minimap-surface">
              <div
                className="minimap-camera"
                style={{
                  ...sceneToMinimap(cameraPose.position, minimapBounds),
                  transform: `translate(-50%, -50%) rotate(${cameraPose.yaw}rad)`
                }}
                aria-hidden="true"
              />
              {views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={activeViewId === view.id ? "minimap-view active" : "minimap-view"}
                  style={sceneToMinimap(view.position, minimapBounds)}
                  title={view.label}
                  onClick={() => activateView(view)}
                >
                  <span className="sr-only">{view.label}</span>
                </button>
              ))}
            </div>
          </aside>
        )}

        {rooms.length > 0 && (
          <aside className="room-list" aria-label="Rooms">
            {rooms.map((room) => {
              const view = views.find((item) => item.id === room.viewId);
              return (
                <button
                  key={room.id}
                  type="button"
                  className={room.viewId && activeViewId === room.viewId ? "room-row active" : "room-row"}
                  disabled={!view}
                  onClick={() => view && activateView(view)}
                >
                  <span>{room.label}</span>
                  {room.dimensions && <small>{room.dimensions}</small>}
                </button>
              );
            })}
          </aside>
        )}

        {activeHotspot && (
          <aside className="hotspot-panel" aria-live="polite">
            <div className="hotspot-heading">
              <BadgeInfo size={18} aria-hidden="true" />
              <strong>{activeHotspot.interaction.title}</strong>
              <button
                type="button"
                className="icon-button compact"
                title="Close"
                onClick={() => setActiveHotspot(null)}
              >
                <X size={16} aria-hidden="true" />
                <span className="sr-only">Close</span>
              </button>
            </div>
            {activeHotspot.interaction.body && <p>{activeHotspot.interaction.body}</p>}
          </aside>
        )}

        {activeObject && (
          <aside className="object-panel" aria-live="polite">
            <div className="hotspot-heading">
              <BadgeInfo size={18} aria-hidden="true" />
              <strong>{activeObject.objectName}</strong>
              <button
                type="button"
                className="icon-button compact"
                title="Close"
                onClick={() => setActiveObject(null)}
              >
                <X size={16} aria-hidden="true" />
                <span className="sr-only">Close</span>
              </button>
            </div>
            <dl className="object-details">
              <div>
                <dt>Materials</dt>
                <dd>{activeObject.materialNames.length > 0 ? activeObject.materialNames.join(", ") : "None"}</dd>
              </div>
              <div>
                <dt>Position</dt>
                <dd>{activeObject.point.map((value) => value.toFixed(2)).join(", ")}</dd>
              </div>
            </dl>
          </aside>
        )}

        {materialVariantInteractions.length > 0 && (
          <aside className="variant-panel" aria-label="Material variants">
            {materialVariantInteractions.map((interaction) => (
              <div key={interaction.id} className="variant-group">
                <div className="variant-heading">
                  <Palette size={17} aria-hidden="true" />
                  <strong>{interaction.label}</strong>
                </div>
                <div className="variant-options">
                  {interaction.variants.map((variant) => (
                    <button
                      key={variant.id}
                      type="button"
                      className={
                        activeVariants[interaction.id] === variant.id ? "variant-button active" : "variant-button"
                      }
                      title={variant.label}
                      onClick={() => activateVariant(interaction, variant.id)}
                    >
                      <span
                        className="variant-swatch"
                        style={{ background: variant.color ?? "#ffffff" }}
                        aria-hidden="true"
                      />
                      <span>{variant.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </aside>
        )}

        {shareState === "copied" && <div className="toast">Link copied</div>}
        {screenshotState === "saved" && <div className="toast">Screenshot saved</div>}
        {screenshotState === "failed" && <div className="toast">Screenshot unavailable</div>}
      </section>
    </main>
  );
}

export default App;
