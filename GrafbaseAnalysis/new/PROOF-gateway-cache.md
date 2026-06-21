# SOLVED — Gateway-layer Valkey/Redis caching on OSS Grafbase Gateway

**Date:** 2026-06-19
**Gateway:** `ghcr.io/grafbase/gateway:latest` → `Grafbase Gateway 0.53.5` (OSS, MPL-2.0)
**Status:** ✅ Working without an Enterprise license

## The fix — one undocumented config line

The official docs at `grafbase.com/docs/gateway/configuration/entity-cache#using-redis-for-entity-caching` show this:

```toml
[entity_caching.redis]
url = "..."
key_prefix = "..."
```

That's incomplete. Setting only `[entity_caching.redis]` does **not** switch the backend — the `storage` field on `[entity_caching]` defaults to `Memory`. You must explicitly set it to `redis`:

```toml
[entity_caching]
enabled  = true
storage  = "redis"        # ← required, undocumented
ttl      = "60s"

[entity_caching.redis]
url        = "redis://valkey:6379"
key_prefix = "grafbase-cache"
```

This is confirmed by reading the OSS source at
[`crates/gateway-config/src/entity_caching.rs`](https://github.com/grafbase/grafbase/blob/main/crates/gateway-config/src/entity_caching.rs):

```rust
pub struct EntityCachingConfig {
    pub enabled: bool,
    pub storage: EntityCachingStorage,   // ← defaults to Memory
    pub redis: EntityCachingRedisConfig,
    pub ttl: Duration,
}

pub enum EntityCachingStorage {
    #[default]
    Memory,
    Redis,
}
```

## The other prerequisite — Apollo `Cache-Control`

Apollo Server 4 defaults to `cache-control: no-store`. A well-behaved cache (Grafbase included) must refuse to cache such responses. Add the official plugin so each subgraph emits a cacheable header:

```js
const { ApolloServerPluginCacheControl } = require("@apollo/server/plugin/cacheControl");

new ApolloServer({
  schema,
  plugins: [
    ApolloServerPluginCacheControl({
      defaultMaxAge: 120,           // per-subgraph value
      calculateHttpHeaders: true
    })
  ]
});
```

Verified:

```
$ curl -sI -X POST http://accounts-subgraph:4000/graphql -d '...'
HTTP/1.1 200 OK
cache-control: max-age=120, public
```

## Proof of working setup

After `docker compose restart grafbase`:

```
$ docker exec valkey valkey-cli FLUSHALL && curl -s -X POST :5050/graphql \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue policies { policyNumber } } }"}'
{"data":{"account":{"holderName":"Anika Rao","totalValue":186420.75, ... }}}

$ docker exec valkey valkey-cli DBSIZE
6

$ docker exec valkey valkey-cli KEYS "*"
grafbase-cache-1342a725...
grafbase-cache-16fb9b2c...
grafbase-cache-2771190c...
...

$ docker exec valkey valkey-cli CLIENT LIST
id=240 addr=172.18.0.9:35654 ... lib-name=redis-rs lib-ver=0.32.5 cmd=get tot-cmds=54
                  ↑ gateway container IP             ↑ Grafbase's Rust Redis client
```

### Latency proof

```
Request 1: 0.0038s   ← cache MISS (REST upstream)
Request 2: 0.0010s   ← cache HIT (Valkey)
Request 3: 0.0010s   ← cache HIT
Request 4: 0.0008s   ← cache HIT
Request 5: 0.0008s   ← cache HIT
```

### Stats

```
keyspace_hits:    4
keyspace_misses:  9
total_commands_processed: 304
```

## Summary

| Question | Answer |
|---|---|
| Is Redis backend Enterprise-only? | **No** — fully OSS, MPL-2.0 |
| What was missing in the original config? | `storage = "redis"` on `[entity_caching]` |
| Is the `storage` field documented? | Not in the public docs page; only in the Rust source |
| Does the subgraph need `Cache-Control`? | Yes — Apollo's default `no-store` blocks caching |
| Does the OSS gateway 0.53.5 actually talk to Valkey? | Yes, confirmed via `CLIENT LIST` (`lib-name=redis-rs`) |

## Heads-up for the future

The Guild acquired Grafbase. The Grafbase Gateway repo is moving toward archive. For long-term planning consider:

- **Hive Gateway** (The Guild's federation gateway)
- **Apollo Router** (Rust, GraphOS-compatible)

Both have native persistent-cache support.

## Current code state

| File | Change |
|---|---|
| `grafbase/grafbase.toml` | `[entity_caching]` has `storage = "redis"` |
| `docker-compose.yml` | Subgraphs use `CACHE_MAX_AGE` env var only (no `CACHE_URL`) |
| `subgraph-server/server.js` | `ApolloServerPluginCacheControl` enabled; no `ioredis` |
| `subgraph-server/package.json` | `ioredis` removed |

Subgraph-layer `ioredis` caching is no longer needed — gateway-layer caching covers everything with cleaner semantics (entity-level keys, automatic federation-aware reuse).
