/**
 * GenLogs Cargo Intelligence API Service
 * Handles authentication, token lifecycle, and all endpoint calls.
 * All methods check genlogsEnabled before executing.
 *
 * Working endpoints (current account): /auth/token, /carrier/profile, /carrier/recommendations
 * 403 endpoints (need upgraded plan): /compliance-rules, /carrier/contacts, /facilities, /alerts
 */
const GenLogs = (() => {
    const BASE = 'https://api.genlogs.io';

    // ── Helpers ──────────────────────────────────────────────────────────
    function isEnabled() {
        return localStorage.getItem('genlogsEnabled') === 'true';
    }

    function getStored(key) {
        return localStorage.getItem(key) || '';
    }

    function getCredentials() {
        return {
            apiKey: getStored('genlogsApiKey'),
            email: getStored('genlogsEmail'),
            password: getStored('genlogsPassword')
        };
    }

    function getToken() {
        const token = getStored('genlogsToken');
        const expiry = getStored('genlogsTokenExpiry');
        if (!token || !expiry) return null;
        // Refresh 5 min before expiry
        if (new Date(expiry).getTime() - Date.now() < 5 * 60 * 1000) return null;
        return token;
    }

    function saveToken(data) {
        localStorage.setItem('genlogsToken', data.access_token_data.token);
        localStorage.setItem('genlogsTokenExpiry', data.access_token_data.expires);
    }

    function logActivity(type, target, summary) {
        try {
            const log = JSON.parse(localStorage.getItem('genlogsActivityLog') || '[]');
            log.unshift({ timestamp: new Date().toISOString(), type, target, summary });
            // Keep last 50
            if (log.length > 50) log.length = 50;
            localStorage.setItem('genlogsActivityLog', JSON.stringify(log));
        } catch (e) { /* ignore */ }
    }

    // ── IPC Proxy (avoids CORS — calls go through Electron main process) ─
    async function proxyFetch(url, opts = {}) {
        // Use Electron IPC if available, fall back to fetch for non-Electron envs
        if (window.electronAPI?.genlogsRequest) {
            return window.electronAPI.genlogsRequest({
                method: opts.method || 'GET',
                url,
                headers: opts.headers || {},
                body: opts.body || null
            });
        }
        // Fallback for browser testing (won't work due to CORS, but keeps module portable)
        const res = await fetch(url, opts);
        const body = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, body };
    }

    // ── Authentication ───────────────────────────────────────────────────
    async function authenticate(creds) {
        const { apiKey, email, password } = creds || getCredentials();
        if (!apiKey || !email || !password) {
            throw new Error('GenLogs credentials not configured. Go to Settings → GenLogs.');
        }
        const url = `${BASE}/auth/token?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
        const res = await proxyFetch(url, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'x-api-key': apiKey
            }
        });
        if (!res.ok) {
            const body = res.body || {};
            if (res.status === 401) throw new Error('Invalid GenLogs credentials');
            throw new Error(body.detail?.message || `GenLogs auth failed (${res.status})`);
        }
        const data = res.body;
        saveToken(data);
        return data;
    }

    async function ensureToken() {
        let token = getToken();
        if (token) return token;
        const data = await authenticate();
        return data.access_token_data.token;
    }

    function authHeaders(token, apiKey) {
        return {
            'accept': 'application/json',
            'Access-Token': token,
            'x-api-key': apiKey || getCredentials().apiKey
        };
    }

    // ── Generic request with auto-retry on 401 ──────────────────────────
    async function request(method, path, { query, body, retry = true } = {}) {
        if (!isEnabled()) throw new Error('GenLogs is not enabled');
        const token = await ensureToken();
        const apiKey = getCredentials().apiKey;

        let url = `${BASE}${path}`;
        if (query) {
            const params = new URLSearchParams();
            Object.entries(query).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') params.append(k, v);
            });
            const qs = params.toString();
            if (qs) url += `?${qs}`;
        }

        const headers = authHeaders(token, apiKey);
        if (body) headers['Content-Type'] = 'application/json';

        let res = await proxyFetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null
        });

        // Auto-refresh on 401
        if (res.status === 401 && retry) {
            await authenticate();
            const newToken = getToken();
            headers['Access-Token'] = newToken;
            res = await proxyFetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
        }

        if (!res.ok) {
            const err = res.body || {};
            const msg = err.detail?.message || err.detail || `GenLogs API error (${res.status})`;
            throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
        return res.body;
    }

    // ── Carrier Endpoints (WORKING) ──────────────────────────────────────

    /**
     * Get carrier profile: FMCSA details, equipment pairings, sighting history
     * Response: { "USDOT": { fmcsa_detail: {...}, equipment_pairings: {fmcsa:[], genlogs:[]}, sightings: [] } }
     *
     * Key FMCSA fields: legal_name, dba_name, usdot_number, docket_number (MC#),
     *   carrier_status, entity_type, carrier_operation, carrier_total_power_units,
     *   carrier_total_drivers, telephone, email_address, phy_street, phy_city,
     *   phy_state, phy_zip, carried_cargo
     */
    async function carrierProfile(usdotNumber, opts = {}) {
        const data = await request('GET', '/carrier/profile', {
            query: { usdot_number: usdotNumber, ...opts }
        });
        logActivity('carrier_lookup', `USDOT ${usdotNumber}`, data[usdotNumber]?.fmcsa_detail?.legal_name || 'Found');
        return data;
    }

    /**
     * Get carrier recommendations for a lane
     * Required: origin_city, origin_state, destination_city, destination_state
     * Optional: equipment_types, max_results
     * Response: { real_time_locs: {}, recommendations: [...] }
     */
    async function carrierRecommendations(opts) {
        const data = await request('GET', '/carrier/recommendations', { query: opts });
        logActivity('lane_search', `${opts.origin_city},${opts.origin_state} → ${opts.destination_city},${opts.destination_state}`,
            `${data.recommendations?.length || 0} carriers`);
        return data;
    }

    // ── Disabled Endpoints (403 — need upgraded plan) ────────────────────
    // These stubs provide clear errors instead of cryptic 403s.

    async function vetCarrier(usdotNumber) {
        throw new Error('Carrier vetting requires an upgraded GenLogs plan (compliance-rules endpoint).');
    }

    async function carrierContacts(usdotNumber) {
        throw new Error('Carrier contacts require an upgraded GenLogs plan (carrier/contacts endpoint).');
    }

    async function facilityLookup(opts) {
        throw new Error('Facility lookup requires an upgraded GenLogs plan (facilities endpoint).');
    }

    async function createAlert(data) {
        throw new Error('Alert creation requires an upgraded GenLogs plan (alerts endpoint).');
    }

    async function runAlerts() {
        throw new Error('Alert monitoring requires an upgraded GenLogs plan (alerts/run endpoint).');
    }

    async function getVettingRules() {
        throw new Error('Vetting rules require an upgraded GenLogs plan.');
    }

    // ── Utility ──────────────────────────────────────────────────────────

    /**
     * Full carrier intel: profile only (vet + contacts need upgraded plan)
     */
    async function fullCarrierIntel(usdotNumber) {
        const profileData = await carrierProfile(usdotNumber);
        return {
            profile: profileData,
            vetting: { error: 'Requires upgraded plan' },
            contacts: { error: 'Requires upgraded plan' }
        };
    }

    function getActivityLog() {
        return JSON.parse(localStorage.getItem('genlogsActivityLog') || '[]');
    }

    function getCachedAlerts() {
        // Alerts disabled — always empty
        return [];
    }

    function clearCredentials() {
        ['genlogsApiKey', 'genlogsEmail', 'genlogsPassword', 'genlogsToken', 'genlogsTokenExpiry'].forEach(k => localStorage.removeItem(k));
    }

    function connectionStatus() {
        const token = getStored('genlogsToken');
        const expiry = getStored('genlogsTokenExpiry');
        if (!token) return { status: 'disconnected', label: 'Not Connected', color: '#ef4444' };
        if (new Date(expiry).getTime() < Date.now()) return { status: 'expired', label: 'Token Expired', color: '#f59e0b' };
        return { status: 'connected', label: 'Connected', color: '#4ade80' };
    }

    // ── Public API ───────────────────────────────────────────────────
    return {
        isEnabled,
        authenticate,
        ensureToken,
        carrierProfile,
        vetCarrier,           // stub — throws
        carrierContacts,      // stub — throws
        carrierRecommendations,
        facilityLookup,       // stub — throws
        createAlert,          // stub — throws
        runAlerts,            // stub — throws
        getVettingRules,      // stub — throws
        fullCarrierIntel,
        getActivityLog,
        getCachedAlerts,
        clearCredentials,
        connectionStatus,
        getCredentials
    };
})();
