Good constraint. Since the Enterprise image is off the table, the alternative is **subgraph-level Valkey caching** — each Node.js subgraph server checks Valkey before calling the REST API. This gives persistent cache without touching the gateway image. Let me redesign the plan.

Now I have everything I need. Let me write the revised plan.

Now implementing all 6 file changes in order.

Now add the `cachedRequestJson` function right after `requestJson`:

Now replace all `requestJson(` calls inside the resolver functions with `cachedRequestJson(`:

Now update `docker-compose.yml` — add `CACHE_URL` + `CACHE_TTL` to each subgraph and `depends_on: valkey`:

Now update `.env.example` and `grafbase.toml`:

Now update `grafbase.toml` to comment out the Redis block:

Now update the `Readme.md` Caching section:

Also clean up the outdated env vars section in README:

Now install the new dependency and verify the server.js looks correct:

Everything looks perfect. Here's a summary of everything that was done:

---

## ✅ Done — All 6 Files Updated

### What changed and why

| File | Change |
|---|---|
| `subgraph-server/package.json` | Added `ioredis ^5.6.0` — the Redis/Valkey client |
| `subgraph-server/server.js` | Added Redis client init + `cachedRequestJson()` wrapper; all 10 resolver calls now go through cache |
| `docker-compose.yml` | Added `CACHE_URL` + `CACHE_TTL` to all 3 subgraphs; added `depends_on: valkey: condition: service_healthy` so subgraphs wait for Valkey to be ready |
| `.env.example` | Documented `CACHE_URL` and TTL rationale |
| `grafbase/grafbase.toml` | Commented out `[entity_caching.redis]` (was silently ignored by OSS anyway); added clear note about Enterprise path |
| `Readme.md` | Replaced the "in-memory only" caveat with the correct two-layer caching description |

### How to verify

```bash
# Rebuild and start
docker compose down
docker compose up --build

# Terminal 2 — watch Valkey receive writes live
docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR

# Terminal 3 — fire a query
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
```

**You should now see** `SET subgraph:accounts:/accounts/acct-1001 ...` in the MONITOR terminal on the first query, and `GET ...` on every repeat — **Valkey is the cache, not memory**. Keys persist if you `docker compose restart grafbase`.