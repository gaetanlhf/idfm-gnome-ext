import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const PRIM_BASE = 'https://prim.iledefrance-mobilites.fr/marketplace';
const PRIM_API_HEADER = 'apikey';
const TICK_SECONDS = 10;

function normalizeWatch(w) {
    if (!Array.isArray(w.showSlots)) {
        w.showSlots = Array.isArray(w.showDays)
            ? [{days: w.showDays, start: w.showStart ?? 1020, end: w.showEnd ?? 1200}]
            : [{days: [1, 2, 3, 4, 5], start: 1020, end: 1200}];
    }
    if (!w.siriId)
        w.siriId = String(w.stopId).split(':').pop();
    return w;
}

function readWatches(settings) {
    try {
        const w = JSON.parse(settings.get_string('watches'));
        return Array.isArray(w) ? w.map(normalizeWatch) : [];
    } catch (_e) {
        return [];
    }
}

function groupWatchesByStop(watches) {
    const stops = new Map();
    for (const w of watches) {
        if (!stops.has(w.stopId))
            stops.set(w.stopId, {name: w.stopName, watches: []});
        stops.get(w.stopId).watches.push(w);
    }
    return [...stops.values()];
}

function siriRef(id) {
    return `STIF:StopArea:SP:${id}:`;
}

function lineIdFromRef(lineRef) {
    const m = /::([^:]+):?$/.exec(lineRef ?? '');
    return m ? `line:IDFM:${m[1]}` : '';
}

function firstValue(field) {
    return field?.[0]?.value ?? '';
}

