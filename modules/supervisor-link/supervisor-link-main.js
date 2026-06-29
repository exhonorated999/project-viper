// modules/supervisor-link/supervisor-link-main.js
// ---------------------------------------------------------------------------
// Supervisor Link — investigator (Project V.I.P.E.R.) side of the push bridge.
//
// Lives in the Electron MAIN process. Opens a mutually-authenticated,
// forward-secret WebSocket session to the V.I.P.E.R. LAN node as role
// "investigator" (protocol v2), then:
//   • discovers the live roster of online supervisor machines
//   • pushes datasets (stats snapshot / case-status digest) and OPS plan PDFs
//   • forwards "decision" events (approve / return) back to the renderer
//
// Security (v2): this machine has a persistent ECDSA P-256 device key
// (userData). deviceId = key fingerprint. The node signs its ephemeral key
// with its static key; we PIN the node (TOFU) and refuse a changed node key.
// Session keys are derived via ephemeral ECDH (forward secrecy).
//
// Crypto + wire protocol MUST match the LAN node and supervisor app.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dgram = require('node:dgram');
const WebSocket = require('ws');
const { app, BrowserWindow } = require('electron');
const X = require('./supervisor-link-crypto');

const DEFAULT_URL = process.env.VIPER_SUPERVISOR_LAN_URL || 'ws://127.0.0.1:7071';
const DISCOVERY_PORT = Number(process.env.VIPER_SUPERVISOR_DISCOVERY_PORT) || 7071;
const DISCOVERY_MAGIC = 'VIPER_DISCOVER';
const RPC_TIMEOUT = 10000;
const CONNECT_TIMEOUT = 8000;

let client = null;       // active SupervisorLinkClient (one node at a time)
let store = null;        // persisted { deviceKey, pins:{url:nodeId} }

// ── persistent device key + node pins ──────────────────────────────────────
function storePath() {
  try { return path.join(app.getPath('userData'), 'supervisor-link-identity.json'); }
  catch { return path.join(__dirname, 'supervisor-link-identity.json'); }
}
function loadStore() {
  if (store) return store;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    store = JSON.parse(raw);
  } catch { store = null; }
  if (!store || !store.deviceKey || !store.deviceKey.publicJwk) {
    const kp = X.generateKeyPair();
    store = { deviceKey: kp, pins: {} };
    saveStore();
  }
  if (!store.pins) store.pins = {};
  return store;
}
function saveStore() {
  try { fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8'); } catch (_) {}
}
function deviceIdentity() {
  const s = loadStore();
  return {
    deviceId: X.deviceIdFromJwk(s.deviceKey.publicJwk, 'DEV'),
    publicJwk: s.deviceKey.publicJwk,
    privateJwk: s.deviceKey.privateJwk,
  };
}

function broadcastToRenderer(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send(channel, payload); } catch (_) {}
  }
}

class SupervisorLinkClient {
  constructor(url, identity) {
    this.url = url;
    this.identity = identity; // { name, badge, unit }
    this.ws = null;
    this.key = null;
    this.seq = 0;
    this.pending = new Map();
    this.state = 'idle';
    this.session = null;
    this.lastError = null;
    this._connectWaiters = [];
  }

  sameIdentity(identity) {
    return this.identity
      && this.identity.name === identity.name
      && this.identity.badge === identity.badge
      && this.identity.unit === identity.unit;
  }

  isReady() { return this.state === 'connected' && this.ws && this.ws.readyState === 1 && this.key; }

  connect() {
    if (this.isReady()) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      this._connectWaiters.push({ resolve, reject });
      if (this.state === 'connecting' || this.state === 'handshaking') return;
      this.state = 'connecting';

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.lastError = String(err && err.message || err);
        this._flushWaiters(err);
        try { this.ws && this.ws.close(); } catch (_) {}
      };
      const timer = setTimeout(() => fail(new Error('CONNECT_TIMEOUT')), CONNECT_TIMEOUT);

      let ws;
      try { ws = new WebSocket(this.url, { maxPayload: 64 * 1024 * 1024 }); }
      catch (e) { clearTimeout(timer); this.state = 'offline'; return fail(e); }
      this.ws = ws;

