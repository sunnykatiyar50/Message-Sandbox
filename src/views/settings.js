// The Settings page (admin only): shows the settings from GET /api/settings, grouped, and saves changes with
// PUT /api/settings. Loaded after scripts.js, whose helpers it uses ($, el, apiJson). Everything is rendered
// with textContent, never as HTML.

let settingsData = null;
const settingsInputs = new Map(); // setting name -> { setting, input, error, row }

const SETTINGS_SOURCE_LABELS = { database: 'Saved here', env: '.env', default: 'Default' };

function settingsInputValue(setting, input) {
    return setting.type === 'bool' ? String(input.checked) : input.value.trim();
}

function settingsDirtyEntries() {
    const dirty = {};
    for (const [key, { setting, input }] of settingsInputs) {
        const value = settingsInputValue(setting, input);
        if (value !== setting.value) dirty[key] = value;
    }
    return dirty;
}

function settingsUpdateButtons() {
    const dirty = settingsDirtyEntries();
    const any = Object.keys(dirty).length > 0;
    $('settingsSave').disabled = !any;
    $('settingsDiscard').disabled = !any;
    for (const [key, { row }] of settingsInputs) row.classList.toggle('dirty', key in dirty);
}

function settingsControl(setting) {
    let input;
    if (setting.type === 'bool') {
        input = el('input');
        input.type = 'checkbox';
        input.checked = setting.value === 'true';
    } else if (setting.type === 'int') {
        input = el('input');
        input.type = 'number';
        input.min = String(setting.min);
        input.max = String(setting.max);
        input.value = setting.value;
    } else {
        input = el('input');
        input.type = 'text';
        input.value = setting.value;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.placeholder = setting.default || 'not set';
    }
    input.id = `setting-${setting.key}`;
    input.addEventListener('input', () => {
        const entry = settingsInputs.get(setting.key);
        entry.error.textContent = '';
        input.classList.remove('invalid');
        settingsUpdateButtons();
    });
    input.addEventListener('change', settingsUpdateButtons);
    return input;
}

function settingsRow(setting) {
    const row = el('div', 'settings-row');

    const text = el('div', 'settings-text');
    const label = el('label', 'settings-label', setting.label);
    label.htmlFor = `setting-${setting.key}`;
    text.appendChild(label);
    text.appendChild(el('code', 'settings-key', setting.key));
    if (setting.help) text.appendChild(el('div', 'settings-help muted', setting.help));
    row.appendChild(text);

    const side = el('div', 'settings-side');
    const input = settingsControl(setting);
    side.appendChild(input);

    const meta = el('div', 'settings-meta');
    meta.appendChild(el('span', `chip source-${setting.source}`, SETTINGS_SOURCE_LABELS[setting.source]));
    if (setting.apply === 'restart') {
        const chip = el('span', setting.restartPending ? 'chip chip-warn' : 'chip', setting.restartPending ? 'Restart to apply' : 'Applied at startup');
        chip.title = setting.restartPending ? 'Saved, but the server is still running with the old value' : 'Takes effect the next time the server starts';
        meta.appendChild(chip);
    }
    if (setting.source === 'database') {
        const reset = el('button', 'link-button', setting.envValue !== null ? 'Use .env value' : 'Use default');
        reset.type = 'button';
        reset.title = setting.envValue !== null ? `Go back to the value in .env${setting.sensitive ? '' : ` (${setting.envValue})`}` : `Go back to the default${setting.default ? ` (${setting.default})` : ''}`;
        reset.addEventListener('click', () => settingsSave({ [setting.key]: null }));
        meta.appendChild(reset);
    }
    side.appendChild(meta);
    const error = el('small', 'field-error');
    side.appendChild(error);
    row.appendChild(side);

    settingsInputs.set(setting.key, { setting, input, error, row });
    return row;
}

function settingsRender(data) {
    settingsData = data;
    settingsInputs.clear();
    const groups = $('settingsGroups');
    groups.replaceChildren();
    const order = [];
    for (const setting of data.settings) if (!order.includes(setting.group)) order.push(setting.group);
    for (const name of order) {
        const card = el('div', 'card settings-group');
        card.appendChild(el('h3', null, name));
        for (const setting of data.settings.filter(s => s.group === name)) card.appendChild(settingsRow(setting));
        groups.appendChild(card);
    }

    const pending = data.settings.filter(s => s.restartPending);
    const restart = $('settingsRestart');
    restart.classList.toggle('hidden', pending.length === 0);
    restart.textContent = pending.length
        ? `Restart the server to apply: ${pending.map(s => s.label).join(', ')}. The other changes are already active.`
        : '';
    const problem = $('settingsProblem');
    problem.classList.toggle('hidden', !data.startupProblem);
    problem.textContent = data.startupProblem
        ? `The settings saved here were ignored at startup because they do not work with the current .env: ${data.startupProblem}. The server is running on .env values. Change or reset them below.`
        : '';

    $('settingsEnvOnly').replaceChildren(
        ...data.envOnly.map(entry => {
            const li = el('li');
            li.appendChild(el('code', null, entry.names));
            li.appendChild(el('span', 'muted', `: ${entry.why}`));
            return li;
        })
    );
    settingsUpdateButtons();
}

async function settingsLoad() {
    try {
        const { response, data } = await apiJson('/api/settings');
        if (!response.ok) throw new Error(data.error || response.statusText);
        settingsRender(data);
        $('settingsFootnote').textContent = '';
    } catch (error) {
        $('settingsFootnote').textContent = `Could not load settings: ${error.message}`;
    }
}

// changes: { NAME: "value" | null }
async function settingsSave(changes) {
    $('settingsSave').disabled = true;
    try {
        const { response, data } = await apiJson('/api/settings', { method: 'PUT', body: JSON.stringify({ changes }) });
        if (!response.ok) {
            // The reason is shown where it cannot be missed; problems with one value are also shown under it
            const problem = $('settingsProblem');
            problem.textContent = data.error || response.statusText;
            problem.classList.remove('hidden');
            $('settingsFootnote').textContent = '';
            for (const [key, message] of Object.entries(data.details || {})) {
                const entry = settingsInputs.get(key);
                if (!entry) continue;
                entry.error.textContent = message;
                entry.input.classList.add('invalid');
            }
            settingsUpdateButtons();
            return;
        }
        settingsRender(data);
        $('settingsFootnote').textContent = data.changed.length
            ? `Saved ${data.changed.length} setting${data.changed.length === 1 ? '' : 's'}.`
            : 'Nothing changed.';
    } catch (error) {
        $('settingsFootnote').textContent = `Could not save: ${error.message}`;
        settingsUpdateButtons();
    }
}

// Called by showView() each time the page opens
function settingsShow() {
    settingsLoad();
}

window.addEventListener('DOMContentLoaded', () => {
    $('settingsSave').addEventListener('click', () => settingsSave(settingsDirtyEntries()));
    $('settingsDiscard').addEventListener('click', () => {
        if (settingsData) settingsRender(settingsData);
        $('settingsFootnote').textContent = '';
    });
});
