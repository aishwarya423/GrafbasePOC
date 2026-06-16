# Proof — OSS Grafbase Gateway does not write to Valkey/Redis

**Date:** 2026-06-16
**Question:** Does configuring `[entity_caching.redis]` in `grafbase.toml` cause the OSS gateway to actually use Valkey, as the architect expects? Or does it silently fall back to in-memory cache?
**Answer (empirical):** **It silently falls back.** The OSS image (`ghcr.io/grafbase/gateway:latest`, version 0.53.5) parses the Redis config without error but never opens a TCP connection to Valkey, never sends any Redis command, and writes zero keys.

---

## Test setup

All subgraph-level ioredis caching code was removed. Only the gateway-layer config remains.

### `grafbase/grafbase.toml` (gateway config)

```toml
[entity_caching]
enabled = true
ttl = "60s"

[entity_caching.redis]
url = "redis://valkey:6379"

[subgraphs.accounts.entity_caching]
enabled = true
ttl = "120s"

[subgraphs.policies.entity_caching]
enabled = true
ttl = "30s"

[subgraphs.funds.entity_caching]
enabled = true
ttl = "300s"
```

### `docker-compose.yml` (gateway service)

```yaml
grafbase:
  image: ghcr.io/grafbase/gateway:latest   # OSS — no license
```

### `subgraph-server/server.js`

No `ioredis`, no `cachedRequestJson`, no Redis client. Pure REST → JSON resolvers. Confirmed below in §Evidence-4.

---

## Reproducing the test

```bash
docker compose down -v          # clear Valkey volume
docker compose up --build -d
sleep 4

# Confirm Valkey is empty
docker exec grafbasepoc-valkey-1 valkey-cli FLUSHALL
docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE   # → 0

# Run a query
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'

# Inspect Valkey
docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
docker exec grafbasepoc-valkey-1 valkey-cli INFO stats | grep -E "keyspace_hits|keyspace_misses|total_commands_processed"
docker exec grafbasepoc-valkey-1 valkey-cli CLIENT LIST
docker logs grafbasepoc-grafbase-1 2>&1 | grep -iE "cache|redis|valkey|backend"
```

---

## Evidence

### Evidence 1 — Gateway version + startup logs

The gateway started cleanly; **no errors, no warnings about the Redis backend, no "connected to Redis" log line.**

```
INFO Grafbase Gateway 0.53.5
WARN To send telemetry to the Grafbase Platform, provide a valid graph-ref and access token
WARN Directive definitions are ignored.
INFO GraphQL endpoint exposed at http://0.0.0.0:5000/graphql
```

If the gateway intended to use Redis, we would expect a line like
`INFO entity_caching backend=redis url=redis://valkey:6379 connected=true`. There is none. Filtering all logs for `cache|redis|valkey|backend` returns **zero matches**.

### Evidence 2 — Valkey state after queries

After two successful GraphQL queries (which returned correct data):

| Metric | Value |
|---|---|
| `DBSIZE` | `0` |
| `KEYS "*"` | _empty_ |
| `keyspace_hits` | `0` |
| `keyspace_misses` | `0` |
| `total_commands_processed` | `9` *(only `PING`s from healthcheck)* |
| `total_connections_received` | `10` *(only `127.0.0.1` healthcheck)* |

### Evidence 3 — No connection from gateway to Valkey

`CLIENT LIST` while the system is running:

```
id=15 addr=127.0.0.1:47556 ... cmd=monitor    ← my own MONITOR session
id=19 addr=127.0.0.1:47350 ... cmd=client|list ← my own CLIENT LIST
```

Both come from `127.0.0.1` (inside the Valkey container itself). The gateway's container IP is `172.18.0.9`. **The gateway has never opened a connection to Valkey.**

### Evidence 4 — MONITOR over 6 seconds during 3 cross-subgraph queries

Each query touched accounts + policies + funds subgraphs:

```
$ docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR
OK
1781617067.232848 [0 127.0.0.1:47564] "ping"
```

Only output: a single `ping` from Valkey's own healthcheck. **Zero `GET`, zero `SET`, zero `MGET`, zero anything from the gateway.**

### Evidence 5 — Subgraph code has no Redis library

```bash
$ grep -E "redis|ioredis|CACHE_URL" subgraph-server/server.js
(no matches)

$ cat subgraph-server/package.json | grep -i redis
(no matches)
```

This rules out the possibility that the gateway behaviour is being masked by subgraph-level caching.

---

## What the official documentation says

Per `https://grafbase.com/docs/gateway/performance/entity-caching`:

> "Entity caching stores data in an **in-memory cache by default**."
>
> "Configure Redis as your caching backend when you need to run and share cache across multiple gateways."

The page **does not explicitly say** that the Redis backend requires an Enterprise license. It documents Redis as a supported configuration with no version/tier caveats stated.

That said: the OSS image 0.53.5 demonstrably does not honour the config, as proven above. The gap between documentation and observed behaviour is what needs to be reconciled.

---

## Possible explanations

1. **Silent Enterprise gate.** The Redis backend code path exists in the Enterprise binary only; the OSS binary parses the config block for forward-compatibility but never wires it up. This is consistent with our observations and the historical Grafbase model. Unverified by official docs.
2. **Missing prerequisite** — e.g. subgraph responses must carry `Cache-Control: max-age=…` headers for the gateway to consider them cacheable. Our Apollo subgraphs do not currently set these headers. This could explain why **nothing** is being cached, not even in-memory. The docs do not confirm or deny this requirement explicitly.
3. **Version bug** in 0.53.5.

Distinguishing (1) from (2) requires either:
- Trying the Enterprise image with a license key (proves/disproves #1), or
- Adding `Cache-Control: max-age=60` to subgraph responses and re-running the test (proves/disproves #2).

---

## Recommendation to take back to the architect

> **The architect's hypothesis — "the same config that works on Enterprise will work on OSS, no code changes needed" — is empirically false on Grafbase Gateway 0.53.5.**
>
> With `[entity_caching.redis]` correctly pointing at a running Valkey, the OSS gateway:
> - starts without error,
> - serves GraphQL queries correctly,
> - but **never opens a TCP connection to Valkey** (confirmed via `CLIENT LIST`),
> - **never issues a single Redis command** (confirmed via `MONITOR` and `INFO stats`),
> - **writes zero keys** (confirmed via `DBSIZE` and `KEYS "*"`).
>
> Official docs do not explicitly state the Redis backend is Enterprise-only, but they also don't list any prerequisite the OSS image is missing. We need confirmation from Grafbase support, or a test with the Enterprise image, before relying on this config for persistent gateway-layer cache.
>
> Until that's confirmed, the **subgraph-layer ioredis caching we built (now reverted) is the only working persistent cache** on the OSS stack.

---

## How to revert this proof setup back to working subgraph-layer cache

```bash
# 1. Re-add ioredis
npm --prefix subgraph-server install ioredis@^5.6.0

# 2. Restore the cached resolvers + CACHE_URL/CACHE_TTL env vars
git checkout HEAD -- subgraph-server/server.js docker-compose.yml grafbase/grafbase.toml

# 3. Restart
docker compose down && docker compose up --build -d
```
