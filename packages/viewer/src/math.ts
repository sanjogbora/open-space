import * as THREE from "three";
import type { Vec3 } from "@walkthrough/scene-schema";

export function toVector3(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

export function clampToBounds(
  value: THREE.Vector3,
  min: THREE.Vector3,
  max: THREE.Vector3
): THREE.Vector3 {
  value.x = Math.min(max.x, Math.max(min.x, value.x));
  value.y = Math.min(max.y, Math.max(min.y, value.y));
  value.z = Math.min(max.z, Math.max(min.z, value.z));
  return value;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function damp(current: number, target: number, smoothing: number, delta: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-smoothing * delta));
}

export function dampAngle(current: number, target: number, smoothing: number, delta: number): number {
  const difference = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  return current + difference * (1 - Math.exp(-smoothing * delta));
}

export function dampVector(
  current: THREE.Vector3,
  target: THREE.Vector3,
  smoothing: number,
  delta: number
): THREE.Vector3 {
  current.x = damp(current.x, target.x, smoothing, delta);
  current.y = damp(current.y, target.y, smoothing, delta);
  current.z = damp(current.z, target.z, smoothing, delta);
  return current;
}
