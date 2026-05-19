import React from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Shared Privacy Policy + Terms of Service bodies.
// Imported by both App.js (post-auth modals) and AuthGate.js (pre-auth modals)
// so the two surfaces never drift out of sync.
// ─────────────────────────────────────────────────────────────────────────────

export const EFFECTIVE_DATE = 'May 18, 2026';

export function PrivacyBody() {
  return (
    <>
      <p className="terms-effective">Effective {EFFECTIVE_DATE} · trysettle.app</p>
      <p>Settle is designed to collect as little data as possible. Here's exactly what we store and why.</p>

      <h3>1. Account &amp; Authentication</h3>
      <p>A free account is required to use Settle. Sign-in is handled by <strong>Firebase Authentication</strong> (Google LLC). When you sign in with Google or email magic link, we receive and store your email address and display name solely to identify your account. We do not store passwords — magic links expire after 1 hour and are single-use.</p>
      <p>This authentication data is held by Google Firebase and subject to the <a href="https://firebase.google.com/support/privacy" target="_blank" rel="noopener noreferrer">Firebase Privacy Policy</a>.</p>

      <h3>2. Cloud Sync (Firestore)</h3>
      <p>When you grant storage consent, your in-app data is synced to <strong>Firebase Firestore</strong> so it follows you across devices. This includes:</p>
      <ul>
        <li>Selected streaming services, genres, mood filters, and format preferences</li>
        <li>Watch history (last 30 titles with your vote per entry)</li>
        <li>Your taste profile (up/down vote weights per genre)</li>
        <li>Saved picks ("Save for Later" bookmarks)</li>
        <li>Player names (Couples mode)</li>
        <li>Onboarding completion status</li>
      </ul>
      <p>If you decline consent, all data stays on-device only (localStorage + IndexedDB). When you sign out, this device's locally-cached data is cleared automatically. You can revoke consent at any time from the in-app <strong>Privacy &amp; Data</strong> settings (gear icon in the account bar) — your cloud document will no longer receive updates from this device.</p>

      <h3>3. Local &amp; Offline Storage</h3>
      <p>Settle uses your browser's <strong>localStorage</strong> and <strong>IndexedDB</strong> to cache preferences and enable offline use as a Progressive Web App (PWA). This data never leaves your device unless you are signed in and have granted cloud sync consent.</p>

      <h3>4. Analytics</h3>
      <p>We use <strong>PostHog</strong> to collect anonymous, aggregated usage data — for example, which modes are used and how often picks are generated. No personally identifiable information is included. Analytics are only activated after you accept the storage consent prompt. You can also opt out by enabling your browser's "Do Not Track" setting or using a content blocker.</p>

      <h3>5. Share Cards</h3>
      <p>The "Share Pick" feature generates an image entirely within your browser using the HTML Canvas API. No image data is transmitted to our servers or any third party. The poster artwork is fetched from TMDB's CDN directly by your device.</p>

      <h3>6. Third-Party Services</h3>
      <ul>
        <li><strong>TMDB API</strong> — movie and series data (titles, posters, ratings). Subject to the <a href="https://www.themoviedb.org/privacy-policy" target="_blank" rel="noopener noreferrer">TMDB Privacy Policy</a>.</li>
        <li><strong>Watchmode API</strong> — direct streaming links for Disney+ and Apple TV. Subject to Watchmode's privacy policy.</li>
        <li><strong>Google Fonts</strong> — typefaces loaded from fonts.googleapis.com. Subject to <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google's Privacy Policy</a>.</li>
        <li><strong>Netflix, Prime Video, Max, Apple TV, Disney+</strong> — outbound search or direct links only. We do not share any user data with these platforms.</li>
      </ul>

      <h3>7. Data Retention &amp; Deletion</h3>
      <p>You can permanently delete your account and all associated Firestore data yourself, at any time, from the in-app <strong>Privacy &amp; Data</strong> settings (gear icon in the account bar). The deletion is immediate. If you'd prefer we delete it for you, email <strong>hello@trysettle.app</strong> and we'll process the request within 30 days. Local browser data (localStorage, IndexedDB) is cleared automatically when you sign out, or can be cleared at any time through your browser settings.</p>

      <h3>8. Children's Privacy</h3>
      <p>Settle is not directed at children under 13. We do not knowingly collect personal information from anyone under 13. If you believe a child has provided us with personal data, contact us and we will delete it promptly.</p>

      <h3>9. Contact</h3>
      <p>Questions? Reach out at <strong>hello@trysettle.app</strong></p>
    </>
  );
}

