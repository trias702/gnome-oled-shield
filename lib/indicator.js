'use strict';

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Import error handling and utilities
import { ExtensionError } from './errors.js';
import { metrics } from './metrics.js';
import ResourceManager from './resourceManager.js';
import SignalManager from './signalManager.js';

// Import extension modules
import DisplayManager from './displayManager.js';
import PixelShift from './pixelShift.js';
import Dimming from './dimming.js';
import PixelRefresh from './pixelRefresh.js';

/**
 * Custom error class for indicator operations
 */
class IndicatorError extends ExtensionError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            context: options.context || 'indicator'
        });
        this.name = 'IndicatorError';
    }

    static operationFailed(operation, cause) {
        return new IndicatorError(`Failed to perform indicator operation: ${operation}`, {
            cause,
            context: 'operation',
            metadata: { operation }
        });
    }
}

// Defined as a frozen object for immutability
const CONSTANTS = Object.freeze({
    SETTINGS: {
        DEBUG_MODE: 'debug-mode',
        ENABLED_DISPLAYS: 'enabled-displays',
        SCREEN_DIM_ENABLED: 'screen-dim-enabled',
        DIMMING_LEVEL: 'dimming-level',
        SCREEN_DIM_TIMEOUT: 'screen-dim-timeout',
        UNFOCUS_DIM_ENABLED: 'unfocus-dim-enabled',
        UNFOCUS_DIM_LEVEL: 'unfocus-dim-level',
        PIXEL_SHIFT_ENABLED: 'pixel-shift-enabled',
        PIXEL_SHIFT_INTERVAL: 'pixel-shift-interval',
        PIXEL_REFRESH_ENABLED: 'pixel-refresh-enabled',
        PIXEL_REFRESH_SPEED: 'pixel-refresh-speed',
        PIXEL_REFRESH_SMART: 'pixel-refresh-smart',
        PIXEL_REFRESH_SCHEDULE: 'pixel-refresh-schedule',
        PIXEL_REFRESH_RUNNING: 'pixel-refresh-running',
        PIXEL_REFRESH_PROGRESS: 'pixel-refresh-progress',
        PIXEL_REFRESH_TIME_REMAINING: 'pixel-refresh-time-remaining',
        PIXEL_REFRESH_NEXT_RUN: 'pixel-refresh-next-run',
        PIXEL_REFRESH_MANUAL_TRIGGER: 'pixel-refresh-manual-trigger',
        PIXEL_REFRESH_MANUAL_CANCEL: 'pixel-refresh-manual-cancel'
    },
    PERFORMANCE_BUDGET: {
        MENU_OPERATION: 10 // milliseconds
    }
});

/**
 * Panel indicator for OLED Care extension
 */
export default class OledCareIndicator extends PanelMenu.Button {
    // Static initialization block for constants
    static {
        this.REQUIRED_SETTINGS = Object.values(CONSTANTS.SETTINGS);
    }

