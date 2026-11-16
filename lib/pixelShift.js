'use strict';

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Import error handling and utilities
import { ExtensionError } from './errors.js';
import { metrics } from './metrics.js';
import { removeSource } from './compatibility.js';

// Defined as a frozen object for immutability
const CONSTANTS = Object.freeze({
    DEFAULT_AMOUNT: 4, // maximum offset from home, in logical pixels
    MAX_AMOUNT: 10,
    DEFAULT_INTERVAL: 120, // seconds between 1 px steps
    SETTINGS: {
        DEBUG_MODE: 'debug-mode',
        PIXEL_SHIFT_ENABLED: 'pixel-shift-enabled',
        PIXEL_SHIFT_INTERVAL: 'pixel-shift-interval',
        PIXEL_SHIFT_AMOUNT: 'pixel-shift-amount',
        PIXEL_SHIFT_STEP: 'pixel-shift-step'
    },
    PERFORMANCE_BUDGET: {
        SHIFT_OPERATION: 5 // milliseconds
    }
});

/**
 * Every offset within `radius` pixels of home, as a square spiral starting
 * at (0, 0). Consecutive positions are exactly 1 px apart and each offset in
 * the (2r+1) x (2r+1) square appears once.
 * @param {number} radius - maximum offset in pixels
 * @returns {Array<{x: number, y: number}>}
 */
export function buildShiftPath(radius) {
    const total = (2 * radius + 1) ** 2;
    const path = [{x: 0, y: 0}];
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let x = 0, y = 0, leg = 1, dir = 0;
    while (path.length < total) {
        // Leg lengths go 1, 1, 2, 2, 3, 3, ...
        for (let turn = 0; turn < 2 && path.length < total; turn++, dir++) {
            const [dx, dy] = dirs[dir % 4];
            for (let i = 0; i < leg && path.length < total; i++) {
                x += dx;
                y += dy;
                path.push({x, y});
            }
        }
        leg++;
    }
    return path;
}

/**
 * Number of steps in one full cycle: out along the spiral and back again,
 * so the move from the last step to the first is also 1 px.
 * @param {Array} path - from buildShiftPath()
 * @returns {number}
 */
export function cycleLength(path) {
    return Math.max(1, 2 * path.length - 2);
}

/**
 * Offset for a step of the out-and-back cycle
 * @param {Array} path - from buildShiftPath()
 * @param {number} step - any integer; wraps around the cycle
 * @returns {{x: number, y: number}}
 */
export function positionForStep(path, step) {
    const cycle = cycleLength(path);
    const s = ((step % cycle) + cycle) % cycle;
    return path[s < path.length ? s : cycle - s];
}

/**
 * Custom error class for pixel shift operations
 */
class PixelShiftError extends ExtensionError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            context: options.context || 'pixelshift'
        });
        this.name = 'PixelShiftError';
    }

    static operationFailed(operation, cause) {
        return new PixelShiftError(`Failed to perform pixel shift operation: ${operation}`, {
            cause,
            context: 'operation',
            metadata: { operation }
        });
    }
}

/**
 * Manages pixel shifting to prevent OLED burn-in
 * Translates Main.layoutManager.uiGroup (which contains every window and all
 * shell chrome). The stage itself is the root of the scene graph and
 * transforms on it are not honoured by mutter.
 *
 * The offset walks a square spiral out to `pixel-shift-amount` pixels and
 * back, 1 px per `pixel-shift-interval`, so every offset in the square gets
 * the same time on screen and no move is ever bigger than 1 px. The current
 * step is saved so the walk resumes where it left off after a restart.
 */
export default class PixelShift extends GObject.Object {
    // Static initialization block for constants
    static {
        this.REQUIRED_SETTINGS = Object.values(CONSTANTS.SETTINGS);
    }

    // Private field declarations (initializers moved to constructor for GObject compatibility)
    #settings;
    #stage;
    #currentShift;
    #path;
    #step;
    #pixelShiftTimeout;
    #debug;
    #resourceManager;
    #signalManager;
    #abortController;
    #settingConnections;

