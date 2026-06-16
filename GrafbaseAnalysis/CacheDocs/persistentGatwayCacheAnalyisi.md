Short answer: **No — not with the OSS Grafbase Gateway.** Persistent gateway-layer caching is gated behind the Enterprise license. But there are workarounds. Here's the full picture:

---

## Why it's not possible on OSS

The Grafbase Gateway has a `[entity_caching.redis]` config block (which we have in `grafbase.toml`), but the **Redis backend is an Enterprise-only feature**. The OSS image silently ignores it and falls back to in-memory caching. There is no OSS flag, env var, or workaround inside the gateway itself.

So at the **actual gateway process layer**, persistent cache requires:
- `ghcr.io/grafbase/gateway:latest-enterprise` image
- A valid `GRAFBASE_LICENSE_KEY`

That's the only "real" gateway-level persistent cache option.

---

## Workaround: Reverse Proxy in Front of the Gateway

If you want **persistent caching that sits at the gateway layer** without Enterprise, you put a **caching reverse proxy in front of the Grafbase Gateway**. The client hits the proxy, the proxy checks Valkey, and only forwards to Grafbase on a miss.

```
Client
   ↓
Caching Proxy (Nginx / Varnish / custom Node)  ← NEW
   ↓ check Valkey here
Grafbase Gateway (OSS)
   ↓
Subgraphs → REST APIs
```

### Three concrete options:

| Option | Tool | Effort | Notes |
|---|---|---|---|
| **A. Nginx + Redis module** | `nginx` with `ngx_http_redis` or OpenResty | Medium | Caches GraphQL POST bodies by hash; works but POST caching is awkward |
| **B. Varnish + xkey** | Varnish Cache | Medium-High | Powerful but designed for GETs; needs vmod for POST/GraphQL |
| **C. Custom Node.js proxy** | Express/Fastify + `ioredis` | Low | ~50 lines of code; full control, easiest to debug — **recommended** |

### Option C — Custom Node Proxy (the cleanest fit for this POC)

A tiny Express server that:
1. Hashes the incoming GraphQL query + variables → cache key
2. Checks Valkey for that key
3. On HIT → returns cached response (Grafbase not touched)
4. On MISS → proxies to `grafbase:5000`, stores response in Valkey with TTL, returns it

**Why this is "gateway-layer":**
- The client still hits a single endpoint
- Caching happens *before* Grafbase processes the query
- Persistent across gateway restarts (Valkey-backed)
- Whole-response caching, not entity-by-entity

**Trade-offs vs current subgraph-layer approach:**

| Aspect | Subgraph-layer (current) | Gateway-layer proxy (new) |
|---|---|---|
| Cache granularity | Per REST call (fine-grained, reusable across queries) | Per full GraphQL query (whole response) |
| Cache reuse | High — same `/accounts/acct-1001` REST call cached once | Low — different query shapes ≠ same cache key |
| Implementation effort | Done | ~1 hour |
| Cache invalidation | Per-route | Per-query-hash (harder) |
| Handles partial mutations | Yes (mutations bypass cache naturally) | Need explicit "skip cache on mutation" logic |

---

## My Recommendation

**Keep the current subgraph-layer Valkey caching** — it's strictly better for this POC because:

1. **Higher hit rate**: An `Account` cached by one GraphQL query gets reused by a totally different query that also references that account. Whole-response caching would treat them as separate keys.
2. **Already persistent**: Valkey volume survives gateway restarts — which was the original design goal.
3. **No new moving parts**: Adding a proxy means another service, another failure point, another Dockerfile.

If you specifically need to **demonstrate gateway-layer persistent caching** for the design doc's acceptance criteria, the cleanest answer for the conclusion is:

> *"Gateway-layer persistent caching requires the Grafbase Enterprise image. As an OSS-compatible alternative, we implemented equivalent persistent caching at the subgraph layer using Valkey + ioredis. A second viable option — a caching reverse proxy (Nginx/Varnish/custom Node) in front of the gateway — was evaluated and rejected as it produces lower cache hit rates than per-entity subgraph caching."*

---

## If you still want to do it — here's the minimal plan

I can add a small Node.js caching proxy if you want a side-by-side demo:

- New service `cache-proxy/` (Express + ioredis, ~60 lines)
- New compose entry `cache-proxy` on port `5050`
- Grafbase moves to internal port (no host expose)
- Proxy forwards to `http://grafbase:5000/graphql`
- Cache key: `gw:${sha256(query+variables+operationName)}`
- TTL: 60s default, skips caching on `mutation` operations

Just say the word and I'll implement it as a second cache layer (you'd have both working at once — subgraph-layer + gateway-proxy-layer — and could compare hit rates).