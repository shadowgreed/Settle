// All Watchmode requests route through /api/watchmode — a Vercel serverless proxy
// that injects the API key server-side. The key is never in the JS bundle.
const WATCHMODE_BASE_URL = '/api/watchmode';
const CACHE_KEY_PREFIX = 'wm_';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Try multiple name variants — Max rebranded from HBO Max, Watchmode may use either
const SERVICE_NAME_VARIANTS = {
  'Disney+':   ['Disney+'],
  'Max':       ['Max', 'HBO Max', 'Max Amazon Channel'],
  'Apple TV':  ['Apple TV Plus', 'Apple TV+', 'Apple TV'],
};

// Direct URL fallbacks if Watchmode returns nothing
const DIRECT_FALLBACKS = {
  'Max':       (title) => `https://www.max.com/search?q=${encodeURIComponent(title)}`,
  'Apple TV':  (title) => `https://tv.apple.com/search?term=${encodeURIComponent(title)}`,
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
        `${WATCHMODE_BASE_URL}/search/?search_field=${tmdbField}&search_value=${tmdbId}`
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
        `${WATCHMODE_BASE_URL}/title/${watchmodeId}/sources/?regions=US`
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

  // Public — return direct web_url for a given service, or fallback URL, or null
  async getServiceUrl(tmdbId, type, service, title = '') {
    const variants = SERVICE_NAME_VARIANTS[service];
    if (!variants) return null;

    const watchmodeId = await this._resolveWatchmodeId(tmdbId, type);

    if (watchmodeId) {
      const sources = await this._fetchSources(watchmodeId);
      // Log available source names in dev so we can verify exact naming
      if (process.env.NODE_ENV === 'development') {
        console.log(`[Watchmode] Sources for ${title}:`, sources.map(s => s.name));
      }
      // Try each name variant for the service
      for (const name of variants) {
        const match = sources.find(s => s.name === name);
        if (match?.web_url) return match.web_url;
      }
    }

    // Fallback — use direct search URL if Watchmode didn't return a match
    const fallback = DIRECT_FALLBACKS[service];
    return fallback ? fallback(title) : null;
  }
}

const watchmodeService = new WatchmodeService();
export default watchmodeService;
