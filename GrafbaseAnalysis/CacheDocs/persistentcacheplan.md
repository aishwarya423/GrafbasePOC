# Plan: Persistent Valkey Caching at the Subgraph Layer (No Enterprise License)

## Context

The Grafbase OSS gateway supports only in-memory entity caching — the `[entity_caching.redis]` config in `grafbase.toml` is silently ignored without the Enterprise license. Since the Enterprise image is out of scope, we move caching one layer down: **each subgraph Node.js server caches its own REST API responses in Valkey** before returning data to the gateway.

This gives persistent, TTL-controlled Valkey caching with zero changes to the gateway image, and Valkey is already running in Docker Compose with a persistent volume.

```
Grafbase Gateway (OSS, in-memory)
       |
  Subgraph Server (Node.js)
       |── check Valkey first  ← NEW
       |── on HIT: return cached JSON
       |── on MISS: call REST API → store in Valkey → return
       |
  Mock REST APIs
```

---

## Files to Change

| File | Change |
|---|---|
| `subgraph-server/package.json` | Add `ioredis` dependency |
| `subgraph-server/server.js` | Wrap `requestJson()` with Valkey cache |
| `docker-compose.yml` | Pass `CACHE_URL` + `CACHE_TTL` env vars to each subgraph |
| `.env.example` | Document `CACHE_URL` and `CACHE_TTL` variables |
| `grafbase/grafbase.toml` | Remove/disable `[entity_caching.redis]` block (no-op on OSS but avoids confusion) |
| `Readme.md` | Update Caching section to describe subgraph-level caching |

---

## Detailed Changes

### 1. `subgraph-server/package.json`

Add `ioredis` (production Redis/Valkey client for Node.js):
```json
"dependencies": {
  ...existing deps...,
  "ioredis": "^5.6.0"
}
```

### 2. `subgraph-server/server.js`

**Add at the top** — create a shared Valkey client and a cached fetch wrapper:

```js
const Redis = require("ioredis");

const cacheUrl = process.env.CACHE_URL || "";
const cacheTtl = Number(process.env.CACHE_TTL || 60);

// Only connect if CACHE_URL is set; fall through to REST if not
const redis = cacheUrl ? new Redis(cacheUrl, { lazyConnect: true }) : null;
if (redis) {
  redis.connect().catch((e) => console.warn("Valkey unavailable, caching disabled:", e.message));
}

async function cachedRequestJson(route) {
  const key = `subgraph:${serviceName}:${route}`;

  if (redis && redis.status === "ready") {
    const cached = await redis.get(key);
    if (cached !== null) {
      console.log(`[cache HIT]  ${key}`);
      return JSON.parse(cached);
    }
    console.log(`[cache MISS] ${key}`);
  }

  const data = await requestJson(route);           // existing REST fetch
  if (redis && redis.status === "ready" && data !== null) {
    await redis.set(key, JSON.stringify(data), "EX", cacheTtl);
  }
  return data;
}
```

**Replace all `requestJson(` calls** with `cachedRequestJson(` in the three resolver functions.

> `requestJson` itself stays unchanged — it's still used internally by `cachedRequestJson`.

### 3. `docker-compose.yml`

Add `CACHE_URL` and `CACHE_TTL` to each subgraph's `environment` block:

```yaml
accounts-subgraph:
  environment:
    ...existing vars...
    CACHE_URL: redis://valkey:6379
    CACHE_TTL: 120          # accounts data changes infrequently

policies-subgraph:
  environment:
    ...existing vars...
    CACHE_URL: redis://valkey:6379
    CACHE_TTL: 30           # policy status can change

funds-subgraph:
  environment:
    ...existing vars...
    CACHE_URL: redis://valkey:6379
    CACHE_TTL: 300          # fund prices update daily
```

Also add `depends_on: valkey` (with `condition: service_healthy`) to each subgraph service so they start after Valkey is ready.

### 4. `.env.example`

Document the new variables:
```env
# Subgraph-level Valkey cache (persistent, no Enterprise license needed)
CACHE_URL=redis://valkey:6379
# Per-service TTL overrides (seconds) — set in docker-compose.yml per subgraph
```

### 5. `grafbase/grafbase.toml`

Remove the `[entity_caching.redis]` block and keep only in-memory entity caching (the OSS default), or comment it out with a clear note:
```toml
# Entity caching — in-memory only on OSS gateway image.
# Persistent caching is handled at the subgraph layer (see docker-compose.yml).
[entity_caching]
enabled = true
ttl = "60s"
# [entity_caching.redis]  ← requires Enterprise image, not used here
# url = "redis://valkey:6379"
```

### 6. `Readme.md` — Caching section rewrite

Replace the current caching section to explain:
- Caching is at the **subgraph layer** (REST response cache in Valkey)
- Gateway also has in-memory entity caching as a second layer
- Per-subgraph TTLs (120s / 30s / 300s) are set in `docker-compose.yml`
- Testing commands (same `valkey-cli KEYS`, `MONITOR`, TTL tests still apply)

---

## Cache Key Design

Keys follow the pattern: `subgraph:<service>:<route>`

Examples:
- `subgraph:accounts:/accounts/acct-1001`
- `subgraph:policies:/accounts/acct-1001/policies`
- `subgraph:funds:/funds/fund-001`

This namespaces keys by service to avoid collisions.

---

## Graceful Degradation

If Valkey is unreachable (container down, network error), the `redis.status !== "ready"` check causes `cachedRequestJson` to fall through directly to `requestJson` — subgraphs continue working without cache, just slower. No crash, no error surfaced to the user.

---

## Verification Steps

```bash
# 1. Rebuild with new image
docker compose down
docker compose up --build

# 2. Watch Valkey receive writes in real time
docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR

# 3. Fire a query — should see SET commands in MONITOR
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'

# 4. Check stored keys (should NOT be empty now)
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"

# 5. Repeat the query — MONITOR shows GET (hit), no REST call
# Subgraph logs show [cache HIT]

# 6. Persistence test — restart grafbase only, Valkey keeps data
docker compose restart grafbase
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
# Keys still present → persistent across gateway restarts

# 7. TTL test — wait > 30s (policies TTL) then query policies
# After TTL, subgraph log shows [cache MISS], REST called again
```

---

## Summary of Acceptance Criteria vs Approach

| Acceptance Criteria | How Met |
|---|---|
| Redis/Valkey runs with Grafbase | Valkey already in compose — no change |
| Runtime uses cache backend | `ioredis` in each subgraph writes/reads Valkey |
| Repeat queries return cached response | `cachedRequestJson` returns Valkey data on HIT |
| TTL/tagging demonstrated | Per-subgraph `CACHE_TTL` env vars (30/120/300s) |
| Cache survives gateway restart | Valkey volume `valkey-data` persists independently |
| Documentation updated | Readme.md Caching section updated |