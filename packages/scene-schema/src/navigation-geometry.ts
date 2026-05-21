type Vec2 = readonly [number, number];

const EPSILON = 0.000001;

export interface ClosestPolygonPointPair2D {
  a: Vec2;
  b: Vec2;
}

export function navigationZoneConnectionPadding(
  aKind: string | undefined,
  bKind: string | undefined,
  bodyRadius = 0.28
): number {
  const basePadding = Math.max(0.22, bodyRadius * 1.35);
  if (aKind !== "pass" && bKind !== "pass") {
    return basePadding;
  }
  return Math.max(basePadding, Math.min(1.15, bodyRadius * 2.8));
}

export function pointToSegmentDistance2D(point: Vec2, start: Vec2, end: Vec2): number {
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

export function pointInPolygon2D(point: Vec2, polygon: readonly Vec2[], padding = 0): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
    if (padding > 0 && pointToSegmentDistance2D(point, a, b) <= padding) {
      return true;
    }
  }
  return inside;
}

function segmentOrientation2D(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
}

function pointOnSegment2D(point: Vec2, start: Vec2, end: Vec2): boolean {
  return (
    point[0] <= Math.max(start[0], end[0]) + EPSILON &&
    point[0] + EPSILON >= Math.min(start[0], end[0]) &&
    point[1] <= Math.max(start[1], end[1]) + EPSILON &&
    point[1] + EPSILON >= Math.min(start[1], end[1])
  );
}

function segmentsIntersect2D(aStart: Vec2, aEnd: Vec2, bStart: Vec2, bEnd: Vec2): boolean {
  const o1 = segmentOrientation2D(aStart, aEnd, bStart);
  const o2 = segmentOrientation2D(aStart, aEnd, bEnd);
  const o3 = segmentOrientation2D(bStart, bEnd, aStart);
  const o4 = segmentOrientation2D(bStart, bEnd, aEnd);
  if (o1 * o2 < 0 && o3 * o4 < 0) {
    return true;
  }
  return (
    (Math.abs(o1) < EPSILON && pointOnSegment2D(bStart, aStart, aEnd)) ||
    (Math.abs(o2) < EPSILON && pointOnSegment2D(bEnd, aStart, aEnd)) ||
    (Math.abs(o3) < EPSILON && pointOnSegment2D(aStart, bStart, bEnd)) ||
    (Math.abs(o4) < EPSILON && pointOnSegment2D(aEnd, bStart, bEnd))
  );
}

function closestPointOnSegment2D(point: Vec2, start: Vec2, end: Vec2): Vec2 {
  const segmentX = end[0] - start[0];
  const segmentZ = end[1] - start[1];
  const segmentLengthSq = segmentX * segmentX + segmentZ * segmentZ;
  if (segmentLengthSq < 0.0001) {
    return [start[0], start[1]];
  }
  const t = Math.min(
    1,
    Math.max(0, ((point[0] - start[0]) * segmentX + (point[1] - start[1]) * segmentZ) / segmentLengthSq)
  );
  return [start[0] + segmentX * t, start[1] + segmentZ * t];
}

export function pointToPolygonDistance2D(point: Vec2, polygon: readonly Vec2[]): number {
  if (polygon.length < 3 || pointInPolygon2D(point, polygon)) {
    return 0;
  }
  return polygon.reduce((distance, start, index) => {
    const end = polygon[(index + 1) % polygon.length]!;
    return Math.min(distance, pointToSegmentDistance2D(point, start, end));
  }, Number.POSITIVE_INFINITY);
}

export function polygonDistance2D(a: readonly Vec2[], b: readonly Vec2[]): number {
  if (a.length < 3 || b.length < 3) {
    return Number.POSITIVE_INFINITY;
  }
  if (a.some((point) => pointInPolygon2D(point, b)) || b.some((point) => pointInPolygon2D(point, a))) {
    return 0;
  }
  let distance = Number.POSITIVE_INFINITY;
  for (let aIndex = 0; aIndex < a.length; aIndex += 1) {
    const aStart = a[aIndex]!;
    const aEnd = a[(aIndex + 1) % a.length]!;
    for (let bIndex = 0; bIndex < b.length; bIndex += 1) {
      const bStart = b[bIndex]!;
      const bEnd = b[(bIndex + 1) % b.length]!;
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

export function closestPolygonPointPair2D(
  a: readonly Vec2[],
  b: readonly Vec2[]
): ClosestPolygonPointPair2D | undefined {
  if (a.length < 3 || b.length < 3) {
    return undefined;
  }
  if (polygonDistance2D(a, b) === 0) {
    const insideA = a.find((point) => pointInPolygon2D(point, b));
    if (insideA) {
      return { a: [insideA[0], insideA[1]], b: [insideA[0], insideA[1]] };
    }
    const insideB = b.find((point) => pointInPolygon2D(point, a));
    if (insideB) {
      return { a: [insideB[0], insideB[1]], b: [insideB[0], insideB[1]] };
    }
  }
  let best: { a: Vec2; b: Vec2; distance: number } | undefined;
  const remember = (pointA: Vec2, pointB: Vec2) => {
    const distance = Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1]);
    if (!best || distance < best.distance) {
      best = { a: [pointA[0], pointA[1]], b: [pointB[0], pointB[1]], distance };
    }
  };
  for (const point of a) {
    for (let index = 0; index < b.length; index += 1) {
      remember(point, closestPointOnSegment2D(point, b[index]!, b[(index + 1) % b.length]!));
    }
  }
  for (const point of b) {
    for (let index = 0; index < a.length; index += 1) {
      remember(closestPointOnSegment2D(point, a[index]!, a[(index + 1) % a.length]!), point);
    }
  }
  return best ? { a: best.a, b: best.b } : undefined;
}
