/* ============================================================================
 *  VIPER — Shared basemap configuration (RENDERER side)
 * ----------------------------------------------------------------------------
 *  Single source of truth for the CARTO raster basemap URLs used by every
 *  Leaflet map in the app (CDR map, AMP playback map, Connection Board,
 *  Google warrant location map, Missing-Persons sighting map).
 *
 *  WHY THIS FILE EXISTS
 *  CARTO began watermarking their raster tile CDN with a large diagonal
 *  "API KEY REQUIRED / carto.com/basemaps/apikey" overlay on keyless requests.
 *  Every VIPER map was hitting the CDN without a key, so every map in the
 *  product was defaced. The fix is a `key=` query parameter on the tile URL.
 *  It was pasted at six separate call sites across three files; centralising
 *  it here means the next key rotation is a one-line change.
 *
 *  Verified 2026-09-17 against https://a.basemaps.cartocdn.com/dark_all/8/59/103.png
 *      keyless  -> 11653 bytes, md5 ADDA5B198D37  (watermarked)
 *      with key -> 11491 bytes, md5 8B1DFF46013F  (clean)
 *  i.e. the key works on the plain `dark_all` path; there is no need to move
 *  to the `rastertiles/dark_all` path (it serves a byte-identical tile).
 *
 *  ON THE KEY ITSELF
 *  This is a CARTO *client-side* basemap key. It travels in the query string
 *  of every tile request, so it is visible in any browser's network panel and
 *  is not a secret in the cryptographic sense — it is a usage-attribution
 *  token. It is deliberately checked in rather than kept in the OS keyring:
 *  the renderer needs it synchronously on every map init, and treating it as
 *  a secret would imply a confidentiality guarantee that the transport does
 *  not provide.
 *
 *  FALLBACK CONTRACT
 *  Every call site resolves the URL through a local helper that falls back to
 *  the keyless URL if this file failed to load. A watermarked map is degraded;
 *  a map that throws is broken. For an investigator mid-case, degraded beats
 *  broken.
 * ==========================================================================*/
(function (root) {
    'use strict';

    // CARTO basemap key (client-side, see header note).
    var CARTO_KEY = 'cb1_3oqf_1_911980cf4189da1dfd1186b2';

    function withKey(path) {
        return 'https://{s}.basemaps.cartocdn.com/' + path + '/{z}/{x}/{y}{r}.png?key=' + CARTO_KEY;
    }

    var API = {
        key: CARTO_KEY,

        // Dark theme — the VIPER house style, used by every map today.
        dark: withKey('dark_all'),
        // Available if a light/print variant is ever needed.
        light: withKey('light_all'),
        voyager: withKey('rastertiles/voyager'),

        attribution: '&copy; OpenStreetMap &copy; CARTO',

        // Keyless equivalents. Only for the degraded fallback path — these
        // render the "API KEY REQUIRED" watermark.
        darkNoKey: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    };

    root.VIPER_BASEMAP = API;

    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
