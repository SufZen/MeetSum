"""Mint the MeetSum API token in Vexa v0.12.28 (docs/runbooks/vexa.md, Deploy step 4).

Mirrors upstream deploy/compose/bin/provision-token at the tag: resolve-or-create
the user, then mint a scoped token. Runs INSIDE the admin-api container (whose
port is not published), with only the Python standard library:

  docker compose -p vexa exec -T admin-api python - < deploy/vexa/mint-token.py

Env (container): ADMIN_API_TOKEN (set by compose from ADMIN_TOKEN). Optional:
EMAIL (default meetsum@realization.co.il), SCOPES (bot,tx), MAX_BOTS (2).
Prints only the token.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("ADMIN_API_URL", "http://localhost:8001")
ADMIN = os.environ.get("ADMIN_API_TOKEN") or os.environ.get("ADMIN_TOKEN")
EMAIL = os.environ.get("EMAIL", "meetsum@realization.co.il")
SCOPES = os.environ.get("SCOPES", "bot,tx")
MAX_BOTS = int(os.environ.get("MAX_BOTS", "2"))

if not ADMIN:
    sys.exit("ADMIN_API_TOKEN is not set in this container")


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method)
    request.add_header("X-Admin-API-Key", ADMIN)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


try:
    user = call("GET", "/admin/users/email/" + urllib.parse.quote(EMAIL))
except urllib.error.HTTPError:
    user = call("POST", "/admin/users", {"email": EMAIL, "max_concurrent_bots": MAX_BOTS})

token = call("POST", "/admin/users/%s/tokens?scopes=%s" % (user["id"], urllib.parse.quote(SCOPES)))
print(token["token"])
