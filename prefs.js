import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Soup from 'gi://Soup';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const PRIM_BASE = 'https://prim.iledefrance-mobilites.fr/marketplace';
const PRIM_NAVITIA_BASE = 'https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia';
const PRIM_API_HEADER = 'apikey';

const DAYS = [
    {value: 1, name: 'Monday'},
    {value: 2, name: 'Tuesday'},
    {value: 3, name: 'Wednesday'},
    {value: 4, name: 'Thursday'},
    {value: 5, name: 'Friday'},
    {value: 6, name: 'Saturday'},
    {value: 7, name: 'Sunday'},
];

function readWatches(settings) {
    try {
        const w = JSON.parse(settings.get_string('watches'));
        return Array.isArray(w) ? w : [];
    } catch (_e) {
        return [];
    }
}

function writeWatches(settings, watches) {
    settings.set_string('watches', JSON.stringify(watches));
}

function removeWatch(settings, id) {
    writeWatches(settings, readWatches(settings).filter(w => w.id !== id));
}

function updateSlot(settings, watchId, index, patch) {
    const watches = readWatches(settings);
    const w = watches.find(x => x.id === watchId);
    if (!w || !Array.isArray(w.showSlots) || !w.showSlots[index])
        return;
    Object.assign(w.showSlots[index], patch);
    writeWatches(settings, watches);
}

function addSlot(settings, watchId, slot) {
    const watches = readWatches(settings);
    const w = watches.find(x => x.id === watchId);
    if (!w)
        return;
    if (!Array.isArray(w.showSlots))
        w.showSlots = [];
    w.showSlots.push(slot);
    writeWatches(settings, watches);
}

function removeSlot(settings, watchId, index) {
    const watches = readWatches(settings);
    const w = watches.find(x => x.id === watchId);
    if (!w || !Array.isArray(w.showSlots))
        return;
    w.showSlots.splice(index, 1);
    writeWatches(settings, watches);
}

