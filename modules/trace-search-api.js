/**
 * TRACE Network Search — API service for VIPER
 *
 * Allows VIPER law enforcement users (lifetime license) to search the
 * TRACE broker network for matches against investigation tokens.
 *
 * Token hashing uses the EXACT same SHA-256 algorithm as the TRACE desktop
 * app (networkSync.js) so hashes match what's stored in the broker DB.
 *
 * Token types recognised by broker:
 *   Tier 1 (exact): vehicle_plate | suspect_exact | cargo_mc | cargo_dl | cargo_trailer | serial_number
 *   Tier 2 (fuzzy): vehicle_desc  | suspect_desc  | target_type | geo_zone
 */
const TraceSearch = (function () {
  'use strict';

  const BROKER_URL = 'https://trace-broker-production.up.railway.app';
  const STORAGE_PREFIX = 'traceSearch_';
  const MAX_AUDIT_ENTRIES = 500;
  const MAX_ACTIVITY_ENTRIES = 50;

  /* ── localStorage helpers ──────────────────────────────────── */
  function _get(key) { return localStorage.getItem(STORAGE_PREFIX + key); }
  function _set(key, v) { localStorage.setItem(STORAGE_PREFIX + key, v); }
  function _remove(key) { localStorage.removeItem(STORAGE_PREFIX + key); }

  /* ── SHA-256 (Web Crypto, same as TRACE desktop) ───────────── */
  async function sha256(str) {
    const data = new TextEncoder().encode(String(str).toLowerCase().trim());
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function tok(hash, type, tier, caseType) {
    return { token_hash: hash, token_type: type, tier, case_type: caseType || 'cargo' };
  }

  /* ── Placeholder guard (same regex as TRACE desktop) ───────── */
  const PLACEHOLDER_RE = /^(unknown|unkn|unk|u\/k|n\/a|na|none|null|nil|tbd|tbf|-+|\.+|x+|0+)$/i;
  function isPlaceholder(val) {
    if (!val) return true;
    const s = String(val).trim();
    if (s.length === 0) return true;
    return PLACEHOLDER_RE.test(s);
  }

  /* ── Status helpers ────────────────────────────────────────── */
  function isEnabled() {
    return _get('enabled') === 'true';
  }

  function isRegistered() {
    return !!_get('apiKey');
  }

  function connectionStatus() {
    return {
      enabled: isEnabled(),
      registered: isRegistered(),
      agency: _get('agency') || '',
      userName: _get('userName') || '',
    };
  }

  /* ── Broker HTTP helpers ───────────────────────────────────── */
  async function brokerPost(path, body) {
    const apiKey = _get('apiKey');
    const url = BROKER_URL + path;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-Api-Key'] = apiKey;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`TRACE Broker ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async function brokerGet(path) {
    const apiKey = _get('apiKey');
    const url = BROKER_URL + path;
    const res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`TRACE Broker ${res.status}: ${txt}`);
    }
    return res.json();
  }

  /* ── Registration ──────────────────────────────────────────── */
  async function register(name, email, agency, city, state, zipCode, viperLicenseKey, viperApiKey) {
    const result = await brokerPost('/api/le/register', {
      name, email, agency, city, state, zip_code: zipCode,
      viper_license_key: viperLicenseKey,
      viper_api_key: viperApiKey,
    });

    if (result.success) {
      _set('apiKey', result.api_key);
      _set('storeId', result.store_id);
      _set('userName', name);
      _set('agency', agency);
      _set('email', email);
      logActivity('registration', `Registered as LE: ${agency}`);
    }
    return result;
  }

  /* ── License check ─────────────────────────────────────────── */
  async function checkStatus() {
    return brokerGet('/api/license/status');
  }

  /* ── Token extraction — mirrors TRACE desktop networkSync.js ─ */

  /**
   * Extract tokens from manual search form input.
   * Each value is hashed identically to how TRACE desktop does it.
   */
  async function extractManualTokens(fields) {
    const tokens = [];
    const ct = 'cargo';

    // License plate
    if (fields.plate && !isPlaceholder(fields.plate)) {
      const key = fields.plateState
        ? `${fields.plate.toUpperCase()}:${fields.plateState.toUpperCase()}`
        : fields.plate.toUpperCase();
      tokens.push(tok(await sha256(key), 'vehicle_plate', 1, ct));
    }

    // VIN
    if (fields.vin && !isPlaceholder(fields.vin)) {
      tokens.push(tok(await sha256(fields.vin.toUpperCase()), 'vehicle_plate', 1, ct));
    }

    // Name (first + last = suspect_exact, same as TRACE: "FIRST LAST")
    if (fields.firstName && fields.lastName && !isPlaceholder(fields.firstName) && !isPlaceholder(fields.lastName)) {
      const nameKey = `${fields.firstName.trim()} ${fields.lastName.trim()}`.toUpperCase();
      tokens.push(tok(await sha256(nameKey), 'suspect_exact', 1, ct));
    }

    // BOL number
    if (fields.bol && !isPlaceholder(fields.bol)) {
      tokens.push(tok(await sha256(fields.bol), 'cargo_trailer', 1, ct));
    }

    // MC number
    if (fields.mc && !isPlaceholder(fields.mc)) {
      tokens.push(tok(await sha256(fields.mc), 'cargo_mc', 1, ct));
    }

    // CDL number
    if (fields.cdl && !isPlaceholder(fields.cdl)) {
      tokens.push(tok(await sha256(fields.cdl), 'cargo_dl', 1, ct));
    }

    // Trailer number
    if (fields.trailerNumber && !isPlaceholder(fields.trailerNumber)) {
      tokens.push(tok(await sha256(fields.trailerNumber), 'cargo_trailer', 1, ct));
    }

    // Trailer plate
    if (fields.trailerPlate && !isPlaceholder(fields.trailerPlate)) {
      tokens.push(tok(await sha256(fields.trailerPlate.toUpperCase()), 'vehicle_plate', 1, ct));
    }

    return dedup(tokens);
  }

  /**
   * Extract tokens from VIPER cargo module items.
   * Mirrors TRACE desktop's cargo token extraction.
   */
  async function extractCargoTokens(cargoItems) {
    const tokens = [];
    const ct = 'cargo';

    for (const item of (cargoItems || [])) {
      if (item.mcNumber && !isPlaceholder(item.mcNumber))
        tokens.push(tok(await sha256(item.mcNumber), 'cargo_mc', 1, ct));
      if (item.cdlNumber && !isPlaceholder(item.cdlNumber))
        tokens.push(tok(await sha256(item.cdlNumber), 'cargo_dl', 1, ct));
      if (item.trailerNumber && !isPlaceholder(item.trailerNumber))
        tokens.push(tok(await sha256(item.trailerNumber), 'cargo_trailer', 1, ct));
      if (item.trailerPlate && !isPlaceholder(item.trailerPlate))
        tokens.push(tok(await sha256(item.trailerPlate.toUpperCase()), 'vehicle_plate', 1, ct));
      if (item.bolNumber && !isPlaceholder(item.bolNumber))
        tokens.push(tok(await sha256(item.bolNumber), 'cargo_trailer', 1, ct));

      // Vehicle descriptors from cargo
      if (item.vehicleMake && !isPlaceholder(item.vehicleMake))
        tokens.push(tok(await sha256('make:' + item.vehicleMake), 'vehicle_desc', 2, ct));
      if (item.vehicleColor && !isPlaceholder(item.vehicleColor))
        tokens.push(tok(await sha256('color:' + item.vehicleColor), 'vehicle_desc', 2, ct));
    }

    return dedup(tokens);
  }

  /**
   * Extract tokens from imported TRACE case data.
   * TRACE imports store data in localStorage as viperTraceImports or rmsImports_.
   * The TRACE JSON has vehicles, suspects, merchandise, cargo objects.
   */
  async function extractTraceImportTokens(traceData) {
    const tokens = [];
    const ct = traceData.case_type || 'retail';

    // Vehicles
    for (const v of (traceData.vehicles || [])) {
      if (v.plate && !isPlaceholder(v.plate)) {
        const key = v.plate_state
          ? `${v.plate.toUpperCase()}:${v.plate_state.toUpperCase()}`
          : v.plate.toUpperCase();
        tokens.push(tok(await sha256(key), 'vehicle_plate', 1, ct));
      }
      if (v.vin && !isPlaceholder(v.vin))
        tokens.push(tok(await sha256(v.vin.toUpperCase()), 'vehicle_plate', 1, ct));
      if (v.make && !isPlaceholder(v.make))
        tokens.push(tok(await sha256('make:' + v.make), 'vehicle_desc', 2, ct));
      if (v.color && !isPlaceholder(v.color))
        tokens.push(tok(await sha256('color:' + v.color), 'vehicle_desc', 2, ct));
      if (v.model && !isPlaceholder(v.model))
        tokens.push(tok(await sha256('model:' + v.model), 'vehicle_desc', 2, ct));
    }

    // Suspects
    for (const s of (traceData.suspects || [])) {
      if (s.name && !isPlaceholder(s.name))
        tokens.push(tok(await sha256(s.name.toUpperCase()), 'suspect_exact', 1, ct));
      if (s.first_name && s.last_name && !isPlaceholder(s.first_name) && !isPlaceholder(s.last_name)) {
        const nameKey = `${s.first_name.trim()} ${s.last_name.trim()}`.toUpperCase();
        tokens.push(tok(await sha256(nameKey), 'suspect_exact', 1, ct));
      }
      if (s.race && !isPlaceholder(s.race))
        tokens.push(tok(await sha256('race:' + s.race), 'suspect_desc', 2, ct));
      if (s.sex && !isPlaceholder(s.sex))
        tokens.push(tok(await sha256('sex:' + s.sex), 'suspect_desc', 2, ct));
      if (s.hair && !isPlaceholder(s.hair))
        tokens.push(tok(await sha256('hair:' + s.hair), 'suspect_desc', 2, ct));
    }

    // Merchandise (serial numbers)
    for (const m of (traceData.merchandise || [])) {
      if (m.serial_number && !isPlaceholder(m.serial_number))
        tokens.push(tok(await sha256(m.serial_number), 'serial_number', 1, ct));
    }

    // Cargo
    if (traceData.cargo) {
      const cg = traceData.cargo;
      if (cg.mc_number && !isPlaceholder(cg.mc_number))
        tokens.push(tok(await sha256(cg.mc_number), 'cargo_mc', 1, ct));
      if (cg.cdl_number && !isPlaceholder(cg.cdl_number))
        tokens.push(tok(await sha256(cg.cdl_number), 'cargo_dl', 1, ct));
      if (cg.trailer_number && !isPlaceholder(cg.trailer_number))
        tokens.push(tok(await sha256(cg.trailer_number), 'cargo_trailer', 1, ct));
      if (cg.trailer_plate && !isPlaceholder(cg.trailer_plate))
        tokens.push(tok(await sha256(cg.trailer_plate.toUpperCase()), 'vehicle_plate', 1, ct));
      if (cg.bol_number && !isPlaceholder(cg.bol_number))
        tokens.push(tok(await sha256(cg.bol_number), 'cargo_trailer', 1, ct));
    }

    return dedup(tokens);
  }

  /**
   * Extract tokens from VIPER case suspects module data.
   */
  async function extractSuspectTokens(suspects) {
    const tokens = [];
    const ct = 'cargo';

    for (const s of (suspects || [])) {
      // Name
      const first = s.firstName || s.first_name || '';
      const last = s.lastName || s.last_name || '';
      if (first && last && !isPlaceholder(first) && !isPlaceholder(last)) {
        tokens.push(tok(await sha256(`${first.trim()} ${last.trim()}`.toUpperCase()), 'suspect_exact', 1, ct));
      }
      // DL
      if (s.driversLicense && !isPlaceholder(s.driversLicense))
        tokens.push(tok(await sha256(s.driversLicense), 'cargo_dl', 1, ct));
      // Vehicle plate from suspect
      if (s.vehiclePlate && !isPlaceholder(s.vehiclePlate))
        tokens.push(tok(await sha256(s.vehiclePlate.toUpperCase()), 'vehicle_plate', 1, ct));
    }

    return dedup(tokens);
  }

  /**
   * Extract tokens from VIPER recovered vehicles module data.
   */
  async function extractVehicleTokens(vehicles) {
    const tokens = [];
    const ct = 'cargo';

    for (const v of (vehicles || [])) {
      const plate = v.licensePlate || v.plate || '';
      if (plate && !isPlaceholder(plate)) {
        const key = v.state ? `${plate.toUpperCase()}:${v.state.toUpperCase()}` : plate.toUpperCase();
        tokens.push(tok(await sha256(key), 'vehicle_plate', 1, ct));
      }
      if (v.vin && !isPlaceholder(v.vin))
        tokens.push(tok(await sha256(v.vin.toUpperCase()), 'vehicle_plate', 1, ct));
      if (v.make && !isPlaceholder(v.make))
        tokens.push(tok(await sha256('make:' + v.make), 'vehicle_desc', 2, ct));
      if (v.color && !isPlaceholder(v.color))
        tokens.push(tok(await sha256('color:' + v.color), 'vehicle_desc', 2, ct));
      if (v.model && !isPlaceholder(v.model))
        tokens.push(tok(await sha256('model:' + v.model), 'vehicle_desc', 2, ct));
    }

    return dedup(tokens);
  }

  /* ── Deduplication ─────────────────────────────────────────── */
  function dedup(tokens) {
    const seen = new Set();
    return tokens.filter(t => {
      const key = t.token_hash + t.token_type;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /* ── Search (match) ────────────────────────────────────────── */
  async function search(tokens, caseRef, reason, searchType) {
    if (!tokens || tokens.length === 0) {
      return { match_count: 0, matches: [] };
    }

    const result = await brokerPost('/api/tokens/match', {
      case_ref: caseRef || 'VIPER-SEARCH',
      tokens,
      radius_miles: 250,
      search_reason: reason || '',
      search_type: searchType || 'manual',
    });

    // Audit log
    logAudit({
      searchType: searchType || 'manual',
      reason: reason || '',
      tokenCount: tokens.length,
      matchCount: result.match_count || 0,
      matchSummary: (result.matches || []).map(m => ({
        store: m.store_name,
        confidence: m.confidence,
        caseRef: m.case_ref,
      })),
    });

    logActivity(searchType || 'manual', `Searched ${tokens.length} tokens → ${result.match_count} match(es)`);

    return result;
  }

  /* ── Audit log ─────────────────────────────────────────────── */
  function logAudit(entry) {
    const log = JSON.parse(localStorage.getItem('traceSearchAuditLog') || '[]');
    log.unshift({
      timestamp: new Date().toISOString(),
      userName: _get('userName') || 'Unknown',
      agency: _get('agency') || '',
      ...entry,
    });
    // Cap at MAX_AUDIT_ENTRIES
    if (log.length > MAX_AUDIT_ENTRIES) log.length = MAX_AUDIT_ENTRIES;
    localStorage.setItem('traceSearchAuditLog', JSON.stringify(log));
  }

  function getAuditLog() {
    return JSON.parse(localStorage.getItem('traceSearchAuditLog') || '[]');
  }

  function clearAuditLog() {
    localStorage.setItem('traceSearchAuditLog', '[]');
  }

  /* ── Activity log ──────────────────────────────────────────── */
  function logActivity(type, description) {
    const log = JSON.parse(localStorage.getItem('traceSearchActivityLog') || '[]');
    log.unshift({ type, description, timestamp: new Date().toISOString() });
    if (log.length > MAX_ACTIVITY_ENTRIES) log.length = MAX_ACTIVITY_ENTRIES;
    localStorage.setItem('traceSearchActivityLog', JSON.stringify(log));
  }

  function getActivityLog() {
    return JSON.parse(localStorage.getItem('traceSearchActivityLog') || '[]');
  }

  /* ── Disconnect ────────────────────────────────────────────── */
  function disconnect() {
    _remove('apiKey');
    _remove('storeId');
    _remove('userName');
    _remove('agency');
    _remove('email');
    _remove('enabled');
    logActivity('disconnect', 'Disconnected from TRACE Network');
  }

  /* ── Public API ────────────────────────────────────────────── */
  return {
    isEnabled,
    isRegistered,
    connectionStatus,
    register,
    checkStatus,
    search,
    extractManualTokens,
    extractCargoTokens,
    extractTraceImportTokens,
    extractSuspectTokens,
    extractVehicleTokens,
    getAuditLog,
    clearAuditLog,
    getActivityLog,
    disconnect,
    // Expose for testing
    sha256,
    isPlaceholder,
  };
})();
