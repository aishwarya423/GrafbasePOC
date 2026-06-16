# Valkey — Client Demo

**Source:** consolidated from `GrafbaseAnalysis/*.md` and `devDocs/*.md`

---

## 1. Why Valkey

> Source: `RedisAnalysis.md`, `ValkeyOrRedisSwitchingChanges.md`

- **Valkey** is the BSD-licensed fork of Redis, created in March 2024 by the Linux Foundation after Redis Inc. moved Redis to a restrictive SSPL/RSAL license.
- 100% **wire-protocol compatible** with Redis — same RESP protocol, same commands (`GET`, `SET`, `EXPIRE` …), same `redis://` URL scheme.
- Backed by AWS, Google, Oracle. Slightly faster than Redis 7 thanks to 8.x multi-threading.
- For any tool that says "Redis client / Redis URL," Valkey is a drop-in.

| | Redis | **Valkey** |
|---|---|---|
| License | SSPL/RSAL (restrictive since 2024) | **BSD (fully open)** |
| Wire protocol | RESP | RESP (identical) |
| Image | `redis:7-alpine` | `valkey/valkey:8-alpine` |
| Cost | Free; commercial restrictions | **Free forever** |
| Future-proof | Vendor-controlled | Community-governed |


---

## 2. Valkey as In-Memory Cache

> Source: `devDocs/inMemoryCache.md`, `InMemoryToValkeyCache.md`

Valkey runs as a separate Docker container with a persistent volume (`valkey-data`). Each subgraph uses `ioredis` to cache REST responses before returning them to the Grafbase Gateway.

```
GraphQL Query
      │
      ▼
 Grafbase Gateway (OSS)
      │
      ▼
 Subgraph (Node + ioredis) ──► Valkey container (persistent /data volume)
      │ cache MISS
      ▼
 REST API
```

**Why subgraph layer (not gateway layer):** the OSS Grafbase Gateway silently uses in-memory entity caching — its `[entity_caching.redis]` backend is Enterprise-only. We implemented persistent caching at the subgraph instead so it works on OSS.

**Cache keys:** `subgraph:<service>:<route>` (e.g. `subgraph:accounts:/accounts/acct-1001`)
**TTLs (per business need):** accounts 120s · policies 30s · funds 300s
**Entity tagging:** every cache entry is auto-tagged (`Account`, `Account:acct-1001`, etc.) and can be purged by tag via `POST /purge` on each subgraph's management port (5001/5002/5003).

---

## 3. Valkey Enterprise (Grafbase Enterprise gateway)

> Source: `InMemoryToValkeyCache.md`, `devDocs/inMemoryCache.md`

Activating the Enterprise gateway moves caching from the subgraphs **up to the gateway layer**, with Valkey as the persistent backend.

| | OSS gateway (today) | Enterprise gateway |
|---|---|---|
| Cache location | Subgraph (ioredis) | **Gateway (native)** |
| Cache backend | Valkey (via ioredis) | **Valkey (native)** |
| Cache key | REST route | **`Type:id` federation entity** |
| Cross-query entity reuse | Limited (per route) | **High (per entity)** |
| Tagging | Manual (we built it) | **Built-in** |
| License | Free | Requires `GRAFBASE_LICENSE_KEY` |

**Activation (3 changes):**
1. `docker-compose.yml`: `ghcr.io/grafbase/gateway:latest` → `latest-enterprise`
2. `grafbase.toml`: uncomment `[entity_caching.redis] url = "redis://valkey:6379"`
3. `.env`: add `GRAFBASE_LICENSE_KEY=…`

No code changes; the Valkey container and config are already wired.

---

## 4. Switching Between Redis and Valkey

> Source: `ValkeyOrRedisSwitchingChanges.md`

Three lines, two files. The `redis://` URL scheme is the protocol name, not branding — Grafbase doesn't care which server answers.

| Change | Valkey | Redis |
|---|---|---|
| `docker-compose.yml` image | `valkey/valkey:8-alpine` | `redis:7-alpine` |
| `docker-compose.yml` healthcheck | `valkey-cli ping` | `redis-cli ping` |
| `grafbase.toml` URL hostname | `redis://valkey:6379` | `redis://redis:6379` |

Hostname must match the docker-compose service name (Docker DNS). Everything else — config keys, client code — stays identical.

---

## 5. Subgraph Cache Implementation

> Source: `subgraph-server/server.js`, `devDocs/inMemoryCache.md`

```
┌────────────────────────────────────────────────────────────┐
│                  Subgraph (Node.js)                        │
│                                                            │
│   resolver → cachedRequestJson(route)                      │
│                  │                                         │
│       ┌──────────┴──────────┐                              │
│       │ HIT  ─ return JSON  │ ◄── Valkey (TTL'd entry)     │
│       │ MISS ─ fetch REST,  │                              │
│       │        SET key,     │                              │
│       │        SADD tags    │                              │
│       └─────────────────────┘                              │
└────────────────────────────────────────────────────────────┘
```

- Cache write also registers the key into per-tag Valkey SETs (`tag:Account`, `tag:Account:acct-1001`).
- Each subgraph exposes a management HTTP API: `GET /health`, `GET /tags/:tag`, `POST /purge`.
- Graceful degradation: if Valkey is unreachable, subgraphs fall back to direct REST calls.

---

## 6. Gateway Cache Design Summary

> Source: `devDocs/wtsDesignDocument.md`, `InMemoryToValkeyCache.md`

**Objective:** validate Redis/Valkey-backed entity caching in the local Grafbase federation runtime.

**Key decisions:**
- Valkey deployed via Docker Compose with persistent volume.
- Per-subgraph TTL overrides driven by data volatility (accounts 120s / policies 30s / funds 300s).
- OSS limitation acknowledged: gateway-layer Valkey backend is Enterprise-only → subgraph-layer caching used as the OSS-compatible equivalent.
- Risk accepted: cache validation fails on cold miss if upstream REST is down — acceptable for POC.

**Acceptance criteria (status):**

| Criterion | Status |
|---|---|
| Valkey runs with Grafbase | ✅ |
| Runtime uses cache backend | ✅ (subgraph layer) |
| Repeat queries return cached response | ✅ |
| TTL / tagging demonstrated | ✅ (both implemented) |
| Cache survives restart | ✅ (Valkey volume) |
| Documentation updated | ✅ |

---

## 7. Demo Checklist


```bash
# 0. Bring stack up clean
docker compose down && docker compose up --build -d

# 1. SHOW: services running, Valkey healthy
docker compose ps

# 2. SHOW: empty cache
docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE
# → (integer) 0

# 3. RUN: first query — cache MISS
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'

# 4. SHOW: cache populated + auto-tags
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account:acct-1001"

# 5. SHOW: cache HIT latency vs MISS
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "Request $i: %{time_total}s\n" \
    -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
done
# expected: req 1 slow, req 2–5 ~5–10x faster

# 6. SHOW: instant tag-based invalidation (no TTL wait)
curl -X POST http://localhost:5001/purge -H "Content-Type: application/json" \
  -d '{"tags":["Account:acct-1001"]}'
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
# → tagged entries gone

# 7. SHOW: persistence — cache survives gateway restart
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName } }"}'
docker compose restart grafbase
docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE
# → still > 0

# 8. SHOW: live monitor (keep open during Q&A)
docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR
```

 