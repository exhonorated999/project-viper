/**
 * WiGLE API Client for VIPER Network Intelligence
 * 
 * Provides geolocation intelligence for WiFi, Bluetooth, and Cell networks
 * API Documentation: https://api.wigle.net/swagger
 */

class WiGLEClient {
    constructor() {
        this.baseURL = 'https://api.wigle.net/api/v2';
    }

    /**
     * Get encrypted credentials from localStorage and decrypt them
     * @returns {Object} { name, token }
     * @throws {Error} If credentials not configured
     */
    getCredentials() {
        const settings = JSON.parse(localStorage.getItem('viperSettings')) || {};
        if (!settings.wigleApiName || !settings.wigleApiToken) {
            throw new Error('WiGLE credentials not configured. Please visit Settings to add your API credentials.');
        }
        
        // Use the same encryption helper functions from settings.html
        return {
            name: this.decryptString(settings.wigleApiName),
            token: this.decryptString(settings.wigleApiToken)
        };
    }

    /**
     * Decrypt encrypted string (same logic as settings.html)
     */
    decryptString(encrypted) {
        if (!encrypted) return '';
        const key = "VIPER_SECURE_KEY_" + navigator.userAgent;
        const decrypted = atob(encrypted);
        let original = "";
        for (let i = 0; i < decrypted.length; i++) {
            original += String.fromCharCode(decrypted.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return original;
    }

    /**
     * Build HTTP Basic Authentication header
     * @returns {string} Authorization header value
     */
    getAuthHeader() {
        const creds = this.getCredentials();
        return 'Basic ' + btoa(creds.name + ':' + creds.token);
    }

    /**
     * Search WiFi networks by BSSID (MAC address)
     * @param {string} bssid - MAC address (format: 00:11:22:33:44:55)
     * @returns {Promise<Object>} WiGLE API response
     */
    async searchWiFiByBSSID(bssid) {
        const url = `${this.baseURL}/network/search?netid=${encodeURIComponent(bssid)}`;
        const response = await fetch(url, {
            headers: { 'Authorization': this.getAuthHeader() }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`WiGLE API error (${response.status}): ${errorText}`);
        }
        
        return await response.json();
    }

    /**
     * Search WiFi networks by SSID (network name)
     * @param {string} ssid - Network name
     * @param {Object} options - Optional filters { latRange, lonRange }
     * @returns {Promise<Object>} WiGLE API response
     */
    async searchWiFiBySSID(ssid, options = {}) {
        let url = `${this.baseURL}/network/search?ssid=${encodeURIComponent(ssid)}`;
        
        // Add optional geographic filters
        if (options.latRange && Array.isArray(options.latRange) && options.latRange.length === 2) {
            url += `&latrange1=${options.latRange[0]}&latrange2=${options.latRange[1]}`;
        }
        if (options.lonRange && Array.isArray(options.lonRange) && options.lonRange.length === 2) {
            url += `&longrange1=${options.lonRange[0]}&longrange2=${options.lonRange[1]}`;
        }
        
        const response = await fetch(url, {
            headers: { 'Authorization': this.getAuthHeader() }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`WiGLE API error (${response.status}): ${errorText}`);
        }
        
        return await response.json();
    }

    /**
     * Search cell towers by Cell ID
     * @param {string} cellId - Cell tower identifier
     * @param {Object} options - Optional filters { latRange, lonRange }
     * @returns {Promise<Object>} WiGLE API response
     */
    async searchCell(cellId, options = {}) {
        let url = `${this.baseURL}/cell/search?cellid=${encodeURIComponent(cellId)}`;
        
        if (options.latRange && Array.isArray(options.latRange) && options.latRange.length === 2) {
            url += `&latrange1=${options.latRange[0]}&latrange2=${options.latRange[1]}`;
        }
        if (options.lonRange && Array.isArray(options.lonRange) && options.lonRange.length === 2) {
            url += `&longrange1=${options.lonRange[0]}&longrange2=${options.lonRange[1]}`;
        }
        
        const response = await fetch(url, {
            headers: { 'Authorization': this.getAuthHeader() }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`WiGLE API error (${response.status}): ${errorText}`);
        }
        
        return await response.json();
    }

    /**
     * Search Bluetooth devices by MAC address
     * @param {string} mac - Bluetooth MAC address
     * @returns {Promise<Object>} WiGLE API response
     */
    async searchBluetooth(mac) {
        const url = `${this.baseURL}/bluetooth/search?netid=${encodeURIComponent(mac)}`;
        const response = await fetch(url, {
            headers: { 'Authorization': this.getAuthHeader() }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`WiGLE API error (${response.status}): ${errorText}`);
        }
        
        return await response.json();
    }

    /**
     * Transform WiGLE WiFi/Network response to standardized VIPER format
     * @param {Object} wigleResponse - Raw WiGLE API response
     * @returns {Array} Array of observation objects
     */
    parseWiFiResults(wigleResponse) {
        if (!wigleResponse.results || wigleResponse.results.length === 0) {
            return [];
        }

        return wigleResponse.results.map(result => ({
            ssid: result.ssid || 'Hidden Network',
            bssid: result.netid,
            lat: result.trilat,
            lon: result.trilong,
            firstSeen: result.firsttime || 'Unknown',
            lastSeen: result.lasttime || 'Unknown',
            observations: result.locationData?.length || 1,
            qos: result.qos || 0,
            encryption: result.encryption || 'Unknown',
            channel: result.channel || 'N/A',
            // Additional metadata
            country: result.country || '',
            region: result.region || '',
            city: result.city || '',
            roadDetail: result.road || '',
            housenumber: result.housenumber || ''
        }));
    }

    /**
     * Transform WiGLE Cell response to standardized VIPER format
     * @param {Object} wigleResponse - Raw WiGLE API response
     * @returns {Array} Array of cell tower observation objects
     */
    parseCellResults(wigleResponse) {
        if (!wigleResponse.results || wigleResponse.results.length === 0) {
            return [];
        }

        return wigleResponse.results.map(result => ({
            cellId: result.cellid,
            lat: result.trilat,
            lon: result.trilong,
            firstSeen: result.firsttime || 'Unknown',
            lastSeen: result.lasttime || 'Unknown',
            observations: 1,
            qos: result.qos || 0,
            // Cell-specific data
            network: result.network || 'Unknown',
            type: result.type || 'Unknown', // GSM, LTE, etc.
            country: result.country || '',
            region: result.region || ''
        }));
    }

    /**
     * Transform WiGLE Bluetooth response to standardized VIPER format
     * @param {Object} wigleResponse - Raw WiGLE API response
     * @returns {Array} Array of Bluetooth observation objects
     */
    parseBluetoothResults(wigleResponse) {
        if (!wigleResponse.results || wigleResponse.results.length === 0) {
            return [];
        }

        return wigleResponse.results.map(result => ({
            name: result.name || 'Unknown Device',
            mac: result.netid,
            lat: result.trilat,
            lon: result.trilong,
            firstSeen: result.firsttime || 'Unknown',
            lastSeen: result.lasttime || 'Unknown',
            observations: result.locationData?.length || 1,
            qos: result.qos || 0,
            deviceType: result.type || 'Unknown'
        }));
    }

    /**
     * Validate MAC address format
     * @param {string} mac - MAC address string
     * @returns {boolean} True if valid
     */
    isValidMAC(mac) {
        // Matches formats: 00:11:22:33:44:55, 00-11-22-33-44-55, 001122334455
        const macRegex = /^([0-9A-Fa-f]{2}[:-]?){5}([0-9A-Fa-f]{2})$/;
        return macRegex.test(mac);
    }

    /**
     * Normalize MAC address to WiGLE format (colon-separated uppercase)
     * @param {string} mac - MAC address in any format
     * @returns {string} Normalized MAC address
     */
    normalizeMAC(mac) {
        // Remove all non-hex characters
        const cleaned = mac.replace(/[^0-9A-Fa-f]/g, '');
        
        if (cleaned.length !== 12) {
            throw new Error('Invalid MAC address length');
        }
        
        // Insert colons and convert to uppercase
        return cleaned.match(/.{1,2}/g).join(':').toUpperCase();
    }
}

// Create global instance for use in other scripts
const wigleClient = new WiGLEClient();
