#!/usr/bin/env node
/**
 * Decade-mood catalog audit (PM roadmap 2.1 pre-build gate).
 *
 * For each candidate decade × each streaming service, queries TMDB via the
 * production proxy and counts pickable titles. "Pickable" means the same
 * filter floor the app applies on a normal pick: vote_count >= 50 (so we
 * don't surface obscure titles), vote_average >= 6.0 (so we don't surface
 * trash).
 *
 * Output: a markdown report listing counts per service per decade plus
 * an "Pass / Skip" verdict per decade (threshold: 50 combined titles).
 *
 * Usage:
 *   node scripts/decade-audit.js                     # hit production proxy
 *   TMDB_API_KEY=xxx node scripts/decade-audit.js    # hit TMDB directly
 *
 * Written to: scripts/decade-audit-report.md
 */
const fs = require('fs');
const path = require('path');

const SERVICES = [
  { name: 'Netflix',     id: 8    },
  { name: 'Max',         id: 1899 },
  { name: 'Disney+',     id: 337  },
  { name: 'Apple TV',    id: 350  },
  { name: 'Prime Video', id: 9    },
];

const DECADES = [
  { label: "'80s vibes", start: '1980-01-01', end: '1989-12-31' },
  { label: "'90s vibes", start: '1990-01-01', end: '1999-12-31' },
  { label: "'00s vibes", start: '2000-01-01', end: '2009-12-31' },
];

// PM's stated threshold — fewer combined titles than this and the mood
// will feel broken on first use.
const VIABILITY_THRESHOLD = 50;

// Filter floor — matches the app's default discover query (minRating 6.0,
// vote_count >= 50). Counting "pickable" titles is what matters, not raw
// catalog presence.
const VOTE_AVG_FLOOR   = 6.0;
const VOTE_COUNT_FLOOR = 50;

const HAS_KEY = !!process.env.TMDB_API_KEY;
const TMDB_DIRECT = 'https://api.themoviedb.org/3';
const TMDB_PROXY  = 'https://trysettle.app/api/tmdb';

async function tmdbQuery(endpoint, params) {
  const u = new URL(HAS_KEY ? `${TMDB_DIRECT}${endpoint}` : TMDB_PROXY);
  if (HAS_KEY) {
    u.searchParams.set('api_key', process.env.TMDB_API_KEY);
  } else {
    // Proxy convention: _p carries the endpoint path.
    u.searchParams.set('_p', endpoint.replace(/^\//, ''));
  }
  for (const [k, v] of Object.entries(params)) {
    if (v != null) u.searchParams.set(k, v);
  }
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${endpoint}`);
  return res.json();
}

async function count(kind, providerId, dateGte, dateLte) {
  const dateField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
  const data = await tmdbQuery(`/discover/${kind}`, {
    with_watch_providers: providerId,
    watch_region: 'US',
    sort_by: 'popularity.desc',
    'vote_average.gte': VOTE_AVG_FLOOR,
    'vote_count.gte': VOTE_COUNT_FLOOR,
    [`${dateField}.gte`]: dateGte,
    [`${dateField}.lte`]: dateLte,
    page: 1,
  });
  return data.total_results || 0;
}

async function audit() {
  console.log(`Mode: ${HAS_KEY ? 'direct TMDB' : 'production proxy (trysettle.app)'}`);
  console.log(`Filter floor: vote_average >= ${VOTE_AVG_FLOOR}, vote_count >= ${VOTE_COUNT_FLOOR}`);
  console.log(`Viability threshold: >= ${VIABILITY_THRESHOLD} combined titles\n`);

  const results = [];
  for (const decade of DECADES) {
    const row = { decade, services: {}, total: 0 };
    process.stdout.write(`${decade.label}  `);
    for (const svc of SERVICES) {
      try {
        const [m, tv] = await Promise.all([
          count('movie', svc.id, decade.start, decade.end),
          count('tv',    svc.id, decade.start, decade.end),
        ]);
        const total = m + tv;
        row.services[svc.name] = { movie: m, tv, total };
        row.total += total;
        process.stdout.write(`${svc.name}:${total}  `);
      } catch (e) {
        row.services[svc.name] = { error: e.message };
        process.stdout.write(`${svc.name}:ERR  `);
      }
    }
    process.stdout.write('\n');
    results.push(row);
  }

  // Build markdown report.
  const md = [];
  md.push('# Decade-Mood Catalog Audit');
  md.push('');
  md.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  md.push(`**Source:** ${HAS_KEY ? 'TMDB direct' : 'trysettle.app /api/tmdb proxy'}`);
  md.push(`**Filter floor:** vote_average ≥ ${VOTE_AVG_FLOOR}, vote_count ≥ ${VOTE_COUNT_FLOOR}`);
  md.push(`**Viability threshold:** ≥ ${VIABILITY_THRESHOLD} combined titles (PM roadmap 2.1)`);
  md.push('');

  // Per-decade detailed tables.
  for (const row of results) {
    const verdict = row.total >= VIABILITY_THRESHOLD ? '✅ PASS' : '❌ SKIP';
    md.push(`## ${row.decade.label}  —  ${verdict}`);
    md.push('');
    md.push(`**Combined pickable titles: ${row.total}**`);
    md.push('');
    md.push('| Service | Movies | Series | Total |');
    md.push('|---|---:|---:|---:|');
    for (const svc of SERVICES) {
      const r = row.services[svc.name];
      if (r?.error) {
        md.push(`| ${svc.name} | — | — | ERR (${r.error}) |`);
      } else {
        md.push(`| ${svc.name} | ${r.movie} | ${r.tv} | **${r.total}** |`);
      }
    }
    md.push('');
  }

  // Summary verdict.
  const passed = results.filter(r => r.total >= VIABILITY_THRESHOLD);
  const skipped = results.filter(r => r.total < VIABILITY_THRESHOLD);
  md.push('## Verdict');
  md.push('');
  if (passed.length > 0) {
    md.push(`**Build these mood tiles:** ${passed.map(r => r.decade.label).join(', ')}`);
  }
  if (skipped.length > 0) {
    md.push(`**Skip these (below threshold):** ${skipped.map(r => r.decade.label).join(', ')}`);
  }
  md.push('');
  md.push('---');
  md.push(`*Generated by ${path.relative(process.cwd(), __filename)}*`);

  const outPath = path.join(__dirname, 'decade-audit-report.md');
  fs.writeFileSync(outPath, md.join('\n'), 'utf8');
  console.log(`\nReport written to ${outPath}`);
  return { results, outPath };
}

audit().catch(e => {
  console.error('Audit failed:', e);
  process.exit(1);
});
