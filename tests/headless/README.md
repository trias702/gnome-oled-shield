# Headless in-shell tests

These tools test the extension inside a **real GNOME Shell**, not mocks, without
touching your desktop session. On GNOME 50 (Wayland-only) the shell can't be
restarted in place, so this is the fastest way to verify changes before logging
out and back in.

## `make test-headless` (or `tests/headless/run-headless-tests.sh`)

1. Runs `make build`.
2. Starts an isolated `gnome-shell --headless --wayland` with a virtual
   1920x1080 monitor, on a private D-Bus session and private
   `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_RUNTIME_DIR`
   directories. Your real dconf settings and installed extensions are never
   used or modified.
3. Enables the freshly built `oled-care@asplund.kim` together with the test
   driver extension `oled-care-test@local`.
4. Opens the preferences window (`gnome-extensions prefs`).
5. Prints every `OLEDTEST PASS/FAIL` line and any `JS ERROR`, `JS WARNING` or
   `CRITICAL` the shell logged. It exits non-zero on any failure or warning.

A full run takes about 2 minutes, because it waits on real timers: idle
dimming, a 30 s pixel refresh and a 60 s pixel shift interval.

Options:

- `--keep` keeps the isolated environment (logs, dconf) for inspection.
  It is always kept on failure.
- `--timeout SECONDS` sets the overall wait for the in-shell run (default: 300).

### What the test driver checks

`oled-care-test@local/extension.js` drives settings, injects input through
Clutter virtual pointer and keyboard devices, opens two real GTK 4 Wayland
windows (`windows.js`), and asserts on actual shell state:

| Area | Checks |
|---|---|
| Startup | extension state is ENABLED, indicator is in the panel, welcome notification, monitor vendor/connector detection, primary display |
| Panel auto-hide | panel box collapses and the panel slides out; restored when turned off |
| Dash / dock | overview dash hidden; Dash to Dock `intellihide-mode` set, then the user's own value restored |
| True black | background set to solid black, then the original restored |
| Window dimming | unfocused window dimmed and focused one not; dim swaps on focus change; cleared when turned off |
| Screen dimming | not dimmed while active; dimmed after idle timeout; undimmed on input |
| Pixel refresh | overlay shown, modal grab taken, cursor hidden; Escape cancels and restores everything; full 30 s run completes with a moving sweep bar |
| Pixel shift | UI group translated by 1 px after the interval |
| Lifecycle | disable removes the indicator, shift, panel changes and notification source; re-enable works; immediate disable+enable in one tick works |

To add a check, add a `check('name', condition, 'diagnostic')` call in
`_run()`. Use `await sleep(ms)` to wait for timers and animations.

## `make probe-apis` (or `tests/headless/probe-shell-apis.sh`)

Loads the installed mutter and shell typelibs with GJS (no running shell
needed) and reports `OK` or `MISSING` for every GI API the extension relies on.
It also lists legacy APIs that older versions of this code used and that are
now gone. Run it first when porting to a new GNOME release.

`--extract DIR` also extracts the shell's own JS sources (`ui/`, `misc/`,
`extensions/`) from `libshell-*.so`, which is the most reliable reference for
how the shell itself uses an API on that version.

## Requirements

`gnome-shell` (with `--headless`), `gjs`, the GTK 4 typelib (for the test
windows), `glib-compile-schemas`, `dbus-run-session`, `gdbus`, `gresource`,
`make` and `jq`.
