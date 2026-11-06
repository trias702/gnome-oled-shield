#!/bin/bash
#
# Headless in-shell test harness for OLED Care.
#
# Builds the extension, then starts a real, isolated GNOME Shell (headless,
# Wayland, virtual 1920x1080 monitor) on a private D-Bus session with its own
# XDG data/config/cache/runtime directories. Your desktop session, dconf
# settings and installed extensions are never touched.
#
# Inside that shell it enables:
#   - oled-care@asplund.kim   (the freshly built extension)
#   - oled-care-test@local    (tests/headless/oled-care-test@local, a test
#                              driver that exercises every feature against
#                              real shell state and logs OLEDTEST PASS/FAIL)
#
# It then opens the preferences window, and finally fails if any check
# failed or if the shell logged any JS ERROR / CRITICAL / JS WARNING.
#
# Usage: tests/headless/run-headless-tests.sh [--keep] [--timeout SECONDS]
#   --keep       keep the isolated environment directory after the run
#   --timeout    overall timeout for the in-shell test run (default 300)
#
# Requirements: gnome-shell (with --headless support), gjs, Gtk 4 typelib
# (for the test windows), glib-compile-schemas, dbus-run-session, make, jq.
# A full run takes roughly 2 minutes because it waits on real timers
# (idle dimming, a 30 s pixel refresh, a 60 s pixel shift interval).

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UUID="oled-care@asplund.kim"
TEST_UUID="oled-care-test@local"
KEEP=false
TIMEOUT=300

while [ $# -gt 0 ]; do
    case "$1" in
        --keep) KEEP=true ;;
        --timeout) shift; TIMEOUT="$1" ;;
        -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

for cmd in gnome-shell gjs glib-compile-schemas dbus-run-session make jq gdbus; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 2; }
done

echo "== Building extension"
make -C "$REPO_DIR" build >/dev/null || { echo "Build failed" >&2; exit 1; }

# Isolated environment. The Wayland socket path must fit in 108 bytes, so the
# runtime dir gets its own short path under /tmp.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oled-headless.XXXXXX")"
RUNTIME_DIR="$(mktemp -d /tmp/oledrt.XXXXXX)"
chmod 700 "$RUNTIME_DIR"
cleanup() {
    rm -rf "$RUNTIME_DIR"
    if [ "$KEEP" = true ]; then
        echo "Kept test environment: $WORK_DIR"
    else
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

mkdir -p "$WORK_DIR"/{data,config,cache}
EXT_ROOT="$WORK_DIR/data/gnome-shell/extensions"
mkdir -p "$EXT_ROOT"
cp -r "$REPO_DIR/build" "$EXT_ROOT/$UUID"
cp -r "$SCRIPT_DIR/$TEST_UUID" "$EXT_ROOT/$TEST_UUID"

# Keep the test driver's shell-version in step with the extension's
jq --argjson v "$(jq -c '."shell-version"' "$REPO_DIR/metadata.json")" \
    '."shell-version" = $v' "$SCRIPT_DIR/$TEST_UUID/metadata.json" \
    > "$EXT_ROOT/$TEST_UUID/metadata.json"

SHELL_LOG="$WORK_DIR/gnome-shell.log"
SESSION_LOG="$WORK_DIR/session.log"
RESULTS="$WORK_DIR/results.txt"

export XDG_DATA_HOME="$WORK_DIR/data" XDG_CONFIG_HOME="$WORK_DIR/config"
export XDG_CACHE_HOME="$WORK_DIR/cache" XDG_RUNTIME_DIR="$RUNTIME_DIR"
export EXT_DIR="$EXT_ROOT/$UUID" UUID TEST_UUID SHELL_LOG RESULTS TIMEOUT
export WAYLAND_NAME="oledtest-$$"
unset DISPLAY WAYLAND_DISPLAY

echo "== Starting isolated headless GNOME Shell ($(gnome-shell --version))"
dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"$UUID\", \"$TEST_UUID\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    # A non-default dock value lets the test verify it is restored afterwards
    gsettings set org.gnome.shell.extensions.dash-to-dock dock-fixed true 2>/dev/null
    GSETTINGS_SCHEMA_DIR="$EXT_DIR/schemas" \
        gsettings set org.gnome.shell.extensions.oled-care debug-mode true

    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1920x1080 \
        --wayland-display="$WAYLAND_NAME" >"$SHELL_LOG" 2>&1 &
    SHELL_PID=$!

    for _ in $(seq 1 "$TIMEOUT"); do
        grep -q "OLEDTEST DONE" "$SHELL_LOG" && break
        kill -0 $SHELL_PID 2>/dev/null || break
        sleep 1
    done

    echo "== Opening preferences window"
    WAYLAND_DISPLAY="$WAYLAND_NAME" timeout 15 gnome-extensions prefs "$UUID"
    echo "prefs-exit=$?"
    sleep 6

    gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell \
        -m org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" > "$RESULTS.info" 2>&1

    kill $SHELL_PID 2>/dev/null
    wait $SHELL_PID 2>/dev/null
' >"$SESSION_LOG" 2>&1

# ---- Report -----------------------------------------------------------------
STATUS=0
echo
echo "== In-shell checks"
grep -h "OLEDTEST" "$SHELL_LOG" | sed -E 's/^.*(OLEDTEST .*)$/\1/' | tee "$RESULTS"

if ! grep -q "OLEDTEST DONE" "$SHELL_LOG"; then
    echo "ERROR: test driver did not finish (timeout or shell crash)"
    STATUS=1
elif grep -q "OLEDTEST FAIL" "$SHELL_LOG"; then
    STATUS=1
fi

echo
echo "== Shell errors and warnings"
# The NM.Object::client line is a harmless GJS warning from the shell itself
PROBLEMS=$(grep -E "JS ERROR|JS WARNING|CRITICAL" "$SHELL_LOG" | grep -v "NM.Object::client")
if [ -n "$PROBLEMS" ]; then
    echo "$PROBLEMS" | cut -c1-300
    STATUS=1
else
    echo "(none)"
fi

echo
echo "== Preferences window"
PREFS_PROBLEMS=$(grep -E "OLED Care Prefs\] ERROR|JS ERROR|Gjs-CRITICAL" "$SESSION_LOG")
if [ -n "$PREFS_PROBLEMS" ]; then
    echo "$PREFS_PROBLEMS" | cut -c1-300
    STATUS=1
elif grep -q "\[OLED Care Prefs\] Settings loaded" "$SESSION_LOG"; then
    echo "loaded without errors"
else
    echo "WARNING: preferences window did not report loading"
    STATUS=1
fi

echo
if [ "$STATUS" -eq 0 ]; then
    echo "RESULT: PASS"
else
    echo "RESULT: FAIL (logs: $SHELL_LOG, $SESSION_LOG)"
    KEEP=true
fi
exit $STATUS
