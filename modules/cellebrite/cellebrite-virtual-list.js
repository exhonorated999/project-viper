/**
 * Cellebrite — Virtualized list helper
 * ─────────────────────────────────────────────────────────────────────────
 * Windowed rendering for fixed-height rows in large datasets (calls / SMS).
 * Designed to be plugged behind `CellebriteUI._applyPaneFilter`:
 *
 *   const vlist = new CellebriteVirtualList({
 *       host: scrollContainer,    // bounded-height, position:relative
 *       rowHeight: 56,            // px — uniform per row
 *       items: callsArray,        // full backing array
 *       gridTemplate: '48px 200px 1fr ...',
 *       renderRow: (item, absIdx) => '<div class="...">...</div>',
 *       emptyHtml: '<div>No matches</div>',
 *   });
 *   vlist.setFilteredIndices(allIndices);  // or a subset
 *
 * Performance target (plan §8): 5k rows render in <100ms (cold), scroll
 * <16ms/frame (hot). Buffer renders ±5 rows around the visible window.
 *
 * Lifecycle: caller owns destruction. Call `vlist.destroy()` when the
 * containing pane is replaced.
 */
class CellebriteVirtualList {
    constructor({ host, rowHeight, items, gridTemplate, renderRow, emptyHtml = '', buffer = 5 }) {
        if (!host) throw new Error('CellebriteVirtualList: host required');
        if (!Number.isFinite(rowHeight) || rowHeight <= 0) throw new Error('CellebriteVirtualList: positive rowHeight required');
        if (typeof renderRow !== 'function') throw new Error('CellebriteVirtualList: renderRow function required');

        this.host = host;
        this.rowHeight = rowHeight;
        this.items = items || [];
        this.gridTemplate = gridTemplate || '';
        this.renderRow = renderRow;
        this.emptyHtml = emptyHtml;
        this.buffer = buffer;
        this.filteredIndices = items ? items.map((_, i) => i) : [];

        this._rafToken = 0;
        this._onScroll = this._onScroll.bind(this);
        this._onResize = this._onResize.bind(this);
        this._destroyed = false;

        this._mount();
    }

    _mount() {
        // Ensure host has positioning + scroll. (Caller should also set a bounded height
        // — we don't force one because layout depends on the pane shell.)
        if (this.host.style.position !== 'absolute' && this.host.style.position !== 'fixed') {
            this.host.style.position = 'relative';
        }
        if (!this.host.style.overflowY) this.host.style.overflowY = 'auto';

        // Spacer pushes scrollbar to the right size.
        this.spacer = document.createElement('div');
        this.spacer.className = 'cb-vlist-spacer';
        this.spacer.style.width = '1px';
        this.spacer.style.pointerEvents = 'none';
        this.host.appendChild(this.spacer);

        // Absolute-positioned window holds rendered rows.
        this.windowEl = document.createElement('div');
        this.windowEl.className = 'cb-vlist-window';
        this.windowEl.style.position = 'absolute';
        this.windowEl.style.top = '0';
        this.windowEl.style.left = '0';
        this.windowEl.style.right = '0';
        this.host.appendChild(this.windowEl);

        // Empty-state overlay.
        this.emptyEl = document.createElement('div');
        this.emptyEl.className = 'cb-vlist-empty';
        this.emptyEl.style.position = 'absolute';
        this.emptyEl.style.top = '0';
        this.emptyEl.style.left = '0';
        this.emptyEl.style.right = '0';
        this.emptyEl.style.display = 'none';
        this.emptyEl.innerHTML = this.emptyHtml;
        this.host.appendChild(this.emptyEl);

        this.host.addEventListener('scroll', this._onScroll, { passive: true });
        if (typeof window !== 'undefined' && window.ResizeObserver) {
            this._ro = new ResizeObserver(this._onResize);
            this._ro.observe(this.host);
        }

        this._applyHeight();
        this._renderWindow(/*force=*/true);
    }

