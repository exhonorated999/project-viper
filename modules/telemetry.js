/**
 * ViperTelemetry — demo-only product telemetry SDK (v3.8.4+)
 *
 * Pure renderer-side module. No Node APIs except what preload exposes.
 * All public methods are wrapped in try/catch — telemetry must never break the app.
 */
(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────────────── */
  var STORAGE_PREFIX = "viper_";
  var QUEUE_KEY      = STORAGE_PREFIX + "telemetry_queue";
  var SEQ_KEY        = STORAGE_PREFIX + "telemetry_seq";
  var INSTALL_KEY    = STORAGE_PREFIX + "install_id";
  var CONSENT_KEY    = STORAGE_PREFIX + "telemetry_consent";
  var REGISTERED_KEY = STORAGE_PREFIX + "registered_at";
  var MAX_QUEUE      = 200;
  var FLUSH_BATCH    = 50;
  var FLUSH_TIMEOUT  = 3000; // 3 s
  var MAX_PAYLOAD    = 65536; // 64 KB

  /* ── Canonical module name mapping ─────────────────────────────────── */
  // Internal tab IDs → canonical telemetry module names
  var TAB_ID_MAP = {
    overview:          "overview",
    evidence:          "evidence",
    suspects:          "suspects",
    victims:           "victims",
    victimBusiness:    "victim_businesses",
    cargo:             "cargo",
    witnesses:         "witnesses",
    involvedPersons:   "involved_persons",
    vehicles:          "recovered_vehicles",
    missingpersons:    "missing_persons",
    areacanvas:        "canvas",
    prosecution:       "prosecution",
    narcotics:         "narcotics",
    firearms:          "firearms",
    money:             "money_seized",
    opsplan:           "ops_plans",
    warrantAuthor:     "warrant_author",
    datapilot:         "datapilot",
    aperture:          "aperture",
    forensics:         "unknown",       // no canonical mapping
    warrants:          "unknown",       // warrants list, not warrant_author
    notes:             "unknown",
    reports:           "unknown",
    consentSearch:     "unknown",
    networkIntelligence: "unknown",
    analytics:         "unknown",
    traceImport:       "unknown",
    rmsImport:         "unknown",
    oversightImport:   "unknown",
    cyberTips:         "ncmec_reports",
    googleWarrant:     "unknown",
    metaWarrant:       "unknown",
    kikWarrant:        "unknown",
    snapchatWarrant:   "unknown",
    discordWarrant:    "unknown",
    cellebrite:        "unknown",
    settings:          "settings",
  };

  /* ── Allowed event names ───────────────────────────────────────────── */
  var ALLOWED_EVENTS = { app_open: 1, module_open: 1, session_end: 1 };

  /* ── Internal state ────────────────────────────────────────────────── */
  var _config    = null;
  var _sessionId = null;
  var _appVersion = "0.0.0";
  var _platform  = "unknown";
  var _initDone  = false;
  var _flushTimer = null;

  /* ── Helpers ───────────────────────────────────────────────────────── */

  /** Defensive localStorage JSON parse (mirrors _lsParse pattern). */
  function _lsParse(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      try {
        localStorage.removeItem(key);
      } catch (_) { /* quota / private mode */ }
      return fallback;
    }
  }

  function _lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  /** UUID v4 — use crypto.randomUUID() if available, else polyfill. */
  function _uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Polyfill
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /** Get or create install_id. */
  function _ensureInstallId() {
    var id = localStorage.getItem(INSTALL_KEY);
    if (id) return id;
    id = _uuid();
    try { localStorage.setItem(INSTALL_KEY, id); } catch (_) {}
    return id;
  }

  /** Compute demo_day_n (1-based, clamped 1..400). */
  function _demoDayN() {
    try {
      var regAt = localStorage.getItem(REGISTERED_KEY);
      if (!regAt) return 1;
      var ms = Date.now() - new Date(regAt).getTime();
      var day = Math.floor(ms / 86400000) + 1;
      return Math.max(1, Math.min(day, 400));
    } catch (_) { return 1; }
  }

  /** Get monotonic client_seq, persisted. */
  function _nextSeq() {
    var seq = _lsParse(SEQ_KEY, 0);
    if (typeof seq !== "number" || isNaN(seq)) seq = 0;
    seq += 1;
    _lsSet(SEQ_KEY, seq);
    return seq;
  }

  /** Normalize a tab ID to a canonical module name. */
  function _normalizeModule(tabId) {
    if (!tabId) return "unknown";
    return TAB_ID_MAP[tabId] || "unknown";
  }

  /** Detect platform. */
  function _detectPlatform() {
    try {
      if (_config && typeof _config.getPlatform === "function") {
        var p = _config.getPlatform();
        if (p && p !== "unknown") return p;
      }
    } catch (_) {}
    // Fallback from navigator
    var ua = (navigator && navigator.userAgent) || "";
    if (ua.indexOf("Win") !== -1) return "win32";
    if (ua.indexOf("Mac") !== -1) return "darwin";
    if (ua.indexOf("Linux") !== -1) return "linux";
    return "unknown";
  }

  /* ── Gating ────────────────────────────────────────────────────────── */
  function _isGated() {
    try {
      // 1) Must have consent
      if (localStorage.getItem(CONSENT_KEY) !== "granted") return true;

      // 2) Must have api_key (registered)
      var apiKey = _config && typeof _config.getApiKey === "function" ? _config.getApiKey() : null;
      if (!apiKey) return true;

      // 3) License status must be demo or demo_expired
      var status = "unknown";
      if (_config && typeof _config.getStatus === "function") {
        var ls = _config.getStatus();
        status = ls && ls.status ? ls.status : "unknown";
      }
      if (status !== "demo" && status !== "demo_expired") return true;

      return false;
    } catch (_) {
      return true; // gate closed on error
    }
  }

  /* ── Queue management ──────────────────────────────────────────────── */
  function _readQueue() {
    return _lsParse(QUEUE_KEY, []);
  }

  function _writeQueue(q) {
    // FIFO eviction if over cap
    if (q.length > MAX_QUEUE) {
      q = q.slice(q.length - MAX_QUEUE);
    }
    _lsSet(QUEUE_KEY, q);
  }

  function _enqueue(eventObj) {
    var q = _readQueue();
    q.push(eventObj);
    _writeQueue(q);
  }

  /* ── Flush ─────────────────────────────────────────────────────────── */
  function _flush() {
    if (_isGated()) return Promise.resolve();
    if (!_config || !_config.apiBase) return Promise.resolve();

    var q = _readQueue();
    if (q.length === 0) return Promise.resolve();

    var batch = q.slice(0, FLUSH_BATCH);
    var payload;
    try {
      payload = JSON.stringify({ events: batch });
    } catch (_) { return Promise.resolve(); }

    // Hard-cap payload at 64 KB
    if (payload.length > MAX_PAYLOAD) return Promise.resolve();

    var apiKey = "";
    try { apiKey = _config.getApiKey() || ""; } catch (_) {}

    var controller;
    try { controller = new AbortController(); } catch (_) { controller = null; }
    var signal = controller ? controller.signal : undefined;
    var timeoutId;
    if (controller) {
      timeoutId = setTimeout(function () { try { controller.abort(); } catch (_) {} }, FLUSH_TIMEOUT);
    }

    return fetch(_config.apiBase + "/api/telemetry/event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: payload,
      signal: signal,
    }).then(function (res) {
      if (timeoutId) clearTimeout(timeoutId);
      if (res.status === 204) {
        // Remove flushed events from queue
        var remaining = _readQueue();
        _writeQueue(remaining.slice(batch.length));
      }
      // Any other status — leave events in queue for next attempt
    }).catch(function () {
      if (timeoutId) clearTimeout(timeoutId);
      // Network error — leave events in queue
    });
  }

  /**
   * Unload-time flush via fetch({ keepalive: true }).
   * Chromium/Electron supports keepalive on fetch, which (unlike sendBeacon)
   * preserves custom headers like X-API-Key. Same security model as normal flush.
   * Payload is hard-capped at 64KB to satisfy keepalive's per-request limit.
   */
  function _flushBeacon() {
    if (_isGated()) return;
    if (!_config || !_config.apiBase) return;
    if (typeof fetch !== "function") return;

    var q = _readQueue();
    if (q.length === 0) return;

    var batch = q.slice(0, FLUSH_BATCH);
    var payload;
    try { payload = JSON.stringify({ events: batch }); } catch (_) { return; }
    if (payload.length > MAX_PAYLOAD) return;

    var apiKey = "";
    try { apiKey = _config.getApiKey() || ""; } catch (_) {}
    if (!apiKey) return;

    try {
      // Fire-and-forget; keepalive lets it complete after the page unloads.
      // We deliberately don't await — unload handlers must return fast.
      fetch(_config.apiBase + "/api/telemetry/event", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: payload,
        keepalive: true,
        // No AbortController on unload paths — browser owns the timeout.
      }).catch(function () { /* swallow */ });
      // Optimistically remove from queue. If the request ultimately fails
      // server-side, the events are lost — acceptable for session_end which
      // is best-effort engagement signal, not a billing event.
      var remaining = _readQueue();
      _writeQueue(remaining.slice(batch.length));
    } catch (_) { /* swallow */ }
  }

  /* ── Public API ────────────────────────────────────────────────────── */

  var ViperTelemetry = {
    /**
     * Initialize the telemetry SDK. Call once early in each renderer page.
     */
    init: function (config) {
      try {
        _config = config || {};
        _sessionId = _uuid();

        // Ensure install_id exists
        _ensureInstallId();

        // Resolve app version (async, fire-and-forget)
        if (_config.getAppVersion) {
          Promise.resolve(_config.getAppVersion()).then(function (v) {
            if (v) _appVersion = v;
          }).catch(function () {});
        }

        // Detect platform
        _platform = _detectPlatform();

        _initDone = true;

        // Opportunistic flush after 5s
        _flushTimer = setTimeout(function () {
          try { _flush(); } catch (_) {}
        }, 5000);
      } catch (_) {}
    },

    /**
     * Track an event. Synchronous — returns immediately.
     * @param {string} event  - one of "app_open", "module_open", "session_end"
     * @param {object} props  - optional extra properties
     */
    track: function (event, props) {
      try {
        if (!_initDone) return;
        if (_isGated()) return;

        // Validate event name
        if (!ALLOWED_EVENTS[event]) return;

        props = props || {};

        // Privacy guard: scrub keys starting with _
        var safeProps = {};
        for (var k in props) {
          if (!props.hasOwnProperty(k)) continue;
          if (k.charAt(0) === "_") continue;
          safeProps[k] = props[k];
        }

        var installId = localStorage.getItem(INSTALL_KEY) || _ensureInstallId();

        var eventObj = {
          install_id:      installId,
          session_id:      _sessionId,
          event:           event,
          app_version:     _appVersion,
          platform:        _platform,
          client_ts:       new Date().toISOString(),
          client_seq:      _nextSeq(),
          demo_day_n:      _demoDayN(),
          license_status:  (function () {
            try {
              var ls = _config && _config.getStatus ? _config.getStatus() : null;
              return ls && ls.status ? ls.status : "unknown";
            } catch (_) { return "unknown"; }
          })(),
        };

        // Merge safe props (module, duration_seconds)
        if (safeProps.module) eventObj.module = safeProps.module;
        if (typeof safeProps.duration_seconds === "number") eventObj.duration_seconds = safeProps.duration_seconds;

        _enqueue(eventObj);

        // Auto-flush if queue ≥ 5 or session_end
        var qLen = _readQueue().length;
        if (qLen >= 5 || event === "session_end") {
          if (event === "session_end") {
            _flushBeacon();
          } else {
            try { _flush(); } catch (_) {}
          }
        }
      } catch (_) {}
    },

    /** Convenience: app_open event. */
    appOpen: function () {
      try { ViperTelemetry.track("app_open"); } catch (_) {}
    },

    /** Convenience: module_open event. */
    moduleOpen: function (tabId) {
      try {
        var moduleKey = _normalizeModule(tabId);
        ViperTelemetry.track("module_open", { module: moduleKey });
      } catch (_) {}
    },

    /** Convenience: session_end event. Flushes via fetch keepalive on unload. */
    sessionEnd: function (durationSeconds) {
      try {
        ViperTelemetry.track("session_end", { duration_seconds: durationSeconds });
      } catch (_) {}
    },

    /** Async flush — fire-and-forget POST. */
    flush: function () {
      try { return _flush(); } catch (_) { return Promise.resolve(); }
    },

    /** Expose the tab ID normalizer for external use. */
    normalizeModule: _normalizeModule,

    /** Expose install_id for settings UI. */
    getInstallId: function () {
      try { return localStorage.getItem(INSTALL_KEY) || ""; } catch (_) { return ""; }
    },

    /** Clear the telemetry queue and sequence counter. */
    clearQueue: function () {
      try {
        localStorage.removeItem(QUEUE_KEY);
        localStorage.removeItem(SEQ_KEY);
      } catch (_) {}
    },

    /** Test connectivity to the telemetry backend. */
    testConnection: function () {
      if (!_config || !_config.apiBase) return Promise.reject(new Error("Not initialized"));
      var apiKey = "";
      try { apiKey = _config.getApiKey() || ""; } catch (_) {}

      var controller;
      try { controller = new AbortController(); } catch (_) { controller = null; }
      var signal = controller ? controller.signal : undefined;
      var timeoutId;
      if (controller) {
        timeoutId = setTimeout(function () { try { controller.abort(); } catch (_) {} }, FLUSH_TIMEOUT);
      }

      return fetch(_config.apiBase + "/api/telemetry/ping", {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        signal: signal,
      }).then(function (res) {
        if (timeoutId) clearTimeout(timeoutId);
        return { ok: res.ok, status: res.status };
      }).catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        return { ok: false, status: 0, error: (err && err.name) || "network_error" };
      });
    },
  };

  // Expose globally
  window.ViperTelemetry = ViperTelemetry;
})();