    /**
     * Constructor for the OledCareIndicator component
     * @param {Gio.Settings} settings - The extension settings
     * @param {object} components - Optional pre-initialized components
     * @param {DisplayManager} components.displayManager - Display manager instance
     * @param {PixelShift} components.pixelShift - Pixel shift instance
     * @param {PixelRefresh} components.pixelRefresh - Pixel refresh instance
     * @param {Dimming} components.dimming - Dimming instance
     * @param {Function} components.openPreferences - Callback to open preferences
     */
    _init(settings, components = {}) {
        super._init(0.0, 'OLED Care Indicator');

        // Initialize fields in _init (class field initializers don't run in GObject classes)
        this._openPreferencesCallback = null;
        this._settings = null;
        this._sessionMode = null;
        this._menuItems = {};
        this._displayManager = null;
        this._pixelShift = null;
        this._dimming = null;
        this._pixelRefresh = null;
        this._notificationSource = null;
        this._sessionModeChangedId = null;
        this._debug = null;
        this._resourceManager = null;
        this._signalManager = null;
        this._settingsConnections = [];
        this._abortController = new AbortController();
        this._ownedComponents = [];
        this._displayRefreshHandler = null;

        try {
            this._settings = settings;
            this._sessionMode = Main.sessionMode;

            // Store pre-initialized components if provided
            this._displayManager = components.displayManager;
            this._pixelShift = components.pixelShift;
            this._pixelRefresh = components.pixelRefresh;
            this._dimming = components.dimming;

            // Store openPreferences callback and extension directory
            this._openPreferencesCallback = components.openPreferences;
            this._extensionDir = components.extensionDir;
            
            // Initialize debug mode based on settings
            const debugMode = this._settings?.get_boolean(CONSTANTS.SETTINGS.DEBUG_MODE) ?? false;
            this._debug = debugMode ? this._logDebug.bind(this) : () => {};
            
            // Start tracking performance
            metrics.setEnabled(debugMode);
            
            // Set up resource and signal managers
            this._resourceManager = new ResourceManager(this._debug);
            this._signalManager = new SignalManager(this._debug);
            
            // Validate required settings
            this._validateSettings();
            
            // Initialize component managers with dependency injection
            this._initializeComponents();
            
            // Create notification source for system notifications
            this._createNotificationSource();
            
            // Create panel UI
            this._createPanelIcon();
            
            // Build menu and bind settings
            try {
                this._buildMenu();
                this._bindSettings();
            } catch (error) {
                console.error(`[OLED Care] build_menu/bindSettings inner error: ${error.message}\n${error.stack}`);
                throw IndicatorError.operationFailed('build_menu', error);
            }
            
            // Initialize features (async - display menu will rebuild when ready)
            this._debug('Initializing features...');
            this._initializeFeatures().catch(error => {
                console.error(`[OLED Care] [Indicator] Feature init error: ${error.message}`);
            });
            
            // Connect to session mode changes
            this._connectSessionModeSignal();
            
            // Show welcome notification only in user mode
            if (this._sessionMode.currentMode === 'user') {
                this._showNotification('OLED Care Active', 'Protecting your OLED display');
            }
            
            this._debug('Indicator initialization complete');
        } catch (error) {
            console.error(`[OLED Care] [Indicator] Construction error: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Update the indicator status display
     * @param {string} status - Current extension status
     * @param {Error} [error] - Optional error if status is ERROR
     */
    updateStatus(status, error) {
        this._debug?.(`Status updated: ${status}${error ? ` (${error.message})` : ''}`);
    }

    updateComponentStatus(component, enabled) {
        this._debug?.(`Component ${component}: ${enabled ? 'enabled' : 'disabled'}`);
    }

    updateErrorStatus(stats) {
        this._debug?.(`Error stats updated: ${JSON.stringify(stats)}`);
    }

    notifyPerformanceIssue(value) {
        this._debug?.(`Performance issue: ${value}`);
    }

    /**
     * Log a debug message with component prefix
     * @param {string} message - Message to log
     * @private
     */
    _logDebug(message) {
        console.log(`[OLED Care] [Indicator] ${message}`);
        
        // Track debug message in metrics
        metrics.incrementCounter('debug_messages', 1, { component: 'Indicator' });
    }
    
    /**
     * Validate required settings
     * @private
     * @throws {IndicatorError} If settings validation fails
     */
    _validateSettings() {
        try {
            if (!this._settings) {
                throw new IndicatorError('Settings object is null or undefined', {
                    context: 'validation'
                });
            }
            
            const schemas = this._settings.list_keys();
            
            // Check for required settings
            for (const setting of OledCareIndicator.REQUIRED_SETTINGS) {
                if (!schemas.includes(setting)) {
                    this._debug(`Warning: Required setting '${setting}' not found in schema`);
                }
            }
        } catch (error) {
            // Re-throw errors with proper context
            if (!(error instanceof IndicatorError)) {
                throw new IndicatorError(`Settings validation failed: ${error.message}`, { 
                    cause: error,
                    context: 'validation'
                });
            }
            throw error;
        }
    }
    
    /**
     * Initialize component managers
     * @private
     */
    _initializeComponents() {
        const timer = metrics.startTimer('init_components');

        try {
            // Only create components if they weren't provided to constructor.
            // Components passed in are owned (and destroyed) by the extension;
            // only the ones created here are destroyed by the indicator.
            if (!this._displayManager) {
                this._displayManager = new DisplayManager(this._settings);
                this._ownedComponents.push(this._displayManager);
            }
            if (!this._pixelShift) {
                this._pixelShift = new PixelShift(this._settings);
                this._ownedComponents.push(this._pixelShift);
            }
            if (!this._dimming) {
                this._dimming = new Dimming(this._settings);
                this._ownedComponents.push(this._dimming);
            }
            if (!this._pixelRefresh) {
                this._pixelRefresh = new PixelRefresh(this._settings);
                this._ownedComponents.push(this._pixelRefresh);
            }

            // Inject dependencies
            this._displayManager.setResourceManager?.(this._resourceManager);
            this._displayManager.setSignalManager?.(this._signalManager);
            this._pixelShift.setResourceManager?.(this._resourceManager);
            this._pixelShift.setSignalManager?.(this._signalManager);
            this._dimming.setResourceManager?.(this._resourceManager);
            this._dimming.setSignalManager?.(this._signalManager);
            this._pixelRefresh.setResourceManager?.(this._resourceManager);
            this._pixelRefresh.setSignalManager?.(this._signalManager);

            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();

            this._debug(`Error initializing components: ${error.message}`);
            throw IndicatorError.operationFailed('init_components', error);
        }
    }
    
    /**
     * Create notification source for system notifications
     * @private
     */
    _createNotificationSource() {
        // The source is created lazily in _getNotificationSource(): a
        // MessageTray.Source destroys itself once its last notification is
        // gone, so holding one across the session leaves a dead reference.
        this._notificationSource = null;
    }

    /**
     * Get (or create) a live notification source
     * @returns {MessageTray.Source|null}
     * @private
     */
    _getNotificationSource() {
        if (this._notificationSource)
            return this._notificationSource;

        try {
            const source = new MessageTray.Source({
                title: 'OLED Care',
                icon: this._getIcon(),
            });
            source.connect('destroy', () => {
                if (this._notificationSource === source)
                    this._notificationSource = null;
            });
            Main.messageTray.add(source);
            this._notificationSource = source;
        } catch (error) {
            this._debug(`Error creating notification source: ${error.message}`);
        }
        return this._notificationSource;
    }

    /**
     * The extension's symbolic icon as a Gio.Icon. The icon is shipped inside
     * the extension, so it is not in the icon theme and must be loaded by file.
     * @returns {Gio.Icon}
     * @private
     */
    _getIcon() {
        if (this._extensionDir) {
            const iconFile = this._extensionDir
                .get_child('icons')
                .get_child('symbolic')
                .get_child('oled-care-symbolic.svg');

            if (iconFile.query_exists(null))
                return Gio.FileIcon.new(iconFile);
        }
        // Fallback to icon name lookup (works if icon is in theme path)
        return new Gio.ThemedIcon({ name: 'oled-care-symbolic' });
    }

    _createPanelIcon() {
        try {
            const icon = new St.Icon({
                gicon: this._getIcon(),
                style_class: 'system-status-icon'
            });

            this.add_child(icon);
        } catch (error) {
            this._debug(`Error creating panel icon: ${error.message}`);
            throw IndicatorError.operationFailed('create_panel_icon', error);
        }
    }
    
    /**
     * Initialize all feature components
     * @private
     */
    async _initializeFeatures() {
        const timer = metrics.startTimer('init_features');

        try {
            // Await async init methods (displayManager, dimming, pixelRefresh are async)
            await this._displayManager.init();
            this._pixelShift.init();
            await this._dimming.init();

            // Set display manager on pixel refresh before init
            this._pixelRefresh.setDisplayManager?.(this._displayManager);
            await this._pixelRefresh.init();

            // Rebuild display menu now that displayManager has detected monitors
            this._rebuildDisplayMenu();

            // Listen for future monitor changes to update display menu
            if (typeof this._displayManager.on === 'function') {
                this._displayRefreshHandler = () => this._rebuildDisplayMenu();
                this._displayManager.on('refreshed', this._displayRefreshHandler);
            }

            this._debug('Features initialized');
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();

            this._debug(`Error initializing features: ${error.message}`);
            this._showNotification('Error', 'Failed to initialize some features');

            throw IndicatorError.operationFailed('init_features', error);
        }
    }
    
    /**
     * Connect to session mode changes
     * @private
     */
    _connectSessionModeSignal() {
        try {
            if (this._sessionMode) {
                this._sessionModeChangedId = this._signalManager.connect(
                    this._sessionMode,
                    'updated',
                    this._onSessionModeChanged.bind(this),
                    'session-mode-changed'
                );
            }
        } catch (error) {
            this._debug(`Error connecting to session mode signal: ${error.message}`);
            // Non-critical error, can continue without session mode handling
        }
    }

    /**
     * Handle session mode changes
     * @private
     */
    _onSessionModeChanged() {
        const timer = metrics.startTimer('session_mode_changed');
        
        try {
            const mode = this._sessionMode.currentMode;
            this._debug(`Session mode changed to: ${mode}`);
            
            switch (mode) {
                case 'user':
                    this._enableFullFunctionality();
                    break;
                case 'unlock-dialog':
                    this._enableLimitedFunctionality();
                    break;
                default:
                    this._disableFeatures();
                    break;
            }
            
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this._debug(`Error handling session mode change: ${error.message}`);
        }
    }

    /**
     * Enable full functionality in normal user mode
     * @private
     */
    _enableFullFunctionality() {
        const timer = metrics.startTimer('enable_full_functionality');
        
        try {
            this._debug('Enabling full functionality');
            this.show();
            this.setSensitive(true);
            this._displayManager.enable();
            // Back from the lock screen: only re-enable what the user has turned on.
            // (Previously pixel refresh and dimming were enabled unconditionally.)
            const s = CONSTANTS.SETTINGS;
            if (this._settings.get_boolean(s.PIXEL_SHIFT_ENABLED))
                this._pixelShift.enable();
            if (this._settings.get_boolean(s.SCREEN_DIM_ENABLED))
                this._dimming.enable();
            if (this._settings.get_boolean(s.PIXEL_REFRESH_ENABLED))
                this._pixelRefresh.enable();
            
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this._debug(`Error enabling full functionality: ${error.message}`);
        }
    }

    /**
     * Enable limited functionality in lock screen mode
     * @private
     */
    _enableLimitedFunctionality() {
        const timer = metrics.startTimer('enable_limited_functionality');
        
        try {
            this._debug('Enabling limited functionality');
            this.hide();
            this.setSensitive(false);
            this._displayManager.enableLimited();
            if (this._settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED))
                this._pixelShift.enable();
            this._dimming.enableLimited();
            this._pixelRefresh.disable();
            
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this._debug(`Error enabling limited functionality: ${error.message}`);
        }
    }

    /**
     * Disable all features
     * @private
     */
    _disableFeatures() {
        const timer = metrics.startTimer('disable_features');
        
        try {
            this._debug('Disabling all features');
            this.hide();
            this.setSensitive(false);
            this._displayManager.disable();
            this._pixelShift.disable();
            this._dimming.disable();
            this._pixelRefresh.disable();
            
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this._debug(`Error disabling features: ${error.message}`);
        }
    }

    /**
     * Build the indicator menu
     * @private
     */
    _buildMenu() {
        const timer = metrics.startTimer('build_menu');
        
        try {
            this._debug('Building menu');
            
            // Header
            const headerItem = new PopupMenu.PopupMenuItem('OLED Care', { 
                reactive: false,
                style_class: 'popup-menu-header oled-care-header'
            });
            this.menu.addMenuItem(headerItem);
            
            // Separator
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            
            // Display selection submenu
            this._menuItems.displaySubmenu = new PopupMenu.PopupSubMenuMenuItem('Displays');
            this._rebuildDisplayMenu();
            this.menu.addMenuItem(this._menuItems.displaySubmenu);
            
            // Separator
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            
            // Pixel Shift toggle
            this._menuItems.pixelShift = new PopupMenu.PopupSwitchMenuItem('Pixel Shift');
            this._menuItems.pixelShift.setToggleState(
                this._settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED)
            );
            this._menuItems.pixelShift.connect('toggled', (item) => {
                this._settings.set_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED, item.state);
            });
            this.menu.addMenuItem(this._menuItems.pixelShift);
            
            // Screen Dimming toggle
            this._menuItems.screenDim = new PopupMenu.PopupSwitchMenuItem('Screen Dimming');
            this._menuItems.screenDim.setToggleState(
                this._settings.get_boolean(CONSTANTS.SETTINGS.SCREEN_DIM_ENABLED)
            );
            this._menuItems.screenDim.connect('toggled', (item) => {
                this._settings.set_boolean(CONSTANTS.SETTINGS.SCREEN_DIM_ENABLED, item.state);
            });
            this.menu.addMenuItem(this._menuItems.screenDim);
            
            // Window Dimming toggle
            this._menuItems.windowDim = new PopupMenu.PopupSwitchMenuItem('Window Dimming');
            this._menuItems.windowDim.setToggleState(
                this._settings.get_boolean(CONSTANTS.SETTINGS.UNFOCUS_DIM_ENABLED)
            );
            this._menuItems.windowDim.connect('toggled', (item) => {
                this._settings.set_boolean(CONSTANTS.SETTINGS.UNFOCUS_DIM_ENABLED, item.state);
            });
            this.menu.addMenuItem(this._menuItems.windowDim);
            
            // Pixel Refresh toggle
            this._menuItems.pixelRefresh = new PopupMenu.PopupSwitchMenuItem('Pixel Refresh');
            this._menuItems.pixelRefresh.setToggleState(
                this._settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_ENABLED)
            );
            this._menuItems.pixelRefresh.connect('toggled', (item) => {
                this._settings.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_ENABLED, item.state);
            });
            this.menu.addMenuItem(this._menuItems.pixelRefresh);
            
            // Manual Pixel Refresh
            this._menuItems.manualRefresh = new PopupMenu.PopupMenuItem('Run Pixel Refresh Now');
            this._menuItems.manualRefresh.setSensitive(
                !this._settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_RUNNING)
            );
            this._menuItems.manualRefresh.connect('activate', () => {
                this._pixelRefresh.runManualRefresh();
            });
            this.menu.addMenuItem(this._menuItems.manualRefresh);
            
            // Separator
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            
            // Settings button
            const settingsItem = new PopupMenu.PopupMenuItem('Settings');
            settingsItem.connect('activate', () => {
                try {
                    // Call the openPreferences callback if provided
                    if (this._openPreferencesCallback) {
                        this._openPreferencesCallback();
                    } else {
                        this._debug('No openPreferences callback provided');
                    }
                } catch (error) {
                    this._debug(`Error opening preferences: ${error.message}`);
                }
            });
            this.menu.addMenuItem(settingsItem);
            
            this._debug('Menu built');
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();

            console.error(`[OLED Care] _buildMenu ORIGINAL error: ${error.message}\n${error.stack}`);
            throw IndicatorError.operationFailed('build_menu', error);
        }
    }
    
    /**
     * Rebuild the display submenu with current monitors
     * @private
     */
    _rebuildDisplayMenu() {
        if (!this._menuItems.displaySubmenu) return;

        const submenu = this._menuItems.displaySubmenu.menu;
        submenu.removeAll();

        try {
            const displays = this._displayManager?.getDisplayInfo?.() ?? [];
            if (displays.length === 0) {
                const noDisplays = new PopupMenu.PopupMenuItem('No displays detected', {reactive: false});
                submenu.addMenuItem(noDisplays);
                return;
            }

            for (const display of displays) {
                const label = `${display.name}${display.isPrimary ? ' (Primary)' : ''}`;
                const item = new PopupMenu.PopupSwitchMenuItem(label, display.isProtected);
                item.connect('toggled', () => {
                    // Match by index: two identical monitors share the same name
                    const monitor = this._displayManager.getDisplays().find(
                        m => m.index === display.index
                    );
                    if (monitor) {
                        this._displayManager.toggleProtection(monitor);
                    }
                });
                submenu.addMenuItem(item);
            }
        } catch (error) {
            this._debug?.(`Error building display menu: ${error.message}`);
            const errorItem = new PopupMenu.PopupMenuItem('Error loading displays', {reactive: false});
            submenu.addMenuItem(errorItem);
        }
    }

    /**
     * Bind settings to update UI and components
     * @private
     */
    _bindSettings() {
        const timer = metrics.startTimer('bind_settings');
        
        try {
            this._debug('Binding settings');
            
            // Bind pixel shift settings
            this._connectSetting(
                CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED,
                (value) => {
                    if (this._menuItems.pixelShift) {
                        this._menuItems.pixelShift.setToggleState(value);
                    }
                }
            );
            
            // Bind dimming settings
            this._connectSetting(
                CONSTANTS.SETTINGS.SCREEN_DIM_ENABLED,
                (value) => {
                    if (this._menuItems.screenDim) {
                        this._menuItems.screenDim.setToggleState(value);
                    }
                }
            );
            
            this._connectSetting(
                CONSTANTS.SETTINGS.UNFOCUS_DIM_ENABLED,
                (value) => {
                    if (this._menuItems.windowDim) {
                        this._menuItems.windowDim.setToggleState(value);
                    }
                }
            );
            
            // Bind pixel refresh settings
            this._connectSetting(
                CONSTANTS.SETTINGS.PIXEL_REFRESH_ENABLED,
                (value) => {
                    if (this._menuItems.pixelRefresh) {
                        this._menuItems.pixelRefresh.setToggleState(value);
                    }
                }
            );
            
            // Update manual refresh item sensitivity based on pixel refresh running state
            this._connectSetting(
                CONSTANTS.SETTINGS.PIXEL_REFRESH_RUNNING,
                (value) => {
                    if (this._menuItems.manualRefresh) {
                        this._menuItems.manualRefresh.setSensitive(!value);
                    }
                }
            );
            
            // Bind component properties directly using GSettings bind
            this._bindComponentProperties();
            
            this._debug('Settings bound');
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this._debug(`Error binding settings: ${error.message}`);
            throw IndicatorError.operationFailed('bind_settings', error);
        }
    }
    
    /**
     * Connect a setting to a callback using SignalManager
     * @param {string} settingKey - The setting key to monitor
     * @param {function} callback - Function to call when setting changes
     * @private
     */
    _connectSetting(settingKey, callback) {
        if (!this._signalManager || !this._settings) return;
        
        const id = this._signalManager.connect(
            this._settings,
            `changed::${settingKey}`,
            () => {
                const value = this._getSettingValue(settingKey);
                callback(value);
            },
            `setting-${settingKey}`
        );
        
        this._settingsConnections.push(id);
    }
    
    /**
     * Get the value of a setting based on its type
     * @param {string} settingKey - The setting key
     * @returns {any} The setting value
     * @private
     */
    _getSettingValue(settingKey) {
        if (!this._settings) return null;
        
        // Determine setting type and get value accordingly
        if (settingKey.includes('enabled')) {
            return this._settings.get_boolean(settingKey);
        } else if (settingKey.includes('interval') || 
                  settingKey.includes('level') || 
                  settingKey.includes('timeout') ||
                  settingKey.includes('speed') ||
                  settingKey.includes('progress') ||
                  settingKey.includes('remaining')) {
            return this._settings.get_int(settingKey);
        } else if (settingKey.includes('schedule')) {
            return this._settings.get_strv(settingKey);
        } else {
            // Default to boolean for unknown types
            return this._settings.get_boolean(settingKey);
        }
    }
    
    /**
     * Bind component properties directly using GSettings
     * @private
     */
    _bindComponentProperties() {
        // Direct property bindings for GObject-based components
        const bindings = [
            // PixelShift bindings
            [CONSTANTS.SETTINGS.PIXEL_SHIFT_INTERVAL, this._pixelShift, 'interval'],
            
            // Dimming bindings
            [CONSTANTS.SETTINGS.DIMMING_LEVEL, this._dimming, 'level'],
            [CONSTANTS.SETTINGS.SCREEN_DIM_TIMEOUT, this._dimming, 'timeout'],
            [CONSTANTS.SETTINGS.UNFOCUS_DIM_LEVEL, this._dimming, 'unfocusLevel'],
            
            // PixelRefresh bindings
            [CONSTANTS.SETTINGS.PIXEL_REFRESH_SPEED, this._pixelRefresh, 'speed'],
            [CONSTANTS.SETTINGS.PIXEL_REFRESH_SMART, this._pixelRefresh, 'smart'],
            [CONSTANTS.SETTINGS.PIXEL_REFRESH_SCHEDULE, this._pixelRefresh, 'schedule'],
            
            // DisplayManager bindings
            [CONSTANTS.SETTINGS.ENABLED_DISPLAYS, this._displayManager, 'enabledDisplays']
        ];
        
        // Bind each property if target component has the property
        for (const [settingKey, target, property] of bindings) {
            if (target && Object.hasOwn(target, property)) {
                this._settings.bind(
                    settingKey, 
                    target, 
                    property, 
                    Gio.SettingsBindFlags.DEFAULT
                );
            }
        }
    }
    
    /**
     * Show a notification to the user
     * @param {string} title - Notification title
     * @param {string} message - Notification message
     * @private
     */
    _showNotification(title, message) {
        try {
            const source = Main.messageTray ? this._getNotificationSource() : null;
            if (!source) {
                this._debug('Warning: Notification system not available');
                return;
            }

            const notification = new MessageTray.Notification({
                source,
                title: title,
                body: message,
                isTransient: true
            });
            
            try {
                // GNOME 46+ API (Source.showNotification() was removed)
                source.addNotification(notification);
                this._debug(`Notification shown: ${title} - ${message}`);
                
                // Track notification in metrics
                metrics.incrementCounter('notifications', 1, { title });
            } catch (showError) {
                this._debug(`Failed to show notification: ${showError.message}`);
            }
        } catch (error) {
            this._debug(`Error creating notification: ${error.message}`);
        }
    }

    /**
     * Clean up resources before destruction.
     *
     * Must be synchronous: Main.panel.addToStatusArea() removes our role from
     * statusArea on the actor's 'destroy' signal. An async destroy() delayed
     * that, so a quick disable/enable failed with "Extension point conflict".
     */
    destroy() {
        const timer = metrics.startTimer('indicator_destroy');

        try {
            this._debug?.('Destroying indicator');

            this._abortController.abort('Component destruction');

            if (this._displayRefreshHandler && typeof this._displayManager?.off === 'function')
                this._displayManager.off('refreshed', this._displayRefreshHandler);
            else if (this._displayRefreshHandler)
                this._displayManager?.removeListener?.('refreshed', this._displayRefreshHandler);
            this._displayRefreshHandler = null;

            // Disconnect everything connected through our signal manager
            // (settings signals, session mode, component settings signals)
            this._settingsConnections = [];
            this._sessionModeChangedId = null;
            this._signalManager?.destroy?.();

            // Destroy only the components this indicator created itself
            for (const component of this._ownedComponents) {
                Promise.resolve(component?.destroy?.()).catch(error => {
                    console.error(`[OLED Care] [Indicator] Error destroying component: ${error.message}`);
                });
            }
            this._ownedComponents = [];

            // Only destroy the source if it is still alive (it self-destroys
            // when its notifications expire; the 'destroy' handler clears it)
            const source = this._notificationSource;
            this._notificationSource = null;
            source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);

            this._resourceManager?.destroy?.();
            this._resourceManager = null;
            this._signalManager = null;
        } catch (error) {
            console.error(`[OLED Care] [Indicator] Error destroying indicator: ${error.message}`);
        }

        timer.addLabels?.({ phase: 'destroy' });
        timer.stop();

        super.destroy();
    }
}

// Register the GObject class instead of using decorator
OledCareIndicator = GObject.registerClass({
    GTypeName: 'OledCareIndicator'
}, OledCareIndicator);