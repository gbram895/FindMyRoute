import { BIKE_PROFILES, findLoops, safetyRuns, toGpx } from './loop.js';

const COLORS = { safe: '#1a9850', ok: '#f0a202', busy: '#d73027' };
const $ = (id) => document.getElementById(id);

const map = L.map('map').setView([51.0885, 4.9145], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors · routing by BRouter',
}).addTo(map);

let start = null;
let startMarker = null;
let routeLayer = null;
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
  const targetM = Number($('distance').value) * 1000;
  const bike = new FormData(e.target).get('bike');
  $('go').disabled = true;
  $('results').replaceChildren();
  clearRoute();
  setStatus('Trying loops in every direction…');
  try {
    loops = await findLoops({
      start,
      targetM,
      bike,
      onProgress: (done, total) => setStatus(`Routing loops… ${done}/${total}`),
    });
    if (!loops.length) setStatus('No routes found here. Try another start point or distance.');
    else {
      setStatus(`${loops.length} loops for ${BIKE_PROFILES[bike].label.toLowerCase()}, safest and most fun first.`);
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
      const li = document.createElement('li');
      li.className = 'result';
      li.tabIndex = 0;
      li.innerHTML = `
        <div class="result-head">
          <strong>${(loop.lengthM / 1000).toFixed(1)} km</strong>
          <span class="result-meta">heads ${compass(loop.heading)} · ↑${loop.ascendM} m · ~${Math.round(loop.timeS / 60)} min</span>
        </div>
        <div class="bars">
          <span>Safety</span><span class="bar"><i style="width:${pct(m.safety)}"></i></span><span>${pct(m.safety)}</span>
          <span>Fun</span><span class="bar"><i style="width:${pct(m.fun)}"></i></span><span>${pct(m.fun)}</span>
        </div>
        <div class="result-meta">${pct(m.networkShare)} on signed cycle routes · ${pct(m.busyShare)} on busy roads · ${pct(m.unpavedShare)} unpaved${m.overlap > 0.05 ? ` · ${pct(m.overlap)} ridden twice` : ''}</div>
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
