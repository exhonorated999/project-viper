/**
 * VIPER UI Preferences
 *
 * Loaded early on every page (index.html, case-detail-with-analytics.html,
 * settings.html). Owns:
 *   1. Interface font scaling — applies the user's choice from Settings
 *      to the <html> element's font-size, so every Tailwind rem-based
 *      class (text-xs, text-sm, p-4, gap-2, etc.) scales proportionally.
 *   2. Sidebar collapse / auto-hide — adds a hamburger toggle button,
 *      reads the auto-hide setting, listens for window resize, and
 *      injects the CSS that actually hides the sidebar.
 *
 * Both features expose refresh hooks on `window` so the Settings page can
 * trigger a re-apply when the user changes a preference.
 */
(function () {

    /* ─────────────────── Font Size ─────────────────── */
    // Two-pronged scaling so that BOTH rem-based Tailwind classes
    // (text-xs, text-sm, p-4) AND arbitrary pixel sizes
    // (text-[10px], inline style="font-size:11px") scale together:
    //   • html font-size  → covers all rem/em units
    //   • body zoom       → covers everything else (px, layout, padding)
    //
    // We pick a small zoom delta so the two scales compound only modestly,
    // giving a clearly readable bump at "large" / "x-large" without
    // breaking layouts.
    const FONT_SIZES = {
        small:    { px: '14px', zoom: '0.92' },
        medium:   { px: '15px', zoom: '1'    },
        large:    { px: '16px', zoom: '1.10' },
        'x-large':{ px: '18px', zoom: '1.22' },
    };
    function applyFontSize(size) {
        const cfg = FONT_SIZES[size] || FONT_SIZES.medium;
        // Setting font-size on <html> rescales every rem-based Tailwind class.
        document.documentElement.style.fontSize = cfg.px;
        document.documentElement.style.setProperty('--viper-font-size', cfg.px);
        // Zoom scales hardcoded px text (text-[10px], text-[11px], inline
        // font-size:Npx) plus all layout dimensions, so the whole page
        // grows together. Apply on body so position:fixed widgets that
        // anchor to <html> (toast, modals) aren't double-scaled.
        if (document.body) {
            document.body.style.zoom = cfg.zoom;
        } else {
            // body not parsed yet — attach when ready.
            document.addEventListener('DOMContentLoaded', () => {
                document.body.style.zoom = cfg.zoom;
            }, { once: true });
        }
    }
    // Apply immediately, before Tailwind has even painted the page.
    applyFontSize(localStorage.getItem('viperFontSize') || 'medium');

    // Public API for Settings page.
    window.viperApplyFontSize = applyFontSize;
    window.viperFontSizeRefresh = function () {
        applyFontSize(localStorage.getItem('viperFontSize') || 'medium');
    };

    /* ─────────────────── Sidebar Toggle ─────────────────── */
    // Find the page's sidebar. All three pages use a top-level
    // <div class="w-64 glass-card ..."> as the sidebar wrapper.
    function findSidebar() {
        // Prefer a tagged sidebar if any page has been updated to use it.
        let el = document.getElementById('appSidebar');
        if (el) return el;
        // Fallback: first w-64 + glass-card wrapper inside the body.
        const candidates = document.querySelectorAll('.w-64.glass-card, .w-64.flex.flex-col');
        for (const c of candidates) {
            if (c.querySelector('.sidebar-item') || c.querySelector('[id$="Nav"]')) {
                c.id = c.id || 'appSidebar';
                return c;
            }
        }
        return null;
    }

    // Inject CSS that owns the collapsed state + the toggle button look.
    function injectSidebarCss() {
        if (document.getElementById('viper-prefs-css')) return;
        const css = document.createElement('style');
        css.id = 'viper-prefs-css';
        css.textContent = `
            /* Hidden state — applied to <body> so the sidebar pulls out and the
               main content fills the freed space. */
            body.viper-sidebar-collapsed #appSidebar {
                width: 0 !important;
                min-width: 0 !important;
                padding: 0 !important;
                margin: 0 !important;
                border: none !important;
                overflow: hidden !important;
                opacity: 0;
                pointer-events: none;
                transition: width 0.25s ease, opacity 0.2s ease;
            }
            #appSidebar { transition: width 0.25s ease, opacity 0.2s ease; }

            /* Floating toggle button — always visible top-left. */
            #viperSidebarToggle {
                position: fixed;
                top: 14px;
                left: 14px;
                z-index: 9998;
                width: 36px;
                height: 36px;
                border-radius: 8px;
                background: rgba(26, 35, 50, 0.85);
                border: 1px solid rgba(0, 217, 255, 0.35);
                color: #00d9ff;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                backdrop-filter: blur(8px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                transition: all 0.2s ease;
            }
            #viperSidebarToggle:hover {
                background: rgba(0, 217, 255, 0.15);
                border-color: #00d9ff;
                box-shadow: 0 0 12px rgba(0, 217, 255, 0.5);
            }
            #viperSidebarToggle svg { width: 18px; height: 18px; }

            /* When the sidebar is open, push the toggle to just past its
               right edge so it doesn't sit on top of the sidebar items. */
            body:not(.viper-sidebar-collapsed) #viperSidebarToggle {
                left: 268px;
            }
            @media (max-width: 1024px) {
                body:not(.viper-sidebar-collapsed) #viperSidebarToggle { left: 268px; }
            }
        `;
        document.head.appendChild(css);
    }

    function injectToggleButton() {
        if (document.getElementById('viperSidebarToggle')) return;
        const btn = document.createElement('button');
        btn.id = 'viperSidebarToggle';
        btn.title = 'Show / hide sidebar';
        btn.setAttribute('aria-label', 'Toggle sidebar');
        btn.innerHTML = `
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
        `;
        btn.addEventListener('click', toggleSidebar);
        document.body.appendChild(btn);
    }

    function setSidebarCollapsed(collapsed, persist) {
        document.body.classList.toggle('viper-sidebar-collapsed', !!collapsed);
        if (persist) {
            localStorage.setItem('viperSidebarCollapsed', collapsed ? 'true' : 'false');
        }
    }
    function isAutoHideEnabled() {
        return localStorage.getItem('viperSidebarAutoHide') === 'true';
    }
    function isManuallyCollapsed() {
        return localStorage.getItem('viperSidebarCollapsed') === 'true';
    }

    function toggleSidebar() {
        const nowCollapsed = !document.body.classList.contains('viper-sidebar-collapsed');
        setSidebarCollapsed(nowCollapsed, true);
    }

    // Decide initial state based on auto-hide rule + manual override.
    function applySidebarRules() {
        const sb = findSidebar();
        if (!sb) return;
        // Manual collapse always wins.
        if (isManuallyCollapsed()) {
            setSidebarCollapsed(true, false);
            return;
        }
        // Auto-hide on narrow windows.
        if (isAutoHideEnabled() && window.innerWidth <= 1024) {
            setSidebarCollapsed(true, false);
            return;
        }
        setSidebarCollapsed(false, false);
    }

    function initSidebar() {
        const sb = findSidebar();
        if (!sb) return;            // Page has no sidebar (e.g. login).
        injectSidebarCss();
        injectToggleButton();
        applySidebarRules();
        window.addEventListener('resize', () => {
            // Only let the resize handler change state when auto-hide is on
            // and the user hasn't manually pinned a state on this page.
            if (isManuallyCollapsed()) return;
            if (!isAutoHideEnabled()) return;
            applySidebarRules();
        });
    }

    // Hook the Settings toggle so changes apply live across pages.
    window.viperSidebarAutoHideRefresh = function () {
        // Clear any manual override so the auto rule can take effect again.
        localStorage.removeItem('viperSidebarCollapsed');
        applySidebarRules();
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSidebar);
    } else {
        initSidebar();
    }
})();
