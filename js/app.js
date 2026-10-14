import { BIKE_PROFILES, createProfileStore, findLoops, safetyRuns, toGpx } from './loop.js';
import { buildGrid, decodePolyline } from './familiar.js';
import * as strava from './strava.js';

const COLORS = { safe: '#1a9850', ok: '#f0a202', busy: '#d73027', rides: '#7b3fe4' };
const $ = (id) => document.getElementById(id);

const map = L.map('map', { preferCanvas: true }).setView([51.0885, 4.9145], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors · routing by BRouter',
}).addTo(map);

const profiles = createProfileStore((file) => fetch(file).then((r) => r.text()));

let start = null;
let startMarker = null;
let routeLayer = null;
let ridesLayer = null;
let grid = null;
let loops = [];

function setStart(latlng, label) {
  start = [latlng.lat, latlng.lng];
  if (startMarker) startMarker.setLatLng(latlng);
  else startMarker = L.marker(latlng, { draggable: true }).addTo(map).on('dragend', (e) => setStart(e.target.getLatLng()));
  $('start-label').textContent = label || `${start[0].toFixed(4)}, ${start[1].toFixed(4)}`;
  $('go').disabled = false;
}

map.on('click', (e) => setStart(e.latlng));

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Your browser cannot share its location.');
  setStatus('Finding you…');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const latlng = L.latLng(coords.latitude, coords.longitude);
      setStart(latlng, 'Your location');
      map.setView(latlng, 12);
      setStatus('');
    },
    () => setStatus('Could not get your location. Click the map instead.'),
  );
});

$('search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = e.target.value.trim();
  if (!q) return;
  setStatus('Searching…');
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const [hit] = await res.json();
    if (!hit) return setStatus(`Nothing found for “${q}”.`);
    const latlng = L.latLng(Number(hit.lat), Number(hit.lon));
    setStart(latlng, hit.display_name.split(',').slice(0, 2).join(','));
    map.setView(latlng, 12);
    setStatus('');
  } catch {
    setStatus('Search failed. Click the map instead.');
  }
});

$('distance').addEventListener('input', (e) => ($('distance-out').textContent = e.target.value));

$('plan').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!start) return;
  const form = new FormData(e.target);
  const targetM = Number($('distance').value) * 1000;
  const bike = form.get('bike');
  const roads = grid ? form.get('roads') : null;
  $('go').disabled = true;
  $('results').replaceChildren();
  clearRoute();
  setStatus('Trying loops in every direction…');
  try {
    loops = await findLoops({
      start,
      targetM,
      bike,
      profiles,
      grid,
      roads,
      onProgress: (done, total) => setStatus(`Routing loops… ${done}/${total}`),
    });
    if (!loops.length) setStatus('No routes found here. Try another start point or distance.');
    else {
      setStatus(`${loops.length} ${BIKE_PROFILES[bike].label.toLowerCase()} loops, quietest and most fun first.`);
      renderResults();
      showRoute(0);
    }
  } catch (err) {
    setStatus(`Routing failed: ${err.message}`);
  } finally {
    $('go').disabled = false;
  }
});

const pct = (x) => `${Math.round(x * 100)}%`;
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

function renderResults() {
  $('results').replaceChildren(
    ...loops.map((loop, i) => {
      const m = loop.metrics;
      const details = [
        `${pct(m.mainRoadShare)} along main roads`,
        `${pct(m.networkShare)} on signed cycle routes`,
        `${pct(m.unpavedShare)} unpaved`,
      ];
      if (m.familiar !== null) details.unshift(`${pct(m.familiar)} on roads you've ridden`);
      if (m.overlap > 0.05) details.push(`${pct(m.overlap)} ridden twice`);
      const li = document.createElement('li');
      li.className = 'result';
      li.tabIndex = 0;
      li.innerHTML = `
        <div class="result-head">
          <strong>${(loop.lengthM / 1000).toFixed(1)} km</strong>
          <span class="result-meta">heads ${compass(loop.heading)} · ↑${loop.ascendM} m · ~${Math.round(loop.timeS / 60)} min</span>
        </div>
        <div class="bars">
          <span>Quiet</span><span class="bar"><i style="width:${pct(m.safety)}"></i></span><span>${pct(m.safety)}</span>
          <span>Fun</span><span class="bar"><i style="width:${pct(m.fun)}"></i></span><span>${pct(m.fun)}</span>
        </div>
        <div class="result-meta">${details.join(' · ')}</div>
        <div class="result-actions"><button type="button" data-gpx>Download GPX</button></div>`;
      li.addEventListener('click', () => showRoute(i));
      li.addEventListener('keydown', (ev) => ev.key === 'Enter' && showRoute(i));
      li.querySelector('[data-gpx]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        downloadGpx(loop, i);
      });
      return li;
    }),
  );
}

