// In-shell test driver for oled-care@asplund.kim. Only ever installed in an
// isolated headless test shell. Logs "OLEDTEST PASS/FAIL <name>" lines.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const UUID = 'oled-care@asplund.kim';
const sleep = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { r(); return GLib.SOURCE_REMOVE; }));
let pass = 0, fail = 0, started = false;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`OLEDTEST PASS ${name}`); }
    else { fail++; console.log(`OLEDTEST FAIL ${name} ${extra}`); }
}
const findOverlay = () => Main.layoutManager.uiGroup.get_children().find(a => a.style_class === 'pixel-refresh-overlay');

export default class OledCareTests extends Extension {
    enable() {
        // The shell re-enables later extensions when an earlier one is toggled
        if (started) return;
        started = true;
        this._run()
            .catch(e => { fail++; console.log(`OLEDTEST FAIL exception ${e}\n${e.stack}`); })
            .finally(() => console.log(`OLEDTEST DONE pass=${pass} fail=${fail}`));
    }
    disable() {}

    async _run() {
        await sleep(2500);
        const ext = Main.extensionManager.lookup(UUID);
        check('extension-enabled', ext?.state === 1, `state=${ext?.state} error=${ext?.error}`);
        const src = Gio.SettingsSchemaSource.new_from_directory(ext.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const settings = new Gio.Settings({settings_schema: src.lookup('org.gnome.shell.extensions.oled-care', false)});
        const seat = global.stage.context.get_backend().get_default_seat();
        const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const kbd = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const wiggle = () => ptr.notify_relative_motion(GLib.get_monotonic_time(), 7, 3);
        const tracker = global.backend.get_cursor_tracker();

        // Short timers so the run finishes quickly
        settings.set_int('pixel-shift-interval', 60);
        settings.set_int('screen-dim-timeout', 30);
        settings.set_int('pixel-refresh-speed', 5);
        wiggle();
        const t0 = Date.now();

        // --- indicator, notification, display detection
        const ind = Main.panel.statusArea[UUID];
        check('indicator-in-panel', !!ind);
        check('notification-shown', Main.messageTray.getSources().some(s => s.title === 'OLED Care' && s.notifications.length > 0));
        const info = ind?._displayManager?.getDisplayInfo?.() ?? [];
        check('display-detected', info.length === 1 && info[0].connector !== 'Unknown' && info[0].name !== 'Monitor 0',
            JSON.stringify(info.map(d => ({name: d.name, connector: d.connector, mfr: d.manufacturer, model: d.model}))));
        check('display-primary', info[0]?.isPrimary === true);

        // --- panel auto-hide
        settings.set_boolean('autohide-top-panel', true);
        await sleep(800);
        check('panel-autohide-collapsed', Main.layoutManager.panelBox.height === 0 && Main.panel.translation_y < 0, `box=${Main.layoutManager.panelBox.height} ty=${Main.panel.translation_y}`);
        settings.set_boolean('autohide-top-panel', false);
        await sleep(800);
        check('panel-autohide-restored', Main.layoutManager.panelBox.height > 0 && Main.panel.translation_y === 0, `box=${Main.layoutManager.panelBox.height} ty=${Main.panel.translation_y}`);

        // --- dash / dock (restores the user's own values)
        const dockSchema = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.shell.extensions.dash-to-dock', true);
        const dock = dockSchema ? new Gio.Settings({settings_schema: dockSchema}) : null;
        dock?.set_string('intellihide-mode', 'MAXIMIZED_WINDOWS');
        settings.set_boolean('autohide-dash', true);
        await sleep(300);
        check('dash-hidden', Main.overview.dash.visible === false);
        if (dock) check('dock-intellihide-set', dock.get_string('intellihide-mode') === 'ALL_WINDOWS', dock.get_string('intellihide-mode'));
        settings.set_boolean('autohide-dash', false);
        await sleep(300);
        check('dash-shown', Main.overview.dash.visible === true);
        if (dock) check('dock-user-value-restored', dock.get_string('intellihide-mode') === 'MAXIMIZED_WINDOWS', dock.get_string('intellihide-mode'));

        // --- true black background
        const bg = new Gio.Settings({schema: 'org.gnome.desktop.background'});
        const origOpts = bg.get_string('picture-options');
        settings.set_boolean('true-black-background', true);
        await sleep(300);
        check('true-black-applied', bg.get_string('primary-color') === '#000000' && bg.get_string('picture-options') === 'none');
        settings.set_boolean('true-black-background', false);
        await sleep(300);
        check('true-black-restored', bg.get_string('picture-options') === origOpts, bg.get_string('picture-options'));

        // --- unfocused window dimming with two real Wayland client windows
        Main.overview.hide();
        await sleep(800);
        const proc = Gio.Subprocess.new(['gjs', '-m', this.dir.get_child('windows.js').get_path()], Gio.SubprocessFlags.NONE);
        const testWindows = () => global.get_window_actors().filter(a => a.meta_window?.get_title()?.startsWith('oledtest-'));
        for (let i = 0; i < 40 && !(testWindows().length === 2 && testWindows().every(a => a.is_mapped())); i++)
            await sleep(250);
        const wins = testWindows();
        check('test-windows-mapped', wins.length === 2, `count=${wins.length}`);
        if (wins.length === 2) {
            const dimmed = a => !!a.get_effect('oled-care-unfocus-dim');
            const state = tag => console.log(`OLEDDIAG ${tag} focus=${global.display.focus_window?.get_title()} ` +
                wins.map(a => `${a.meta_window.get_title()}:type=${a.meta_window.get_window_type()},dim=${dimmed(a)}`).join(' '));
            state('mapped');
            Main.activateWindow(wins[0].meta_window);
            await sleep(400);
            state('after-activate-0');
            check('focused-window-not-dimmed', global.display.focus_window === wins[0].meta_window && !dimmed(wins[0]));
            check('unfocused-window-dimmed', dimmed(wins[1]));
            Main.activateWindow(wins[1].meta_window);
            await sleep(400);
            check('focus-switch-swaps-dim', dimmed(wins[0]) && !dimmed(wins[1]));
            settings.set_boolean('unfocus-dim-enabled', false);
            await sleep(300);
            check('unfocus-dim-off-clears', !dimmed(wins[0]) && !dimmed(wins[1]));
            settings.set_boolean('unfocus-dim-enabled', true);
            await sleep(300);
            check('unfocus-dim-on-again', dimmed(wins[0]) && !dimmed(wins[1]));
        }
        proc.force_exit();
        await sleep(500);

        // --- screen dimming on idle (no input since t0)
        check('not-dimmed-while-active', !Main.layoutManager.uiGroup.get_effect('oled-care-dimming'));
        await sleep(Math.max(0, 33000 - (Date.now() - t0)));
        const dimEffect = Main.layoutManager.uiGroup.get_effect('oled-care-dimming');
        check('dimmed-after-idle', !!dimEffect);
        wiggle();
        await sleep(500);
        check('undimmed-on-activity', !Main.layoutManager.uiGroup.get_effect('oled-care-dimming'));

        // --- pixel refresh: start, grab, hidden cursor, Escape cancels
        const modalBefore = Main.modalCount;
        settings.set_boolean('pixel-refresh-manual-trigger', true);
        await sleep(1000);
        const ov = findOverlay();
        check('refresh-overlay-shown', !!ov && ov.width === global.stage.width);
        check('refresh-running-setting', settings.get_boolean('pixel-refresh-running'));
        check('refresh-trigger-reset', settings.get_boolean('pixel-refresh-manual-trigger') === false);
        check('refresh-modal-grab', Main.modalCount === modalBefore + 1, `modal ${modalBefore}->${Main.modalCount}`);
        check('refresh-cursor-hidden', tracker.get_pointer_visible() === false);
        kbd.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.PRESSED);
        kbd.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Escape, Clutter.KeyState.RELEASED);
        await sleep(600);
        check('escape-cancels-refresh', !findOverlay() && !settings.get_boolean('pixel-refresh-running'));
        check('escape-releases-grab', Main.modalCount === modalBefore, `modal=${Main.modalCount}`);
        check('escape-restores-cursor', tracker.get_pointer_visible() === true);

