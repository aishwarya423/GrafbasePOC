Let me scan the repo to check what's implemented.

Here's the gap analysis against the design document:

---

## What's Already Done

| Design Requirement | Status |
|---|---|
| Valkey service in Docker Compose with named volume | Done (`valkey/valkey:8-alpine`, `valkey-data` volume) |
| `grafbase` depends on Valkey with health check | Done |
| `[entity_caching.redis]` pointing to `redis://valkey:6379` | Done in `grafbase.toml` |
| TTL configuration (global + per-subgraph overrides) | Done (60s global, 120s/30s/300s per subgraph) |
| Cache testing guide (miss/hit/TTL/persistence steps) | Done (`GrafbaseAnalysis/ValkeyTestingGuide.md`) |
| README updated with Valkey section, architecture diagram | Done |

---

## What's Missing / Incomplete

### 1. Enterprise Gateway Image — **Blocker**
The design says "Runtime uses cache backend / cache connection verified." The README itself admits the OSS image (`ghcr.io/grafbase/gateway:latest`) uses **in-memory** cache only — Valkey is wired but receives nothing. The design acceptance criteria cannot be met until the enterprise image is used.

**Gap:** `docker-compose.yml` uses the OSS image. The `.env.example` does not include `GRAFBASE_LICENSE_KEY`.

### 2. Persistence Validation — **Not Demonstrated**
The design explicitly calls out: *"Restart Grafbase container → verify cached data remains in Redis/Valkey."* The testing guide mentions this conceptually but only if Valkey actually receives writes (blocked by gap #1). No script or documented step exists that specifically restarts **only** the grafbase container (not the whole stack) and confirms Valkey keys survive.

### 3. Cache Miss/Hit Validation via Valkey — **Not Demonstrated**
`valkey-cli KEYS "*"` currently returns empty. The design's acceptance criteria "Repeat queries return cached response" and "Cache connection verified" require actual Valkey writes, not just in-memory caching.

### 4. `CACHE_ENABLED` / `CACHE_URL` / `CACHE_TTL` env vars — **Not Used**
The design doc shows these three env vars. The actual implementation uses `grafbase.toml` TOML config (which is fine), but the `.env.example` doesn't document `GRAFBASE_LICENSE_KEY` as required.

---

## What Needs to Be Done

1. **Add `GRAFBASE_LICENSE_KEY` to `.env.example`** with a placeholder and explanation.
2. **Switch the image (or document the switch)** — either update `docker-compose.yml` to use `ghcr.io/grafbase/gateway:latest-enterprise`, or create a separate `docker-compose.enterprise.yml` override. At minimum, add a clear comment in `docker-compose.yml` explaining how to switch.
3. **Add a persistence test script/steps** — document the exact sequence: populate cache → `docker compose restart grafbase` → `valkey-cli KEYS "*"` → confirm keys still exist.

---

## What to Document at Conclusion (High-Level)

For your story conclusion/Confluence page, cover these sections:

**1. Feasibility Verdict**
> Grafbase + Valkey integration is architecturally feasible. The TOML config, Docker Compose wiring, and per-subgraph TTL overrides all work correctly. The only gate is licensing: the OSS gateway uses in-memory cache; the Enterprise image activates the Redis/Valkey backend.

**2. What Was Validated (OSS image)**
- In-memory entity caching is active and measurable (request 2+ is faster than request 1)
- TTL-based stale data behavior works (changed REST data not visible until TTL expires)
- Docker Compose orchestration, Valkey healthcheck, and volume persistence config are all correct

**3. What Requires Enterprise License**
- Valkey actually receiving cache writes (`valkey-cli KEYS "*"` returning data)
- Persistence across gateway restarts (Valkey survives; in-memory does not)
- Full cache hit/miss observability via `valkey-cli MONITOR`

**4. Configuration Pattern Established**
- `[entity_caching]` + `[entity_caching.redis]` in `grafbase.toml` is the correct config path
- Per-subgraph TTL overrides via `[subgraphs.<name>.entity_caching]` work as designed
- No application code changes needed — caching is entirely gateway-layer configuration

**5. Risk / Limitation (from design doc)**
> Confirmed: if mock REST APIs are down on cache miss, the first request fails. Acceptable for POC.

**6. Next Steps to Complete Full Validation**
- Obtain enterprise license key → set `GRAFBASE_LICENSE_KEY` in `.env`
- Switch to enterprise image → run persistence and Valkey monitor tests from `ValkeyTestingGuide.md`