'use strict';

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Import error handling and utilities
import { ExtensionError } from './errors.js';
import { metrics } from './metrics.js';
import EventEmitter from './eventEmitter.js';
import { removeSource } from './compatibility.js';

/**
 * Custom error class for pixel refresh operations
 */
class PixelRefreshError extends ExtensionError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            context: options.context || 'pixelrefresh'
        });
        this.name = 'PixelRefreshError';
    }

    static operationFailed(operation, cause) {
        return new PixelRefreshError(`Failed to perform pixel refresh operation: ${operation}`, {
            cause,
            context: 'operation',
            metadata: { operation }
        });
    }
    
    static validationFailed(key, value, cause) {
        return new PixelRefreshError(`Pixel refresh setting validation failed: ${key}`, {
            cause,
            context: 'validation',
            metadata: { key, value }
        });
    }
}

// Defined as a frozen object for immutability
const CONSTANTS = Object.freeze({
    SETTINGS: {
        DEBUG_MODE: 'debug-mode',
        PIXEL_REFRESH_ENABLED: 'pixel-refresh-enabled',
        PIXEL_REFRESH_SPEED: 'pixel-refresh-speed',
        PIXEL_REFRESH_SMART: 'pixel-refresh-smart',
        PIXEL_REFRESH_SCHEDULE: 'pixel-refresh-schedule',
        PIXEL_REFRESH_INTERVAL: 'pixel-refresh-interval',
        PIXEL_REFRESH_RUNNING: 'pixel-refresh-running',
        PIXEL_REFRESH_PROGRESS: 'pixel-refresh-progress',
        PIXEL_REFRESH_TIME_REMAINING: 'pixel-refresh-time-remaining',
        PIXEL_REFRESH_NEXT_RUN: 'pixel-refresh-next-run',
        PIXEL_REFRESH_MANUAL_TRIGGER: 'pixel-refresh-manual-trigger',
        PIXEL_REFRESH_MANUAL_CANCEL: 'pixel-refresh-manual-cancel',
        PIXEL_REFRESH_INTERRUPTED: 'pixel-refresh-interrupted',
        PIXEL_REFRESH_INTERRUPTED_PROGRESS: 'pixel-refresh-interrupted-progress'
    },
    DEFAULTS: {
        REFRESH_INTERVAL: 240, // minutes
        REFRESH_SPEED: 2 // 1-5 scale
    },
    PERFORMANCE_BUDGET: {
        REFRESH_OPERATION: 16 // milliseconds (target 60fps)
    },
    STATUS: {
        IDLE: 'idle',
        RUNNING: 'running',
        PAUSED: 'paused',
        ERROR: 'error',
        DISABLED: 'disabled'
    }
});

/**
 * Manages pixel refresh operations for OLED displays
 * Provides a full-screen refresh operation to help prevent burn-in
 */
export default class PixelRefresh extends EventEmitter {
    // Static initialization block for constants
    static {
        this.REQUIRED_SETTINGS = Object.values(CONSTANTS.SETTINGS);
        this.STATUS = CONSTANTS.STATUS;

        // Pixel refresh phases - each exercises OLED subpixels differently
        // Solid colors force all subpixels to maximum output.
        // Sweep bars force each pixel row through a full on/off transition.
        // Colors crossfade over the first 20% of each solid phase so pixels
        // exercise the full intermediate range between colors.
        this.PHASES = Object.freeze([
            { type: 'solid', rgb: [255, 255, 255], name: 'White',      weight: 0.15 },
            { type: 'solid', rgb: [255, 0,   0  ], name: 'Red',        weight: 0.10 },
            { type: 'solid', rgb: [0,   255, 0  ], name: 'Green',      weight: 0.10 },
            { type: 'solid', rgb: [0,   0,   255], name: 'Blue',       weight: 0.10 },
            { type: 'solid', rgb: [0,   0,   0  ], name: 'Black',      weight: 0.15 },
            { type: 'sweep', direction: 'down',    name: 'Sweep down', weight: 0.20 },
            { type: 'sweep', direction: 'up',      name: 'Sweep up',   weight: 0.20 },
        ]);

        // Fraction of each solid phase spent crossfading from previous color
        this.CROSSFADE_RATIO = 0.2;

        // Total duration (seconds) by speed setting (1=thorough, 5=fast)
        this.DURATION_BY_SPEED = Object.freeze({
            1: 300,  // 5 minutes
            2: 180,  // 3 minutes
            3: 120,  // 2 minutes
            4: 60,   // 1 minute
            5: 30,   // 30 seconds
        });
    }

    // Private field declarations (initializers moved to constructor for GObject compatibility)
    #settings;
    #refreshTimeout;
    #refreshLines;
    #scheduler;
    #schedulerTimeout;
    #usePortalAPI;
    #cancelRequested;
    #lastFrameTime;
    #frameCount;
    #performanceMonitoringActive;
    #suspendSignalId;
    #resumeSignalId;
    #debug;
    #resourceManager;
    #signalManager;
    #settingsConnections;
    #abortController;
    #resourceBundle;
    #displayManager;
    #status;
    #progress;
    #refreshActor;
    #isEnabled;
    #refreshStartTime;
    #refreshDuration;
    #nextScheduledRun;
    #timeoutIds;
    #sweepBar;
    #currentPhaseIndex;
    #escapeKeyId;
    #escapeKeyTarget;
    #modalGrab;
    #cursorHidden;
    #destroyed;

