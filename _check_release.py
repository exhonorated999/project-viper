import keyring, urllib.request, json, os
token = None
for service in ("memex", "memex secrets", "workshop", "GH_TOKEN"):
    for user in ("GH_TOKEN", "gh_token", "secrets"):
        try:
            v = keyring.get_password(service, user)
            if v:
                token = v; break
        except Exception:
            pass
    if token: break
if not token:
    token = os.environ.get("GH_TOKEN")
print("token loaded:", bool(token))

req = urllib.request.Request(
    "https://api.github.com/repos/exhonorated999/project-viper/releases/tags/v3.8.4",
    headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "viper-check",
    },
)
with urllib.request.urlopen(req) as r:
    rel = json.loads(r.read())
print("Release URL:", rel["html_url"])
print("Assets uploaded so far:")
for a in rel["assets"]:
    print(f"  - {a['name']}  ({a['size']:,} bytes, state={a['state']})")
print(f"Total assets: {len(rel['assets'])}")
