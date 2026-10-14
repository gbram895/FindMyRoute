import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { haversine, destinationPoint } from '../js/geo.js';
import { buildGrid, decodePolyline, familiarShare, snapToRidden } from '../js/familiar.js';
import { createProfileStore, loopWaypoints, safetyOf, scoreRoute, toGpx } from '../js/loop.js';

const START = [51.0885, 4.9145];

test('decodes Google encoded polylines', () => {
  // Example from Google's polyline documentation.
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
});

test('loop waypoints start and end at home and roughly match the distance', () => {
  const wp = loopWaypoints(START, 40000, 90);
  assert.deepEqual(wp[0], START);
  assert.deepEqual(wp.at(-1), START);
  let crowFlies = 0;
  for (let i = 1; i < wp.length; i++) crowFlies += haversine(wp[i - 1], wp[i]);
  assert.ok(crowFlies > 25000 && crowFlies < 40000, `straight-line loop is ${crowFlies} m`);
});

test('quiet roads score higher than main roads and their sidepaths', () => {
  const quiet = safetyOf({ highway: 'residential' });
  const freePath = safetyOf({ highway: 'cycleway' });
  const sidepath = safetyOf({ highway: 'cycleway', oneway: 'yes' });
  const tertiaryTrack = safetyOf({ highway: 'tertiary', 'cycleway:right': 'track' });
  const secondary = safetyOf({ highway: 'secondary' });
  assert.ok(freePath >= quiet && quiet > sidepath);
  assert.ok(sidepath >= tertiaryTrack && tertiaryTrack > secondary);
});

test('familiar roads: share and waypoint snapping follow the ridden line', () => {
  // A ride going 5 km due east of the start.
  const ride = [START, destinationPoint(START, 90, 5000)];
  const grid = buildGrid([ride]);
  assert.ok(familiarShare(grid, ride) > 0.99);
  const elsewhere = [destinationPoint(START, 0, 3000), destinationPoint(START, 0, 6000)];
  assert.equal(familiarShare(grid, elsewhere), 0);

  const offRoad = destinationPoint(destinationPoint(START, 90, 2500), 0, 800);
  const snapped = snapToRidden(grid, offRoad, 1500);
  assert.ok(haversine(snapped, destinationPoint(START, 90, 2500)) < 600, 'snaps onto the ride');
  assert.deepEqual(snapToRidden(grid, offRoad, 300), offRoad, 'leaves far-away points alone');
});

test('scoring rewards familiar roads only when asked', () => {
  const coords = [START, destinationPoint(START, 90, 5000)];
  const route = { coords, segments: [{ distance: 5000, tags: { highway: 'residential' } }] };
  const grid = buildGrid([coords]);
  const mine = scoreRoute(route, 'road', grid, 'mine');
  const fresh = scoreRoute(route, 'road', grid, 'new');
  assert.ok(mine.familiar > 0.99);
  assert.ok(mine.fun > fresh.fun);
  assert.equal(scoreRoute(route, 'road').familiar, null);
});

test('profile store uploads each profile once and can re-upload', async () => {
  let uploads = 0;
  const fakeFetch = async () => ({ json: async () => ({ profileid: `custom_${++uploads}` }) });
  const store = createProfileStore((file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8'), fakeFetch);
  assert.equal(await store.get('road'), 'custom_1');
  assert.equal(await store.get('road'), 'custom_1');
  store.forget('road');
  assert.equal(await store.get('road'), 'custom_2');
});

test('GPX export contains every point', () => {
  const gpx = toGpx({ coords: [[51, 4, 10], [51.001, 4.001, null]] }, 'A & B');
  assert.match(gpx, /<name>A &amp; B<\/name>/);
  assert.equal(gpx.match(/<trkpt /g).length, 2);
});
