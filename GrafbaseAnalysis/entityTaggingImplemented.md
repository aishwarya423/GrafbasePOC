I'll implement entity tagging at the subgraph cache layer. The approach: when we cache a REST response, also write tag-index SETs in Valkey, and expose a small HTTP "purge" endpoint on each subgraph for tag-based invalidation.

Now replace `cachedRequestJson` with a tag-aware version and add the helpers + purge endpoint:

Now add the management HTTP server at the bottom of the file:

Now expose the management ports in `docker-compose.yml`:

Now add a "Cache tagging" section to the README:

Quick syntax check on the server.js:

All done. Here's a summary of what was added:

---

## ✅ Entity Tagging Implemented

### What was added

| File | Change |
|---|---|
| `subgraph-server/server.js` | `tagsForRoute()` helper, tag-writing in `cachedRequestJson()`, `purgeTags()` function, management HTTP server on `MGMT_PORT` |
| `docker-compose.yml` | Added `MGMT_PORT: 5000` + host port mappings (`5001/5002/5003`) for each subgraph |
| `Readme.md` | Documented tag scheme, management API, demo flow |

### How tagging works

**On cache write** — `cachedRequestJson('/accounts/acct-1001')`:
```
Pipeline:
  SET subgraph:accounts:/accounts/acct-1001  "{...}"  EX 120
  SADD tag:Account                           subgraph:accounts:/accounts/acct-1001
  EXPIRE tag:Account 240
  SADD tag:Account:acct-1001                 subgraph:accounts:/accounts/acct-1001
  EXPIRE tag:Account:acct-1001 240
```

**On purge** — `POST /purge {"tags":["Account:acct-1001"]}`:
```
SMEMBERS tag:Account:acct-1001          → list of cache keys
DEL <each cache key>                    → entries gone
DEL tag:Account:acct-1001               → tag index gone
```

### Auto-tag rules baked in

| Route | Tags |
|---|---|
| `/accounts/{id}` | `Account`, `Account:{id}` |
| `/accounts/{id}/policies` | `Account:{id}`, `Policy` |
| `/accounts/{id}/funds` | `Account:{id}`, `Fund` |
| `/policies/{id}` | `Policy`, `Policy:{id}` |
| `/funds/{id}` | `Fund`, `Fund:{id}` |
| `/funds/{id}/policies` | `Fund:{id}`, `Policy` |
| `/customers/{id}/accounts` | `Customer:{id}`, `Account` |
| `/accounts` (list) | `Account` |
| `/policies` (list) | `Policy` |
| `/funds` (list) | `Fund` |

### Management endpoints (per subgraph)

```bash
GET  http://localhost:5001/health
GET  http://localhost:5001/tags/Account:acct-1001
POST http://localhost:5001/purge   {"tags": ["Account:acct-1001"]}
```

(`5001` = accounts, `5002` = policies, `5003` = funds)

### Try it

```bash
docker compose down && docker compose up --build

# Cache a query
curl -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName } }"}'

# See tags
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account:acct-1001"

# Purge by tag (no TTL wait)
curl -X POST http://localhost:5001/purge \
  -H "Content-Type: application/json" \
  -d '{"tags":["Account:acct-1001"]}'
```

Per-subgraph tagging is the OSS-friendly mirror of what Enterprise Grafbase does natively at the gateway layer — same mental model (`Type:id` tags, group invalidation), implemented at the subgraph layer so it works without a license.