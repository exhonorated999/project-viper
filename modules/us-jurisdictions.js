/*
 * VIPER — Issuing-jurisdiction list (driver's licenses and license plates)
 * ------------------------------------------------------------------------
 * A driver's license number or a plate is only unique WITHIN its issuing
 * jurisdiction.  "D1234567" is a different person in California than it is
 * in Florida, and running a plate against the wrong state returns the wrong
 * vehicle.  Every DL/plate field in VIPER therefore carries a companion
 * state code.
 *
 * Scope of the list, in display order:
 *   - 50 US states + District of Columbia
 *   - US territories that issue their own DLs/plates (PR, GU, VI, AS, MP)
 *   - US federal / military issuers an officer may actually see on a card
 *   - Canadian provinces and territories (common on border-state returns)
 *   - Mexico, then a catch-all "Other / Foreign"
 *
 * The stored value is always the short code ('CA'), never the display name,
 * so existing plate-lookup integrations (Flock) keep working unchanged.
 *
 * Pure UMD: no DOM access at load time, so it is unit-testable in plain Node.
 */
(function (global) {
    'use strict';

    const US_STATES = [
        ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
        ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
        ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
        ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
        ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
        ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
        ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
        ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
        ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
        ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
        ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
        ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
        ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
    ];

    const US_TERRITORIES = [
        ['PR', 'Puerto Rico'], ['GU', 'Guam'], ['VI', 'U.S. Virgin Islands'],
        ['AS', 'American Samoa'], ['MP', 'Northern Mariana Islands'],
    ];

    // Federal / military issuers that appear on real credentials and plates.
    const US_FEDERAL = [
        ['US', 'U.S. Government'],
        ['DOD', 'U.S. Military / DoD'],
        ['DOS', 'U.S. Dept. of State (Diplomatic)'],
    ];

    const CA_PROVINCES = [
        ['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'],
        ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'],
        ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'],
        ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'],
        ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
    ];

    const OTHER = [
        ['MX', 'Mexico'],
        ['FN', 'Other / Foreign'],
    ];

    // Grouped for <optgroup> rendering.
    const GROUPS = [
        { label: 'U.S. States', items: US_STATES },
        { label: 'U.S. Territories', items: US_TERRITORIES },
        { label: 'Federal / Military', items: US_FEDERAL },
        { label: 'Canada', items: CA_PROVINCES },
        { label: 'Other', items: OTHER },
    ];

    // Flat code -> display name.  NOTE: a handful of two-letter codes are
    // shared between US states and Canadian provinces (e.g. NB, NS, PE, ON
    // do not collide, but BC/AB/MB/QC/SK/NT/NU/YT are unique while 'NL' is
    // Newfoundland only).  Where a genuine collision would exist the US
    // entry wins because it is inserted first, which matches how an
    // American agency reads an unqualified code.
    const NAME_BY_CODE = {};
    GROUPS.forEach(g => g.items.forEach(([code, name]) => {
        if (!(code in NAME_BY_CODE)) NAME_BY_CODE[code] = name;
    }));

    const ALL_CODES = Object.keys(NAME_BY_CODE);

    function escAttr(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /**
     * Normalize an arbitrary user/import value to a known code.
     * Accepts a code ('ca', 'Ca') or a full name ('California').
     * Returns '' when the value is not recognised, so a bad import can never
     * silently fabricate a jurisdiction.
     */
    function normalize(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return '';
        const up = raw.toUpperCase();
        if (NAME_BY_CODE[up]) return up;
        const hit = ALL_CODES.find(c => NAME_BY_CODE[c].toUpperCase() === up);
        return hit || '';
    }

    /** Display label for a code; falls back to the raw value when unknown. */
    function label(code) {
        const c = normalize(code);
        return c ? NAME_BY_CODE[c] : String(code == null ? '' : code);
    }

    /**
     * Render a <select> of jurisdictions.
     *
     * @param {object} opts
     *   id           element id (optional)
     *   name         form field name (optional; needed for FormData reads)
     *   value        currently selected code
     *   cls          class attribute for the <select>
     *   placeholder  text for the empty option (default '— State —')
     *   onchange     inline handler (optional)
     *
     * An UNKNOWN stored value is preserved as an extra option rather than
     * being dropped — silently blanking a field the examiner typed is worse
     * than showing an odd code.
     */
    function selectHtml(opts) {
        const o = opts || {};
        const current = String(o.value == null ? '' : o.value).trim();
        const known = normalize(current);
        const sel = known || current;

        let html = '<select';
        if (o.id) html += ` id="${escAttr(o.id)}"`;
        if (o.name) html += ` name="${escAttr(o.name)}"`;
        if (o.cls) html += ` class="${escAttr(o.cls)}"`;
        if (o.onchange) html += ` onchange="${escAttr(o.onchange)}"`;
        html += '>';
        html += `<option value=""${sel ? '' : ' selected'}>${escAttr(o.placeholder || '\u2014 State \u2014')}</option>`;

        if (current && !known) {
            html += `<option value="${escAttr(current)}" selected>${escAttr(current)} (unrecognized)</option>`;
        }

        GROUPS.forEach(g => {
            html += `<optgroup label="${escAttr(g.label)}">`;
            g.items.forEach(([code, name]) => {
                const isSel = known && code === known;
                html += `<option value="${code}"${isSel ? ' selected' : ''}>${code} \u2014 ${escAttr(name)}</option>`;
            });
            html += '</optgroup>';
        });
        html += '</select>';
        return html;
    }

    const API = {
        GROUPS,
        ALL_CODES,
        NAME_BY_CODE,
        normalize,
        label,
        selectHtml,
    };

    global.ViperJurisdictions = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
