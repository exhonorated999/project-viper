// modules/supervisor-link/supervisor-link-ui.js
// ---------------------------------------------------------------------------
// Supervisor Link — renderer UI (Project V.I.P.E.R. investigator side).
//
// Provides window.SupervisorLink:
//   • getIdentity()            – this investigator's name/badge/unit/deviceId
//   • buildStatsSnapshot()     – productivity stats from localStorage.viperCases
//   • buildCaseDigest()        – case-status digest (metadata only, NO content)
//   • openPushDialog(opts)     – modal: discover online supervisors, pick one,
//                                push datasets and/or an OPS plan PDF.
//
// All transport happens in the main process via electronAPI.supervisorLink.
// No case files, evidence, media, or narratives are ever transmitted — only
// rolled-up stats, status rows, and (for OPS plans) a generated PDF.
// ---------------------------------------------------------------------------
(function () {
  'use strict';

  const C = {
    bg: '#0E1117', panel: '#161a21', panel2: '#1a1f27',
    border: '#262d38', borderSoft: '#1f2530',
    blue: '#0078D4', cyan: '#00B7C3', green: '#4CAF50',
    amber: '#FFC107', red: '#ef5350', text: '#E0E0E0', dim: '#A0A0A0', faint: '#6b7280',
  };

  // ── localStorage helpers ────────────────────────────────────────────────
  function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function lsJSON(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } }

  // LAN node address — the Supervisor host on the network. Persisted locally.
  // Blank ("") means AUTO-DETECT: the app UDP-broadcasts to find the node, so
  // no manual configuration is needed on a normal LAN. A value pins a specific
  // host (e.g. ws://192.168.1.52:7071) and skips discovery.
  const NODE_URL_KEY = 'viper_supervisor_node_url';
  function getNodeUrl() {
    return (lsGet(NODE_URL_KEY) || '').trim(); // '' => auto-detect
  }
  function setNodeUrl(u) {
    try { localStorage.setItem(NODE_URL_KEY, String(u || '').trim()); } catch (_) {}
  }

  function deviceId() {
    let id = lsGet('viper_device_id');
    if (!id) {
      id = 'INV-' + Math.random().toString(36).slice(2, 8).toUpperCase()
        + '-' + Date.now().toString(36).toUpperCase().slice(-4);
      try { localStorage.setItem('viper_device_id', id); } catch (_) {}
    }
    return id;
  }

  function getIdentity() {
    const userInfo = lsJSON('viperUserInfo', {});
    return {
      name: lsGet('viper_customer_name') || userInfo.officerName || 'Investigator',
      badge: userInfo.badgeNumber || lsGet('viper_badge') || '',
      unit: lsGet('viper_agency') || userInfo.agencyName || '',
      deviceId: deviceId(),
    };
  }

  function api() { return (window.electronAPI && window.electronAPI.supervisorLink) || null; }

  // ── Domain helpers ──────────────────────────────────────────────────────
  const ACTIVE_STATES = ['active', 'open', 'ongoing'];
  function isClosed(s) { return /clos|clear|arrest|adjud|inactiv/i.test(String(s || '')); }
  function priorityLabel(p) {
    const n = parseInt(p, 10) || 0;
    return ['Routine', 'Low', 'Medium', 'High'][Math.min(n, 3)] || 'Routine';
  }
  function statusLabel(s) {
    const v = String(s || 'active');
    return v.charAt(0).toUpperCase() + v.slice(1).replace(/[-_]/g, ' ');
  }
  function shortLabel(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > (n || 60) ? t.slice(0, n || 60) + '…' : (t || '—');
  }

  function getCases() { return lsJSON('viperCases', []); }

  // Productivity snapshot — small headline numbers + breakdowns. No content.
  function buildStatsSnapshot() {
    const cases = getCases();
    const total = cases.length;
    let open = 0, closed = 0;
    const byStatus = {}, byPriority = {};
    cases.forEach((c) => {
      const st = String(c.status || 'active');
      byStatus[statusLabel(st)] = (byStatus[statusLabel(st)] || 0) + 1;
      if (isClosed(st)) closed++; else open++;
      const pl = priorityLabel(c.priority);
      byPriority[pl] = (byPriority[pl] || 0) + 1;
    });
    const now = new Date();
    const newThisMonth = cases.filter((c) => {
      const d = new Date(c.createdAt || 0);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    const clearance = total ? Math.round((closed / total) * 100) : 0;

    const id = getIdentity();
    return {
      manifest: {
        title: `Stats Snapshot — ${id.name}`,
        generatedAt: now.toISOString(),
        caseCount: total,
      },
      body: {
        headline: [
          { label: 'Total Cases', value: total },
          { label: 'Open', value: open },
          { label: 'Closed', value: closed },
          { label: 'Clearance %', value: clearance + '%' },
          { label: 'New (Month)', value: newThisMonth },
        ],
        byStatus: Object.entries(byStatus).map(([label, count]) => ({ label, count })),
        byType: Object.entries(byPriority).map(([label, count]) => ({ label, count })),
        investigator: id.name,
        badge: id.badge,
      },
    };
  }

  // ── Case activity redactor ────────────────────────────────────────────
  // Reconstructs a SAFE, metadata-only activity feed per case from the same
  // localStorage sources the case-detail timeline uses. CRITICAL: this emits
  // ONLY {date, lane, category, action, significance} where `action` is a
  // curated status label (verb + type/platform). It NEVER includes names,
  // addresses, free-text titles/descriptions, narrative text, note content,
  // tags, file names, or any other PII / case content. Notes are excluded.
  function _isoFull(v) {
    try { const d = new Date(v); return isNaN(d) ? '' : d.toISOString(); }
    catch { return ''; }
  }

  function buildCaseActivity(c) {
    const caseNumber = c.caseNumber || ('#' + (c.id || ''));
    const id = c.id;
    const ev = []; // { date, lane, category, action, significance }
    const push = (date, lane, category, action, significance) => {
      const d = _isoFull(date);
      if (!d) return;
      ev.push({ date: d, lane, category, action, significance: significance || 'supporting' });
    };

    // Case opened
    if (c.createdAt) push(c.createdAt, 'incident', 'custom', 'Case opened', 'major');

    // Warrants — type + status verb only (NO issuedTo / description)
    const warrants = (lsJSON('viperCaseWarrants', {})[caseNumber]) || [];
    warrants.forEach((w) => {
      const kind = String(w.provider || w.platform || w.service || w.type || 'Warrant').trim();
      if (w.dateSigned)      push(w.dateSigned + 'T00:00:00', 'investigation', 'warrant', `${kind} warrant signed`, 'major');
      if (w.dateServed)      push(w.dateServed + 'T00:00:00', 'investigation', 'warrant', `${kind} warrant served`, 'major');
      if (w.courtReturnDate) push(w.courtReturnDate + 'T00:00:00', 'investigation', 'warrant', `${kind} court return`, 'supporting');
      if (w.uploadedAt || w.createdAt) push(w.uploadedAt || w.createdAt, 'investigation', 'warrant', `${kind} warrant uploaded`, 'supporting');
    });

    // RMS imports — report TYPE only (NO number / agency / narrative text)
    const rms = lsJSON(`rmsImports_${id}`, []);
    rms.forEach((r) => {
      const t = String(r.reportType || 'RMS report').trim();
      const incidentDate = r.reportDate || r.fromDateTime;
      if (incidentDate) push(incidentDate, 'incident', 'rms', `${t} filed`, 'major');
      if (r.importedAt)  push(r.importedAt, 'investigation', 'rms', `${t} imported`, 'supporting');
      // narratives intentionally skipped — free-text + officer name
    });

    // Evidence — TYPE only (NO tag / description / file names)
    const evidence = (lsJSON('viperCaseEvidence', {})[caseNumber]) || [];
    evidence.forEach((e) => {
      let ts = e.createdAt;
      if (!ts && typeof e.id === 'number' && e.id > 1e12) ts = new Date(e.id).toISOString();
      const type = String(e.type || 'Evidence').trim();
      push(ts, 'forensics', 'digital', `${type} evidence logged`, 'supporting');
    });

    // Area canvass — existence only (NO address / contact / notes)
    const canvas = lsJSON(`areacanvas_${id}`, []);
    canvas.forEach((cv) => push(cv.timestamp, 'investigation', 'surveillance', 'Area canvass conducted', 'supporting'));

    // TRACE imports — existence only
    const allTrace = lsJSON('viperTraceImports', {});
    (allTrace[caseNumber] || []).forEach((imp) => push(imp._importedAt || imp.export_date, 'incident', 'rms', 'TRACE data imported', 'supporting'));

    // Oversight imports — existence only (NO offender name / file name)
    lsJSON(`oversightImport_${id}`, []).forEach((oi) => push(oi.importedAt, 'incident', 'rms', 'Oversight record imported', 'supporting'));

    // Consent searches — type + granted/refused (NO party / location)
    lsJSON(`consentSearches_${id}`, []).forEach((cs) => {
      const granted = cs.consentGiven !== false;
      const type = String(cs.consentType || 'verbal').trim();
      push(cs.dateTime, 'investigation', 'fieldwork', `Consent search (${type}) — ${granted ? 'granted' : 'refused'}`, granted ? 'major' : 'major');
    });

    // Manual timeline entries — generic only (NO user title / description)
    lsJSON(`timelineEvents_${id}`, []).forEach((m) => {
      if (m.sourceType !== 'manual') return;
      push(m.timestamp, m.lane || 'investigation', m.category || 'custom', 'Activity logged', m.significance === 'major' ? 'major' : 'supporting');
    });

    // NOTE: case notes (viperCaseNotes) intentionally NOT included.

    // Sort newest first
    ev.sort((a, b) => b.date.localeCompare(a.date));

    // Totals (computed over ALL events, before capping)
    const totals = {
      total: ev.length,
      warrants: ev.filter((x) => x.category === 'warrant').length,
      warrantsServed: ev.filter((x) => x.category === 'warrant' && /served/.test(x.action)).length,
      evidence: ev.filter((x) => x.category === 'digital').length,
      reports: ev.filter((x) => x.category === 'rms').length,
      fieldwork: ev.filter((x) => x.category === 'fieldwork' || x.category === 'surveillance').length,
    };

    // 12-week cadence (events per ISO week), oldest→newest
    const cadence = {};
    ev.forEach((x) => {
      const d = new Date(x.date);
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
      const key = `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
      cadence[key] = (cadence[key] || 0) + 1;
    });
    const cadenceArr = Object.entries(cadence)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([week, count]) => ({ week, count }));

    return {
      lastActivity: ev[0] ? ev[0].date.slice(0, 10) : (c.lastModified || c.createdAt || '').slice(0, 10),
      totals,
      cadence: cadenceArr,
      events: ev.slice(0, 50), // cap per case to bound payload
    };
  }

  // Case-status digest — one lightweight row per case, metadata only.
  function buildCaseDigest() {
    const cases = getCases();
    const rows = cases.map((c) => ({
      caseNumber: c.caseNumber || ('#' + (c.id || '')),
      label: shortLabel(c.synopsis, 60),
      state: statusLabel(c.status),
      risk: priorityLabel(c.priority),
      lastActivity: (c.lastModified || c.createdAt || '').slice(0, 10),
      assignee: c.createdBy || getIdentity().name,
      activity: buildCaseActivity(c),
    }));
    return {
      manifest: {
        title: `Case-Status Digest — ${rows.length} case${rows.length === 1 ? '' : 's'}`,
        generatedAt: new Date().toISOString(),
        count: rows.length,
      },
      body: { rows },
    };
  }

  // ── Dialog ──────────────────────────────────────────────────────────────
  let overlayEl = null;

  function el(tag, style, props) {
    const e = document.createElement(tag);
    if (style) e.setAttribute('style', style);
    if (props) Object.assign(e, props);
    return e;
  }

  function close() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }

  // opts:
  //   mode: 'dashboard' | 'opsplan'
  //   ops?: { caseNumber, title, date, location, risk, summary, officer } (opsplan)
  function openPushDialog(opts) {
    opts = opts || {};
    const mode = opts.mode || 'dashboard';
    if (!api()) { alert('Supervisor Link is only available in the desktop app.'); return; }
    close();

    overlayEl = el('div', `position:fixed;inset:0;z-index:99999;background:rgba(4,6,10,.66);
      backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;
      font-family:'Segoe UI',system-ui,sans-serif;`);
    overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) close(); });

    const card = el('div', `width:560px;max-width:94vw;max-height:90vh;overflow:auto;
      background:linear-gradient(160deg,${C.panel2},${C.panel});border:1px solid ${C.border};
      border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.6);color:${C.text};`);
    overlayEl.appendChild(card);

    // Header
    const head = el('div', `display:flex;align-items:center;gap:12px;padding:18px 20px;border-bottom:1px solid ${C.borderSoft};`);
    head.appendChild(el('div', `width:34px;height:34px;border-radius:9px;display:grid;place-items:center;
      background:rgba(0,183,195,.14);border:1px solid rgba(0,183,195,.4);color:${C.cyan};font-weight:800;`, { textContent: '⇪' }));
    const htext = el('div', 'flex:1');
    htext.appendChild(el('div', `font-size:16px;font-weight:700;color:#fff;`, { textContent: 'Push to Supervisor' }));
    htext.appendChild(el('div', `font-size:12px;color:${C.dim};margin-top:2px;`, {
      textContent: mode === 'opsplan' ? 'Send this operations plan for digital approval' : 'Share stats & case status over the LAN',
    }));
    head.appendChild(htext);
    const x = el('button', `background:none;border:none;color:${C.dim};font-size:18px;cursor:pointer;`, { textContent: '✕' });
    x.addEventListener('click', close);
    head.appendChild(x);
    card.appendChild(head);

    const bodyWrap = el('div', 'padding:18px 20px;');
    card.appendChild(bodyWrap);

    // Section: LAN node address (auto-detected; optional manual override)
    bodyWrap.appendChild(el('div', `font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.faint};margin-bottom:8px;`, { textContent: 'Supervisor LAN Node' }));
    const nodeRow = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px;');
    const nodeInput = el('input', `flex:1;background:${C.bg};border:1px solid ${C.border};color:${C.text};
      border-radius:9px;padding:10px 12px;font-size:13px;outline:none;font-family:ui-monospace,Consolas,monospace;`,
      { type: 'text', value: getNodeUrl(), placeholder: 'auto-detect on network  (or ws://host:7071)' });
    const applyBtn = el('button', `background:${C.panel};border:1px solid ${C.border};color:${C.dim};
      border-radius:9px;padding:10px 14px;font-size:13px;cursor:pointer;white-space:nowrap;`, { textContent: 'Apply' });
    nodeRow.appendChild(nodeInput);
    nodeRow.appendChild(applyBtn);
    bodyWrap.appendChild(nodeRow);
    bodyWrap.appendChild(el('div', `font-size:11px;color:${C.faint};margin-bottom:14px;`, {
      textContent: 'Leave blank to auto-detect the Supervisor node on your network. Enter a LAN address (e.g. ws://192.168.1.52:7071) to target a specific machine.',
    }));
    applyBtn.addEventListener('click', () => { setNodeUrl(nodeInput.value); refreshSecure(); discover(); });
    nodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setNodeUrl(nodeInput.value); refreshSecure(); discover(); } });

    // Section: supervisor picker
    bodyWrap.appendChild(el('div', `font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.faint};margin-bottom:8px;`, { textContent: 'Destination Supervisor' }));
    const pickerRow = el('div', 'display:flex;gap:8px;align-items:center;margin-bottom:6px;');
    const select = el('select', `flex:1;background:${C.bg};border:1px solid ${C.border};color:${C.text};
      border-radius:9px;padding:10px 12px;font-size:13px;outline:none;`);
    select.appendChild(el('option', '', { textContent: 'Discovering…', value: '' }));
    select.disabled = true;
    const refreshBtn = el('button', `background:${C.panel};border:1px solid ${C.border};color:${C.dim};
      border-radius:9px;padding:10px 12px;font-size:13px;cursor:pointer;`, { textContent: '↻' });
    pickerRow.appendChild(select);
    pickerRow.appendChild(refreshBtn);
    bodyWrap.appendChild(pickerRow);
    const pickerHint = el('div', `font-size:12px;color:${C.dim};min-height:16px;`);
    bodyWrap.appendChild(pickerHint);

    // Secure-link status line (device id + node pin + reset).
    const secureLine = el('div', `font-size:11px;color:${C.faint};margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;`);
    bodyWrap.appendChild(secureLine);
    async function refreshSecure() {
      try {
        const st = await api().status({ url: getNodeUrl() });
        secureLine.innerHTML = '';
        const lock = el('span', `color:${C.green};`, { textContent: '\u{1F512}' });
        secureLine.appendChild(lock);
        secureLine.appendChild(el('span', '', { textContent: `device ${st.deviceId || '—'}` }));
        secureLine.appendChild(el('span', `color:${st.nodePin ? C.green : C.amber};`, {
          textContent: st.nodePin ? `· node pinned ${st.nodePin}` : '· node not pinned (pins on connect)',
        }));
        if (st.nodePin) {
          const reset = el('a', `color:${C.cyan};cursor:pointer;text-decoration:underline;`, { textContent: 'reset pin' });
          reset.addEventListener('click', async () => { await api().resetPin({ url: getNodeUrl() }); refreshSecure(); });
          secureLine.appendChild(reset);
        }
      } catch (_) { /* ignore */ }
    }
    refreshSecure();

    // Diagnostics: layered TCP→WS→handshake probe with a copyable report.
    const diagRow = el('div', `margin-top:10px;display:flex;gap:10px;align-items:center;`);
    const diagBtn = el('button', `background:${C.panel};border:1px solid ${C.border};color:${C.cyan};
      border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;`, { textContent: 'Run connection diagnostics' });
    const diagStatus = el('span', `font-size:11px;color:${C.faint};`);
    diagRow.appendChild(diagBtn);
    diagRow.appendChild(diagStatus);
    bodyWrap.appendChild(diagRow);
    const diagPanel = el('div', `display:none;margin-top:8px;border:1px solid ${C.border};border-radius:9px;
      background:${C.bg};padding:10px 12px;`);
    const diagPre = el('pre', `margin:0;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5;
      color:${C.text};font-family:ui-monospace,Consolas,monospace;max-height:220px;overflow:auto;`);
    const diagFoot = el('div', `display:flex;gap:8px;margin-top:8px;`);
    const copyBtn = el('button', `background:${C.panel};border:1px solid ${C.border};color:${C.dim};
      border-radius:7px;padding:6px 11px;font-size:11px;cursor:pointer;`, { textContent: 'Copy report' });
    diagFoot.appendChild(copyBtn);
    diagPanel.appendChild(diagPre);
    diagPanel.appendChild(diagFoot);
    bodyWrap.appendChild(diagPanel);

    function fmtDiag(r) {
      if (!r) return 'No report.';
      const s = r.steps || {};
      const yn = (b) => (b ? 'PASS' : 'FAIL');
      const lines = [];
      lines.push('V.I.P.E.R. Supervisor-Link Diagnostics');
      lines.push('time      ' + (r.ts || '—'));
      lines.push('app       v' + (r.appVersion || '?') + '   ' + (r.platform || ''));
      lines.push('device    ' + (r.deviceId || '—'));
      lines.push('identity  ' + (r.identity && r.identity.present ? (r.identity.name + ' #' + r.identity.badge + ' / ' + (r.identity.unit || '—')) : 'NOT SET'));
      lines.push('field     "' + ((r.field && r.field.input) || '') + '"');
      lines.push('target    ' + ((r.target && r.target.url) || '—') + '   (host ' + ((r.target && r.target.host) || '—') + ' : ' + ((r.target && r.target.port) || '—') + ')');
      const dn = (r.discovery && r.discovery.nodes) || [];
      lines.push('discovery ' + (r.discovery && r.discovery.ran ? (dn.length + ' node(s)' + (r.discovery.error ? ' err=' + r.discovery.error : '')) : 'not run'));
      dn.forEach((n) => lines.push('          • ' + n.url + '  ' + (n.nodeId || '')));
      lines.push('');
      lines.push('1) TCP        ' + yn(s.tcp && s.tcp.ok) + '  ' + ((s.tcp && s.tcp.ms) || 0) + 'ms' + (s.tcp && s.tcp.error ? '  ' + s.tcp.error : ''));
      lines.push('2) WebSocket  ' + yn(s.ws && s.ws.ok) + '  ' + ((s.ws && s.ws.ms) || 0) + 'ms  hello=' + (s.ws && s.ws.helloReceived ? 'yes' : 'no') + (s.ws && s.ws.error ? '  ' + s.ws.error : ''));
      lines.push('3) Handshake  ' + yn(s.handshake && s.handshake.ok) + '  ' + ((s.handshake && s.handshake.ms) || 0) + 'ms  state=' + ((s.handshake && s.handshake.state) || '—') + (s.handshake && s.handshake.rosterCount != null ? '  roster=' + s.handshake.rosterCount : '') + (s.handshake && s.handshake.error ? '  ' + s.handshake.error : ''));
      lines.push('');
      lines.push('VERDICT   ' + (r.summary || '—'));
      return lines.join('\n');
    }

    diagBtn.addEventListener('click', async () => {
      diagBtn.disabled = true;
      diagStatus.style.color = C.faint;
      diagStatus.textContent = 'Probing TCP → WebSocket → handshake…';
      diagPanel.style.display = 'block';
      diagPre.textContent = 'Running…';
      try {
        const r = await api().diagnostics({ url: getNodeUrl(), identity: getIdentity() });
        diagPre.textContent = fmtDiag(r);
        const good = r && r.steps && r.steps.handshake && r.steps.handshake.ok;
        diagStatus.style.color = good ? C.green : C.red;
        diagStatus.textContent = good ? 'Secure link OK' : 'Issue found — see report / copy it to share';
      } catch (e) {
        diagPre.textContent = 'Diagnostics failed: ' + (e && e.message || e);
        diagStatus.style.color = C.red;
        diagStatus.textContent = 'Diagnostics error';
      } finally {
        diagBtn.disabled = false;
      }
    });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(diagPre.textContent || ''); copyBtn.textContent = 'Copied ✓'; setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500); }
      catch (_) { copyBtn.textContent = 'Copy failed'; setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500); }
    });

    // Section: payload
    const payloadWrap = el('div', 'margin-top:16px;');
    bodyWrap.appendChild(payloadWrap);

    let getSelectedPushes; // () => [{dtype, manifest, body}]

    if (mode === 'opsplan') {
      const ops = opts.ops || {};
      payloadWrap.appendChild(el('div', `font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.faint};margin-bottom:8px;`, { textContent: 'Operations Plan' }));
      const tile = el('div', `display:flex;gap:12px;align-items:center;padding:13px;border-radius:10px;
        background:${C.bg};border:1px solid ${C.borderSoft};`);
      tile.appendChild(el('div', `width:42px;height:50px;border-radius:6px;display:grid;place-items:center;
        background:rgba(239,83,80,.14);border:1px solid rgba(239,83,80,.45);color:#ef7a78;font-weight:800;font-size:11px;`, { textContent: 'PDF' }));
      const ti = el('div', 'flex:1;min-width:0;');
      ti.appendChild(el('div', `color:#fff;font-size:14px;font-weight:600;`, { textContent: ops.title || ('Operations Plan — ' + (ops.caseNumber || '')) }));
      ti.appendChild(el('div', `color:${C.dim};font-size:12px;margin-top:2px;`, {
        textContent: [ops.caseNumber, ops.date, ops.risk].filter(Boolean).join(' · ') || 'Generated at push time',
      }));
      tile.appendChild(ti);
      payloadWrap.appendChild(tile);
      payloadWrap.appendChild(el('div', `font-size:12px;color:${C.faint};margin-top:8px;`, {
        textContent: 'A one-page OPS plan PDF is generated and sent. No case files or evidence are included.',
      }));

      getSelectedPushes = async () => {
        // Prefer the FULL OPS plan PDF the case-detail view already rendered
        // (photos/maps/suspects/attachments). Fall back to the one-page
        // summary stub only if no full PDF was attached.
        const pdf = ops.pdfBase64 || await buildOpsPdf(ops);
        const fileName = ops.fileName || ((ops.caseNumber ? ops.caseNumber + '-' : '') + 'ops-plan.pdf');
        return [{
          dtype: 'opsPlan',
          manifest: {
            title: ops.title || ('Operations Plan — ' + (ops.caseNumber || '')),
            caseNumber: ops.caseNumber || '', risk: ops.risk || '',
            date: ops.date || '', location: ops.location || '',
          },
          body: { fileName, pdfBase64: pdf },
        }];
      };
    } else {
      payloadWrap.appendChild(el('div', `font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:${C.faint};margin-bottom:8px;`, { textContent: 'Datasets to Send' }));
      const stats = buildStatsSnapshot();
      const digest = buildCaseDigest();
      const mkCheck = (checked, title, sub) => {
        const row = el('label', `display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:10px;
          background:${C.bg};border:1px solid ${C.borderSoft};margin-bottom:8px;cursor:pointer;`);
        const cb = el('input', 'margin-top:2px;', { type: 'checkbox', checked });
        const tx = el('div', 'flex:1;');
        tx.appendChild(el('div', `color:#fff;font-size:13px;font-weight:600;`, { textContent: title }));
        tx.appendChild(el('div', `color:${C.dim};font-size:12px;margin-top:2px;`, { textContent: sub }));
        row.appendChild(cb); row.appendChild(tx);
        row._cb = cb;
        return row;
      };
      const rowStats = mkCheck(true, 'Stats Snapshot', `${stats.body.headline[0].value} cases · clearance ${stats.body.headline[3].value}`);
      const rowDigest = mkCheck(true, 'Case-Status Digest', `${digest.body.rows.length} case rows · metadata only, no content`);
      payloadWrap.appendChild(rowStats);
      payloadWrap.appendChild(rowDigest);

      getSelectedPushes = async () => {
        const out = [];
        if (rowStats._cb.checked) out.push({ dtype: 'stats', manifest: stats.manifest, body: stats.body });
        if (rowDigest._cb.checked) out.push({ dtype: 'caseStatus', manifest: digest.manifest, body: digest.body });
        return out;
      };
    }

    // Footer
    const foot = el('div', `display:flex;gap:10px;align-items:center;padding:16px 20px;border-top:1px solid ${C.borderSoft};`);
    const result = el('div', `flex:1;font-size:13px;color:${C.dim};`);
    const cancel = el('button', `background:${C.panel};border:1px solid ${C.border};color:${C.text};
      border-radius:9px;padding:10px 16px;font-size:13px;cursor:pointer;`, { textContent: 'Cancel' });
    cancel.addEventListener('click', close);
    const pushBtn = el('button', `background:${C.blue};border:1px solid ${C.blue};color:#fff;font-weight:600;
      border-radius:9px;padding:10px 18px;font-size:13px;cursor:pointer;opacity:.55;`, { textContent: 'Push' });
    pushBtn.disabled = true;
    foot.appendChild(result); foot.appendChild(cancel); foot.appendChild(pushBtn);
    card.appendChild(foot);

    // ── discovery ──
    let roster = [];
    async function discover() {
      select.disabled = true; pushBtn.disabled = true; pushBtn.style.opacity = '.55';
      select.innerHTML = '';
      const manual = getNodeUrl();
      select.appendChild(el('option', '', { textContent: manual ? 'Connecting…' : 'Scanning network…', value: '' }));
      pickerHint.style.color = C.dim;
      pickerHint.textContent = manual ? '' : 'Searching the LAN for a Supervisor node…';
      const res = await api().discover({ identity: getIdentity(), url: manual });
      if (!res || !res.ok) {
        select.innerHTML = '';
        const err = (res && res.error) || '';
        select.appendChild(el('option', '', { textContent: 'Secure link unavailable', value: '' }));
        pickerHint.style.color = C.red;
        if (/NODE_PIN_MISMATCH/.test(err)) {
          pickerHint.textContent = 'Node key changed — pin mismatch (possible rogue node). Reset the pin only if you trust this node.';
        } else if (/DEVICE_REVOKED/.test(err)) {
          pickerHint.textContent = 'This device has been revoked by the supervisor/node. Contact the administrator.';
        } else if (/NODE_PROOF_FAILED/.test(err)) {
          pickerHint.textContent = 'Node failed its identity proof — refusing to connect.';
        } else if (!manual) {
          pickerHint.textContent = 'No Supervisor node found on the network. Make sure the Supervisor app is running and on the same Wi-Fi, or enter its address manually below.';
        } else {
          pickerHint.textContent = 'Could not reach the Supervisor node at ' + manual + '. Check the address and that the app is running — then click "Run connection diagnostics" below for details.';
        }
        refreshSecure();
        return;
      }
      // Reflect the resolved address (auto-detected or manual) into the field.
      if (res.url) { nodeInput.value = res.url; setNodeUrl(res.url); }
      refreshSecure();
      roster = res.roster || [];
      select.innerHTML = '';
      if (!roster.length) {
        select.appendChild(el('option', '', { textContent: 'No supervisors online', value: '' }));
        pickerHint.style.color = C.amber;
        pickerHint.textContent = 'Node found at ' + (res.url || '') + ', but no Supervisor is registered/online there.';
        return;
      }
      select.disabled = false;
      roster.forEach((s) => {
        select.appendChild(el('option', '', { textContent: `${s.name} — ${s.unit || 'Unit'} (${s.badge || s.deviceId})`, value: s.deviceId }));
      });
      pickerHint.style.color = C.dim;
      pickerHint.textContent = `${roster.length} supervisor${roster.length === 1 ? '' : 's'} online`
        + (res.url ? ` · ${res.url}` : '') + '.';
      pushBtn.disabled = false; pushBtn.style.opacity = '1';
    }
    refreshBtn.addEventListener('click', discover);

    pushBtn.addEventListener('click', async () => {
      const to = select.value;
      if (!to) return;
      pushBtn.disabled = true; pushBtn.style.opacity = '.55'; pushBtn.textContent = 'Sending…';
      result.style.color = C.dim; result.textContent = 'Preparing payload…';
      try {
        const pushes = await getSelectedPushes();
        if (!pushes.length) { result.style.color = C.amber; result.textContent = 'Select at least one item.'; pushBtn.disabled = false; pushBtn.style.opacity = '1'; pushBtn.textContent = 'Push'; return; }
        let delivered = 0, queued = 0;
        for (const p of pushes) {
          const ack = await api().push({ identity: getIdentity(), url: getNodeUrl(), to, dtype: p.dtype, manifest: p.manifest, body: p.body });
          if (!ack || !ack.ok) throw new Error((ack && ack.error) || 'PUSH_FAILED');
          if (ack.delivered) delivered++; else queued++;
        }
        result.style.color = C.green;
        const target = roster.find((r) => r.deviceId === to);
        result.textContent = `✓ Sent to ${target ? target.name : 'supervisor'}` +
          (queued ? ` (${queued} queued — offline)` : '');
        pushBtn.textContent = 'Done';
        pushBtn.style.background = C.green; pushBtn.style.borderColor = C.green;
        pushBtn.disabled = false; pushBtn.style.opacity = '1';
        pushBtn.onclick = close;
      } catch (e) {
        result.style.color = C.red;
        result.textContent = 'Push failed: ' + (e && e.message || e);
        pushBtn.disabled = false; pushBtn.style.opacity = '1'; pushBtn.textContent = 'Retry';
      }
    });

    document.body.appendChild(overlayEl);
    discover();
  }

  // Build an OPS-plan PDF in the main process (pdf-lib). Returns base64.
  async function buildOpsPdf(ops) {
    const built = await window.electronAPI.supervisorLink.buildOpsPdf(ops);
    if (built && built.ok) return built.pdfBase64;
    throw new Error((built && built.error) || 'PDF_BUILD_FAILED');
  }

  // ── ICAC assignment receiver + inbox ────────────────────────────────────
  // Supervisor -> investigator direction. A supervisor pushes a CyberTip
  // NUMBER (never PII); we surface it as a dashboard alert. The investigator
  // acknowledges and launches a case in their OWN app, then downloads the
  // report contents from their ICAC system. The ack is routed back so the
  // supervisor can document that the assignment was received.
  const INBOX_KEY = 'viperIcacAssignments';
  let inboxPanelEl = null;

  function inboxGet() { return lsJSON(INBOX_KEY, []); }
  function inboxSave(list) { try { localStorage.setItem(INBOX_KEY, JSON.stringify(list)); } catch (_) {} }
  function pendingCount() { return inboxGet().filter((a) => a.status !== 'acknowledged').length; }

  function toast(msg, kind) {
    if (typeof window.viperToast === 'function') { try { window.viperToast(msg, kind || 'info'); return; } catch (_) {} }
    console.log('[SupervisorLink]', msg);
  }

  function upsertAssignment(a) {
    const list = inboxGet();
    const i = list.findIndex((x) => x.id === a.id);
    if (i >= 0) list[i] = { ...list[i], ...a };
    else list.unshift(a);
    inboxSave(list);
    renderInboxBadge();
    if (inboxPanelEl) renderInboxList();
  }

  function renderInboxBadge() {
    let btn = document.getElementById('icacInboxBtn');
    const n = pendingCount();
    if (!btn) {
      btn = el('button', `position:fixed;right:18px;bottom:18px;z-index:99990;
        width:52px;height:52px;border-radius:50%;border:1px solid ${C.cyan};cursor:pointer;
        background:${C.panel};color:${C.cyan};box-shadow:0 6px 24px rgba(0,0,0,.5);
        font-size:20px;display:flex;align-items:center;justify-content:center;`, { id: 'icacInboxBtn', title: 'CyberTip assignments' });
      btn.innerHTML = '&#128232;';
      btn.addEventListener('click', openInbox);
      const badge = el('span', `position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;
        border-radius:10px;background:${C.red};color:#fff;font-size:11px;font-weight:700;
        display:none;align-items:center;justify-content:center;padding:0 5px;`, { id: 'icacInboxCount' });
      btn.appendChild(badge);
      document.body.appendChild(btn);
    }
    const badge = document.getElementById('icacInboxCount');
    if (badge) {
      badge.textContent = String(n);
      badge.style.display = n > 0 ? 'flex' : 'none';
    }
    // Only show the bell when there is at least one assignment on record.
    btn.style.display = inboxGet().length ? 'flex' : 'none';
  }

  function priBadge(p) {
    const c = p === 'High' ? C.red : p === 'Low' ? C.faint : C.amber;
    return `<span style="border:1px solid ${c};color:${c};border-radius:6px;padding:1px 7px;font-size:11px;">${p || 'Medium'}</span>`;
  }

  function renderInboxList() {
    if (!inboxPanelEl) return;
    const body = inboxPanelEl.querySelector('#icacInboxBody');
    if (!body) return;
    const list = inboxGet();
    if (!list.length) {
      body.innerHTML = `<div style="color:${C.dim};font-size:13px;padding:16px 4px;">No CyberTip assignments yet.</div>`;
      return;
    }
    body.innerHTML = '';
    for (const a of list) {
      const ackd = a.status === 'acknowledged';
      const row = el('div', `border:1px solid ${C.border};border-radius:10px;padding:12px 14px;
        margin-bottom:10px;background:${C.panel2};`);
      row.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-family:ui-monospace,Consolas,monospace;color:#fff;font-size:15px;">${a.cybertipNumber || '—'}</span>
          ${priBadge(a.priority)}
          <span style="margin-left:auto;color:${ackd ? C.green : C.amber};font-size:12px;">${ackd ? '✓ Acknowledged' : 'Pending'}</span>
        </div>
        <div style="color:${C.dim};font-size:12px;margin-top:6px;">From ${a.from || 'Supervisor'} · ${a.sentAt ? new Date(a.sentAt).toLocaleString() : ''}</div>
        ${a.note ? `<div style="color:${C.text};font-size:12.5px;margin-top:6px;">${escapeHtml(a.note)}</div>` : ''}
        ${a.caseNumber ? `<div style="color:${C.cyan};font-size:12px;margin-top:6px;">Case ${escapeHtml(a.caseNumber)}</div>` : ''}
      `;
      if (!ackd) {
        const actions = el('div', 'display:flex;gap:8px;margin-top:10px;');
        const launch = el('button', `flex:1;padding:7px;border-radius:8px;border:1px solid ${C.cyan};
          background:rgba(0,183,195,.16);color:${C.cyan};cursor:pointer;font-size:12.5px;`, { textContent: 'Acknowledge & Launch Case' });
        launch.addEventListener('click', () => acknowledge(a.id, true));
        const ackOnly = el('button', `padding:7px 12px;border-radius:8px;border:1px solid ${C.border};
          background:transparent;color:${C.dim};cursor:pointer;font-size:12.5px;`, { textContent: 'Acknowledge' });
        ackOnly.addEventListener('click', () => acknowledge(a.id, false));
        actions.appendChild(launch); actions.appendChild(ackOnly);
        row.appendChild(actions);
      }
      body.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function openInbox() {
    if (inboxPanelEl) { closeInbox(); return; }
    inboxPanelEl = el('div', `position:fixed;right:18px;bottom:80px;z-index:99991;width:min(380px,92vw);
      max-height:70vh;overflow:auto;background:${C.panel};border:1px solid ${C.border};border-radius:14px;
      box-shadow:0 12px 40px rgba(0,0,0,.6);font-family:'Segoe UI',system-ui,sans-serif;padding:16px;`);
    const head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:12px;');
    head.innerHTML = `<div style="color:#fff;font-weight:600;font-size:15px;">CyberTip Assignments</div>`;
    const x = el('button', `margin-left:auto;background:transparent;border:none;color:${C.dim};font-size:18px;cursor:pointer;`, { textContent: '✕' });
    x.addEventListener('click', closeInbox);
    head.appendChild(x);
    const body = el('div', '', { id: 'icacInboxBody' });
    inboxPanelEl.appendChild(head);
    inboxPanelEl.appendChild(body);
    document.body.appendChild(inboxPanelEl);
    renderInboxList();
  }

  function closeInbox() {
    if (inboxPanelEl && inboxPanelEl.parentNode) inboxPanelEl.parentNode.removeChild(inboxPanelEl);
    inboxPanelEl = null;
  }

  // Create a local case for the CyberTip (investigator opens it in their app).
  function launchCaseForTip(a) {
    const cases = lsJSON('viperCases', []);
    let caseNumber = 'CT-' + (a.cybertipNumber || Date.now());
    let n = 1;
    while (cases.find((c) => c.caseNumber === caseNumber)) caseNumber = 'CT-' + a.cybertipNumber + '-' + (++n);
    const now = new Date().toISOString();
    const newCase = {
      id: Date.now(),
      caseNumber,
      synopsis: `ICAC CyberTip ${a.cybertipNumber} assigned by ${a.from || 'Supervisor'}.` + (a.note ? ` Note: ${a.note}` : ''),
      cybertipNumber: a.cybertipNumber || '',
      status: 'active',
      priority: a.priority === 'High' ? 3 : a.priority === 'Low' ? 1 : 2,
      modules: [],
      tabOrder: ['overview'],
      createdAt: now,
      createdBy: lsGet('viper_customer_name') || 'Investigator',
      lastModified: now,
    };
    cases.push(newCase);
    try { localStorage.setItem('viperCases', JSON.stringify(cases)); } catch (_) {}
    if (typeof window.updateDashboardCaseData === 'function') { try { window.updateDashboardCaseData(); } catch (_) {} }
    return newCase;
  }

  async function acknowledge(assignmentId, launch) {
    const list = inboxGet();
    const a = list.find((x) => x.id === assignmentId);
    if (!a) return;
    let caseNumber = a.caseNumber || null;
    let newCase = null;
    if (launch) {
      newCase = launchCaseForTip(a);
      caseNumber = newCase.caseNumber;
    }
    // Route the acknowledgement back to the supervisor.
    if (api()) {
      try {
        const res = await api().icacAck({
          assignmentId, caseNumber,
          identity: getIdentity(),
          url: getNodeUrl() || undefined,
        });
        if (!res || !res.ok) toast('Acknowledged locally — could not reach supervisor: ' + ((res && res.error) || 'offline'), 'warning');
        else toast('CyberTip ' + a.cybertipNumber + ' acknowledged', 'success');
      } catch (e) {
        toast('Acknowledged locally — supervisor unreachable', 'warning');
      }
    }
    a.status = 'acknowledged';
    a.caseNumber = caseNumber;
    a.acknowledgedAt = new Date().toISOString();
    inboxSave(list);
    renderInboxBadge();
    if (inboxPanelEl) renderInboxList();
    if (launch && newCase && typeof window.openCaseDetail === 'function') {
      closeInbox();
      try { window.openCaseDetail(newCase.id); } catch (_) {}
    }
  }

  let receiverStarted = false;
  function initAssignmentReceiver() {
    if (receiverStarted) return;
    // Receiving supervisor assignments is ON by default in the desktop app;
    // only an explicit opt-out disables it.
    if (lsGet('viperSupervisorLinkEnabled') === 'false') return;
    if (!api()) return;
    receiverStarted = true;

    // Start the persistent receiver so assignments arrive while idle.
    // Blank node url ('') => undefined => main process auto-discovers.
    api().listen({ identity: getIdentity(), url: getNodeUrl() || undefined }).catch(() => {});

    // Fold live assignment events into the inbox.
    api().onEvent((evt) => {
      if (!evt || evt.kind !== 'icac:assign:new') return;
      const p = evt.payload || {};
      upsertAssignment({
        id: p.id,
        cybertipNumber: p.cybertipNumber,
        priority: p.priority || null,
        note: p.note || '',
        from: p.from || 'Supervisor',
        fromBadge: p.fromBadge || '',
        sentAt: p.sentAt || new Date().toISOString(),
        status: 'pending',
      });
      toast('New CyberTip assigned: ' + (p.cybertipNumber || ''), 'info');
    });

    // Reconcile with the node on paint (offline-queued assignments, etc.).
    api().icacAssignments({ identity: getIdentity(), url: getNodeUrl() || undefined })
      .then((r) => {
        if (!r || !r.ok) return;
        for (const a of r.assignments || []) {
          upsertAssignment({
            id: a.id,
            cybertipNumber: a.cybertipNumber,
            priority: a.priority || null,
            note: a.note || '',
            from: a.fromName || 'Supervisor',
            sentAt: a.sentAt,
            status: a.status === 'acknowledged' ? 'acknowledged' : 'pending',
            caseNumber: a.caseNumber || null,
          });
        }
      })
      .catch(() => {});

    renderInboxBadge();
  }

  // Boot the receiver once the DOM is ready, and react to the feature toggle.
  function bootReceiver() {
    initAssignmentReceiver();
    window.addEventListener('storage', (e) => {
      if (e && e.key === 'viperSupervisorLinkEnabled' && e.newValue !== 'false') initAssignmentReceiver();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootReceiver);
  else bootReceiver();

  window.SupervisorLink = { getIdentity, openPushDialog, buildStatsSnapshot, buildCaseDigest, openInbox };
})();