    /**
     * Replace the full item array AND filtered indices.
     * Use when an import is reloaded or surface data changes wholesale.
     */
    setItems(items) {
        this.items = items || [];
        this.filteredIndices = this.items.map((_, i) => i);
        this._lastRange = null;
        this._applyHeight();
        this._renderWindow(/*force=*/true);
    }

    /**
     * Update the visible subset by absolute index into `items`.
     * Used by CellebriteUI._applyPaneFilter after computing matches.
     */
    setFilteredIndices(indices) {
        this.filteredIndices = Array.isArray(indices) ? indices : [];
        this._lastRange = null;
        this._applyHeight();
        // Reset scroll to top whenever filter changes — otherwise scrollTop can
        // land past the new (smaller) content height and feel "stuck".
        if (this.host.scrollTop > this.spacer.offsetHeight) this.host.scrollTop = 0;
        this._renderWindow(/*force=*/true);
    }

    refresh() {
        this._lastRange = null;
        this._renderWindow(/*force=*/true);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.host.removeEventListener('scroll', this._onScroll);
        if (this._ro) try { this._ro.disconnect(); } catch (_) {}
        if (this.spacer && this.spacer.parentNode) this.spacer.parentNode.removeChild(this.spacer);
        if (this.windowEl && this.windowEl.parentNode) this.windowEl.parentNode.removeChild(this.windowEl);
        if (this.emptyEl && this.emptyEl.parentNode) this.emptyEl.parentNode.removeChild(this.emptyEl);
    }

    _applyHeight() {
        const total = this.filteredIndices.length * this.rowHeight;
        this.spacer.style.height = `${total}px`;
        if (this.filteredIndices.length === 0) {
            this.emptyEl.style.display = '';
            this.windowEl.style.display = 'none';
        } else {
            this.emptyEl.style.display = 'none';
            this.windowEl.style.display = '';
        }
    }

    _onScroll() {
        if (this._rafToken) return;
        this._rafToken = requestAnimationFrame(() => {
            this._rafToken = 0;
            this._renderWindow(/*force=*/false);
        });
    }

    _onResize() {
        // Visible window count depends on host clientHeight — re-render on resize.
        this._lastRange = null;
        this._renderWindow(/*force=*/true);
    }

    _renderWindow(force) {
        if (this._destroyed) return;
        const total = this.filteredIndices.length;
        if (total === 0) return;

        const scrollTop = this.host.scrollTop;
        const clientH = this.host.clientHeight || this.host.offsetHeight || 600;
        const firstIdx = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.buffer);
        const visibleCount = Math.ceil(clientH / this.rowHeight) + this.buffer * 2;
        const lastIdx = Math.min(total, firstIdx + visibleCount);

        // Skip re-render if the window hasn't moved by enough rows.
        if (!force && this._lastRange && this._lastRange.first === firstIdx && this._lastRange.last === lastIdx) {
            return;
        }
        this._lastRange = { first: firstIdx, last: lastIdx };

        // Build HTML for the windowed slice. Each row gets data-cb-vrow-idx
        // (absolute index into items) so click delegation can resolve back.
        const parts = [];
        for (let i = firstIdx; i < lastIdx; i++) {
            const absIdx = this.filteredIndices[i];
            const item = this.items[absIdx];
            if (item == null) continue;
            const rowHtml = this.renderRow(item, absIdx);
            parts.push(
                `<div class="cb-vlist-row" data-cb-vrow-idx="${absIdx}" `
                + `style="position:absolute;left:0;right:0;top:${i * this.rowHeight}px;height:${this.rowHeight}px;`
                + (this.gridTemplate ? `display:grid;grid-template-columns:${this.gridTemplate};align-items:center;` : '')
                + `">${rowHtml}</div>`
            );
        }
        this.windowEl.innerHTML = parts.join('');
        this.windowEl.style.height = `${total * this.rowHeight}px`;
    }
}

if (typeof window !== 'undefined') {
    window.CellebriteVirtualList = CellebriteVirtualList;
}
