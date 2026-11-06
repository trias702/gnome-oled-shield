import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';
Gtk.init();
const loop = GLib.MainLoop.new(null, false);
for (const t of ['oledtest-A', 'oledtest-B']) {
    const w = new Gtk.Window({title: t, default_width: 400, default_height: 300});
    w.present();
}
loop.run();
