# Valkey — Testing Guide

**Source:** consolidated from `GrafbaseAnalysis/ValkeyTestingGuide.md`, `devDocs/cacheTesting.md`, `subgraph-server/server.js`

> Container name assumed: `grafbasepoc-valkey-1`. Subgraph cache-management ports: accounts `5001`, policies `5002`, funds `5003`. Gateway: `http://localhost:5050/graphql`.

---

## 1. Test Plan

Four scenarios. Run them in order — each one builds on the state of the previous.

### S1 — Persistent storage behavior (RDB/AOF)

**Goal:** confirm Valkey writes data to its mounted volume and that data survives a container restart.

| Step | Command | Expected |
|---|---|---|
| 1 | `docker exec grafbasepoc-valkey-1 valkey-cli CONFIG GET save` | Returns RDB snapshot schedule, e.g. `3600 1 300 100 60 10000` |
| 2 | `docker exec grafbasepoc-valkey-1 valkey-cli CONFIG GET appendonly` | `no` by default (RDB-only; OK for POC) |
| 3 | Fire a GraphQL query (see §2.A) | Populates cache |
| 4 | `docker exec grafbasepoc-valkey-1 valkey-cli BGSAVE` | `Background saving started` — forces immediate RDB dump to `/data/dump.rdb` |
| 5 | `docker exec grafbasepoc-valkey-1 valkey-cli LASTSAVE` | Unix timestamp updated |
| 6 | `docker compose restart valkey` | Container restarts |
| 7 | `docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE` | **Same count as before restart** ← pass |

**Pass:** DBSIZE ≥ count taken before restart.
**Fail:** DBSIZE == 0 → volume not mounted, or `save` config disabled snapshots.

### S2 — Cache read/write behavior

**Goal:** verify subgraph populates Valkey on cache miss and serves from Valkey on subsequent calls.

| Step | Command | Expected |
|---|---|---|
| 1 | `docker exec grafbasepoc-valkey-1 valkey-cli FLUSHDB` | `OK` (clean slate) |
| 2 | One GraphQL query (§2.A) | Cache MISS, REST hit |
| 3 | `docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"` | At least `subgraph:accounts:/accounts/acct-1001`, `tag:Account`, `tag:Account:acct-1001` |
| 4 | `docker exec grafbasepoc-valkey-1 valkey-cli GET "subgraph:accounts:/accounts/acct-1001"` | JSON document with `holderName`, `totalValue`, etc. |
| 5 | Re-run query, measure timing loop (§2.C) | Req 1 ~20–50ms; reqs 2–5 ~2–5ms (>3× faster) |
| 6 | `docker logs grafbasepoc-accounts-subgraph-1 2>&1 \| grep cache` | `[cache HIT]` lines after first request |

**Pass:** key present in Valkey **and** repeat requests ≥3× faster.
**Fail:** keys empty after queries → Valkey unreachable (check `CACHE_URL`), or subgraph fell through to direct REST.

### S3 — TTL / key expiration

**Goal:** confirm per-subgraph TTLs (accounts 120s · policies 30s · funds 300s) are honored and entries expire.

| Step | Command | Expected |
|---|---|---|
| 1 | Query a policy (TTL = 30s) | `{ policy(id:"pol-9001") { status } }` |
| 2 | `docker exec grafbasepoc-valkey-1 valkey-cli TTL "subgraph:policies:/policies/pol-9001"` | Integer ≤ 30 |
| 3 | Wait 35s: `sleep 35` | — |
| 4 | Same TTL command | `-2` (key expired & gone) |
| 5 | Same query again | Cache MISS, repopulates with TTL ≤ 30 |
| 6 | Test `PERSIST`: `valkey-cli SET test "x" EX 60` → `valkey-cli PERSIST test` → `valkey-cli TTL test` | `-1` (no expiry) |

**Pass:** all observed TTLs ≤ configured cap; key disappears after sleep.
**Fail:** TTL stays `-1` (no expiry set) → bug in `cachedRequestJson`; or TTL > cap → wrong env var.

