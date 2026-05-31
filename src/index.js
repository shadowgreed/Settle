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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
