/**
 * Datapilot — Mobile Evidence Report PDF generator
 * Uses jsPDF (already loaded by VIPER for case reports).
 *
 * Sections:
 *   1. Cover page (case info + device)
 *   2. Acquisition summary
 *   3. Stats dashboard
 *   4. Top contacts (bar chart, baked in)
 *   5. Comms heatmap (PNG)
 *   6. GPS map snapshot (Leaflet → canvas)
 *   7. Anomaly summary
 *   8. Auto-narrative paragraph
 *   9. Flagged items detail
 *  10. Appendices: contacts list, message excerpts, photo thumbnails
 */

class DatapilotReport {
    constructor(module) {
        this.module = module;
        this.ACCENT = [0, 90, 160];
        this.BLACK = [30, 30, 30];
        this.GRAY = [100, 100, 100];
        this.LGRAY = [180, 180, 180];
    }

    async generate() {
        if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
            throw new Error('jsPDF not loaded');
        }
        const { jsPDF } = (window.jspdf || jspdf);
        const imp = this.module.getActiveImport();
        if (!imp) throw new Error('No active Datapilot import');

        const doc = new jsPDF({ unit: 'pt', format: 'letter' });
        this.doc = doc;
        this.W = doc.internal.pageSize.getWidth();
        this.H = doc.internal.pageSize.getHeight();
        this.margin = 50;
        this.y = this.margin;

        if (typeof showToast === 'function') showToast('Generating Mobile Evidence Report…', 'info');

        // Cover
        this._cover(imp);

        // Stats + Device
        this.doc.addPage(); this.y = this.margin;
        this._header('Mobile Evidence Report', imp);
        this._sectionTitle('Device & Acquisition');
        this._deviceTable(imp);
        this._spacer(8);
        this._acquisitionTable(imp);
        this._spacer(12);
        this._sectionTitle('Statistics');
        this._statsBlock(imp);

        // Top contacts bar chart
        this.doc.addPage(); this.y = this.margin;
        this._header('Mobile Evidence Report', imp);
        this._sectionTitle('Top Contacts (Message Volume)');
        await this._topContactsChart(imp);

        // Heatmap
        this._spacer(20);
        this._sectionTitle('Communication Heatmap');
        this._heatmapChart(imp);

        // GPS map
        this.doc.addPage(); this.y = this.margin;
        this._header('Mobile Evidence Report', imp);
        this._sectionTitle('GPS Activity Map');
        await this._gpsSnapshot(imp);

        // Anomalies
        this.doc.addPage(); this.y = this.margin;
        this._header('Mobile Evidence Report', imp);
        this._sectionTitle('Anomaly Detection');
        this._anomalies(imp);

        this._spacer(16);
        this._sectionTitle('Auto-Narrative');
        this._narrative(imp);

        // Flagged items
        const total = this.module.flagCount();
        if (total > 0) {
            this.doc.addPage(); this.y = this.margin;
            this._header('Mobile Evidence Report', imp);
            this._sectionTitle(`Flagged Items (${total})`);
            this._flagged(imp);
        }

