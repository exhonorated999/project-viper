"""
Create GitHub Release v3.8.5 and upload installer artifacts.
Reads GH_TOKEN from OS keyring; never prints the token.
"""
import os
import sys
import json
import keyring
import urllib.request
import urllib.parse

REPO_OWNER = "exhonorated999"
REPO_NAME = "project-viper"
TAG = "v3.8.5"
RELEASE_NAME = "v3.8.5 - Opt-in demo telemetry"
RELEASE_BODY = """## v3.8.5 — Opt-in demo telemetry (sales-pipeline visibility)

### What's new
Demo installs can now optionally report **anonymous usage signals** to
help us understand which features matter to evaluators and follow up
with the right context. This is **opt-in, disclosed, demo-only, and
fully offline-tolerant** — it does not change anything for licensed
users.

### What gets reported (only with consent, only during demo)
- `install_open` — install + version identifier on first launch
- `module_open` — which module tab was opened (e.g. `suspects`, `recovered_vehicles`)
- `session_end` — session length + module visit counts

### What is NEVER reported
- Case content, names, addresses, narratives, photos, evidence, contacts
- Anything the user types into a case
- Anything from licensed (non-demo) installs

### Privacy architecture
- **Three-way gate:** license-status = `demo` AND api_key present AND consent accepted
- **Opt-in:** first-launch consent dialog with clear "No thanks" option
- **Outbound-only:** the desktop app makes HTTPS POSTs to our dashboard.
  No inbound listener, no new attack surface
- **Offline-tolerant:** events queue to localStorage (200-event cap, 64KB
  payload cap) and flush on next launch. Telemetry failure NEVER blocks
  the app
- **License upgrade:** the moment a paid license activates, telemetry
  silently stops without any rebuild

### Implementation
- `modules/telemetry.js` — SDK with queued POSTs, `fetch(keepalive)` on
  unload, X-API-Key auth, dedup via client_seq
- `modules/telemetry-consent.js` — first-launch consent modal
- Hooks in `index.html`, `case-detail-with-analytics.html`, `settings.html`
- `preload.js` — exposes `platform` to the renderer for the SDK

### Artifacts
- `V.I.P.E.R-3.8.5-Setup.exe` — NSIS installer (per-user, no UAC)
- `V.I.P.E.R-3.8.5-Portable.exe` — extract-and-run, no install
- `V.I.P.E.R-3.8.5.msi` — MSI for SCCM / Intune / PDQ / GPO deployment
- `latest.yml` — electron-updater manifest
"""

# Build output on this machine
_DIST = r"C:\Users\JUSTI\Workspace\VIPER\dist"
ARTIFACTS = [
    os.path.join(_DIST, "V.I.P.E.R-3.8.5-Setup.exe"),
    os.path.join(_DIST, "V.I.P.E.R-3.8.5-Setup.exe.blockmap"),
    os.path.join(_DIST, "V.I.P.E.R-3.8.5-Portable.exe"),
    os.path.join(_DIST, "V.I.P.E.R-3.8.5.msi"),
    os.path.join(_DIST, "latest.yml"),
]


def get_token():
    # Try common keyring layouts; never print the value.
    for service in ("memex", "memex secrets", "workshop", "GH_TOKEN"):
        for user in ("GH_TOKEN", "gh_token", "secrets"):
            try:
                v = keyring.get_password(service, user)
                if v:
                    return v
            except Exception:
                pass
    v = os.environ.get("GH_TOKEN")
    if v:
        return v
    print("ERROR: could not locate GH_TOKEN in keyring or env", file=sys.stderr)
    sys.exit(2)


def http_request(method, url, token, data=None, content_type="application/json", extra_headers=None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "viper-release-publisher",
        "Content-Type": content_type,
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read()
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_or_create_release(token):
    # Try fetch existing release by tag first (idempotent).
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases/tags/{TAG}"
    status, body = http_request("GET", url, token)
    if status == 200:
        rel = json.loads(body)
        print(f"Release for tag {TAG} already exists: id={rel['id']}")
        return rel
    if status != 404:
        print(f"Unexpected status {status} fetching release: {body[:500]}")
        sys.exit(3)

    # Create release
    create_url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/releases"
    payload = json.dumps({
        "tag_name": TAG,
        "name": RELEASE_NAME,
        "body": RELEASE_BODY,
        "draft": False,
        "prerelease": False,
    }).encode("utf-8")
    status, body = http_request("POST", create_url, token, data=payload)
    if status not in (200, 201):
        print(f"ERROR creating release: status={status}")
        try:
            print(body.decode("utf-8", errors="replace")[:1000])
        except Exception:
            pass
        sys.exit(4)
    rel = json.loads(body)
    print(f"Created release id={rel['id']}")
    return rel


def upload_asset(token, upload_url_template, file_path):
    name = os.path.basename(file_path)
    # upload_url has trailing "{?name,label}" template
    base = upload_url_template.split("{")[0]
    url = base + "?" + urllib.parse.urlencode({"name": name})

    # Detect content-type
    ext = name.lower().rsplit(".", 1)[-1]
    ctype = {
        "exe": "application/octet-stream",
        "msi": "application/octet-stream",
        "blockmap": "application/octet-stream",
        "yml": "application/x-yaml",
        "yaml": "application/x-yaml",
    }.get(ext, "application/octet-stream")

    size = os.path.getsize(file_path)
    print(f"  Uploading {name} ({size:,} bytes)...", flush=True)

    with open(file_path, "rb") as f:
        data = f.read()
    status, body = http_request(
        "POST", url, token, data=data,
        content_type=ctype,
        extra_headers={"Content-Length": str(size)},
    )
    if status not in (200, 201):
        print(f"  ERROR uploading {name}: status={status}")
        try:
            print("  " + body.decode("utf-8", errors="replace")[:500])
        except Exception:
            pass
        return False
    print(f"  OK {name}")
    return True


def main():
    token = get_token()

    # Sanity check repo exists
    status, body = http_request(
        "GET",
        f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}",
        token,
    )
    if status != 200:
        print(f"ERROR: cannot access repo {REPO_OWNER}/{REPO_NAME} — status {status}")
        try:
            print(body.decode("utf-8", errors="replace")[:500])
        except Exception:
            pass
        sys.exit(5)
    print(f"Authenticated. Repo {REPO_OWNER}/{REPO_NAME} accessible.")

    rel = get_or_create_release(token)
    upload_url = rel["upload_url"]

    # Skip already-uploaded assets (idempotent)
    existing = {a["name"] for a in rel.get("assets", [])}
    if existing:
        print(f"Existing assets: {sorted(existing)}")

    all_ok = True
    for path in ARTIFACTS:
        if not os.path.isfile(path):
            print(f"  SKIP missing file: {path}")
            all_ok = False
            continue
        name = os.path.basename(path)
        if name in existing:
            print(f"  SKIP already uploaded: {name}")
            continue
        ok = upload_asset(token, upload_url, path)
        all_ok = all_ok and ok

    print()
    print(f"Release URL: {rel['html_url']}")
    print(f"Done. all_ok={all_ok}")


if __name__ == "__main__":
    main()
