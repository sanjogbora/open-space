import * as THREE from "three";

export function createHotspotSprite(label: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 160;
  const context = canvas.getContext("2d");

  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.beginPath();
    context.arc(80, 80, 55, 0, Math.PI * 2);
    context.fillStyle = "rgba(0, 132, 255, 0.96)";
    context.fill();
    context.lineWidth = 8;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.stroke();
    context.font = "700 68px Arial, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#ffffff";
    context.fillText(label.slice(0, 1).toUpperCase(), 80, 84);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.38, 0.38, 0.38);
  sprite.renderOrder = 10;
  return sprite;
}

