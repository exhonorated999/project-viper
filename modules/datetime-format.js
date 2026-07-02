/**
 * VIPER Date/Time Formatting — single source of truth.
 *
 * Loaded early on every page (index.html, case-detail-with-analytics.html,
 * settings.html, report-popout.html) right after viper-prefs.js. Owns the
 * user's Date & Time display preferences (Settings → Date & Time) and
 * provides timezone-aware formatters used everywhere dates/times are shown.
 *
 * Why this exists: the app formatted dates ad-hoc with new Date(x).toLocale*
 * calls scattered across the codebase, so every display used the machine's
 * local timezone with no way to override it. Officers working cases across
 * timezones (or wanting a fixed evidentiary timezone) need one setting that
 * applies universally. Route ALL user-facing date/time rendering through
 * window.ViperDateTime.* so a single Settings control governs the whole app.
 *
 * Settings shape (localStorage key 'viperDateTimeSettings'):
 *   {
 *     timeZone: 'auto' | '<IANA zone>',   // 'auto' = machine/system zone
 *     hour12:   'auto' | true | false,    // 12h vs 24h clock; 'auto' = locale
 *   }
 *
 * Public API (window.ViperDateTime):
 *   getSettings()            -> {timeZone, hour12}
 *   setSettings(patch)       -> merges, persists, broadcasts 'change'
 *   resolvedTimeZone()       -> IANA string or undefined (system)
 *   label()                  -> short human label e.g. "America/New_York (24h)"
 *   formatDate(ts, opts?)    -> date string (default: MMM D, YYYY)
 *   formatTime(ts, opts?)    -> time string (default: h:mm AM/PM or 24h)
 *   formatDateTime(ts, opts?)-> date + time
 *   format(ts, kind, opts?)  -> kind: 'date'|'time'|'datetime'|'dateShort'|
 *                               'dateLong'|'monthDay'|'iso'
 *   onChange(cb)             -> subscribe to setting changes (returns unsubscribe)
 *   TIMEZONES                -> curated [{value,label}] list for the Settings dropdown
 *
 * All formatters accept a JS Date, epoch-ms number, or ISO string, and return
 * '' for null/invalid input (never throw).
 */
