// modules/supervisor-link/supervisor-link-main.js
// ---------------------------------------------------------------------------
// Supervisor Link — investigator (Project V.I.P.E.R.) side of the push bridge.
//
// Lives in the Electron MAIN process. Opens an AES-256-GCM encrypted
// WebSocket session to the V.I.P.E.R. LAN node as role "investigator", then:
//   • discovers the live roster of online supervisor machines
//   • pushes datasets (stats snapshot / case-status digest) and OPS plan PDFs
//     addressed to a chosen supervisor
//   • forwards "decision" events (approve / return) back to the renderer
//
// The renderer drives everything through ipcRenderer.invoke; identity
// (officer name / badge) is read from renderer localStorage and passed in,
// since the main process cannot see localStorage.
//
// Wire protocol + crypto params MUST match the LAN node and supervisor app.
// ---------------------------------------------------------------------------
'use strict';

const WebSocket = require('ws');
const { BrowserWindow } = require('electron');
const { deriveKey, encryptJSON, decryptJSON } = require('./supervisor-link-crypto');

const DEFAULT_URL = process.env.VIPER_SUPERVISOR_LAN_URL || 'ws://127.0.0.1:7071';
const DEFAULT_PSK = process.env.VIPER_SUPERVISOR_LAN_PSK || 'VIPER-LAN-PSK-2025';
const RPC_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 8000;

let client = null; // active SupervisorLinkClient (one node at a time)

function broadcastToRenderer(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send(channel, payload); } catch (_) {}
  }
}

class SupervisorLinkClient {
  constructor(url, psk, identity) {
    this.url = url;
    this.psk = psk;
    this.identity = identity; // { name, badge, deviceId, unit }
    this.ws = null;
    this.key = null;
    this.seq = 0;
    this.pending = new Map();
    this.state = 'idle';
    this.session = null;
    this._connectWaiters = [];
  }

  sameIdentity(identity) {
    return this.identity
      && this.identity.deviceId === identity.deviceId
      && this.identity.name === identity.name
      && this.identity.badge === identity.badge;
  }

  isReady() {
    return this.state === 'connected' && this.ws && this.ws.readyState === 1 && this.key;
  }

  connect() {
    if (this.isReady()) return Promise.resolve(true);
    if (this.state === 'connecting' || this.state === 'handshaking') {
      return new Promise((resolve, reject) => this._connectWaiters.push({ resolve, reject }));
    }
    this.state = 'connecting';
    return new Promise((resolve, reject) => {
      this._connectWaiters.push({ resolve, reject });

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this._flushWaiters(err);
        try { this.ws && this.ws.close(); } catch (_) {}
      };
      const timer = setTimeout(() => fail(new Error('CONNECT_TIMEOUT')), CONNECT_TIMEOUT);

      let ws;
      try {
        ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 });
      } catch (e) {
        clearTimeout(timer);
        this.state = 'offline';
        return fail(e);
      }
      this.ws = ws;

      ws.on('open', () => { this.state = 'handshaking'; });

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.t === 'hello') {
          try {
            this.key = deriveKey(this.psk, Buffer.from(msg.salt, 'hex'));
            const auth = encryptJSON(this.key, {
              role: 'investigator',
              name: this.identity.name,
              badge: this.identity.badge,
              deviceId: this.identity.deviceId,
              unit: this.identity.unit,
              nonce: msg.nonce,
            });
            ws.send(JSON.stringify({ t: 'auth', ...auth }));
          } catch (e) { fail(e); }
          return;
        }

        if (msg.t === 'auth-ok') {
          try { this.session = decryptJSON(this.key, msg.iv, msg.data); } catch (_) {}
          this.state = 'connected';
          settled = true;
          clearTimeout(timer);
          this._flushWaiters(null, true);
          return;
        }

        if (msg.t === 'auth-fail') {
          clearTimeout(timer);
          return fail(new Error('AUTH_FAILED:' + (msg.reason || 'UNKNOWN')));
        }

        if (!this.key) return;

        if (msg.t === 'rpc-res') {
          let res;
          try { res = decryptJSON(this.key, msg.iv, msg.data); } catch { return; }
          const p = this.pending.get(res.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(res.id);
          if (res.ok) p.resolve(res.result);
          else p.reject(new Error(res.error || 'RPC_ERROR'));
          return;
        }

        if (msg.t === 'event') {
          let e;
          try { e = decryptJSON(this.key, msg.iv, msg.data); } catch { return; }
          broadcastToRenderer('supervisor-link:event', e);
          return;
        }
      });

      ws.on('error', () => { /* close handles state */ });

      ws.on('close', () => {
        this.key = null;
        this.session = null;
        const wasReady = this.state === 'connected';
        this.state = 'offline';
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('LAN_DISCONNECTED'));
        }
        this.pending.clear();
        if (!settled) fail(new Error('CLOSED_BEFORE_HANDSHAKE'));
        if (wasReady) broadcastToRenderer('supervisor-link:state', { state: 'offline' });
      });
    });
  }

  _flushWaiters(err, value) {
    const waiters = this._connectWaiters.splice(0);
    for (const w of waiters) {
      if (err) w.reject(err);
      else w.resolve(value);
    }
  }

  rpc(kind, payload) {
    if (!this.isReady()) return Promise.reject(new Error('LAN_OFFLINE'));
    const id = ++this.seq;
    const env = encryptJSON(this.key, { id, kind, payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('RPC_TIMEOUT'));
      }, RPC_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ t: 'rpc', ...env })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() {
    try { this.ws && this.ws.close(); } catch (_) {}
  }
}