function normalizeName(s) {
    return String(s ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function esc(text) {
    return GLib.markup_escape_text(String(text ?? ''), -1);
}

function fmtTime(minutes) {
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
}

function daysSummary(ds) {
    if (!Array.isArray(ds) || ds.length === 0)
        return _('no day');
    if (ds.length === 7)
        return _('every day');
    if (ds.length === 5 && ds.every(d => d <= 5))
        return _('Mon-Fri');
    return ds.map(d => _(DAYS[d - 1].name).slice(0, 3)).join(', ');
}

function slotsSummary(slots) {
    if (!Array.isArray(slots) || slots.length === 0)
        return _('never shown');
    return slots
        .map(s => `${daysSummary(s.days)} ${fmtTime(s.start)}-${fmtTime(s.end)}`)
        .join(' ; ');
}

function dirTypeLabel(t) {
    if (t === 'forward')
        return _('Outbound');
    if (t === 'backward')
        return _('Inbound');
    return '';
}

function defaultWatch(stop, line, direction, siriId) {
    const dirName = direction?.name ?? '';
    return {
        id: `${stop.id}|${line.id}|${normalizeName(dirName)}`,
        stopId: stop.id,
        stopName: stop.name,
        siriId,
        lineId: line.id,
        lineCode: line.code,
        lineName: line.name,
        lineColor: line.color,
        lineTextColor: line.textColor,
        lineMode: line.mode,
        directionName: dirName,
        directionRef: direction?.ref ?? '',
        directionType: direction?.directionType ?? '',
        showSlots: [{days: [1, 2, 3, 4, 5], start: 1020, end: 1200}],
    };
}

function zdaTypeForMode(mode) {
    const m = (mode ?? '').toLowerCase();
    if (m.includes('rer') || m.includes('train') || m.includes('transilien'))
        return 'railStation';
    if (m.includes('métro') || m.includes('metro'))
        return 'metroStation';
    if (m.includes('tram'))
        return 'onstreetTram';
    if (m.includes('funiculaire') || m.includes('câble') || m.includes('cable'))
        return 'liftStation';
    return 'onstreetBus';
}

async function fetchOds(session, url) {
    const message = Soup.Message.new('GET', url);
    if (message === null)
        throw new Error(_('Invalid URL'));
    message.request_headers.append('Accept', 'application/json');
    const bytes = await session.send_and_read_async(
        message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK)
        throw new Error(`${_('HTTP error')} ${message.get_status()}`);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}

async function resolveSiriId(session, stop, line) {
    const num = String(stop.id).split(':').pop();
    const type = zdaTypeForMode(line.mode);
    const where = encodeURIComponent(
        `(zdcid=${num} or zdaid=${num}) and zdatype="${type}"`);
    const url = 'https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/' +
        `datasets/zones-d-arrets/records?where=${where}&select=zdaid&limit=5`;
    try {
        const data = await fetchOds(session, url);
        const zdaid = (data.results ?? [])[0]?.zdaid;
        return zdaid ? String(zdaid) : num;
    } catch (_e) {
        return num;
    }
}

async function fetchJson(session, apiKey, url) {
    const message = Soup.Message.new('GET', url);
    if (message === null)
        throw new Error(_('Invalid URL'));
    message.request_headers.append(PRIM_API_HEADER, apiKey);
    message.request_headers.append('Accept', 'application/json');
    const bytes = await session.send_and_read_async(
        message, GLib.PRIORITY_DEFAULT, null);
    const status = message.get_status();
    if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN)
        throw new Error(_('API key refused'));
    if (status !== Soup.Status.OK)
        throw new Error(`${_('HTTP error')} ${status}`);
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}

async function searchStopAreas(session, apiKey, query) {
    const url = `${PRIM_NAVITIA_BASE}/places?q=${encodeURIComponent(query)}` +
        '&type[]=stop_area&count=15&disable_geojson=true';
    const data = await fetchJson(session, apiKey, url);
    return (data.places ?? [])
        .filter(p => p.embedded_type === 'stop_area')
        .map(p => ({
            id: p.id,
            name: p.name,
            modes: (p.stop_area?.physical_modes ?? []).map(m => m.name).join(', '),
        }));
}

async function fetchStopLines(session, apiKey, stopId) {
    const url = `${PRIM_NAVITIA_BASE}/stop_areas/${encodeURIComponent(stopId)}` +
        '/lines?count=100&depth=2';
    const data = await fetchJson(session, apiKey, url);
    return (data.lines ?? []).map(l => ({
        id: l.id,
        code: l.code || l.name || '?',
        name: l.name ?? '',
        color: l.color || '888888',
        textColor: l.text_color || 'FFFFFF',
        mode: l.commercial_mode?.name ?? '',
    }));
}

async function fetchLineDirections(session, apiKey, lineId) {
    const url = `${PRIM_NAVITIA_BASE}/lines/${encodeURIComponent(lineId)}` +
        '/routes?depth=2&count=50';
    const data = await fetchJson(session, apiKey, url);
    const seen = new Set();
    const directions = [];
    for (const route of data.routes ?? []) {
        const name = route.direction?.name || route.name || '';
        const key = normalizeName(name);
        if (!name || seen.has(key))
            continue;
        seen.add(key);
        directions.push({name, directionType: route.direction_type ?? ''});
    }
    return directions;
}

function lineRefFromId(lineId) {
    return `STIF:Line::${String(lineId).split(':').pop()}:`;
}

async function fetchSiriDirections(session, apiKey, siriId, lineId) {
    const ref = `STIF:StopArea:SP:${siriId}:`;
    const url = `${PRIM_BASE}/stop-monitoring?MonitoringRef=${encodeURIComponent(ref)}` +
        `&LineRef=${encodeURIComponent(lineRefFromId(lineId))}`;
    const data = await fetchJson(session, apiKey, url);
    const delivery = data.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0];
    if (!delivery || String(delivery.Status) === 'false')
        return [];
    const seen = new Map();
    for (const v of delivery.MonitoredStopVisit ?? []) {
        const mvj = v.MonitoredVehicleJourney ?? {};
        const name = (mvj.DestinationName ?? [])[0]?.value ||
            (mvj.DirectionName ?? [])[0]?.value || '';
        if (!name)
            continue;
        const key = normalizeName(name);
        if (!seen.has(key))
            seen.set(key, {name, ref: mvj.DestinationRef?.value ?? '', directionType: ''});
    }
    return [...seen.values()];
}

