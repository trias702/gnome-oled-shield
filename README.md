# GNOME OLED Shield

An advanced GNOME extension to protect OLED displays from burn-in using various protection techniques.

## Features

- **Pixel Shift**: Slowly moves the whole screen around its normal position so static edges wear a
  band instead of a single line. It walks a square spiral out to a configurable distance (default
  4 px) and back, 1 px per step (default every 2 minutes), giving every offset equal time and
  resuming where it left off after a restart
- **Pixel Refresh**: Performs full-screen rejuvenation routines to equalize pixel wear
- **Screen Dimming**: Dims the whole screen after a period of inactivity
- **Unfocused Window Dimming**: Dims every window except the one you are using
- **True Black Background**: Replaces the wallpaper with solid black (the original is restored when turned off)
- **Auto-hide Top Panel**: Hides the top bar until the pointer is pushed against the top screen edge.
  With [Dash to Panel](https://extensions.gnome.org/extension/1160/dash-to-panel/) it switches on
  Dash to Panel's own auto-hide ("intellihide") instead, so the panel hides and reveals at whichever
  edge it is on
- **Auto-hide Dash**: Hides the overview dash and makes Ubuntu Dock / Dash to Dock auto-hide (at any
  dock position)

The panel icon gives quick access to the main switches; it can be hidden in Preferences
("Show Icon in Panel") without stopping any protection.

Settings that auto-hide changes in Dash to Panel or Ubuntu Dock / Dash to Dock are saved first and put
back when the option is turned off.

## Modernization

This extension has been fully modernized with cutting-edge JavaScript features to enhance performance, reliability, and maintainability:

### ES2021+ Features

- **Private Class Fields** (`#fieldName`): Proper encapsulation for better security and preventing accidental API misuse
- **Static Initialization Blocks**: Cleaner initialization of static class members
- **Nullish Coalescing** (`??`): Better handling of null/undefined values
- **Optional Chaining** (`?.`): Safer property access
- **Logical Assignment** (`||=`, `&&=`, `??=`): Concise conditional assignments
- **Promise.allSettled**: Better handling of multiple async operations
- **WeakRef & FinalizationRegistry**: Advanced memory management
- **AbortController/AbortSignal**: Cancellable operations

### Architecture Improvements

- **Event-Based Communication**: Components communicate through an event system
- **Resource Management**: Automatic tracking and cleanup of resources
- **Signal Management**: Robust tracking and management of GObject signals
- **Error Handling**: Comprehensive error hierarchy with chaining
- **Metrics Collection**: Performance monitoring through metrics system

## Technical Implementation

The codebase follows a modular architecture with these key components:

### Core Infrastructure

- **EventEmitter**: Provides event-based communication between components
- **ResourceManager**: Tracks and manages resource lifecycles with WeakRef/FinalizationRegistry
- **SignalManager**: Manages GObject signal connections with automatic cleanup
- **Metrics**: Collects and analyzes performance data
- **ErrorRegistry**: Centralized error monitoring and handling

### Feature Modules

- **DisplayManager**: Manages monitor detection and display-specific settings
- **PixelShift**: Implements screen content shifting algorithms
- **PixelRefresh**: Handles full-screen refresh operations
- **Dimming**: Controls brightness reduction for static elements

## Development

### Prerequisites

- GNOME Shell 50+
- GJS 1.86+

### Building and Testing

```bash
# Clone the repository
git clone https://github.com/kimasplund/gnome-oled-shield.git
cd gnome-oled-shield

# Install to your local extensions directory
make install

# Run tests
make test
```

### Running the Tests

The extension includes a comprehensive test suite that verifies the modernization features:

```bash
# Run the modernization test suite
gjs -m tests/test-modernization.js
```

## Installation

### From GNOME Extensions Website

Visit [extensions.gnome.org](https://extensions.gnome.org) and search for "OLED Shield".

### Manual Installation

```bash
# Clone the repository
git clone https://github.com/kimasplund/gnome-oled-shield.git

# Build (compiles the GSettings schema) and install to
# ~/.local/share/gnome-shell/extensions/oled-care@asplund.kim
cd gnome-oled-shield
make install

# GNOME Shell 50 is Wayland-only: log out and log back in so the shell
# picks up the new extension, then enable it
gnome-extensions enable oled-care@asplund.kim
```

## Usage

1. Enable the extension using GNOME Extensions app or the Extensions menu in GNOME Tweaks
2. Click on the shield icon in the top panel to access settings
3. Configure protection features based on your display type

### Settings

- **Pixel Shift**: Configure shift interval, distance, and speed
- **Pixel Refresh**: Schedule refresh operations or run them manually
- **Screen Dimming**: Control dimming level and which UI elements to dim
- **Display Management**: Select which displays to protect

## Technical Documentation

For detailed technical documentation of the codebase, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the GPL-3.0 License - see the [LICENSE](LICENSE) file for details.

## Credits

- **Author**: Kim Asplund (kim.asplund@gmail.com)
- **Website**: https://asplund.kim
- **GitHub**: https://github.com/kimasplund
  