      ws.on('open', () => { this.state = 'handshaking'; });

      ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.t === 'hello') {
          try {
            // (a) verify node proof + pin the node key (TOFU).
            const nodeEphThumb = X.jwkThumbprint(msg.nodeEphJwk);
            const nodeOk = X.verifyUtf8(msg.nodePubJwk, X.nodeProofString(msg.challenge, nodeEphThumb), msg.nodeSig);
            const derivedNodeId = X.deviceIdFromJwk(msg.nodePubJwk, 'NODE');
            if (!nodeOk || derivedNodeId !== msg.nodeId) { clearTimeout(timer); return fail(new Error('NODE_PROOF_FAILED')); }
            const s = loadStore();
            const pinned = s.pins[this.url];
            if (pinned && pinned !== msg.nodeId) { clearTimeout(timer); return fail(new Error('NODE_PIN_MISMATCH')); }
            if (!pinned) { s.pins[this.url] = msg.nodeId; saveStore(); }

            // (b) device key + ephemeral ECDH key + transcript signature.
            const id = deviceIdentity();
            const eph = X.generateKeyPair();
            const clientEphThumb = X.jwkThumbprint(eph.publicJwk);
            const proof = X.deviceProofString(msg.challenge, nodeEphThumb, clientEphThumb, id.deviceId, 'investigator');
            const sig = X.signUtf8(id.privateJwk, proof);

            // (c) session key + encrypted identity.
            this.key = X.deriveSessionKey(eph.privateJwk, msg.nodeEphJwk, msg.challenge);
            const enc = X.encryptJSON(this.key, {
              name: this.identity.name, badge: this.identity.badge,
              unit: this.identity.unit, nonce: msg.challenge,
            });
            ws.send(JSON.stringify({
              t: 'auth', v: 2, role: 'investigator',
              deviceId: id.deviceId, devicePubJwk: id.publicJwk, clientEphJwk: eph.publicJwk, sig, enc,
            }));
          } catch (e) { clearTimeout(timer); fail(e); }
          return;
        }

        if (msg.t === 'auth-ok') {
          try { this.session = X.decryptJSON(this.key, msg.iv, msg.data); } catch (_) {}
          this.state = 'connected';
          settled = true;
          clearTimeout(timer);
          this._flushWaiters(null, true);
          return;
        }

        if (msg.t === 'auth-fail') { clearTimeout(timer); return fail(new Error('AUTH_FAILED:' + (msg.reason || 'UNKNOWN'))); }

        if (!this.key) return;

        if (msg.t === 'rpc-res') {
          let res; try { res = X.decryptJSON(this.key, msg.iv, msg.data); } catch { return; }
          const p = this.pending.get(res.id); if (!p) return;
          clearTimeout(p.timer); this.pending.delete(res.id);
          res.ok ? p.resolve(res.result) : p.reject(new Error(res.error || 'RPC_ERROR'));
          return;
        }

        if (msg.t === 'event') {
          let e; try { e = X.decryptJSON(this.key, msg.iv, msg.data); } catch { return; }
          broadcastToRenderer('supervisor-link:event', e);
          return;
        }
      });

      ws.on('error', () => { /* close handles state */ });

      ws.on('close', () => {
        this.key = null; this.session = null;
        const wasReady = this.state === 'connected';
        this.state = 'offline';
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('LAN_DISCONNECTED')); }
        this.pending.clear();
        if (!settled) fail(new Error('CLOSED_BEFORE_HANDSHAKE'));
        if (wasReady) broadcastToRenderer('supervisor-link:state', { state: 'offline' });
      });
    });
  }

  _flushWaiters(err, value) {
    const waiters = this._connectWaiters.splice(0);
    for (const w of waiters) { if (err) w.reject(err); else w.resolve(value); }
  }

  rpc(kind, payload) {
    if (!this.isReady()) return Promise.reject(new Error('LAN_OFFLINE'));
    const id = ++this.seq;
    const env = X.encryptJSON(this.key, { id, kind, payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('RPC_TIMEOUT')); }, RPC_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ t: 'rpc', ...env })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() { try { this.ws && this.ws.close(); } catch (_) {} }
}

