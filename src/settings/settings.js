const { loadConfig } = require('../config');
const { SETTINGS, ENV_ONLY } = require('./definitions');

const BY_KEY = new Map(SETTINGS.map(def => [def.key, def]));
const MAX_TEXT = 512;

class SettingsError extends Error {
    // details: { SETTING_NAME: message } for problems with one value
    constructor(message, details = null) {
        super(message);
        this.name = 'SettingsError';
        this.details = details;
    }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One submitted value, checked against its definition; returns the text to store
function normalize(def, value) {
    if (typeof value === 'boolean' || typeof value === 'number') value = String(value);
    if (typeof value !== 'string') throw new Error('must be text');
    const text = value.trim();
    if (def.type === 'int') {
        if (!/^\d+$/.test(text)) throw new Error('must be a whole number');
        const n = parseInt(text, 10);
        if (n < def.min || n > def.max) throw new Error(`must be between ${def.min} and ${def.max}`);
        return String(n);
    }
    if (def.type === 'bool') {
        if (text !== 'true' && text !== 'false') throw new Error('must be on or off');
        return text;
    }
    if (/[\r\n]/.test(text)) throw new Error('must be on one line');
    if (text.length > MAX_TEXT) throw new Error(`must be at most ${MAX_TEXT} characters`);
    return text;
}

// Settings stored in the database win over .env, which wins over the defaults.
//
// The stored values are merged over the environment and the result goes through loadConfig(), so a value is
// parsed and validated exactly as it would be in .env. `config` is the one object the whole server holds: live
// settings are copied into it when saved, restart settings are left alone until the server starts again.
class Settings {
    constructor({ model, env = process.env, log = () => {} }) {
        this.model = model;
        this.env = env;
        this.log = log;
        this.overrides = new Map(); // setting name -> stored text
        this.config = null;
        this.startupProblem = null;
        this.listeners = [];
    }

    mergedEnv(overrides = this.overrides) {
        return { ...this.env, ...Object.fromEntries(overrides) };
    }

    // Reads the database and returns the configuration to run with. If the stored values no longer work with
    // .env (it changed since they were saved), they are ignored instead of stopping the server, so the
    // settings page is still reachable to fix them; a broken .env still throws, as it always did.
    async load() {
        const rows = await this.model.all();
        for (const row of rows) if (BY_KEY.has(row.name)) this.overrides.set(row.name, row.value);
        try {
            this.config = loadConfig(this.mergedEnv());
        } catch (error) {
            if (!this.overrides.size) throw error;
            this.startupProblem = error.message;
            this.log(`Settings saved on the dashboard were ignored because they do not work with the current .env: ${error.message}`);
            this.overrides.clear();
            this.config = loadConfig(this.env);
        }
        return this.config;
    }

    onChange(listener) {
        this.listeners.push(listener);
    }

    // The configuration the saved settings produce (what a restart would run with)
    effective(overrides = this.overrides) {
        return loadConfig(this.mergedEnv(overrides));
    }

    describe() {
        let effective;
        try {
            effective = this.effective();
        } catch {
            effective = this.config;
        }
        const settings = SETTINGS.map(def => {
            const stored = this.overrides.has(def.key);
            const fromEnv = this.env[def.key] !== undefined && this.env[def.key] !== '';
            return {
                key: def.key,
                group: def.group,
                label: def.label,
                help: def.help,
                type: def.type,
                min: def.min,
                max: def.max,
                apply: def.apply,
                sensitive: Boolean(def.sensitive),
                default: def.default,
                value: stored ? this.overrides.get(def.key) : fromEnv ? this.env[def.key] : def.default,
                source: stored ? 'database' : fromEnv ? 'env' : 'default',
                envValue: fromEnv ? this.env[def.key] : null,
                restartPending: def.apply === 'restart' && def.props.some(p => !same(effective[p], this.config[p])),
            };
        });
        return {
            settings,
            envOnly: ENV_ONLY,
            restartPending: settings.some(s => s.restartPending),
            startupProblem: this.startupProblem,
        };
    }

    // changes: { SETTING_NAME: "value" } to store, or { SETTING_NAME: null } to go back to .env / the default.
    // Everything is validated first; nothing is saved unless all of it is valid. Returns what changed.
    async set(changes, { actor = null } = {}) {
        const details = {};
        const next = new Map(this.overrides);
        for (const [key, value] of Object.entries(changes || {})) {
            const def = BY_KEY.get(key);
            if (!def) {
                details[key] = 'is not a setting that can be changed here';
                continue;
            }
            if (value === null) {
                next.delete(key);
                continue;
            }
            try {
                next.set(key, normalize(def, value));
            } catch (error) {
                details[key] = error.message;
            }
        }
        if (Object.keys(details).length) throw new SettingsError('Some values are not valid', details);

        const changedKeys = [...new Set([...this.overrides.keys(), ...next.keys()])].filter(key => this.overrides.get(key) !== next.get(key));
        if (!changedKeys.length) return [];

        let effective;
        try {
            effective = this.effective(next);
        } catch (error) {
            throw new SettingsError(error.message.replace(/^Invalid configuration: /, '').replace(/\.$/, ''));
        }
        // TLS problems don't stop the server (it starts without TLS), so a save must not quietly cause them
        const touchesTls = changedKeys.some(key => BY_KEY.get(key).props.some(p => /^(smtpTls|acme)/.test(p)));
        if (touchesTls && effective.tlsErrors.length && !same(effective.tlsErrors, this.effective().tlsErrors)) {
            throw new SettingsError(effective.tlsErrors.join('; '));
        }

        const before = this.describe().settings;
        for (const key of changedKeys) {
            if (next.has(key)) await this.model.set(key, next.get(key), actor);
            else await this.model.remove(key);
        }
        this.overrides = next;

        // Live settings take effect now, by updating the object every part of the server already holds
        for (const def of SETTINGS) {
            if (def.apply === 'live') for (const prop of def.props) this.config[prop] = effective[prop];
        }
        const after = new Map(this.describe().settings.map(s => [s.key, s]));
        const result = changedKeys.map(key => {
            const old = before.find(s => s.key === key);
            return { key, from: old.value, to: after.get(key).value, source: after.get(key).source, sensitive: old.sensitive, apply: old.apply };
        });
        for (const listener of this.listeners) listener(changedKeys, this.config);
        return result;
    }
}

module.exports = { Settings, SettingsError };