export function TermsBody() {
  return (
    <>
      <p className="terms-effective">Effective {EFFECTIVE_DATE} · trysettle.app</p>

      <p>By using Settle you agree to these terms. If you don't agree, please don't use the app.</p>

      <h3>1. What Settle Is</h3>
      <p>Settle is a free, browser-based streaming pick app. It helps solo viewers, couples, and groups decide what to watch across Netflix, Max, Disney+, Apple TV, and Prime Video. A free account — via Google sign-in or email magic link — is required to use the app. Your account lets us sync your preferences, watch history, and taste profile across devices.</p>

      <h3>2. The Service Is Provided Free of Charge</h3>
      <p>Settle is offered at no cost. We reserve the right to modify, suspend, or discontinue the service at any time without notice. We won't be liable to you or any third party for doing so.</p>

      <h3>3. Third-Party Content &amp; APIs</h3>
      <p>All movie and series data (titles, posters, ratings, descriptions) is sourced from <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">TMDB</a> and used under their API terms. Streaming availability and direct links are provided by <a href="https://www.watchmode.com" target="_blank" rel="noopener noreferrer">Watchmode</a>. We don't own, curate, or guarantee the accuracy of this content. Streaming catalogs change daily — always verify availability on the platform directly.</p>
      <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>

      <h3>4. User Accounts &amp; Data</h3>
      <p>You are responsible for maintaining the security of your account. We use Firebase Authentication (Google LLC) to manage sign-in — we do not store passwords. Your in-app data (preferences, history, taste profile) is stored in Firebase Firestore when you grant consent. You may delete your account and all associated data at any time from the in-app <strong>Privacy &amp; Data</strong> settings, or by emailing <strong>hello@trysettle.app</strong>.</p>

      <h3>5. Share Cards</h3>
      <p>Settle can generate shareable pick images ("share cards") via the in-app Share button. These images are created entirely within your browser and are not stored on our servers. You are responsible for any content you choose to share publicly. Movie poster images remain the property of their respective studios and rights holders — share cards are intended for personal, non-commercial use only.</p>

      <h3>6. Progressive Web App (PWA)</h3>
      <p>Settle can be installed to your home screen as a PWA. The app uses browser localStorage and IndexedDB to cache data for offline use. This local data is private to your device and is not transmitted unless you are signed in with cloud sync enabled.</p>

      <h3>7. Acceptable Use</h3>
      <p>You agree not to:</p>
      <ul>
        <li>Scrape, crawl, or automate requests to the app</li>
        <li>Attempt to reverse-engineer or tamper with the service</li>
        <li>Use the app in any way that violates applicable laws</li>
        <li>Misrepresent affiliation with Settle</li>
      </ul>
      <p>We reserve the right to suspend or terminate access for anyone who abuses the service.</p>

      <h3>8. Intellectual Property</h3>
      <p>The Settle app, its design, code, and original content are owned by us and protected by applicable intellectual property laws. Movie posters, titles, and metadata remain the property of their respective studios and rights holders. The TMDB logo and branding belong to TMDB.</p>

      <h3>9. No Warranties</h3>
      <p>Settle is provided <strong>"as is"</strong> and <strong>"as available"</strong> without warranties of any kind — express, implied, or statutory. We make no guarantees that the service will be uninterrupted or error-free.</p>

      <h3>10. Limitation of Liability</h3>
      <p>To the fullest extent permitted by law, Settle and its operators will not be liable for any indirect, incidental, special, or consequential damages arising from your use of — or inability to use — the service. Our total liability for any claim is limited to zero dollars, reflecting that the service is free.</p>

      <h3>11. Analytics</h3>
      <p>We use PostHog to collect anonymous, aggregated usage data (e.g. which modes are used, how often picks are generated). Analytics are only activated after you accept the storage consent prompt, and no personally identifiable information is collected. You may opt out by enabling your browser's "Do Not Track" setting or using a content blocker.</p>

      <h3>12. Changes to These Terms</h3>
      <p>We may update these terms at any time. Continued use of the app after changes are posted means you accept the updated terms. The effective date at the top of this page will always reflect the latest revision.</p>

      <h3>13. Contact</h3>
      <p>Questions about these terms? Email us at <strong>hello@trysettle.app</strong></p>
    </>
  );
}
