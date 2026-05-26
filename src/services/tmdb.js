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
  async discoverContent({ service, type = 'movie', genre = null, keywords = null, minRating = 0, hiddenGems = false, maxCertification = null, maxPages = null, dateGte = null, dateLte = null }) {
    const cacheKey = `discover-${service}-${type}-${genre}-${keywords}-${minRating}-${hiddenGems}-${maxCertification}-${dateGte}-${dateLte}`;

    return this.getCached(cacheKey, async () => {
      const providerId = PROVIDER_IDS[service];
      if (!providerId) throw new Error(`Unknown service: ${service}`);

      // Catalog tuning (May 2026 optimization pass):
      //   • vote_count.gte lowered (100→50 regular, 300→200 gems) — opens up
      //     deeper-catalog indie / foreign titles that previously sat below
      //     the floor. Popularity sort still buries true noise on its own.
      //   • Page caps bumped (see pageCap below) — doubles/widens the pool
      //     per query at near-zero latency cost because we now fire all
      //     pages in parallel instead of awaiting page 1 first.
      const params = hiddenGems
        ? {
            with_watch_providers: providerId,
            watch_region: 'US',
            sort_by: 'vote_average.desc',
            'vote_average.gte': 7.5,
            'vote_count.gte': 200,
            'popularity.lte': 50
          }
        : {
            with_watch_providers: providerId,
            watch_region: 'US',
            sort_by: 'popularity.desc',
            'vote_average.gte': minRating,
            'vote_count.gte': 50
          };

      if (genre) params.with_genres = genre;
      if (keywords) params.with_keywords = keywords;
      // Certification filter applies to movies only (TV uses a separate rating system)
      if (maxCertification && type === 'movie') {
        params.certification_country = 'US';
        params['certification.lte'] = maxCertification;
      }
      // Runtime filter retired in P2.2 — runtime now displayed on the
      // result card metadata row, not pre-filtered server-side.
      // Decade-mood date range. Movies use primary_release_date, TV uses
      // first_air_date — same logical year filter, different field name.
      if (dateGte || dateLte) {
        const dateField = type === 'tv' ? 'first_air_date' : 'primary_release_date';
        if (dateGte) params[`${dateField}.gte`] = dateGte;
        if (dateLte) params[`${dateField}.lte`] = dateLte;
      }

      const endpoint = type === 'movie' ? '/discover/movie' : '/discover/tv';
      // Page cap priority: explicit caller override > hidden gems (3) >
      // genre-filtered (2 — combined OR query already covers the mood well,
      // 2 pages = 40 titles per service+format) > unfiltered browse (4,
      // widest net for random variety).
      const pageCap = maxPages !== null ? maxPages : hiddenGems ? 3 : genre ? 2 : 4;

      // Fire all pages in parallel from the start. Previously we awaited
      // page 1 to read `total_pages`, then fired remaining pages — two
      // sequential round-trips. Firing 1..pageCap in parallel costs the
      // same wall-time as a single page fetch and lets us raise pageCap
      // without proportionally raising latency. TMDB returns an empty
      // `results` array for over-range pages (no error), so we just keep
      // every fulfilled response and flatten.
      const pageNums  = Array.from({ length: pageCap }, (_, i) => i + 1);
      const responses = await Promise.allSettled(
        pageNums.map(p => this.api.get(endpoint, { params: { ...params, page: p } }))
      );

      return responses
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value.data.results.map(item => this.normalizeContent(item, type, service)));
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

  // Fetch runtime data for the pick card metadata row (P2.2).
  //
  // Movies return `{ runtimeMin: 102 }` — total runtime in minutes.
  // Series return `{ episodes: 8, avgEpisodeMin: 45 }` — episode count and
  // average episode length. TMDB's episode_run_time is an array (some shows
  // vary widely); we use the median so a single 90-min finale doesn't skew.
  //
  // Returns null if the fetch fails — the card just renders without runtime
  // (graceful degradation, no broken layout).
  async getRuntimeInfo(id, type = 'movie') {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const cacheKey = `runtime-${endpoint}-${id}`;
    return this.getCached(cacheKey, async () => {
      try {
        const res = await this.api.get(`/${endpoint}/${id}`);
        if (type === 'movie') {
          const r = parseInt(res.data?.runtime, 10);
          return Number.isFinite(r) && r > 0 ? { runtimeMin: r } : null;
        }
        const episodes = parseInt(res.data?.number_of_episodes, 10);
        const runtimes = Array.isArray(res.data?.episode_run_time)
          ? res.data.episode_run_time.filter(n => Number.isFinite(n) && n > 0)
          : [];
        // Median runtime — robust against outlier episode lengths.
        let avgEpisodeMin = null;
        if (runtimes.length > 0) {
          const sorted = [...runtimes].sort((a, b) => a - b);
          avgEpisodeMin = sorted[Math.floor(sorted.length / 2)];
        }
        return {
          episodes:       Number.isFinite(episodes) && episodes > 0 ? episodes : null,
          avgEpisodeMin,
        };
      } catch (e) {
        console.warn('[TMDB] getRuntimeInfo failed:', e.message);
        return null;
      }
    });
  }

  // Count new releases ("dropped this week") matching the user's top genres
  // and currently-selected services. Used by the "New in your genres" home
  // screen card (PM roadmap 3.2). Returns just the count via `total_results`
  // — we don't need the actual items, only the headline number for the card.
  // The card's tap behavior re-runs the normal pickContent flow.
  async getNewReleasesCount({ services = [], genreIds = [], days = 7 } = {}) {
    if (!Array.isArray(genreIds) || genreIds.length === 0) return 0;
    if (!Array.isArray(services) || services.length === 0) return 0;

    const providerIds = services
      .map(s => PROVIDER_IDS[s])
      .filter(Boolean)
      .join('|'); // TMDB OR query — title needs to be on ANY of these services
    if (!providerIds) return 0;

    // Date floor — last N days. UTC midnight to keep the cache stable
    // through the day instead of inching forward minute-by-minute.
    const floor = new Date();
    floor.setUTCHours(0, 0, 0, 0);
    floor.setUTCDate(floor.getUTCDate() - days);
    const floorStr = floor.toISOString().slice(0, 10);

    const cacheKey = `newrel-${providerIds}-${genreIds.join(',')}-${floorStr}`;
    return this.getCached(cacheKey, async () => {
      try {
        // Count movies + tv separately; sum total_results for the headline.
        const [m, tv] = await Promise.all([
          this.api.get('/discover/movie', { params: {
            with_watch_providers: providerIds,
            watch_region: 'US',
            sort_by: 'primary_release_date.desc',
            'primary_release_date.gte': floorStr,
            with_genres: genreIds.join('|'),
            'vote_count.gte': 5, // light floor — very new titles have few votes
            page: 1,
          }}),
          this.api.get('/discover/tv', { params: {
            with_watch_providers: providerIds,
            watch_region: 'US',
            sort_by: 'first_air_date.desc',
            'first_air_date.gte': floorStr,
            with_genres: genreIds.join('|'),
            'vote_count.gte': 5,
            page: 1,
          }}),
        ]);
        return (m.data?.total_results || 0) + (tv.data?.total_results || 0);
      } catch (e) {
        console.warn('[TMDB] getNewReleasesCount failed:', e.message);
        return 0;
      }
    });
  }

  // Fetch the best YouTube trailer for a title.
  //
  // Returns a video object { key, name } where `key` is the YouTube video ID,
  // or null if no trailer is available. Selection priority:
  //   1. Official YouTube Trailer in English
  //   2. Any YouTube Trailer
  //   3. Official YouTube Teaser
  //   4. Any YouTube Teaser
  // Anything else (Clip, Featurette, Behind the Scenes) is rejected so we
  // don't surface a 30-second bloopers reel as a "trailer".
  //
  // `type` is 'movie' or 'tv' — TMDB exposes the same shape under both.
  async getTrailer(id, type = 'movie') {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const cacheKey = `trailer-${endpoint}-${id}`;
    return this.getCached(cacheKey, async () => {
      try {
        const res = await this.api.get(`/${endpoint}/${id}/videos`);
        const youtubes = (res.data.results || []).filter(v => v.site === 'YouTube');
        if (youtubes.length === 0) return null;

        const scoreOf = (v) => {
          // Higher score = better match. Reject non-trailer/teaser entirely.
          let s = 0;
          if (v.type === 'Trailer') s += 100;
          else if (v.type === 'Teaser') s += 50;
          else return -1;
          if (v.official) s += 30;
          if (v.iso_639_1 === 'en') s += 20;
          // Tiebreak by published_at — newer wins (often the "Final Trailer").
          if (v.published_at) s += Math.min(10, Math.floor(new Date(v.published_at).getTime() / 1e12));
          return s;
        };

        const ranked = youtubes
          .map(v => ({ video: v, score: scoreOf(v) }))
          .filter(r => r.score >= 0)
          .sort((a, b) => b.score - a.score);

        if (ranked.length === 0) return null;
        const best = ranked[0].video;
        return { key: best.key, name: best.name };
      } catch (e) {
        console.warn('[TMDB] getTrailer failed:', e.message);
        return null;
      }
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