function normalizeName(s) {
    return String(s ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const DIR_STOP = new Set(
    ['gare', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'aux', 'au', 'sur', 'a']);

function dirTokens(normalized) {
    return new Set(normalized.split(' ').filter(w => w && !DIR_STOP.has(w)));
}

function directionMatches(watch, dep) {
    if (!watch.directionName && !watch.directionRef)
        return true;
    if (watch.directionRef && dep.destRef && watch.directionRef === dep.destRef)
        return true;
    const want = dirTokens(normalizeName(watch.directionName));
    if (want.size === 0)
        return true;
    return (dep.dirKeys ?? []).some(k => {
        const got = dirTokens(k);
        if (got.size === 0)
            return false;
        const [small, large] = want.size <= got.size ? [want, got] : [got, want];
        for (const w of small) {
            if (!large.has(w))
                return false;
        }
        return true;
    });
}

function scheduleActive(days, start, end, now) {
    if (!Array.isArray(days) || !days.includes(now.get_day_of_week()))
        return false;
    const m = now.get_hour() * 60 + now.get_minute();
    return start <= end ? m >= start && m <= end : m >= start || m <= end;
}

function displayActive(watch, now) {
    return Array.isArray(watch.showSlots) &&
        watch.showSlots.some(s => scheduleActive(s.days, s.start, s.end, now));
}

function minutesUntil(time, now) {
    return Math.floor(time.difference(now) / GLib.TIME_SPAN_MINUTE);
}

function waitMinutes(dep, now) {
    return dep.atStop ? 0 : minutesUntil(dep.time, now);
}

function shortWait(dep, now) {
    const mins = waitMinutes(dep, now);
    if (mins <= 0)
        return '0′';
    return mins > 60 ? dep.time.format('%H:%M') : `${mins}′`;
}

function longWait(dep, now) {
    const mins = waitMinutes(dep, now);
    if (mins <= 0)
        return '0 min';
    return mins > 60 ? dep.time.format('%H:%M') : `${mins} min`;
}

function badgeAppearance(mode, color, textColor) {
    const m = (mode ?? '').toLowerCase();
    const bg = `#${color || '6e6e6e'}`;
    const fg = `#${textColor || 'FFFFFF'}`;
    if (m.includes('métro') || m.includes('metro'))
        return ['idfm-gnome-badge-metro', `background-color: ${bg}; color: ${fg};`];
    if (m.includes('rer') || m.includes('train') || m.includes('transilien'))
        return ['idfm-gnome-badge-rer', `background-color: ${bg}; color: ${fg};`];
    if (m.includes('tram') || m.includes('câble') || m.includes('cable') ||
        m.includes('funiculaire'))
        return ['idfm-gnome-badge-tram', `background-color: ${bg}; color: ${fg};`];
    return ['idfm-gnome-badge-bus', `background-color: ${bg}; color: ${fg};`];
}

function makeBadge(watch, extraClass = '') {
    const [badgeClass, style] = badgeAppearance(
        watch.lineMode, watch.lineColor, watch.lineTextColor);
    return new St.Label({
        text: watch.lineCode || '?',
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
        style_class: `idfm-gnome-line-badge ${badgeClass} ${extraClass}`.trim(),
        style,
    });
}

class IdfmClient {
    constructor(apiKey) {
        this._apiKey = apiKey;
        this._session = new Soup.Session({timeout: 15});
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    async _getJson(url, cancellable) {
        const message = Soup.Message.new('GET', url);
        if (message === null)
            throw new Error(_('Invalid URL'));
        message.request_headers.append(PRIM_API_HEADER, this._apiKey);
        message.request_headers.append('Accept', 'application/json');
        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED || status === Soup.Status.FORBIDDEN)
            throw new Error(_('API key refused'));
        if (status === 429)
            throw new Error(_('PRIM quota exceeded'));
        if (status !== Soup.Status.OK)
            throw new Error(`${_('HTTP error')} ${status}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    async getStopDepartures(stopId, stopName, cancellable) {
        const url = `${PRIM_BASE}/stop-monitoring?MonitoringRef=` +
            encodeURIComponent(siriRef(stopId));
        const data = await this._getJson(url, cancellable);

        const delivery = data.Siri?.ServiceDelivery?.StopMonitoringDelivery?.[0];
        if (!delivery)
            throw new Error(_('Unexpected response'));
        if (String(delivery.Status) === 'false') {
            throw new Error(delivery.ErrorCondition?.ErrorInformation?.ErrorText ??
                _('Stop unknown to the realtime service'));
        }

        const stopKey = normalizeName(stopName);
        const now = GLib.DateTime.new_now_local();
        const departures = [];

        for (const visit of delivery.MonitoredStopVisit ?? []) {
            const mvj = visit.MonitoredVehicleJourney ?? {};
            const call = mvj.MonitoredCall ?? {};
            if (call.DepartureStatus === 'cancelled' || call.ArrivalStatus === 'cancelled')
                continue;

            const destName = firstValue(mvj.DestinationName);
            const dirName = firstValue(mvj.DirectionName);
            const destDisplay = firstValue(call.DestinationDisplay);

            const hasDeparture = Boolean(
                call.ExpectedDepartureTime || call.AimedDepartureTime);
            if (!hasDeparture && stopKey && normalizeName(destName) === stopKey)
                continue;

            const rawTime = call.ExpectedDepartureTime || call.AimedDepartureTime ||
                call.ExpectedArrivalTime || call.AimedArrivalTime;
            if (!rawTime)
                continue;
            const time = GLib.DateTime.new_from_iso8601(rawTime, null)?.to_local() ?? null;
            const atStop = call.VehicleAtStop === true;
            if (!time || (!atStop && time.difference(now) < -GLib.TIME_SPAN_MINUTE))
                continue;

            departures.push({
                lineId: lineIdFromRef(mvj.LineRef?.value),
                direction: destName || dirName || destDisplay,
                destRef: mvj.DestinationRef?.value ?? '',
                dirKeys: [normalizeName(destName), normalizeName(dirName),
                    normalizeName(destDisplay)].filter(Boolean),
                time,
                atStop,
                realtime: Boolean(call.ExpectedDepartureTime || call.ExpectedArrivalTime),
            });
        }

        departures.sort((a, b) => a.time.compare(b.time));
        return departures;
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'IDFM GNOME');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = null;
        this._cancellable = new Gio.Cancellable();

        this._tickId = 0;
        this._rotateId = 0;
        this._resetTimeoutId = 0;
        this._pendingStops = new Map();
        this._draining = false;
        this._lastFetch = null;
        this._lastAttempt = null;
        this._errorStreak = 0;

        this._stopData = new Map();
        this._scheduleActiveWatches = [];
        this._displayActiveWatches = [];
        this._panelIndex = 0;

        this._blinkId = 0;
        this._blinkPhase = false;
        this._blinkMenu = [];
        this._blinkPanel = [];

        this._panelBox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._panelBox);

        this._section = new PopupMenu.PopupMenuSection();
        this._menuBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'idfm-gnome-menu',
        });
        this._section.actor.add_child(this._menuBox);
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._updatedItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            style_class: 'idfm-gnome-updated',
        });
        this.menu.addMenuItem(this._updatedItem);

        const footer = new PopupMenu.PopupBaseMenuItem(
            {reactive: false, can_focus: false});
        footer.add_style_class_name('idfm-gnome-footer');
        footer.add_child(this._actionButton(
            'view-refresh-symbolic', _('Refresh'), () => this._forceFetch()));
        footer.add_child(this._actionButton(
            'preferences-system-symbolic', _('Preferences'), () => {
                this.menu.close();
                this._extension.openPreferences();
            }));
        this.menu.addMenuItem(footer);

        this._scrollHandler = this.connect('scroll-event', (_a, event) => {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP)
                this._advancePanel(-1);
            else if (dir === Clutter.ScrollDirection.DOWN)
                this._advancePanel(1);
            return Clutter.EVENT_STOP;
        });

        this._menuHandler = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._forceFetch();
        });

        this._settingsHandlers = [
            this._settings.connect('changed::api-key', () => this._reset()),
            this._settings.connect('changed::watches', () => this._reset()),
            this._settings.connect('changed::refresh-interval', () => this._forceFetch()),
            this._settings.connect('changed::max-departures', () => this._render()),
            this._settings.connect('changed::panel-departures', () => this._renderPanel(false)),
            this._settings.connect('changed::panel-rotate-interval', () => this._scheduleRotation()),
            this._settings.connect('changed::hide-idle-icon', () => this._evaluate()),
            this._settings.connect('changed::highlight-enabled', () => this._render()),
            this._settings.connect('changed::highlight-threshold', () => this._render()),
            this._settings.connect('changed::blink-enabled', () => {
                this._startBlink();
                this._render();
            }),
            this._settings.connect('changed::blink-interval', () => this._startBlink()),
            this._settings.connect('changed::blink-style', () => this._render()),
        ];

        this._reset();
    }

    _reset() {
        if (this._resetTimeoutId)
            GLib.source_remove(this._resetTimeoutId);
        this._resetTimeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._resetTimeoutId = 0;
                this._client?.destroy();
                this._client = new IdfmClient(this._settings.get_string('api-key'));
                this._stopData.clear();
                this._pendingStops.clear();
                this._lastFetch = null;
                this._lastAttempt = null;
                this._errorStreak = 0;
                this._scheduleTick();
                this._scheduleRotation();
                this._startBlink();
                if (this.menu.isOpen)
                    this._forceFetch();
                else
                    this._evaluate();
                return GLib.SOURCE_REMOVE;
            });
    }

    _scheduleTick() {
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
                this._evaluate();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _scheduleRotation() {
        if (this._rotateId)
            GLib.source_remove(this._rotateId);
        this._rotateId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._settings.get_int('panel-rotate-interval'), () => {
                if (this._displayActiveWatches.length > 1)
                    this._advancePanel(1);
                return GLib.SOURCE_CONTINUE;
            });
    }

    _advancePanel(delta) {
        const n = this._displayActiveWatches.length;
        if (n === 0)
            return;
        this._panelIndex = (this._panelIndex + delta + n) % n;
        this._renderPanel(true);
    }

    _stopsOf(watches) {
        const m = new Map();
        for (const w of watches) {
            if (!m.has(w.siriId))
                m.set(w.siriId, w.stopName);
        }
        return [...m.entries()].map(([id, name]) => ({id, name}));
    }

    _refreshActive() {
        const now = GLib.DateTime.new_now_local();
        const watches = readWatches(this._settings);
        const hasKey = this._settings.get_string('api-key').length > 0;

        const ordered = groupWatchesByStop(watches).flatMap(s => s.watches);

        this._scheduleActiveWatches = ordered.filter(w => displayActive(w, now));

        this._displayActiveWatches = this._scheduleActiveWatches.filter(w => {
            const {departures, error, loaded} = this._departuresForWatch(w);
            return !loaded || error || departures.length > 0;
        });

        const anyActive = this._scheduleActiveWatches.length > 0;
        const hideIdle = this._settings.get_boolean('hide-idle-icon');
        const visible = hasKey && watches.length > 0 && (anyActive || !hideIdle);
        if (!visible && this.menu.isOpen)
            this.menu.close();
        this.visible = visible;

        if (this._panelIndex >= this._displayActiveWatches.length)
            this._panelIndex = 0;
    }

    _forceFetch() {
        this._refreshActive();
        this._requestFetch(this._stopsOf(readWatches(this._settings)));
        this._render();
    }

    _evaluate() {
        if (!this._client)
            return;
        this._refreshActive();

        const hasKey = this._settings.get_string('api-key').length > 0;
        if (hasKey && this._scheduleActiveWatches.length > 0) {
            const now = GLib.DateTime.new_now_local();
            const interval = this._settings.get_int('refresh-interval');
            const eff = this._errorStreak > 0
                ? Math.min(interval * (2 ** this._errorStreak), 900)
                : interval;
            const due = !this._lastAttempt ||
                now.difference(this._lastAttempt) >= eff * GLib.TIME_SPAN_SECOND;
            if (due)
                this._requestFetch(this._stopsOf(this._scheduleActiveWatches));
        }
        this._render();
    }

    _requestFetch(stops) {
        if (stops.length === 0)
            return;
        for (const s of stops)
            this._pendingStops.set(s.id, s.name);
        if (this._client)
            this._drain().catch(e => logError(e, 'idfm-gnome'));
    }

    async _drain() {
        if (this._draining)
            return;
        this._draining = true;
        try {
            while (this._client && this._pendingStops.size > 0) {
                const [id, name] = this._pendingStops.entries().next().value;
                this._pendingStops.delete(id);
                try {
                    const deps = await this._client.getStopDepartures(
                        id, name, this._cancellable);
                    const now = GLib.DateTime.new_now_local();
                    this._stopData.set(id, {departures: deps, error: null, ts: now});
                    this._lastFetch = now;
                    this._lastAttempt = now;
                    this._errorStreak = 0;
                } catch (e) {
                    if (!this._client)
                        break;
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        if (readWatches(this._settings).some(w => w.siriId === id))
                            this._pendingStops.set(id, name);
                        continue;
                    }
                    this._lastAttempt = GLib.DateTime.new_now_local();
                    this._errorStreak++;
                    this._stopData.set(id,
                        {departures: [], error: e.message, ts: this._lastAttempt});
                }
                this._render();
            }
        } finally {
            this._draining = false;
        }
    }

    _departuresForWatch(watch) {
        const data = this._stopData.get(watch.siriId);
        if (!data)
            return {departures: [], error: null, loaded: false};
        if (data.error)
            return {departures: [], error: data.error, loaded: true};
        const departures = data.departures.filter(
            d => d.lineId === watch.lineId && directionMatches(watch, d));
        return {departures, error: null, loaded: true};
    }

    _render() {
        this._refreshActive();
        this._renderMenu();
        this._renderPanel(false);
    }

    _renderPanel(animated) {
        this._blinkPanel = [];
        const active = this._displayActiveWatches;
        if (active.length === 0) {
            const child = this._panelBox.get_first_child();
            if (!child || !child._idfmIcon) {
                this._panelBox.destroy_all_children();
                const icon = new St.Icon({
                    gicon: Gio.icon_new_for_string(
                        `${this._extension.path}/icons/idfm-symbolic.svg`),
                    style_class: 'system-status-icon',
                });
                icon._idfmIcon = true;
                this._panelBox.add_child(icon);
            }
            return;
        }

        const watch = active[this._panelIndex % active.length];
        const now = GLib.DateTime.new_now_local();
        const {departures, error, loaded} = this._departuresForWatch(watch);

        const content = new St.BoxLayout({style_class: 'idfm-gnome-panel-item'});
        content.add_child(makeBadge(watch, 'idfm-gnome-panel-badge'));

        const minutesBox = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        content.add_child(minutesBox);

        const plain = text => new St.Label({
            text,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'idfm-gnome-panel-minutes',
        });

        if (error)
            minutesBox.add_child(plain('⚠'));
        else if (!loaded)
            minutesBox.add_child(plain('…'));
        else if (departures.length === 0)
            minutesBox.add_child(plain('—'));
        else {
            const n = this._settings.get_int('panel-departures');
            departures.slice(0, n).forEach((d, i) => {
                if (i > 0)
                    minutesBox.add_child(plain(' · '));
                const hot = this._highlighted(d, now);
                const label = new St.Label({
                    text: shortWait(d, now),
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: hot
                        ? 'idfm-gnome-panel-imminent' : 'idfm-gnome-panel-minutes',
                });
                if (hot)
                    this._registerBlink(label, this._blinkPanel);
                minutesBox.add_child(label);
            });
        }

        this._swapPanel(content, animated
            ? this._settings.get_string('panel-rotate-animation') : 'none');
    }

    _swapPanel(content, animation) {
        this._panelBox.destroy_all_children();
        this._panelBox.add_child(content);
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        content.opacity = 0;
        switch (animation) {
        case 'slide-down':
            content.translation_y = -14;
            content.ease({translation_y: 0, opacity: 255, duration: 180, mode});
            break;
        case 'slide-up':
            content.translation_y = 14;
            content.ease({translation_y: 0, opacity: 255, duration: 180, mode});
            break;
        case 'slide-left':
            content.translation_x = 14;
            content.ease({translation_x: 0, opacity: 255, duration: 180, mode});
            break;
        case 'slide-right':
            content.translation_x = -14;
            content.ease({translation_x: 0, opacity: 255, duration: 180, mode});
            break;
        case 'fade':
            content.ease({opacity: 255, duration: 150});
            break;
        default:
            content.opacity = 255;
        }
    }

    _renderMenu() {
        this._blinkMenu = [];
        this._menuBox.destroy_all_children();
        const now = GLib.DateTime.new_now_local();
        const watches = readWatches(this._settings);

        if (watches.length === 0) {
            this._addStatus(_('Nothing configured. Open preferences to add a line.'));
            this._updatedItem.label.text = '';
            return;
        }

        const maxDep = this._settings.get_int('max-departures');

        let firstStop = true;
        for (const stop of groupWatchesByStop(watches)) {
            if (!firstStop)
                this._addSeparator();
            firstStop = false;
            this._menuBox.add_child(new St.Label({
                text: stop.name,
                style_class: 'idfm-gnome-stop-header',
            }));

            stop.watches.forEach((watch, i) => {
                if (i > 0)
                    this._addLineDivider();
                const watchBox = new St.BoxLayout({
                    x_expand: true,
                    style_class: 'idfm-gnome-watch idfm-gnome-row',
                });
                watchBox.add_child(makeBadge(watch));
                if (watch.directionName) {
                    watchBox.add_child(new St.Label({
                        text: '→',
                        y_align: Clutter.ActorAlign.CENTER,
                    }));
                    watchBox.add_child(new St.Label({
                        text: watch.directionName,
                        y_align: Clutter.ActorAlign.CENTER,
                        x_expand: true,
                        style_class: 'idfm-gnome-direction',
                    }));
                } else {
                    watchBox.add_child(new St.Label({
                        text: _('all directions'),
                        y_align: Clutter.ActorAlign.CENTER,
                        x_expand: true,
                        style_class: 'idfm-gnome-direction',
                    }));
                }
                this._menuBox.add_child(watchBox);

                const {departures, error, loaded} = this._departuresForWatch(watch);
                if (error)
                    this._addStatus(error);
                else if (!loaded)
                    this._addStatus(_('Loading…'));
                else if (departures.length === 0)
                    this._addStatus(_('No upcoming departures'));
                else {
                    for (const dep of departures.slice(0, maxDep))
                        this._menuBox.add_child(this._makeDepartureItem(dep, now));
                }
            });
        }

        this._updatedItem.label.text = this._lastFetch
            ? `${_('Updated at')} ${this._lastFetch.format('%H:%M:%S')}` : '';
    }

    _highlighted(dep, now) {
        return this._settings.get_boolean('highlight-enabled') &&
            waitMinutes(dep, now) <= this._settings.get_int('highlight-threshold');
    }

    _registerBlink(actor, list) {
        if (!this._settings.get_boolean('blink-enabled'))
            return;
        list.push(actor);
        const strong = this._settings.get_string('blink-style') === 'strong';
        actor.opacity = this._blinkPhase ? (strong ? 0 : 110) : 255;
    }

    _startBlink() {
        if (this._blinkId) {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
        }
        if (!this._settings.get_boolean('blink-enabled'))
            return;
        const half = Math.max(100,
            Math.floor(this._settings.get_int('blink-interval') / 2));
        this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, half, () => {
            this._blinkPhase = !this._blinkPhase;
            const strong = this._settings.get_string('blink-style') === 'strong';
            const target = this._blinkPhase ? (strong ? 0 : 110) : 255;
            for (const actor of this._blinkMenu.concat(this._blinkPanel)) {
                try {
                    if (strong)
                        actor.opacity = target;
                    else
                        actor.ease({opacity: target, duration: half});
                } catch (_e) {
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _actionButton(iconName, label, callback) {
        const box = new St.BoxLayout({
            style_class: 'idfm-gnome-action',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}));
        box.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({
            child: box,
            x_expand: true,
            can_focus: true,
            style_class: 'idfm-gnome-action-button button',
        });
        button.connect('clicked', callback);
        return button;
    }

    _addSeparator() {
        const sep = new St.BoxLayout({
            x_expand: true,
            style_class: 'popup-separator-menu-item idfm-gnome-sep',
        });
        sep.add_child(new St.Widget({
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'popup-separator-menu-item-separator',
        }));
        this._menuBox.add_child(sep);
    }

    _addLineDivider() {
        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'popup-separator-menu-item idfm-gnome-line-divider',
        });
        box.add_child(new St.Widget({
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'popup-separator-menu-item-separator idfm-gnome-dot',
        }));
        this._menuBox.add_child(box);
    }

    _addStatus(text) {
        const label = new St.Label({
            text,
            style_class: 'idfm-gnome-status idfm-gnome-row',
        });
        label.opacity = 160;
        this._menuBox.add_child(label);
    }

    _makeDepartureItem(dep, now) {
        const item = new St.BoxLayout({
            x_expand: true,
            style_class: 'idfm-gnome-row idfm-gnome-departure',
        });
        item.add_child(new St.Label({
            text: dep.direction || '—',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'idfm-gnome-destination',
        }));
        const hot = this._highlighted(dep, now);
        const time = new St.Label({
            text: longWait(dep, now) + (dep.realtime ? '' : ' *'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: hot ? 'idfm-gnome-time-imminent' : 'idfm-gnome-time',
        });
        if (hot)
            this._registerBlink(time, this._blinkMenu);
        item.add_child(time);
        return item;
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of ['_tickId', '_rotateId', '_resetTimeoutId', '_blinkId']) {
            if (this[id]) {
                GLib.source_remove(this[id]);
                this[id] = 0;
            }
        }
        if (this._scrollHandler) {
            this.disconnect(this._scrollHandler);
            this._scrollHandler = 0;
        }
        if (this._menuHandler) {
            this.menu.disconnect(this._menuHandler);
            this._menuHandler = 0;
        }
        for (const id of this._settingsHandlers ?? [])
            this._settings.disconnect(id);
        this._settingsHandlers = [];
        this._client?.destroy();
        this._client = null;
        this._settings = null;
        this._extension = null;
        super.destroy();
    }
});

export default class IdfmGnomeExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
