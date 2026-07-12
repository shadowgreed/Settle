import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { Analytics } from '@vercel/analytics/react';
import { installNativeBridge, isNative } from './native/bridge';

// Native (Capacitor) shims — no-op on web, so the PWA is unchanged.
installNativeBridge();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
    <Analytics />
  </React.StrictMode>
);

// Register the PWA service worker on the WEB only. In the native shell the app
// is served from the local bundle, so the SW (and its web-push path) is both
// unnecessary and potentially confusing — native push uses @capacitor/push.
if (!isNative() && 'serviceWorker' in navigator) {
  // Security/performance audit fix (PERF-01): sw.js calls skipWaiting() +
  // clients.claim(), so a new deploy's service worker takes over every open
  // tab immediately with no update prompt. Without this listener, a tab left
  // open across a deploy would keep running old in-memory JS against a new
  // SW's fetch/cache behavior indefinitely — stale static-asset hashes,
  // changed /api contracts, etc. Reload once when the controller actually
  // CHANGES from one active worker to another; `currentController` starts
  // null on a fresh page load with nothing controlling it yet, so the very
  // first activation (every first-time visitor) is correctly not treated as
  // an update and doesn't trigger an unwanted reload.
  let currentController = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (currentController) window.location.reload();
    currentController = navigator.serviceWorker.controller;
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