// Ensure a live client matching the requested endpoint + identity.
async function ensureClient(opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const psk = opts.psk || DEFAULT_PSK;
  const identity = opts.identity || {};
  if (!identity.name || !identity.badge || !identity.deviceId) {
    throw new Error('IDENTITY_REQUIRED');
  }
  // Rebuild the client if endpoint or identity changed.
  if (client && (client.url !== url || client.psk !== psk || !client.sameIdentity(identity))) {
    client.close();
    client = null;
  }
  if (!client) client = new SupervisorLinkClient(url, psk, identity);
  await client.connect();
  return client;
}

function registerIpc(ipcMain) {
  ipcMain.handle('supervisor-link:status', async () => ({
    state: client ? client.state : 'idle',
    url: client ? client.url : DEFAULT_URL,
    session: client ? client.session : null,
  }));

  ipcMain.handle('supervisor-link:discover', async (_e, opts = {}) => {
    try {
      const c = await ensureClient(opts);
      const roster = await c.rpc('get:roster');
      return { ok: true, state: c.state, roster: roster || [] };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), roster: [] };
    }
  });

  ipcMain.handle('supervisor-link:push', async (_e, opts = {}) => {
    try {
      const c = await ensureClient(opts);
      const ack = await c.rpc('action:push', {
        to: opts.to,
        dtype: opts.dtype,
        manifest: opts.manifest || {},
        body: opts.body,
      });
      return { ok: true, ...ack };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  ipcMain.handle('supervisor-link:disconnect', async () => {
    if (client) { client.close(); client = null; }
    return { ok: true };
  });

  // Generate a one-page OPS-plan PDF (pdf-lib) for approval delivery.
  ipcMain.handle('supervisor-link:build-ops-pdf', async (_e, ops = {}) => {
    try {
      const pdfBase64 = await buildOpsPdf(ops);
      return { ok: true, pdfBase64 };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  console.log('[SupervisorLink] IPC registered (LAN node default:', DEFAULT_URL, ')');
}

// Compose a compact, readable operations-plan PDF from the supplied fields.
// Intentionally a SUMMARY artifact (no embedded photos/maps) so deliveries
// stay small; the full export pipeline can replace this later.
async function buildOpsPdf(ops) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  let page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = 54;
  const width = 612 - margin * 2;
  let y = 792 - margin;

  const ink = rgb(0.07, 0.09, 0.11);
  const dim = rgb(0.38, 0.42, 0.48);
  const accent = rgb(0, 0.47, 0.83);

  const wrap = (text, f, size, maxW) => {
    const words = String(text == null ? '' : text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };
  const ensure = (need) => {
    if (y - need < margin) { page = doc.addPage([612, 792]); y = 792 - margin; }
  };
  const text = (s, opts = {}) => {
    const f = opts.bold ? bold : font;
    const size = opts.size || 11;
    const color = opts.color || ink;
    for (const ln of wrap(s, f, size, opts.maxW || width)) {
      ensure(size + 5);
      page.drawText(ln, { x: margin + (opts.indent || 0), y, size, font: f, color });
      y -= size + 5;
    }
  };
  const gap = (n) => { y -= (n || 8); };
  const field = (label, value) => {
    ensure(28);
    page.drawText(label.toUpperCase(), { x: margin, y, size: 8, font: bold, color: dim });
    y -= 13;
    text(value || '—', { size: 11 });
    gap(4);
  };

  // Header band
  page.drawRectangle({ x: 0, y: 792 - 8, width: 612, height: 8, color: accent });
  text('OPERATIONS PLAN', { bold: true, size: 20 });
  text('V.I.P.E.R. — Submitted for Supervisor Approval', { size: 10, color: dim });
  gap(10);
  page.drawLine({ start: { x: margin, y }, end: { x: margin + width, y }, thickness: 1, color: rgb(0.85, 0.87, 0.9) });
  gap(14);

  field('Operation / Title', ops.title || ('Operations Plan ' + (ops.caseNumber || '')));
  field('Case Number', ops.caseNumber);
  field('Operation Date', ops.date);
  field('Risk Level', ops.risk);
  field('Location', ops.location);
  field('Requesting Investigator', ops.officer);
  gap(6);
  page.drawText('OPERATIONAL SUMMARY', { x: margin, y, size: 8, font: bold, color: dim });
  y -= 15;
  text(ops.summary || 'No summary provided.', { size: 11 });
  gap(20);

  ensure(60);
  page.drawLine({ start: { x: margin, y }, end: { x: margin + width, y }, thickness: 0.6, color: rgb(0.85, 0.87, 0.9) });
  gap(12);
  text('Supervisor Sign-Off', { bold: true, size: 11 });
  gap(2);
  text('Approved / Returned digitally via V.I.P.E.R. Supervisor Edition.', { size: 9, color: dim });
  gap(6);
  text('Generated ' + new Date().toLocaleString(), { size: 8, color: dim });

  const bytes = await doc.save();
  return Buffer.from(bytes).toString('base64');
}

module.exports = { registerIpc };
