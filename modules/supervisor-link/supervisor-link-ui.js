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
        const pdf = await buildOpsPdf(ops);
        return [{
          dtype: 'opsPlan',
          manifest: {
            title: ops.title || ('Operations Plan — ' + (ops.caseNumber || '')),
            caseNumber: ops.caseNumber || '', risk: ops.risk || '',
            date: ops.date || '', location: ops.location || '',
          },
          body: { fileName: (ops.caseNumber ? ops.caseNumber + '-' : '') + 'ops-plan.pdf', pdfBase64: pdf },
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
          pickerHint.textContent = 'Could not reach the Supervisor node at ' + manual + '. Check the address and that the app is running.';
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

  window.SupervisorLink = { getIdentity, openPushDialog, buildStatsSnapshot, buildCaseDigest };
})();
