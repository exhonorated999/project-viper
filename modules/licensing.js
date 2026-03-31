/**
 * Licensing module for V.I.P.E.R.
 * Communicates with the Intellect Unified Dashboard API.
 */
const PRODUCT_SLUG = "project-viper";
const STORAGE_PREFIX = "viper_";
const API_BASE = "https://intellect-unified-dashboard-production.up.railway.app";
const DEMO_DAYS = 60;
const APP_VERSION = "1.5.0";

/* ---------- helpers ---------- */
function _get(key) { return localStorage.getItem(STORAGE_PREFIX + key); }
function _set(key, v) { localStorage.setItem(STORAGE_PREFIX + key, v); }
function _remove(key) { localStorage.removeItem(STORAGE_PREFIX + key); }

function _daysBetween(a, b) {
  return Math.floor((b - a) / 86400000);
}

/* ---------- status ---------- */
function getLicenseStatus() {
  const licenseKey = _get("license_key");
  const licenseType = _get("license_type");
  const registeredAt = _get("registered_at");
  const expiresAt = _get("expires_at");

  if (!registeredAt) {
    return { registered: false, status: "unregistered", daysLeft: 0, canCreate: false };
  }

  // Has a paid license
  if (licenseKey && licenseType && licenseType !== "demo") {
    const expired = expiresAt ? new Date(expiresAt) < new Date() : false;
    return {
      registered: true,
      status: expired ? "expired" : "licensed",
      licenseType,
      daysLeft: expiresAt ? _daysBetween(new Date(), new Date(expiresAt)) : Infinity,
      canCreate: !expired,
    };
  }

  // Demo
  const start = new Date(registeredAt);
  const demoEnd = new Date(start.getTime() + DEMO_DAYS * 86400000);
  const daysLeft = _daysBetween(new Date(), demoEnd);
  const expired = daysLeft < 0;

  return {
    registered: true,
    status: expired ? "demo_expired" : "demo",
    licenseType: "demo",
    daysLeft: Math.max(daysLeft, 0),
    canCreate: !expired,
  };
}

function canCreateCases() {
  return getLicenseStatus().canCreate;
}

/* ---------- registration ---------- */
async function registerDemo(data) {
  const body = {
    product_slug: PRODUCT_SLUG,
    name: data.name,
    contact_email: data.email,
    agency: data.agency || "",
    address: data.address || "",
  };

  const res = await fetch(`${API_BASE}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail) ? err.detail.map(e => e.msg).join(", ") : err.detail;
    throw new Error(detail || "Registration failed");
  }

  const json = await res.json();
  _set("registered_at", new Date().toISOString());
  _set("api_key", json.api_key);
  _set("customer_name", data.name);
  _set("contact_email", data.email);
  if (data.agency) _set("agency", data.agency);
  return json;
}

/* ---------- activation ---------- */
async function activateLicense(licenseKey) {
  const apiKey = _get("api_key");
  if (!apiKey) throw new Error("Not registered — register first.");

  const res = await fetch(`${API_BASE}/api/license/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ license_key: licenseKey, product_slug: PRODUCT_SLUG }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = Array.isArray(err.detail) ? err.detail.map(e => e.msg).join(", ") : err.detail;
    throw new Error(detail || "Activation failed");
  }

  const json = await res.json();
  if (!json.valid) {
    throw new Error(json.message || "Activation failed");
  }
  _set("license_key", licenseKey);
  _set("license_type", json.license_type || "standard");
  if (json.expires_at) _set("expires_at", json.expires_at);
  return json;
}

/* ---------- validation ---------- */
async function validateLicense() {
  const apiKey = _get("api_key");
  const licenseKey = _get("license_key");
  if (!apiKey || !licenseKey) return null;

  try {
    const res = await fetch(`${API_BASE}/api/license/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ license_key: licenseKey }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---------- update checker ---------- */
async function checkForUpdate() {
  try {
    const res = await fetch(
      `${API_BASE}/api/updates/${PRODUCT_SLUG}/latest?current_version=${encodeURIComponent(APP_VERSION)}`
    );
    if (!res.ok) return { updateAvailable: false };
    const body = await res.json();
    return {
      updateAvailable: body.update_available || false,
      latestVersion: body.latest_version,
      changelog: body.changelog,
      downloadUrl: body.download_url ? `${API_BASE}${body.download_url}` : undefined,
    };
  } catch {
    return { updateAvailable: false };
  }
}

/* ---------- exports (global) ---------- */
window.ViperLicensing = {
  PRODUCT_SLUG,
  APP_VERSION,
  DEMO_DAYS,
  getLicenseStatus,
  canCreateCases,
  registerDemo,
  activateLicense,
  validateLicense,
  checkForUpdate,
};
