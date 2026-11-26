const { toIso } = require('../utils/time');

// Settings changed on the dashboard: one row per environment variable name, holding the value as text
class SettingsModel {
    constructor(db) {
        this.db = db;
    }

    async all() {
        const rows = await this.db.all('SELECT name, value, updated_at, updated_by FROM app_settings');
        return rows.map(r => ({ name: r.name, value: r.value, updatedAt: toIso(r.updated_at), updatedBy: r.updated_by || null }));
    }

    // Insert or update. Two statements rather than an upsert, which differs between the three databases.
    async set(name, value, updatedBy = null) {
        const [existing] = await this.db.all('SELECT name FROM app_settings WHERE name = ?', [name]);
        if (existing) {
            await this.db.run('UPDATE app_settings SET value = ?, updated_at = ?, updated_by = ? WHERE name = ?', [value, new Date(), updatedBy, name]);
        } else {
            await this.db.run('INSERT INTO app_settings (name, value, updated_at, updated_by) VALUES (?, ?, ?, ?)', [name, value, new Date(), updatedBy]);
        }
    }

    async remove(name) {
        return this.db.run('DELETE FROM app_settings WHERE name = ?', [name]);
    }
}

module.exports = SettingsModel;