### S4 — Data change / update scenarios

**Goal:** confirm the cache serves stale data within TTL, fresh data after TTL or after a tag purge.

| Step | Command | Expected |
|---|---|---|
| 1 | Query account → note `totalValue` (e.g. `186420.75`) | — |
| 2 | Edit `mock-rest-api/server.js`, change `totalValue` to `999999.99`, `docker compose up --build -d accounts-rest` | REST source updated |
| 3 | Query immediately | **Still old value** (cache HIT) |
| 4a | Wait 120s: `sleep 120`; query | **New value** (TTL expired) |
| 4b | OR: `curl -X POST http://localhost:5001/purge -H "Content-Type: application/json" -d '{"tags":["Account:acct-1001"]}'`; query | **New value immediately** (tag purge) |

**Pass:** stale-during-TTL, fresh-after-TTL/purge both observed.
**Fail:** new value appears immediately on step 3 → cache write skipped; old value persists past TTL/purge → TTL not applied or purge endpoint broken.

---

## 2. `valkey-cli` Reference (with expected output)

### A. Sample GraphQL query used throughout

```bash
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
```
Expected: `{"data":{"account":{"holderName":"Anika Rao","totalValue":186420.75}}}`

### B. Core commands

| Purpose | Command | Expected |
|---|---|---|
| Health | `valkey-cli PING` | `PONG` |
| Count keys | `valkey-cli DBSIZE` | integer |
| List keys | `valkey-cli KEYS "*"` | `subgraph:...`, `tag:...` entries |
| Read value | `valkey-cli GET "<key>"` | JSON string |
| Set value | `valkey-cli SET test "hello" EX 60` | `OK` |
| Check TTL | `valkey-cli TTL "<key>"` | seconds remaining; `-1` no expiry; `-2` missing |
| Set TTL | `valkey-cli EXPIRE "<key>" 30` | `1` if set |
| Remove TTL | `valkey-cli PERSIST "<key>"` | `1` if removed |
| List tag members | `valkey-cli SMEMBERS "tag:Account:acct-1001"` | one or more cache keys |
| Save snapshot now | `valkey-cli BGSAVE` | `Background saving started` |
| Last snapshot time | `valkey-cli LASTSAVE` | unix timestamp |
| Snapshot config | `valkey-cli CONFIG GET save` | RDB schedule |
| AOF config | `valkey-cli CONFIG GET appendonly` | `no` / `yes` |
| Wipe DB | `valkey-cli FLUSHDB` | `OK` |
| Wipe all DBs | `valkey-cli FLUSHALL` | `OK` |
| Live op stream | `valkey-cli MONITOR` | streaming `SET`/`GET`/`SADD` lines |
| Stats | `valkey-cli INFO` | sections: server, clients, memory, persistence, stats |
| Memory used | `valkey-cli INFO memory \| grep used_memory_human` | e.g. `used_memory_human:1.23M` |
| Hit/miss counts | `valkey-cli INFO stats \| grep keyspace` | `keyspace_hits`, `keyspace_misses` |

### C. Latency timing loop

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "Request $i: %{time_total}s\n" \
    -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
done
```
Expected: req 1 ≈ 20–50 ms; reqs 2–5 ≈ 2–5 ms.

### D. Subgraph management API

| Purpose | Command | Expected |
|---|---|---|
| Health | `curl http://localhost:5001/health` | `{"service":"accounts","cache":"ready"}` |
| List tag members | `curl http://localhost:5001/tags/Account:acct-1001` | `{"tag":"Account:acct-1001","keys":[...]}` |
| Purge by tag | `curl -X POST http://localhost:5001/purge -H "Content-Type: application/json" -d '{"tags":["Account:acct-1001"]}'` | `{"purgedKeys":N,"purgedTags":1,"keys":[...]}` |

---

## 3. Bruno Collection Structure

> Bruno is not yet present in the repo — proposed layout below. Create as `bruno/valkey-cache-tests/` with one `.bru` file per request, organised by folder.

