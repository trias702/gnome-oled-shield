#!/bin/bash

set -e  # Exit on any error

echo "Running post-installation tasks..."

# Compile GSettings schemas
echo "Compiling GSettings schemas..."
if [ -d "${MESON_INSTALL_PREFIX}/share/glib-2.0/schemas/" ]; then
    glib-compile-schemas "${MESON_INSTALL_PREFIX}/share/glib-2.0/schemas/" || {
        echo "Error: Failed to compile GSettings schemas."
        exit 1
    }
    echo "✓ GSettings schemas compiled successfully."
else
    echo "Warning: GSettings schema directory not found."
fi

# GNOME Shell 50 is Wayland-only and cannot be restarted in place
echo "Log out and log back in so GNOME Shell loads the extension."

# Additional post-install checks
extension_path="${MESON_INSTALL_PREFIX}/share/gnome-shell/extensions/oled-care@asplund.kim"
if [ -d "$extension_path" ]; then
    echo "✓ Extension installed at: $extension_path"
else
    echo "Warning: Extension installation path not found. Installation may have failed."
fi

echo ""
echo "Installation complete!"
echo "To enable the extension, use GNOME Extensions app or the command line:"
echo "$ gnome-extensions enable oled-care@asplund.kim"
echo ""
echo "If the extension is not immediately available, log out and log back in." 