'use strict';

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

// Import modules conditionally based on environment
const isTestEnv = GLib.getenv('G_TEST_SRCDIR') !== null;

const Main = isTestEnv
    ? (await import('../tests/unit/mocks/main.js')).default
    : (await import('resource:///org/gnome/shell/ui/main.js'));

// gi:// modules only have a default export, so take the class off the
// default namespace object (destructuring the module itself yields undefined).
const { BrightnessContrastEffect } = isTestEnv
    ? await import('../tests/unit/mocks/clutter.js')
    : (await import('gi://Clutter')).default;

/**
 * Custom error classes for better error handling
 */
class DimmingError extends Error {
    constructor(message, options = {}) {
        // Using Error.cause for better error chaining (ES2022)
        super(message, { cause: options.cause });
        this.name = 'DimmingError';
        
        // Add additional context if provided
        this.context = options.context ?? null;
        this.timestamp = new Date();
    }
    
    /**
     * Format the error with additional context for logging
     * @returns {string} Formatted error message
     */
    format() {
        const contextInfo = this.context ? ` (Context: ${this.context})` : '';
        const causeInfo = this.cause ? `\n  Caused by: ${this.cause.message}` : '';
        return `${this.name}: ${this.message}${contextInfo}${causeInfo}`;
    }
}

class SettingsValidationError extends DimmingError {
    constructor(key, type, options = {}) {
        super(`Failed to validate setting: ${key} (${type})`, options);
        this.name = 'SettingsValidationError';
        this.key = key;
        this.type = type;
    }
}

class EffectApplicationError extends DimmingError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'EffectApplicationError';
    }
}

/**
 * Screen dimming functionality for OLED displays
 * Manages screen dimming effects to reduce OLED panel wear
 */
export default class Dimming extends GObject.Object {
    // Static initialization block for constants and configuration
    static {
        this.DEBUG_MODE_KEY = 'debug-mode';
        this.SCREEN_DIM_ENABLED_KEY = 'screen-dim-enabled';
        this.DIMMING_LEVEL_KEY = 'dimming-level';
        this.SCREEN_DIM_TIMEOUT_KEY = 'screen-dim-timeout';
        this.EFFECT_NAME = 'oled-care-dimming';
        
        // Define required settings keys by type
        this.REQUIRED_BOOLEAN_KEYS = [
            this.DEBUG_MODE_KEY,
            this.SCREEN_DIM_ENABLED_KEY
        ];
        
        this.REQUIRED_INT_KEYS = [
            this.DIMMING_LEVEL_KEY,
            this.SCREEN_DIM_TIMEOUT_KEY
        ];
        
        // All required settings combined
        this.ALL_REQUIRED_KEYS = [
            ...this.REQUIRED_BOOLEAN_KEYS,
            ...this.REQUIRED_INT_KEYS
        ];
        
        // Error messages as a frozen object for consistency
        this.ERROR_MESSAGES = Object.freeze({
            INIT_FAILED: 'Failed to initialize dimming component',
            MISSING_SETTING: 'Missing required setting',
            APPLY_ERROR: 'Error applying dimming effect',
            REMOVE_ERROR: 'Error removing dimming effect',
            SCHEDULE_ERROR: 'Error scheduling dimming',
            CANCEL_ERROR: 'Error canceling scheduled dimming'
        });
        
        // Default configuration values
        this.DEFAULTS = Object.freeze({
            DIMMING_LEVEL: 30,
            TIMEOUT: 300,
            DEBUG: false
        });
    }

    // Private field declarations (initializers moved to constructor for GObject compatibility)
    #settings;
    #debug;
    #enabled;
    #dimmingEffect;
    #idleMonitor;
    #idleWatchId;
    #activeWatchId;
    #settingsSignalIds;

    /**
     * Constructor for the Dimming component
     * @param {object} settings - GSettings instance
     */
    constructor(settings) {
        super();

        // Initialize fields in constructor (class field initializers don't run in GObject classes)
        this.#enabled = false;
        this.#dimmingEffect = null;
        this.#idleMonitor = null;
        this.#idleWatchId = 0;
        this.#activeWatchId = 0;
        this.#settingsSignalIds = [];

        try {
            this.#settings = settings;

            this.#debug = settings?.get_boolean(Dimming.DEBUG_MODE_KEY) ?? Dimming.DEFAULTS.DEBUG
                ? this.#logDebug.bind(this)
                : () => {};

            this.#validateSettings();

            this.#debug('Dimming component initialized');
        } catch (error) {
            throw new DimmingError(Dimming.ERROR_MESSAGES.INIT_FAILED, {
                cause: error,
                context: 'constructor'
            });
        }
    }

