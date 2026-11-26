// Registers the service worker, which (with manifest.webmanifest) makes the dashboard installable.
// Browsers only allow this on HTTPS or on localhost; elsewhere it silently does nothing.
(function () {
    'use strict';
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
    });
})();
