// ─────────────────────────────────────────────────────────────────────────────
// Location service for Theater Mode 2.0.
//
// Lat/long handling — IMPORTANT:
//   • Coordinates are NEVER persisted to any storage (memory only, dropped
//     on page reload). This is a hard privacy contract from the spec.
//   • PostHog analytics capture distance BUCKETS only ('under_5mi', etc),
//     never raw coordinates.
//   • ZIP code (the fallback) is lower-resolution and explicitly typed —
//     persisted to user profile under Firestore.
//
// Permission lifecycle:
//   • First Theater Mode open → prompt once
//   • If declined → ZIP fallback. Re-prompt after 7 days (per spec).
//   • If granted → silently re-use on subsequent sessions until expired.
// ─────────────────────────────────────────────────────────────────────────────

import { authHeader } from './authHeader';

const PERMISSION_STORAGE_KEY = 'settle_location_permission'; // tri-state: 'granted' | 'denied' | null
const PERMISSION_DENIED_AT   = 'settle_location_denied_at'; // ISO timestamp for re-prompt timer
const ZIP_STORAGE_KEY        = 'settle_zip_fallback';       // string, last typed ZIP
const REPROMPT_AFTER_DAYS    = 7;

// In-memory cache for current session. Dropped on reload.
let cachedCoords = null;

/**
 * Returns the user's current coordinates as { lat, lng, accuracy }, or
 * null if permission isn't granted or the platform doesn't support it.
 *
 * Uses sessionStorage NOTHING for the coordinates themselves — just
 * remembers the user's permission decision. The coordinates live in
 * `cachedCoords` for the page's lifetime only.
 *
 * Hard JS-level Promise.race timeout: Safari (especially in PWA standalone
 * mode) has been documented to silently ignore the `timeout` option of
 * `getCurrentPosition`, leaving the promise hanging forever. The manual
 * race below guarantees we always settle within `timeoutMs`.
 */
export async function getCurrentCoords({ forceRefresh = false, timeoutMs = 8000 } = {}) {
  if (cachedCoords && !forceRefresh) return cachedCoords;

  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  const geo = new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        // Spec: accept anything within 10km accuracy; below that, fall
        // back to ZIP. accuracy is in meters.
        const accuracy = pos.coords.accuracy;
        if (accuracy > 10000) {
          resolve(null);
          return;
        }
        cachedCoords = {
          lat:      pos.coords.latitude,
          lng:      pos.coords.longitude,
          accuracy,
        };
        resolve(cachedCoords);
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 5 * 60 * 1000 }
    );
  });

  // Hard backstop — Safari iOS PWA may never invoke either callback.
  const hardTimeout = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs + 500));

  return Promise.race([geo, hardTimeout]);
}

/**
 * Manually invalidate the in-memory coords cache. Called when the user
 * changes location from inside the showtimes sheet — forces the next
 * read to either re-query GPS or fall through to the new ZIP.
 */
export function clearCachedCoords() {
  cachedCoords = null;
}

/**
 * Permission state — 'granted' | 'denied' | null (never asked).
 * Reads from localStorage (our cached decision), not the browser API,
 * because the browser's Permissions API doesn't tell us "declined" in
 * the same way we want to gate re-prompts.
 */
export function getStoredPermissionState() {
  try {
    return localStorage.getItem(PERMISSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * True if the user previously declined and the 7-day re-prompt window
 * has elapsed. Used to decide whether to surface the permission prompt
 * again to a previously-declined user.
 */
export function shouldRepromptAfterDecline() {
  try {
    const deniedAt = localStorage.getItem(PERMISSION_DENIED_AT);
    if (!deniedAt) return false;
    const elapsedMs = Date.now() - new Date(deniedAt).getTime();
    return elapsedMs > REPROMPT_AFTER_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * Records the user's decision. Granted → clear the denial timestamp;
 * denied → stamp it so the 7-day timer can run.
 */
export function recordPermissionDecision(decision) {
  try {
    localStorage.setItem(PERMISSION_STORAGE_KEY, decision);
    if (decision === 'denied') {
      localStorage.setItem(PERMISSION_DENIED_AT, new Date().toISOString());
    } else {
      localStorage.removeItem(PERMISSION_DENIED_AT);
    }
  } catch {}
}

/**
 * ZIP fallback — persisted because it's user-typed and lower resolution
 * than lat/long. Stored in localStorage; cloudSync writes it to Firestore
 * under user profile too (see cloudSync.js prefs.zip).
 */
export function getStoredZip() {
  try {
    return localStorage.getItem(ZIP_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredZip(zip) {
  try {
    if (zip && /^\d{5}$/.test(zip)) {
      localStorage.setItem(ZIP_STORAGE_KEY, zip);
    } else {
      localStorage.removeItem(ZIP_STORAGE_KEY);
    }
  } catch {}
}

/**
 * Resolve a ZIP code to coordinates via the geocoding proxy. Cached in
 * memory for the session — no roundtrip on repeated reads.
 */
const zipCoordsCache = new Map();
export async function zipToCoords(zip) {
  if (!zip || !/^\d{5}$/.test(zip)) return null;
  if (zipCoordsCache.has(zip)) return zipCoordsCache.get(zip);

  try {
    const res = await fetch(`/api/geocode?address=${encodeURIComponent(zip)}`, {
      headers: await authHeader(),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.lat === 'number' && typeof data.lng === 'number') {
      const coords = { lat: data.lat, lng: data.lng };
      zipCoordsCache.set(zip, coords);
      return coords;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns the best available location signal:
 *   1. Cached lat/long from a granted permission (highest res)
 *   2. Geocoded ZIP fallback if user provided one
 *   3. null if neither
 *
 * Callers use the result to rank theaters. If null, theaters render
 * without distance ranking (graceful degradation per spec).
 */
export async function getEffectiveLocation() {
  // Try the high-res path first if permission is granted
  if (getStoredPermissionState() === 'granted') {
    const coords = await getCurrentCoords();
    if (coords) return { ...coords, source: 'gps' };
  }

  // Fall back to ZIP
  const zip = getStoredZip();
  if (zip) {
    const coords = await zipToCoords(zip);
    if (coords) return { ...coords, source: 'zip', zip };
  }

  return null;
}

/**
 * Bucket a raw distance into a PostHog-safe coarse band for analytics.
 * Used by showtime_clicked / showtimes_opened events so we never log
 * raw coordinates indirectly via narrow distance precision.
 */
export function distanceBucket(mi) {
  if (mi == null) return 'unknown';
  if (mi < 5)  return 'under_5mi';
  if (mi < 10) return '5_to_10mi';
  if (mi < 30) return '10_to_30mi';
  return 'over_30mi';
}
