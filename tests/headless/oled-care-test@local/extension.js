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
        // Time of the last injected input, so idle dimming is timed from it
        let lastInput = Date.now();
        const wiggle = () => { lastInput = Date.now(); ptr.notify_relative_motion(GLib.get_monotonic_time(), 7, 3); };
        const tracker = global.backend.get_cursor_tracker();

        // Pixel shift path: pure checks on the spiral walk
        const PS = await import(ext.dir.get_child('lib').get_child('pixelShift.js').get_uri());
        const ui = Main.layoutManager.uiGroup;
        const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        let pathOk = true, pathWhy = '';
        for (let r = 1; r <= 10; r++) {
            const path = PS.buildShiftPath(r);
            const keys = new Set(path.map(p => `${p.x},${p.y}`));
            const cycle = PS.cycleLength(path);
            const steps = [...Array(cycle + 1).keys()].map(i => PS.positionForStep(path, i));
            if (path.length !== (2 * r + 1) ** 2 || keys.size !== path.length) { pathOk = false; pathWhy += ` r${r}:count`; }
            if (path.some(p => Math.abs(p.x) > r || Math.abs(p.y) > r)) { pathOk = false; pathWhy += ` r${r}:bounds`; }
            if (path[0].x !== 0 || path[0].y !== 0) { pathOk = false; pathWhy += ` r${r}:start`; }
            if (steps.some((p, i) => i > 0 && dist(p, steps[i - 1]) !== 1)) { pathOk = false; pathWhy += ` r${r}:jump`; }
        }
        check('pixel-shift-path-covers-square-in-1px-steps', pathOk, pathWhy);
        const path4 = PS.buildShiftPath(4);

        // Short timers so the run finishes quickly. The walk resumes from the
        // saved step when the shift restarts (interval change).
        settings.set_int('pixel-shift-amount', 4);
        settings.set_int('pixel-shift-step', 10);
        settings.set_int('pixel-shift-interval', 60);
        const resumed = PS.positionForStep(path4, 10);
        check('pixel-shift-resumes-saved-step', ui.translation_x === resumed.x && ui.translation_y === resumed.y,
            `t=${ui.translation_x},${ui.translation_y} want=${resumed.x},${resumed.y}`);
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

        // --- panel icon can be hidden; the features it owns keep running
        settings.set_boolean('show-indicator', false);
        await sleep(300);
        check('indicator-hidden', ind && !ind.container.visible && !ind.container.is_mapped(), `visible=${ind?.container.visible}`);
        check('indicator-hidden-keeps-features', Main.panel.statusArea[UUID] === ind && !!ind?._pixelShift && ext.state === 1);
        settings.set_boolean('show-indicator', true);
        await sleep(300);
        check('indicator-shown-again', ind && ind.container.visible && ind.container.is_mapped(), `visible=${ind?.container.visible} mapped=${ind?.container.is_mapped()}`);

        // --- which panel / dock extensions share the shell with us
        const DTP = 'dash-to-panel@jderose9.github.com';
        const active = uuid => Main.extensionManager.lookup(uuid)?.state === 1;
        const dtpActive = active(DTP);
        const dockActive = active('ubuntu-dock@ubuntu.com') || active('dash-to-dock@micxgx.gmail.com');
        const dockSchema = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.shell.extensions.dash-to-dock', true);
        const dock = dockSchema ? new Gio.Settings({settings_schema: dockSchema}) : null;
        console.log(`OLEDDIAG scenario dash-to-panel=${dtpActive} dock=${dockActive}`);
        const workArea = () => global.display.get_workspace_manager().get_active_workspace().get_work_area_for_monitor(Main.layoutManager.primaryIndex);
        const mon = Main.layoutManager.primaryMonitor;
        const pointerTo = (x, y) => { lastInput = Date.now(); ptr.notify_absolute_motion(GLib.get_monotonic_time(), x, y); };
        const push = async (dy, times = 15) => {
            for (let i = 0; i < times; i++) {
                lastInput = Date.now();
                ptr.notify_relative_motion(GLib.get_monotonic_time(), 0, dy);
                await sleep(30);
            }
        };
        if (dockActive) {
            // Dock moved to the bottom, as with Settings > Ubuntu Desktop > Dock position
            dock.set_string('dock-position', 'BOTTOM');
            await sleep(1500);
        }
        Main.overview.hide();
        await sleep(800);

        // --- panel auto-hide
        const pb = Main.layoutManager.panelBox;
        const fullArea = workArea();
        // Work-area changes resize maximized windows and rearrange desktop
        // icons, so revealing/re-hiding an auto-hidden panel must not cause any
        let waChanges = 0;
        const waId = global.display.connect('workareas-changed', () => waChanges++);
        if (dtpActive) {
            // Dash to Panel owns the panel box: auto-hide must use its intellihide
            const dtpExt = Main.extensionManager.lookup(DTP);
            const dtpSrc = Gio.SettingsSchemaSource.new_from_directory(dtpExt.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
            const dtp = new Gio.Settings({settings_schema: dtpSrc.lookup('org.gnome.shell.extensions.dash-to-panel', false)});
            const prop = 'translation_y';
            const bottom = pb.get_transformed_position()[1] > mon.y + mon.height / 2;
            console.log(`OLEDDIAG dtp panel bottom=${bottom} box=${pb.width}x${pb.height} work=${fullArea.y}+${fullArea.height}`);
            dtp.set_boolean('intellihide-hide-from-windows', true);
            settings.set_boolean('autohide-top-panel', true);
            await sleep(2500);
            check('dtp-intellihide-enabled', dtp.get_boolean('intellihide') && !dtp.get_boolean('intellihide-hide-from-windows'));
            check('dtp-panel-box-not-collapsed', pb.height > 0, `box=${pb.height}`);
            check('dtp-panel-hidden', bottom ? pb[prop] > 0 : pb[prop] < 0, `${prop}=${pb[prop]}`);
            check('dtp-workarea-freed', workArea().height === mon.height, `work=${workArea().height} mon=${mon.height}`);
            waChanges = 0;
            pointerTo(mon.x + mon.width / 2, bottom ? mon.y + mon.height - 1 : mon.y);
            await push(bottom ? 20 : -20);
            await sleep(800);
            check('dtp-panel-reveals-at-edge', pb[prop] === 0, `${prop}=${pb[prop]}`);
            pointerTo(mon.x + mon.width / 2, mon.y + mon.height / 2);
            await sleep(2000);
            check('dtp-panel-rehides', pb[prop] !== 0, `${prop}=${pb[prop]}`);
            check('dtp-reveal-and-rehide-keep-workarea', waChanges === 0 && workArea().height === mon.height, `changes=${waChanges} work=${workArea().height}`);

            // The shell turns Dash to Panel off on the lock screen and back on
            // at unlock. OLED Care must fall back to hiding the shell's own
            // panel meanwhile, then hand back to Dash to Panel.
            Main.extensionManager.disableExtension(DTP);
            await sleep(2500);
            check('lock-dtp-off-uses-shell-panel', pb.height === 0 && Main.panel.translation_y < 0 && pb.get_parent() === Main.layoutManager.uiGroup,
                `box=${pb.height} ty=${Main.panel.translation_y} parent=${pb.get_parent()?.constructor.name}`);
            Main.extensionManager.enableExtension(DTP);
            await sleep(5000);
            check('unlock-dtp-back-to-intellihide', dtp.get_boolean('intellihide') && pb.height > 0 && Main.panel.translation_y === 0 && pb[prop] !== 0,
                `intellihide=${dtp.get_boolean('intellihide')} box=${pb.height} ty=${Main.panel.translation_y} ${prop}=${pb[prop]}`);
            settings.set_boolean('autohide-top-panel', false);
            await sleep(1500);
            check('dtp-user-values-restored', !dtp.get_boolean('intellihide') && dtp.get_boolean('intellihide-hide-from-windows'));
            check('dtp-panel-shown', pb[prop] === 0 && pb.visible, `${prop}=${pb[prop]} visible=${pb.visible}`);
            check('dtp-workarea-restored', workArea().height === fullArea.height, `work=${workArea().height}`);
            check('backup-cleared', settings.get_string('autohide-saved-settings') === '', settings.get_string('autohide-saved-settings'));
        } else {
            settings.set_boolean('autohide-top-panel', true);
            await sleep(800);
            check('panel-autohide-collapsed', pb.height === 0 && Main.panel.translation_y < 0, `box=${pb.height} ty=${Main.panel.translation_y}`);
            check('panel-workarea-freed', workArea().y === mon.y, `work.y=${workArea().y}`);
            waChanges = 0;
            pointerTo(mon.x + mon.width / 2, mon.y);
            await push(-20);
            await sleep(800);
            check('panel-reveals-at-top-edge', pb.height > 0 && Main.panel.translation_y === 0, `box=${pb.height} ty=${Main.panel.translation_y}`);
            check('panel-reveal-overlays-keeps-workarea', waChanges === 0 && workArea().y === mon.y, `changes=${waChanges} work.y=${workArea().y}`);
            pointerTo(mon.x + mon.width / 2, mon.y + mon.height / 2);
            await sleep(2500);
            check('panel-rehides', pb.height === 0 && Main.panel.translation_y < 0, `box=${pb.height} ty=${Main.panel.translation_y}`);
            check('panel-rehide-keeps-workarea', waChanges === 0 && workArea().y === mon.y, `changes=${waChanges} work.y=${workArea().y}`);
            settings.set_boolean('autohide-top-panel', false);
            await sleep(800);
            check('panel-autohide-restored', pb.height > 0 && Main.panel.translation_y === 0, `box=${pb.height} ty=${Main.panel.translation_y}`);
            check('panel-reserves-space-again', workArea().y === fullArea.y && workArea().height === fullArea.height, `work=${workArea().y}+${workArea().height} before=${fullArea.y}+${fullArea.height}`);
        }

        // --- dash / dock (restores the user's own values)
        const dashWasVisible = Main.overview.dash.visible;
        dock?.set_string('intellihide-mode', 'MAXIMIZED_WINDOWS');
        settings.set_boolean('autohide-dash', true);
        await sleep(1500);
        check('dash-hidden', Main.overview.dash.visible === false);
        if (dock && dockActive) {
            check('dock-autohide-set', dock.get_string('intellihide-mode') === 'ALL_WINDOWS' && !dock.get_boolean('dock-fixed') && dock.get_boolean('autohide'), dock.get_string('intellihide-mode'));
            check('dock-space-freed', workArea().height > fullArea.height, `work=${workArea().height} before=${fullArea.height}`);
        } else if (dock) {
            check('dock-settings-untouched-when-no-dock', dock.get_string('intellihide-mode') === 'MAXIMIZED_WINDOWS' && settings.get_string('autohide-saved-settings') === '');
        }
        settings.set_boolean('autohide-dash', false);
        await sleep(1500);
        check('dash-visibility-restored', Main.overview.dash.visible === dashWasVisible, `visible=${Main.overview.dash.visible} was=${dashWasVisible}`);
        if (dock) check('dock-user-value-restored', dock.get_string('intellihide-mode') === 'MAXIMIZED_WINDOWS', dock.get_string('intellihide-mode'));
        if (dock && dockActive) check('dock-space-restored', workArea().height === fullArea.height, `work=${workArea().height} full=${fullArea.height}`);

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

        // --- screen dimming on idle (30 s after the last injected input)
        check('not-dimmed-while-active', !Main.layoutManager.uiGroup.get_effect('oled-care-dimming'));
        await sleep(Math.max(0, 33000 - (Date.now() - lastInput)));
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

        // --- pixel shift (interval 60 s, set at t0): one 1 px step along the path
        await sleep(Math.max(0, 63000 - (Date.now() - t0)));
        const next = PS.positionForStep(path4, 11);
        check('pixel-shift-steps-1px-along-path', ui.translation_x === next.x && ui.translation_y === next.y && dist(next, resumed) === 1,
            `t=${ui.translation_x},${ui.translation_y} want=${next.x},${next.y}`);
        check('pixel-shift-step-saved', settings.get_int('pixel-shift-step') === 11, `step=${settings.get_int('pixel-shift-step')}`);
        settings.set_int('pixel-shift-amount', 2);
        await sleep(300);
        check('pixel-shift-new-range-restarts-at-home', ui.translation_x === 0 && ui.translation_y === 0 && settings.get_int('pixel-shift-step') === 0,
            `t=${ui.translation_x},${ui.translation_y} step=${settings.get_int('pixel-shift-step')}`);
        settings.set_int('pixel-shift-amount', 4);
        settings.set_int('pixel-shift-step', 10);
        settings.set_int('pixel-shift-interval', 120);
        await sleep(300);

        // --- disable cleans up everything
        settings.set_boolean('autohide-top-panel', true);
        await sleep(500);
        Main.extensionManager.disableExtension(UUID);
        await sleep(800);
        check('disable-removes-indicator', !Main.panel.statusArea[UUID]);
        check('disable-resets-shift', ui.translation_x === 0 && ui.translation_y === 0);
        check('disable-restores-panel', Main.layoutManager.panelBox.height > 0 && Main.panel.translation_y === 0 && Main.layoutManager.panelBox.translation_y === 0);
        check('disable-restores-workarea', workArea().y === fullArea.y && workArea().height === fullArea.height,
            `work=${workArea().y}+${workArea().height} before=${fullArea.y}+${fullArea.height}`);
        check('disable-removes-notification-source', !Main.messageTray.getSources().some(s => s.title === 'OLED Care'));

        // --- re-enable (with the icon set to hidden), and an immediate
        // disable+enable in the same tick
        settings.set_boolean('show-indicator', false);
        Main.extensionManager.enableExtension(UUID);
        await sleep(1500);
        check('reenable-indicator', !!Main.panel.statusArea[UUID] && Main.extensionManager.lookup(UUID).state === 1);
        check('indicator-starts-hidden', Main.panel.statusArea[UUID]?.container.visible === false,
            `visible=${Main.panel.statusArea[UUID]?.container.visible}`);
        settings.set_boolean('show-indicator', true);
        await sleep(300);
        Main.extensionManager.disableExtension(UUID);
        Main.extensionManager.enableExtension(UUID);
        await sleep(1500);
        const e2 = Main.extensionManager.lookup(UUID);
        check('fast-cycle-no-conflict', !!Main.panel.statusArea[UUID] && e2.state === 1, `state=${e2.state} err=${e2.error}`);
        settings.set_boolean('autohide-top-panel', false);
        await sleep(500);
        global.display.disconnect(waId);
    }
}