    /**
     * Validate required settings
     * @private
     * @throws {SettingsValidationError} If settings validation fails
     */
    #validateSettings() {
        if (!this.#settings) {
            throw new SettingsValidationError('settings', 'object', {
                context: 'validation',
                cause: new Error('Settings object is null or undefined')
            });
        }

        for (const key of Dimming.REQUIRED_BOOLEAN_KEYS) {
            try {
                this.#settings.get_boolean(key);
            } catch (error) {
                throw new SettingsValidationError(key, 'boolean', { cause: error });
            }
        }

        for (const key of Dimming.REQUIRED_INT_KEYS) {
            try {
                this.#settings.get_int(key);
            } catch (error) {
                throw new SettingsValidationError(key, 'integer', { cause: error });
            }
        }
    }

    /**
     * Brightness offset for the current dimming level.
     * ClutterBrightnessContrastEffect uses -1.0 (black) .. 0.0 (unchanged) .. 1.0 (white).
     * @returns {number}
     * @private
     */
    #brightnessForLevel() {
        const level = this.#settings?.get_int(Dimming.DIMMING_LEVEL_KEY) ?? Dimming.DEFAULTS.DIMMING_LEVEL;
        const clamped = Math.max(0, Math.min(100, level));
        return -(clamped / 100);
    }

    /**
     * Lazily get the core idle monitor (tracks real user input)
     * @returns {Meta.IdleMonitor|null}
     * @private
     */
    #getIdleMonitor() {
        this.#idleMonitor ??= global.backend?.get_core_idle_monitor?.() ?? null;
        return this.#idleMonitor;
    }

    /**
     * Apply dimming effect to the screen
     * @returns {Promise<boolean>} True if successful
     */
    async applyDimming() {
        if (this.#dimmingEffect) {
            this.#debug('Dimming already active, skipping');
            return true;
        }

        this.#debug('Applying screen dimming');

        try {
            if (!Main.layoutManager?.uiGroup) {
                throw new EffectApplicationError('Main.layoutManager.uiGroup not available', {
                    context: 'apply'
                });
            }

            // The brightness/contrast properties are CoglColor on GNOME 47+,
            // so set the value through the float setter instead of the constructor.
            const effect = new BrightnessContrastEffect();
            const brightness = this.#brightnessForLevel();
            effect.set_brightness(brightness);
            Main.layoutManager.uiGroup.add_effect_with_name(Dimming.EFFECT_NAME, effect);
            this.#dimmingEffect = effect;

            // Undim as soon as the user is active again
            const monitor = this.#getIdleMonitor();
            if (monitor && !this.#activeWatchId) {
                this.#activeWatchId = monitor.add_user_active_watch(() => {
                    this.#activeWatchId = 0;
                    this.#debug('User active, removing dimming');
                    this.removeDimming().catch(e => this.#debug(`Undim failed: ${e.message}`));
                });
            }

            this.#debug(`Dimming applied (brightness ${brightness})`);
            return true;
        } catch (error) {
            this.#debug(`Error applying dimming: ${error.message}`);
            this.#removeEffect();
            throw new EffectApplicationError(Dimming.ERROR_MESSAGES.APPLY_ERROR, {
                cause: error,
                context: 'apply'
            });
        }
    }

    /**
     * Arm an idle watch that dims the screen after the configured idle time
     * @returns {Promise<boolean>} True if scheduled successfully
     */
    async scheduleDimming() {
        if (this.#idleWatchId) {
            this.#debug('Dimming already scheduled, skipping');
            return true;
        }

        if (!this.#enabled) {
            this.#debug('Dimming not enabled, skipping scheduling');
            return false;
        }

        try {
            const timeout = this.#settings?.get_int(Dimming.SCREEN_DIM_TIMEOUT_KEY) ??
                Dimming.DEFAULTS.TIMEOUT;
            const monitor = this.#getIdleMonitor();
            if (!monitor)
                throw new Error('Idle monitor not available');

            // Idle watches re-fire every time the user goes idle for this long
            this.#idleWatchId = monitor.add_idle_watch(Math.max(1, timeout) * 1000, () => {
                this.#debug('Idle timeout reached');
                this.applyDimming().catch(e => this.#debug(`Scheduled dimming failed: ${e.message}`));
            });

            this.#debug(`Dimming armed after ${timeout}s of inactivity`);
            return true;
        } catch (error) {
            this.#debug(`Error scheduling dimming: ${error.message}`);
            this.cancelScheduledDimming();
            throw new DimmingError(Dimming.ERROR_MESSAGES.SCHEDULE_ERROR, {
                cause: error,
                context: 'schedule'
            });
        }
    }

    /**
     * Cancel the idle watch (and any pending user-active watch)
     * @returns {boolean} True if a scheduled dimming was canceled
     */
    cancelScheduledDimming() {
        const monitor = this.#idleMonitor;
        let cancelled = false;

        if (monitor && this.#idleWatchId) {
            monitor.remove_watch(this.#idleWatchId);
            cancelled = true;
        }
        this.#idleWatchId = 0;

        return cancelled;
    }

    /**
     * Remove our effect from the UI group (synchronous helper)
     * @private
     */
    #removeEffect() {
        if (this.#activeWatchId && this.#idleMonitor) {
            this.#idleMonitor.remove_watch(this.#activeWatchId);
        }
        this.#activeWatchId = 0;

        const uiGroup = Main.layoutManager?.uiGroup;
        const effect = uiGroup?.get_effect(Dimming.EFFECT_NAME);
        if (effect)
            uiGroup.remove_effect(effect);
        this.#dimmingEffect = null;
    }

    /**
     * Remove dimming effect from screen
     * @returns {Promise<boolean>} True if successfully removed
     */
    async removeDimming() {
        if (!this.#dimmingEffect) {
            this.#debug('No active dimming to remove');
            return true;
        }

        try {
            this.#removeEffect();
            this.#debug('Dimming removed');
            return true;
        } catch (error) {
            this.#dimmingEffect = null;
            throw new EffectApplicationError(Dimming.ERROR_MESSAGES.REMOVE_ERROR, {
                cause: error,
                context: 'remove'
            });
        }
    }

    /**
     * React to dimming level / timeout changes while enabled
     * @private
     */
    #connectSettings() {
        if (!this.#settings || this.#settingsSignalIds.length > 0)
            return;

        this.#settingsSignalIds.push(
            this.#settings.connect(`changed::${Dimming.DIMMING_LEVEL_KEY}`, () => {
                this.#dimmingEffect?.set_brightness(this.#brightnessForLevel());
            }),
            this.#settings.connect(`changed::${Dimming.SCREEN_DIM_TIMEOUT_KEY}`, () => {
                if (!this.#enabled)
                    return;
                this.cancelScheduledDimming();
                this.scheduleDimming().catch(e => this.#debug(`Reschedule failed: ${e.message}`));
            })
        );
    }

    #disconnectSettings() {
        for (const id of this.#settingsSignalIds)
            this.#settings?.disconnect(id);
        this.#settingsSignalIds = [];
    }

    /**
     * Clean up all resources
     */
    async destroy() {
        this.#debug('Destroying Dimming component');
        this.disable();
        this.#idleMonitor = null;
        this.#debug('Dimming component destroyed');
    }

    /**
     * Log a debug message
     * @param {string} message - Message to log
     * @private
     */
    #logDebug(message) {
        console.log(`[OLED Care] [Dimming] ${message}`);
    }

    /**
     * Initialize the dimming component
     * @returns {Promise<boolean>} Success status
     */
    async init() {
        this.#debug('Initializing dimming component');
        return true;
    }

    /**
     * Enable dimming functionality
     */
    enable() {
        this.#debug('Enabling dimming');
        this.#enabled = true;
        this.#connectSettings();

        if (this.#settings?.get_boolean(Dimming.SCREEN_DIM_ENABLED_KEY) ?? false) {
            this.scheduleDimming().catch(error => {
                this.#debug(`Error scheduling dimming: ${error.message}`);
            });
        }
    }

    /**
     * Disable dimming functionality
     */
    disable() {
        this.#debug('Disabling dimming');
        this.#enabled = false;
        this.cancelScheduledDimming();
        this.#removeEffect();
        this.#disconnectSettings();
    }

    /**
     * Enable dimming in limited mode (for lock screen)
     */
    enableLimited() {
        this.#debug('Enabling dimming in limited mode');
        // Keep whatever idle watch is already armed; nothing else to do on the lock screen
    }

    /**
     * Get current status of dimming
     * @returns {object} Status information
     */
    getStatus() {
        return {
            enabled: this.#enabled,
            active: this.#dimmingEffect !== null,
            scheduled: this.#idleWatchId !== 0
        };
    }
}

// Register the GObject class instead of using decorator
Dimming = GObject.registerClass({
    GTypeName: 'OledCareDimming'
}, Dimming);
