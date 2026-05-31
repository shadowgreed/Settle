# Settle — Native (Capacitor)

The **same** Settle web app (Solo / Couples / Theater) wrapped as a real native
iOS + Android app for the App Store / Play Store. No fork: `src/` is shared, the
Vercel PWA keeps deploying from this repo unchanged, and `android/` + `ios/` are
native build targets generated from the web `build/`.

## How it works
- **Web (Vercel):** unchanged. `installNativeBridge()` in `src/index.js` is a
  no-op when `Capacitor.isNativePlatform()` is false.
- **Native:** `src/native/bridge.js` installs three startup shims (native only):
  1. Relative `/api/*` calls → rewritten to `https://www.trysettle.app` and sent
     through the **native HTTP stack** (`CapacitorHttp`), bypassing WebView CORS.
     Firebase (absolute googleapis URLs) + image loads are left untouched.
  2. `window.open()` → in-app browser (SFSafariViewController / Custom Tab).
  3. `<a target="_blank">` clicks ("Open on Netflix", Fandango ticket CTA) →
     in-app browser. **This is the in-app ticket-purchase win** — the user buys
     without leaving the app, no ticketing partnership, IAP-exempt.

## Build / run
```bash
npm run build && npx cap sync          # web build → native projects
npx cap run android                    # device/emulator (Windows OK)
npm run cap:ios                        # build + open Xcode (needs macOS)
npm run cap:android                    # build + open Android Studio
```
- **Android:** builds on Windows with Android Studio / the Android SDK.
- **iOS:** the Xcode project is scaffolded (Capacitor 8 uses Swift Package
  Manager — no CocoaPods), but **compiling an .ipa needs macOS**. Without a Mac,
  use a cloud-Mac CI: **Codemagic** (free tier) or **GitHub Actions macOS
  runner** → `cap sync ios` + `xcodebuild` → upload to TestFlight via Fastlane.

## Done in this pass
- ✅ Capacitor 8 + `android/` + `ios/` projects + plugins (browser, app,
  status-bar, splash-screen, push-notifications).
- ✅ `capacitor.config.json` (appId `app.trysettle.settle`, webDir `build`, dark theme).
- ✅ Native bridge: API-over-native-HTTP + in-app browser for all external links.
- ✅ Web PWA verified still building (bridge is a no-op on web).

## Remaining for App Store readiness
- **[code] Native push** — register via `@capacitor/push-notifications` (APNs/FCM),
  POST the token to the existing `/api/push/subscribe` (reuse Upstash + cron).
  Replaces the web service-worker push on native.
- **[code] Sign in with Apple** — required by Apple (Guideline 4.8) since Google
  login is offered. Firebase Apple provider + `@capacitor-community/apple-sign-in`
  or the native flow.
- **[code] Location** — optional: native geolocation for "showtimes near me"
  (add `NSLocationWhenInUseUsageDescription`).
- **[code] App icons / splash** — drop brand art into `ios/.../Assets.xcassets`
  and `android/.../res` (or use `@capacitor/assets` to generate from one source).
- **[you] Apple Developer account** ($99/yr) + App Store Connect record.
- **[you] Privacy nutrition labels, screenshots, description** in App Store Connect.
- **[done-in-web] Account deletion** — already in the app (Settings) → satisfies
  Guideline 5.1.1(v).
- **[apple] Review** — Settle is a full app (3 modes, real-time couples, native
  push, in-app purchase), not a thin wrapper, so it clears Guideline 4.2.

## Note
`android/` and `ios/` are committed (standard for Capacitor — needed for native
config: push entitlements, Apple sign-in, icons, signing). Vercel ignores them
and only builds `build/`, so the web deploy is unaffected.
