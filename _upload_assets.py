"""Upload v3.8.4 release assets to GitHub using curl (reliable for large files)."""
import json
import os
import subprocess
import sys
import urllib.request

import keyring

REPO = "exhonorated999/project-viper"
TAG = "v3.8.4"
ARTIFACTS = [
    r"D:\VIPER\dist\latest.yml",                       # tiny first - critical for auto-updater
    r"D:\VIPER\dist\V.I.P.E.R-3.8.4-Setup.exe.blockmap",
    r"D:\VIPER\dist\V.I.P.E.R-3.8.4-Setup.exe",
    r"D:\VIPER\dist\V.I.P.E.R-3.8.4-Portable.exe",
    r"D:\VIPER\dist\V.I.P.E.R-3.8.4.msi",
]

def get_token():
    for svc in ("memex", "memex secrets", "workshop", "GH_TOKEN"):
        for key in ("GH_TOKEN", "gh_token", "Gh_Token"):
            try:
                v = keyring.get_password(svc, key)
                if v:
                    return v.strip()
            except Exception:
                pass
    # Try generic
    for svc in ("memex", "memex secrets", "workshop"):
        try:
            v = keyring.get_password(svc, "secrets")
            if v:
                try:
                    d = json.loads(v)
                    for k in d:
                        if k.upper() == "GH_TOKEN":
                            return d[k].strip()
                except Exception:
                    pass
        except Exception:
            pass
    return None

def gh_get(token, path):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "viper-publish"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def gh_delete(token, path):
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "viper-publish"},
        method="DELETE",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status

def main():
    token = get_token()
    if not token:
        print("ERROR: no GH_TOKEN")
        return 1

    rel = gh_get(token, f"/repos/{REPO}/releases/tags/{TAG}")
    rel_id = rel["id"]
    upload_url = rel["upload_url"].split("{", 1)[0]
    print(f"Release id={rel_id}")
    print(f"Upload URL base: {upload_url}")

    existing = {a["name"]: a["id"] for a in rel.get("assets", [])}
    print(f"Existing assets: {list(existing.keys())}")

    for path in ARTIFACTS:
        name = os.path.basename(path)
        if not os.path.exists(path):
            print(f"  SKIP missing: {path}")
            continue
        size = os.path.getsize(path)

        if name in existing:
            # Verify size; if mismatch, delete + re-upload
            asset = next(a for a in rel.get("assets", []) if a["name"] == name)
            if asset.get("size") == size and asset.get("state") == "uploaded":
                print(f"  OK already uploaded: {name} ({size:,} bytes)")
                continue
            print(f"  DELETING incomplete asset {name} (state={asset.get('state')}, size={asset.get('size')})")
            try:
                gh_delete(token, f"/repos/{REPO}/releases/assets/{asset['id']}")
            except Exception as e:
                print(f"    delete err: {e}")

        # Determine content-type
        ct = "application/octet-stream"
        if name.endswith(".yml"):
            ct = "text/yaml"
        elif name.endswith(".msi"):
            ct = "application/x-msi"

        print(f"  Uploading {name} ({size:,} bytes) via curl...")
        url = f"{upload_url}?name={name}"
        # curl: -T streams the file, --fail returns non-zero on HTTP error, -sS shows errors
        cmd = [
            "curl",
            "-sS",
            "--fail-with-body",
            "-X", "POST",
            "-H", f"Authorization: Bearer {token}",
            "-H", f"Content-Type: {ct}",
            "-H", "Accept: application/vnd.github+json",
            "-H", "User-Agent: viper-publish",
            "--data-binary", f"@{path}",
            url,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"    FAILED rc={proc.returncode}")
            print(f"    stderr: {proc.stderr[:500]}")
            print(f"    stdout: {proc.stdout[:500]}")
            return 1
        try:
            resp = json.loads(proc.stdout)
            print(f"    OK id={resp.get('id')} state={resp.get('state')} size={resp.get('size')}")
        except Exception:
            print(f"    OK (non-json resp: {proc.stdout[:200]})")

    print()
    print("Final verification:")
    rel = gh_get(token, f"/repos/{REPO}/releases/tags/{TAG}")
    for a in rel.get("assets", []):
        print(f"  - {a['name']}: {a['size']:,} bytes, state={a['state']}")
    print(f"Total assets: {len(rel.get('assets', []))}")
    print(f"Release URL: {rel['html_url']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
