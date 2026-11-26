// Service worker: makes the dashboard installable and keeps the app shell available offline.
//
// It caches only the public static files (scripts, styles, icons). Messages, the API and the HTML pages
// (which depend on the signed-in session) are never cached: they always come from the network. When the
// server is unreachable, a page navigation shows offline.html instead of the browser's error page.
'use strict';

const CACHE = 'message-sandbox-shell-v1';
const OFFLINE_URL = 'offline.html';
const PRECACHE = [
    OFFLINE_URL,
    'offline.css',
    'styles.css',
    'theme.js',
    'formatters.js',
    'scripts.js',
    'sms.js',
    'login.js',
    'favicon.svg',
    'icons/icon-192.png',
];
const STATIC_FILE = /\.(?:css|js|svg|png|webmanifest)$/;
const NEVER_CACHE = /^\/(?:api|auth|metrics|health)(?:\/|$)/;

self.addEventListener('install', event => {
    event.waitUntil(
        caches
            .open(CACHE)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches
            .keys()
            .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || NEVER_CACHE.test(url.pathname)) return;

    if (request.mode === 'navigate') {
        event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
        return;
    }

    // Static files: network first (so an update shows up at once), the cached copy when offline
    if (STATIC_FILE.test(url.pathname)) {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE).then(cache => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(request).then(cached => cached || Response.error()))
        );
    }
});
