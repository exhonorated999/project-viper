/**
 * VIPER Sidebar Auto-Hide
 * - Settings toggle: localStorage `viperSidebarAutoHide` ("true" / "false")
 * - When enabled AND viewport <= breakpoint, the sidebar is hidden by default
 *   and revealed via a hamburger button in the top-left corner (drawer).
 * - Click the backdrop or hit Escape to close the drawer.
 * - Applied uniformly across index.html, settings.html, case-detail-with-analytics.html.
 *
 * Usage: include `<script src="viper-sidebar-autohide.js" defer></script>` near
 * end of <head> or before </body>. The script self-initializes on DOMContentLoaded.
 */
(function () {
    'use strict';

    const LS_KEY = 'viperSidebarAutoHide';
    const BREAKPOINT_KEY = 'viperSidebarAutoHideBreakpoint'; // optional override
    const DEFAULT_BREAKPOINT = 1024; // px

    function isEnabled() {
        return localStorage.getItem(LS_KEY) === 'true';
    }

    function getBreakpoint() {
        const v = parseInt(localStorage.getItem(BREAKPOINT_KEY), 10);
        return (Number.isFinite(v) && v > 320) ? v : DEFAULT_BREAKPOINT;
    }

    // Sidebar selector — matches the 3 main sidebars in the app
    function findSidebar() {
        const candidates = document.querySelectorAll('.w-64.glass-card');
        for (const el of candidates) {
            // Pick the first one that has nav navigation children (not the QR code preview etc.)
            if (el.querySelector('nav') || el.classList.contains('flex-col')) {
                return el;
            }
        }
        return null;
    }

    function injectStyles() {
        if (document.getElementById('viper-sidebar-autohide-styles')) return;
        const style = document.createElement('style');
        style.id = 'viper-sidebar-autohide-styles';
        style.textContent = `
            .viper-sah-toggle {
                position: fixed;
                top: 12px;
                left: 12px;
                z-index: 1001;
                width: 40px;
                height: 40px;
                display: none;
                align-items: center;
                justify-content: center;
                background: rgba(15, 23, 42, 0.85);
                color: #67e8f9;
                border: 1px solid rgba(34, 211, 238, 0.4);
                border-radius: 8px;
                cursor: pointer;
                backdrop-filter: blur(8px);
                transition: background .15s ease, transform .15s ease;
            }
            .viper-sah-toggle:hover { background: rgba(34, 211, 238, 0.15); }
            .viper-sah-toggle:active { transform: scale(0.95); }
            .viper-sah-backdrop {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.55);
                z-index: 999;
                display: none;
                opacity: 0;
                transition: opacity .2s ease;
            }
            body.viper-sah-active .viper-sah-toggle { display: flex; }
            body.viper-sah-active [data-viper-sidebar] {
                position: fixed;
                top: 0;
                left: 0;
                bottom: 0;
                z-index: 1000;
                transform: translateX(-100%);
                transition: transform .25s cubic-bezier(.2,.7,.2,1);
                box-shadow: 0 0 30px rgba(0,0,0,0.6);
            }
            body.viper-sah-active.viper-sah-open [data-viper-sidebar] {
                transform: translateX(0);
            }
            body.viper-sah-active.viper-sah-open .viper-sah-backdrop {
                display: block;
                opacity: 1;
            }
            /* Smooth hide of the toggle when drawer is open (keeps the close action via backdrop / Esc) */
            body.viper-sah-active.viper-sah-open .viper-sah-toggle {
                opacity: 0;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureToggleButton() {
        let btn = document.getElementById('viperSidebarToggleBtn');
        if (btn) return btn;
        btn = document.createElement('button');
        btn.id = 'viperSidebarToggleBtn';
        btn.className = 'viper-sah-toggle';
        btn.setAttribute('aria-label', 'Open menu');
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>`;
        btn.addEventListener('click', openDrawer);
        document.body.appendChild(btn);
        return btn;
    }

    function ensureBackdrop() {
        let bd = document.getElementById('viperSidebarBackdrop');
        if (bd) return bd;
        bd = document.createElement('div');
        bd.id = 'viperSidebarBackdrop';
        bd.className = 'viper-sah-backdrop';
        bd.addEventListener('click', closeDrawer);
        document.body.appendChild(bd);
        return bd;
    }

    function openDrawer() {
        document.body.classList.add('viper-sah-open');
    }
    function closeDrawer() {
        document.body.classList.remove('viper-sah-open');
    }

    function refresh() {
        const sidebar = findSidebar();
        if (!sidebar) return;
        if (!sidebar.hasAttribute('data-viper-sidebar')) {
            sidebar.setAttribute('data-viper-sidebar', '');
        }
        injectStyles();
        ensureToggleButton();
        ensureBackdrop();

        const enabled = isEnabled();
        const small = window.innerWidth <= getBreakpoint();
        const active = enabled && small;

        document.body.classList.toggle('viper-sah-active', active);
        if (!active) {
            document.body.classList.remove('viper-sah-open');
        }
    }

    // Auto-close drawer when a sidebar item is clicked (drawer = navigated away)
    function bindAutoClose() {
        document.addEventListener('click', (e) => {
            if (!document.body.classList.contains('viper-sah-open')) return;
            const item = e.target.closest('.sidebar-item');
            if (item) {
                // Let the click propagate, then close
                setTimeout(closeDrawer, 50);
            }
        }, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeDrawer();
        });
    }

    // Public API for the settings page to trigger a refresh after toggle
    window.viperSidebarAutoHideRefresh = refresh;

    function init() {
        try {
            refresh();
            bindAutoClose();
            window.addEventListener('resize', refresh, { passive: true });
        } catch (e) {
            console.warn('Sidebar auto-hide init failed:', e);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
