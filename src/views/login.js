const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const errorEl = document.getElementById('loginError');
const button = document.getElementById('loginButton');

function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
}

// Remember the last username so only the password needs typing next time
try {
    const saved = localStorage.getItem('ms_last_username');
    if (saved) {
        usernameInput.value = saved;
        passwordInput.focus();
    }
} catch {
    // storage unavailable
}

document.getElementById('togglePassword').addEventListener('click', event => {
    const toggle = event.currentTarget;
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    passwordInput.focus();
});

passwordInput.addEventListener('keyup', event => {
    const on = event.getModifierState && event.getModifierState('CapsLock');
    document.getElementById('capsLockHint').classList.toggle('hidden', !on);
});

[usernameInput, passwordInput].forEach(input => input.addEventListener('input', () => showError('')));

form.addEventListener('submit', async event => {
    event.preventDefault();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
        showError('Enter your username and password.');
        (username ? passwordInput : usernameInput).focus();
        return;
    }

    showError('');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
            body: JSON.stringify({ username, password }),
        });
        if (response.ok) {
            try {
                localStorage.setItem('ms_last_username', username);
            } catch {
                // storage unavailable
            }
            window.location.href = '/';
            return;
        }
        const data = await response.json().catch(() => ({}));
        showError(response.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : data.error || 'Sign in failed.');
        passwordInput.select();
    } catch {
        showError('Could not reach the server.');
    } finally {
        button.disabled = false;
        button.textContent = 'Sign in';
    }
});
