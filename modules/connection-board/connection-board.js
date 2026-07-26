/* ============================================================
   Case Connection Board  (VIPER)
   Digital red-string murder board: Map-first (Leaflet) + Web (D3)
   Shares the case-detail global scope (currentCase, _lsParse, viperToast, L, d3).
   Persists per case under connectionBoard_<caseId>.
   ============================================================ */
(function () {
  'use strict';

  // ---- module state ----
  var board = null;          // { pins:[], strings:[], notes:[], view:{} }
  var caseId = null;
  var map = null;            // Leaflet map
  var markers = {};          // pinId -> L.marker
  var polylines = {};        // stringId -> L.polyline
  var view = 'map';          // 'map' | 'web'
  var connectMode = false;
  var connectFrom = null;    // pinId awaiting second click
  var currentColor = '#ef4444';
  var selectedPinId = null;
  var geocodeCache = {};
  var webZoom = 1;           // web-board zoom factor (0.25–2), persisted per board

  var COLORS = ['#ef4444', '#f59e0b', '#eab308', '#22c55e', '#06b6d4',
                '#3b82f6', '#a855f7', '#ec4899', '#ffffff', '#9ca3af'];

  var TYPE_META = {
    scene:    { color: '#ef4444', glyph: '\uD83D\uDCCD', label: 'Scene' },
    person:   { color: '#3b82f6', glyph: '\uD83D\uDC64', label: 'Person' },
    suspect:  { color: '#f59e0b', glyph: '\uD83D\uDEA8', label: 'Suspect' },
    victim:   { color: '#22c55e', glyph: '\uD83C\uDD98', label: 'Victim' },
    witness:  { color: '#06b6d4', glyph: '\uD83D\uDC41', label: 'Witness' },
    missing:  { color: '#ec4899', glyph: '\uD83D\uDD0E', label: 'Missing' },
    vehicle:  { color: '#a855f7', glyph: '\uD83D\uDE97', label: 'Vehicle' },
    location: { color: '#22c55e', glyph: '\uD83D\uDCCD', label: 'Location' },
    plateHit: { color: '#06b6d4', glyph: '\uD83D\uDCF7', label: 'Plate Hit' },
    lpr:      { color: '#06b6d4', glyph: '\uD83D\uDCF7', label: 'LPR Hit' },
    cellData: { color: '#eab308', glyph: '\uD83D\uDCF6', label: 'Cell Data' },
    cellPing: { color: '#f97316', glyph: '\uD83D\uDCF1', label: 'Cell Ping' },
    associate:{ color: '#3b82f6', glyph: '\uD83C\uDFE0', label: 'Associate' },
    note:     { color: '#facc15', glyph: '\uD83D\uDCDD', label: 'Note' },
    image:    { color: '#38bdf8', glyph: '\uD83D\uDDBC', label: 'Image' },
    video:    { color: '#ef4444', glyph: '\uD83C\uDFA5', label: 'Video' },
    evidence: { color: '#14b8a6', glyph: '\uD83D\uDCE6', label: 'Evidence' },
    'case':   { color: '#9ca3af', glyph: '\uD83D\uDD17', label: 'Case' },
    custom:   { color: '#9ca3af', glyph: '\uD83D\uDCCC', label: 'Custom' }
  };

  // ---- small helpers ----
  function uid(p) { return (p || 'cb') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(m, t) { try { (window.viperToast || window.showToast || function(){})(m, t || 'info'); } catch (_) {} }

  // ---- in-drawer modal (Electron does NOT support window.prompt/confirm) ----
  function cbPrompt(title, defaultValue, placeholder) {
    return new Promise(function (resolve) {
      var host = document.getElementById('cbDrawer') || document.body;
      var back = document.createElement('div');
      back.className = 'cb-modal-back';
      back.innerHTML =
        '<div class="cb-modal">' +
          '<div class="cb-modal-title">' + esc(title) + '</div>' +
          '<input type="text" class="cb-modal-input" />' +
          '<div class="cb-modal-actions">' +
            '<button class="cb-btn" data-act="cancel">Cancel</button>' +
            '<button class="cb-btn cb-modal-ok" data-act="ok">OK</button>' +
          '</div>' +
        '</div>';
      host.appendChild(back);
      var input = back.querySelector('.cb-modal-input');
      input.value = defaultValue == null ? '' : defaultValue;
      if (placeholder) input.placeholder = placeholder;
      function done(val) { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener('keydown', onKey, true); resolve(val); }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(input.value); }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('click', function (e) { if (e.target === back) done(null); });
      back.querySelector('[data-act="cancel"]').onclick = function () { done(null); };
      back.querySelector('[data-act="ok"]').onclick = function () { done(input.value); };
      setTimeout(function () { input.focus(); input.select(); }, 30);
    });
  }

  // Prompt with an inline Delete button. Resolves: null = cancel,
  // { del: true } = delete requested, or a string = the edited value.
  function cbPromptDelete(title, defaultValue, placeholder) {
    return new Promise(function (resolve) {
      var host = document.getElementById('cbDrawer') || document.body;
      var back = document.createElement('div');
      back.className = 'cb-modal-back';
      back.innerHTML =
        '<div class="cb-modal">' +
          '<div class="cb-modal-title">' + esc(title) + '</div>' +
          '<input type="text" class="cb-modal-input" />' +
          '<div class="cb-modal-actions">' +
            '<button class="cb-btn cb-btn-danger" data-act="del">\uD83D\uDDD1 Delete</button>' +
            '<span style="flex:1"></span>' +
            '<button class="cb-btn" data-act="cancel">Cancel</button>' +
            '<button class="cb-btn cb-modal-ok" data-act="ok">OK</button>' +
          '</div>' +
        '</div>';
      host.appendChild(back);
      var input = back.querySelector('.cb-modal-input');
      input.value = defaultValue == null ? '' : defaultValue;
      if (placeholder) input.placeholder = placeholder;
      function done(val) { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener('keydown', onKey, true); resolve(val); }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(input.value); }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('click', function (e) { if (e.target === back) done(null); });
      back.querySelector('[data-act="cancel"]').onclick = function () { done(null); };
      back.querySelector('[data-act="del"]').onclick = function () { done({ del: true }); };
      back.querySelector('[data-act="ok"]').onclick = function () { done(input.value); };
      setTimeout(function () { input.focus(); input.select(); }, 30);
    });
  }

  function cbConfirm(title) {
    return new Promise(function (resolve) {
      var host = document.getElementById('cbDrawer') || document.body;
      var back = document.createElement('div');
      back.className = 'cb-modal-back';
      back.innerHTML =
        '<div class="cb-modal">' +
          '<div class="cb-modal-title">' + esc(title) + '</div>' +
          '<div class="cb-modal-actions">' +
            '<button class="cb-btn" data-act="cancel">Cancel</button>' +
            '<button class="cb-btn cb-btn-danger" data-act="ok">Confirm</button>' +
          '</div>' +
        '</div>';
      host.appendChild(back);
      function done(val) { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener('keydown', onKey, true); resolve(val); }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(false); }
        else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); }
      }
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('click', function (e) { if (e.target === back) done(false); });
      back.querySelector('[data-act="cancel"]').onclick = function () { done(false); };
      back.querySelector('[data-act="ok"]').onclick = function () { done(true); };
      setTimeout(function () { var b = back.querySelector('[data-act="ok"]'); if (b) b.focus(); }, 30);
    });
  }
  function lsParse(k, d) { try { return (typeof _lsParse === 'function') ? _lsParse(k, d) : (JSON.parse(localStorage.getItem(k)) || d); } catch (_) { return d; } }
  function typeColor(t) { return (TYPE_META[t] || TYPE_META.custom).color; }
  function typeGlyph(t) { return (TYPE_META[t] || TYPE_META.custom).glyph; }

  function haversineMi(a, b) {
    if (!a || !b) return null;
    var R = 3958.8, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function fullSuspectAddress(s) {
    return [s.address, s.addressCityStateZip].filter(Boolean).join(', ').trim();
  }

  // true only when the string has at least one letter/digit (not just ", ")
  function hasAddrText(a) { return /[a-z0-9]/i.test(a || ''); }

  // ---- evidence media helpers (inline image / video / audio in the card) ----
  function _mimeFromExt(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    var map = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp',
      webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff', tif: 'image/tiff', svg: 'image/svg+xml',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
      m4v: 'video/mp4', wmv: 'video/x-ms-wmv', flv: 'video/x-flv',
      mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wma: 'audio/x-ms-wma', ogg: 'audio/ogg'
    };
    return map[ext] || '';
  }
  function _mediaKind(mime) {
    if (!mime) return '';
    if (mime.indexOf('image/') === 0) return 'image';
    if (mime.indexOf('video/') === 0) return 'video';
    if (mime.indexOf('audio/') === 0) return 'audio';
    return '';
  }
  // Collect viewable (image/video/audio) files off an evidence record.
  function evidenceMedia(ev) {
    var out = [];
    var files = (ev && ev.files) || [];
    files.forEach(function (f) {
      if (!f || !f.path) return;
      var mime = f.type || _mimeFromExt(f.name);
      var kind = _mediaKind(mime);
      if (!kind) return;
      out.push({ path: f.path, name: f.name || '', mime: mime, kind: kind });
    });
    return out;
  }

  // ---- persistence ----
  function storeKey() { return 'connectionBoard_' + caseId; }
  function loadBoard() {
    board = lsParse(storeKey(), null);
    if (!board || typeof board !== 'object') board = { pins: [], strings: [], notes: [], view: { mode: 'map' } };
    board.pins = board.pins || [];
    board.strings = board.strings || [];
    // Strings are ONLY user-drawn (Connect mode sets manual:true). Purge any
    // legacy auto-generated strings ("resides at", "last seen", "owner of")
    // that older builds seeded, so the board never draws lines on its own.
    board.strings = board.strings.filter(function (s) { return s && s.manual === true; });
    // Strings are per-view (each belongs to the map OR the web canvas, not both).
    // Legacy strings predate the `view` tag; they were drawn on the web canvas, so
    // default them to 'web' — keeps them off the map, matching where they were made.
    board.strings.forEach(function (s) { if (!s.view) s.view = 'web'; });
    board.notes = board.notes || [];
    board.view = board.view || { mode: 'map' };
    board.openCards = board.openCards || [];
    webZoom = (board.view && board.view.webZoom) || 1;
  }
  function saveBoard() {
    try { localStorage.setItem(storeKey(), JSON.stringify(board)); } catch (e) { console.warn('[CB] save failed', e); }
  }

  function findPin(id) { for (var i = 0; i < board.pins.length; i++) if (board.pins[i].id === id) return board.pins[i]; return null; }
  function pinBySource(st, sid) {
    for (var i = 0; i < board.pins.length; i++) if (board.pins[i].sourceType === st && String(board.pins[i].sourceId) === String(sid)) return board.pins[i];
    return null;
  }

  // ---- geocoding (Nominatim; CSP-whitelisted) ----
  // Reuses the hardened global geocodeAddress() from the Missing Persons module
  // (429/HTTP handling + window._lastGeocodeError). Falls back to a direct
  // Nominatim fetch if that helper is not present. All requests funnel through a
  // single throttled queue so we honor Nominatim's ~1 req/sec usage policy even
  // when many pins are geocoded at once (avoids 429 rate-limiting).
  var GEOCODE_MIN_INTERVAL = 1100; // ms between Nominatim hits
  var _geocodeQueue = [];
  var _geocodeDraining = false;
  var _geocodeLastAt = 0;
  window._cbLastGeocodeError = null;

  function _runGeocodeQueue() {
    if (_geocodeDraining) return;
    _geocodeDraining = true;
    (function step() {
      if (!_geocodeQueue.length) { _geocodeDraining = false; return; }
      var wait = Math.max(0, GEOCODE_MIN_INTERVAL - (Date.now() - _geocodeLastAt));
      setTimeout(function () {
        var job = _geocodeQueue.shift();
        _geocodeLastAt = Date.now();
        job.run().then(function (res) { job.resolve(res); }, function () { job.resolve(null); })
          .then(step);
      }, wait);
    })();
  }

  function _enqueueGeocode(runner) {
    return new Promise(function (resolve) {
      _geocodeQueue.push({ run: runner, resolve: resolve });
      _runGeocodeQueue();
    });
  }

  // Normalize any geocode result to {lat, lng, display}
  function _normGeo(g) {
    if (!g) return null;
    var lat = parseFloat(g.lat);
    var lng = parseFloat(g.lng != null ? g.lng : g.lon);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat: lat, lng: lng, display: g.display_name || g.display || '' };
  }

  function _geocodeDirect(address) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (r.status === 429) { window._cbLastGeocodeError = 'Rate limited \u2014 wait a moment'; return null; }
        if (!r.ok) { window._cbLastGeocodeError = 'Lookup failed (HTTP ' + r.status + ')'; return null; }
        return r.json();
      })
      .then(function (j) {
        if (!j || !j.length) { window._cbLastGeocodeError = 'Address not found \u2014 try adding city/state'; return null; }
        return _normGeo({ lat: j[0].lat, lon: j[0].lon, display_name: j[0].display_name });
      })
      .catch(function () { window._cbLastGeocodeError = 'Network error \u2014 check connection'; return null; });
  }

  // Expand common US street-type abbreviations Nominatim sometimes misses.
  function _expandAbbrev(a) {
    return String(a)
      .replace(/\bCir\b\.?/gi, 'Circle')
      .replace(/\bSt\b\.?/gi, 'Street')
      .replace(/\bAve\b\.?/gi, 'Avenue')
      .replace(/\bRd\b\.?/gi, 'Road')
      .replace(/\bBlvd\b\.?/gi, 'Boulevard')
      .replace(/\bLn\b\.?/gi, 'Lane')
      .replace(/\bDr\b\.?/gi, 'Drive')
      .replace(/\bCt\b\.?/gi, 'Court')
      .replace(/\bPl\b\.?/gi, 'Place')
      .replace(/\bHwy\b\.?/gi, 'Highway')
      .replace(/\bPkwy\b\.?/gi, 'Parkway')
      .replace(/\bTer\b\.?/gi, 'Terrace')
      .replace(/\bTrl\b\.?/gi, 'Trail')
      .replace(/\bSq\b\.?/gi, 'Square')
      .replace(/\bXing\b\.?/gi, 'Crossing');
  }

  // Ordered geocode attempts, each flagged approx (coarser than the exact string):
  //   raw -> abbrev-expanded -> street+ZIP -> ZIP centroid (right town, drag to spot).
  // Street is cut at the street-type token so a misspelled/attached city
  // (e.g. "...Cir Canadigua, NY 14424") does not poison the street+ZIP query.
  function _streetPart(raw) {
    var m = raw.match(/^(.*?\b(?:cir|circle|st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|pl|place|way|hwy|highway|pkwy|parkway|ter|terrace|trl|trail|sq|square|xing|crossing|loop|run|path|pike|row|walk|cres|crescent|pt|point)\b\.?)/i);
    return m ? m[1].trim() : raw.split(',')[0].trim();
  }

  function _addressAttempts(address) {
    var raw = String(address).trim();
    var out = [];
    function add(q, approx) { if (q && !out.some(function (o) { return o.q === q; })) out.push({ q: q, approx: !!approx }); }
    add(raw, false);
    var exp = _expandAbbrev(raw); if (exp !== raw) add(exp, false);
    var zip = (raw.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1];
    var street = _streetPart(raw);
    if (zip && street) {
      var se = _expandAbbrev(street);
      add(se + ', ' + zip + ', USA', true);
      if (se !== street) add(street + ', ' + zip + ', USA', true);
    }
    if (zip) add(zip + ', USA', true); // coarse: ZIP centroid, right town
    return out;
  }

  // Run a single query string through the throttled queue.
  function _geocodeQuery(q) {
    return _enqueueGeocode(function () {
      window._cbLastGeocodeError = null;
      var p;
      // Prefer the shared, hardened helper from case-detail (Missing Persons schema)
      if (typeof window.geocodeAddress === 'function') {
        p = window.geocodeAddress(q).then(function (g) {
          if (!g && window._lastGeocodeError) window._cbLastGeocodeError = window._lastGeocodeError;
          return _normGeo(g);
        });
      } else {
        p = _geocodeDirect(q);
      }
      return p;
    });
  }

  function geocode(address) {
    if (!address) return Promise.resolve(null);
    if (geocodeCache[address]) return Promise.resolve(geocodeCache[address]);
    var attempts = _addressAttempts(address);
    return (function tryAt(i) {
      if (i >= attempts.length) return Promise.resolve(null);
      return _geocodeQuery(attempts[i].q).then(function (out) {
        if (out) {
          out.approx = attempts[i].approx; // looser/centroid match, not exact building
          geocodeCache[address] = out;
          return out;
        }
        return tryAt(i + 1);
      });
    })(0);
  }

  function reverseGeocode(lat, lng) {
    return _enqueueGeocode(function () {
      var url = 'https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng;
      return fetch(url, { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && j.display_name) ? j.display_name : null; })
        .catch(function () { return null; });
    });
  }

  // ---- pin creation / merge ----
  function upsertAutoPin(spec) {
    // spec: {type,label,sourceType,sourceId,photo,address,lat,lng,data}
    var existing = pinBySource(spec.sourceType, spec.sourceId);
    if (existing) {
      // refresh label/photo but keep manual position/color overrides
      if (!existing._labelOverride) existing.label = spec.label;
      if (spec.photo && !existing._photoOverride) existing.photo = spec.photo;
      // Keep the address text in sync with the live case record. Older builds
      // could save a punctuation-only placeholder (e.g. ", ") that is truthy but
      // meaningless; treat that as blank so a corrected address refreshes it.
      var _newAddr = (spec.address != null) ? String(spec.address).trim() : '';
      var _curAddr = (existing.address != null) ? String(existing.address).trim() : '';
      var _hasText = function (a) { return /[a-z0-9]/i.test(a || ''); };
      if (_newAddr && _newAddr !== _curAddr) {
        existing.address = spec.address;
        // Re-geocode from the corrected address unless the user hand-placed it.
        if (!existing._posManual && _hasText(_newAddr)) { existing.lat = null; existing.lng = null; existing.approx = false; }
      } else if (!_hasText(_curAddr) && _curAddr) {
        // Wipe a stale placeholder like ", " when the source has no address.
        existing.address = '';
      }
      return existing;
    }
    var pin = {
      id: uid('pin'), type: spec.type, label: spec.label || '(unnamed)',
      lat: spec.lat != null ? spec.lat : null, lng: spec.lng != null ? spec.lng : null,
      x: null, y: null,
      color: spec.color || typeColor(spec.type),
      photo: spec.photo || '', manual: false,
      sourceType: spec.sourceType || null, sourceId: spec.sourceId != null ? spec.sourceId : null,
      address: spec.address || '', data: spec.data || {}
    };
    board.pins.push(pin);
    return pin;
  }

  function ensureString(fromId, toId, label, color, style, viewName) {
    for (var i = 0; i < board.strings.length; i++) {
      var s = board.strings[i];
      if (viewName && s.view && s.view !== viewName) continue; // strings are per-view
      if ((s.from === fromId && s.to === toId) || (s.from === toId && s.to === fromId)) return s;
    }
    var str = { id: uid('str'), from: fromId, to: toId, label: label || '', color: color || '#9ca3af', style: style || 'solid', manual: false, view: viewName || 'map' };
    board.strings.push(str);
    return str;
  }

  // ---- always-on: sync the Scene pin from the overview Location of Occurrence ----
  // Runs on every open (not just first seed) so the incident location is always
  // imported when available, and updates if it was edited in the overview tab.
  function ensureScenePin() {
    if (!currentCase) return;
    var addr = String(currentCase.locationOfOccurrence || '').trim();
    if (!addr) return; // nothing to import
    var scene = pinBySource('scene', 'loc');
    if (!scene) {
      scene = upsertAutoPin({ type: 'scene', label: 'Scene of Occurrence', sourceType: 'scene', sourceId: 'loc', address: addr, data: { address: addr } });
    } else if (scene.address !== addr && !scene._posManual) {
      // location was changed in the overview -> refresh + re-geocode
      scene.address = addr;
      scene.lat = null; scene.lng = null; scene.approx = false;
    }
    if (scene.lat == null) {
      geocode(addr).then(function (g) { if (g) { scene.lat = g.lat; scene.lng = g.lng; scene.approx = !!g.approx; saveBoard(); scheduleRefresh(); } });
    }
    saveBoard();
  }

  // ---- build: minimal seed (suspect homes; scene handled by ensureScenePin) ----
  function seedMinimal() {
    if (!currentCase) return Promise.resolve();
    var jobs = [];

    // Suspect home addresses
    var suspectsArr = lsParse('suspects_' + currentCase.id, []);
    suspectsArr.forEach(function (s, idx) {
      var addr = fullSuspectAddress(s);
      var pin = upsertAutoPin({ type: 'suspect', label: s.name || ('Suspect ' + (idx + 1)), sourceType: 'suspect', sourceId: (s.id != null ? s.id : idx), photo: s.photo || '', address: addr, data: { name: s.name, dob: s.dob, id: s.id, sourceTab: 'suspects', sourceIndex: idx } });
      if (addr && pin.lat == null) {
        jobs.push(geocode(addr).then(function (g) {
          if (g) { pin.lat = g.lat; pin.lng = g.lng; pin.approx = !!g.approx; scheduleRefresh(); }
        }));
      }
    });

    return Promise.all(jobs).then(function () { saveBoard(); });
  }

  // ---- sync: reconcile board auto-pins with the live case data ----
  // Auto-imported pins carry a sourceType (suspect/victim/vehicle/...). Manual
  // assets have sourceType null and are never touched. This removes auto-pins
  // whose backing case record was deleted, and (via syncFromCase) re-imports new
  // records so the board tracks add/delete edits made in the case tabs.
  function _currentSourceKeys() {
    var cid = currentCase.id;
    var keys = {};
    function put(st, arr) { keys[st] = {}; (arr || []).forEach(function (o, idx) { keys[st][String(o.id != null ? o.id : idx)] = true; }); }
    var susp = lsParse('suspects_' + cid, []);
    put('suspect', susp);
    put('victim', lsParse('victims_' + cid, []));
    put('witness', lsParse('witnesses_' + cid, []));
    var mps = lsParse('missingpersons_' + cid, []);
    put('missing', mps);
    keys['lastseen'] = {};
    mps.forEach(function (p, idx) { if (p.lastSeenLocation) keys['lastseen'][String(p.id != null ? p.id : idx)] = true; });
    put('canvas', lsParse('areacanvas_' + cid, []));
    keys['vehicle'] = {};
    susp.forEach(function (s, sidx) { (s.vehicles || []).forEach(function (v, vidx) { keys['vehicle'][sidx + ':' + vidx] = true; }); });
    keys['evidence'] = {};
    try {
      var evAll = (lsParse('viperCaseEvidence', {}) || {})[currentCase.caseNumber] || [];
      evAll.forEach(function (ev, idx) { if (ev && ev.location && String(ev.location).trim()) keys['evidence'][String(ev.id != null ? ev.id : idx)] = true; });
    } catch (_) {}
    return keys;
  }

  function reconcileDeletions() {
    var keys = _currentSourceKeys();
    var removed = {};
    var kept = [];
    board.pins.forEach(function (pin) {
      // keep: user assets (no sourceType), scene (handled separately),
      // CaseLink-managed crosscase, and any sourceType we don't track here.
      if (!pin.sourceType || pin.sourceType === 'scene' || pin.sourceType === 'crosscase' || !(pin.sourceType in keys)) { kept.push(pin); return; }
      if (keys[pin.sourceType][String(pin.sourceId)]) { kept.push(pin); return; }
      removed[pin.id] = true;
    });
    var n = Object.keys(removed).length;
    if (n) {
      board.pins = kept;
      board.strings = board.strings.filter(function (s) { return !removed[s.from] && !removed[s.to]; });
      Object.keys(removed).forEach(function (id) {
        var wc = webCards[id]; if (wc && wc.parentNode) { wc.parentNode.removeChild(wc); }
        delete webCards[id];
        var dc = document.querySelector('#cbCards .cb-detail-card[data-pin="' + id + '"]');
        if (dc && dc.parentNode) dc.parentNode.removeChild(dc);
        if (selectedPinId === id) selectedPinId = null;
      });
    }
    return n;
  }

  // Which "Add from case data" imports already have pins on the board, so a sync
  // refreshes exactly the sources the user opted into (not every possible type).
  function _presentDataTypes() {
    var map = { victim: 'victims', witness: 'witnesses', missing: 'missing', lastseen: 'missing', vehicle: 'vehicles', canvas: 'canvas', evidence: 'evidence', crosscase: 'crosscase' };
    var types = {};
    board.pins.forEach(function (p) { if (p.sourceType && map[p.sourceType]) types[map[p.sourceType]] = true; });
    return Object.keys(types);
  }

  // Case-data sources that should ALWAYS auto-import/sync onto the board (like
  // suspects, which seedMinimal handles). Everyone the detective added as a
  // party — victims, witnesses, missing persons — plus located evidence pulls
  // in automatically. Vehicles/canvas/crosscase stay opt-in via "Add from case
  // data" and are refreshed only when already present (_presentDataTypes).
  var ALWAYS_IMPORT = ['victims', 'witnesses', 'missing', 'evidence'];

  function syncFromCase(silent) {
    if (!currentCase) return;
    var before = board.pins.length;
    var removedCount = reconcileDeletions();
    ensureScenePin();                 // keep the incident location current
    seedMinimal();                    // re-import suspects (idempotent upsert)
    ALWAYS_IMPORT.forEach(function (t) { addFromCaseData(t, true); }); // parties + located evidence
    _presentDataTypes().forEach(function (t) { if (ALWAYS_IMPORT.indexOf(t) === -1) addFromCaseData(t, true); });
    saveBoard();
    renderCurrentView();
    renderLocPanel();
    if (silent) return;
    var added = board.pins.length - (before - removedCount);
    var parts = [];
    if (added > 0) parts.push('added ' + added);
    if (removedCount > 0) parts.push('removed ' + removedCount);
    toast(parts.length ? ('Board synced \u2014 ' + parts.join(', ')) : 'Board already up to date', parts.length ? 'success' : 'info');
  }

  // ---- Add-from-case-data sources ----
  function addFromCaseData(type, quiet) {
    if (!currentCase) return;
    var added = 0;
    var jobs = [];
    var cid = currentCase.id, cnum = currentCase.caseNumber;

    function addPerson(arr, ptype, tab) {
      arr.forEach(function (p, idx) {
        var addr = [p.address, p.addressCityStateZip].filter(Boolean).join(', ');
        var pin = upsertAutoPin({ type: ptype, label: p.name || (TYPE_META[ptype].label + ' ' + (idx + 1)), sourceType: ptype, sourceId: (p.id != null ? p.id : idx), photo: p.photo || '', address: addr, data: { name: p.name, sourceTab: tab, sourceIndex: idx } });
        added++;
        if (addr && pin.lat == null) jobs.push(geocode(addr).then(function (g) { if (g) { pin.lat = g.lat; pin.lng = g.lng; scheduleRefresh(); } }));
      });
    }

    if (type === 'victims') addPerson(lsParse('victims_' + cid, []), 'victim', 'victims');
    else if (type === 'witnesses') addPerson(lsParse('witnesses_' + cid, []), 'witness', 'witnesses');
    else if (type === 'missing') {
      var mps = lsParse('missingpersons_' + cid, []);
      mps.forEach(function (p, idx) {
        var pPin = upsertAutoPin({ type: 'missing', label: p.name || ('Missing ' + (idx + 1)), sourceType: 'missing', sourceId: (p.id != null ? p.id : idx), photo: p.photo || '', data: { name: p.name, sourceTab: 'missingpersons', sourceIndex: idx } });
        added++;
        if (p.lastSeenLocation) {
          var lsPin = upsertAutoPin({ type: 'location', label: 'Last seen: ' + (p.name || ''), sourceType: 'lastseen', sourceId: (p.id != null ? p.id : idx), address: p.lastSeenLocation, data: { time: p.lastSeenTime } });
          jobs.push(geocode(p.lastSeenLocation).then(function (g) { if (g) { lsPin.lat = g.lat; lsPin.lng = g.lng; scheduleRefresh(); } }));
        }
      });
    }
    else if (type === 'vehicles') {
      var susp = lsParse('suspects_' + cid, []);
      susp.forEach(function (s, sidx) {
        (s.vehicles || []).forEach(function (v, vidx) {
          var plate = v.plateNumber || v.licensePlate || '';
          var vPin = upsertAutoPin({ type: 'vehicle', label: (v.makeModel || v.make || 'Vehicle') + (plate ? ' (' + plate + ')' : ''), sourceType: 'vehicle', sourceId: sidx + ':' + vidx, data: { plate: plate, state: v.plateState } });
          added++;
        });
      });
    }
    else if (type === 'canvas') {
      var canv = lsParse('areacanvas_' + cid, []);
      canv.forEach(function (c, idx) {
        if (!c.address) return;
        var cPin = upsertAutoPin({ type: 'location', label: c.address, sourceType: 'canvas', sourceId: (c.id != null ? c.id : idx), address: c.address, data: { contact: c.contact, notes: c.notes } });
        added++;
        jobs.push(geocode(c.address).then(function (g) { if (g) { cPin.lat = g.lat; cPin.lng = g.lng; scheduleRefresh(); } }));
      });
    }
    else if (type === 'evidence') {
      var evList = [];
      try { evList = (lsParse('viperCaseEvidence', {}) || {})[cnum] || []; } catch (_) { evList = []; }
      var evWithLoc = 0;
      evList.forEach(function (ev, idx) {
        var loc = (ev && ev.location ? String(ev.location) : '').trim();
        if (!loc) return;
        evWithLoc++;
        var lbl = ev.tag || (TYPE_META[ev.type] && TYPE_META[ev.type].label) || 'Evidence';
        var media = evidenceMedia(ev);
        var ePin = upsertAutoPin({
          type: 'evidence', label: lbl,
          sourceType: 'evidence', sourceId: (ev.id != null ? ev.id : idx),
          address: loc,
          data: { tag: ev.tag, evType: ev.type, notes: ev.description, sourceTab: 'evidence', sourceIndex: idx, media: media }
        });
        // upsert doesn't merge data onto existing pins — keep media/notes fresh.
        ePin.data = ePin.data || {};
        ePin.data.media = media; ePin.data.notes = ev.description; ePin.data.sourceTab = 'evidence';
        added++;
        if (ePin.lat == null) jobs.push(geocode(loc).then(function (g) { if (g) { ePin.lat = g.lat; ePin.lng = g.lng; ePin.approx = !!g.approx; scheduleRefresh(); } }));
      });
      if (!quiet && !evWithLoc) toast('No evidence has a "Location Obtained" address yet', 'info');
    }
    else if (type === 'crosscase') {
      try {
        if (window.CaseLink && typeof window.CaseLink.getRelatedCases === 'function') {
          var rel = window.CaseLink.getRelatedCases(cid) || [];
          rel.forEach(function (r) {
            var rp = upsertAutoPin({ type: 'case', label: 'Case ' + (r.caseNumber || r.id), sourceType: 'crosscase', sourceId: r.id, data: { shared: (r.sharedPersons || []).map(function (p) { return p.name; }) } });
            added++;
          });
        } else { toast('Case-link engine not loaded', 'warning'); }
      } catch (e) { console.warn('[CB] crosscase', e); }
    }

    Promise.all(jobs).then(function () {
      saveBoard();
      renderCurrentView();
      renderLocPanel();
      if (!quiet) toast(added ? ('Added ' + added + ' item(s) to the board') : 'Nothing new to add', added ? 'success' : 'info');
    });
  }

  // ============================================================
  //  DRAWER SHELL
  // ============================================================
  function buildDrawer() {
    if (document.getElementById('cbDrawer')) return;

    var backdrop = document.createElement('div');
    backdrop.id = 'cbBackdrop';
    backdrop.addEventListener('click', closeBoard);

    var drawer = document.createElement('div');
    drawer.id = 'cbDrawer';

    var swatches = COLORS.map(function (c, i) {
      return '<span class="cb-swatch' + (i === 0 ? ' active' : '') + '" data-color="' + c + '" style="background:' + c + '"></span>';
    }).join('');

    drawer.innerHTML =
      '<div class="cb-toolbar">' +
        '<div class="cb-title">\uD83E\uDDF5 Connection Board <span class="cb-sub" id="cbCaseLabel"></span></div>' +
        '<div class="cb-seg" id="cbViewSeg">' +
          '<button data-view="map" class="active">Map</button>' +
          '<button data-view="web">Web</button>' +
        '</div>' +
        '<button class="cb-btn" id="cbConnectBtn">\uD83D\uDD17 Connect</button>' +
        '<div class="cb-swatches" id="cbSwatches">' + swatches + '</div>' +
        '<button class="cb-btn" id="cbAddPinBtn">\uD83D\uDCCC Drop Pin</button>' +
        '<button class="cb-btn" id="cbAddAssetBtn">\u2795 Add Asset</button>' +
        '<div class="cb-seg" id="cbAddMenuWrap" style="position:relative;">' +
          '<button id="cbAddDataBtn">\u2795 Add from case data</button>' +
        '</div>' +
        '<button class="cb-btn" id="cbSyncBtn" title="Re-sync the board with the current case data (adds new suspects/assets, removes deleted ones)">\uD83D\uDD04 Sync</button>' +
        '<button class="cb-btn" id="cbExportBtn" title="Export this board as a single self-contained HTML file you can email or take to a briefing on a USB stick">\u2B07 Export</button>' +
        '<div class="cb-spacer"></div>' +
        '<button class="cb-btn cb-retract" id="cbRetractBtn">\u2B06 Retract</button>' +
      '</div>' +
      '<div class="cb-body">' +
        '<div class="cb-panel">' +
          '<div class="cb-panel-head"><span>LOCATIONS &amp; ASSETS</span><span id="cbPinCount"></span></div>' +
          '<div class="cb-panel-list" id="cbLocList"></div>' +
        '</div>' +
        '<div class="cb-stage-wrap">' +
          '<div id="cbMapStage"></div>' +
          '<div id="cbWebStage" class="cb-hidden"><div id="cbWebViewport"><div id="cbWebCanvas"><svg id="cbWebLines"></svg><div id="cbWebLabels"></div></div></div></div>' +
          '<div id="cbWebZoomCtl" class="cb-hidden">' +
            '<button id="cbZoomOut" title="Zoom out">\u2212</button>' +
            '<button id="cbZoomLevel" title="Reset to 100%">100%</button>' +
            '<button id="cbZoomIn" title="Zoom in">+</button>' +
            '<button id="cbZoomFit" title="Fit the whole board in view">Fit</button>' +
          '</div>' +
          '<div class="cb-connect-hint" id="cbConnectHint">Click a first pin, then a second pin to draw a string</div>' +
          '<div id="cbCards"></div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    // wire toolbar
    drawer.querySelector('#cbRetractBtn').addEventListener('click', closeBoard);
    drawer.querySelector('#cbViewSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]'); if (!b) return;
      setView(b.getAttribute('data-view'));
    });
    drawer.querySelector('#cbConnectBtn').addEventListener('click', toggleConnect);
    drawer.querySelector('#cbAddPinBtn').addEventListener('click', startDropPin);
    drawer.querySelector('#cbAddAssetBtn').addEventListener('click', openAssetForm);
    drawer.querySelector('#cbAddDataBtn').addEventListener('click', openAddMenu);
    drawer.querySelector('#cbSyncBtn').addEventListener('click', function () { syncFromCase(false); });
    drawer.querySelector('#cbExportBtn').addEventListener('click', exportBoard);
    drawer.querySelector('#cbZoomIn').addEventListener('click', function () { setWebZoom(webZoom * 1.2); });
    drawer.querySelector('#cbZoomOut').addEventListener('click', function () { setWebZoom(webZoom / 1.2); });
    drawer.querySelector('#cbZoomLevel').addEventListener('click', function () { setWebZoom(1); });
    drawer.querySelector('#cbZoomFit').addEventListener('click', fitWebZoom);
    drawer.querySelector('#cbSwatches').addEventListener('click', function (e) {
      var sw = e.target.closest('.cb-swatch'); if (!sw) return;
      currentColor = sw.getAttribute('data-color');
      drawer.querySelectorAll('.cb-swatch').forEach(function (x) { x.classList.remove('active'); });
      sw.classList.add('active');
    });

    // ---- drag assets from the LOCATIONS & ASSETS tray onto the Web board ----
    var webStage = drawer.querySelector('#cbWebStage');
    webStage.addEventListener('dragover', function (e) {
      if (view !== 'web') return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      webStage.classList.add('cb-dropok');
    });
    webStage.addEventListener('dragleave', function (e) {
      if (e.target === webStage) webStage.classList.remove('cb-dropok');
    });
    webStage.addEventListener('drop', function (e) {
      e.preventDefault();
      webStage.classList.remove('cb-dropok');
      var id = e.dataTransfer.getData('text/plain');
      var pin = findPin(id); if (!pin) return;
      var canvas = document.getElementById('cbWebCanvas');
      var rect = canvas.getBoundingClientRect();
      // place the card so the cursor lands near its top-center
      pin.x = Math.max(0, (e.clientX - rect.left) / webZoom - 100);
      pin.y = Math.max(0, (e.clientY - rect.top) / webZoom - 20);
      saveBoard();
      renderWeb();
      renderLocPanel();
    });

    // Ctrl + mouse wheel = zoom the web board (natural, like a design canvas).
    webStage.addEventListener('wheel', function (e) {
      if (!e.ctrlKey || view !== 'web') return;
      e.preventDefault();
      setWebZoom(webZoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    // Keep the board reactive: re-lay out cards/lines when the window resizes so
    // nothing gets stranded off-screen when the app window shrinks.
    var _rzTimer = null;
    window.addEventListener('resize', function () {
      if (!document.getElementById('cbDrawer')) return;
      if (_rzTimer) clearTimeout(_rzTimer);
      _rzTimer = setTimeout(function () {
        if (view === 'web') renderWeb(); else if (map) map.invalidateSize();
        clampDetailCards();
      }, 120);
    });
  }

  function openBoard() {
    if (typeof currentCase === 'undefined' || !currentCase) { toast('Open a case first', 'warning'); return; }
    buildDrawer();
    caseId = currentCase.id;
    loadBoard();

    document.getElementById('cbCaseLabel').textContent = 'Case ' + (currentCase.caseNumber || '');
    var bd = document.getElementById('cbBackdrop');
    var dw = document.getElementById('cbDrawer');
    // Force the browser to paint the closed (translateY(-102%)) state first, then
    // flip to open on the next frame so the CSS transition actually animates the
    // drawer sliding down (otherwise it snaps open with no motion).
    void dw.offsetHeight; // reflow
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        bd.classList.add('cb-open');
        dw.classList.add('cb-open');
      });
    });
    document.addEventListener('keydown', onEsc);

    var seedNeeded = board.pins.length === 0;
    // Render the board straight away so the map + any unplaced pins show
    // immediately; seedMinimal() geocodes in the background and pins pop in
    // progressively via scheduleRefresh().
    view = (board.view && board.view.mode) || 'map';
    setView(view, true);
    renderLocPanel();
    ensureScenePin();          // always import/refresh the incident location
    if (seedNeeded) { seedMinimal(); ALWAYS_IMPORT.forEach(function (t) { addFromCaseData(t, true); }); }
    else syncFromCase(true);   // reconcile add/deletes from the case tabs on reopen
    restoreOpenCards();        // re-open the detail cards the detective left up
  }

  function closeBoard() {
    var d = document.getElementById('cbDrawer'); if (!d) return;
    d.classList.remove('cb-open');
    document.getElementById('cbBackdrop').classList.remove('cb-open');
    document.removeEventListener('keydown', onEsc);
    hideCard();
    if (connectMode) toggleConnect();
  }

  function onEsc(e) { if (e.key === 'Escape') closeBoard(); }

  // ============================================================
  //  VIEW SWITCHING
  // ============================================================
  function setView(v, force) {
    if (v === view && !force) return;
    view = v;
    board.view.mode = v;
    saveBoard();
    document.querySelectorAll('#cbViewSeg button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === v); });
    document.getElementById('cbMapStage').classList.toggle('cb-hidden', v !== 'map');
    document.getElementById('cbWebStage').classList.toggle('cb-hidden', v !== 'web');
    var zc = document.getElementById('cbWebZoomCtl'); if (zc) zc.classList.toggle('cb-hidden', v !== 'web');
    hideCard();
    if (v === 'map') renderMap(); else renderWeb();
  }
  function renderCurrentView() { if (view === 'map') renderMap(); else renderWeb(); }

  // Debounced board refresh — used while geocode jobs resolve one-by-one so
  // pins pop onto the map/panel progressively instead of all at the end.
  var _refreshTimer = null;
  function scheduleRefresh() {
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      if (!document.getElementById('cbDrawer')) return;
      saveBoard();
      renderCurrentView();
      renderLocPanel();
    }, 200);
  }

  // ============================================================
  //  MAP VIEW (Leaflet)
  // ============================================================
  function initMap() {
    if (map) return;
    map = L.map('cbMapStage', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap &copy; CARTO'
    }).addTo(map);
    map.on('click', onMapClick);
  }

  function markerIcon(pin) {
    var inner = pin.photo
      ? '<img src="' + esc(pin.photo) + '" alt="">'
      : '<span class="cb-marker-glyph">' + typeGlyph(pin.type) + '</span>';
    var size = 44;
    var approxCls = pin.approx ? ' cb-marker-approx' : '';
    var approxBadge = pin.approx ? '<span class="cb-marker-approx-badge" title="Approximate \u2014 drag to the exact spot">~</span>' : '';
    return L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: '<div class="cb-marker' + approxCls + '" style="width:' + size + 'px;height:' + size + 'px;border-color:' + (pin.color || typeColor(pin.type)) + '">' + inner + approxBadge + '</div>'
    });
  }

  var dropPinArmed = false;
  function startDropPin() {
    if (view !== 'map') { toast('Switch to Map view to drop a location pin', 'info'); return; }
    dropPinArmed = true;
    toast('Click anywhere on the map to drop a pin', 'info');
    document.getElementById('cbMapStage').style.cursor = 'crosshair';
  }

  function onMapClick(e) {
    if (!dropPinArmed) return;
    dropPinArmed = false;
    document.getElementById('cbMapStage').style.cursor = '';
    openAssetForm(e.latlng);
  }

  function renderMap() {
    initMap();
    setTimeout(function () { if (map) map.invalidateSize(); }, 60);

    // clear old layers
    Object.keys(markers).forEach(function (k) { map.removeLayer(markers[k]); });
    Object.keys(polylines).forEach(function (k) { map.removeLayer(polylines[k]); });
    markers = {}; polylines = {};

    var placed = board.pins.filter(function (p) { return p.lat != null && p.lng != null; });

    // strings first (under markers) — only strings drawn in the MAP view
    board.strings.forEach(function (s) {
      if ((s.view || 'map') !== 'map') return;
      var a = findPin(s.from), b = findPin(s.to);
      if (!a || !b || a.lat == null || b.lat == null) return;
      var pl = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: s.color || '#9ca3af', weight: 3, opacity: 0.85,
        dashArray: s.style === 'dashed' ? '6,8' : null
      }).addTo(map);
      var mi = haversineMi(a, b);
      var lbl = (s.label || '') + (mi != null ? (s.label ? ' \u00B7 ' : '') + mi.toFixed(1) + ' mi' : '');
      // Wide, invisible hit-area so the thin line is easy to click/delete, and an
      // interactive tooltip so clicking the label opens the edit/delete modal too.
      var hit = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: '#000', weight: 16, opacity: 0, interactive: true
      }).addTo(map);
      if (lbl) hit.bindTooltip(lbl, { permanent: true, direction: 'center', className: 'cb-string-label', interactive: true });
      hit.on('click', function () { editString(s); });
      pl.on('click', function () { editString(s); });
      polylines[s.id] = pl;
      polylines[s.id + '_hit'] = hit;
    });

    // markers
    placed.forEach(function (pin) {
      var m = L.marker([pin.lat, pin.lng], { icon: markerIcon(pin), draggable: true }).addTo(map);
      m.on('click', function () { onPinActivate(pin, 'map'); });
      m.on('dragend', function (ev) { var ll = ev.target.getLatLng(); pin.lat = ll.lat; pin.lng = ll.lng; pin.approx = false; pin._posManual = true; saveBoard(); renderMap(); });
      markers[pin.id] = m;
    });

    // fit
    if (placed.length === 1) { map.setView([placed[0].lat, placed[0].lng], 14); }
    else if (placed.length > 1) {
      map.fitBounds(placed.map(function (p) { return [p.lat, p.lng]; }), { padding: [60, 60], maxZoom: 15 });
    } else if (!map._loaded) { map.setView([39.5, -98.35], 4); }

    var empty = document.querySelector('#cbMapStage .cb-empty');
    if (!placed.length) {
      if (!empty) {
        empty = document.createElement('div'); empty.className = 'cb-empty';
        empty.textContent = 'No placed pins yet. Use "Add from case data" or "Drop Pin".';
        document.getElementById('cbMapStage').appendChild(empty);
      }
    } else if (empty) empty.remove();
  }

  // ============================================================
  //  WEB VIEW = HTML "murder board" of info cards + SVG strings
  //  Assets render as draggable information cards (not bare pins).
  //  A card appears on the board once it has web coords (pin.x/pin.y);
  //  unplaced assets stay in the left tray and are dragged onto the board.
  // ============================================================
  var webCards = {};          // pinId -> card DOM element
  var SVGNS = 'http://www.w3.org/2000/svg';

  function webPlaced() {
    return board.pins.filter(function (p) { return p.x != null && p.y != null; });
  }

  function drawWebLines() {
    var svg = document.getElementById('cbWebLines'); if (!svg) return;
    var labels = document.getElementById('cbWebLabels');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (labels) labels.innerHTML = '';
    board.strings.forEach(function (s) {
      if ((s.view || 'map') !== 'web') return; // only strings drawn in the WEB view
      var a = webCards[s.from], b = webCards[s.to];
      if (!a || !b) return;
      var ax = a.offsetLeft + a.offsetWidth / 2, ay = a.offsetTop + a.offsetHeight / 2;
      var bx = b.offsetLeft + b.offsetWidth / 2, by = b.offsetTop + b.offsetHeight / 2;
      var line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', ax); line.setAttribute('y1', ay);
      line.setAttribute('x2', bx); line.setAttribute('y2', by);
      line.setAttribute('stroke', s.color || '#9ca3af');
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-opacity', '0.85');
      if (s.style === 'dashed') line.setAttribute('stroke-dasharray', '6,7');
      line.addEventListener('click', function () { editString(s); });
      svg.appendChild(line);
      var fromPin = findPin(s.from), toPin = findPin(s.to);
      var mi = (fromPin && toPin && fromPin.lat != null && toPin.lat != null) ? haversineMi(fromPin, toPin) : null;
      var lbl = (s.label || '') + (mi != null ? (s.label ? ' \u00B7 ' : '') + mi.toFixed(1) + ' mi' : '');
      // Labels are floating HTML pills ABOVE the cards (not SVG text behind them),
      // so long relationship notes are never clipped by an adjacent card. The pill
      // truncates with an ellipsis and expands to the full text on hover.
      if (lbl && labels) {
        var pill = document.createElement('div');
        pill.className = 'cb-web-linelabel-pill';
        pill.style.left = ((ax + bx) / 2) + 'px';
        pill.style.top = ((ay + by) / 2) + 'px';
        if (s.color) pill.style.borderColor = s.color;
        pill.textContent = lbl;
        pill.title = lbl;
        pill.addEventListener('click', function () { editString(s); });
        labels.appendChild(pill);
      }
    });
  }

  function webCardHtml(pin) {
    var meta = TYPE_META[pin.type] || TYPE_META.custom;
    var color = pin.color || meta.color;
    var img = pin.photo ? '<img class="cb-web-card-img" src="' + esc(pin.photo) + '">' : '';
    var rows = '';
    if (hasAddrText(pin.address)) rows += '<div class="cb-web-card-row"><span class="cb-k">\uD83D\uDCCD </span>' + esc(pin.address) + '</div>';
    if (pin.data && pin.data.plate) rows += '<div class="cb-web-card-row"><span class="cb-k">Plate: </span>' + esc(pin.data.plate) + '</div>';
    if (pin.data && pin.data.datetime) rows += '<div class="cb-web-card-row"><span class="cb-k">\uD83D\uDD52 </span>' + esc(pin.data.datetime) + '</div>';
    if (pin.data && pin.data.dob) rows += '<div class="cb-web-card-row"><span class="cb-k">DOB: </span>' + esc(pin.data.dob) + '</div>';
    var notes = (pin.data && pin.data.notes) ? '<div class="cb-web-card-notes">' + esc(pin.data.notes) + '</div>' : '';
    var video = pin.data && pin.data.video ? '<div class="cb-web-card-row"><span class="cb-k">\uD83C\uDFA5 </span>' + esc(pin.data.video.name || 'surveillance video') + '</div>' : '';
    var linkCount = board.strings.filter(function (s) { return s.from === pin.id || s.to === pin.id; }).length;
    var body = (rows || notes || video)
      ? '<div class="cb-web-card-body">' + rows + video + notes + '</div>'
      : '';
    return '' +
      '<span class="cb-web-card-unplace" title="Remove from board (keeps the asset)">\u21A9</span>' +
      '<div class="cb-web-card-head"><span class="cb-web-card-glyph">' + typeGlyph(pin.type) + '</span>' +
        '<span class="cb-web-card-title">' + esc(pin.label) + '</span></div>' +
      '<div class="cb-web-card-type">' + esc(meta.label) + '</div>' +
      img + body +
      '<div class="cb-web-card-foot">\uD83D\uDD17 ' + linkCount + ' connection' + (linkCount === 1 ? '' : 's') + '</div>';
  }

  function makeCardDraggable(el, pin) {
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('.cb-web-card-unplace')) return;
      var sx = e.clientX, sy = e.clientY, ox = pin.x || 0, oy = pin.y || 0, moved = false;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      el.classList.add('cb-dragging');
      function move(ev) {
        var dx = (ev.clientX - sx) / webZoom, dy = (ev.clientY - sy) / webZoom;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        pin.x = Math.max(0, ox + dx); pin.y = Math.max(0, oy + dy);
        el.style.left = pin.x + 'px'; el.style.top = pin.y + 'px';
        drawWebLines();
      }
      function up() {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.classList.remove('cb-dragging');
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
        if (moved) { saveBoard(); }
        else { onPinActivate(pin, 'web'); }
      }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  function renderWeb() {
    var canvas = document.getElementById('cbWebCanvas');
    if (!canvas) return;
    // wipe old cards (keep the SVG line layer)
    Object.keys(webCards).forEach(function (k) { var el = webCards[k]; if (el && el.parentNode) el.parentNode.removeChild(el); });
    webCards = {};
    var oldEmpty = canvas.querySelector('.cb-web-empty'); if (oldEmpty) oldEmpty.remove();

    var placed = webPlaced();
    var stage = document.getElementById('cbWebStage');

    if (!placed.length) {
      var svg = document.getElementById('cbWebLines'); if (svg) { while (svg.firstChild) svg.removeChild(svg.firstChild); }
      var lbls = document.getElementById('cbWebLabels'); if (lbls) lbls.innerHTML = '';
      canvas.style.width = '100%'; canvas.style.height = '100%';
      canvas.style.transform = '';
      var vp0 = document.getElementById('cbWebViewport'); if (vp0) { vp0.style.width = '100%'; vp0.style.height = '100%'; }
      var empty = document.createElement('div');
      empty.className = 'cb-web-empty';
      empty.innerHTML = '<div class="cb-web-empty-big">\uD83E\uDDF5</div>' +
        '<div>Drag assets from the left panel onto the board</div>' +
        '<div style="font-size:0.78rem;color:#556">Add them with "Add Asset" or "Add from case data", then drop them here to build the web.</div>';
      canvas.appendChild(empty);
      return;
    }

    var maxX = 0, maxY = 0;
    placed.forEach(function (pin) {
      var meta = TYPE_META[pin.type] || TYPE_META.custom;
      var el = document.createElement('div');
      el.className = 'cb-web-card';
      el.style.left = pin.x + 'px';
      el.style.top = pin.y + 'px';
      el.style.borderTopColor = pin.color || meta.color;
      el.innerHTML = webCardHtml(pin);
      canvas.appendChild(el);
      webCards[pin.id] = el;
      makeCardDraggable(el, pin);
      var unp = el.querySelector('.cb-web-card-unplace');
      if (unp) unp.addEventListener('click', function (ev) {
        ev.stopPropagation();
        pin.x = null; pin.y = null; saveBoard(); renderWeb(); renderLocPanel();
      });
      maxX = Math.max(maxX, pin.x + 260);
      maxY = Math.max(maxY, pin.y + 260);
    });

    // grow the canvas so cards near the edges stay reachable / scrollable.
    // Minimum is the stage size in *content* coords (stage / zoom) so a zoomed-
    // out board still fills the view instead of leaving dead space.
    var minW = (stage ? stage.clientWidth : 0) / webZoom;
    var minH = (stage ? stage.clientHeight : 0) / webZoom;
    canvas.style.width = Math.max(minW, maxX + 40) + 'px';
    canvas.style.height = Math.max(minH, maxY + 40) + 'px';
    canvas.classList.toggle('cb-connecting', connectMode);

    drawWebLines();
    applyWebZoom();
  }

  // ---- Web-board zoom / pan ----
  // The canvas holds cards in unscaled "content" coordinates; a CSS transform
  // scales what you see, and a viewport sizer gives the scroll container the
  // scaled dimensions so every card stays reachable at any zoom level.
  function applyWebZoom() {
    var canvas = document.getElementById('cbWebCanvas');
    var vp = document.getElementById('cbWebViewport');
    if (!canvas || !vp) return;
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = 'scale(' + webZoom + ')';
    var cw = parseFloat(canvas.style.width) || canvas.offsetWidth;
    var ch = parseFloat(canvas.style.height) || canvas.offsetHeight;
    vp.style.width = (cw * webZoom) + 'px';
    vp.style.height = (ch * webZoom) + 'px';
    var lvl = document.getElementById('cbZoomLevel');
    if (lvl) lvl.textContent = Math.round(webZoom * 100) + '%';
  }

  function setWebZoom(z) {
    z = Math.max(0.25, Math.min(2, z));
    webZoom = Math.round(z * 100) / 100;
    if (board && board.view) { board.view.webZoom = webZoom; saveBoard(); }
    renderWeb(); // re-layout so line/label positions and canvas size track the zoom
  }

  function fitWebZoom() {
    var stage = document.getElementById('cbWebStage');
    var canvas = document.getElementById('cbWebCanvas');
    if (!stage || !canvas) return;
    // measure raw content extent from the placed pins (independent of current zoom)
    var maxX = 0, maxY = 0, any = false;
    board.pins.forEach(function (p) { if (p.x != null && p.y != null) { any = true; maxX = Math.max(maxX, p.x + 254); maxY = Math.max(maxY, p.y + 220); } });
    if (!any) { setWebZoom(1); return; }
    var z = Math.min(stage.clientWidth / (maxX + 40), stage.clientHeight / (maxY + 40), 1);
    setWebZoom(z);
    stage.scrollLeft = 0; stage.scrollTop = 0;
  }

  // Keep floating detail cards from getting stranded off-screen when the window
  // shrinks — nudge each back inside the current stage bounds.
  function clampDetailCards() {
    var stage = document.querySelector('.cb-stage-wrap'); if (!stage) return;
    var W = stage.clientWidth, H = stage.clientHeight;
    document.querySelectorAll('#cbCards .cb-detail-card').forEach(function (el) {
      var l = el.offsetLeft, t = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
      var nl = Math.max(0, Math.min(l, W - Math.min(w, W)));
      var nt = Math.max(0, Math.min(t, H - Math.min(h, H)));
      if (nl !== l) { el.style.left = nl + 'px'; el.style.right = 'auto'; }
      if (nt !== t) { el.style.top = nt + 'px'; }
    });
    persistOpenCards();
  }

  // ============================================================
  //  CONNECT MODE + STRINGS
  // ============================================================
  function toggleConnect() {
    connectMode = !connectMode;
    connectFrom = null;
    document.getElementById('cbConnectBtn').classList.toggle('cb-btn-active', connectMode);
    document.getElementById('cbSwatches').classList.toggle('cb-show', connectMode);
    document.getElementById('cbConnectHint').classList.toggle('cb-show', connectMode);
    var canvas = document.getElementById('cbWebCanvas');
    if (canvas) {
      canvas.classList.toggle('cb-connecting', connectMode);
      canvas.querySelectorAll('.cb-web-card.cb-connect-src').forEach(function (el) { el.classList.remove('cb-connect-src'); });
    }
  }

  function onPinActivate(pin, from) {
    if (connectMode) {
      if (!connectFrom) {
        connectFrom = pin.id;
        if (webCards[pin.id]) webCards[pin.id].classList.add('cb-connect-src');
        toast('First pin selected \u2014 click a second pin', 'info');
      } else if (connectFrom !== pin.id) {
        var fromId = connectFrom;
        connectFrom = null;
        if (webCards[fromId]) webCards[fromId].classList.remove('cb-connect-src');
        cbPrompt('Relationship label (optional)', '', 'e.g. resides at, seen with, owns').then(function (label) {
          if (label === null) return;
          var s = ensureString(fromId, pin.id, label, currentColor, 'solid', from);
          s.manual = true; s.color = currentColor; s.view = from; if (label) s.label = label;
          saveBoard(); renderCurrentView(); renderLocPanel();
        });
      }
      return;
    }
    openCard(pin, from);
  }

  function editString(s) {
    cbPromptDelete('Edit string label', s.label || '', 'e.g. resides at, seen with, owns').then(function (choice) {
      if (choice === null) return;
      if (choice && choice.del) {
        board.strings = board.strings.filter(function (x) { return x.id !== s.id; });
      } else { s.label = choice; }
      saveBoard(); renderCurrentView();
    });
  }

  // ============================================================
  //  DETAIL CARDS (multiple, draggable, individually closable)
  //  Selecting a pin opens a floating card; opening more stacks them
  //  tiled across the stage. Each stays until its own X is clicked.
  // ============================================================
  var _cardZ = 860;
  function raiseCard(el) { el.style.zIndex = (++_cardZ); }

  function positionDetailCard(el, from) {
    var stage = document.querySelector('.cb-stage-wrap');
    var W = (stage ? stage.clientWidth : 1000), H = (stage ? stage.clientHeight : 600);
    var cardW = 300, gap = 14, rowH = 250;
    var idx = document.querySelectorAll('#cbCards .cb-detail-card').length - 1; // this card already appended
    if (idx < 0) idx = 0;
    var cols = Math.max(1, Math.floor((W - gap) / (cardW + gap)));
    var col = idx % cols, row = Math.floor(idx / cols);
    // tile from the right edge leftward, top-down (keeps map zoom ctrl clear)
    var left = W - gap - cardW - col * (cardW + gap);
    var top = gap + row * (rowH + gap);
    if (left < gap) left = gap + (idx % 5) * 18;      // ran out of columns -> gentle cascade
    if (top > H - 120) top = gap + (idx % 6) * 24;
    el.style.left = Math.max(0, left) + 'px';
    el.style.top = Math.max(0, top) + 'px';
    el.style.right = 'auto';
  }

  function makeDetailDraggable(el) {
    var head = el.querySelector('.cb-card-head'); if (!head) return;
    head.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target.closest('.cb-card-close')) return;
      var sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
      raiseCard(el); el.classList.add('cb-dragging');
      function move(ev) { el.style.left = Math.max(0, ox + ev.clientX - sx) + 'px'; el.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; el.style.right = 'auto'; }
      function up() { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); el.classList.remove('cb-dragging'); try { head.releasePointerCapture(e.pointerId); } catch (_) {} persistOpenCards(); }
      head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
    });
  }

  // Window-style resize: 8 handles (edges + corners). Adjusts width/height and,
  // for the top/left edges, repositions the card so the opposite edge stays put.
  function makeDetailResizable(el) {
    var dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    dirs.forEach(function (d) {
      var h = document.createElement('div');
      h.className = 'cb-resize cb-resize-' + d;
      el.appendChild(h);
      h.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        raiseCard(el);
        var startX = e.clientX, startY = e.clientY;
        var startW = el.offsetWidth, startH = el.offsetHeight;
        var startL = el.offsetLeft, startT = el.offsetTop;
        var minW = 240, minH = 160;
        el.classList.add('cb-sized');
        try { h.setPointerCapture(e.pointerId); } catch (_) {}
        function move(ev) {
          var dx = ev.clientX - startX, dy = ev.clientY - startY;
          var w = startW, hh = startH, l = startL, t = startT;
          if (d.indexOf('e') > -1) { w = Math.max(minW, startW + dx); }
          if (d.indexOf('s') > -1) { hh = Math.max(minH, startH + dy); }
          if (d.indexOf('w') > -1) { w = Math.max(minW, startW - dx); l = startL + (startW - w); }
          if (d.indexOf('n') > -1) { hh = Math.max(minH, startH - dy); t = startT + (startH - hh); }
          el.style.width = w + 'px';
          el.style.height = hh + 'px';
          el.style.left = Math.max(0, l) + 'px';
          el.style.top = Math.max(0, t) + 'px';
          el.style.right = 'auto';
        }
        function up() {
          h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up);
          try { h.releasePointerCapture(e.pointerId); } catch (_) {}
          persistOpenCards();
        }
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
      });
    });
  }

  // ---- open-card persistence ----
  // The floating detail cards a detective has pulled up are part of his working
  // state, so we remember which pins are open plus each card's position/size/
  // z-order under board.openCards and restore them when the board reopens (even
  // after leaving the case). Called after every open/close/drag/resize.
  function persistOpenCards() {
    if (!board) return;
    var cont = document.getElementById('cbCards');
    var list = [];
    if (cont) {
      cont.querySelectorAll('.cb-detail-card').forEach(function (el) {
        var sized = el.classList.contains('cb-sized');
        list.push({
          pinId: el.getAttribute('data-pin'),
          left: el.style.left || '', top: el.style.top || '',
          width: sized ? (el.style.width || '') : '', height: sized ? (el.style.height || '') : '',
          sized: sized, z: el.style.zIndex || ''
        });
      });
    }
    board.openCards = list;
    saveBoard();
  }

  function restoreOpenCards() {
    var cont = document.getElementById('cbCards'); if (!cont) return;
    cont.innerHTML = '';
    var list = (board && board.openCards) || [];
    list.forEach(function (st) {
      var pin = findPin(st.pinId); if (!pin) return; // skip cards for deleted pins
      var el = document.createElement('div');
      el.className = 'cb-detail-card';
      el.setAttribute('data-pin', pin.id);
      cont.appendChild(el);
      if (st.left) el.style.left = st.left;
      if (st.top) el.style.top = st.top;
      el.style.right = 'auto';
      if (st.sized) { el.classList.add('cb-sized'); if (st.width) el.style.width = st.width; if (st.height) el.style.height = st.height; }
      if (st.z) { el.style.zIndex = st.z; var zn = parseInt(st.z, 10); if (!isNaN(zn) && zn > _cardZ) _cardZ = zn; }
      renderDetailInner(el, pin, 'restore');
    });
    persistOpenCards(); // prune any entries whose pins no longer exist
  }

  function openCard(pin, from) {
    selectedPinId = pin.id;
    var cont = document.getElementById('cbCards'); if (!cont) return;
    var existing = cont.querySelector('.cb-detail-card[data-pin="' + pin.id + '"]');
    if (existing) { raiseCard(existing); persistOpenCards(); existing.classList.add('cb-flash'); setTimeout(function () { existing.classList.remove('cb-flash'); }, 300); return; }
    var el = document.createElement('div');
    el.className = 'cb-detail-card';
    el.setAttribute('data-pin', pin.id);
    cont.appendChild(el);
    positionDetailCard(el, from);
    renderDetailInner(el, pin, from);
    raiseCard(el);
    persistOpenCards();
  }

  function renderDetailInner(el, pin, from) {
    var meta = TYPE_META[pin.type] || TYPE_META.custom;

    var linked = board.strings.filter(function (s) { return s.from === pin.id || s.to === pin.id; }).map(function (s) {
      var otherId = s.from === pin.id ? s.to : s.from;
      var other = findPin(otherId);
      var mi = (pin.lat != null && other && other.lat != null) ? haversineMi(pin, other) : null;
      return '<div class="cb-linked-item">\u2514 ' + esc(s.label || 'linked') + ': <b>' + esc(other ? other.label : '?') + '</b>' + (mi != null ? ' <span style="color:#6b7685">(' + mi.toFixed(1) + ' mi)</span>' : '') + '</div>';
    }).join('') || '<div class="cb-linked-item" style="color:#6b7685">No connections yet</div>';

    var swatches = COLORS.map(function (c) { return '<span class="cb-swatch' + (c === pin.color ? ' active' : '') + '" data-color="' + c + '" style="background:' + c + '"></span>'; }).join('');
    var jumpBtn = (pin.data && pin.data.sourceTab) ? '<button class="cb-btn cb-card-jump">\u2197 Open in ' + esc(pin.data.sourceTab) + '</button>' : '';
    var mapBtn = (pin.lat != null) ? '<button class="cb-btn cb-card-center">\uD83D\uDCCD Center map</button>' : '';
    var boardBtn = (pin.x == null || pin.y == null) ? '<button class="cb-btn cb-card-toboard">\uD83E\uDDF5 Add to web</button>' : '';
    var video = pin.data && pin.data.video;
    var videoBtn = video ? '<button class="cb-btn cb-card-video">\u25B6 Play video</button>' : '';
    var mediaList = (pin.type === 'evidence' && pin.data && pin.data.media && pin.data.media.length) ? pin.data.media : [];

    el.innerHTML =
      '<div class="cb-card-head" style="background:' + (pin.color || meta.color) + '22;border-bottom:2px solid ' + (pin.color || meta.color) + '">' +
        '<span>' + typeGlyph(pin.type) + '</span><span class="cb-card-headname">' + esc(pin.label) + '</span>' +
        '<span class="cb-card-close" title="Close">\u2715</span>' +
      '</div>' +
      '<div class="cb-card-body">' +
        (pin.photo ? '<img class="cb-card-photo" src="' + esc(pin.photo) + '">' : '') +
        '<div class="cb-card-row"><span class="cb-k">Type:</span> ' + esc(meta.label) + '</div>' +
        (pin.data && pin.data.dob ? '<div class="cb-card-row"><span class="cb-k">DOB:</span> ' + esc(pin.data.dob) + '</div>' : '') +
        (hasAddrText(pin.address) ? '<div class="cb-card-row"><span class="cb-k">Address:</span> ' + esc(pin.address) + '</div>' : '') +
        (pin.data && pin.data.plate ? '<div class="cb-card-row"><span class="cb-k">Plate:</span> ' + esc(pin.data.plate) + '</div>' : '') +
        (pin.data && pin.data.datetime ? '<div class="cb-card-row"><span class="cb-k">Date/Time:</span> ' + esc(pin.data.datetime) + '</div>' : '') +
        (pin.data && pin.data.time ? '<div class="cb-card-row"><span class="cb-k">Time:</span> ' + esc(pin.data.time) + '</div>' : '') +
        (pin.data && pin.data.notes ? '<div class="cb-card-row cb-card-notes"><span class="cb-k">Notes:</span> ' + esc(pin.data.notes) + '</div>' : '') +
        (video ? '<div class="cb-card-row"><span class="cb-k">Video:</span> ' + esc(video.name || 'surveillance') + ' <span style="color:#6b7685">(in Evidence)</span></div>' : '') +
        (mediaList.length ? '<div class="cb-card-media" data-media-host="1"></div>' : '') +
        '<div class="cb-linked"><div class="cb-card-row cb-k" style="margin-bottom:4px">LINKED TO</div>' + linked + '</div>' +
      '</div>' +
      '<div class="cb-card-colors">' + swatches + '</div>' +
      '<div class="cb-card-actions">' +
        '<button class="cb-btn cb-card-edit">\u270E Rename</button>' +
        mapBtn + boardBtn + videoBtn + jumpBtn +
        '<button class="cb-btn cb-btn-danger cb-card-del">\uD83D\uDDD1 Remove</button>' +
      '</div>';

    makeDetailDraggable(el);
    makeDetailResizable(el);
    if (mediaList.length) fillEvidenceMedia(el, mediaList);

    el.querySelector('.cb-card-close').onclick = function () { if (el.parentNode) el.parentNode.removeChild(el); persistOpenCards(); };
    el.querySelector('.cb-card-edit').onclick = function () {
      cbPrompt('Rename', pin.label).then(function (nm) { if (nm != null) { pin.label = nm; pin._labelOverride = true; saveBoard(); renderCurrentView(); renderLocPanel(); renderDetailInner(el, pin, from); } });
    };
    el.querySelector('.cb-card-del').onclick = function () {
      cbConfirm('Remove "' + pin.label + '" and its connections?').then(function (ok) {
        if (!ok) return;
        board.pins = board.pins.filter(function (p) { return p.id !== pin.id; });
        board.strings = board.strings.filter(function (s) { return s.from !== pin.id && s.to !== pin.id; });
        saveBoard(); if (el.parentNode) el.parentNode.removeChild(el); persistOpenCards(); renderCurrentView(); renderLocPanel();
      });
    };
    if (el.querySelector('.cb-card-center')) el.querySelector('.cb-card-center').onclick = function () { if (map && pin.lat != null) { setView('map'); map.setView([pin.lat, pin.lng], 15); } };
    if (el.querySelector('.cb-card-toboard')) el.querySelector('.cb-card-toboard').onclick = function () {
      var stage = document.getElementById('cbWebStage');
      pin.x = (stage ? stage.scrollLeft : 0) + 60; pin.y = (stage ? stage.scrollTop : 0) + 60;
      saveBoard(); setView('web'); renderWeb(); renderLocPanel(); renderDetailInner(el, pin, from);
    };
    if (el.querySelector('.cb-card-video')) el.querySelector('.cb-card-video').onclick = function () {
      var v = pin.data && pin.data.video;
      if (v && v.path && window.electronAPI && window.electronAPI.openFile) { window.electronAPI.openFile(v.path); }
      else toast('Video not available', 'warning');
    };
    if (el.querySelector('.cb-card-jump')) el.querySelector('.cb-card-jump').onclick = function () {
      closeBoard();
      try { if (typeof renderTabContent === 'function') { renderTabContent(pin.data.sourceTab); } if (typeof switchTab === 'function') switchTab(pin.data.sourceTab); } catch (_) {}
    };
    el.querySelectorAll('.cb-card-colors .cb-swatch').forEach(function (sw) {
      sw.onclick = function () { pin.color = sw.getAttribute('data-color'); saveBoard(); renderCurrentView(); renderLocPanel(); renderDetailInner(el, pin, from); };
    });
  }

  function hideCard() { var c = document.getElementById('cbCards'); if (c) c.innerHTML = ''; selectedPinId = null; }

  // Populate the evidence card's media host with inline image/video/audio.
  // Reads the file bytes through the Electron bridge and shows them as a blob
  // (same technique the Evidence tab uses); falls back to an "Open externally"
  // button if the bridge is missing or the read fails.
  function fillEvidenceMedia(el, list) {
    var host = el.querySelector('[data-media-host]');
    if (!host || !list || !list.length) return;
    host.innerHTML = '';
    list.slice(0, 4).forEach(function (m) {
      var wrap = document.createElement('div');
      wrap.className = 'cb-media-item';
      var name = document.createElement('div');
      name.className = 'cb-media-name';
      name.textContent = m.name || m.kind;
      wrap.appendChild(name);

      function fallback() {
        var b = document.createElement('button');
        b.className = 'cb-btn cb-media-open';
        b.textContent = '\u2197 Open externally';
        b.onclick = function () { if (window.electronAPI && window.electronAPI.openFile) window.electronAPI.openFile(m.path); };
        wrap.appendChild(b);
      }

      var mediaEl;
      if (m.kind === 'image') { mediaEl = document.createElement('img'); }
      else if (m.kind === 'video') { mediaEl = document.createElement('video'); mediaEl.controls = true; mediaEl.preload = 'metadata'; }
      else { mediaEl = document.createElement('audio'); mediaEl.controls = true; mediaEl.preload = 'metadata'; }
      mediaEl.className = 'cb-media-el';
      mediaEl.onerror = function () { mediaEl.remove(); fallback(); };
      wrap.appendChild(mediaEl);
      host.appendChild(wrap);

      if (window.electronAPI && window.electronAPI.readEvidenceFile) {
        window.electronAPI.readEvidenceFile(m.path).then(function (data) {
          try {
            var blob = new Blob([new Uint8Array(data)], { type: m.mime });
            mediaEl.src = URL.createObjectURL(blob);
          } catch (e) { mediaEl.remove(); fallback(); }
        }).catch(function () { mediaEl.src = 'file:///' + m.path.replace(/\\/g, '/'); });
      } else {
        mediaEl.src = 'file:///' + m.path.replace(/\\/g, '/');
      }
    });
  }


  // ============================================================
  //  LOCATIONS / ASSET PANEL
  // ============================================================
  function renderLocPanel() {
    var list = document.getElementById('cbLocList'); if (!list) return;
    document.getElementById('cbPinCount').textContent = board.pins.length;
    if (!board.pins.length) { list.innerHTML = '<div style="color:#6b7685;font-size:0.8rem;padding:10px">Board is empty. Seed adds the scene + suspect homes; use "Add Asset" (LPR/cell/note/image/video) or "Add from case data" for more.</div>'; return; }
    list.innerHTML = board.pins.map(function (p) {
      var placed = p.lat != null;
      var onboard = p.x != null && p.y != null;
      var sub = placed ? (p.address || (p.lat.toFixed(4) + ', ' + p.lng.toFixed(4))) : (p.address || 'No address');
      var locateBtn = (!placed && p.address) ? '<button class="cb-loc-locate" data-locate="' + p.id + '" title="Retry address lookup">Locate</button>' : '';
      var onboardBadge = onboard ? '<span class="cb-loc-onboard" title="On the Web board">web</span>' : '';
      return '<div class="cb-loc' + (placed ? '' : ' cb-unplaced') + (onboard ? ' cb-onboard' : '') + '" draggable="true" data-pin="' + p.id + '" title="Drag onto the Web board to place">' +
        '<span class="cb-dot" style="background:' + (p.color || typeColor(p.type)) + '"></span>' +
        '<div class="cb-loc-body"><div class="cb-loc-name">' + esc(p.label) + '</div><div class="cb-loc-sub">' + esc(sub) + '</div></div>' +
        onboardBadge + locateBtn +
        '</div>';
    }).join('');
    list.querySelectorAll('.cb-loc').forEach(function (el) {
      el.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', el.getAttribute('data-pin'));
        e.dataTransfer.effectAllowed = 'move';
      });
      el.onclick = function () {
        var pin = findPin(el.getAttribute('data-pin')); if (!pin) return;
        if (view === 'web') {
          if (pin.x == null || pin.y == null) {
            // drop it near the top-left of the current viewport
            var stage = document.getElementById('cbWebStage');
            pin.x = (stage ? stage.scrollLeft : 0) + 40;
            pin.y = (stage ? stage.scrollTop : 0) + 40;
            saveBoard(); renderWeb(); renderLocPanel();
            return;
          }
          if (webCards[pin.id]) webCards[pin.id].scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
          onPinActivate(pin, 'web');
          return;
        }
        if (pin.lat != null && view === 'map') { map.setView([pin.lat, pin.lng], 15); }
        onPinActivate(pin, view);
      };
    });
    list.querySelectorAll('.cb-loc-locate').forEach(function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var pin = findPin(btn.getAttribute('data-locate')); if (!pin || !pin.address) return;
        btn.textContent = '\u2026'; btn.disabled = true;
        geocode(pin.address).then(function (g) {
          if (g) {
            pin.lat = g.lat; pin.lng = g.lng; pin.approx = !!g.approx;
            saveBoard(); renderCurrentView(); renderLocPanel();
            if (view === 'map' && map) map.setView([g.lat, g.lng], 15);
            toast(g.approx ? ('Located "' + pin.label + '" approximately (matched street/ZIP \u2014 verify the exact spot)') : ('Located "' + pin.label + '"'), g.approx ? 'info' : 'success');
          } else {
            btn.textContent = 'Locate'; btn.disabled = false;
            toast(window._cbLastGeocodeError || 'Could not locate that address \u2014 check spelling or drop the pin manually', 'warning');
          }
        });
      };
    });
  }

  // ============================================================
  //  ADD-FROM-CASE-DATA MENU
  // ============================================================
  function openAddMenu() {
    var opts = [
      ['victims', 'Victims'], ['witnesses', 'Witnesses'], ['missing', 'Missing Persons (last seen)'],
      ['vehicles', 'Vehicles / Plates'], ['canvas', 'Area Canvas locations'], ['evidence', 'Evidence (with location)'], ['crosscase', 'Related cases (shared suspects)']
    ];
    var wrap = document.getElementById('cbAddMenuWrap');
    var existing = document.getElementById('cbAddMenu');
    if (existing) { existing.remove(); return; }
    var menu = document.createElement('div');
    menu.id = 'cbAddMenu';
    menu.style.cssText = 'position:absolute;top:110%;left:0;background:#0d1117;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px;z-index:10001;min-width:220px;box-shadow:0 10px 30px rgba(0,0,0,0.6)';
    menu.innerHTML = opts.map(function (o) { return '<div class="cb-btn" style="width:100%;justify-content:flex-start;margin-bottom:4px;border:none;background:transparent" data-add="' + o[0] + '">\u2795 ' + o[1] + '</div>'; }).join('');
    wrap.appendChild(menu);
    menu.querySelectorAll('[data-add]').forEach(function (el) {
      el.onmouseenter = function () { el.style.background = '#131a24'; };
      el.onmouseleave = function () { el.style.background = 'transparent'; };
      el.onclick = function () { addFromCaseData(el.getAttribute('data-add')); menu.remove(); };
    });
    setTimeout(function () {
      document.addEventListener('click', function h(e) { if (!menu.contains(e.target) && e.target.id !== 'cbAddDataBtn') { menu.remove(); document.removeEventListener('click', h); } });
    }, 0);
  }

  // ============================================================
  //  ADD ASSET (LPR/cell/associate/note/image/video)
  // ============================================================
  var ASSET_TYPES = [
    ['lpr', '\uD83D\uDCF7 License Plate Reader (LPR) Hit'],
    ['cellData', '\uD83D\uDCF6 Cell Data Record Hit'],
    ['cellPing', '\uD83D\uDCF1 Cell Phone Ping'],
    ['associate', '\uD83C\uDFE0 Family / Friend / Accomplice House'],
    ['location', '\uD83D\uDCCD Location of Interest'],
    ['note', '\uD83D\uDCDD Note'],
    ['image', '\uD83D\uDDBC Image'],
    ['video', '\uD83C\uDFA5 Surveillance Video (\u2192 Evidence)'],
    ['custom', '\uD83D\uDCCC Other / Custom']
  ];

  function openAssetForm(dropLatLng) {
    if (document.getElementById('cbAssetModal')) return;
    var host = document.getElementById('cbDrawer') || document.body;
    var back = document.createElement('div');
    back.className = 'cb-modal-back';
    back.id = 'cbAssetModal';
    var typeOpts = ASSET_TYPES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('');
    back.innerHTML =
      '<div class="cb-modal cb-modal-lg">' +
        '<div class="cb-modal-title">' + (dropLatLng ? 'Drop Pin \u2014 Details' : 'Add Asset to Board') + '</div>' +
        '<div class="cb-form-grid">' +
          '<label class="cb-flabel">Asset type' +
            '<select class="cb-modal-input" id="cbAssetType">' + typeOpts + '</select>' +
          '</label>' +
          '<label class="cb-flabel">Label / title' +
            '<input type="text" class="cb-modal-input" id="cbAssetLabel" placeholder="e.g. LPR hit \u2014 ABC1234 on I-10" />' +
          '</label>' +
          '<label class="cb-flabel" id="cbAssetAddrWrap">' + (dropLatLng ? 'Address / place (auto-filled from the drop point)' : 'Address or place (optional \u2014 geocodes to map)') +
            '<input type="text" class="cb-modal-input" id="cbAssetAddr" placeholder="e.g. 123 Main St, City, ST 00000" />' +
          '</label>' +
          '<label class="cb-flabel" id="cbAssetPlateWrap" style="display:none">Plate number' +
            '<input type="text" class="cb-modal-input" id="cbAssetPlate" placeholder="e.g. 7ABC123" />' +
          '</label>' +
          '<label class="cb-flabel">Date / time (optional)' +
            '<input type="datetime-local" class="cb-modal-input" id="cbAssetDateTime" />' +
          '</label>' +
          '<label class="cb-flabel">Notes (optional)' +
            '<textarea class="cb-modal-input" id="cbAssetNotes" rows="3" placeholder="Details, source, context\u2026"></textarea>' +
          '</label>' +
          '<label class="cb-flabel" id="cbAssetFileWrap">Attachment (optional)' +
            '<input type="file" class="cb-modal-input cb-modal-file" id="cbAssetFile" accept="image/*,video/*" />' +
            '<span class="cb-fhint" id="cbAssetFileHint">Images attach to the pin. Videos are stored in the Evidence module.</span>' +
          '</label>' +
        '</div>' +
        '<div class="cb-modal-actions">' +
          '<button class="cb-btn" data-act="cancel">Cancel</button>' +
          '<button class="cb-btn cb-modal-ok" data-act="ok">Add to board</button>' +
        '</div>' +
      '</div>';
    host.appendChild(back);

    var typeSel = back.querySelector('#cbAssetType');
    var plateWrap = back.querySelector('#cbAssetPlateWrap');
    var fileInput = back.querySelector('#cbAssetFile');
    var fileHint = back.querySelector('#cbAssetFileHint');
    function syncType() {
      var t = typeSel.value;
      plateWrap.style.display = (t === 'lpr') ? '' : 'none';
      if (t === 'video') { fileInput.setAttribute('accept', 'video/*'); fileHint.textContent = 'The video will be saved to the Evidence module for this case.'; }
      else if (t === 'image') { fileInput.setAttribute('accept', 'image/*'); fileHint.textContent = 'The image attaches to this pin and shows on its marker.'; }
      else { fileInput.setAttribute('accept', 'image/*,video/*'); fileHint.textContent = 'Images attach to the pin. Videos are stored in the Evidence module.'; }
    }
    typeSel.addEventListener('change', syncType); syncType();

    // Drop Pin: default to a location type and auto-fill the address from the
    // clicked coordinates via reverse geocoding.
    if (dropLatLng) {
      typeSel.value = 'location'; syncType();
      var addrInput = back.querySelector('#cbAssetAddr');
      addrInput.placeholder = 'Looking up address\u2026';
      reverseGeocode(dropLatLng.lat, dropLatLng.lng).then(function (addr) {
        if (addr && !addrInput.value) addrInput.value = addr;
        addrInput.placeholder = 'e.g. 123 Main St, City, ST 00000';
      });
    }

    function close() { if (back.parentNode) back.parentNode.removeChild(back); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('[data-act="cancel"]').onclick = close;
    back.querySelector('[data-act="ok"]').onclick = function () { saveAsset(back, close, dropLatLng); };
    setTimeout(function () { back.querySelector('#cbAssetLabel').focus(); }, 30);
  }

  function saveAsset(back, close, dropLatLng) {
    var type = back.querySelector('#cbAssetType').value;
    var label = (back.querySelector('#cbAssetLabel').value || '').trim();
    var addr = (back.querySelector('#cbAssetAddr').value || '').trim();
    var plate = (back.querySelector('#cbAssetPlate').value || '').trim();
    var dtRaw = back.querySelector('#cbAssetDateTime').value || '';
    var notes = (back.querySelector('#cbAssetNotes').value || '').trim();
    var fileInput = back.querySelector('#cbAssetFile');
    var file = fileInput.files && fileInput.files[0];

    if (!label) { label = (TYPE_META[type] || TYPE_META.custom).label; }
    var dt = dtRaw ? dtRaw.replace('T', ' ') : '';

    var pin = {
      id: uid('pin'), type: type, label: label,
      lat: null, lng: null, x: null, y: null,
      color: (TYPE_META[type] || TYPE_META.custom).color,
      photo: '', manual: true, sourceType: null, sourceId: null,
      address: addr, data: {}
    };
    if (plate) { pin.data.plate = plate; }
    if (dt) { pin.data.datetime = dt; }
    if (notes) { pin.data.notes = notes; }
    // Dropped straight onto the map -> use the exact clicked coordinates.
    if (dropLatLng) { pin.lat = dropLatLng.lat; pin.lng = dropLatLng.lng; pin.manual = true; pin._posManual = true; }

    var okBtn = back.querySelector('[data-act="ok"]');
    okBtn.disabled = true;

    function finish() {
      // If the user is on the Web board, drop the new card straight into the
      // visible viewport so it appears immediately (still draggable afterwards).
      if (view === 'web') {
        var stage = document.getElementById('cbWebStage');
        var jitter = (board.pins.length % 5) * 26;
        pin.x = (stage ? stage.scrollLeft : 0) + 60 + jitter;
        pin.y = (stage ? stage.scrollTop : 0) + 60 + jitter;
      }
      board.pins.push(pin);
      saveBoard();
      renderCurrentView(); renderLocPanel();
      if (dropLatLng) {
        if (view === 'map' && map) map.setView([pin.lat, pin.lng], 15);
      } else if (addr) {
        geocode(addr).then(function (g) {
          if (g) { pin.lat = g.lat; pin.lng = g.lng; pin.approx = !!g.approx; saveBoard(); renderCurrentView(); renderLocPanel(); if (view === 'map' && map) map.setView([g.lat, g.lng], 14); }
          else { toast('Asset added \u2014 address not found, drop it on the map', 'info'); }
        });
      }
      toast('Added "' + label + '" to the board', 'success');
      close();
    }

    if (!file) { finish(); return; }

    // Handle attachment
    var isVideo = /^video\//i.test(file.type) || type === 'video';
    var isImage = /^image\//i.test(file.type) || type === 'image';

    if (isVideo) {
      toast('Saving video to Evidence\u2026', 'info');
      saveFileToEvidence(file, true).then(function (res) {
        if (res) {
          pin.data.video = { name: file.name, path: res.savedPath, evidenceId: res.evidenceId };
          if (pin.type !== 'video') { pin.type = 'video'; pin.color = TYPE_META.video.color; }
        } else {
          toast('Could not save video to Evidence', 'warning');
        }
        finish();
      });
    } else if (isImage) {
      // Read as data URL for the marker/card thumbnail
      var reader = new FileReader();
      reader.onload = function () { pin.photo = reader.result; finish(); };
      reader.onerror = function () { toast('Could not read image', 'warning'); finish(); };
      reader.readAsDataURL(file);
    } else {
      // Any other file -> store in Evidence, reference on pin
      saveFileToEvidence(file, false).then(function (res) {
        if (res) pin.data.attachment = { name: file.name, path: res.savedPath, evidenceId: res.evidenceId };
        finish();
      });
    }
  }

  // Save a file into the case Evidence module (disk + viperCaseEvidence store).
  function saveFileToEvidence(file, makeEvidenceItem) {
    if (!currentCase || !window.electronAPI || !window.electronAPI.saveEvidenceFile) return Promise.resolve(null);
    var caseNumber = currentCase.caseNumber;
    var tag = 'ConnectionBoard_' + Date.now();
    return file.arrayBuffer().then(function (buf) {
      var u8 = new Uint8Array(buf);
      return window.electronAPI.saveEvidenceFile({ caseNumber: caseNumber, evidenceTag: tag, fileName: file.name, fileData: Array.from(u8) });
    }).then(function (savedPath) {
      var evidenceId = null;
      if (makeEvidenceItem) {
        try {
          var all = lsParse('viperCaseEvidence', {});
          var arr = all[caseNumber] || [];
          evidenceId = Date.now();
          var item = {
            id: evidenceId,
            type: /^video\//i.test(file.type) ? 'video' : 'digital',
            tag: tag,
            description: 'Added from Connection Board',
            fileCount: 1, totalSize: file.size,
            files: [{ name: file.name, path: savedPath, size: file.size, type: file.type, lastModified: file.lastModified }],
            createdAt: new Date().toISOString(),
            source: 'connection-board'
          };
          arr.push(item);
          all[caseNumber] = arr;
          localStorage.setItem('viperCaseEvidence', JSON.stringify(all));
          // keep case-detail's in-memory list in sync if present
          try { if (typeof caseEvidence !== 'undefined' && Array.isArray(caseEvidence)) caseEvidence.push(item); } catch (_) {}
        } catch (e) { console.warn('[CB] evidence item', e); }
      }
      return { savedPath: savedPath, evidenceId: evidenceId };
    }).catch(function (e) { console.error('[CB] saveFileToEvidence', e); return null; });
  }

  // ============================================================
  //  EXPORT  —  self-contained single-file HTML briefing document
  //  Bundles pins, strings, photos and evidence media (data URLs) into one
  //  .html the detective can email or carry on a USB. The Map view uses live
  //  Leaflet from CDN (needs internet in the room); the Web view is fully
  //  offline. Large clips are poster-thumbnailed instead of embedded.
  // ============================================================
  var EXPORT_MEDIA_CAP = 8 * 1024 * 1024; // bytes; clips under this embed in full

  function _fmtMB(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

  function _blobToDataUrl(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('read')); };
      fr.readAsDataURL(blob);
    });
  }

  // Grab a poster frame from a video blob (used for oversized clips we won't
  // embed in full). Resolves to a JPEG data URL, or null if it can't decode.
  function _capturePoster(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob), v = document.createElement('video'), done = false;
      function finish(val) { if (done) return; done = true; try { URL.revokeObjectURL(url); } catch (_) {} resolve(val); }
      v.preload = 'metadata'; v.muted = true; v.src = url;
      v.onloadeddata = function () { try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (_) { finish(null); } };
      v.onseeked = function () {
        try {
          var w = v.videoWidth || 320, h = v.videoHeight || 240, scale = Math.min(1, 480 / w);
          var c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          finish(c.toDataURL('image/jpeg', 0.7));
        } catch (_) { finish(null); }
      };
      v.onerror = function () { finish(null); };
      setTimeout(function () { finish(null); }, 8000);
    });
  }

  function _collectMedia(mediaArr) {
    var arr = (mediaArr || []).slice(0, 6);
    var out = [];
    var chain = Promise.resolve();
    arr.forEach(function (m) {
      chain = chain.then(function () {
        var item = { name: m.name || '', kind: m.kind, mime: m.mime };
        if (!(window.electronAPI && window.electronAPI.readEvidenceFile)) { item.note = 'Media unavailable'; out.push(item); return; }
        return window.electronAPI.readEvidenceFile(m.path).then(function (bytes) {
          var blob = new Blob([new Uint8Array(bytes)], { type: m.mime });
          item.size = blob.size;
          if (m.kind === 'image') { return _blobToDataUrl(blob).then(function (d) { item.src = d; out.push(item); }); }
          if (blob.size <= EXPORT_MEDIA_CAP) { return _blobToDataUrl(blob).then(function (d) { item.src = d; out.push(item); }); }
          // oversized: thumbnail video, note-only for audio
          if (m.kind === 'video') {
            return _capturePoster(blob).then(function (p) { if (p) item.poster = p; item.note = 'Full clip in VIPER (' + _fmtMB(blob.size) + ')'; out.push(item); });
          }
          item.note = 'Full clip in VIPER (' + _fmtMB(blob.size) + ')'; out.push(item);
        }).catch(function () { item.note = 'Unavailable (' + (m.name || m.kind) + ')'; out.push(item); });
      });
    });
    return chain.then(function () { return out; });
  }

  function collectExportData() {
    var pinJobs = board.pins.map(function (p) {
      var base = {
        id: p.id, type: p.type, label: p.label || '', color: p.color || '', address: p.address || '',
        lat: (p.lat == null ? null : p.lat), lng: (p.lng == null ? null : p.lng), approx: !!p.approx,
        x: (p.x == null ? null : p.x), y: (p.y == null ? null : p.y), photo: p.photo || '',
        data: {
          dob: (p.data && p.data.dob) || '', plate: (p.data && p.data.plate) || '',
          datetime: (p.data && p.data.datetime) || '', time: (p.data && p.data.time) || '',
          notes: (p.data && p.data.notes) || ''
        },
        media: []
      };
      if (p.type === 'evidence' && p.data && p.data.media && p.data.media.length) {
        return _collectMedia(p.data.media).then(function (mm) { base.media = mm; return base; });
      }
      return Promise.resolve(base);
    });
    return Promise.all(pinJobs).then(function (pins) {
      var strings = board.strings.map(function (s) {
        return { from: s.from, to: s.to, label: s.label || '', color: s.color || '#9ca3af', style: s.style || 'solid', view: s.view || 'web' };
      });
      return {
        typeMeta: TYPE_META,
        caseInfo: { number: (currentCase && currentCase.caseNumber) || '', id: (currentCase && currentCase.id) || '' },
        generated: new Date().toLocaleString(),
        defaultView: (board.view && board.view.mode) || 'map',
        pins: pins, strings: strings
      };
    });
  }

  function exportBoard() {
    if (!board || !board.pins.length) { toast('Board is empty \u2014 nothing to export', 'warning'); return; }
    var btn = document.getElementById('cbExportBtn');
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '\u2026 Exporting'; }
    function restore() { if (btn) { btn.disabled = false; btn.textContent = old; } }
    collectExportData().then(function (data) {
      var html = buildExportHtml(data);
      var num = String(data.caseInfo.number || 'export').replace(/[<>:"|?*\\/]/g, '_');
      var fname = 'VIPER Connection Board - Case ' + num + '.html';
      if (!(window.electronAPI && window.electronAPI.exportConnectionBoard)) { toast('Export bridge unavailable', 'error'); restore(); return; }
      return window.electronAPI.exportConnectionBoard({ html: html, defaultFileName: fname }).then(function (res) {
        if (res && res.success) toast('Board exported \u2014 ' + (res.filePath || ''), 'success');
        else if (res && res.canceled) { /* user cancelled — stay quiet */ }
        else toast('Export failed' + (res && res.error ? ': ' + res.error : ''), 'error');
        restore();
      });
    }).catch(function (e) { console.error('[CB] export', e); toast('Export failed: ' + (e && e.message || e), 'error'); restore(); });
  }

  // ---- self-contained viewer: CSS + JS baked into the exported file ----
  var EXPORT_CSS =
    '*{box-sizing:border-box}' +
    'html,body{margin:0;height:100%;background:#0b0e14;color:#e6e9ef;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}' +
    'header{display:flex;align-items:center;gap:16px;padding:10px 16px;background:#0d1117;border-bottom:1px solid rgba(255,255,255,.1);height:53px}' +
    '.h-title{font-weight:700;font-size:1.05rem}.h-sub{color:#8a93a6;font-size:.85rem}' +
    '.seg{display:flex;border:1px solid rgba(255,255,255,.15);border-radius:8px;overflow:hidden;margin-left:auto}' +
    '.seg-btn{background:transparent;color:#cdd3df;border:none;padding:7px 18px;cursor:pointer;font-size:.9rem}' +
    '.seg-btn.active{background:#1f6feb;color:#fff}' +
    '#stage{position:absolute;top:53px;left:0;right:0;bottom:0}' +
    '#map{position:absolute;inset:0}' +
    '#web{position:absolute;inset:0;overflow:auto;background:#0b0e14}' +
    '.hidden{display:none!important}' +
    '#webCanvas{position:relative;min-width:100%;min-height:100%}' +
    '#webLines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}' +
    '.ll{fill:#cdd3df;font-size:12px;paint-order:stroke;stroke:#0b0e14;stroke-width:3px}' +
    '#webLabels{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;overflow:visible}' +
    '.ll-pill{position:absolute;transform:translate(-50%,-50%);max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:rgba(5,7,10,.92);border:1px solid rgba(255,255,255,.16);color:#e6edf3;font-size:10px;font-weight:600;padding:3px 8px;border-radius:11px;box-shadow:0 2px 8px rgba(0,0,0,.55);pointer-events:auto}' +
    '.ll-pill:hover{max-width:360px;white-space:normal;overflow:visible;border-color:rgba(255,255,255,.4);z-index:20}' +
    '.wc{position:absolute;width:220px;background:#111723;border:1px solid rgba(255,255,255,.12);border-top:3px solid #888;border-radius:10px;padding:10px;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.4);z-index:2}' +
    '.wc:hover{border-color:rgba(255,255,255,.35)}' +
    '.wc-head{display:flex;gap:6px;align-items:center;font-weight:600}.wc-g{font-size:1.1rem}.wc-t{font-size:.95rem}' +
    '.wc-type{color:#8a93a6;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;margin:2px 0 6px}' +
    '.wc-img{width:100%;border-radius:6px;margin-bottom:6px;max-height:150px;object-fit:cover}' +
    '.wc-row{font-size:.8rem;color:#c3c9d5;margin:2px 0}' +
    '.wc-notes{font-size:.78rem;color:#9aa3b3;margin-top:4px;white-space:pre-wrap}' +
    '.wc-foot{margin-top:6px;font-size:.72rem;color:#7c8698}' +
    '.mk{width:44px;height:44px;border-radius:50%;border:3px solid #888;overflow:hidden;background:#111723;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.5)}' +
    '.mk img{width:100%;height:100%;object-fit:cover}.mg{font-size:1.2rem}' +
    '.leaflet-tooltip.sl{background:#0d1117;border:1px solid rgba(255,255,255,.25);color:#e6e9ef;border-radius:4px;font-size:12px}' +
    '.web-empty{position:absolute;top:40%;left:0;right:0;text-align:center;color:#7c8698}' +
    '#detail{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100000}' +
    '.d-card{width:min(460px,92vw);max-height:88vh;overflow:auto;background:#111723;border:1px solid rgba(255,255,255,.15);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.6)}' +
    '.d-head{display:flex;align-items:center;gap:8px;padding:10px 12px;font-weight:600}.d-hn{flex:1}.d-x{cursor:pointer;color:#c3c9d5;font-size:1.1rem}' +
    '.d-body{padding:12px}' +
    '.d-photo{width:100%;border-radius:8px;margin-bottom:8px;max-height:280px;object-fit:cover}' +
    '.d-row{font-size:.85rem;margin:4px 0;color:#d3d8e2}.dk{color:#8a93a6}' +
    '.d-media{margin:10px 0;display:flex;flex-direction:column;gap:10px}' +
    '.d-mn{font-size:.75rem;color:#8a93a6;margin-bottom:3px}' +
    '.d-me{width:100%;max-height:280px;background:#000;border-radius:6px;display:block}audio.d-me{max-height:44px}' +
    '.d-note{font-size:.75rem;color:#c9a24a;margin-top:3px}' +
    '.d-linked{margin-top:10px;border-top:1px solid rgba(255,255,255,.1);padding-top:8px}' +
    '.d-link{font-size:.8rem;margin:3px 0}.dim{color:#6b7685}';

  var EXPORT_JS =
    '(function(){' +
    'var D=window.__BOARD__,TM=D.typeMeta||{};' +
    'var byId={};D.pins.forEach(function(p){byId[p.id]=p;});' +
    'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\\"/g,"&quot;");}' +
    'function meta(p){return TM[p.type]||TM.custom||{color:"#9ca3af",glyph:"\uD83D\uDCCC",label:"Pin"};}' +
    'function pcolor(p){return p.color||meta(p).color;}function glyph(p){return meta(p).glyph;}' +
    'function hasAddr(a){return /[a-z0-9]/i.test(a||"");}' +
    'function hav(a,b){if(!a||!b||a.lat==null||b.lat==null)return null;var R=3958.8,dLa=(b.lat-a.lat)*Math.PI/180,dLo=(b.lng-a.lng)*Math.PI/180,l1=a.lat*Math.PI/180,l2=b.lat*Math.PI/180;var h=Math.sin(dLa/2)*Math.sin(dLa/2)+Math.sin(dLo/2)*Math.sin(dLo/2)*Math.cos(l1)*Math.cos(l2);return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));}' +
    'var map=null,mapLayers=[];' +
    'function initMap(){if(map)return;map=L.map("map",{zoomControl:true});L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{maxZoom:19,attribution:"&copy; OpenStreetMap &copy; CARTO"}).addTo(map);}' +
    'function micon(p){var inner=p.photo?"<img src=\\""+esc(p.photo)+"\\">":"<span class=\\"mg\\">"+glyph(p)+"</span>";return L.divIcon({className:"",iconSize:[44,44],iconAnchor:[22,22],html:"<div class=\\"mk\\" style=\\"border-color:"+pcolor(p)+"\\">"+inner+"</div>"});}' +
    'function renderMap(){initMap();setTimeout(function(){if(map)map.invalidateSize();},60);mapLayers.forEach(function(l){map.removeLayer(l);});mapLayers=[];' +
    'var placed=D.pins.filter(function(p){return p.lat!=null&&p.lng!=null;});' +
    'D.strings.forEach(function(s){if((s.view||"web")!=="map")return;var a=byId[s.from],b=byId[s.to];if(!a||!b||a.lat==null||b.lat==null)return;' +
    'var pl=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:s.color||"#9ca3af",weight:3,opacity:.85,dashArray:s.style==="dashed"?"6,8":null}).addTo(map);mapLayers.push(pl);' +
    'var mi=hav(a,b),lbl=(s.label||"")+(mi!=null?((s.label?" \u00B7 ":"")+mi.toFixed(1)+" mi"):"");if(lbl)pl.bindTooltip(lbl,{permanent:true,direction:"center",className:"sl"});});' +
    'placed.forEach(function(p){var m=L.marker([p.lat,p.lng],{icon:micon(p)}).addTo(map);m.on("click",function(){openDetail(p);});mapLayers.push(m);});' +
    'if(placed.length===1)map.setView([placed[0].lat,placed[0].lng],14);else if(placed.length>1)map.fitBounds(placed.map(function(p){return[p.lat,p.lng];}),{padding:[60,60],maxZoom:15});else map.setView([39.5,-98.35],4);}' +
    'var webCards={};' +
    'function cardHtml(p){var m=meta(p),img=p.photo?"<img class=\\"wc-img\\" src=\\""+esc(p.photo)+"\\">":"";var rows="";' +
    'if(hasAddr(p.address))rows+="<div class=\\"wc-row\\">\uD83D\uDCCD "+esc(p.address)+"</div>";' +
    'if(p.data.plate)rows+="<div class=\\"wc-row\\">Plate: "+esc(p.data.plate)+"</div>";' +
    'if(p.data.datetime)rows+="<div class=\\"wc-row\\">\uD83D\uDD52 "+esc(p.data.datetime)+"</div>";' +
    'if(p.data.dob)rows+="<div class=\\"wc-row\\">DOB: "+esc(p.data.dob)+"</div>";' +
    'var notes=p.data.notes?"<div class=\\"wc-notes\\">"+esc(p.data.notes)+"</div>":"";' +
    'var links=D.strings.filter(function(s){return s.from===p.id||s.to===p.id;}).length;' +
    'return "<div class=\\"wc-head\\"><span class=\\"wc-g\\">"+glyph(p)+"</span><span class=\\"wc-t\\">"+esc(p.label)+"</span></div><div class=\\"wc-type\\">"+esc(m.label)+"</div>"+img+((rows||notes)?"<div class=\\"wc-body\\">"+rows+notes+"</div>":"")+"<div class=\\"wc-foot\\">\uD83D\uDD17 "+links+" connection"+(links===1?"":"s")+"</div>";}' +
    'function renderWeb(){var canvas=document.getElementById("webCanvas");Object.keys(webCards).forEach(function(k){var e=webCards[k];if(e&&e.parentNode)e.parentNode.removeChild(e);});webCards={};' +
    'var old=canvas.querySelector(".web-empty");if(old)old.remove();' +
    'var placed=D.pins.filter(function(p){return p.x!=null&&p.y!=null;});var stage=document.getElementById("web");' +
    'if(!placed.length){var svg=document.getElementById("webLines");while(svg.firstChild)svg.removeChild(svg.firstChild);var e=document.createElement("div");e.className="web-empty";e.textContent="No web layout was built for this board \u2014 use the Map view.";canvas.appendChild(e);return;}' +
    'var maxX=0,maxY=0;placed.forEach(function(p){var el=document.createElement("div");el.className="wc";el.style.left=p.x+"px";el.style.top=p.y+"px";el.style.borderTopColor=pcolor(p);el.innerHTML=cardHtml(p);el.onclick=function(){openDetail(p);};canvas.appendChild(el);webCards[p.id]=el;maxX=Math.max(maxX,p.x+260);maxY=Math.max(maxY,p.y+260);});' +
    'canvas.style.width=Math.max(stage.clientWidth,maxX)+"px";canvas.style.height=Math.max(stage.clientHeight,maxY)+"px";layoutLines();}' +
    'function layoutLines(){var svg=document.getElementById("webLines");if(!svg)return;while(svg.firstChild)svg.removeChild(svg.firstChild);var labels=document.getElementById("webLabels");if(labels)labels.innerHTML="";' +
    'D.strings.forEach(function(s){if((s.view||"web")!=="web")return;var a=webCards[s.from],b=webCards[s.to];if(!a||!b)return;' +
    'var ax=a.offsetLeft+a.offsetWidth/2,ay=a.offsetTop+a.offsetHeight/2,bx=b.offsetLeft+b.offsetWidth/2,by=b.offsetTop+b.offsetHeight/2;' +
    'var ln=document.createElementNS("http://www.w3.org/2000/svg","line");ln.setAttribute("x1",ax);ln.setAttribute("y1",ay);ln.setAttribute("x2",bx);ln.setAttribute("y2",by);ln.setAttribute("stroke",s.color||"#9ca3af");ln.setAttribute("stroke-width","2.5");ln.setAttribute("stroke-opacity",".85");if(s.style==="dashed")ln.setAttribute("stroke-dasharray","6,7");svg.appendChild(ln);' +
    'var fa=byId[s.from],fb=byId[s.to],mi=hav(fa,fb),lbl=(s.label||"")+(mi!=null?((s.label?" \u00B7 ":"")+mi.toFixed(1)+" mi"):"");' +
    'if(lbl&&labels){var pill=document.createElement("div");pill.className="ll-pill";pill.style.left=((ax+bx)/2)+"px";pill.style.top=((ay+by)/2)+"px";if(s.color)pill.style.borderColor=s.color;pill.textContent=lbl;pill.title=lbl;labels.appendChild(pill);}});}' +
    'function mediaHtml(p){if(!p.media||!p.media.length)return "";var h="<div class=\\"d-media\\">";p.media.forEach(function(m){h+="<div class=\\"d-mi\\"><div class=\\"d-mn\\">"+esc(m.name||m.kind)+"</div>";' +
    'if(m.src&&m.kind==="image")h+="<img class=\\"d-me\\" src=\\""+m.src+"\\">";' +
    'else if(m.src&&m.kind==="video")h+="<video class=\\"d-me\\" controls preload=\\"metadata\\" src=\\""+m.src+"\\"></video>";' +
    'else if(m.src&&m.kind==="audio")h+="<audio class=\\"d-me\\" controls preload=\\"metadata\\" src=\\""+m.src+"\\"></audio>";' +
    'else if(m.poster){h+="<img class=\\"d-me\\" src=\\""+m.poster+"\\">";if(m.note)h+="<div class=\\"d-note\\">"+esc(m.note)+"</div>";}' +
    'else if(m.note)h+="<div class=\\"d-note\\">"+esc(m.note)+"</div>";h+="</div>";});return h+"</div>";}' +
    'function openDetail(p){var m=meta(p);' +
    'var linked=D.strings.filter(function(s){return s.from===p.id||s.to===p.id;}).map(function(s){var oid=s.from===p.id?s.to:s.from,o=byId[oid],mi=(p.lat!=null&&o&&o.lat!=null)?hav(p,o):null;return "<div class=\\"d-link\\">\u2514 "+esc(s.label||"linked")+": <b>"+esc(o?o.label:"?")+"</b>"+(mi!=null?" <span class=\\"dim\\">("+mi.toFixed(1)+" mi)</span>":"")+"</div>";}).join("")||"<div class=\\"d-link dim\\">No connections</div>";' +
    'var b="<div class=\\"d-card\\"><div class=\\"d-head\\" style=\\"background:"+pcolor(p)+"22;border-bottom:2px solid "+pcolor(p)+"\\"><span>"+glyph(p)+"</span><span class=\\"d-hn\\">"+esc(p.label)+"</span><span class=\\"d-x\\">\u2715</span></div><div class=\\"d-body\\">"+' +
    '(p.photo?"<img class=\\"d-photo\\" src=\\""+esc(p.photo)+"\\">":"")+' +
    '"<div class=\\"d-row\\"><span class=\\"dk\\">Type:</span> "+esc(m.label)+"</div>"+' +
    '(p.data.dob?"<div class=\\"d-row\\"><span class=\\"dk\\">DOB:</span> "+esc(p.data.dob)+"</div>":"")+' +
    '(hasAddr(p.address)?"<div class=\\"d-row\\"><span class=\\"dk\\">Address:</span> "+esc(p.address)+"</div>":"")+' +
    '(p.data.plate?"<div class=\\"d-row\\"><span class=\\"dk\\">Plate:</span> "+esc(p.data.plate)+"</div>":"")+' +
    '(p.data.datetime?"<div class=\\"d-row\\"><span class=\\"dk\\">Date/Time:</span> "+esc(p.data.datetime)+"</div>":"")+' +
    '(p.data.time?"<div class=\\"d-row\\"><span class=\\"dk\\">Time:</span> "+esc(p.data.time)+"</div>":"")+' +
    '(p.data.notes?"<div class=\\"d-row\\"><span class=\\"dk\\">Notes:</span> "+esc(p.data.notes)+"</div>":"")+' +
    'mediaHtml(p)+"<div class=\\"d-linked\\"><div class=\\"d-row dk\\">LINKED TO</div>"+linked+"</div></div></div>";' +
    'var host=document.getElementById("detail");host.innerHTML=b;host.classList.remove("hidden");' +
    'host.querySelector(".d-x").onclick=function(){host.classList.add("hidden");host.innerHTML="";};' +
    'host.onclick=function(e){if(e.target===host){host.classList.add("hidden");host.innerHTML="";}};}' +
    'function setView(v){document.getElementById("map").classList.toggle("hidden",v!=="map");document.getElementById("web").classList.toggle("hidden",v!=="web");' +
    'document.querySelectorAll(".seg-btn").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-v")===v);});' +
    'if(v==="map")renderMap();else renderWeb();}' +
    'document.querySelectorAll(".seg-btn").forEach(function(b){b.onclick=function(){setView(b.getAttribute("data-v"));};});' +
    'window.addEventListener("resize",function(){if(!document.getElementById("web").classList.contains("hidden"))layoutLines();});' +
    'setView(D.defaultView||"map");' +
    '})();';

  function buildExportHtml(data) {
    var dataJson = JSON.stringify(data).replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    var title = 'VIPER Connection Board \u2014 Case ' + (data.caseInfo.number || '');
    return '<!DOCTYPE html>\n' +
      '<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(title) + '</title>' +
      '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>' +
      '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>' +
      '<style>' + EXPORT_CSS + '</style></head><body>' +
      '<header><span class="h-title">\uD83E\uDDF5 Connection Board</span>' +
      '<span class="h-sub">Case ' + esc(data.caseInfo.number) + ' \u00B7 Generated ' + esc(data.generated) + '</span>' +
      '<div class="seg"><button class="seg-btn" data-v="map">Map</button><button class="seg-btn" data-v="web">Web</button></div>' +
      '</header>' +
      '<div id="stage"><div id="map"></div><div id="web" class="hidden"><div id="webCanvas"><svg id="webLines"></svg><div id="webLabels"></div></div></div></div>' +
      '<div id="detail" class="hidden"></div>' +
      '<script>window.__BOARD__=' + dataJson + ';\n' + EXPORT_JS + '<\/script>' +
      '</body></html>';
  }

  // ============================================================
  //  FEATURE FLAG (button visibility) — default ON
  // ============================================================
  function applyFlag() {
    var btn = document.getElementById('connectionBoardBtn');
    if (!btn) return;
    var disabled = localStorage.getItem('viperConnectionBoardEnabled') === 'false';
    btn.style.display = disabled ? 'none' : '';
  }

  // ---- exports ----
  window.ConnectionBoard = {
    open: openBoard, close: closeBoard, addFromCaseData: addFromCaseData, applyFlag: applyFlag
  };
  window.openConnectionBoard = openBoard;
  window.closeConnectionBoard = closeBoard;

  document.addEventListener('DOMContentLoaded', applyFlag);
})();