        // --- pixel refresh: full run at speed 5 (30 s), sweep bar must move
        settings.set_boolean('pixel-refresh-manual-trigger', true);
        const tStart = Date.now();
        await sleep(19500);
        const bar1 = findOverlay()?.get_first_child();
        const y1 = bar1?.y;
        await sleep(1500);
        const y2 = findOverlay()?.get_first_child()?.y;
        check('sweep-bar-moves', bar1 && y1 !== undefined && y2 !== undefined && y2 > y1, `y1=${y1} y2=${y2}`);
        await sleep(Math.max(0, 32500 - (Date.now() - tStart)));
        check('refresh-completes', !findOverlay() && !settings.get_boolean('pixel-refresh-running') && Main.modalCount === modalBefore,
            `overlay=${!!findOverlay()} running=${settings.get_boolean('pixel-refresh-running')} modal=${Main.modalCount}`);

        // --- cancel pressed while idle must not stick
        settings.set_boolean('pixel-refresh-manual-cancel', true);
        await sleep(300);
        check('cancel-flag-reset-when-idle', settings.get_boolean('pixel-refresh-manual-cancel') === false);

        // --- pixel shift (interval 60 s, set at t0)
        await sleep(Math.max(0, 63000 - (Date.now() - t0)));
        const ui = Main.layoutManager.uiGroup;
        check('pixel-shift-applied', Math.abs(ui.translation_x) + Math.abs(ui.translation_y) === 1, `tx=${ui.translation_x} ty=${ui.translation_y}`);

        // --- disable cleans up everything
        settings.set_boolean('autohide-top-panel', true);
        await sleep(500);
        Main.extensionManager.disableExtension(UUID);
        await sleep(800);
        check('disable-removes-indicator', !Main.panel.statusArea[UUID]);
        check('disable-resets-shift', ui.translation_x === 0 && ui.translation_y === 0);
        check('disable-restores-panel', Main.layoutManager.panelBox.height > 0 && Main.panel.translation_y === 0);
        check('disable-removes-notification-source', !Main.messageTray.getSources().some(s => s.title === 'OLED Care'));

        // --- re-enable, and an immediate disable+enable in the same tick
        Main.extensionManager.enableExtension(UUID);
        await sleep(1500);
        check('reenable-indicator', !!Main.panel.statusArea[UUID] && Main.extensionManager.lookup(UUID).state === 1);
        Main.extensionManager.disableExtension(UUID);
        Main.extensionManager.enableExtension(UUID);
        await sleep(1500);
        const e2 = Main.extensionManager.lookup(UUID);
        check('fast-cycle-no-conflict', !!Main.panel.statusArea[UUID] && e2.state === 1, `state=${e2.state} err=${e2.error}`);
        settings.set_boolean('autohide-top-panel', false);
        await sleep(500);
    }
}
