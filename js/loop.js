// Core route-finding logic: no DOM, so it runs in the browser and in Node tests.

import { destinationPoint, haversine } from './geo.js';
import { familiarShare, snapToRidden } from './familiar.js';

const BROUTER_URL = 'https://brouter.de/brouter';

// Roads usually wind more than a straight line between waypoints.
const ROAD_DETOUR_FACTOR = 1.3;

// Custom BRouter profiles (see profiles/) that keep away from main roads, cycle
// paths running alongside them, and road noise.
export const BIKE_PROFILES = {
  road: { label: 'Road bike', file: 'profiles/quiet-road.brf' },
  gravel: { label: 'Gravel', file: 'profiles/quiet-gravel.brf' },
};

// Uploads a profile to BRouter once and remembers the id it hands back. The server
// forgets custom profiles after a while, so `forget` lets callers upload again.
export function createProfileStore(loadProfileText, fetchImpl = fetch) {
  const ids = new Map();
  return {
    async get(bike) {
      if (!ids.has(bike)) {
        const text = await loadProfileText(BIKE_PROFILES[bike].file);
        const res = await fetchImpl(`${BROUTER_URL}/profile`, { method: 'POST', body: text });
        const body = await res.json();
        if (!body.profileid) throw new Error(body.error || 'Could not upload routing profile');
        ids.set(bike, body.profileid);
      }
      return ids.get(bike);
    },
    forget(bike) {
      ids.delete(bike);
    },
  };
}

// Waypoints for a loop: the start sits on a circle whose centre lies `heading` away;
// the other points are spread around that circle so the ride comes back home.
export function loopWaypoints(start, targetM, heading, points = 3, shapeScale = 1) {
  const radius = (targetM / (2 * Math.PI * ROAD_DETOUR_FACTOR)) * shapeScale;
  const centre = destinationPoint(start, heading, radius);
  const backBearing = (heading + 180) % 360;
  const waypoints = [];
  for (let i = 1; i <= points; i++) {
    waypoints.push(destinationPoint(centre, backBearing + (360 / (points + 1)) * i, radius));
  }
  return [start, ...waypoints, start];
}

