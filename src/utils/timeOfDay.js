// ─────────────────────────────────────────────────────────────────────────────
// Time-of-day helpers — single source of truth for the time buckets the app
// uses to label picks ("Morning Pick" / "Afternoon Pick" / etc.) and to
// generate the mood-greeting line on the home screen.
//
// Buckets:
//    5 am – 12 pm  →  morning
//   12 pm –  6 pm  →  afternoon
//    6 pm –  9 pm  →  evening
//    9 pm –  5 am  →  tonight
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns one of 'morning' | 'afternoon' | 'evening' | 'tonight' for the
 * given hour-of-day (0–23). Accepts an optional `hour` for testability;
 * defaults to the user's current local hour.
 */
export function timeOfDay(hour) {
  const h = typeof hour === 'number' ? hour : new Date().getHours();
  if (h >= 5  && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  if (h >= 18 && h < 21) return 'evening';
  return 'tonight';
}

/**
 * Label for the share-card mode pill + the cinema-mode stamp.
 *   solo  mode  →  "Tonight's Pick" / "Morning Pick" / etc.
 *   couple mode →  "Our Pick Tonight" / "Our Morning Pick" / etc.
 * Theater is handled separately by callers because its label depends on
 * the surface (cinema overlay vs share card) rather than time of day.
 */
export function pickLabel(mode, hour) {
  const t = timeOfDay(hour);
  if (mode === 'couple') {
    return t === 'tonight' ? 'Our Pick Tonight'
         : t === 'morning' ? 'Our Morning Pick'
         : t === 'afternoon' ? 'Our Afternoon Pick'
         : 'Our Evening Pick';
  }
  return t === 'tonight' ? "Tonight's Pick"
       : t === 'morning' ? 'Morning Pick'
       : t === 'afternoon' ? 'Afternoon Pick'
       : 'Evening Pick';
}

/**
 * Lowercase "verb" used by the text-only share fallback:
 *   solo:   "Tonight's pick:" / "Morning pick:" / etc.
 *   couple: "We're watching" (time-agnostic — already idiomatic for couples).
 */
export function pickVerb(mode, hour) {
  if (mode === 'couple') return "We're watching";
  const t = timeOfDay(hour);
  return t === 'tonight' ? "Tonight's pick:"
       : t === 'morning' ? 'Morning pick:'
       : t === 'afternoon' ? 'Afternoon pick:'
       : 'Evening pick:';
}

/**
 * Question used in the home screen mood label. Was a standalone helper in
 * App.js; consolidated here so all time-of-day copy reads from one bucket.
 */
export function moodGreeting(hour) {
  const t = timeOfDay(hour);
  if (t === 'morning')   return 'How are you feeling this morning?';
  if (t === 'afternoon') return 'How are you feeling this afternoon?';
  if (t === 'evening')   return 'How are you feeling this evening?';
  return 'How are you feeling tonight?';
}