function showRoute(i) {
  clearRoute();
  routeLayer = L.featureGroup(
    safetyRuns(loops[i]).map((run) => L.polyline(run.coords, { color: COLORS[run.level], weight: 5, opacity: 0.9 })),
  ).addTo(map);
  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
  [...$('results').children].forEach((li, j) => li.classList.toggle('selected', i === j));
}

function clearRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = null;
}

function downloadGpx(loop, i) {
  const name = `FindMyRoute ${(loop.lengthM / 1000).toFixed(0)} km #${i + 1}`;
  const url = URL.createObjectURL(new Blob([toGpx(loop, name)], { type: 'application/gpx+xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name.replace(/\W+/g, '-')}.gpx` });
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(text) {
  $('status').textContent = text;
}

// --- Strava -------------------------------------------------------------

$('callback-domain').textContent = location.hostname;
// Strava always accepts localhost, whatever callback domain the app has.
if (['localhost', '127.0.0.1'].includes(location.hostname)) $('callback-step').hidden = true;
const app = strava.getApp();
if (app) $('client-id').value = app.clientId;

$('strava-form').addEventListener('submit', (e) => {
  e.preventDefault();
  strava.startConnect($('client-id').value, $('client-secret').value);
});

$('sync').addEventListener('click', () => syncStrava());

$('disconnect').addEventListener('click', () => {
  strava.disconnect();
  loadRides();
});

$('show-rides').addEventListener('change', () => drawRides());

async function syncStrava() {
  $('sync').disabled = true;
  $('strava-summary').textContent = 'Downloading your rides from Strava…';
  try {
    await strava.syncRides((n) => ($('strava-summary').textContent = `Downloading your rides… ${n} so far`));
    loadRides();
  } catch (err) {
    loadRides();
    $('strava-summary').textContent = err.message;
  } finally {
    $('sync').disabled = false;
  }
}

function loadRides() {
  const connected = strava.isConnected();
  const rides = connected ? strava.getRides() : [];
  $('strava-off').hidden = connected;
  $('strava-on').hidden = !connected;
  $('roads-field').hidden = !rides.length;
  $('legend-rides').hidden = !rides.length;
  const lines = rides.map((r) => decodePolyline(r.polyline));
  grid = lines.length ? buildGrid(lines) : null;
  ridesLayer = lines.length
    ? L.featureGroup(lines.map((pts) => L.polyline(pts, { color: COLORS.rides, weight: 3, opacity: 0.45, interactive: false })))
    : null;
  drawRides();
  if (connected) {
    const newest = rides.reduce((d, r) => (r.date > d ? r.date : d), '');
    $('strava-summary').textContent = rides.length
      ? `${rides.length} outdoor ride${rides.length === 1 ? '' : 's'} loaded${newest ? `, newest ${newest.slice(0, 10)}` : ''}.`
      : 'Connected. No outdoor rides with GPS found yet.';
  }
}

let drawnRides = null;
function drawRides() {
  if (drawnRides) map.removeLayer(drawnRides);
  drawnRides = $('show-rides').checked && ridesLayer ? ridesLayer.addTo(map) : null;
  if (drawnRides) drawnRides.bringToBack();
}

(async () => {
  try {
    if (await strava.handleRedirect()) {
      loadRides();
      await syncStrava();
      if (ridesLayer) map.fitBounds(ridesLayer.getBounds());
      return;
    }
  } catch (err) {
    $('strava-setup').open = true;
    setStatus(err.message);
  }
  loadRides();
})();