    /**
     * Constructor for the PixelShift component
     * @param {object} settings - GSettings instance
     */
    constructor(settings) {
        super();

        // Initialize fields in constructor (class field initializers don't run in GObject classes)
        this.#stage = null;
        this.#currentShift = { x: 0, y: 0 };
        this.#path = buildShiftPath(CONSTANTS.DEFAULT_AMOUNT);
        this.#step = 0;
        this.#pixelShiftTimeout = null;
        this.#resourceManager = null;
        this.#signalManager = null;
        this.#abortController = new AbortController();
        this.#settingConnections = [];

        try {
            this.#settings = settings;

            // Shift the shell's root UI group (windows + panel + overlays)
            this.#stage = Main.layoutManager.uiGroup;
            
            // Initialize debug mode based on settings
            const debugMode = this.#settings?.get_boolean(CONSTANTS.SETTINGS.DEBUG_MODE) ?? false;
            this.#debug = debugMode ? this.#logDebug.bind(this) : () => {};
            
            // Validate required settings
            this.#validateSettings();
            
            this.#debug('PixelShift component constructed');
            
            // Start tracking performance
            metrics.setEnabled(debugMode);
        } catch (error) {
            console.error(`[OLED Care] [PixelShift] Construction error: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Set the resource manager for memory management
     * @param {ResourceManager} manager - The resource manager instance
     */
    setResourceManager(manager) {
        this.#resourceManager = manager;
        this.#debug('Resource manager set');
    }
    
    /**
     * Set the signal manager for signal tracking
     * @param {SignalManager} manager - The signal manager instance
     */
    setSignalManager(manager) {
        this.#signalManager = manager;
        this.#debug('Signal manager set');
    }

    /**
     * Validate required settings
     * @private
     * @throws {PixelShiftError} If settings validation fails
     */
    #validateSettings() {
        if (!this.#settings) {
            throw new PixelShiftError('Settings object is null or undefined', {
                context: 'validation'
            });
        }

        const schemas = this.#settings.list_keys();
        
        for (const setting of PixelShift.REQUIRED_SETTINGS) {
            if (!schemas.includes(setting)) {
                this.#debug(`Warning: Required setting '${setting}' not found in schema`);
            }
        }
    }

    /**
     * Log a debug message
     * @param {string} message - Message to log
     * @private
     */
    #logDebug(message) {
        console.log(`[OLED Care] [PixelShift] ${message}`);
        
        // Track debug message in metrics
        metrics.incrementCounter('debug_messages', 1, { component: 'PixelShift' });
    }

    /**
     * Initialize the component
     */
    init() {
        const initTimer = metrics.startTimer('pixelshift_init');
        
        try {
            this.#debug('Initializing pixel shift');
            
            // Initialize based on current settings
            if (this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED) ?? false) {
                this.#startPixelShift();
            }

            // Connect to settings changes
            this.#connectSettingsSignals();
            
            this.#debug('Pixel shift initialized');
            initTimer.stop();
        } catch (error) {
            initTimer.addLabels({ error: true });
            initTimer.stop();
            
            this.#debug(`Error in init: ${error.message}`);
            throw PixelShiftError.operationFailed('init', error);
        }
    }
    
    /**
     * Connect to settings change signals
     * @private
     */
    #connectSettingsSignals() {
        if (!this.#signalManager || !this.#settings) return;
        
        // Connect to pixel shift enabled setting
        const enabledId = this.#signalManager.connect(
            this.#settings,
            `changed::${CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED}`,
            () => {
                if (this.#settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED)) {
                    this.#startPixelShift();
                } else {
                    this.#stopPixelShift();
                }
            },
            'pixel-shift-enabled'
        );
        
        // Connect to pixel shift interval setting
        const intervalId = this.#signalManager.connect(
            this.#settings,
            `changed::${CONSTANTS.SETTINGS.PIXEL_SHIFT_INTERVAL}`,
            () => {
                if (this.#settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED)) {
                    this.#restartPixelShift();
                }
            },
            'pixel-shift-interval'
        );
        
        // A new range starts the walk again from home
        const amountId = this.#signalManager.connect(
            this.#settings,
            `changed::${CONSTANTS.SETTINGS.PIXEL_SHIFT_AMOUNT}`,
            () => {
                this.#saveStep(0);
                if (this.#settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED)) {
                    this.#restartPixelShift();
                }
            },
            'pixel-shift-amount'
        );

        // Store connection IDs for cleanup
        this.#settingConnections.push(enabledId, intervalId, amountId);
    }

    /**
     * Enable the component
     */
    enable() {
        this.#debug('Enabling pixel shift');
        if (this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_SHIFT_ENABLED) ?? false) {
            this.#startPixelShift();
        }
    }

    /**
     * Disable the component
     */
    disable() {
        this.#debug('Disabling pixel shift');
        this.#stopPixelShift();
    }

    /**
     * Update based on settings changes
     */
    update() {
        this.#debug('Updating pixel shift settings');
        this.#restartPixelShift();
    }

    /**
     * Clean up resources before destruction
     */
    async destroy() {
        this.#debug('Destroying pixel shift');
        
        // Cancel any pending operations
        this.#abortController.abort('Component destruction');
        
        // Stop pixel shifting
        this.#stopPixelShift();
        
        // Disconnect any remaining signals via signal manager
        if (this.#signalManager) {
            for (const id of this.#settingConnections) {
                this.#signalManager.disconnect(id);
            }
            this.#settingConnections = [];
        }
        
        this.#debug('Pixel shift destroyed');
    }

    /**
     * Start pixel shifting
     * @private
     */
    #startPixelShift() {
        const timer = metrics.startTimer('start_pixel_shift');
        
        try {
            this.#debug('Starting pixel shift');
            
            // Stop any existing shift first
            this.#stopPixelShift();
            
            const interval = this.#readInt(CONSTANTS.SETTINGS.PIXEL_SHIFT_INTERVAL, CONSTANTS.DEFAULT_INTERVAL);
            const intervalMs = interval * 1000;

            // Resume the walk where it left off
            const amount = Math.min(CONSTANTS.MAX_AMOUNT,
                Math.max(1, this.#readInt(CONSTANTS.SETTINGS.PIXEL_SHIFT_AMOUNT, CONSTANTS.DEFAULT_AMOUNT)));
            this.#path = buildShiftPath(amount);
            this.#step = this.#readInt(CONSTANTS.SETTINGS.PIXEL_SHIFT_STEP, 0) % cycleLength(this.#path);
            this.#applyShift(positionForStep(this.#path, this.#step));
            
            // Create new timeout
            this.#pixelShiftTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
                try {
                    return this.#shiftPixels();
                } catch (error) {
                    this.#debug(`Error in pixel shift: ${error.message}`);
                    return GLib.SOURCE_CONTINUE; // Continue despite errors
                }
            });
            
            // The timeout is owned and removed by #stopPixelShift(); it is
            // deliberately not handed to the GC-driven ResourceManager, which
            // would try to remove it a second time.

            this.#debug(`Pixel shift started: up to ${amount} px, 1 px every ${interval} s, at step ${this.#step}/${cycleLength(this.#path)}`);
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this.#debug(`Error starting pixel shift: ${error.message}`);
            throw PixelShiftError.operationFailed('start', error);
        }
    }

    /**
     * Stop pixel shifting
     * @private
     */
    #stopPixelShift() {
        const timer = metrics.startTimer('stop_pixel_shift');
        
        try {
            this.#debug('Stopping pixel shift');
            
            // Remove timeout if it exists
            removeSource(this.#pixelShiftTimeout);
            this.#pixelShiftTimeout = null;
            
            // Reset any existing shift
            this.#resetShift();
            
            this.#debug('Pixel shift stopped');
            timer.stop();
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this.#debug(`Error stopping pixel shift: ${error.message}`);
        }
    }

    /**
     * Restart pixel shifting
     * @private
     */
    #restartPixelShift() {
        this.#debug('Restarting pixel shift');
        this.#stopPixelShift();
        this.#startPixelShift();
    }

    /**
     * Perform the actual pixel shift using Clutter Stage transformations
     * @returns {number} GLib source continuation flag
     * @private
     */
    #shiftPixels() {
        const timer = metrics.startTimer('shift_pixels_operation');
        
        try {
            if (!this.#stage) {
                this.#debug('Stage not available, skipping pixel shift');
                return GLib.SOURCE_CONTINUE;
            }

            // Next point of the out-and-back spiral
            this.#saveStep((this.#step + 1) % cycleLength(this.#path));
            const newShift = positionForStep(this.#path, this.#step);
            this.#debug(`Shifting pixels to x:${newShift.x}, y:${newShift.y} (step ${this.#step})`);
            this.#applyShift(newShift);
            
            // Track successful shift
            metrics.incrementCounter('pixel_shifts');

            const duration = timer.stop();

            // Check if we exceeded performance budget
            if (duration > CONSTANTS.PERFORMANCE_BUDGET.SHIFT_OPERATION) {
                this.#debug(`Performance warning: Shift operation took ${duration.toFixed(2)}ms, budget is ${CONSTANTS.PERFORMANCE_BUDGET.SHIFT_OPERATION}ms`);
                metrics.incrementCounter('performance_budget_exceeded', 1, { operation: 'shift_pixels' });
            }
            
            return GLib.SOURCE_CONTINUE;
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this.#debug(`Error shifting pixels: ${error.message}`);
            metrics.incrementCounter('pixel_shift_errors');
            
            // Continue despite errors to maintain the shifting cycle
            return GLib.SOURCE_CONTINUE;
        }
    }

    /**
     * Reset any active shift
     * @private
     */
    #resetShift() {
        // Only reset if there's an active shift
        if (this.#currentShift.x !== 0 || this.#currentShift.y !== 0) {
            try {
                if (this.#stage) {
                    // Reset UI group translation to zero
                    this.#stage.set_translation(0, 0, 0);
                }
                
                this.#currentShift = { x: 0, y: 0 };
                this.#debug('Shift reset to zero');
            } catch (error) {
                this.#debug(`Error resetting shift: ${error.message}`);
            }
        }
    }

    /**
     * Translate the UI group to an offset
     * @param {{x: number, y: number}} shift - offset from home in pixels
     * @private
     */
    #applyShift(shift) {
        this.#stage?.set_translation(shift.x, shift.y, 0);
        this.#currentShift = { x: shift.x, y: shift.y };
    }

    /**
     * Remember the current step, in memory and in settings
     * @param {number} step - step of the cycle
     * @private
     */
    #saveStep(step) {
        this.#step = step;
        try {
            this.#settings?.set_int(CONSTANTS.SETTINGS.PIXEL_SHIFT_STEP, step);
        } catch (error) {
            this.#debug(`Could not save pixel shift step: ${error.message}`);
        }
    }

    #readInt(key, fallback) {
        try {
            return this.#settings?.get_int(key) ?? fallback;
        } catch {
            return fallback;
        }
    }
}

// Register the GObject class instead of using decorator
PixelShift = GObject.registerClass({
    GTypeName: 'OledCarePixelShift'
}, PixelShift);
