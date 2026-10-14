// "Roads I ride": a grid of map cells covered by the athlete's own rides.
// Pure functions, no DOM, so they run in Node tests too.

import { haversine } from './geo.js';

const CELLS_PER_DEGREE = 2000; // ~55 m north-south, ~35 m east-west in Belgium
const SAMPLE_STEP_M = 20;

const cellOf = ([lat, lon]) => [Math.round(lat * CELLS_PER_DEGREE), Math.round(lon * CELLS_PER_DEGREE)];
const key = (i, j) => `${i},${j}`;

// Google encoded polyline (what Strava returns in map.summary_polyline) -> [[lat, lon], ...]
export function decodePolyline(str) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / 1e5, lon / 1e5]);
  }
  return points;
}

// Walk a line in small steps so that long straight polyline edges still mark every cell.
function* sample(points) {
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const steps = Math.max(1, Math.ceil(haversine(a, b) / SAMPLE_STEP_M));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      yield [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  if (points.length) yield points[points.length - 1];
}

// Map of cell -> number of rides that passed through it.
export function buildGrid(rides) {
  const grid = new Map();
  for (const points of rides) {
    const seen = new Set();
    for (const p of sample(points)) {
      const k = key(...cellOf(p));
      if (seen.has(k)) continue;
      seen.add(k);
      grid.set(k, (grid.get(k) || 0) + 1);
    }
  }
  return grid;
}

function isRidden(grid, point) {
  const [i, j] = cellOf(point);
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      if (grid.has(key(i + di, j + dj))) return true;
    }
  }
  return false;
}

// Share of a route's distance on roads the athlete has ridden before.
export function familiarShare(grid, coords) {
  if (!grid || !grid.size) return 0;
  let total = 0;
  let known = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    const mid = [(coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2];
    total += d;
    if (isRidden(grid, mid)) known += d;
  }
  return total ? known / total : 0;
}

// Move a waypoint onto a nearby, often-ridden road. Returns the original point when
// nothing the athlete rode lies within `searchM`.
export function snapToRidden(grid, point, searchM) {
  if (!grid || !grid.size) return point;
  const [ci, cj] = cellOf(point);
  const latSpan = Math.ceil((searchM / 111320) * CELLS_PER_DEGREE);
  const lonSpan = Math.ceil((searchM / (111320 * Math.cos((point[0] * Math.PI) / 180))) * CELLS_PER_DEGREE);
  let best = null;
  let bestScore = 0;
  for (let i = ci - latSpan; i <= ci + latSpan; i++) {
    for (let j = cj - lonSpan; j <= cj + lonSpan; j++) {
      const count = grid.get(key(i, j));
      if (!count) continue;
      const p = [i / CELLS_PER_DEGREE, j / CELLS_PER_DEGREE];
      const d = haversine(point, p);
      if (d > searchM) continue;
      // Favour roads ridden often, but not at the cost of wrecking the loop shape.
      const score = Math.sqrt(count) / (1 + d / (searchM / 3));
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best || point;
}
