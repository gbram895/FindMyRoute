# FindMyRoute

Choose a start point and how far you want to ride, and FindMyRoute suggests
cycling loops of that length on safe, quiet roads.

## How it works

1. Pick a start point (click the map, search a place or use your location), a
   distance and your bike type.
2. The app draws loops heading off in 6 directions and routes each one with
   [BRouter](https://brouter.de) on OpenStreetMap data. It uses its own routing
   profiles in `profiles/`, based on BRouter's `fastbike-verylowtraffic` (road)
   and `gravel` profiles, tuned to stay away from:
   - main roads (N-roads and other tertiary, secondary and primary roads);
   - one-way cycle paths, which nearly always run right beside a main road;
   - road noise (BRouter's estimate of how close you are to busy traffic).
   Around Westerlo this cut the share of each loop on or beside main roads from
   43–59% to 3–16% for road bikes and to 1–6% for gravel.
3. Each loop is resized until its length is within about 7% of the distance you
   asked for. Out-and-back detours to a turning point are cut out, and if a loop
   still rides stretches twice, its shape is turned a little (±25°) and the
   version that doubles back least is kept. In tests around Westerlo, Herentals
   and Mechelen no loop rode more than 5% of its distance twice.
4. Each loop is scored:
   - **Quiet**: how much of it is on quiet roads and traffic-free paths rather
     than on or beside main roads.
   - **Fun**: little doubling back, signed cycle routes (such as the Belgian
     *fietsknooppunten*), the right surface for your bike and, when Strava is
     connected, your favourite roads (or roads you have never ridden).
5. The loops are listed best first. The map colours each route green (quiet),
   orange (beside a main road) or red (in traffic). Any loop can be downloaded
   as a GPX file.

## Connecting Strava

Connecting Strava lets the app learn which roads you actually ride:

- **Roads I ride** moves each loop's turning points onto roads you ride often,
  and ranks loops by how much of them you already know.
- **Discover new** ranks loops on roads you have never ridden higher.
- Your outdoor rides are drawn on the map (indoor and virtual rides are skipped).

Strava requires every app to use API keys from a Strava API app. Strava gives
each account one API app, so if you already made one for another project, reuse it:

1. Open https://www.strava.com/settings/api and copy the Client ID and Client Secret.
2. Check **Authorization Callback Domain**:
   - Running FindMyRoute on your computer (`localhost`)? Nothing to change:
     Strava always accepts `localhost`.
   - Using it on GitHub Pages? The domain must be `gbram895.github.io`. If your
     other project also runs on `gbram895.github.io`, it already is, and both
     keep working. If the other project uses a different domain, the two can't
     share the app online: run FindMyRoute on `localhost` instead.
3. In FindMyRoute, open **Connect Strava**, paste the Client ID and Client
   Secret, and approve access.

The keys, login tokens and downloaded rides are stored only in your browser
(localStorage). Nothing is sent anywhere except Strava itself.

## Running it

It's a static site with no build step and no API keys:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

It can also be hosted on GitHub Pages.

## Files

- `js/loop.js`: loop geometry, BRouter calls, quiet and fun scoring, GPX export.
- `js/familiar.js`: grid of the roads in your Strava rides, used for snapping and scoring.
- `js/strava.js`: Strava login and ride download, in the browser.
- `js/app.js`: map and user interface (Leaflet).
- `profiles/`: the custom BRouter routing profiles.
- `tests/`: unit tests, run with `npm test` (Node 20 or newer).