    /**
     * Constructor for the PixelRefresh component
     * @param {object} settings - GSettings instance
     */
    constructor(settings) {
        super();

        // Initialize fields in constructor (class field initializers don't run in GObject classes)
        this.#refreshTimeout = null;
        this.#refreshLines = new Map();
        this.#scheduler = null;
        this.#schedulerTimeout = null;
        this.#usePortalAPI = false;
        this.#cancelRequested = false;
        this.#lastFrameTime = 0;
        this.#frameCount = 0;
        this.#performanceMonitoringActive = false;
        this.#suspendSignalId = null;
        this.#resumeSignalId = null;
        this.#resourceManager = null;
        this.#signalManager = null;
        this.#settingsConnections = [];
        this.#abortController = new AbortController();
        this.#resourceBundle = null;
        this.#displayManager = null;
        this.#status = CONSTANTS.STATUS.IDLE;
        this.#progress = 0;
        this.#refreshActor = null;
        this.#isEnabled = false;
        this.#refreshStartTime = 0;
        this.#refreshDuration = 0;
        this.#nextScheduledRun = null;
        this.#timeoutIds = new Set();
        this.#sweepBar = null;
        this.#currentPhaseIndex = 0;
        this.#escapeKeyId = null;
        this.#escapeKeyTarget = null;
        this.#modalGrab = null;
        this.#cursorHidden = false;
        this.#destroyed = false;

        try {
            this.#settings = settings;
            
            // Initialize debug mode based on settings
            const debugMode = this.#settings?.get_boolean(CONSTANTS.SETTINGS.DEBUG_MODE) ?? false;
            this.#debug = debugMode ? this.#logDebug.bind(this) : () => {};
            
            // Check if portal API is supported
            this.#usePortalAPI = this.#checkPortalSupport();
            
            // Validate required settings
            this.#validateSettings();
            
            this.#debug('PixelRefresh component constructed');
            
            // Start tracking performance
            metrics.setEnabled(debugMode);
        } catch (error) {
            console.error(`[OLED Care] [PixelRefresh] Construction error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Sync running state and progress to GSettings so prefs UI reflects reality
     * @param {boolean} running - Whether refresh is currently running
     * @param {number} progress - Current progress 0.0-1.0
     * @private
     */
    #syncStatusToSettings(running, progress) {
        if (!this.#settings) return;
        try {
            this.#settings.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_RUNNING, running);
            this.#settings.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_PROGRESS,
                Math.round(progress * 100));

            // Calculate time remaining from known total duration and progress
            if (running && progress > 0) {
                const totalSec = this.#refreshDuration || 180;
                const remaining = Math.round(totalSec * (1 - progress));
                // Clamp to schema range 0-3600
                this.#settings.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_TIME_REMAINING,
                    Math.max(0, Math.min(3600, remaining)));
            } else {
                this.#settings.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_TIME_REMAINING, 0);
            }
        } catch (error) {
            // Non-critical - don't crash refresh over settings sync
        }
    }

    /**
     * Log a debug message with component prefix
     * @param {string} message - Message to log
     * @private
     */
    #logDebug(message) {
        console.log(`[OLED Care] [PixelRefresh] ${message}`);
        
        // Track debug message in metrics
        metrics.incrementCounter('debug_messages', 1, { component: 'PixelRefresh' });
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
     * @throws {PixelRefreshError} If settings validation fails
     */
    #validateSettings() {
        try {
            if (!this.#settings) {
                throw new PixelRefreshError('Settings object is null or undefined', {
                    context: 'validation'
                });
            }
            
            const schemas = this.#settings.list_keys();
            
            // Check for required settings
            for (const setting of PixelRefresh.REQUIRED_SETTINGS) {
                if (!schemas.includes(setting)) {
                    this.#debug(`Warning: Required setting '${setting}' not found in schema`);
                }
            }

            // Validate interval range
            const interval = this.#settings.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL);
            if (interval < 60 || interval > 1440) {
                this.#debug(`Warning: Invalid refresh interval ${interval}, resetting to ${CONSTANTS.DEFAULTS.REFRESH_INTERVAL} minutes`);
                this.#settings.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL, CONSTANTS.DEFAULTS.REFRESH_INTERVAL);
            }

            // Validate speed range
            const speed = this.#settings.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_SPEED);
            if (speed < 1 || speed > 5) {
                this.#debug(`Warning: Invalid refresh speed ${speed}, resetting to ${CONSTANTS.DEFAULTS.REFRESH_SPEED}`);
                this.#settings.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_SPEED, CONSTANTS.DEFAULTS.REFRESH_SPEED);
            }

            // Validate schedule format
            const schedule = this.#settings.get_strv(CONSTANTS.SETTINGS.PIXEL_REFRESH_SCHEDULE);
            const validSchedule = schedule.filter(timeStr => {
                const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
                if (!timeRegex.test(timeStr)) {
                    this.#debug(`Warning: Invalid schedule time format ${timeStr}, will be ignored`);
                    return false;
                }
                return true;
            });
            
            if (validSchedule.length !== schedule.length) {
                this.#settings.set_strv(CONSTANTS.SETTINGS.PIXEL_REFRESH_SCHEDULE, validSchedule);
            }
        } catch (error) {
            // Re-throw errors with proper context
            if (!(error instanceof PixelRefreshError)) {
                throw PixelRefreshError.validationFailed('settings', null, error);
            }
            throw error;
        }
    }

    #startPerformanceMonitoring() {
        this.#lastFrameTime = GLib.get_monotonic_time();
        this.#frameCount = 0;
        this.#performanceMonitoringActive = true;
        this.#debug('Started performance monitoring');
    }

    #stopPerformanceMonitoring() {
        if (this.#performanceMonitoringActive) {
            const currentTime = GLib.get_monotonic_time();
            const elapsed = currentTime - this.#lastFrameTime;
            if (elapsed > 0) {
                const fps = this.#frameCount / (elapsed / 1000000);
                this.#debug(`Final performance stats: ${fps.toFixed(2)} FPS`);
            }
            this.#performanceMonitoringActive = false;
            this.#frameCount = 0;
            this.#lastFrameTime = 0;
            this.#debug('Stopped performance monitoring');
        }
    }

    #updatePerformanceStats() {
        if (!this.#performanceMonitoringActive) return;

        this.#frameCount++;
        const currentTime = GLib.get_monotonic_time();
        const elapsed = currentTime - this.#lastFrameTime;
        if (elapsed > 1000000) { // 1 second
            const fps = this.#frameCount / (elapsed / 1000000);
            this.#debug(`Performance: ${fps.toFixed(2)} FPS`);
            this.#frameCount = 0;
            this.#lastFrameTime = currentTime;
        }
    }

    /**
     * Initialize the pixel refresh component
     * @returns {Promise<boolean>} Success status
     */
    async init() {
        const timer = metrics.startTimer('pixelrefresh_init');
        
        try {
            this.#debug('Initializing PixelRefresh');
            
            // Connect to settings signals
            await this.#connectSettingsSignals();
            
            // Connect to system signals (like suspend/resume)
            await this.#connectSystemSignals();
            
            // Load schedule from settings
            this.#loadSchedule();
            
            // Update enabled state
            this.#isEnabled = this.#settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_ENABLED);
            this.enabled = this.#isEnabled;
            
            // Check if we need to handle interrupted refresh
            const wasInterrupted = this.#settings.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED);
            if (wasInterrupted) {
                const progress = this.#settings.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED_PROGRESS);
                this.#debug(`Detected interrupted refresh at ${progress}% progress`);
                this.emit('refresh-interrupted', progress);
            }
            
            timer.stop();
            this.#debug('PixelRefresh initialization complete');
            
            // Emit ready event
            this.emit('ready');
            
            return true;
        } catch (error) {
            timer.addLabels({ error: true });
            timer.stop();
            
            this.#debug(`Error initializing PixelRefresh: ${error.message}`);
            this.#status = CONSTANTS.STATUS.ERROR;
            
            // Emit error event
            this.emit('error', error instanceof PixelRefreshError ? error : 
                PixelRefreshError.operationFailed('initialization', error));
            
            return false;
        }
    }
    
    /**
     * Connect to settings signals
     * @private
     * @returns {Promise<void>}
     */
    async #connectSettingsSignals() {
        if (!this.#signalManager || !this.#settings) {
            this.#debug('Signal manager or settings not available');
            return;
        }
        
        try {
            // Connect to the enabled setting
            const enabledSignalId = this.#signalManager.connect(
                this.#settings,
                `changed::${CONSTANTS.SETTINGS.PIXEL_REFRESH_ENABLED}`,
                this.#onEnabledChanged.bind(this),
                'refresh-enabled-changed'
            );
            
            // Connect to speed setting
            const speedSignalId = this.#signalManager.connect(
                this.#settings,
                `changed::${CONSTANTS.SETTINGS.PIXEL_REFRESH_SPEED}`,
                this.#onSpeedChanged.bind(this),
                'refresh-speed-changed'
            );
            
            // Connect to interval setting
            const intervalSignalId = this.#signalManager.connect(
                this.#settings,
                `changed::${CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL}`,
                this.#onIntervalChanged.bind(this),
                'refresh-interval-changed'
            );
            
            // Connect to schedule setting
            const scheduleSignalId = this.#signalManager.connect(
                this.#settings,
                `changed::${CONSTANTS.SETTINGS.PIXEL_REFRESH_SCHEDULE}`,
                this.#onScheduleChanged.bind(this),
                'refresh-schedule-changed'
            );
            
            // Connect to manual trigger
            const manualTriggerSignalId = this.#signalManager.connect(
                this.#settings,
                `changed::${CONSTANTS.SETTINGS.PIXEL_REFRESH_MANUAL_TRIGGER}`,
                this.#onManualTriggerChanged.bind(this),
                'refresh-manual-trigger'
            );
            
            // Connect to manual cancel
            const manualCancelSignalId = this.#signalManager.connect(
                this.#settings,
                `changed::${CONSTANTS.SETTINGS.PIXEL_REFRESH_MANUAL_CANCEL}`,
                this.#onManualCancelChanged.bind(this),
                'refresh-manual-cancel'
            );
            
            // Store connection IDs for cleanup
            this.#settingsConnections.push(
                enabledSignalId,
                speedSignalId,
                intervalSignalId,
                scheduleSignalId,
                manualTriggerSignalId,
                manualCancelSignalId
            );
            
            this.#debug('Connected to settings signals');
        } catch (error) {
            this.#debug(`Error connecting settings signals: ${error.message}`);
            throw error;
        }
    }
    
    /**
     * Connect to system signals (suspend/resume)
     * @private
     * @returns {Promise<void>}
     */
    async #connectSystemSignals() {
        try {
            // Connect to system suspend signal if available
            const systemd = Main.shellDBusService?.systemdProxy;
            
            if (systemd && this.#signalManager) {
                // Connect to prepare for sleep signal (for suspend/resume)
                this.#suspendSignalId = this.#signalManager.connect(
                    systemd,
                    'PrepareForSleep',
                    this.#onPrepareForSleep.bind(this),
                    'system-prepare-for-sleep'
                );
                
                this.#debug('Connected to system suspend/resume signals');
            } else {
                this.#debug('System suspend/resume signals not available');
            }
        } catch (error) {
            this.#debug(`Error connecting to system signals: ${error.message}`);
            // Non-critical error, continue initialization
        }
    }
    
    /**
     * Set the display manager
     * @param {DisplayManager} manager - The display manager instance
     */
    setDisplayManager(manager) {
        this.#displayManager = manager;
        this.#debug('Display manager set');
        return this;
    }
    
    /**
     * Enable pixel refresh functionality
     */
    enable() {
        this.#debug('Enabling pixel refresh');
        
        if (this.#status === CONSTANTS.STATUS.RUNNING) {
            this.#debug('Cannot enable: refresh already running');
            return;
        }
        
        this.#isEnabled = true;
        this.enabled = true;
        
        // Update status
        this.#status = CONSTANTS.STATUS.IDLE;
        
        // Clear any interrupted state
        if (this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED)) {
            this.#settings.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED, false);
        }
        
        // Start the scheduler if we have a schedule
        this.#startScheduler();
        
        // Emit enabled event
        this.emit('enabled');
    }
    
    /**
     * Disable pixel refresh functionality
     */
    disable() {
        this.#debug('Disabling pixel refresh');
        
        // Save state if we're in the middle of a refresh
        if (this.#status === CONSTANTS.STATUS.RUNNING) {
            this.#settings?.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED, true);
            this.#settings?.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED_PROGRESS, Math.round(this.#progress * 100));
            this.#cancelRefresh();
        }

        // Stop scheduler
        this.#stopScheduler();
        
        // Update status
        this.#isEnabled = false;
        this.enabled = false;
        this.#status = CONSTANTS.STATUS.DISABLED;
        
        // Emit disabled event
        this.emit('disabled');
    }
    
    /**
     * Destroy the pixel refresh component and clean up
     * @returns {Promise<void>}
     */
    async destroy() {
        if (this.#destroyed)
            return;
        this.#destroyed = true;
        this.#debug('Destroying pixel refresh');

        try {
            // Disable first (cancels a running refresh and the scheduler)
            this.disable();

            // Abort any pending operations
            this.#abortController.abort();

            // Remove any timeouts that are still alive
            for (const timeoutId of this.#timeoutIds)
                removeSource(timeoutId);
            this.#timeoutIds.clear();
            this.#refreshTimeout = null;
            this.#schedulerTimeout = null;

            // Make sure the overlay, grab and cursor state are gone
            this.#teardownOverlay();

            // Clean up resource bundle if available
            if (this.#resourceBundle) {
                await this.#resourceBundle.destroy();
                this.#resourceBundle = null;
            }

            this.#suspendSignalId = null;

            // Clear references
            this.#displayManager = null;
            this.#settings = null;
            this.#signalManager = null;
            this.#resourceManager = null;

            this.#debug('Pixel refresh destroyed');

            // EventEmitter.destroy() stops its cleanup timer, emits 'destroyed'
            // and removes listeners. Skipping it leaked a GLib timer per enable.
            super.destroy();
        } catch (error) {
            console.error(`[OLED Care] [PixelRefresh] Error during cleanup: ${error.message}`);
        }
    }

    #checkPortalSupport() {
        try {
            return !!Main.shellDBusService?.shellProxy;
        } catch (e) {
            this.#debug('Portal API not available: ' + e.message);
            return false;
        }
    }

    #loadSchedule() {
        try {
            const schedule = this.#settings?.get_strv(CONSTANTS.SETTINGS.PIXEL_REFRESH_SCHEDULE);
            if (schedule && schedule.length > 0) {
                this.#debug(`Loaded schedule: ${JSON.stringify(schedule)}`);
                return schedule;
            }
        } catch (error) {
            this.#debug(`Error loading schedule: ${error.message}`);
        }
        return null;
    }

    #startScheduler() {
        this.#stopScheduler(); // Clear any existing scheduler

        const interval = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL) || CONSTANTS.DEFAULTS.REFRESH_INTERVAL;
        const intervalMs = interval * 60 * 1000; // Convert minutes to milliseconds

        this.#debug(`Starting scheduler with interval: ${interval} minutes`);

        this.#schedulerTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            if (this.#shouldRunRefresh()) {
                this.#startRefresh();
            }
            // The scheduler fires on a fixed cadence; publish the next tick
            this.#scheduleNextRefresh();
            return GLib.SOURCE_CONTINUE; // Keep running
        });

        this.#timeoutIds.add(this.#schedulerTimeout);
        this.#scheduleNextRefresh();
    }

    #stopScheduler() {
        if (this.#schedulerTimeout !== null) {
            removeSource(this.#schedulerTimeout);
            this.#timeoutIds.delete(this.#schedulerTimeout);
            this.#schedulerTimeout = null;
            this.#debug('Scheduler stopped');
        }
    }

    #onEnabledChanged() {
        const enabled = this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_ENABLED) ?? false;
        this.#isEnabled = enabled;
        this.#debug(`Pixel refresh enabled changed: ${enabled}`);

        if (enabled) {
            this.#startScheduler();
        } else {
            this.#stopScheduler();
            if (this.running) {
                this.#cancelRefresh();
            }
        }

        this.emit('enabled-changed', enabled);
    }

    #onSpeedChanged() {
        const speed = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_SPEED) || CONSTANTS.DEFAULTS.REFRESH_SPEED;
        this.#debug(`Pixel refresh speed changed: ${speed}`);
        this.#refreshDuration = PixelRefresh.DURATION_BY_SPEED[speed] ?? 180;
        this.emit('speed-changed', speed);
    }

    #onIntervalChanged() {
        const interval = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL) || CONSTANTS.DEFAULTS.REFRESH_INTERVAL;
        this.#debug(`Pixel refresh interval changed: ${interval} minutes`);

        // Restart scheduler with new interval
        if (this.#isEnabled) {
            this.#startScheduler();
        }

        this.emit('interval-changed', interval);
    }

    #onScheduleChanged() {
        const schedule = this.#loadSchedule();
        this.#debug(`Pixel refresh schedule changed: ${JSON.stringify(schedule)}`);
        this.#rescheduleRefresh();
        this.emit('schedule-changed', schedule);
    }

    #onManualTriggerChanged() {
        const trigger = this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_MANUAL_TRIGGER) ?? false;
        if (trigger) {
            this.#debug('Manual refresh triggered');
            this.runManualRefresh();
            // Reset the trigger
            this.#settings?.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_MANUAL_TRIGGER, false);
        }
    }

    #onManualCancelChanged() {
        const cancel = this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_MANUAL_CANCEL) ?? false;
        if (!cancel)
            return;
        if (this.running) {
            this.#debug('Manual cancel triggered');
            this.#cancelRefresh();
        }
        // Always reset the flag, otherwise a cancel pressed while idle sticks
        // at true and later presses never emit a change
        this.#settings?.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_MANUAL_CANCEL, false);
    }

    #onPrepareForSleep(login1Manager, aboutToSuspend) {
        if (aboutToSuspend) {
            this.#debug('System preparing for sleep');

            // Save current progress if refresh is running
            if (this.running) {
                this.#settings?.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED, true);
                this.#settings?.set_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED_PROGRESS, Math.round(this.#progress * 100));
                this.#cancelRefresh();
            }
        } else {
            this.#debug('System resuming from sleep');

            // Resume refresh if it was interrupted
            const wasInterrupted = this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED) ?? false;
            if (wasInterrupted && this.#isEnabled) {
                const savedProgressInt = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED_PROGRESS) || 0;
                const savedProgress = savedProgressInt / 100;
                this.#debug(`Resuming refresh from progress: ${savedProgress}`);
                this.#startRefresh(savedProgress);
                this.#settings?.set_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERRUPTED, false);
            }
        }
    }

    #cancelRefresh() {
        this.#debug('Cancelling pixel refresh');
        this.#cancelRequested = true;

        // Clear refresh timeout
        if (this.#refreshTimeout !== null) {
            removeSource(this.#refreshTimeout);
            this.#timeoutIds.delete(this.#refreshTimeout);
            this.#refreshTimeout = null;
        }

        // Release the grab, restore the cursor and remove the overlay
        this.#teardownOverlay();

        // Update state
        this.running = false;
        this.#status = CONSTANTS.STATUS.IDLE;
        this.#progress = 0;
        this.#syncStatusToSettings(false, 0);

        this.emit('refresh-cancelled');
        this.emit('refresh-canceled');
    }

    #startRefresh(startProgress = 0) {
        if (this.running) {
            this.#debug('Refresh already running');
            return;
        }

        const speed = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_SPEED)
            || CONSTANTS.DEFAULTS.REFRESH_SPEED;
        this.#refreshDuration = PixelRefresh.DURATION_BY_SPEED[speed] ?? 180;

        this.#debug(`Starting pixel refresh (speed ${speed}, duration ${this.#refreshDuration}s, from ${Math.round(startProgress * 100)}%)`);

        try {
            this.#createOverlay();
        } catch (error) {
            // Never leave a half-built overlay, a stuck grab or a hidden cursor behind
            console.error(`[OLED Care] [PixelRefresh] Could not start refresh: ${error.message}`);
            this.#teardownOverlay();
            this.running = false;
            this.#status = CONSTANTS.STATUS.IDLE;
            this.#syncStatusToSettings(false, 0);
            this.emit('refresh-error', error.message);
            return;
        }

        this.#cancelRequested = false;
        this.running = true;
        this.#status = CONSTANTS.STATUS.RUNNING;
        this.#progress = startProgress;
        this._lastSyncBucket = -1;
        this.#refreshStartTime = GLib.get_monotonic_time();
        this.#syncStatusToSettings(true, startProgress);

        this.emit('refresh-started');

        // Determine which phase to start in based on resume progress
        this.#currentPhaseIndex = this.#phaseIndexForProgress(startProgress);
        this.#runNextPhase();
    }

    /**
     * Build the full-screen overlay, take a modal grab so Escape can cancel,
     * and hide the pointer.
     * @private
     */
    #createOverlay() {
        // Plain St.Widget uses a fixed layout, so the sweep bar's set_position()
        // is honoured (an St.BoxLayout would override child positions).
        this.#refreshActor = new St.Widget({
            style_class: 'pixel-refresh-overlay',
            reactive: true,
            can_focus: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            style: 'background-color: rgb(0,0,0);',
        });

        // GNOME 50 addChrome() only accepts trackFullscreen/affectsStruts
        Main.layoutManager.addChrome(this.#refreshActor, {
            affectsStruts: false,
        });

        // On Wayland, key events go to the focused client, not the stage, so a
        // modal grab is required for the overlay to see Escape.
        const onKeyPress = (_actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.#debug('Escape pressed, cancelling refresh');
                this.#cancelRefresh();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        };

        // On GNOME 50 pushModal() always returns a grab (Clutter.Grab no longer
        // reports seat state), the same way the shell's own ModalDialog uses it.
        this.#modalGrab = Main.pushModal(this.#refreshActor, { actionMode: Shell.ActionMode.NONE });
        this.#refreshActor.grab_key_focus();
        this.#escapeKeyTarget = this.#refreshActor;
        this.#escapeKeyId = this.#escapeKeyTarget.connect('key-press-event', onKeyPress);

        this.#hideCursor();
    }

    /**
     * Undo everything #createOverlay() did. Safe to call repeatedly.
     * @private
     */
    #teardownOverlay() {
        this.#disconnectEscapeKey();

        if (this.#modalGrab) {
            try {
                Main.popModal(this.#modalGrab);
            } catch (error) {
                this.#debug(`Could not release modal grab: ${error.message}`);
            }
            this.#modalGrab = null;
        }

        this.#showCursor();
        this.#destroySweepBar();

        if (this.#refreshActor) {
            this.#refreshActor.destroy();
            this.#refreshActor = null;
        }
    }

    /**
     * Compute cumulative progress boundaries for each phase.
     * Returns array of { start, end } in 0..1 range.
     */
    #phaseBoundaries() {
        const phases = PixelRefresh.PHASES;
        const bounds = [];
        let cumulative = 0;
        for (const phase of phases) {
            bounds.push({ start: cumulative, end: cumulative + phase.weight });
            cumulative += phase.weight;
        }
        return bounds;
    }