(function () {
  'use strict';

  var KEY = 'viperDateTimeSettings';

  var DEFAULTS = { timeZone: 'auto', hour12: 'auto' };

  // Curated timezone list for the Settings dropdown (common US zones first,
  // then a handful of others). 'auto' follows the machine clock.
  var TIMEZONES = [
    { value: 'auto',                label: 'Automatic (system timezone)' },
    { value: 'America/New_York',    label: 'Eastern Time — America/New_York' },
    { value: 'America/Chicago',     label: 'Central Time — America/Chicago' },
    { value: 'America/Denver',      label: 'Mountain Time — America/Denver' },
    { value: 'America/Phoenix',     label: 'Mountain (no DST) — America/Phoenix' },
    { value: 'America/Los_Angeles', label: 'Pacific Time — America/Los_Angeles' },
    { value: 'America/Anchorage',   label: 'Alaska Time — America/Anchorage' },
    { value: 'Pacific/Honolulu',    label: 'Hawaii Time — Pacific/Honolulu' },
    { value: 'America/Puerto_Rico', label: 'Atlantic Time — America/Puerto_Rico' },
    { value: 'UTC',                 label: 'UTC' },
    { value: 'Europe/London',       label: 'London — Europe/London' },
    { value: 'Europe/Paris',        label: 'Central Europe — Europe/Paris' },
  ];

  var _cache = null;   // parsed settings cache
  var _listeners = [];

  function _read() {
    if (_cache) return _cache;
    var s;
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { s = {}; }
    _cache = {
      timeZone: (s && typeof s.timeZone === 'string') ? s.timeZone : DEFAULTS.timeZone,
      hour12:   (s && (s.hour12 === true || s.hour12 === false)) ? s.hour12 : DEFAULTS.hour12,
    };
    return _cache;
  }

  function getSettings() {
    var s = _read();
    return { timeZone: s.timeZone, hour12: s.hour12 };
  }

  function setSettings(patch) {
    var cur = _read();
    var next = {
      timeZone: (patch && typeof patch.timeZone === 'string') ? patch.timeZone : cur.timeZone,
      hour12:   (patch && 'hour12' in patch) ? patch.hour12 : cur.hour12,
    };
    _cache = next;
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (_) {}
    _emit();
    return next;
  }

  function _emit() {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](getSettings()); } catch (_) {}
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    _listeners.push(cb);
    return function () {
      var i = _listeners.indexOf(cb);
      if (i >= 0) _listeners.splice(i, 1);
    };
  }

  // Cross-window propagation: settings.html is a separate BrowserWindow, so a
  // change there fires a 'storage' event in the other windows (same origin).
  window.addEventListener('storage', function (e) {
    if (e && e.key === KEY) { _cache = null; _emit(); }
  });

  function resolvedTimeZone() {
    var tz = _read().timeZone;
    return (!tz || tz === 'auto') ? undefined : tz;
  }

  function _hour12Opt() {
    var h = _read().hour12;
    return (h === true || h === false) ? h : undefined;   // undefined = locale default
  }

  function _toDate(ts) {
    if (ts == null || ts === '') return null;
    var d;
    if (ts instanceof Date) d = ts;
    else if (typeof ts === 'number') d = new Date(ts);
    else d = new Date(ts);           // ISO / parseable string
    return isNaN(d.getTime()) ? null : d;
  }

  // Build (and memoize) an Intl.DateTimeFormat for a given options object.
  // Key includes tz + hour12 so cache invalidates when settings change.
  var _fmtCache = {};
  function _fmt(optsBase) {
    var tz = resolvedTimeZone();
    var h12 = _hour12Opt();
    var opts = {};
    for (var k in optsBase) if (Object.prototype.hasOwnProperty.call(optsBase, k)) opts[k] = optsBase[k];
    if (tz) opts.timeZone = tz;
    if (h12 !== undefined && (('hour' in opts) || ('timeStyle' in opts))) opts.hour12 = h12;
    var key = JSON.stringify(opts);
    var f = _fmtCache[key];
    if (!f) {
      try { f = new Intl.DateTimeFormat(undefined, opts); }
      catch (_) {
        // Bad/unsupported timeZone → fall back to system zone.
        delete opts.timeZone;
        f = new Intl.DateTimeFormat(undefined, opts);
      }
      _fmtCache[key] = f;
    }
    return f;
  }

  // Clear the formatter cache whenever settings change.
  onChange(function () { _fmtCache = {}; });

  var DEFAULT_DATE = { year: 'numeric', month: 'short', day: 'numeric' };
  var DEFAULT_TIME = { hour: 'numeric', minute: '2-digit' };

  function formatDate(ts, opts) {
    var d = _toDate(ts); if (!d) return '';
    return _fmt(opts || DEFAULT_DATE).format(d);
  }
  function formatTime(ts, opts) {
    var d = _toDate(ts); if (!d) return '';
    return _fmt(opts || DEFAULT_TIME).format(d);
  }
  function formatDateTime(ts, opts) {
    var d = _toDate(ts); if (!d) return '';
    if (opts) return _fmt(opts).format(d);
    return formatDate(d) + ', ' + formatTime(d);
  }

  function format(ts, kind, opts) {
    switch (kind) {
      case 'time':      return formatTime(ts, opts);
      case 'datetime':  return formatDateTime(ts, opts);
      case 'dateShort': return formatDate(ts, opts || { year: '2-digit', month: 'numeric', day: 'numeric' });
      case 'dateLong':  return formatDate(ts, opts || { year: 'numeric', month: 'long', day: 'numeric' });
      case 'monthDay':  return formatDate(ts, opts || { month: 'short', day: 'numeric' });
      case 'iso': {
        var d = _toDate(ts); return d ? d.toISOString() : '';
      }
      case 'date':
      default:          return formatDate(ts, opts);
    }
  }

  function label() {
    var s = _read();
    var tz = (!s.timeZone || s.timeZone === 'auto')
      ? ('System (' + (Intl.DateTimeFormat().resolvedOptions().timeZone || 'local') + ')')
      : s.timeZone;
    var clock = (s.hour12 === true) ? '12h' : (s.hour12 === false) ? '24h' : 'locale';
    return tz + ' · ' + clock;
  }

  window.ViperDateTime = {
    KEY: KEY,
    TIMEZONES: TIMEZONES,
    getSettings: getSettings,
    setSettings: setSettings,
    resolvedTimeZone: resolvedTimeZone,
    label: label,
    formatDate: formatDate,
    formatTime: formatTime,
    formatDateTime: formatDateTime,
    format: format,
    onChange: onChange,
  };
})();
