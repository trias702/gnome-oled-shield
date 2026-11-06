#!/bin/bash
#
# Check that every GNOME Shell / mutter API this extension relies on exists in
# the GNOME Shell installed on this machine. Run it first when porting to a new
# GNOME release: it reports MISSING for anything that was removed or renamed.
#
# Usage: tests/headless/probe-shell-apis.sh [--extract DIR]
#   --extract DIR   also extract the shell's own JS sources (ui/*.js, misc/*.js,
#                   extensions/*.js) into DIR, handy for reading how the shell
#                   itself uses an API on this version.
#
# It loads the real mutter/shell typelibs with gjs (no running shell needed).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTRACT_DIR=""
[ "${1:-}" = "--extract" ] && EXTRACT_DIR="${2:?--extract needs a directory}"

SHELL_LIB=$(ls /usr/lib*/gnome-shell/libshell-*.so /usr/lib/*/gnome-shell/libshell-*.so 2>/dev/null | head -1)
SHELL_TYPELIB_DIR=$(dirname "$(ls /usr/lib*/gnome-shell/Shell-*.typelib /usr/lib/*/gnome-shell/Shell-*.typelib 2>/dev/null | head -1)")
MUTTER_DIR=$(dirname "$(ls -d /usr/lib*/mutter-*/Meta-*.typelib /usr/lib/*/mutter-*/Meta-*.typelib 2>/dev/null | sort -V | tail -1)")

if [ -z "$SHELL_LIB" ] || [ -z "$MUTTER_DIR" ]; then
    echo "Could not locate gnome-shell (libshell-*.so) or mutter typelibs" >&2
    exit 2
fi

echo "GNOME Shell: $(gnome-shell --version 2>/dev/null)"
echo "libshell:    $SHELL_LIB"
echo "mutter:      $MUTTER_DIR"
echo

if [ -n "$EXTRACT_DIR" ]; then
    mkdir -p "$EXTRACT_DIR"
    for r in $(gresource list "$SHELL_LIB" | grep '\.js$'); do
        mkdir -p "$EXTRACT_DIR$(dirname "$r")"
        gresource extract "$SHELL_LIB" "$r" > "$EXTRACT_DIR$r"
    done
    echo "Extracted shell JS sources to $EXTRACT_DIR/org/gnome/shell"
    echo
fi

GI_TYPELIB_PATH="$MUTTER_DIR:$SHELL_TYPELIB_DIR${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}" \
LD_LIBRARY_PATH="$MUTTER_DIR:$(dirname "$SHELL_LIB")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    gjs -m "$SCRIPT_DIR/probe-shell-apis.js"
