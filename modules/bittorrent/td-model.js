/**
 * VIPER — BitTorrent (TD) tab: shared model helpers.
 *
 * UMD: loaded by the main-process parser (require) AND by the renderer
 * (<script>, exposes window.TdModel). In the renderer `module` IS defined,
 * so we assign both module.exports and root.TdModel.
 *
 * Pure functions only — no fs, no DOM. Everything here works on the parsed
 * JSON produced by td-log-parser.js.
 *
 * Wording note: labels/summaries are VIPER's own. Do not paste text from the
 * Torrential Downpour manual, Suspect Viewer, or training material here.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.TdModel = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ── Piece ranges ("0-21, 23-173, 175-687") ─────────────────────────────
  function parseRanges(str) {
    var out = [];
    if (str == null) return out;
    String(str).split(',').forEach(function (part) {
      var p = part.trim();
      if (!p) return;
      var m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      if (m) { var a = +m[1], b = +m[2]; if (b < a) { var t = a; a = b; b = t; } out.push([a, b]); return; }
      if (/^\d+$/.test(p)) out.push([+p, +p]);
    });
    return normalizeRanges(out);
  }

  function normalizeRanges(ranges) {
    var r = ranges.slice().sort(function (x, y) { return x[0] - y[0]; });
    var out = [];
    r.forEach(function (x) {
      var last = out[out.length - 1];
      if (last && x[0] <= last[1] + 1) { if (x[1] > last[1]) last[1] = x[1]; }
      else out.push([x[0], x[1]]);
    });
    return out;
  }

  function countRanges(ranges) {
    if (typeof ranges === 'string') ranges = parseRanges(ranges);
    var n = 0;
    (ranges || []).forEach(function (x) { n += x[1] - x[0] + 1; });
    return n;
  }

  function formatRanges(ranges) {
    if (typeof ranges === 'string') ranges = parseRanges(ranges);
    return (ranges || []).map(function (x) { return x[0] === x[1] ? String(x[0]) : x[0] + '-' + x[1]; }).join(', ');
  }

  /** Build ranges from an unsorted list of integers. */
  function rangesFromList(list) {
    var s = (list || []).slice().sort(function (a, b) { return a - b; });
    var out = [];
    s.forEach(function (n) {
      var last = out[out.length - 1];
      if (last && n <= last[1] + 1) { if (n > last[1]) last[1] = n; }
      else out.push([n, n]);
    });
    return out;
  }

  /** Pieces in [0,total) not covered by ranges. Returns ranges. */
  function missingRanges(ranges, total) {
    if (typeof ranges === 'string') ranges = parseRanges(ranges);
    var out = [], next = 0;
    normalizeRanges(ranges || []).forEach(function (x) {
      if (x[0] > next) out.push([next, Math.min(x[0] - 1, total - 1)]);
      next = Math.max(next, x[1] + 1);
    });
    if (total > next) out.push([next, total - 1]);
    return out.filter(function (x) { return x[0] <= x[1]; });
  }

  // ── Teredo ─────────────────────────────────────────────────────────────
  /** Expand an IPv6 string to 8 hextets (numbers). null if not IPv6. */
  function expandIPv6(ip) {
    if (!ip || String(ip).indexOf(':') < 0) return null;
    var s = String(ip).trim().replace(/^\[|\]$/g, '').split('%')[0];
    var halves = s.split('::');
    if (halves.length > 2) return null;
    var head = halves[0] ? halves[0].split(':') : [];
    var tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    // embedded dotted IPv4 tail
    var last = tail.length ? tail[tail.length - 1] : head[head.length - 1];
    if (last && last.indexOf('.') >= 0) {
      var q = last.split('.').map(Number);
      if (q.length !== 4 || q.some(function (n) { return !(n >= 0 && n <= 255); })) return null;
      var w = [((q[0] << 8) | q[1]).toString(16), ((q[2] << 8) | q[3]).toString(16)];
      if (tail.length) tail.splice(tail.length - 1, 1, w[0], w[1]); else head.splice(head.length - 1, 1, w[0], w[1]);
    }
    var fill = 8 - head.length - tail.length;
    if (halves.length === 1 && fill !== 0) return null;
    if (fill < 0) return null;
    var parts = head.concat(new Array(fill).fill('0'), tail);
    var nums = parts.map(function (h) { return /^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN; });
    return nums.some(isNaN) ? null : nums;
  }

  /**
   * Teredo (2001:0000::/32): server IPv4 in hextets 2-3, client port in
   * hextet 5 (bits flipped), client IPv4 in hextets 6-7 (bits flipped).
   */
  function teredoDecode(ip) {
    var h = expandIPv6(ip);
    if (!h || h[0] !== 0x2001 || h[1] !== 0x0000) return null;
    var v4 = function (a, b) { return [a >> 8, a & 255, b >> 8, b & 255].join('.'); };
    return {
      server: v4(h[2], h[3]),
      clientIPv4: v4(h[6] ^ 0xffff, h[7] ^ 0xffff),
      clientPort: h[5] ^ 0xffff,
      flags: h[4]
    };
  }

  function isIPv6(ip) { return !!expandIPv6(ip); }

  // ── BitTorrent client identification (peer id prefix) ──────────────────
  var CLIENTS = {
    'qB': 'qBittorrent', 'UT': 'µTorrent', 'UM': 'µTorrent (Mac)', 'UE': 'µTorrent Embedded',
    'TR': 'Transmission', 'DE': 'Deluge', 'LT': 'libtorrent (Rasterbar)', 'lt': 'libTorrent (rTorrent)',
    'AZ': 'Vuze / Azureus', 'BI': 'BiglyBT', 'BT': 'BitTorrent (mainline)', 'BW': 'BitWombat',
    'FD': 'Free Download Manager', 'FW': 'FrostWire', 'KT': 'KTorrent', 'PI': 'PicoTorrent',
    'WW': 'WebTorrent', 'WD': 'WebTorrent Desktop', 'XL': 'Xunlei', 'SD': 'Thunder (Xunlei)',
    'BN': 'Baidu Netdisk', 'BC': 'BitComet', 'BF': 'Bitflu', 'AG': 'Ares', 'A~': 'Ares',
    'ML': 'MLDonkey', 'TT': 'TuoTu', 'XF': 'Xfplay', 'SP': 'BitSpirit', 'TL': 'Tribler',
    'HL': 'Halite', 'LW': 'LimeWire', 'RT': 'Retriever', 'ST': 'SymTorrent', 'SZ': 'Shareaza',
    'S~': 'Shareaza (beta)', 'tT': 'tTorrent', 'FL': 'Flud', 'TS': 'Torrentstorm', 'MO': 'MonoTorrent',
    'BB': 'BitBuddy', 'TX': 'Tixati', 'ZT': 'ZipTorrent', 'IL': 'iLivid', 'MG': 'MediaGet',
    'FX': 'Freebox BitTorrent', 'GR': 'GetRight', 'PD': 'Pando', 'OS': 'OneSwarm', 'AT': 'Artemis',
    'BG': 'BTG', 'NX': 'Net Transport', 'CD': 'Enhanced CTorrent', 'Lr': 'LibreTorrent', 'TB': 'Torch'
  };

  function _vchar(c) {
    if (/[0-9]/.test(c)) return c.charCodeAt(0) - 48;
    if (/[A-Z]/.test(c)) return c.charCodeAt(0) - 55;
    if (/[a-z]/.test(c)) return c.charCodeAt(0) - 61;
    return null;
  }

  /** Peer id hex → printable prefix ("-qB5240-"). */
  function peerIdPrefix(hex) {
    if (!hex || !/^[0-9a-f]+$/i.test(hex) || hex.length < 16) return '';
    var s = '';
    for (var i = 0; i < 16; i += 2) {
      var c = parseInt(hex.substr(i, 2), 16);
      s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
    }
    return s;
  }

  /**
   * Decode an Azureus-style tag ("-qB5240-") or a raw peer id (hex).
   * Returns { tag, code, name, version } — name/version null when unknown.
   */
  function decodeClient(tagOrHex) {
    var tag = String(tagOrHex || '').trim();
    if (/^[0-9a-f]{40}$/i.test(tag)) tag = peerIdPrefix(tag);
    var m = /^-([A-Za-z~]{2})([0-9A-Za-z]{4})-/.exec(tag);
    if (!m) return { tag: tag, code: null, name: null, version: null };
    var code = m[1], v = m[2], version;
    if (code === 'TR') {
      // Transmission: major digit + two-digit minor ("2940" → 2.94)
      version = v[0] + '.' + v.substr(1, 2) + (/[XZ]/.test(v[3]) ? ' (beta)' : '');
    } else {
      var nums = v.split('').map(_vchar);
      if (nums.some(function (n) { return n == null; })) version = v;
      else {
        if (nums[3] === 0) nums = nums.slice(0, 3);
        version = nums.join('.');
      }
    }
    return { tag: tag, code: code, name: CLIENTS[code] || null, version: version };
  }

  /** Human label: "qBittorrent 5.2.4 (-qB5240-)". Prefers v= from extended handshake. */
  function clientLabel(session) {
    if (!session) return '';
    var d = decodeClient(session.clientTag || session.peerId || '');
    var tag = d.tag ? ' (' + d.tag + ')' : '';
    if (session.clientName) return session.clientName + tag;
    if (d.name) return d.name + ' ' + d.version + tag;
    return d.tag || '';
  }

  // ── What the client tells the investigator (warrant / device planning) ─
  // platforms: windows | macos | linux | android | ios | nas | any.  {hash} → the torrent's info hash.
  // Wording is deliberately "typically" — peer ids are self-reported and default paths can be changed.
  var CLIENT_PROFILES = {
    qB: { kind: 'Free, open-source desktop BitTorrent program', platforms: ['windows', 'macos', 'linux', 'nas'],
      device: 'A Windows, Mac or Linux computer (desktop or laptop). There is no official qBittorrent phone app. The headless edition (qbittorrent-nox) also runs on Linux servers, NAS boxes and seedboxes, usually controlled from a web browser.',
      look: ['Windows: %LOCALAPPDATA%\\qBittorrent\\BT_backup\\ — one {hash}.torrent and {hash}.fastresume per torrent (or a torrents.db database); settings in %APPDATA%\\qBittorrent\\qBittorrent.ini',
        'Mac: ~/Library/Application Support/qBittorrent/BT_backup/ ; settings in ~/.config/qBittorrent/',
        'Linux / NAS: ~/.local/share/qBittorrent/BT_backup/ ; settings in ~/.config/qBittorrent/qBittorrent.ini',
        'Default save folder is the user\'s Downloads folder unless changed in settings'] },
    UT: { kind: 'Freeware BitTorrent program (BitTorrent, Inc.)', platforms: ['windows', 'android'],
      device: 'Most often a Windows PC (µTorrent Classic). The Mac edition normally identifies as UM. µTorrent also ships Android and browser-based (µTorrent Web) versions.',
      look: ['Windows: %APPDATA%\\uTorrent\\ — resume.dat (list of torrents and save paths), settings.dat, and copies of .torrent files',
        'Search resume.dat for the info hash {hash}'] },
    UM: { kind: 'Freeware BitTorrent program — Mac edition', platforms: ['macos'],
      device: 'An Apple Mac computer.',
      look: ['~/Library/Application Support/uTorrent/ — resume.dat and .torrent copies'] },
    BT: { kind: 'Freeware BitTorrent program (BitTorrent, Inc. — "mainline")', platforms: ['windows', 'macos', 'android'],
      device: 'Usually a Windows PC or Mac; an Android version also exists.',
      look: ['Windows: %APPDATA%\\BitTorrent\\ — resume.dat, settings.dat, .torrent copies'] },
    TR: { kind: 'Free, open-source BitTorrent program', platforms: ['macos', 'linux', 'windows', 'nas'],
      device: 'Common on Macs and Linux computers (it comes pre-installed on Ubuntu and other Linux desktops). Also runs on Windows, and as transmission-daemon on NAS boxes (Synology, QNAP), routers and seedboxes.',
      look: ['Mac: ~/Library/Application Support/Transmission/ — Torrents/ and Resume/ folders',
        'Linux: ~/.config/transmission/ (desktop) or ~/.config/transmission-daemon/ (server/NAS) — torrents/ and resume/',
        'Windows: %LOCALAPPDATA%\\transmission\\',
        'Torrent and resume files are named after the torrent and/or its info hash {hash}'] },
    DE: { kind: 'Free, open-source BitTorrent program', platforms: ['windows', 'macos', 'linux', 'nas'],
      device: 'A Windows, Mac or Linux computer; the deluged daemon is also common on NAS boxes and seedboxes.',
      look: ['Windows: %APPDATA%\\deluge\\state\\ — {hash}.torrent, torrents.state, torrents.fastresume',
        'Linux / Mac: ~/.config/deluge/state/'] },
    lt: { kind: 'rTorrent — command-line (terminal) BitTorrent program', platforms: ['linux', 'nas', 'macos'],
      device: 'Usually a Linux server, seedbox or NAS, often with a web front end (ruTorrent). Rare on ordinary home PCs.',
      look: ['Session folder set in .rtorrent.rc (often ~/.session or ~/rtorrent/.session) — {hash}.torrent, .torrent.rtorrent, .torrent.libtorrent_resume (hash in upper case)'] },
    LT: { kind: 'libtorrent (Rasterbar) — a software library built into many apps', platforms: ['any'],
      device: 'The library itself does not say which app or device. Apps that keep the default ID include some Android and NAS programs; check the device for any BitTorrent app.',
      look: ['Search the device for the info hash {hash} and for .torrent / .fastresume files'] },
    AZ: { kind: 'Vuze (formerly Azureus) — Java BitTorrent program', platforms: ['windows', 'macos', 'linux', 'android'],
      device: 'Usually a Windows PC or Mac; Linux and an older Android app also exist.',
      look: ['Windows: %APPDATA%\\Azureus\\ — active\\ folder (torrent copies) and downloads.config', 'Mac: ~/Library/Application Support/Vuze/'] },
    BI: { kind: 'BiglyBT — open-source successor to Vuze', platforms: ['windows', 'macos', 'linux', 'android'],
      device: 'A Windows, Mac or Linux computer, or an Android phone/tablet.',
      look: ['Windows: %APPDATA%\\BiglyBT\\ — active\\ folder and downloads.config', 'Mac: ~/Library/Application Support/BiglyBT/'] },
    FL: { kind: 'Flud — Android BitTorrent app', platforms: ['android'],
      device: 'An Android phone or tablet.',
      look: ['App com.delphicoder.flud; downloads usually in the device\'s Download folder or SD card'] },
    tT: { kind: 'tTorrent — Android BitTorrent app', platforms: ['android'],
      device: 'An Android phone or tablet.',
      look: ['App hu.tagsoft.ttorrent (Lite / Pro); downloads usually in the device\'s Download folder or SD card'] },
    Lr: { kind: 'LibreTorrent — open-source Android BitTorrent app', platforms: ['android'],
      device: 'An Android phone or tablet.',
      look: ['App org.proninyaroslav.libretorrent; downloads usually in the device\'s Download folder'] },
    BC: { kind: 'BitComet — freeware BitTorrent / download manager', platforms: ['windows', 'macos', 'android'],
      device: 'Most often a Windows PC; Mac and Android editions also exist.',
      look: ['Windows: BitComet program folder or %APPDATA%\\BitComet\\ — downloads.xml and torrent copies'] },
    TX: { kind: 'Tixati — freeware BitTorrent program', platforms: ['windows', 'linux'],
      device: 'A Windows or Linux computer (no Mac or phone version).',
      look: ['Windows: %APPDATA%\\tixati\\ (or the portable folder)'] },
    PI: { kind: 'PicoTorrent — small open-source BitTorrent program', platforms: ['windows'],
      device: 'A Windows PC (Windows only).', look: [] },
    KT: { kind: 'KTorrent — KDE BitTorrent program', platforms: ['linux'],
      device: 'A Linux computer (KDE desktop).', look: ['~/.local/share/ktorrent/'] },
    WD: { kind: 'WebTorrent Desktop — open-source streaming BitTorrent program', platforms: ['windows', 'macos', 'linux'],
      device: 'A Windows, Mac or Linux computer.', look: [] },
    WW: { kind: 'WebTorrent — JavaScript BitTorrent library', platforms: ['any'],
      device: 'Built into other apps; does not identify the device on its own.', look: [] },
    FD: { kind: 'Free Download Manager — download manager with BitTorrent', platforms: ['windows', 'macos', 'linux', 'android'],
      device: 'A Windows, Mac or Linux computer, or an Android device.', look: [] },
    FW: { kind: 'FrostWire — BitTorrent program and media player', platforms: ['windows', 'macos', 'linux', 'android'],
      device: 'A computer or an Android device.', look: [] },
    TL: { kind: 'Tribler — BitTorrent program with built-in anonymity (onion routing)', platforms: ['windows', 'macos', 'linux'],
      device: 'A Windows, Mac or Linux computer. Its anonymity feature is worth noting for intent.', look: [] },
    SZ: { kind: 'Shareaza — multi-network P2P program', platforms: ['windows'], device: 'A Windows PC.', look: [] },
    HL: { kind: 'Halite — BitTorrent program', platforms: ['windows'], device: 'A Windows PC.', look: [] },
    XL: { kind: 'Xunlei (Thunder) — Chinese download manager', platforms: ['windows', 'macos', 'android'], device: 'Most often a Windows PC.', look: [] },
    SD: { kind: 'Xunlei (Thunder) — Chinese download manager', platforms: ['windows', 'macos', 'android'], device: 'Most often a Windows PC.', look: [] },
    BN: { kind: 'Baidu Netdisk — Chinese cloud-storage app', platforms: ['windows', 'macos', 'android', 'ios'], device: 'A computer or phone.', look: [] },
    MG: { kind: 'MediaGet — download manager', platforms: ['windows', 'macos', 'android'], device: 'Most often a Windows PC.', look: [] }
  };
  CLIENT_PROFILES.S_ = CLIENT_PROFILES.SZ;
  var PLATFORM_LABELS = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', nas: 'NAS / server', any: 'Any (library)' };

  function clientProfile(code) {
    if (!code) return null;
    var p = CLIENT_PROFILES[code === 'S~' ? 'S_' : code];
    return p ? { code: code, kind: p.kind, platforms: p.platforms.slice(), device: p.device, look: p.look.slice() } : null;
  }

  /**
   * Every client that answered, newest version info first-seen order:
   * [{ code, name, version, tag, label, sessions, handshakes, dataSessions, firstAt, firstRef, peerIds, profile }]
   */
  function clientsSeen(sessions) {
    var by = {}, order = [];
    (sessions || []).forEach(function (x) {
      var lbl = clientLabel(x);
      if (!lbl) return;
      var d = decodeClient(x.clientTag || x.peerId || '');
      var c = by[lbl];
      if (!c) {
        c = by[lbl] = { code: d.code, name: x.clientName || d.name, version: d.version, tag: d.tag, label: lbl,
          sessions: 0, handshakes: 0, dataSessions: 0, firstAt: null, firstRef: null, peerIds: 0, _ids: {}, profile: clientProfile(d.code) };
        order.push(c);
      }
      c.sessions++;
      if (x.handshake) {
        c.handshakes++;
        if (!c.firstAt) { c.firstAt = x.handshakeAt || x.connectedAt || x.attemptAt; c.firstRef = x.ref || null; }
      }
      if ((x.piecesDownloaded || 0) > 0) c.dataSessions++;
      if (x.peerId && !c._ids[x.peerId]) { c._ids[x.peerId] = 1; c.peerIds++; }
    });
    order.forEach(function (c) { delete c._ids; });
    return order.sort(function (a, b) { return (b.dataSessions - a.dataSessions) || (b.handshakes - a.handshakes); });
  }

  // ── Time helpers ───────────────────────────────────────────────────────
  var MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
    september: 9, october: 10, november: 11, december: 12 };
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** "Monday, October 19, 2026 23:37" / "Wednesday, August 17, 2016 10:17:34 AM" → "2026-10-19 23:37[:ss]" */
  function parseLongDate(text) {
    var m = /(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i.exec(String(text || ''));
    if (!m) return null;
    var mo = MONTHS[m[1].toLowerCase()];
    if (!mo) return null;
    var h = +m[4];
    if (m[7]) { var pm = /p/i.test(m[7]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return m[3] + '-' + pad(mo) + '-' + pad(+m[2]) + ' ' + pad(h) + ':' + m[5] + (m[6] ? ':' + m[6] : '');
  }

  /** "GMT-07:00" → -420 */
  function parseGmtOffset(text) {
    var m = /(?:GMT|UTC)\s*([+-])(\d{1,2}):?(\d{2})/i.exec(String(text || ''));
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  }

  function _ms(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
  }
  function _fmt(ms, withSec) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + (withSec === false ? '' : ':' + pad(d.getUTCSeconds()));
  }
  /** local "YYYY-MM-DD HH:MM:SS" + offset minutes → UTC string. */
  function localToUtc(local, offsetMin) {
    var t = _ms(local);
    if (isNaN(t) || offsetMin == null) return null;
    return _fmt(t - offsetMin * 60000);
  }
  function minutesBetween(a, b) {
    var x = _ms(a), y = _ms(b);
    return (isNaN(x) || isNaN(y)) ? null : Math.round((y - x) / 60000);
  }
  function secondsBetween(a, b) {
    var x = _ms(a), y = _ms(b);
    return (isNaN(x) || isNaN(y)) ? null : Math.round((y - x) / 1000);
  }
  function formatDuration(sec) {
    if (sec == null || isNaN(sec)) return '';
    sec = Math.max(0, Math.round(sec));
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    if (d) return d + 'd ' + h + 'h ' + m + 'm';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }

  // ── Session classification / grouping ──────────────────────────────────
  /** Short machine kind for how a session ended. */
  function sessionEndKind(s) {
    if (!s) return 'unknown';
    if (s.result === 'failed') return 'failed';
    var r = (s.endReason || '').toLowerCase();
    if (/rejected encryption/.test(r)) return 'rejected';
    if (/too long without activity/.test(r)) return 'idle';
    if (/reset by the remote client|has been reset/.test(r)) return 'reset';
    if (/has been closed/.test(r)) return 'closed';
    if (/limit/.test(r)) return 'limit';
    return r ? 'other' : 'unknown';
  }

  var END_LABELS = {
    failed: 'No answer (connection failed)',
    rejected: 'Remote ended the connection during encryption',
    idle: 'Dropped for inactivity',
    reset: 'Remote reset the connection',
    closed: 'Connection closed',
    limit: 'Stopped at a program limit',
    other: 'Ended',
    unknown: 'Session (end reason not in this log)'
  };
  function endLabel(kind) { return END_LABELS[kind] || END_LABELS.other; }

  /**
   * Collapse consecutive sessions with the same shape into groups so a
   * 283-attempt download reads as a dozen lines. Sessions that moved data
   * are always their own group.
   */
  function groupSessions(sessions) {
    var groups = [];
    (sessions || []).forEach(function (s) {
      var kind = sessionEndKind(s);
      var data = (s.piecesDownloaded || 0) > 0;
      var key = data ? 'data#' + s.n : (s.result || 'unknown') + ':' + kind + ':' + (s.have != null ? 'h' + s.have : '');
      var g = groups[groups.length - 1];
      if (g && g.key === key) {
        g.sessions.push(s.n); g.last = s; g.count++;
      } else {
        groups.push({ key: key, kind: kind, result: s.result || null, hasData: data, first: s, last: s, count: 1, sessions: [s.n] });
      }
    });
    return groups.map(function (g) {
      return {
        kind: g.kind,
        label: endLabel(g.kind),
        result: g.result,
        hasData: g.hasData,
        count: g.count,
        firstN: g.first.n,
        lastN: g.last.n,
        from: g.first.attemptAt || g.first.connectedAt || null,
        to: g.last.endedAt || g.last.attemptAt || null,
        have: g.first.have != null ? g.first.have : null,
        haveOf: g.first.haveOf != null ? g.first.haveOf : null,
        piecesDownloaded: g.hasData ? (g.first.piecesDownloaded || 0) : 0,
        sessions: g.sessions
      };
    });
  }

  // ── At-a-glance summary ────────────────────────────────────────────────
  function fileStatusCounts(files) {
    var c = { complete: 0, incomplete: 0, none: 0, unknown: 0, total: 0 };
    (files || []).forEach(function (f) {
      if (!f) return;
      c.total++;
      if (f.status === 'complete') c.complete++;
      else if (f.status === 'incomplete') c.incomplete++;
      else if (f.status === 'none') c.none++;
      else c.unknown++;
    });
    return c;
  }

  /** The address an officer should run for subpoena / ARIN. */
  function suspectIp(parsed) {
    var r = (parsed && parsed.remote) || {};
    if (r.identifyIp) return r.identifyIp;
    if (r.teredo && r.teredo.ipv4) return r.teredo.ipv4;
    var t = teredoDecode(r.ip);
    if (t) return t.clientIPv4;
    return r.ip || null;
  }

  function summarize(parsed) {
    parsed = parsed || {};
    var sessions = parsed.sessions || [];
    var closing = parsed.closing || {};
    var torrent = parsed.torrent || {};
    var s = {
      attempts: sessions.length,
      connected: 0, failed: 0, handshakes: 0,
      sessionsWithData: 0, piecesDownloaded: 0,
      firstContact: null, lastContact: null,
      firstDataAt: null,
      clients: [], ourIps: [],
      maxHave: null, haveOf: torrent.pieceCount || null,
      acknowledgedAllNoData: false
    };
    var clients = {}, ours = {};
    sessions.forEach(function (x) {
      if (x.result === 'connected') s.connected++;
      else if (x.result === 'failed') s.failed++;
      if (x.handshake) {
        s.handshakes++;
        var when = x.connectedAt || x.attemptAt;
        if (!s.firstContact) s.firstContact = when;
        s.lastContact = x.endedAt || when;
      }
      if ((x.piecesDownloaded || 0) > 0) {
        s.sessionsWithData++;
        s.piecesDownloaded += x.piecesDownloaded;
        if (!s.firstDataAt) s.firstDataAt = x.connectedAt || x.attemptAt;
      }
      if (x.have != null && (s.maxHave == null || x.have > s.maxHave)) s.maxHave = x.have;
      if (x.haveOf != null) s.haveOf = x.haveOf;
      var lbl = clientLabel(x);
      if (lbl) clients[lbl] = (clients[lbl] || 0) + 1;
      if (x.ourIp) ours[x.ourIp] = (ours[x.ourIp] || 0) + 1;
    });
    s.clients = Object.keys(clients).map(function (k) { return { label: k, sessions: clients[k] }; });
    s.ourIps = Object.keys(ours).map(function (k) { return { ip: k, sessions: ours[k] }; });

    // Prefer the tool's own closing totals when present.
    var written = closing.writtenRanges != null ? countRanges(closing.writtenRanges)
      : (closing.definedWritten ? closing.definedWritten.n : null);
    s.piecesWritten = written != null ? written : s.piecesDownloaded;
    s.acknowledged = closing.acknowledged ? closing.acknowledged.n
      : (closing.acknowledgedRanges != null ? countRanges(closing.acknowledgedRanges) : s.maxHave);
    s.files = fileStatusCounts(parsed.files);
    s.filesReportedComplete = closing.filesReported || null;
    s.hashesValid = closing.validation ? !!closing.validation.allValid : null;
    s.validationFailures = closing.validation && closing.validation.failures ? closing.validation.failures.length : 0;
    s.endReason = (closing.limits && closing.limits[0]) || closing.stopReason || null;
    s.outcome = closing.outcome || null;
    s.suspectIp = suspectIp(parsed);
    s.port = parsed.remote ? parsed.remote.port : null;
    s.acknowledgedAllNoData = s.handshakes > 0 && s.piecesWritten === 0 && s.acknowledged != null &&
      s.haveOf != null && s.acknowledged >= s.haveOf;
    s.durationSec = secondsBetween(parsed.download && parsed.download.startedAt, parsed.download && parsed.download.endedAt);
    return s;
  }

  // ── Netstat corroboration ──────────────────────────────────────────────
  function netstatSummary(parsed) {
    var blocks = (parsed && parsed.netstat) || [];
    var ip = parsed && parsed.remote ? parsed.remote.ip : null;
    var out = { blocks: blocks.length, withRemote: 0, established: 0, first: null, last: null };
    blocks.forEach(function (b) {
      var hit = (b.matches || []).length > 0;
      if (hit) {
        out.withRemote++;
        if (b.matches.some(function (m) { return /ESTABLISHED/i.test(m.state || ''); })) out.established++;
        if (!out.first) out.first = b.at;
        out.last = b.at;
      }
    });
    out.remoteIp = ip;
    return out;
  }

  return {
    parseRanges: parseRanges, normalizeRanges: normalizeRanges, countRanges: countRanges,
    formatRanges: formatRanges, rangesFromList: rangesFromList, missingRanges: missingRanges,
    expandIPv6: expandIPv6, isIPv6: isIPv6, teredoDecode: teredoDecode,
    peerIdPrefix: peerIdPrefix, decodeClient: decodeClient, clientLabel: clientLabel, CLIENTS: CLIENTS,
    clientProfile: clientProfile, clientsSeen: clientsSeen, PLATFORM_LABELS: PLATFORM_LABELS,
    parseLongDate: parseLongDate, parseGmtOffset: parseGmtOffset, localToUtc: localToUtc,
    minutesBetween: minutesBetween, secondsBetween: secondsBetween, formatDuration: formatDuration,
    sessionEndKind: sessionEndKind, endLabel: endLabel, groupSessions: groupSessions,
    fileStatusCounts: fileStatusCounts, suspectIp: suspectIp, summarize: summarize,
    netstatSummary: netstatSummary
  };
});
