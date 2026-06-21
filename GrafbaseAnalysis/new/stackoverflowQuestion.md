Here's a focused, well-structured Stack Overflow question — written to maximize the chance of a real answer from the Grafbase team or someone who's hit the same wall.

---

## Title (pick one)

- **Grafbase Gateway OSS: `[entity_caching.redis]` configured but gateway never connects to Redis/Valkey**
- **Grafbase self-hosted gateway 0.53.5 silently ignores `entity_caching.redis` backend — is this Enterprise-only?**

The second title is more pointed and tends to attract maintainers faster.

---

## Tags

`graphql` `redis` `graphql-federation` `valkey` `grafbase`

(If `grafbase` doesn't exist as a tag yet, add `apollo-federation` instead — it'll pull federation experts in.)

---

## Body

````markdown
I'm trying to enable persistent entity caching at the Grafbase Gateway layer using the configuration documented at <https://grafbase.com/docs/gateway/configuration/entity-cache#using-redis-for-entity-caching>. The gateway parses the config, queries return correct data, but the gateway **never opens a TCP connection to Redis** and zero keys are ever written.

I've already eliminated the most obvious cause (Apollo Server's default `cache-control: no-store`) and the gateway still doesn't touch Redis. Is the Redis backend gated to Grafbase Enterprise on the OSS image, or am I missing a prerequisite?

## Setup

- Gateway image: `ghcr.io/grafbase/gateway:latest` → reports `Grafbase Gateway 0.53.5`
- Redis-compatible backend: `valkey/valkey:8-alpine` (same RESP protocol)
- Federation: three Apollo Server v4 subgraphs (accounts, policies, funds)
- All services on the same Docker Compose network. `valkey` resolves from inside the gateway container.

### `grafbase/grafbase.toml`

```toml
[entity_caching]
enabled = true
ttl = "60s"

[entity_caching.redis]
url = "redis://valkey:6379"
key_prefix = "grafbase-cache"

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

### Apollo subgraphs emit cacheable `Cache-Control`

By default Apollo Server v4 emits `cache-control: no-store`, which a well-behaved cache must refuse. I overrode that with the official plugin:

```js
const { ApolloServerPluginCacheControl } =
  require("@apollo/server/plugin/cacheControl");

const server = new ApolloServer({
  schema,
  plugins: [
    ApolloServerPluginCacheControl({
      defaultMaxAge: 120,            // per-service value
      calculateHttpHeaders: true
    })
  ]
});
```

Verified directly against the subgraph:

```
$ curl -sI -X POST http://accounts-subgraph:4000/graphql \
    -H "Content-Type: application/json" \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName } }"}'
HTTP/1.1 200 OK
cache-control: max-age=120, public
```

So the upstream response is cacheable per HTTP semantics.

## What I observe

Gateway starts cleanly. **No log line about the Redis backend, no connection error, nothing.**

```
INFO Grafbase Gateway 0.53.5
WARN To send telemetry to the Grafbase Platform, provide a valid graph-ref and access token
WARN Directive definitions are ignored.
INFO GraphQL endpoint exposed at http://0.0.0.0:5000/graphql
```

Filtering all gateway logs for `cache|redis|valkey|backend` returns zero matches.

GraphQL queries through the gateway succeed and return correct data:

```
$ curl -s -X POST http://localhost:5050/graphql \
    -H "Content-Type: application/json" \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
{"data":{"account":{"holderName":"Anika Rao","totalValue":186420.75}}}
```

But Valkey state after **7+ successful queries**:

```
DBSIZE                       → 0
KEYS "grafbase-cache*"       → (empty)
KEYS "*"                     → (empty)
keyspace_hits                → 0
keyspace_misses              → 0
total_commands_processed     → 70   (only healthcheck PINGs)
```

Most damning: the gateway container's IP (`172.18.0.9`) has **never** appeared in `CLIENT LIST`:

```
$ docker exec valkey valkey-cli CLIENT LIST
id=77 addr=127.0.0.1:60814 cmd=client|list  ← my own session
                                              (no entries from 172.18.0.9)
```

The gateway has never opened a TCP connection to Redis. It isn't trying.

## What I've ruled out

- **Network reachability** — other containers on the same network reach `valkey:6379` fine.
- **Wire protocol** — Valkey is RESP-identical to Redis; `redis://` URL scheme is documented as supported.
- **Subgraph `Cache-Control`** — verified `max-age=120, public` is being sent.
- **Key prefix** — `KEYS "*"` shows no keys under any prefix.
- **Config typo** — gateway would refuse to start on a malformed `[entity_caching.redis]` block; it boots silently.
- **Subgraph-side caching masking the test** — `ioredis` removed entirely, no subgraph caching code.

## My question

Is `[entity_caching.redis]` actually implemented in the OSS gateway image (`ghcr.io/grafbase/gateway:latest`, 0.53.5), or is the Redis backend code path gated to the Enterprise binary? The docs at <https://grafbase.com/docs/gateway/configuration/entity-cache#using-redis-for-entity-caching> do not state any Enterprise / license requirement.

If it is supported on OSS, what prerequisite am I missing? (Federation entity caching requires the subgraph to surface `@key`-resolved entities — which our schema does — but is there an additional opt-in I'm not seeing?)

If it's Enterprise-only, can someone point at a docs page or release note confirming that, so I can take it back to my architect?

Reproducible repo with full Docker Compose stack and proof artefacts: *(add your repo URL here)*

Thanks!
````

---

## Things to do before posting

1. **Push the repo to GitHub** and replace the placeholder with the URL — Stack Overflow voters reward reproducible setups heavily.
2. **Pre-search**: search SO and GitHub Issues on `grafbase/grafbase` for "entity_caching redis" / "entity cache enterprise" before posting. If somebody answered already you save yourself the effort.
3. **Cross-post as a GitHub Discussion or Issue** on [github.com/grafbase/grafbase](https://github.com/grafbase/grafbase) — for niche vendor tooling like this you'll usually get a maintainer reply faster there than on SO.
4. **Mention the version explicitly** (0.53.5) in the title or first paragraph — vendors fix things between versions and any answer needs to know which one you're on.

The structure to follow (and what makes this question SO-friendly):
- One-paragraph problem statement
- Specific version numbers and config
- Concrete observed vs expected behaviour with command output
- A "ruled out" list to deflect drive-by "did you check X?" comments
- A specific question, not a vague "help me debug"