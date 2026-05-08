import * as THREE from "three";
import type { VideoTextureInteraction } from "@walkthrough/scene-schema";

export interface ManagedTexture {
  texture: THREE.Texture;
  update?: (elapsed: number) => void;
  setActive?: (active: boolean) => void;
  destroy?: () => void;
}

function createGeneratedSignal(): ManagedTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 288;
  const context = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  return {
    texture,
    update: (elapsed: number) => {
      if (!context) {
        return;
      }
      const gradient = context.createLinearGradient(0, 0, 512, 288);
      gradient.addColorStop(0, "#0f7bdc");
      gradient.addColorStop(0.45, "#20a8c8");
      gradient.addColorStop(1, "#f38f4f");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 288);

      context.fillStyle = "rgba(255, 255, 255, 0.22)";
      for (let i = 0; i < 9; i += 1) {
        const y = ((elapsed * 38 + i * 36) % 340) - 40;
        context.fillRect(0, y, 512, 8);
      }

      context.fillStyle = "rgba(8, 20, 35, 0.45)";
      context.fillRect(28, 198, 220, 48);
      context.font = "700 24px Arial, sans-serif";
      context.fillStyle = "#ffffff";
      context.fillText("VIDEO SURFACE", 44, 229);
      texture.needsUpdate = true;
    }
  };
}

export function createManagedVideoTexture(interaction: VideoTextureInteraction): ManagedTexture {
  if (interaction.source.startsWith("generated://")) {
    return createGeneratedSignal();
  }

  const video = document.createElement("video");
  video.src = interaction.source;
  video.crossOrigin = "anonymous";
  video.loop = interaction.loop ?? true;
  video.muted = interaction.muted ?? true;
  video.playsInline = true;
  video.preload = "metadata";
  let desiredActive = interaction.autoplay !== false;

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const tryPlay = () => {
    if (!desiredActive) {
      return;
    }
    void video.play().catch(() => {
      video.muted = true;
    });
  };

  video.addEventListener("canplay", tryPlay, { once: true });

  return {
    texture,
    setActive: (active) => {
      desiredActive = active && interaction.autoplay !== false;
      if (desiredActive) {
        tryPlay();
        return;
      }
      video.pause();
    },
    destroy: () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  };
}
