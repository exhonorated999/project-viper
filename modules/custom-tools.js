/**
 * Custom Tools — "Bring Your Own Tool" for the Investigative Resources tray
 *
 * Lets an examiner register their own web resources (a county e-warrant
 * portal, a records-management system, a regional intel share) so they get
 * the same treatment as the built-in resources: an embedded tab in the
 * Investigative Resources drawer, credential auto-fill, capture-to-Evidence
 * and download routing.
 *
 * ── What lives where ────────────────────────────────────────────────
 *   METADATA (label, url, description, enabled, color) → localStorage
 *       key `viperCustomTools`.  Non-sensitive, and the tray needs it
 *       synchronously while building the tab bar.
 *
 *   CREDENTIALS → the MAIN process only, encrypted at rest with
 *       Electron safeStorage (DPAPI on Windows).  The renderer can save
 *       them and ask *whether* they exist, but can never read a password
 *       back.  This is deliberately stricter than the built-in resources,
 *       which round-trip their credentials through renderer localStorage
 *       in plaintext (see electron-main.js `_makeResourceBV`).
 *
 * This file is a UMD-ish module: it attaches `window.CustomTools` in a
 * renderer and also exports for Node so the validation logic is testable
 * headlessly.
 *
 * Include AFTER viper-ui.js and BEFORE resource-hub.js.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CustomTools = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : null), function () {
  'use strict';

  const STORE_KEY = 'viperCustomTools';

  /** Hard ceiling. The tray tab bar scrolls, but past this it is unusable
   *  and every tool costs a BrowserView + a session partition. */
  const MAX_TOOLS = 24;

  const MAX_LABEL = 40;
  const MAX_DESC = 400;

  /** Tab underline colors, assigned round-robin so custom tabs are
   *  visually distinguishable from each other in the tray. */
  const PALETTE = [
    '#38bdf8', '#a3e635', '#fb7185', '#c084fc', '#fbbf24',
    '#2dd4bf', '#f472b6', '#60a5fa', '#facc15', '#4ade80',
  ];

  /* ── Validation ─────────────────────────────────────────────── */

  /**
   * Only http(s) is allowed. This is the security boundary for the whole
   * feature: the URL is handed to BrowserView.loadURL in the main
   * process, so `file:`, `javascript:`, `data:` and friends must never
   * get through. Anything without an explicit scheme is assumed https.
   *
   * @returns {{ok:true, url:string}|{ok:false, error:string}}
   */
  function normalizeUrl(raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return { ok: false, error: 'Enter a website address.' };

    // A bare host ("portal.example.gov/warrants") is the common case when
    // someone copies out of an email, so default the scheme rather than
    // rejecting it.
    //
    // Care is needed: a naive /^[a-z][a-z0-9+.-]*:/ test reads the host in
    // `localhost:3000` or `rms.example.gov:8443` as a SCHEME, which broke
    // every agency running an internal tool on a port. So only treat the
    // input as already-schemed when either
    //   (a) it has an authority — `scheme://…`, or
    //   (b) it is `scheme:` NOT followed by a digit, which is what the
    //       dangerous authority-less schemes look like (`javascript:`,
    //       `data:`, `about:`, `mailto:`). Those fall through to the
    //       protocol check below and are rejected.
    const hasAuthority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
    const schemeNoPort = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(s);
    if (!hasAuthority && !schemeNoPort) s = 'https://' + s;

    let u;
    try { u = new URL(s); } catch (_) { return { ok: false, error: 'That does not look like a valid web address.' }; }

    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { ok: false, error: 'Only http:// and https:// addresses can be added.' };
    }
    if (!u.hostname || u.hostname.indexOf('.') === -1) {
      // Allow bare `localhost` for agencies running an internal tool, but
      // otherwise require something host-shaped.
      if (u.hostname !== 'localhost') return { ok: false, error: 'Enter a full hostname, e.g. portal.example.gov.' };
    }
    if (u.protocol === 'http:' && u.hostname !== 'localhost' && !/^127\./.test(u.hostname)) {
      // Not fatal — some county portals are still plain HTTP — but the
      // caller should warn, so flag it.
      return { ok: true, url: u.toString(), insecure: true };
    }
    return { ok: true, url: u.toString() };
  }

  function validate(tool, existing) {
    const errors = [];
    const label = String((tool && tool.label) || '').trim();
    if (!label) errors.push('Give the tool a name.');
    if (label.length > MAX_LABEL) errors.push('Name must be ' + MAX_LABEL + ' characters or fewer.');

    const u = normalizeUrl(tool && tool.url);
    if (!u.ok) errors.push(u.error);

    const desc = String((tool && tool.description) || '');
    if (desc.length > MAX_DESC) errors.push('Description must be ' + MAX_DESC + ' characters or fewer.');

    const list = Array.isArray(existing) ? existing : [];
    const dupe = list.some(t => t.id !== (tool && tool.id) &&
      String(t.label || '').trim().toLowerCase() === label.toLowerCase());
    if (dupe) errors.push('You already have a tool with that name.');

    return { ok: errors.length === 0, errors, url: u.ok ? u.url : null, insecure: !!u.insecure };
  }

  /* ── Identity ───────────────────────────────────────────────── */

  /**
   * Ids must be stable, filesystem/partition-safe and never collide with a
   * built-in resource id, because they are used to build the session
   * partition name (`persist:custom_<id>`) and DOM element ids
   * (`rhPanel_<id>`). Always prefixed so a custom tool can never shadow
   * `flock`, `tlo`, etc.
   */
  function makeId(existing) {
    const taken = new Set((Array.isArray(existing) ? existing : []).map(t => t.id));
    for (let i = 0; i < 10000; i++) {
      const id = 'ct_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      if (!taken.has(id)) return id;
    }
    throw new Error('Could not allocate a custom tool id');
  }

  function isCustomId(id) { return /^ct_[a-z0-9_]+$/i.test(String(id || '')); }

  /* ── Persistence ────────────────────────────────────────────── */

  function _ls() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (_) { return null; }
  }

  /**
   * Reads the stored list, dropping anything malformed rather than
   * throwing — a corrupt entry must never take the whole tray down.
   */
  function list() {
    const ls = _ls();
    if (!ls) return [];
    let raw;
    try { raw = ls.getItem(STORE_KEY); } catch (_) { return []; }
    if (!raw) return [];
    let arr;
    try { arr = JSON.parse(raw); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr.filter(t => t && isCustomId(t.id) && t.url).map((t, i) => ({
      id: t.id,
      label: String(t.label || 'Untitled tool').slice(0, MAX_LABEL),
      url: String(t.url),
      description: String(t.description || '').slice(0, MAX_DESC),
      enabled: t.enabled !== false,
      color: t.color || PALETTE[i % PALETTE.length],
      createdAt: t.createdAt || null,
    }));
  }

  function _write(arr) {
    const ls = _ls();
    if (!ls) return false;
    // Deliberately NOT wrapped in a silent catch: a QuotaExceededError
    // here means the user's change did not persist, and they must be told
    // rather than shown a tool that vanishes on reload.
    ls.setItem(STORE_KEY, JSON.stringify(arr));
    return true;
  }

  function get(id) { return list().find(t => t.id === id) || null; }

  function enabledTools() { return list().filter(t => t.enabled); }

  function add(input) {
    const existing = list();
    if (existing.length >= MAX_TOOLS) {
      return { ok: false, errors: ['You have reached the limit of ' + MAX_TOOLS + ' custom tools.'] };
    }
    const v = validate(input, existing);
    if (!v.ok) return { ok: false, errors: v.errors };

    const tool = {
      id: makeId(existing),
      label: String(input.label).trim(),
      url: v.url,
      description: String(input.description || '').trim(),
      enabled: input.enabled !== false,
      color: PALETTE[existing.length % PALETTE.length],
      createdAt: new Date().toISOString(),
    };
    _write(existing.concat([tool]));
    return { ok: true, tool, insecure: v.insecure };
  }

  function update(id, patch) {
    const existing = list();
    const idx = existing.findIndex(t => t.id === id);
    if (idx === -1) return { ok: false, errors: ['That tool no longer exists.'] };

    const merged = Object.assign({}, existing[idx], patch || {}, { id });
    const v = validate(merged, existing);
    if (!v.ok) return { ok: false, errors: v.errors };

    merged.label = String(merged.label).trim();
    merged.url = v.url;
    merged.description = String(merged.description || '').trim();
    merged.enabled = merged.enabled !== false;
    existing[idx] = merged;
    _write(existing);
    return { ok: true, tool: merged, insecure: v.insecure };
  }

  function setEnabled(id, on) { return update(id, { enabled: !!on }); }

  /**
   * Removing a tool must also drop its credentials and its BrowserView +
   * session partition, or a deleted portal would leave a logged-in session
   * and a stored password behind — unacceptable on a shared workstation.
   */
  async function remove(id) {
    const existing = list();
    const tool = existing.find(t => t.id === id);
    if (!tool) return { ok: false, errors: ['That tool no longer exists.'] };
    _write(existing.filter(t => t.id !== id));
    const api = (typeof window !== 'undefined' && window.electronAPI) || null;
    if (api && api.customToolForget) {
      try { await api.customToolForget(id); } catch (_) { /* metadata is already gone */ }
    }
    return { ok: true, tool };
  }

  /* ── Credentials (main-process backed) ──────────────────────── */

  function _api() {
    return (typeof window !== 'undefined' && window.electronAPI) || null;
  }

  /** @returns {Promise<{ok:boolean, error?:string}>} */
  async function saveCredentials(id, username, password) {
    const api = _api();
    if (!api || !api.customToolSaveCreds) return { ok: false, error: 'Credential storage is unavailable.' };
    if (!isCustomId(id)) return { ok: false, error: 'Unknown tool.' };
    try {
      // `null` is meaningful: keep the already-stored password. Anything
      // else is coerced to a string.
      const res = await api.customToolSaveCreds({
        id,
        username: String(username || ''),
        password: password === null ? null : String(password || ''),
      });
      return res && res.success ? { ok: true, encrypted: !!res.encrypted } : { ok: false, error: (res && res.error) || 'Could not save credentials.' };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /**
   * Returns only what the UI legitimately needs: whether credentials are
   * stored, the username (not secret — it is shown in the field), and
   * whether the store is actually encrypted. The password never crosses
   * back into the renderer.
   */
  async function credentialStatus(id) {
    const api = _api();
    if (!api || !api.customToolCredStatus) return { hasPassword: false, username: '', encrypted: false };
    try {
      const res = await api.customToolCredStatus(id);
      return {
        hasPassword: !!(res && res.hasPassword),
        username: (res && res.username) || '',
        encrypted: !!(res && res.encrypted),
        // Set when a sealed blob exists but could not be decrypted (a
        // different Windows user, or a rotated DPAPI key). The examiner
        // must be told to re-enter, not shown "no credentials saved".
        unreadable: !!(res && res.unreadable),
      };
    } catch (_) {
      return { hasPassword: false, username: '', encrypted: false, unreadable: false };
    }
  }

  async function clearCredentials(id) {
    const api = _api();
    if (!api || !api.customToolClearCreds) return { ok: false, error: 'Credential storage is unavailable.' };
    try {
      const res = await api.customToolClearCreds(id);
      return res && res.success ? { ok: true } : { ok: false, error: (res && res.error) || 'Could not clear credentials.' };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  /* ── Display helpers ────────────────────────────────────────── */

  /** Host for display. The port is kept when present — an agency tool on
   *  `rms.example.gov:8443` is a different thing from `rms.example.gov`,
   *  and dropping it makes the list ambiguous. */
  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') + (u.port ? ':' + u.port : '');
    } catch (_) { return String(url || ''); }
  }

  /** Two-letter monogram for the tray/settings avatar. */
  function initialsOf(label) {
    const parts = String(label || '').trim().split(/[\s\-_]+/).filter(Boolean);
    if (!parts.length) return '??';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  return {
    STORE_KEY, MAX_TOOLS, MAX_LABEL, MAX_DESC, PALETTE,
    normalizeUrl, validate, makeId, isCustomId,
    list, get, enabledTools, add, update, setEnabled, remove,
    saveCredentials, credentialStatus, clearCredentials,
    hostOf, initialsOf,
  };
});
