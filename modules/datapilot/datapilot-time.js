/**
 * DataPilot time + device-identity helpers.
 *
 * Loaded in BOTH processes:
 *   - main:     require('./datapilot-time') from datapilot-parser.js
 *   - renderer: <script src="modules/datapilot/datapilot-time.js"> → window.DatapilotTime
 *
 * WHY THIS EXISTS
 * DataPilot 10 (dptData.db) stores two kinds of datetime column:
 *   - columns whose name ends in "Utc" (Files.LastModifiedUtc) are true UTC;
 *   - plain columns (Messages.DateTime, CallHistory.DateTime,
 *     Chats.MessageDateTime, Files.LastModifiedLocal / DateTimeTaken,
 *     Calendar.Start/EndDateTime) are the DEVICE'S OWN WALL-CLOCK time with
 *     no zone marker.
 * Measured on three real extractions: LastModifiedLocal − LastModifiedUtc is
 * exactly the device offset, and DeviceInfo.ClockLocalDateTime is written
 * with a fake "Z". VIPER used to read the plain columns as UTC, so a message
 * sent at 20:30 Mountain showed as 2:30 PM in the thread.
 *
 * The fix: read a plain value as wall time IN THE DEVICE'S TIME ZONE
 * (DeviceInfo.TimeZone, e.g. "America/Denver", DST-aware). If the extraction
 * has no usable zone, fall back to a fixed offset taken from the device's two
 * clock readings, and failing that, to the examiner's own zone.
 *
 * Separately, DataPilot's DeviceInfo.PhoneNumber holds the IMEI on every
 * extraction measured; the subscriber number is in MDN. cleanIdentity() keeps
 * a hardware identifier out of the Phone Number field.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.DatapilotTime = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Bump when repairImport() learns a new correction. Imports parsed by a
    // parser that already applies the corrections are stamped with this too.
    var TIME_FIX_VERSION = 1;

    // Windows-style zone names some tools write instead of IANA ids.
    var WINDOWS_ZONES = {
        'eastern standard time': 'America/New_York',
        'central standard time': 'America/Chicago',
        'mountain standard time': 'America/Denver',
        'us mountain standard time': 'America/Phoenix',
        'pacific standard time': 'America/Los_Angeles',
        'alaskan standard time': 'America/Anchorage',
        'hawaiian standard time': 'Pacific/Honolulu',
        'atlantic standard time': 'America/Halifax',
        'utc': 'UTC',
        'gmt standard time': 'Europe/London',
    };

    var _fmtCache = {};

    function _validTz(tz) {
        if (!tz || typeof tz !== 'string') return false;
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
    }

    function _fmtFor(tz) {
        if (!_fmtCache[tz]) {
            _fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
                timeZone: tz, hourCycle: 'h23',
                year: 'numeric', month: 'numeric', day: 'numeric',
                hour: 'numeric', minute: 'numeric', second: 'numeric',
            });
        }
        return _fmtCache[tz];
    }

    /** Offset of `tz` from UTC at instant `ms`, in minutes (Denver summer → -360). */
    function tzOffsetMinutes(ms, tz) {
        var parts = _fmtFor(tz).formatToParts(new Date(ms));
        var p = {};
        for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
        var hour = Number(p.hour) === 24 ? 0 : Number(p.hour);
        var asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
        var whole = ms - (((ms % 1000) + 1000) % 1000);
        return Math.round((asUtc - whole) / 60000);
    }

    /** "+05:30" / "-0700" / "UTC-6" / "GMT-06:00" → minutes, or null. */
    function _parseOffsetString(s) {
        var m = String(s || '').trim().match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
        if (!m) return null;
        var mins = Number(m[2]) * 60 + Number(m[3] || 0);
        if (mins > 14 * 60) return null;
        return m[1] === '-' ? -mins : mins;
    }

    function _clockMs(v) {
        if (!v) return NaN;
        var s = String(v).trim().replace(' ', 'T');
        if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
        return Date.parse(s);
    }

    /**
     * Work out the device's zone from a DataPilot DeviceInfo — either the raw
     * JSON (TimeZone / ClockLocalDateTime / ClockUTCDateTime) or VIPER's
     * projected shape (timeZone / clockLocal / clockUtc).
     * Returns { tz, offsetMin, source } or null.
     */
    function zoneFromDevice(dev) {
        if (!dev || typeof dev !== 'object') return null;
        var tzRaw = String(dev.timeZone || dev.TimeZone || dev['Time Zone'] || '').trim();
        if (tzRaw) {
            if (tzRaw.indexOf('/') > 0 || /^utc$/i.test(tzRaw)) {
                if (_validTz(tzRaw)) return { tz: tzRaw, offsetMin: null, source: 'timezone' };
            }
            var win = WINDOWS_ZONES[tzRaw.toLowerCase()];
            if (win && _validTz(win)) return { tz: win, offsetMin: null, source: 'timezone' };
            var off = _parseOffsetString(tzRaw);
            if (off !== null) return { tz: null, offsetMin: off, source: 'timezone-offset' };
        }
        var local = _clockMs(dev.clockLocal || dev.ClockLocalDateTime);
        var utc = _clockMs(dev.clockUtc || dev.ClockUTCDateTime);
        if (isFinite(local) && isFinite(utc)) {
            var diff = Math.round((local - utc) / 60000 / 15) * 15;
            if (Math.abs(diff) <= 14 * 60) return { tz: null, offsetMin: diff, source: 'device-clock' };
        }
        return null;
    }

    var NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;

    /**
     * Read a DataPilot wall-clock value as the device would have shown it and
     * return the true instant as an ISO-8601 UTC string.
     *   zone = { tz }        → IANA zone, DST-correct
     *   zone = { offsetMin } → fixed offset
     *   zone = null          → the examiner's own zone (best remaining guess)
     *   opts.floating        → all-day calendar dates: always examiner-local
     *                           midnight so the DATE displays unchanged.
     * Values that already carry "Z" or an offset are honoured as written.
     * DataPilot's 0001-01-01 "no value" sentinel returns ''.
     */
    function deviceLocalToIso(value, zone, opts) {
        if (value == null || value === '') return '';
        var str = String(value).trim();
        if (!str) return '';
        var m = str.match(NAIVE_RE);
        if (!m) {
            // Already zoned (or some other shape) — keep the old behaviour.
            var d0 = new Date(str);
            return isNaN(d0.getTime()) ? '' : d0.toISOString();
        }
        var y = Number(m[1]);
        if (y <= 1) return '';
        var mo = Number(m[2]) - 1, d = Number(m[3]);
        var h = Number(m[4] || 0), mi = Number(m[5] || 0), s = Number(m[6] || 0);
        var ms = m[7] ? Math.floor(Number(('0.' + m[7]).slice(0, 5)) * 1000) : 0;

        var t;
        var floating = !!(opts && opts.floating);
        if (!floating && zone && zone.tz && _validTz(zone.tz)) {
            var guess = Date.UTC(y, mo, d, h, mi, s, ms);
            var off1 = tzOffsetMinutes(guess, zone.tz);
            t = guess - off1 * 60000;
            var off2 = tzOffsetMinutes(t, zone.tz);
            if (off2 !== off1) t = guess - off2 * 60000;
        } else if (!floating && zone && typeof zone.offsetMin === 'number' && isFinite(zone.offsetMin)) {
            t = Date.UTC(y, mo, d, h, mi, s, ms) - zone.offsetMin * 60000;
        } else {
            var local = new Date(y, mo, d, h, mi, s, ms);
            if (y < 100) local.setFullYear(y);
            t = local.getTime();
        }
        if (!isFinite(t)) return '';
        var out = new Date(t);
        return isNaN(out.getTime()) ? '' : out.toISOString();
    }

    // ── Device identity ───────────────────────────────────────────────

    function _digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

    function _luhnOk(digits) {
        var sum = 0, dbl = false;
        for (var i = digits.length - 1; i >= 0; i--) {
            var n = digits.charCodeAt(i) - 48;
            if (dbl) { n *= 2; if (n > 9) n -= 9; }
            sum += n; dbl = !dbl;
        }
        return sum % 10 === 0;
    }

    /** A 15-digit Luhn-valid number written without "+": the shape of an IMEI. */
    function looksLikeImei(v) {
        var s = String(v == null ? '' : v).trim();
        if (!s || s.charAt(0) === '+') return false;
        var d = _digits(s);
        return d.length === 15 && _luhnOk(d);
    }

    /**
     * Is this value plausibly a subscriber phone number rather than a hardware
     * or SIM identifier? `hardwareIds` are the device's IMEI/ICCID/IMSI/ESN/
     * serial values; a candidate equal to any of them is rejected outright.
     */
    function isPlausiblePhone(v, hardwareIds) {
        var s = String(v == null ? '' : v).trim();
        if (!s) return false;
        var d = _digits(s);
        if (d.length < 7) return false;
        var ids = hardwareIds || [];
        for (var i = 0; i < ids.length; i++) {
            var h = _digits(ids[i]);
            if (h && h.length >= 7 && h === d) return false;
        }
        // E.164 allows 15 digits, but a bare 14+ digit string with no "+" is an
        // IMEI (15), MEID (14), IMSI (15) or ICCID (19-20) — never a dialable
        // number as DataPilot writes them.
        if (s.charAt(0) !== '+' && d.length >= 14) return false;
        if (d.length > 15) return false;
        return true;
    }

    /**
     * From a raw DataPilot DeviceInfo object, return
     * { phoneNumber, imei, osVersion }. Phone number prefers PhoneNumber,
     * then MDN / MSISDN / MIN, skipping any that is really a hardware id.
     */
    function cleanIdentity(raw) {
        raw = raw || {};
        var get = function () {
            for (var i = 0; i < arguments.length; i++) {
                var v = raw[arguments[i]];
                if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
            }
            return '';
        };
        var imei = get('IMEI', 'IMEI/MEID', 'MEID', 'Imei');
        var hw = [imei, get('ICCID'), get('IMSI'), get('ESN'), get('SerialNumber', 'Serial Number', 'Serial'), get('MEID')];
        var candidates = [get('PhoneNumber', 'Phone Number'), get('MDN'), get('MSISDN'), get('MIN')];
        var phone = '';
        for (var i = 0; i < candidates.length; i++) {
            if (isPlausiblePhone(candidates[i], hw)) { phone = candidates[i]; break; }
        }
        // A phone-number field holding an IMEI with no IMEI field: keep it as IMEI.
        if (!imei) {
            var pn = get('PhoneNumber', 'Phone Number');
            if (pn && looksLikeImei(pn)) imei = pn;
        }
        return {
            phoneNumber: phone,
            imei: imei,
            osVersion: get('SoftwareVersion', 'OSVersion', 'OS Version', 'OS', 'AndroidVersion'),
        };
    }

    // ── Repair of imports stored by older VIPER builds ────────────────

    function _oldIsoToWall(iso) {
        // Old builds wrote naive device time with a "Z" glued on, so the UTC
        // fields of the stored ISO ARE the device's wall-clock reading.
        var m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/);
        return m ? m[1] + ' ' + m[2] : null;
    }

    function _refix(iso, zone, opts) {
        var wall = _oldIsoToWall(iso);
        if (!wall) return iso;
        return deviceLocalToIso(wall, zone, opts) || iso;
    }

    function _isAppMessengerUid(uid) {
        return /^(wa_|wam_|wacall_)/.test(String(uid || ''));
    }

    /**
     * Correct a DataPilot import stored by an older VIPER build, in place.
     * Idempotent: stamps imp.timeFixVersion and does nothing on a second run.
     * Returns true when anything changed (caller should save).
     *
     * Only DPX imports had the time bug (the CSV reader already read local
     * time). WhatsApp records are genuinely UTC in DataPilot and are skipped.
     */
    function repairImport(imp) {
        if (!imp || typeof imp !== 'object') return false;
        var changed = false;

        // Identity — applies to every format.
        var dev = imp.deviceInfo;
        if (dev && typeof dev === 'object') {
            var pn = String(dev.phoneNumber || '').trim();
            if (pn && !isPlausiblePhone(pn, [dev.imei, dev.serial])) {
                if (!dev.imei && looksLikeImei(pn)) dev.imei = pn;
                dev.phoneNumber = '';
                changed = true;
            }
        }

        if ((imp.timeFixVersion || 0) >= TIME_FIX_VERSION) return changed;
        imp.timeFixVersion = TIME_FIX_VERSION;
        changed = true;
        if (imp.format !== 'dpx') return changed;

        var zone = zoneFromDevice(dev);
        var i, r;
        var msgs = Array.isArray(imp.messages) ? imp.messages : [];
        for (i = 0; i < msgs.length; i++) {
            r = msgs[i];
            if (!r || _isAppMessengerUid(r.uid)) continue;
            if (r.timestampIso) r.timestampIso = _refix(r.timestampIso, zone);
        }
        var calls = Array.isArray(imp.calls) ? imp.calls : [];
        for (i = 0; i < calls.length; i++) {
            r = calls[i];
            if (!r || _isAppMessengerUid(r.uid)) continue;
            if (r.timestampIso) r.timestampIso = _refix(r.timestampIso, zone);
        }
        var chats = Array.isArray(imp.chats) ? imp.chats : [];
        for (i = 0; i < chats.length; i++) {
            r = chats[i];
            if (r && r.lastMessageAt) r.lastMessageAt = _refix(r.lastMessageAt, zone);
        }
        var cal = Array.isArray(imp.calendar) ? imp.calendar : [];
        for (i = 0; i < cal.length; i++) {
            r = cal[i];
            if (!r) continue;
            var o = { floating: !!r.allDay };
            if (r.start) r.start = _refix(r.start, zone, o);
            if (r.end) r.end = _refix(r.end, zone, o);
        }
        var lists = [imp.media, imp.files];
        for (var L = 0; L < lists.length; L++) {
            var arr = Array.isArray(lists[L]) ? lists[L] : [];
            for (i = 0; i < arr.length; i++) {
                r = arr[i];
                if (!r) continue;
                if (r.lastModified) r.lastModified = _refix(r.lastModified, zone);
                if (r.dateTaken) r.dateTaken = _refix(r.dateTaken, zone);
            }
        }
        var exif = imp.photoExifByHash && typeof imp.photoExifByHash === 'object' ? imp.photoExifByHash : {};
        for (var k in exif) {
            if (Object.prototype.hasOwnProperty.call(exif, k) && exif[k] && exif[k].dateTaken) {
                exif[k].dateTaken = _refix(exif[k].dateTaken, zone);
            }
        }
        return changed;
    }

    /** Examiner-local calendar day "YYYY-MM-DD" for an ISO instant. */
    function localDayKey(v) {
        if (!v) return '';
        var s = String(v);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        var d = new Date(s);
        if (isNaN(d.getTime())) return s.split('T')[0];
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    return {
        TIME_FIX_VERSION: TIME_FIX_VERSION,
        tzOffsetMinutes: tzOffsetMinutes,
        zoneFromDevice: zoneFromDevice,
        deviceLocalToIso: deviceLocalToIso,
        looksLikeImei: looksLikeImei,
        isPlausiblePhone: isPlausiblePhone,
        cleanIdentity: cleanIdentity,
        repairImport: repairImport,
        localDayKey: localDayKey,
    };
}));