        // Save
        const fname = `MobileEvidenceReport_${(imp.deviceInfo && imp.deviceInfo.model || 'device').replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;
        doc.save(fname);
        if (typeof showToast === 'function') showToast('Mobile Evidence Report saved', 'success');
    }

    // ─── Page primitives ───────────────────────────────────────────────

    _cover(imp) {
        const dev = imp.deviceInfo || {};
        const ci = (imp.summary && imp.summary.caseInfo) || {};
        this.doc.setFillColor(...this.ACCENT);
        this.doc.rect(0, 0, this.W, 130, 'F');
        this.doc.setTextColor(255, 255, 255);
        this.doc.setFont('helvetica', 'bold').setFontSize(28);
        this.doc.text('Mobile Evidence Report', this.margin, 70);
        this.doc.setFont('helvetica', 'normal').setFontSize(13);
        this.doc.text('Datapilot Forensic Analysis', this.margin, 95);

        this.doc.setTextColor(...this.BLACK);
        this.y = 170;

        const lines = [
            ['Case Number', this.module.caseNumber],
            ['Case Title', this.module.caseName || ''],
            ['Device', `${dev.make || ''} ${dev.model || ''}`.trim()],
            ['Phone Number', dev.phoneNumber || ''],
            ['Carrier', dev.carrier || ''],
            ['Serial Number', dev.serial || ''],
            ['Firmware', dev.firmware || ''],
            ['Acquired By', ci['User Info'] || ''],
            ['Acquisition Date', (ci['Case Info'] || '').split('\n').pop() || ''],
            ['Report Generated', new Date().toLocaleString()],
        ];
        this.doc.setFontSize(10);
        for (const [k, v] of lines) {
            this.doc.setTextColor(...this.GRAY);
            this.doc.setFont('helvetica', 'bold');
            this.doc.text(k, this.margin, this.y);
            this.doc.setTextColor(...this.BLACK);
            this.doc.setFont('helvetica', 'normal');
            this.doc.text(String(v).slice(0, 80), this.margin + 130, this.y);
            this.y += 18;
        }

        // Footer
        this.doc.setDrawColor(...this.LGRAY);
        this.doc.line(this.margin, this.H - 50, this.W - this.margin, this.H - 50);
        this.doc.setFontSize(9).setTextColor(...this.GRAY);
        this.doc.text('Generated by VIPER Datapilot Module', this.margin, this.H - 30);
    }

    _header(title, imp) {
        this.doc.setFillColor(...this.ACCENT);
        this.doc.rect(0, 0, this.W, 30, 'F');
        this.doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(11);
        this.doc.text(title, this.margin, 19);
        const dev = imp.deviceInfo || {};
        const right = `${dev.make || ''} ${dev.model || ''} · ${this.module.caseNumber}`;
        const w = this.doc.getStringUnitWidth(right) * 11 / this.doc.internal.scaleFactor;
        this.doc.text(right, this.W - this.margin - w, 19);
        this.doc.setTextColor(...this.BLACK);
        this.y = 60;
    }

    _sectionTitle(text) {
        this.doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(...this.ACCENT);
        this.doc.text(text, this.margin, this.y);
        this.doc.setDrawColor(...this.ACCENT).setLineWidth(0.6);
        this.doc.line(this.margin, this.y + 4, this.W - this.margin, this.y + 4);
        this.y += 18;
        this.doc.setLineWidth(0.2).setTextColor(...this.BLACK);
    }

    _spacer(n) { this.y += n; }

    _need(n) {
        if (this.y + n > this.H - 50) {
            this.doc.addPage();
            this.y = this.margin;
        }
    }

    _kvLine(k, v) {
        this._need(16);
        this.doc.setFontSize(10).setFont('helvetica', 'bold').setTextColor(...this.GRAY);
        this.doc.text(k, this.margin, this.y);
        this.doc.setFont('helvetica', 'normal').setTextColor(...this.BLACK);
        const lines = this.doc.splitTextToSize(String(v || ''), this.W - this.margin * 2 - 130);
        this.doc.text(lines, this.margin + 130, this.y);
        this.y += Math.max(16, lines.length * 14);
    }

    _deviceTable(imp) {
        const dev = imp.deviceInfo || {};
        const rows = [
            ['Make/Model', `${dev.make || ''} ${dev.model || ''}`.trim()],
            ['Phone Number', dev.phoneNumber || ''],
            ['Carrier', dev.carrier || ''],
            ['Serial', dev.serial || ''],
            ['Firmware', dev.firmware || ''],
            ['Time Zone', dev.timeZone || ''],
            ['Clock (UTC)', dev.clockUtc || ''],
        ];
        for (const [k, v] of rows) this._kvLine(k, v);
    }

    _acquisitionTable(imp) {
        const ci = (imp.summary && imp.summary.caseInfo) || {};
        const rows = Object.entries(ci);
        for (const [k, v] of rows) this._kvLine(k, String(v).replace(/\r?\n/g, ' · '));
    }

    _statsBlock(imp) {
        const s = imp.stats || {};
        const items = [
            ['Contacts', s.contacts],
            ['Messages', s.messages],
            ['Calls', s.calls],
            ['Calendar Entries', s.calendarEntries],
            ['Applications', s.apps],
            ['Photos', s.photos],
            ['Videos', s.videos],
            ['Audio Files', s.audio],
            ['Other Files', s.files],
            ['Photos with GPS', s.photosWithGps],
            ['Deleted DBs', s.deletedSources],
            ['App Data Sources', s.appDataSources],
        ];
        const colWidth = (this.W - this.margin * 2) / 4;
        const rowH = 50;
        for (let i = 0; i < items.length; i++) {
            const [label, num] = items[i];
            const col = i % 4;
            const row = Math.floor(i / 4);
            const x = this.margin + col * colWidth;
            const yTop = this.y + row * rowH;
            this.doc.setDrawColor(...this.LGRAY);
            this.doc.rect(x + 2, yTop, colWidth - 4, rowH - 6);
            this.doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...this.ACCENT);
            this.doc.text(String(num != null ? num : 0), x + 10, yTop + 24);
            this.doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...this.GRAY);
            this.doc.text(label.toUpperCase(), x + 10, yTop + 40);
        }
        this.y += Math.ceil(items.length / 4) * rowH + 10;
    }

    async _topContactsChart(imp) {
        const counts = {};
        for (const m of imp.messages) {
            const a = m.address || '?';
            counts[a] = (counts[a] || 0) + 1;
        }
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (!top.length) {
            this.doc.setFontSize(10).setTextColor(...this.GRAY);
            this.doc.text('No messaging activity found.', this.margin, this.y);
            this.y += 16;
            return;
        }
        const max = top[0][1];
        const chartW = this.W - this.margin * 2;
        const rowH = 22;
        for (let i = 0; i < top.length; i++) {
            const [addr, n] = top[i];
            const named = imp.contacts.find(c => (c.phones || []).some(p => p.replace(/\D/g, '').includes(addr.replace(/\D/g, ''))));
            const display = named ? named.name : addr;
            const labelW = 160;
            const barW = chartW - labelW - 50;
            const w = (n / max) * barW;
            this.doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...this.BLACK);
            this.doc.text(String(display).slice(0, 30), this.margin, this.y + 14);
            this.doc.setFillColor(...this.ACCENT);
            this.doc.rect(this.margin + labelW, this.y + 5, w, 12, 'F');
            this.doc.setFontSize(9).setTextColor(...this.BLACK);
            this.doc.text(String(n), this.margin + labelW + w + 4, this.y + 14);
            this.y += rowH;
        }
    }

    _heatmapChart(imp) {
        const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
        let max = 0;
        for (const m of imp.messages) {
            if (!m.timestampIso) continue;
            const d = new Date(m.timestampIso);
            if (isNaN(d.getTime())) continue;
            grid[d.getDay()][d.getHours()]++;
            if (grid[d.getDay()][d.getHours()] > max) max = grid[d.getDay()][d.getHours()];
        }
        if (!max) {
            this.doc.setFontSize(10).setTextColor(...this.GRAY);
            this.doc.text('Insufficient data for heatmap.', this.margin, this.y);
            this.y += 16;
            return;
        }
        const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        const cellW = 18, cellH = 18;
        const startX = this.margin + 30;
        // Hour header
        this.doc.setFontSize(7).setTextColor(...this.GRAY);
        for (let h = 0; h < 24; h++) {
            this.doc.text(String(h), startX + h * cellW + 6, this.y - 2);
        }
        for (let d = 0; d < 7; d++) {
            this.doc.text(days[d], this.margin, this.y + d * cellH + 13);
            for (let h = 0; h < 24; h++) {
                const v = grid[d][h];
                if (v) {
                    const ratio = v / max;
                    // Blend: white → ACCENT
                    const r = Math.round(255 + (this.ACCENT[0] - 255) * ratio);
                    const g = Math.round(255 + (this.ACCENT[1] - 255) * ratio);
                    const b = Math.round(255 + (this.ACCENT[2] - 255) * ratio);
                    this.doc.setFillColor(r, g, b);
                    this.doc.rect(startX + h * cellW, this.y + d * cellH, cellW - 1, cellH - 1, 'F');
                } else {
                    this.doc.setFillColor(245, 245, 245);
                    this.doc.rect(startX + h * cellW, this.y + d * cellH, cellW - 1, cellH - 1, 'F');
                }
            }
        }
        this.y += 7 * cellH + 14;
        this.doc.setFontSize(8).setTextColor(...this.GRAY);
        this.doc.text(`Peak: ${max} messages in single cell. Darker = more activity.`, this.margin, this.y);
        this.y += 12;
    }

    async _gpsSnapshot(imp) {
        const points = [];
        for (const ex of Object.values(imp.photoExifByHash || {})) {
            if (ex && ex.gps) points.push({ lat: ex.gps.lat, lng: ex.gps.lng, name: ex.name });
        }
        if (!points.length) {
            this.doc.setFontSize(10).setTextColor(...this.GRAY);
            this.doc.text('No GPS-tagged photos in this export.', this.margin, this.y);
            this.y += 16;
            return;
        }
        // Simple scatter plot in lat/lng space (no tile imagery — keeps it offline)
        const minLat = Math.min(...points.map(p => p.lat));
        const maxLat = Math.max(...points.map(p => p.lat));
        const minLng = Math.min(...points.map(p => p.lng));
        const maxLng = Math.max(...points.map(p => p.lng));
        const padLat = (maxLat - minLat) * 0.1 || 0.001;
        const padLng = (maxLng - minLng) * 0.1 || 0.001;
        const chartW = this.W - this.margin * 2;
        const chartH = 280;
        // Border
        this.doc.setDrawColor(...this.LGRAY).setFillColor(248, 248, 252);
        this.doc.rect(this.margin, this.y, chartW, chartH, 'FD');
        // Plot
        for (const p of points) {
            const x = this.margin + ((p.lng - (minLng - padLng)) / ((maxLng + padLng) - (minLng - padLng))) * chartW;
            const y = this.y + chartH - ((p.lat - (minLat - padLat)) / ((maxLat + padLat) - (minLat - padLat))) * chartH;
            this.doc.setFillColor(...this.ACCENT);
            this.doc.circle(x, y, 3, 'F');
        }
        this.y += chartH + 8;
        this.doc.setFontSize(8).setTextColor(...this.GRAY);
        this.doc.text(`${points.length} photo${points.length === 1 ? '' : 's'} with GPS · bounds: ${minLat.toFixed(4)}…${maxLat.toFixed(4)} N, ${minLng.toFixed(4)}…${maxLng.toFixed(4)} E`, this.margin, this.y);
        this.y += 14;
    }

    _anomalies(imp) {
        const coach = new DatapilotCoach(this.module);
        const a = coach._computeAnomalies(imp);
        const rules = [
            ['Baseline Outlier', a.baselineOutlier],
            ['New-Contact Burst', a.newContactBurst],
            ['Deletion Burst', a.deletionBurst],
            ['Location Outlier', a.locationOutlier],
            ['App-Install Burst', a.appInstallBurst],
        ];
        for (const [name, rule] of rules) {
            this._need(40);
            this.doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(...this.ACCENT);
            this.doc.text((rule.alerts.length ? '⚠ ' : '✓ ') + name + ` — ${rule.alerts.length || 'OK'}`, this.margin, this.y);
            this.y += 14;
            this.doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...this.BLACK);
            for (const al of rule.alerts.slice(0, 5)) {
                const lines = this.doc.splitTextToSize(' • ' + al, this.W - this.margin * 2 - 12);
                this._need(lines.length * 12);
                this.doc.text(lines, this.margin + 8, this.y);
                this.y += lines.length * 12;
            }
            this.y += 4;
        }
    }

    _narrative(imp) {
        const dev = imp.deviceInfo || {};
        const s = imp.stats || {};
        const coach = new DatapilotCoach(this.module);
        const a = coach._computeAnomalies(imp);
        const totalAnoms = Object.values(a).reduce((sum, x) => sum + x.alerts.length, 0);
        const counts = coach._addressCounts(imp);
        const topAddr = counts[0] ? counts[0].address : null;
        const photos = coach._photoDates(imp);
        const span = photos.length ? `${photos[0].toLocaleDateString()} to ${photos[photos.length - 1].toLocaleDateString()}` : 'unknown';
        const gpsPoints = coach._gpsPoints(imp);
        const gpsSummary = gpsPoints.length ? `${gpsPoints.length} GPS-tagged photos clustered in ${coach._clusterPoints(gpsPoints, 0.5).length} distinct locations` : 'no GPS data';

        const para = [
            `This Datapilot export from a ${dev.make || ''} ${dev.model || ''}${dev.phoneNumber ? ' (' + dev.phoneNumber + ')' : ''} contains ${s.contacts || 0} contacts, ${s.messages || 0} messages, and ${(s.photos || 0) + (s.videos || 0)} media items.`,
            topAddr ? `The most active correspondent was ${topAddr} with ${counts[0].count} messages.` : '',
            `Photo activity spans ${span}, with ${gpsSummary}.`,
            `${s.apps || 0} applications were enumerated on the device.`,
            totalAnoms > 0
                ? `Anomaly detection surfaced ${totalAnoms} alert${totalAnoms === 1 ? '' : 's'} across 5 rules — review the Anomaly Detection section above.`
                : 'No anomalies were detected by the 5 baseline rules.',
        ].filter(Boolean).join(' ');

        this.doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...this.BLACK);
        const lines = this.doc.splitTextToSize(para, this.W - this.margin * 2);
        this._need(lines.length * 13);
        this.doc.text(lines, this.margin, this.y);
        this.y += lines.length * 13;
    }

    _flagged(imp) {
        const f = imp.flagged || {};
        const sections = [
            ['Contacts', f.contacts || [], (k) => {
                const c = imp.contacts.find(x => String(x.no) === String(k));
                return c ? `${c.name || '(unnamed)'} — ${(c.phones || []).join(', ')}` : null;
            }],
            ['Messages', f.messages || [], (k) => {
                const m = imp.messages.find(x => x.uid === k);
                return m ? `[${m.timestamp}] ${m.direction.toUpperCase()} ${m.address}: ${(m.text || '').slice(0, 200)}` : null;
            }],
            ['Calls', f.calls || [], (k) => {
                const c = imp.calls.find(x => String(x.no) === String(k));
                return c ? `Row #${c.no}: ${(c.deletedData || '').slice(0, 200)}` : null;
            }],
            ['Apps', f.apps || [], (k) => {
                const a = imp.apps.find(x => String(x.no) === String(k));
                return a ? `${a.displayName} (${a.appId}) v${a.version}` : null;
            }],
            ['Files', f.files || [], (k) => {
                const fi = imp.files.find(x => x.sha256 === k || String(x.no) === String(k));
                return fi ? `${fi.fileName} — ${fi.sourcePath}` : null;
            }],
            ['Media', f.media || [], (k) => {
                const m = imp.media.find(x => x.sha256 === k);
                return m ? `${m.fileName} (${m.mediaType})` : null;
            }],
        ];
        for (const [label, keys, lookup] of sections) {
            if (!keys.length) continue;
            this._need(20);
            this.doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...this.ACCENT);
            this.doc.text(`${label} (${keys.length})`, this.margin, this.y);
            this.y += 14;
            this.doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...this.BLACK);
            for (const k of keys) {
                const text = lookup(k);
                if (!text) continue;
                const lines = this.doc.splitTextToSize(' • ' + text, this.W - this.margin * 2 - 12);
                this._need(lines.length * 12);
                this.doc.text(lines, this.margin + 8, this.y);
                this.y += lines.length * 12 + 2;
            }
            this.y += 6;
        }
    }
}

if (typeof window !== 'undefined') window.DatapilotReport = DatapilotReport;