```
valkey-cache-tests/
├── environments/
│   └── local.bru                    # vars: gatewayUrl, accountsMgmt, policiesMgmt, fundsMgmt
├── 00-setup/
│   ├── flush-cache.bru              # POST gateway? No — call helper / use docker exec instead
│   └── healthcheck-gateway.bru      # GET {{gatewayUrl}}/health  (flag: confirm Grafbase exposes /health)
├── 01-cache-read-write/
│   ├── 01a-query-account-miss.bru   # POST {{gatewayUrl}}/graphql  → expect data
│   ├── 01b-query-account-hit.bru    # same query, time < 10ms via assertion
│   └── 01c-check-tag-members.bru    # GET {{accountsMgmt}}/tags/Account:acct-1001
├── 02-ttl-expiry/
│   ├── 02a-query-policy.bru         # POST gateway, policy TTL = 30s
│   ├── 02b-wait-35s.bru             # Bruno script: setTimeout 35000
│   └── 02c-requery-policy.bru       # MISS again → assert latency back up
├── 03-data-change/
│   ├── 03a-baseline-query.bru       # capture totalValue
│   ├── 03b-stale-within-ttl.bru     # rerun, assert == baseline
│   ├── 03c-purge-tag.bru            # POST {{accountsMgmt}}/purge {"tags":["Account:acct-1001"]}
│   └── 03d-fresh-after-purge.bru    # assert != baseline
└── 04-persistence/
    ├── 04a-populate-cache.bru
    ├── 04b-trigger-bgsave.bru       # external: docker exec ... BGSAVE
    ├── 04c-restart-valkey.bru       # external: docker compose restart valkey
    └── 04d-verify-survives.bru      # GET {{accountsMgmt}}/tags/Account:acct-1001 still returns members
```

**Environment vars (`local.bru`):**

```
vars {
  gatewayUrl: http://localhost:5050
  accountsMgmt: http://localhost:5001
  policiesMgmt: http://localhost:5002
  fundsMgmt: http://localhost:5003
}
```

**Per-request assertions to add:**
- Status `200`
- Response time threshold (e.g. cache HIT < 15 ms)
- JSON body shape (`data.account.holderName` is non-null)
- For purge requests: `body.purgedKeys >= 1`

**Things Bruno can't do natively (flag for runner script):**
- `docker exec ... valkey-cli FLUSHDB` (use a shell pre-script per folder)
- `docker compose restart valkey` (S4)
- `sleep 35` for TTL waits — use Bruno's `setTimeout` in a pre-request script

---

## 4. Pass / Fail Summary

| Scenario | Pass | Fail |
|---|---|---|
| **S1 Persistence** | DBSIZE survives `docker compose restart valkey` | Empty after restart → volume mount or RDB schedule misconfigured |
| **S2 Read/Write** | Keys present after first query; subsequent queries ≥3× faster | No keys → Valkey unreachable; no speedup → cache not used |
| **S3 TTL** | `TTL` reports ≤ configured cap; key gone after sleep | `TTL` returns `-1` or > cap → TTL bug |
| **S4 Update** | Stale within TTL; fresh after TTL **or** after `/purge` | Fresh during TTL → cache skipped; stale after purge → tag index broken |

---

## Flagged / Missing

- **Container/service names** assume default `docker compose` project naming (`grafbasepoc-*`). Confirm with `docker compose ps` before running scripts.
- **Bruno collection**: structure above is proposed — no `.bru` files exist yet. Decide whether to commit them under `bruno/` or keep in a separate workspace repo.
- **Production TTL values**: 120 / 30 / 300 s are POC defaults from `docker-compose.yml`. Confirm before promoting.
- **AOF**: currently disabled (RDB-only). If durability >5 min is required, enable `--appendonly yes` on the Valkey service and re-run S1.
- **Auth/TLS**: Valkey runs unauthenticated on the Docker network. Production tests should add `AUTH` and `rediss://` URLs.
