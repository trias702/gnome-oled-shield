// GI API probe used by probe-shell-apis.sh. Each entry is an API the
// extension calls; "removed" entries are APIs older code used that must NOT
// be relied on (they are reported for information only).
import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import System from 'system';

const props = klass => GObject.Object.list_properties.call(klass).map(p => p.name);
const fn = (proto, name) => typeof proto?.[name] === 'function';

const REQUIRED = {
    // Panel auto-hide
    'Meta.Barrier has "backend" property': () => props(Meta.Barrier).includes('backend'),
    'Meta.Barrier.destroy()': () => fn(Meta.Barrier.prototype, 'destroy'),
    'Meta.BarrierDirection.POSITIVE_Y': () => Meta.BarrierDirection.POSITIVE_Y !== undefined,
    'Shell.ActionMode.NORMAL/OVERVIEW/NONE': () => [Shell.ActionMode.NORMAL, Shell.ActionMode.OVERVIEW, Shell.ActionMode.NONE].every(v => v !== undefined),
    'Shell.Global.get_pointer()': () => fn(Shell.Global.prototype, 'get_pointer'),
    // Screen dimming
    'Meta.Backend.get_core_idle_monitor()': () => fn(Meta.Backend.prototype, 'get_core_idle_monitor'),
    'Meta.IdleMonitor.add_idle_watch()': () => fn(Meta.IdleMonitor.prototype, 'add_idle_watch'),
    'Meta.IdleMonitor.add_user_active_watch()': () => fn(Meta.IdleMonitor.prototype, 'add_user_active_watch'),
    'Meta.IdleMonitor.remove_watch()': () => fn(Meta.IdleMonitor.prototype, 'remove_watch'),
    'Clutter.BrightnessContrastEffect.set_brightness()': () => fn(Clutter.BrightnessContrastEffect.prototype, 'set_brightness'),
    'Clutter.BrightnessContrastEffect.set_brightness_full()': () => fn(Clutter.BrightnessContrastEffect.prototype, 'set_brightness_full'),
    'Clutter.Actor.add_effect_with_name()/get_effect()': () => fn(Clutter.Actor.prototype, 'add_effect_with_name') && fn(Clutter.Actor.prototype, 'get_effect'),
    // Pixel refresh
    'Meta.Backend.get_cursor_tracker()': () => fn(Meta.Backend.prototype, 'get_cursor_tracker'),
    'Meta.CursorTracker.inhibit_cursor_visibility()': () => fn(Meta.CursorTracker.prototype, 'inhibit_cursor_visibility'),
    'Meta.CursorTracker.uninhibit_cursor_visibility()': () => fn(Meta.CursorTracker.prototype, 'uninhibit_cursor_visibility'),
    'Clutter.Seat.inhibit_unfocus()': () => fn(Clutter.Seat.prototype, 'inhibit_unfocus'),
    'Clutter.KEY_Escape': () => Clutter.KEY_Escape !== undefined,
    'Meta.Window.is_fullscreen()': () => fn(Meta.Window.prototype, 'is_fullscreen'),
    'St.Widget': () => typeof St.Widget === 'function',
    // Unfocused window dimming
    'Meta.WindowActor.get_meta_window()': () => fn(Meta.WindowActor.prototype, 'get_meta_window'),
    'Meta.WindowType.NORMAL': () => Meta.WindowType.NORMAL !== undefined,
    'Meta.LaterType.BEFORE_REDRAW': () => Meta.LaterType.BEFORE_REDRAW !== undefined,
    // Display detection
    'Meta.MonitorManager.get_logical_monitors()': () => fn(Meta.MonitorManager.prototype, 'get_logical_monitors'),
    'Meta.LogicalMonitor.get_number()/get_monitors()': () => fn(Meta.LogicalMonitor.prototype, 'get_number') && fn(Meta.LogicalMonitor.prototype, 'get_monitors'),
    'Meta.Monitor.get_vendor()/get_product()/get_connector()': () => ['get_vendor', 'get_product', 'get_connector', 'get_display_name', 'is_builtin'].every(n => fn(Meta.Monitor.prototype, n)),
    // Lifecycle helpers
    'GLib.MainContext.find_source_by_id()': () => fn(GLib.MainContext.prototype, 'find_source_by_id'),
};

const REMOVED = {
    'Meta.is_wayland_compositor()': () => typeof Meta.is_wayland_compositor === 'function',
    'Meta.Cursor enum': () => Meta.Cursor !== undefined,
    'Meta.Display.set_cursor()': () => fn(Meta.Display.prototype, 'set_cursor'),
    'Meta.MonitorManager.get()': () => typeof Meta.MonitorManager.get === 'function',
    'Shell.PressureBarrier (use ui/layout.js PressureBarrier)': () => Shell.PressureBarrier !== undefined,
    'Shell.WindowTracker.get_running_apps()': () => fn(Shell.WindowTracker.prototype, 'get_running_apps'),
    'Clutter.Actor.add_actor()': () => fn(Clutter.Actor.prototype, 'add_actor'),
};

let missing = 0;
print('Required APIs:');
for (const [name, test] of Object.entries(REQUIRED)) {
    let ok;
    try {
        ok = !!test();
    } catch (e) {
        ok = false;
    }
    if (!ok)
        missing++;
    print(`  ${ok ? 'OK     ' : 'MISSING'} ${name}`);
}

print('\nLegacy APIs (should be absent; the code no longer uses them):');
for (const [name, test] of Object.entries(REMOVED)) {
    let present;
    try {
        present = !!test();
    } catch (e) {
        present = false;
    }
    print(`  ${present ? 'present' : 'absent '} ${name}`);
}

print(`\n${missing === 0 ? 'All required APIs present' : `${missing} required API(s) MISSING`}`);
System.exit(missing === 0 ? 0 : 1);
