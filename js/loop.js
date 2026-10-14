// Core route-finding logic: no DOM, so it runs in the browser and in Node tests.

const BROUTER_URL = 'https://brouter.de/brouter';
const EARTH_RADIUS_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Roads usually wind more than a straight line between waypoints.
const ROAD_DETOUR_FACTOR = 1.3;

export const BIKE_PROFILES = {
  road: { label: 'Road bike', profile: 'fastbike-verylowtraffic' },
  gravel: { label: 'Gravel', profile: 'gravel' },
  touring: { label: 'City / touring', profile: 'safety' },
};

// Point reached by going `distanceM` metres from [lat, lon] on compass bearing `bearingDeg`.
export function destinationPoint([lat, lon], bearingDeg, distanceM) {
  const d = distanceM / EARTH_RADIUS_M;
  const b = toRad(bearingDeg);
  const la1 = toRad(lat);
  const lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [toDeg(la2), ((toDeg(lo2) + 540) % 360) - 180];
}

export function haversine([lat1, lon1], [lat2, lon2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
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

const SEPARATED = new Set(['cycleway', 'path', 'track', 'pedestrian', 'living_street', 'footway', 'bridleway']);
const QUIET = new Set(['residential', 'service', 'unclassified', 'road']);
const BUSY = new Set(['primary', 'primary_link', 'trunk', 'trunk_link', 'motorway']);

// 0 (dangerous) .. 1 (traffic-free) for one way, based on its OSM tags.
export function safetyOf(tags) {
  const hw = tags.highway;
  if (tags.bicycle_road === 'yes' || tags.cyclestreet === 'yes') return 1;
  if (SEPARATED.has(hw)) return 1;
  const cycleway = ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right'].map((k) => tags[k]).filter(Boolean);
  const hasTrack = cycleway.includes('track') || cycleway.includes('separate');
  const hasLane = cycleway.includes('lane') || cycleway.includes('shared_lane');
  const speed = parseInt(tags.maxspeed, 10);
  let score;
  if (QUIET.has(hw)) score = 0.85;
  else if (hw === 'tertiary' || hw === 'tertiary_link') score = 0.6;
  else if (hw === 'secondary' || hw === 'secondary_link') score = 0.35;
  else if (BUSY.has(hw)) score = 0.1;
  else score = 0.6;
  if (hasTrack) score = Math.max(score, 0.9);
  else if (hasLane) score = Math.min(1, score + 0.15);
  if (speed && speed <= 30) score = Math.min(1, score + 0.1);
  if (speed && speed >= 70) score = Math.max(0, score - 0.2);
  return score;
}

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

export function scoreRoute(route, bike) {
  let total = 0;
  let safe = 0;
  let network = 0;
  let unpaved = 0;
  let busy = 0;
  for (const s of route.segments) {
    total += s.distance;
    const safety = safetyOf(s.tags);
    safe += safety * s.distance;
    if (safety < 0.4) busy += s.distance;
    if (isCycleRoute(s.tags)) network += s.distance;
    if (isUnpaved(s.tags)) unpaved += s.distance;
  }
  total = total || 1;
  const metrics = {
    safety: safe / total,
    busyShare: busy / total,
    networkShare: network / total,
    unpavedShare: unpaved / total,
    overlap: overlapShare(route.coords),
  };
  // "Fun": a real loop (little doubling back) along signed cycle routes, with the
  // surface the bike is made for.
  const surfaceFit = bike === 'gravel' ? Math.min(1, metrics.unpavedShare * 2) : bike === 'road' ? 1 - metrics.unpavedShare : 1;
  metrics.fun = 0.5 * (1 - metrics.overlap) + 0.3 * metrics.networkShare + 0.2 * surfaceFit;
  metrics.score = 0.6 * metrics.safety + 0.4 * metrics.fun;
  return metrics;
}

// Route one loop, rescaling it until its length is within `tolerance` of the target.
export async function buildLoop({ start, targetM, heading, bike, fetchImpl, tolerance = 0.07, maxTries = 4 }) {
  const { profile } = BIKE_PROFILES[bike];
  let scale = 1;
  let best = null;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const waypoints = loopWaypoints(start, targetM, heading, 3, scale);
    const route = await fetchRoute(waypoints, profile, fetchImpl);
    const error = Math.abs(route.lengthM - targetM) / targetM;
    if (!best || error < best.error) best = { ...route, waypoints, heading, error };
    if (error <= tolerance) break;
    scale *= targetM / route.lengthM;
  }
  return { ...best, metrics: scoreRoute(best, bike) };
}

// Try loops leaving in different directions and return them best first.
export async function findLoops({ start, targetM, bike, directions = 6, fetchImpl = fetch, onProgress = () => {} }) {
  const offset = Math.random() * 360;
  const headings = Array.from({ length: directions }, (_, i) => (offset + (360 / directions) * i) % 360);
  const results = [];
  let done = 0;
  // Two at a time: brouter.de is a free community server.
  const queue = [...headings];
  const worker = async () => {
    while (queue.length) {
      const heading = queue.shift();
      try {
        results.push(await buildLoop({ start, targetM, heading, bike, fetchImpl }));
      } catch (err) {
        console.warn('Loop failed', heading, err);
      }
      onProgress(++done, directions);
    }
  };
  await Promise.all([worker(), worker()]);
  return results.sort((a, b) => b.metrics.score - a.metrics.score);
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

// Split the track into runs that share a safety level, for colouring the map.
export function safetyRuns(route) {
  const runs = [];
  let seg = 0;
  let current = null;
  for (const [lat, lon] of route.coords) {
    const s = route.segments[Math.min(seg, route.segments.length - 1)];
    const safety = s ? safetyOf(s.tags) : 1;
    const level = safety >= 0.8 ? 'safe' : safety >= 0.5 ? 'ok' : 'busy';
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
