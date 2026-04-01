/**
 * GenLogs Cargo Intelligence API Service
 * Handles authentication, token lifecycle, and all endpoint calls.
 * All methods check genlogsEnabled before executing.
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

    // ── Authentication ───────────────────────────────────────────────────
    async function authenticate(creds) {
        const { apiKey, email, password } = creds || getCredentials();
        if (!apiKey || !email || !password) {
            throw new Error('GenLogs credentials not configured. Go to Settings → GenLogs.');
        }
        const url = `${BASE}/auth/token?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'x-api-key': apiKey
            }
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            if (res.status === 401) throw new Error('Invalid GenLogs credentials');
            throw new Error(body.detail?.message || `GenLogs auth failed (${res.status})`);
        }
        const data = await res.json();
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

        const opts = { method, headers: authHeaders(token, apiKey) };
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }

        let res = await fetch(url, opts);

        // Auto-refresh on 401
        if (res.status === 401 && retry) {
            await authenticate();
            const newToken = getToken();
            opts.headers['Access-Token'] = newToken;
            res = await fetch(url, opts);
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const msg = err.detail?.message || err.detail || `GenLogs API error (${res.status})`;
            throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
        return res.json();
    }

    // ── Carrier Endpoints ────────────────────────────────────────────────

    /**
     * Get carrier profile: FMCSA details, equipment pairings, sighting history
     * @param {string} usdotNumber - USDOT number
     * @param {object} opts - { start_date, end_date } for sighting filters
     */
    async function carrierProfile(usdotNumber, opts = {}) {
        const data = await request('GET', '/carrier/profile', {
            query: { usdot_number: usdotNumber, ...opts }
        });
        logActivity('Carrier Profile', `USDOT ${usdotNumber}`, data[usdotNumber]?.fmcsa_detail?.legal_name || 'Found');
        return data;
    }

    /**
     * Vet a carrier against compliance rules
     * @param {string} usdotNumber - single USDOT or comma-separated list
     */
    async function vetCarrier(usdotNumber) {
        const isBatch = usdotNumber.includes(',');
        const query = isBatch
            ? { usdot_numbers: usdotNumber }
            : { usdot_number: usdotNumber };
        const data = await request('GET', '/compliance-rules', { query });
        const status = data.rule_status
            ? `Pass:${data.rule_status.pass?.total||0} Review:${data.rule_status.review?.total||0} Fail:${data.rule_status.fail?.total||0}`
            : 'Assessed';
        logActivity('Carrier Vetting', `USDOT ${usdotNumber}`, status);
        return data;
    }

    /**
     * Get carrier contacts (dispatch, FMCSA, onboarded)
     * @param {string} usdotNumber - USDOT number(s), comma-separated
     */
    async function carrierContacts(usdotNumber) {
        const data = await request('POST', '/carrier/contacts', {
            body: { usdot_numbers: usdotNumber }
        });
        logActivity('Carrier Contacts', `USDOT ${usdotNumber}`, 'Retrieved');
        return data;
    }

    /**
     * Get carrier recommendations for a lane
     */
    async function carrierRecommendations(opts) {
        const data = await request('GET', '/carrier/recommendations', { query: opts });
        logActivity('Lane Search', `${opts.origin_city},${opts.origin_state} → ${opts.destination_city},${opts.destination_state}`,
            `${data.recommendations?.length || 0} carriers`);
        return data;
    }

    // ── Shipper / Facility Endpoints ─────────────────────────────────────

    /**
     * Lookup facilities by name and/or location
     */
    async function facilityLookup(opts) {
        const data = await request('GET', '/facilities', { query: opts });
        logActivity('Facility Lookup', opts.name || opts.address || `${opts.city}, ${opts.state}`,
            `${data.facilities?.length || 0} found`);
        return data;
    }

    // ── Alert Endpoints ──────────────────────────────────────────────────

    /**
     * Create a new alert (hot = 15min, normal = daily)
     * @param {object} alertData - { email, alert_type, alert_name, license_plate, vin, trailer_number, usdot_number, ... }
     */
    async function createAlert(alertData) {
        const data = await request('POST', '/alerts', { body: alertData });
        // Cache locally
        const alerts = JSON.parse(localStorage.getItem('genlogsAlerts') || '[]');
        alerts.unshift({ ...data, created: new Date().toISOString() });
        localStorage.setItem('genlogsAlerts', JSON.stringify(alerts));
        logActivity('Alert Created', alertData.alert_name,
            `${alertData.alert_type === 'hot' ? '🔴 Hot (15min)' : '📋 Daily'}`);
        return data;
    }

    /**
     * Trigger all configured alerts
     */
    async function runAlerts() {
        const data = await request('POST', '/alerts/run');
        logActivity('Alerts Run', 'All', data.message || 'Triggered');
        return data;
    }

    /**
     * Get vetting rules configured for this account
     */
    async function getVettingRules() {
        return request('GET', '/customer-compliance-rules');
    }

    // ── Utility ──────────────────────────────────────────────────────────

    /**
     * Full carrier intel: profile + vetting + contacts in parallel
     */
    async function fullCarrierIntel(usdotNumber) {
        const [profile, vetting, contacts] = await Promise.allSettled([
            carrierProfile(usdotNumber),
            vetCarrier(usdotNumber),
            carrierContacts(usdotNumber)
        ]);
        return {
            profile: profile.status === 'fulfilled' ? profile.value : { error: profile.reason?.message },
            vetting: vetting.status === 'fulfilled' ? vetting.value : { error: vetting.reason?.message },
            contacts: contacts.status === 'fulfilled' ? contacts.value : { error: contacts.reason?.message }
        };
    }

    function getActivityLog() {
        return JSON.parse(localStorage.getItem('genlogsActivityLog') || '[]');
    }

    function getCachedAlerts() {
        return JSON.parse(localStorage.getItem('genlogsAlerts') || '[]');
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

    // ── Public API ───────────────────────────────────────────────────────
    return {
        isEnabled,
        authenticate,
        ensureToken,
        carrierProfile,
        vetCarrier,
        carrierContacts,
        carrierRecommendations,
        facilityLookup,
        createAlert,
        runAlerts,
        getVettingRules,
        fullCarrierIntel,
        getActivityLog,
        getCachedAlerts,
        clearCredentials,
        connectionStatus,
        getCredentials
    };
})();
