/**
 * V.I.P.E.R. — Skin runtime
 * -------------------------------------------------------------------------
 * Colour-only theming. The palette itself lives in modules/viper-skins.css as
 * CSS variable triples; this file only decides WHICH skin is active and writes
 * `data-skin` onto <html>.
 *
 * Every page also carries a one-line inline applier in <head> so the skin is
 * present before first paint (no flash of the classic palette). This module is
 * the shared API used by Settings and by anything that needs the list.
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'viperSkin';

    // Keep in sync with the skin blocks in modules/viper-skins.css.
    var SKINS = [
        {
            id: 'classic',
            label: 'VIPER Classic',
            description: 'The original cyan-on-navy tactical palette.',
            swatches: ['#0a0e14', '#1a2332', '#00d9ff', '#9d4edd', '#00ff88']
        },
        {
            id: 'supervisor',
            label: 'Supervisor Edition',
            description: 'Command-center blue over #0e1117, matching V.I.P.E.R. Supervisor Edition.',
            swatches: ['#0e1117', '#1a1f27', '#2b9fe3', '#8b5cf6', '#4caf50']
        },
        {
            id: 'obsidian',
            label: 'Cyber Obsidian',
            description: 'Violet-and-magenta obsidian, the Project Oversight / Hindsight PLUS house palette.',
            swatches: ['#0a0612', '#181124', '#b06bff', '#ff2d92', '#ff6a00']
        },
        {
            id: 'ember',
            label: 'Ember Protocol',
            description: 'Molten gold-and-orange magma with cyber-violet over warm obsidian.',
            swatches: ['#060608', '#131211', '#ffb020', '#a855f7', '#ff5a1f']
        },
        // Holiday skins live in modules/viper-skins-holiday.css.
        {
            id: 'winter-frost',
            label: 'Winter Frost',
            description: 'Frosted-glass panels, an aurora banner and drifting snowflakes over midnight blue.',
            swatches: ['#070f22', '#16325c', '#7cc4ff', '#d3dde8', '#5fe3a1']
        },
        {
            id: 'holiday-lights',
            label: 'Holiday Lights',
            description: 'A string of twinkling bulbs and warm bokeh over candlelit gold.',
            swatches: ['#15110d', '#1b1610', '#e0a94a', '#e86a5a', '#5fd884']
        },
        // Tactical skins live in modules/viper-skins-tactical.css.
        {
            id: 'ranger-green',
            label: 'Ranger Green',
            description: 'OD tactical: riveted, stitched canvas panels, a MOLLE webbing strip and coyote-tan accents.',
            swatches: ['#16180f', '#282a1d', '#d2b07a', '#9fb36d', '#f0a04b']
        }
    ];

    function list() { return SKINS.slice(); }

    function get() {
        var id;
        try { id = localStorage.getItem(STORAGE_KEY); } catch (_) { id = null; }
        return isValid(id) ? id : 'classic';
    }

    function isValid(id) {
        for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === id) return true;
        return false;
    }

    function meta(id) {
        for (var i = 0; i < SKINS.length; i++) if (SKINS[i].id === id) return SKINS[i];
        return SKINS[0];
    }

    /** Write the skin onto <html> (no storage write). */
    function apply(id) {
        var skin = isValid(id) ? id : 'classic';
        try {
            if (skin === 'classic') document.documentElement.removeAttribute('data-skin');
            else document.documentElement.setAttribute('data-skin', skin);
        } catch (_) {}
        return skin;
    }

    /** Persist + apply, and notify listeners in this document. */
    function set(id) {
        var skin = isValid(id) ? id : 'classic';
        try { localStorage.setItem(STORAGE_KEY, skin); } catch (_) {}
        apply(skin);
        try {
            document.dispatchEvent(new CustomEvent('viper-skin-change', { detail: { skin: skin } }));
        } catch (_) {}
        return skin;
    }

    /** Re-assert the stored skin (used on load). */
    function init() { return apply(get()); }

    global.ViperSkins = {
        STORAGE_KEY: STORAGE_KEY,
        list: list,
        get: get,
        set: set,
        apply: apply,
        meta: meta,
        isValid: isValid,
        init: init
    };

    // Safe to run immediately — documentElement always exists by the time a
    // <script> in <head> executes.
    init();
})(window);