function chipCss(line) {
    const m = (line.mode || '').toLowerCase();
    let radius = 4;
    const bg = line.color || '888888';
    const fg = line.textColor || 'ffffff';
    if (m.includes('métro') || m.includes('metro'))
        radius = 99;
    else if (m.includes('rer') || m.includes('train') || m.includes('transilien'))
        radius = 6;
    return `.idfm-chip{background-color:#${bg};color:#${fg};font-weight:bold;` +
        `padding:0 4px;border-radius:${radius}px;min-width:20px;}`;
}

function lineChip(line) {
    const label = new Gtk.Label({label: line.code || '?', valign: Gtk.Align.CENTER});
    label.add_css_class('idfm-chip');
    const provider = new Gtk.CssProvider();
    provider.load_from_string(chipCss(line));
    label.get_style_context().add_provider(
        provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    return label;
}

export default class IdfmGnomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 840);
        window._settings = this.getSettings();
        window._session = new Soup.Session({timeout: 15});
        window._closed = false;
        window.connect('close-request', () => {
            window._closed = true;
            window._session.abort();
            return false;
        });

        const apiPage = this._buildApiPage(window);
        window.add(this._buildDeparturesPage(window, apiPage));
        window.add(this._buildDisplayPage(window));
        window.add(apiPage);
        window.set_visible_page(window._departuresPage);
    }

    _toast(window, title) {
        if (window._closed)
            return;
        window.add_toast(new Adw.Toast({title: esc(title), timeout: 4}));
    }

    _buildApiPage(window) {
        const settings = window._settings;
        const page = new Adw.PreferencesPage({
            title: _('API'),
            icon_name: 'dialog-password-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('PRIM API'),
            description: _('Free key from prim.iledefrance-mobilites.fr, under My authentication tokens.'),
        });
        page.add(group);

        const keyRow = new Adw.PasswordEntryRow({title: _('API key')});
        settings.bind('api-key', keyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(keyRow);

        const linkRow = new Adw.ActionRow({
            title: _('Get an API key'),
            subtitle: 'prim.iledefrance-mobilites.fr',
            activatable: true,
        });
        linkRow.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        linkRow.connect('activated', () => {
            new Gtk.UriLauncher({uri: 'https://prim.iledefrance-mobilites.fr/'})
                .launch(window, null, null);
        });
        group.add(linkRow);

        return page;
    }

    _buildDisplayPage(window) {
        const settings = window._settings;
        const page = new Adw.PreferencesPage({
            title: _('Display'),
            icon_name: 'video-display-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: _('General')});
        page.add(group);

        for (const [key, title, subtitle, lower, upper, step] of [
            ['refresh-interval', _('Refresh interval'), _('seconds'), 15, 600, 15],
            ['max-departures', _('Departures per line in the menu'), null, 1, 10, 1],
            ['panel-departures', _('Departures shown in the top bar'), null, 1, 4, 1],
            ['panel-rotate-interval', _('Rotation duration'),
                _('seconds before switching to the next line'), 2, 60, 1],
        ]) {
            const row = new Adw.SpinRow({
                title,
                subtitle: subtitle ?? '',
                adjustment: new Gtk.Adjustment({
                    lower, upper, step_increment: step, value: settings.get_int(key),
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }

        const animations = [
            ['slide-down', _('Slide down')],
            ['slide-up', _('Slide up')],
            ['slide-left', _('Slide left')],
            ['slide-right', _('Slide right')],
            ['fade', _('Fade')],
            ['none', _('None')],
        ];
        const animRow = new Adw.ComboRow({
            title: _('Rotation animation'),
            model: Gtk.StringList.new(animations.map(a => a[1])),
            selected: Math.max(0, animations.findIndex(
                a => a[0] === settings.get_string('panel-rotate-animation'))),
        });
        animRow.connect('notify::selected', () => {
            settings.set_string('panel-rotate-animation', animations[animRow.selected][0]);
        });
        group.add(animRow);

        const hideRow = new Adw.SwitchRow({
            title: _('Hide the icon when idle'),
            subtitle: _('Lines still appear during their period'),
        });
        settings.bind('hide-idle-icon', hideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(hideRow);

        const hl = new Adw.PreferencesGroup({title: _('Imminent departures')});
        page.add(hl);

        const hlSwitch = new Adw.SwitchRow({title: _('Highlight in red')});
        settings.bind('highlight-enabled', hlSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        hl.add(hlSwitch);

        const threshold = new Adw.SpinRow({
            title: _('Threshold (minutes)'),
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 30, step_increment: 1,
                value: settings.get_int('highlight-threshold'),
            }),
        });
        settings.bind('highlight-threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);
        hl.add(threshold);

        const blinkSwitch = new Adw.SwitchRow({title: _('Blink')});
        settings.bind('blink-enabled', blinkSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        hl.add(blinkSwitch);

        const blinkStyles = [['smooth', _('Smooth')], ['strong', _('Strong')]];
        const styleRow = new Adw.ComboRow({
            title: _('Blink style'),
            model: Gtk.StringList.new(blinkStyles.map(s => s[1])),
            selected: Math.max(0, blinkStyles.findIndex(
                s => s[0] === settings.get_string('blink-style'))),
        });
        styleRow.connect('notify::selected', () =>
            settings.set_string('blink-style', blinkStyles[styleRow.selected][0]));
        hl.add(styleRow);

        const speed = new Adw.SpinRow({
            title: _('Blink speed (ms)'),
            adjustment: new Gtk.Adjustment({
                lower: 200, upper: 3000, step_increment: 100,
                value: settings.get_int('blink-interval'),
            }),
        });
        settings.bind('blink-interval', speed, 'value', Gio.SettingsBindFlags.DEFAULT);
        hl.add(speed);

        hlSwitch.bind_property('active', threshold, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        hlSwitch.bind_property('active', blinkSwitch, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        blinkSwitch.bind_property('active', styleRow, 'sensitive', GObject.BindingFlags.SYNC_CREATE);
        blinkSwitch.bind_property('active', speed, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        return page;
    }

    _buildDeparturesPage(window, apiPage) {
        const settings = window._settings;
        const page = new Adw.PreferencesPage({
            title: _('Next departures'),
            icon_name: 'mark-location-symbolic',
        });
        window._departuresPage = page;
        this._stopGroups = [];

        const keyGroup = new Adw.PreferencesGroup();
        const keyRow = new Adw.ActionRow({
            title: _('No API key set'),
            subtitle: _('Add it in the API tab.'),
        });
        const goButton = new Gtk.Button({
            label: _('API'),
            valign: Gtk.Align.CENTER,
        });
        goButton.connect('clicked', () => window.set_visible_page(apiPage));
        keyRow.add_suffix(goButton);
        keyGroup.add(keyRow);
        page.add(keyGroup);

        const syncKey = () => {
            keyGroup.visible = settings.get_string('api-key').length === 0;
        };
        window._apiKeyId = settings.connect('changed::api-key', syncKey);
        syncKey();

        const addGroup = new Adw.PreferencesGroup({
            title: _('Next departures'),
            description: _('One stop, one line, one direction.'),
        });
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: _('Add')}),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._openAssistant(window));
        addGroup.set_header_suffix(addButton);
        page.add(addGroup);

        window._watchesId = settings.connect('changed::watches',
            () => this._rebuildWatches(window));
        window.connect('close-request', () => {
            if (window._apiKeyId) {
                settings.disconnect(window._apiKeyId);
                window._apiKeyId = 0;
            }
            if (window._watchesId) {
                settings.disconnect(window._watchesId);
                window._watchesId = 0;
            }
            return false;
        });
        this._rebuildWatches(window);

        return page;
    }

    _rebuildWatches(window) {
        for (const g of this._stopGroups)
            window._departuresPage.remove(g);
        this._stopGroups = [];

        const watches = readWatches(window._settings);
        if (watches.length === 0) {
            const group = new Adw.PreferencesGroup();
            group.add(new Adw.ActionRow({
                title: _('Nothing yet'),
                subtitle: _('Use the Add button above.'),
            }));
            window._departuresPage.add(group);
            this._stopGroups.push(group);
            return;
        }

        const groups = new Map();
        for (const w of watches) {
            if (!groups.has(w.stopId))
                groups.set(w.stopId, {name: w.stopName, list: []});
            groups.get(w.stopId).list.push(w);
        }
        for (const {name, list} of groups.values()) {
            const group = new Adw.PreferencesGroup({title: esc(name)});
            for (const watch of list)
                group.add(this._buildWatchRow(window, watch));
            window._departuresPage.add(group);
            this._stopGroups.push(group);
        }
    }

    _buildWatchRow(window, watch) {
        const settings = window._settings;
        const row = new Adw.ActionRow({
            title: esc(watch.directionName
                ? `${watch.lineMode} ${watch.lineCode} → ${watch.directionName}`
                : `${watch.lineMode} ${watch.lineCode}`),
            subtitle: esc(slotsSummary(watch.showSlots)),
            activatable: true,
        });
        row.add_prefix(lineChip({
            code: watch.lineCode, color: watch.lineColor,
            textColor: watch.lineTextColor, mode: watch.lineMode,
        }));
        row.connect('activated', () => this._openSlotEditor(window, watch));

        const editButton = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Edit schedule'),
        });
        editButton.connect('clicked', () => this._openSlotEditor(window, watch));
        row.add_suffix(editButton);

        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Remove'),
        });
        removeButton.connect('clicked', () => {
            removeWatch(settings, watch.id);
            this._toast(window, _('Removed'));
        });
        row.add_suffix(removeButton);

        return row;
    }

    _openSlotEditor(window, watch) {
        const settings = window._settings;
        const page = new Adw.PreferencesPage();
        const toolbar = new Adw.ToolbarView({content: page});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            title: watch.directionName
                ? `${watch.lineCode} → ${watch.directionName}` : watch.lineCode,
            default_width: 540,
            default_height: 580,
            content: toolbar,
        });

        const addGroup = new Adw.PreferencesGroup({title: _('Display schedule')});
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: _('Add a slot')}),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        addGroup.set_header_suffix(addButton);
        page.add(addGroup);

        let slotGroups = [];
        const fill = () => {
            for (const g of slotGroups)
                page.remove(g);
            slotGroups = [];

            const w = readWatches(settings).find(x => x.id === watch.id);
            if (!w) {
                dialog.close();
                return;
            }
            const slots = w.showSlots ?? [];
            if (slots.length === 0) {
                const g = new Adw.PreferencesGroup();
                g.add(new Adw.ActionRow({
                    title: _('No slot'),
                    subtitle: _('This line will never show. Add one.'),
                }));
                page.add(g);
                slotGroups.push(g);
                return;
            }
            slots.forEach((slot, index) => {
                const g = new Adw.PreferencesGroup({title: `${_('Slot')} ${index + 1}`});
                const rm = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Remove this slot'),
                });
                rm.connect('clicked', () => {
                    removeSlot(settings, watch.id, index);
                    fill();
                });
                g.set_header_suffix(rm);
                g.add(this._slotDaysRow(settings, watch.id, index, slot));
                g.add(this._slotTimeRow(settings, watch.id, index, slot, 'start', _('Start')));
                g.add(this._slotTimeRow(settings, watch.id, index, slot, 'end', _('End')));
                page.add(g);
                slotGroups.push(g);
            });
        };

        addButton.connect('clicked', () => {
            addSlot(settings, watch.id, {days: [1, 2, 3, 4, 5], start: 1020, end: 1140});
            fill();
        });

        fill();
        dialog.present();
    }

    _slotDaysRow(settings, watchId, index, slot) {
        const row = new Adw.ActionRow({title: _('Days')});
        const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
        const active = new Set(slot.days);
        for (const day of DAYS) {
            const name = _(day.name);
            const toggle = new Gtk.ToggleButton({
                label: name.charAt(0),
                active: active.has(day.value),
                tooltip_text: name,
                css_classes: ['circular'],
            });
            toggle.connect('toggled', () => {
                if (toggle.active)
                    active.add(day.value);
                else
                    active.delete(day.value);
                updateSlot(settings, watchId, index, {days: [...active].sort((a, b) => a - b)});
            });
            box.append(toggle);
        }
        row.add_suffix(box);
        return row;
    }

    _slotTimeRow(settings, watchId, index, slot, field, title) {
        const row = new Adw.ActionRow({title});
        const value = slot[field];
        const hourSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 23, step_increment: 1, value: Math.floor(value / 60),
            }),
            valign: Gtk.Align.CENTER, numeric: true,
        });
        const minuteSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 59, step_increment: 5, value: value % 60,
            }),
            valign: Gtk.Align.CENTER, numeric: true,
        });
        const save = () => updateSlot(settings, watchId, index,
            {[field]: hourSpin.get_value_as_int() * 60 + minuteSpin.get_value_as_int()});
        hourSpin.connect('value-changed', save);
        minuteSpin.connect('value-changed', save);
        const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
        box.append(hourSpin);
        box.append(new Gtk.Label({label: 'h'}));
        box.append(minuteSpin);
        row.add_suffix(box);
        return row;
    }

    _openAssistant(window) {
        const settings = window._settings;
        const apiKey = settings.get_string('api-key');
        if (!apiKey) {
            this._toast(window, _('Enter your API key first (API tab)'));
            return;
        }

        const nav = new Adw.NavigationView();
        const dialog = new Adw.Window({
            modal: true,
            transient_for: window,
            title: _('Add'),
            default_width: 500,
            default_height: 620,
            content: nav,
        });
        dialog._closed = false;
        dialog.connect('close-request', () => {
            dialog._closed = true;
            return false;
        });

        nav.push(this._stopPage(window, apiKey, nav, dialog));
        dialog.present();
    }

    _dead(window, dialog) {
        return window._closed || dialog._closed;
    }

    _makeList() {
        return new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
            valign: Gtk.Align.START,
        });
    }

    _clearList(list) {
        let c;
        while ((c = list.get_first_child()) !== null)
            list.remove(c);
    }

    _spinnerRow() {
        const spinner = new Gtk.Spinner({
            halign: Gtk.Align.CENTER, margin_top: 20, margin_bottom: 20,
        });
        spinner.start();
        return new Gtk.ListBoxRow({selectable: false, activatable: false, child: spinner});
    }

    _listPage(title, list) {
        const scrolled = new Gtk.ScrolledWindow({child: list, vexpand: true});
        const toolbar = new Adw.ToolbarView({content: scrolled});
        toolbar.add_top_bar(new Adw.HeaderBar());
        return new Adw.NavigationPage({title, child: toolbar});
    }

    _stopPage(window, apiKey, nav, dialog) {
        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Stop name (station, stop)'),
            margin_top: 12, margin_start: 12, margin_end: 12,
        });
        const list = this._makeList();
        list.margin_top = 6;

        const run = () => {
            const query = searchEntry.text.trim();
            if (!query || !searchEntry.sensitive)
                return;
            searchEntry.sensitive = false;
            this._clearList(list);
            list.append(this._spinnerRow());
            searchStopAreas(window._session, apiKey, query).then(places => {
                if (this._dead(window, dialog))
                    return;
                this._clearList(list);
                if (places.length === 0) {
                    list.append(new Adw.ActionRow({title: _('No stop found')}));
                    return;
                }
                for (const place of places) {
                    const row = new Adw.ActionRow({
                        title: esc(place.name),
                        subtitle: esc(place.modes),
                        activatable: true,
                    });
                    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                    row.connect('activated', () =>
                        nav.push(this._linePage(window, apiKey, nav, dialog, place)));
                    list.append(row);
                }
            }).catch(e => {
                if (this._dead(window, dialog))
                    return;
                this._clearList(list);
                list.append(new Adw.ActionRow({title: `${_('Error')}: ${esc(e.message)}`}));
            }).finally(() => {
                if (!this._dead(window, dialog))
                    searchEntry.sensitive = true;
            });
        };
        searchEntry.connect('activate', run);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(searchEntry);
        box.append(new Gtk.ScrolledWindow({child: list, vexpand: true}));
        const toolbar = new Adw.ToolbarView({content: box});
        toolbar.add_top_bar(new Adw.HeaderBar());
        return new Adw.NavigationPage({title: _('Stop'), child: toolbar});
    }

    _linePage(window, apiKey, nav, dialog, stop) {
        const list = this._makeList();
        list.append(this._spinnerRow());

        fetchStopLines(window._session, apiKey, stop.id).then(lines => {
            if (this._dead(window, dialog))
                return;
            this._clearList(list);
            if (lines.length === 0) {
                list.append(new Adw.ActionRow({title: _('No line at this stop')}));
                return;
            }
            lines.sort((a, b) => (a.mode + a.code).localeCompare(b.mode + b.code));
            for (const line of lines) {
                const row = new Adw.ActionRow({
                    title: esc(line.mode ? `${line.mode} ${line.code}` : line.code),
                    subtitle: esc(line.name),
                    activatable: true,
                });
                row.add_prefix(lineChip(line));
                row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                row.connect('activated', () =>
                    nav.push(this._directionPage(window, apiKey, nav, dialog, stop, line)));
                list.append(row);
            }
        }).catch(e => {
            if (this._dead(window, dialog))
                return;
            this._clearList(list);
            list.append(new Adw.ActionRow({title: `${_('Error')}: ${esc(e.message)}`}));
        });

        return this._listPage(stop.name, list);
    }

    _directionPage(window, apiKey, nav, dialog, stop, line) {
        const settings = window._settings;
        const list = this._makeList();
        list.append(this._spinnerRow());

        const build = (siriId, dirs) => {
            this._clearList(list);
            const create = direction => {
                const watches = readWatches(settings);
                const watch = defaultWatch(stop, line, direction, siriId);
                if (watches.some(w => w.id === watch.id)) {
                    this._toast(window, _('Already added'));
                } else {
                    watches.push(watch);
                    writeWatches(settings, watches);
                    this._toast(window, _('Added'));
                }
                dialog.close();
            };

            if (dirs.length === 0) {
                list.append(new Adw.ActionRow({
                    title: _('Directions unavailable'),
                    subtitle: _('Try again later.'),
                }));
                return;
            }
            for (const dir of dirs) {
                const row = new Adw.ActionRow({
                    title: esc(`→ ${dir.name}`),
                    subtitle: esc(dirTypeLabel(dir.directionType)),
                    activatable: true,
                });
                row.add_prefix(lineChip(line));
                row.connect('activated', () => create(dir));
                list.append(row);
            }
        };

        (async () => {
            const siriId = await resolveSiriId(window._session, stop, line);
            if (this._dead(window, dialog))
                return;
            let dirs = await fetchSiriDirections(window._session, apiKey, siriId, line.id)
                .catch(() => []);
            if (dirs.length === 0)
                dirs = await fetchLineDirections(window._session, apiKey, line.id)
                    .catch(() => []);
            if (this._dead(window, dialog))
                return;
            build(siriId, dirs);
        })().catch(() => {
            if (!this._dead(window, dialog))
                build(String(stop.id).split(':').pop(), []);
        });

        return this._listPage(_('Direction'), list);
    }
}