// ── UDP discovery (find Supervisor nodes on the LAN) ────────────────────────
// Broadcasts a "VIPER_DISCOVER" datagram on every IPv4 interface's broadcast
// address (plus the limited-broadcast 255.255.255.255). Supervisor nodes reply
// with { magic:'VIPER_NODE', nodeId, wsPort, ... }; we map each reply's source
// IP to ws://<ip>:<wsPort>. Returns a de-duplicated list of discovered nodes.
function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      // Derive the subnet broadcast address: ip | ~netmask.
      try {
        const ip = ni.address.split('.').map(Number);
        const mask = (ni.netmask || '255.255.255.0').split('.').map(Number);
        const bc = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 0xff)).join('.');
        targets.add(bc);
      } catch (_) { /* skip */ }
    }
  }
  return [...targets];
}

function discoverNodes(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch (_) { return resolve([]); }
    const found = new Map(); // url -> node info
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { sock.close(); } catch (_) {}
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      try {
        const j = JSON.parse(msg.toString('utf8'));
        if (j && j.magic === 'VIPER_NODE' && j.wsPort) {
          const url = `ws://${rinfo.address}:${j.wsPort}`;
          found.set(url, {
            url, address: rinfo.address, wsPort: j.wsPort,
            nodeId: j.nodeId || null, serverId: j.serverId || null, name: j.name || null,
          });
        }
      } catch (_) { /* ignore malformed */ }
    });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (_) {}
      const payload = Buffer.from(DISCOVERY_MAGIC);
      const send = () => {
        for (const addr of broadcastTargets()) {
          try { sock.send(payload, DISCOVERY_PORT, addr); } catch (_) {}
        }
      };
      send();
      setTimeout(send, 250); // second probe for reliability
      setTimeout(finish, timeoutMs);
    });
  });
}

async function ensureClient(opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const identity = opts.identity || {};
  if (!identity.name || !identity.badge) throw new Error('IDENTITY_REQUIRED');
  if (client && (client.url !== url || !client.sameIdentity(identity))) { client.close(); client = null; }
  if (!client) client = new SupervisorLinkClient(url, identity);
  await client.connect();
  return client;
}

function registerIpc(ipcMain) {
  ipcMain.handle('supervisor-link:status', async (_e, opts = {}) => {
    const id = deviceIdentity();
    const s = loadStore();
    const url = opts.url || (client ? client.url : DEFAULT_URL);
    return {
      state: client ? client.state : 'idle',
      url,
      deviceId: id.deviceId,
      nodePin: s.pins[url] || null,
      session: client ? client.session : null,
      lastError: client ? client.lastError : null,
    };
  });

  // Broadcast-scan the LAN for Supervisor nodes (zero-config discovery).
  ipcMain.handle('supervisor-link:scan', async (_e, opts = {}) => {
    try {
      const nodes = await discoverNodes(opts.timeoutMs || 1500);
      return { ok: true, nodes };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), nodes: [] };
    }
  });

  ipcMain.handle('supervisor-link:discover', async (_e, opts = {}) => {
    try {
      // No explicit address (or auto requested) → discover one on the LAN.
      let url = (opts.url || '').trim();
      let discovered = [];
      if (!url || opts.auto) {
        discovered = await discoverNodes(opts.timeoutMs || 1500);
        if (discovered.length) url = discovered[0].url;
      }
      if (!url) url = DEFAULT_URL;
      const c = await ensureClient({ ...opts, url });
      const roster = await c.rpc('get:roster');
      return {
        ok: true, state: c.state, roster: roster || [], url,
        discovered, deviceId: deviceIdentity().deviceId,
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), roster: [] };
    }
  });

  ipcMain.handle('supervisor-link:push', async (_e, opts = {}) => {
    try {
      const c = await ensureClient(opts);
      const ack = await c.rpc('action:push', {
        to: opts.to, dtype: opts.dtype, manifest: opts.manifest || {}, body: opts.body,
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

  // Forget the pinned node key for the current/given URL (re-TOFU next time).
  ipcMain.handle('supervisor-link:reset-pin', async (_e, opts = {}) => {
    const s = loadStore();
    const url = opts.url || (client ? client.url : DEFAULT_URL);
    delete s.pins[url];
    saveStore();
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

  console.log('[SupervisorLink] IPC registered (node:', DEFAULT_URL, '· deviceId:', deviceIdentity().deviceId, ')');
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
  const ensure = (need) => { if (y - need < margin) { page = doc.addPage([612, 792]); y = 792 - margin; } };
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
