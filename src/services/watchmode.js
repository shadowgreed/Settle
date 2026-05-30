// All Watchmode requests route through /api/watchmode — a Vercel serverless proxy
// that injects the API key server-side. The key is never in the JS bundle.
import { authHeader } from './authHeader';

const WATCHMODE_BASE_URL = '/api/watchmode';
const CACHE_KEY_PREFIX = 'wm_';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Map each of the app's services to the name(s) Watchmode uses for it. We try
// each variant because providers rebrand (HBO Max → Max) and ship ad tiers that
// Watchmode lists under slightly different names. All variants point at the same
// title page, so any match gives the correct direct deep link (web_url).
const SERVICE_NAME_VARIANTS = {
  'Netflix':     ['Netflix', 'Netflix basic with Ads', 'Netflix Standard with Ads'],
  'Disney+':     ['Disney+'],
  'Max':         ['Max', 'HBO Max', 'Max Amazon Channel'],
  'Apple TV':    ['Apple TV+', 'Apple TV Plus', 'Apple TV'],
  'Prime Video': ['Amazon Prime Video', 'Amazon Prime Video with Ads', 'Prime Video'],
};

class WatchmodeService {
  _getCached(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return undefined;
      const { data, timestamp } = JSON.parse(raw);
      if (Date.now() - timestamp < CACHE_DURATION) return data;
      localStorage.removeItem(key);
    } catch {}
    return undefined;
  }

  _setCache(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {}
  }

  // Step 1 — resolve TMDB ID → Watchmode title ID
  async _resolveWatchmodeId(tmdbId, type) {
    const tmdbField = type === 'Movie' ? 'tmdb_movie_id' : 'tmdb_tv_id';
    const cacheKey = `${CACHE_KEY_PREFIX}id_${type}_${tmdbId}`;

    const cached = this._getCached(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const res = await fetch(
        `${WATCHMODE_BASE_URL}?_p=search&search_field=${tmdbField}&search_value=${tmdbId}`,
        { headers: await authHeader() }
      );
      if (!res.ok) { this._setCache(cacheKey, null); return null; }
      const json = await res.json();
      const id = json?.title_results?.[0]?.id || null;
      this._setCache(cacheKey, id);
      return id;
    } catch (err) {
      console.error('Watchmode ID lookup error:', err);
      return null;
    }
  }

  // Step 2 — fetch sources for a Watchmode title ID
  async _fetchSources(watchmodeId) {
    const cacheKey = `${CACHE_KEY_PREFIX}src_${watchmodeId}`;

    const cached = this._getCached(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const res = await fetch(
        `${WATCHMODE_BASE_URL}?_p=title/${watchmodeId}/sources&regions=US`,
        { headers: await authHeader() }
      );
      if (!res.ok) { this._setCache(cacheKey, []); return []; }
      const sources = await res.json();
      const sub = Array.isArray(sources)
        ? sources.filter(s => s.type === 'sub' || s.type === 'free')
        : [];
      this._setCache(cacheKey, sub);
      return sub;
    } catch (err) {
      console.error('Watchmode sources error:', err);
      return [];
    }
  }

  // Public — return the DIRECT title deep link (web_url) for the given service,
  // or null if Watchmode has no direct URL. The caller falls back to a platform
  // search page only when this returns null, so the search URL is a true
  // last resort rather than the default.
  async getServiceUrl(tmdbId, type, service, title = '') {
    const variants = SERVICE_NAME_VARIANTS[service];
    if (!variants) return null;

    const watchmodeId = await this._resolveWatchmodeId(tmdbId, type);
    if (!watchmodeId) return null;

    const sources = await this._fetchSources(watchmodeId);
    if (process.env.NODE_ENV === 'development') {
      console.log(`[Watchmode] Sources for ${title}:`, sources.map(s => `${s.name} (${s.type})`));
    }
    // First sub/free source matching the selected service that has a web_url.
    for (const name of variants) {
      const match = sources.find(s => s.name === name && s.web_url);
      if (match) return match.web_url;
    }
    return null;
  }
}

const watchmodeService = new WatchmodeService();
export default watchmodeService;