export async function fetchRoute(waypoints, profile, fetchImpl = fetch) {
  const lonlats = waypoints.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join('|');
  const url = `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  const res = await fetchImpl(url);
  const text = await res.text();
  if (!res.ok) throw new Error(text.trim() || `Routing failed (${res.status})`);
  return parseBrouter(JSON.parse(text));
}

export function parseBrouter(geojson) {
  const feature = geojson.features[0];
  const props = feature.properties;
  const coords = feature.geometry.coordinates.map(([lon, lat, ele]) => [lat, lon, ele ?? null]);
  const [header, ...rows] = props.messages;
  const col = (name) => header.indexOf(name);
  const segments = rows.map((r) => ({
    lat: Number(r[col('Latitude')]) / 1e6,
    lon: Number(r[col('Longitude')]) / 1e6,
    distance: Number(r[col('Distance')]),
    tags: parseTags(r[col('WayTags')]),
  }));
  return {
    coords,
    segments,
    lengthM: Number(props['track-length']),
    ascendM: Number(props['filtered ascend']),
    timeS: Number(props['total-time']),
  };
}

function parseTags(str) {
  const tags = {};
  for (const pair of (str || '').split(' ')) {
    const i = pair.indexOf('=');
    if (i > 0) tags[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return tags;
}

const MAIN_ROAD = /^(tertiary|secondary|primary|trunk|motorway)/;
const QUIET = new Set(['residential', 'service', 'unclassified', 'road', 'track', 'path', 'living_street', 'pedestrian', 'footway', 'bridleway']);

// One-way cycle paths are nearly always sidepaths mapped next to a main road.
const isSidepath = (tags) => tags.highway === 'cycleway' && ['yes', '-1'].includes(tags.oneway);

const hasCycleTrack = (tags) =>
  ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right'].some((k) => ['track', 'separate'].includes(tags[k]));

// 0 (in heavy traffic) .. 1 (quiet, away from cars) for one way, based on its OSM tags.
export function safetyOf(tags) {
  const hw = tags.highway;
  if (tags.bicycle_road === 'yes' || tags.cyclestreet === 'yes') return 1;
  if (hw === 'cycleway') return isSidepath(tags) ? 0.65 : 1;
  if (QUIET.has(hw)) {
    const speed = parseInt(tags.maxspeed, 10);
    return speed >= 70 ? 0.6 : 0.95;
  }
  if (MAIN_ROAD.test(hw)) {
    // A separate track beside a main road is safe-ish, but not the quiet road we want.
    if (hasCycleTrack(tags)) return 0.65;
    if (/^tertiary/.test(hw)) return 0.45;
    if (/^secondary/.test(hw)) return 0.25;
    return 0.1;
  }
  return 0.8;
}

export const safetyLevel = (safety) => (safety >= 0.8 ? 'safe' : safety >= 0.5 ? 'ok' : 'busy');

const isCycleRoute = (tags) => Object.keys(tags).some((k) => k.startsWith('route_bicycle_'));
const isUnpaved = (tags) =>
  ['unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'ground', 'grass'].includes(tags.surface) ||
  (tags.highway === 'track' && !tags.surface);

// Share of the ride that covers ground already ridden (out-and-back sections).
export function overlapShare(coords) {
  const seen = new Set();
  let repeated = 0;
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    total += d;
    const a = cellKey(coords[i - 1]);
    const b = cellKey(coords[i]);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (a !== b && seen.has(key)) repeated += d;
    seen.add(key);
  }
  return total ? repeated / total : 0;
}

const cellKey = ([lat, lon]) => `${Math.round(lat * 4000)},${Math.round(lon * 4000)}`; // ~25 m grid

// `roads` is 'mine' (prefer roads from the athlete's rides), 'new' (prefer roads
// they have never ridden) or null when no rides are loaded.
export function scoreRoute(route, bike, grid = null, roads = null) {
  let total = 0;
  let safe = 0;
  let network = 0;
  let unpaved = 0;
  let mainRoad = 0;
  for (const s of route.segments) {
    total += s.distance;
    const safety = safetyOf(s.tags);
    safe += safety * s.distance;
    if (safety < 0.8) mainRoad += s.distance;
    if (isCycleRoute(s.tags)) network += s.distance;
    if (isUnpaved(s.tags)) unpaved += s.distance;
  }
  total = total || 1;
  const metrics = {
    safety: safe / total,
    mainRoadShare: mainRoad / total,
    networkShare: network / total,
    unpavedShare: unpaved / total,
    overlap: overlapShare(route.coords),
    familiar: grid ? familiarShare(grid, route.coords) : null,
  };
  // "Fun": a real loop (little doubling back) along signed cycle routes, with the
  // surface the bike is made for, and on the athlete's favourite (or new) roads.
  const surfaceFit = bike === 'gravel' ? Math.min(1, metrics.unpavedShare * 2) : 1 - metrics.unpavedShare;
  const parts = [
    [0.5, 1 - metrics.overlap],
    [0.3, metrics.networkShare],
    [0.2, surfaceFit],
  ];
  if (roads && metrics.familiar !== null) parts.push([0.6, roads === 'mine' ? metrics.familiar : 1 - metrics.familiar]);
  const weight = parts.reduce((s, [w]) => s + w, 0);
  metrics.fun = parts.reduce((s, [w, v]) => s + w * v, 0) / weight;
  metrics.score = 0.55 * metrics.safety + 0.45 * metrics.fun;
  return metrics;
}

// Route one loop, rescaling it until its length is within `tolerance` of the target.
export async function buildLoop({ start, targetM, heading, bike, profiles, grid, roads, fetchImpl = fetch, tolerance = 0.07, maxTries = 4 }) {
  let scale = 1;
  let best = null;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    let waypoints = loopWaypoints(start, targetM, heading, 3, scale);
    if (roads === 'mine' && grid) {
      const searchM = Math.min(4000, (targetM / (2 * Math.PI * ROAD_DETOUR_FACTOR)) * scale * 0.4);
      waypoints = waypoints.map((p, i) => (i === 0 || i === waypoints.length - 1 ? p : snapToRidden(grid, p, searchM)));
    }
    const route = await routeWithProfile(waypoints, bike, profiles, fetchImpl);
    const error = Math.abs(route.lengthM - targetM) / targetM;
    if (!best || error < best.error) best = { ...route, waypoints, heading, error };
    if (error <= tolerance) break;
    scale *= targetM / route.lengthM;
  }
  return { ...best, metrics: scoreRoute(best, bike, grid, roads) };
}

async function routeWithProfile(waypoints, bike, profiles, fetchImpl) {
  try {
    return await fetchRoute(waypoints, await profiles.get(bike), fetchImpl);
  } catch {
    // The server answers an empty 500 once it has dropped an uploaded profile, which
    // looks like any other failure: upload the profile again and retry once.
    profiles.forget(bike);
    return fetchRoute(waypoints, await profiles.get(bike), fetchImpl);
  }
}

// Try loops leaving in different directions and return them best first.
export async function findLoops({ start, targetM, bike, profiles, grid = null, roads = null, directions = 6, fetchImpl = fetch, onProgress = () => {} }) {
  await profiles.get(bike);
  const offset = Math.random() * 360;
  const queue = Array.from({ length: directions }, (_, i) => (offset + (360 / directions) * i) % 360);
  const results = [];
  const errors = [];
  let done = 0;
  // Two at a time: brouter.de is a free community server.
  const worker = async () => {
    while (queue.length) {
      const heading = queue.shift();
      try {
        results.push(await buildLoop({ start, targetM, heading, bike, profiles, grid, roads, fetchImpl }));
      } catch (err) {
        errors.push(err);
      }
      onProgress(++done, directions);
    }
  };
  await Promise.all([worker(), worker()]);
  if (!results.length && errors.length) throw errors[0];
  return results.sort((a, b) => b.metrics.score - a.metrics.score);
}

// Split the track into runs that share a safety level, for colouring the map.
export function safetyRuns(route) {
  const runs = [];
  let seg = 0;
  let current = null;
  for (const [lat, lon] of route.coords) {
    const s = route.segments[Math.min(seg, route.segments.length - 1)];
    const level = safetyLevel(s ? safetyOf(s.tags) : 1);
    if (!current || current.level !== level) {
      const prev = current && current.coords[current.coords.length - 1];
      current = { level, coords: prev ? [prev] : [] };
      runs.push(current);
    }
    current.coords.push([lat, lon]);
    // Message rows mark where each way ends; move on once we reach that point.
    if (s && Math.abs(s.lat - lat) < 2e-6 && Math.abs(s.lon - lon) < 2e-6) seg++;
  }
  return runs;
}

export function toGpx(route, name = 'FindMyRoute loop') {
  const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const pts = route.coords
    .map(([lat, lon, ele]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele != null ? `<ele>${ele}</ele>` : ''}</trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="FindMyRoute" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}
