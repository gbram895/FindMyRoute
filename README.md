# FindMyRoute

Choose a start point and how far you want to ride, and FindMyRoute suggests
cycling loops of that length on safe, quiet roads.

## How it works

1. Pick a start point (click the map, search a place or use your location), a
   distance and your bike type.
2. The app draws loops heading off in 6 directions and routes each one with
   [BRouter](https://brouter.de) on OpenStreetMap data, using a low-traffic
   bike profile:
   - Road: `fastbike-verylowtraffic`
   - Gravel: `gravel`
   - City / touring: `safety`
3. Each loop is resized until its length is within about 7% of the distance you asked for.
4. Each loop is scored:
   - **Safety**: how much of the distance is on bike paths, cycle streets, quiet
     roads or roads with a separate cycle track, compared with busy main roads.
   - **Fun**: little doubling back, a large share on signed cycle routes (such
     as the Belgian *fietsknooppunten*) and the right surface for your bike.
5. The loops are listed best first. The map colours each route green (bike
   path or quiet road), orange (some traffic) or red (busy road). Any loop can
   be downloaded as a GPX file for Garmin, Wahoo, Strava, Komoot and similar apps.

## Running it

It's a static site with no build step and no API keys:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It can also be hosted on GitHub Pages.

## Files

- `js/loop.js`: loop geometry, BRouter calls, safety and fun scoring, GPX export
  (no DOM, so it also runs in Node).
- `js/app.js`: map and user interface (Leaflet).
