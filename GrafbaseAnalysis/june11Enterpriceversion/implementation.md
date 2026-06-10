I'll convert the code to use Enterprise gateway-layer caching. All subgraph caching code will be removed and the gateway Redis backend will be activated.

Now uncomment and activate the Redis backend in `grafbase.toml`:

Now strip the subgraph caching code out of `server.js`:

Now revert all `cachedRequestJson(` back to `requestJson(`:

Remove `ioredis` from `package.json`:

Now update `.env.example` and `Readme.md`:

Let me verify the final state of the key files:

All Enterprise gateway-layer caching changes are in place.

---

## ✅ Done — Code is ready for Enterprise license

### What changed

| File | Change |
|---|---|
| `docker-compose.yml` | Switched image to `ghcr.io/grafbase/gateway:latest-enterprise`; removed `CACHE_URL`/`CACHE_TTL` and Valkey deps from subgraphs |
| `grafbase/grafbase.toml` | Activated `[entity_caching.redis]` with `url = "redis://valkey:6379"` |
| `subgraph-server/server.js` | Removed `ioredis`, `cachedRequestJson()`, all cache logic — back to pure resolvers |
| `subgraph-server/package.json` | Removed `ioredis` dependency |
| `.env.example` | Replaced `CACHE_URL` with `GRAFBASE_LICENSE_KEY` placeholder |
| `Readme.md` | Updated Caching section to describe gateway-layer Valkey caching |

### What you need to do when you get the license

**Step 1** — Get the license:
1. Sign up at https://grafbase.com
2. Dashboard → Settings → copy the license key

**Step 2** — Create `.env` from `.env.example`:
```bash
cp .env.example .env
# Edit .env and replace `your-grafbase-enterprise-license-key` with your real key
```

**Step 3** — Start:
```bash
docker compose down
docker compose up --build
```

**Step 4** — Verify Valkey is receiving entity cache writes:
```bash
# Terminal 1
docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR

# Terminal 2
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
```

You should see `SET` commands with entity-shaped keys (e.g. `Account:acct-1001`) in MONITOR.

### Notes

- **Don't try to run this code on OSS** — the gateway will fail to start without a valid `GRAFBASE_LICENSE_KEY` because it's using the Enterprise image.
- The Valkey container, the `valkey-data` volume, and the persistence story are unchanged — only the cache producer flipped from subgraph-Node to gateway.
- Subgraph code is now back to being pure GraphQL resolvers with zero caching concerns. Cleaner architecture.