    /** Which phase does a given overall progress fall into? */
    #phaseIndexForProgress(progress) {
        const bounds = this.#phaseBoundaries();
        for (let i = 0; i < bounds.length; i++) {
            if (progress < bounds[i].end) return i;
        }
        return bounds.length - 1;
    }

    /** Main phase sequencer */
    #runNextPhase() {
        if (this.#cancelRequested || !this.running) return;

        const phases = PixelRefresh.PHASES;
        if (this.#currentPhaseIndex >= phases.length) {
            this.#completeRefresh();
            return;
        }

        const phase = phases[this.#currentPhaseIndex];
        const bounds = this.#phaseBoundaries()[this.#currentPhaseIndex];
        const phaseDurationMs = phase.weight * this.#refreshDuration * 1000;

        // Local progress within this phase (for resume)
        const localStart = this.#progress > bounds.start
            ? (this.#progress - bounds.start) / phase.weight
            : 0;

        this.#debug(`Phase ${this.#currentPhaseIndex}: ${phase.name} (${Math.round(localStart * 100)}% in)`);

        if (phase.type === 'solid') {
            this.#runSolidPhase(phase, bounds, phaseDurationMs, localStart);
        } else if (phase.type === 'sweep') {
            this.#runSweepPhase(phase, bounds, phaseDurationMs, localStart);
        }
    }

    /**
     * Solid color phase with crossfade transition.
     * First 20% of the phase smoothly transitions from the previous color,
     * remaining 80% holds the target color at full brightness.
     */
    #runSolidPhase(phase, bounds, durationMs, localStart) {
        this.#destroySweepBar();

        // Determine previous color for crossfade
        const prevPhase = this.#currentPhaseIndex > 0
            ? PixelRefresh.PHASES[this.#currentPhaseIndex - 1]
            : null;
        const fromRgb = prevPhase?.rgb ?? [0, 0, 0];
        const toRgb = phase.rgb;
        const crossfade = PixelRefresh.CROSSFADE_RATIO;

        const remainingMs = durationMs * (1 - localStart);
        const startTime = GLib.get_monotonic_time();

        // Tick at ~30fps during crossfade, then every 500ms while holding
        const tick = () => {
            if (this.#cancelRequested || !this.running || !this.#refreshActor) return;

            const elapsedUs = GLib.get_monotonic_time() - startTime;
            const elapsedMs = elapsedUs / 1000;
            const localProgress = localStart + (1 - localStart) * Math.min(1, elapsedMs / remainingMs);

            // Crossfade during first 20%, hold solid for remaining 80%
            if (localProgress < crossfade) {
                const t = localProgress / crossfade; // 0..1 within crossfade
                const r = Math.round(fromRgb[0] + (toRgb[0] - fromRgb[0]) * t);
                const g = Math.round(fromRgb[1] + (toRgb[1] - fromRgb[1]) * t);
                const b = Math.round(fromRgb[2] + (toRgb[2] - fromRgb[2]) * t);
                this.#refreshActor.style = `background-color: rgb(${r},${g},${b});`;
            } else {
                this.#refreshActor.style = `background-color: rgb(${toRgb[0]},${toRgb[1]},${toRgb[2]});`;
            }

            this.#progress = bounds.start + localProgress * (bounds.end - bounds.start);
            this.#emitProgress();

            if (elapsedMs >= remainingMs) {
                this.#progress = bounds.end;
                this.#currentPhaseIndex++;
                this.#runNextPhase();
            } else {
                // Fast ticks during crossfade, slow ticks while holding
                const interval = localProgress < crossfade ? 33 : 500;
                this.#scheduleTick(interval, tick);
            }
        };

        tick();
    }

    /**
     * Sweep phase: move a bright white bar across the screen.
     * Forces each pixel row through a full on/off cycle.
     */
    #runSweepPhase(phase, bounds, durationMs, localStart) {
        // Black background behind the sweep bar
        this.#refreshActor.style = 'background-color: rgb(0,0,0);';

        const screenH = global.stage.height;
        const barHeight = Math.max(4, Math.ceil(screenH / 20));

        // Create the sweep bar
        this.#destroySweepBar();
        this.#sweepBar = new St.Widget({
            style: 'background-color: rgb(255,255,255);',
            x: 0,
            width: global.stage.width,
            height: barHeight,
        });
        this.#refreshActor.add_child(this.#sweepBar);

        const goingDown = phase.direction === 'down';
        const maxTravel = screenH - barHeight;
        const remainingMs = durationMs * (1 - localStart);
        const startTime = GLib.get_monotonic_time();

        // Animate at ~30fps for smooth sweep
        const tick = () => {
            if (this.#cancelRequested || !this.running) return;

            const elapsedUs = GLib.get_monotonic_time() - startTime;
            const elapsedMs = elapsedUs / 1000;
            const localProgress = localStart + (1 - localStart) * Math.min(1, elapsedMs / remainingMs);

            // Position the bar
            const travel = goingDown
                ? localProgress * maxTravel
                : maxTravel - localProgress * maxTravel;
            if (this.#sweepBar) {
                this.#sweepBar.set_position(0, Math.round(travel));
            }

            this.#progress = bounds.start + localProgress * (bounds.end - bounds.start);
            this.#emitProgress();

            if (elapsedMs >= remainingMs) {
                this.#progress = bounds.end;
                this.#currentPhaseIndex++;
                this.#runNextPhase();
            } else {
                this.#scheduleTick(33, tick);
            }
        };

        tick();
    }

    /**
     * Schedule the next animation tick. The ID is forgotten once it fires so
     * cleanup never tries to remove an already-finished source.
     * @private
     */
    #scheduleTick(intervalMs, tick) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
            this.#timeoutIds.delete(id);
            if (this.#refreshTimeout === id)
                this.#refreshTimeout = null;
            tick();
            return GLib.SOURCE_REMOVE;
        });
        this.#refreshTimeout = id;
        this.#timeoutIds.add(id);
    }

    /** Emit progress and sync to GSettings (throttled to every 5%) */
    #emitProgress() {
        const pct5 = Math.floor(this.#progress * 20);
        this.emit('refresh-progress', this.#progress);

        // Sync to GSettings every 5%
        if (pct5 !== this._lastSyncBucket) {
            this._lastSyncBucket = pct5;
            this.#syncStatusToSettings(true, this.#progress);
        }
    }

    #destroySweepBar() {
        if (this.#sweepBar) {
            this.#sweepBar.destroy();
            this.#sweepBar = null;
        }
    }

    /**
     * Hide the mouse cursor the same way the screen shield does on GNOME 50
     * (Meta.Cursor / MetaDisplay.set_cursor() no longer exist).
     * @private
     */
    #hideCursor() {
        if (this.#cursorHidden) return;
        try {
            const seat = global.stage.context.get_backend().get_default_seat();
            seat.inhibit_unfocus();
            global.backend.get_cursor_tracker().inhibit_cursor_visibility();
            this.#cursorHidden = true;
        } catch (error) {
            this.#debug(`Could not hide cursor: ${error.message}`);
        }
    }

    /** Restore the mouse cursor */
    #showCursor() {
        if (!this.#cursorHidden) return;
        this.#cursorHidden = false;
        try {
            global.backend.get_cursor_tracker().uninhibit_cursor_visibility();
            const seat = global.stage.context.get_backend().get_default_seat();
            seat.uninhibit_unfocus();
        } catch (error) {
            this.#debug(`Could not restore cursor: ${error.message}`);
        }
    }

    /** Disconnect the Escape key handler */
    #disconnectEscapeKey() {
        if (this.#escapeKeyId !== null) {
            try {
                this.#escapeKeyTarget?.disconnect(this.#escapeKeyId);
            } catch {
                // Target already destroyed
            }
            this.#escapeKeyId = null;
            this.#escapeKeyTarget = null;
        }
    }

    #completeRefresh() {
        this.#debug('Pixel refresh complete');

        this.#teardownOverlay();

        this.running = false;
        this.#status = CONSTANTS.STATUS.IDLE;
        this.#progress = 0;
        this.#syncStatusToSettings(false, 0);

        this.emit('refresh-completed');
    }

    #rescheduleRefresh() {
        this.#stopScheduler();
        if (this.#isEnabled) {
            this.#startScheduler();
        }
    }

    #scheduleNextRefresh() {
        const interval = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL) || CONSTANTS.DEFAULTS.REFRESH_INTERVAL;
        const nextRun = new Date(Date.now() + interval * 60 * 1000);
        this.#nextScheduledRun = nextRun;

        this.#settings?.set_string(
            CONSTANTS.SETTINGS.PIXEL_REFRESH_NEXT_RUN,
            nextRun.toISOString()
        );

        this.#debug(`Next refresh scheduled for: ${nextRun.toISOString()}`);
    }

    #shouldRunRefresh() {
        if (!this.#isEnabled) {
            return false;
        }

        if (this.running) {
            return false;
        }

        // Check if current time falls within a scheduled window
        const schedule = this.#settings?.get_strv(CONSTANTS.SETTINGS.PIXEL_REFRESH_SCHEDULE) ?? [];
        if (schedule.length > 0) {
            const interval = this.#settings?.get_int(CONSTANTS.SETTINGS.PIXEL_REFRESH_INTERVAL) || CONSTANTS.DEFAULTS.REFRESH_INTERVAL;
            if (!this.#isWithinScheduleWindow(schedule, interval)) {
                this.#debug('Skipping refresh: outside scheduled window');
                return false;
            }
        }

        // Check if smart mode is enabled
        const smartMode = this.#settings?.get_boolean(CONSTANTS.SETTINGS.PIXEL_REFRESH_SMART) ?? false;
        if (smartMode) {
            // Don't run if critical apps are running
            if (this.#checkCriticalApps()) {
                this.#debug('Skipping refresh: critical apps running');
                return false;
            }
        }

        return true;
    }

    /**
     * Check if current time is within interval minutes after any scheduled time
     * @param {string[]} schedule - Array of 'HH:MM' time strings
     * @param {number} intervalMinutes - Scheduler interval in minutes
     * @returns {boolean}
     * @private
     */
    #isWithinScheduleWindow(schedule, intervalMinutes) {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        for (const entry of schedule) {
            const parts = entry.split(':');
            if (parts.length !== 2) continue;

            const schedMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
            // Check if now is within [schedMinutes, schedMinutes + interval)
            let diff = nowMinutes - schedMinutes;
            if (diff < 0) diff += 1440; // wrap around midnight

            if (diff < intervalMinutes) {
                return true;
            }
        }

        return false;
    }

    #checkCriticalApps() {
        // Don't interrupt fullscreen apps (games, video players, presentations).
        // Shell.WindowTracker.get_running_apps() no longer exists on GNOME 50.
        for (const actor of global.get_window_actors()) {
            const window = actor.get_meta_window?.();
            if (window?.is_fullscreen()) {
                this.#debug(`Critical app detected: ${window.get_title?.() ?? 'unknown'} (fullscreen)`);
                return true;
            }
        }

        return false;
    }

    /**
     * Run a manual pixel refresh
     */
    runManualRefresh() {
        if (this.running) {
            this.#debug('Refresh already running, ignoring manual trigger');
            return;
        }

        this.#debug('Running manual refresh');
        this.#startRefresh();
    }
}

// Register the GObject class instead of using decorator
PixelRefresh = GObject.registerClass({
    Properties: {
        'running': GObject.ParamSpec.boolean(
            'running', 'running', 'Whether refresh is running',
            GObject.ParamFlags.READWRITE,
            false
        ),
        'progress': GObject.ParamSpec.double(
            'progress', 'progress', 'Refresh progress (0-1)',
            GObject.ParamFlags.READWRITE,
            0, 1, 0
        ),
        'enabled': GObject.ParamSpec.boolean(
            'enabled', 'enabled', 'Whether pixel refresh is enabled',
            GObject.ParamFlags.READWRITE,
            false
        )
    },
    Signals: {
        'refresh-started': {},
        'refresh-progress': { param_types: [GObject.TYPE_DOUBLE] },
        'refresh-completed': {},
        'refresh-canceled': {},
        'refresh-error': { param_types: [GObject.TYPE_STRING] }
    },
    GTypeName: 'OledCarePixelRefresh'
}, PixelRefresh);