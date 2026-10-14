// Strava connection, entirely in the browser. The athlete registers their own
// Strava API app; its keys, the tokens and the downloaded rides are kept in this
// browser's localStorage only.

const APP_KEY = 'fmr.strava.app';
const TOKEN_KEY = 'fmr.strava.tokens';
const RIDES_KEY = 'fmr.strava.rides';
const OAUTH_STATE = 'findmyroute';
const RIDE_TYPES = new Set(['Ride', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'EMountainBikeRide']);

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not save', key, err);
  }
}

const redirectUri = () => location.origin + location.pathname;

export const getApp = () => read(APP_KEY);
export const isConnected = () => Boolean(read(TOKEN_KEY));
export const getRides = () => read(RIDES_KEY)?.rides || [];

export function startConnect(clientId, clientSecret) {
  write(APP_KEY, { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() });
  const params = new URLSearchParams({
    client_id: String(clientId).trim(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    approval_prompt: 'auto',
    scope: 'activity:read_all',
    state: OAUTH_STATE,
  });
  location.assign(`https://www.strava.com/oauth/authorize?${params}`);
}

// Finishes the OAuth flow when Strava sends the athlete back with ?code=…
// Returns true when it connected, false when there was nothing to do.
export async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  if (params.get('state') !== OAUTH_STATE) return false;
  history.replaceState(null, '', redirectUri());
  if (params.get('error')) throw new Error('Strava access was not granted.');
  if (!params.get('scope')?.includes('activity:read')) throw new Error('Please allow FindMyRoute to read your activities.');
  await requestToken({ grant_type: 'authorization_code', code: params.get('code') });
  return true;
}

async function requestToken(grant) {
  const app = getApp();
  if (!app) throw new Error('Strava app keys are missing.');
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...grant }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('Strava refused the login. Check the Client ID and Client Secret, then connect again.');
  write(TOKEN_KEY, { access: body.access_token, refresh: body.refresh_token, expiresAt: body.expires_at });
}

async function accessToken() {
  const tokens = read(TOKEN_KEY);
  if (!tokens) throw new Error('Not connected to Strava.');
  if (tokens.expiresAt * 1000 < Date.now() + 60000) {
    await requestToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
    return read(TOKEN_KEY).access;
  }
  return tokens.access;
}

// Downloads outdoor rides added since the last sync. Returns the total ride count.
export async function syncRides(onProgress = () => {}) {
  const stored = read(RIDES_KEY) || { rides: [], latest: 0 };
  const known = new Set(stored.rides.map((r) => r.id));
  let latest = stored.latest;
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({ per_page: '200', page: String(page), after: String(stored.latest) });
    const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?${params}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (res.status === 429) throw new Error('Strava rate limit reached. Try again in 15 minutes.');
    if (!res.ok) throw new Error(`Strava sync failed (${res.status}).`);
    const activities = await res.json();
    if (!activities.length) break;
    for (const a of activities) {
      latest = Math.max(latest, Math.floor(Date.parse(a.start_date) / 1000));
      const sport = a.sport_type || a.type;
      if (!RIDE_TYPES.has(sport) || a.trainer || !a.map?.summary_polyline || known.has(a.id)) continue;
      known.add(a.id);
      stored.rides.push({ id: a.id, date: a.start_date_local, sport, polyline: a.map.summary_polyline });
    }
    onProgress(stored.rides.length);
  }
  stored.latest = latest;
  write(RIDES_KEY, stored);
  return stored.rides.length;
}

export function disconnect() {
  write(TOKEN_KEY, null);
  write(RIDES_KEY, null);
}
