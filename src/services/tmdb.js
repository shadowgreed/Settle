import axios from 'axios';

// All TMDB requests route through /api/tmdb — a Vercel serverless proxy that
// injects the API key server-side. The key is never compiled into the JS bundle.
const TMDB_BASE_URL = '/api/tmdb';

// Streaming provider IDs (TMDB Watch Provider IDs for US region)
const PROVIDER_IDS = {
  'Netflix':      8,
  'Max':          1899,
  'Disney+':      337,
  'Apple TV':     350,
  'Prime Video':  9,      // Amazon Prime Video (US)
};

// Cache for API results to avoid duplicate calls
const cache = new Map();
const CACHE_DURATION = 1000 * 60 * 30; // 30 minutes

class TMDBService {
  constructor() {
    // No api_key param here — the proxy adds it server-side.
    // Request interceptor converts the URL path into a `_p` query param so
    // all calls go to /api/tmdb?_p=<endpoint> — avoids Vercel catch-all routing.
    this.api = axios.create({ baseURL: TMDB_BASE_URL });
    this.api.interceptors.request.use(config => {
      const path = (config.url || '').replace(/^\//, '');
      if (path) {
        config.url = '';
        config.params = { _p: path, ...config.params };
      }
      return config;
    });
  }

  // Get cached data or fetch new
  async getCached(key, fetchFn) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }
    const data = await fetchFn();
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  // Discover content by streaming service and filters
  async discoverContent({ service, type = 'movie', genre = null, keywords = null, minRating = 0, hiddenGems = false, maxCertification = null, maxRuntime = null }) {
    const cacheKey = `discover-${service}-${type}-${genre}-${keywords}-${minRating}-${hiddenGems}-${maxCertification}-${maxRuntime}`;

    return this.getCached(cacheKey, async () => {
      const providerId = PROVIDER_IDS[service];
      if (!providerId) throw new Error(`Unknown service: ${service}`);

      const params = hiddenGems
        ? {
            with_watch_providers: providerId,
            watch_region: 'US',
            sort_by: 'vote_average.desc',
            'vote_average.gte': 7.5,
            'vote_count.gte': 300,
            'popularity.lte': 50
          }
        : {
            with_watch_providers: providerId,
            watch_region: 'US',
            sort_by: 'popularity.desc',
            'vote_average.gte': minRating,
            'vote_count.gte': 100
          };

      if (genre) params.with_genres = genre;
      if (keywords) params.with_keywords = keywords;
      // Certification filter applies to movies only (TV uses a separate rating system)
      if (maxCertification && type === 'movie') {
        params.certification_country = 'US';
        params['certification.lte'] = maxCertification;
      }
      // Runtime filter applies to movies only
      if (maxRuntime && type === 'movie') {
        params['with_runtime.lte'] = maxRuntime;
      }

      const endpoint = type === 'movie' ? '/discover/movie' : '/discover/tv';
      // Cap pages at 3 (normal) / 2 (hidden gems).
      // With 5 services × 2 formats the peak concurrent burst is ~30 requests —
      // safely under TMDB's 40 req/10s limit even when genres are selected.
      // 3 pages × 20 results = 60 results per query, more than enough for the picker.
      const maxPages = hiddenGems ? 2 : 3;
      const firstPage = await this.api.get(endpoint, { params: { ...params, page: 1 } });
      const totalPages = Math.min(firstPage.data.total_pages, maxPages);

      // Page 1 is already fetched — collect remaining pages in a small parallel batch
      const remainingNums = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2);
      const remainingPages = await Promise.allSettled(
        remainingNums.map(p => this.api.get(endpoint, { params: { ...params, page: p } }))
      );

      const allPages = [
        firstPage,
        ...remainingPages.filter(r => r.status === 'fulfilled').map(r => r.value)
      ];

      return allPages.flatMap(res => res.data.results.map(item => this.normalizeContent(item, type, service)));
    });
  }

  // Get genre list
  async getGenres(type = 'movie') {
    const cacheKey = `genres-${type}`;
    
    return this.getCached(cacheKey, async () => {
      const endpoint = type === 'movie' ? '/genre/movie/list' : '/genre/tv/list';
      const response = await this.api.get(endpoint);
      return response.data.genres;
    });
  }

  // Normalize content format
  normalizeContent(item, type, service) {
    const isMovie = type === 'movie';
    const dateStr = isMovie ? item.release_date : item.first_air_date;
    const year = dateStr ? new Date(dateStr).getFullYear() : null;

    return {
      id: item.id,
      title: isMovie ? item.title : item.name,
      year: Number.isFinite(year) ? year : null,
      releaseDate: dateStr || null,
      rating: parseFloat((item.vote_average || 0).toFixed(1)),
      votes: this.formatVotes(item.vote_count || 0),
      description: item.overview || '',
      genres: item.genre_ids || [],
      posterPath: item.poster_path,
      service: service,
      type: isMovie ? 'Movie' : 'Series',
      popularity: item.popularity || 0
    };
  }

  // Format vote count (e.g., 1234 -> "1.2K")
  formatVotes(count) {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return count.toString();
  }

  // Fetch movies currently playing in US theaters.
  // Uses the dedicated /movie/now_playing endpoint (TMDB-managed list) and applies
  // a 45-day client-side guard to drop anything older than a typical theatrical run.
  // Cache is keyed by calendar date so it auto-invalidates at midnight without
  // requiring a longer TTL — stale listings across days are the main failure mode.
  async getNowPlaying() {
    const dateStr = new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
    const cacheKey = `now-playing-${dateStr}`;
    return this.getCached(cacheKey, async () => {
      const today = new Date();
      // 45 days — covers wide releases + limited expansions without surfacing
      // films that have almost certainly left theaters (90 days was too broad).
      const cutoff = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);

      const first = await this.api.get('/movie/now_playing', {
        params: { language: 'en-US', region: 'US', page: 1 }
      });
      // Cap at 3 pages — US theatrical slate rarely exceeds ~60 active titles.
      const totalPages = Math.min(first.data.total_pages, 3);

      // Page 1 already fetched — collect remaining pages without re-hitting page 1.
      const remainingNums = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2);
      const remaining = await Promise.allSettled(
        remainingNums.map(p => this.api.get('/movie/now_playing', {
          params: { language: 'en-US', region: 'US', page: p }
        }))
      );

      const allPages = [
        first,
        ...remaining.filter(r => r.status === 'fulfilled').map(r => r.value)
      ];

      return allPages.flatMap(res =>
        res.data.results
          .filter(item => {
            const releaseDate = new Date(item.release_date);
            return releaseDate >= cutoff && releaseDate <= today;
          })
          // All items from this endpoint are TMDB-curated as currently playing.
          .map(item => ({ ...this.normalizeContent(item, 'movie', 'In Theaters'), verifiedTheater: true }))
      );
    });
  }

  // Check if a movie belongs to a collection and return full franchise parts
  async getMovieCollection(movieId) {
    const cacheKey = `collection-${movieId}`;
    return this.getCached(cacheKey, async () => {
      const movieRes = await this.api.get(`/movie/${movieId}`);
      const collectionInfo = movieRes.data.belongs_to_collection;
      if (!collectionInfo) return null;

      const colRes = await this.api.get(`/collection/${collectionInfo.id}`);
      const parts = colRes.data.parts
        .map(p => ({ id: p.id, title: p.title, year: p.release_date ? new Date(p.release_date).getFullYear() : null }))
        .filter(p => p.year)
        .sort((a, b) => a.year - b.year);

      return { name: colRes.data.name, parts };
    });
  }

  // Theater mode with certification filter (family-friendly path).
  // Uses /discover/movie with theatrical release types so TMDB-side cert filtering works
  // (the /movie/now_playing endpoint doesn't support certification params).
  // Date window mirrors getNowPlaying: 45 days.
  // Cross-references the curated /movie/now_playing list to tag verifiedTheater items —
  // discover results confirmed by TMDB's own list are weighted higher in the picker.
  async getNowPlayingWithOptions({ maxCertification = null } = {}) {
    const dateStr = new Date().toISOString().split('T')[0];
    const cacheKey = `now-playing-opts-${dateStr}-${maxCertification}`;
    return this.getCached(cacheKey, async () => {
      const today = new Date();
      const cutoff = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);

      const params = {
        with_release_type: '2|3',   // 2 = limited theatrical, 3 = theatrical
        region: 'US',
        'primary_release_date.gte': cutoff.toISOString().split('T')[0],
        'primary_release_date.lte': today.toISOString().split('T')[0],
        sort_by: 'popularity.desc',
        'vote_count.gte': 10,       // low floor — new releases accumulate votes slowly
      };

      if (maxCertification) {
        params.certification_country = 'US';
        params['certification.lte'] = maxCertification;
      }

      // Fetch discover pages and TMDB's curated now_playing list in parallel.
      // The now_playing IDs are used to tag verifiedTheater — items on both lists
      // are more confidently still screening and get a weight boost in the picker.
      const [first, npCheck] = await Promise.allSettled([
        this.api.get('/discover/movie', { params: { ...params, page: 1 } }),
        this.api.get('/movie/now_playing', { params: { language: 'en-US', region: 'US', page: 1 } }),
      ]);

      if (first.status === 'rejected') throw first.reason;

      const verifiedIds = new Set(
        npCheck.status === 'fulfilled'
          ? npCheck.value.data.results.map(m => m.id)
          : []
      );

      // 3 pages is plenty for a filtered 45-day US theatrical window
      const totalPages = Math.min(first.value.data.total_pages, 3);
      const remainingNums = Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => i + 2);
      const remaining = await Promise.allSettled(
        remainingNums.map(p => this.api.get('/discover/movie', { params: { ...params, page: p } }))
      );

      const allPages = [
        first.value,
        ...remaining.filter(r => r.status === 'fulfilled').map(r => r.value)
      ];
      return allPages.flatMap(res =>
        res.data.results.map(item => ({
          ...this.normalizeContent(item, 'movie', 'In Theaters'),
          verifiedTheater: verifiedIds.has(item.id),
        }))
      );
    });
  }

  // Fetch US certification (G/PG/PG-13/R) and wide-vs-limited release type for a movie.
  // Used to enrich the theater result card without bloating the main catalog fetch.
  async getMovieReleaseInfo(movieId) {
    const cacheKey = `release-info-${movieId}`;
    return this.getCached(cacheKey, async () => {
      const res = await this.api.get(`/movie/${movieId}/release_dates`);
      const usEntry = res.data.results?.find(r => r.iso_3166_1 === 'US');
      if (!usEntry?.release_dates?.length) return null;

      // type 3 = theatrical (wide), type 2 = limited theatrical
      const theatricals = usEntry.release_dates.filter(r => r.type === 3 || r.type === 2);
      const wide    = theatricals.find(r => r.type === 3);
      const limited = theatricals.find(r => r.type === 2);
      const best    = wide || limited;

      // Prefer cert from the theatrical entry; fall back to any cert on record.
      const certification = best?.certification ||
        usEntry.release_dates.find(r => r.certification)?.certification || null;

      return {
        certification: certification || null,
        isWideRelease: !!wide,
      };
    });
  }

  // Get poster URL
  getPosterUrl(path, size = 'w342') {
    if (!path) return null;
    return `https://image.tmdb.org/t/p/${size}${path}`;
  }
}

const tmdbService = new TMDBService();
export default tmdbService;
