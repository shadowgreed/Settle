import { auth } from './firebase';

// ─────────────────────────────────────────────────────────────────────────────
// Returns an Authorization header carrying the signed-in user's Firebase ID
// token, or {} when signed out / on any failure.
//
// Spreading this into a fetch's headers lets the metered API proxies
// (/api/showtimes, /api/geocode) rate-limit per *verified user* (uid) rather
// than per shared IP — so people behind one office NAT, a school, or a mobile
// carrier's CGNAT don't all share a single rate-limit bucket.
//
// getIdToken() returns the cached token and only hits the network when it's
// near expiry, so this is cheap to call per request. Never throws — on any
// problem we return {} and the request falls back to IP-tier limiting.
// ─────────────────────────────────────────────────────────────────────────────
export async function authHeader() {
  try {
    const user = auth.currentUser;
    if (!user) return {};
    const token = await user.getIdToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
