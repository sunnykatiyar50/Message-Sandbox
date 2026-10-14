// Theme: System (follows the browser/OS), Light or Dark.
//
// Loaded in <head> before the stylesheet applies, so the saved theme is in place on first paint.
// Sets on <html>:
//   data-theme="light" | "dark"   only for an explicit choice (styles.css keys the palettes off this)
//   data-theme-choice="system" | "light" | "dark"   always (picks the icon on the toggle buttons)
// Any element with [data-theme-toggle] cycles System -> Light -> Dark when clicked.
(function () {
    'use strict';

    var KEY = 'mt_theme';
    var ORDER = ['system', 'light', 'dark'];
    var LABELS = { system: 'Theme: System', light: 'Theme: Light', dark: 'Theme: Dark' };
    var root = document.documentElement;

    function read() {
        try {
            var value = localStorage.getItem(KEY);
            return ORDER.indexOf(value) === -1 ? 'system' : value;
        } catch (e) {
            return 'system';
        }
    }

    function apply(choice) {
        if (choice === 'system') root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', choice);
        root.setAttribute('data-theme-choice', choice);
        var buttons = document.querySelectorAll('[data-theme-toggle]');
        for (var i = 0; i < buttons.length; i++) {
            var next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
            buttons[i].title = LABELS[choice] + ' (click for ' + next + ')';
            buttons[i].setAttribute('aria-label', LABELS[choice] + '. Click to switch to ' + next + '.');
            var label = buttons[i].querySelector('[data-theme-label]');
            if (label) label.textContent = LABELS[choice];
        }
    }

    function save(choice) {
        try {
            if (choice === 'system') localStorage.removeItem(KEY);
            else localStorage.setItem(KEY, choice);
        } catch (e) {
            // storage unavailable: the choice lasts until the page is reloaded
        }
    }

    apply(read());

    document.addEventListener('DOMContentLoaded', function () {
        apply(read());
        document.addEventListener('click', function (event) {
            var button = event.target.closest && event.target.closest('[data-theme-toggle]');
            if (!button) return;
            var current = root.getAttribute('data-theme-choice') || 'system';
            var next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
            save(next);
            apply(next);
        });
    });

    // Another tab changed the theme
    window.addEventListener('storage', function (event) {
        if (event.key === KEY) apply(read());
    });
})();
