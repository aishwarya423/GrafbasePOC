# POC for Cache Key Visibility & Valkey Entity Tagging

## Overview

This POC makes the Valkey cache used by the Grafbase federation pilot **transparent and inspectable**. When a GraphQL query such as `account(id: "acct-1001")` runs, each subgraph caches the REST response in Valkey and registers that cache key under **entity tag indexes**. Those indexes are what later invalidation work will use.

What was achieved:

- Traced how `subgraph-server/server.js` maps REST routes and entity ids to Valkey keys.
- Confirmed the split between **payload keys** (Valkey `string`) and **tag indexes** (Valkey `set` of payload keys).
- Executed sample queries for `acct-1001` and inspected the result with `GET`, `TYPE`, `SMEMBERS`, `TTL` (evidence in [Validation results](#validation-results)).
- Implemented and exercised tag-based purge (`POST /purge`) on a per-subgraph management port, as the reference for invalidation work.

## Problem Statement

Responses are cached in Valkey at the **subgraph layer**, keyed by REST route (`subgraph:<service>:<route>`). TTL alone gives no way to invalidate related entries when an entity changes, and the key layout was not documented:

- An engineer could not say which Valkey keys a GraphQL query produces, or what types they have.
- Invalidating "everything about `acct-1001`" would require knowing every REST URL that mentions it (`/accounts/acct-1001`, `/accounts/acct-1001/policies`, `/accounts/acct-1001/funds`, …).
- The OSS Grafbase gateway only provides an **in-memory** entity cache; its Redis/Valkey backend is not active in this stack. Entity-aware, persistent cache invalidation therefore has to be built at the subgraph layer.

The story asked for a reproducible, documented view of the key schema so the subsequent invalidation work can build on it.

## Solution Implemented

All logic lives in [subgraph-server/server.js](../subgraph-server/server.js) (one file, run as three subgraphs via `SERVICE_NAME`). Management ports are wired in [docker-compose.yml](../docker-compose.yml).

### 1. How cache keys are generated

`cachedRequestJson(route)` wraps every REST call the resolvers make:

```js
const key = `subgraph:${serviceName}:${route}`;   // e.g. subgraph:accounts:/accounts/acct-1001
```

- **HIT** → `GET key`, parsed JSON returned, REST API not called (`[cache HIT]` log).
- **MISS** → REST call, then payload + tags written in one Valkey pipeline (`[cache MISS]`, `[cache SET]` logs).
- `404` responses (`null`) are **not** cached.
- If Valkey is not `ready`, the subgraph calls REST directly (graceful degradation).

### 2. Route-to-key mapping (Deliverable 1)

Resolver → REST route → Valkey payload key → tags written. Payload keys are `string`; tags are `set`.

| Subgraph | GraphQL field / resolver | REST route | Payload key (`string`) | Tag indexes (`set`) |
|---|---|---|---|---|
| accounts | `Query.account(id)`, `Account.__resolveReference` | `/accounts/{id}` | `subgraph:accounts:/accounts/acct-1001` | `tag:Account`, `tag:Account:acct-1001` |
| accounts | `Query.accounts` (no args) | `/accounts` | `subgraph:accounts:/accounts` | `tag:Account` |
| accounts | `Query.accounts(customerId)` | `/customers/{id}/accounts` | `subgraph:accounts:/customers/cust-501/accounts` | `tag:Customer:cust-501`, `tag:Account` |
| policies | `Account.policies`, `Query.policies(accountId)` | `/accounts/{id}/policies` | `subgraph:policies:/accounts/acct-1001/policies` | `tag:Account:acct-1001`, `tag:Policy` |
| policies | `Query.policy`, `Policy.__resolveReference` | `/policies/{id}` | `subgraph:policies:/policies/pol-life-3001` | `tag:Policy`, `tag:Policy:pol-life-3001` |
| policies | `Query.policies` (no args) | `/policies` | `subgraph:policies:/policies` | `tag:Policy` |
| policies | `Fund.linkedPolicies` | `/funds/{id}/policies` | `subgraph:policies:/funds/fund-global-equity/policies` | `tag:Fund:fund-global-equity`, `tag:Policy` |
| funds | `Account.availableFunds` | `/accounts/{id}/funds` | `subgraph:funds:/accounts/acct-1001/funds` | `tag:Account:acct-1001`, `tag:Fund` |
| funds | `Query.fund`, `Fund.__resolveReference` | `/funds/{id}` | `subgraph:funds:/funds/fund-global-equity` | `tag:Fund`, `tag:Fund:fund-global-equity` |
| funds | `Query.funds` | `/funds` | `subgraph:funds:/funds` | `tag:Fund` |

Tags are derived by `tagsForRoute(route)`, an ordered list of regex patterns (most specific first). A route that matches no pattern is cached with **no tags** (works, but cannot be purged by tag).

```js
{ re: /^\/accounts\/([^/]+)\/policies$/, tags: (m) => [`Account:${m[1]}`, "Policy"] },
{ re: /^\/accounts\/([^/]+)$/,           tags: (m) => ["Account", `Account:${m[1]}`] },
```

The tag index key is simply `tag:<tag>` (`tagIndexKey`). It is **not** prefixed with the service name.

### 3. How payloads and tag indexes are stored

On a MISS, a single pipeline is executed (example for `/accounts/acct-1001`, accounts TTL 120):

```
SET    subgraph:accounts:/accounts/acct-1001  '<REST JSON>'  EX 120
SADD   tag:Account                            subgraph:accounts:/accounts/acct-1001
EXPIRE tag:Account                            240
SADD   tag:Account:acct-1001                  subgraph:accounts:/accounts/acct-1001
EXPIRE tag:Account:acct-1001                  240
```

| Key type | Valkey type | Content | Lifecycle |
|---|---|---|---|
| Payload cache key `subgraph:<svc>:<route>` | `string` | JSON body of the REST response | Created on MISS with `EX = CACHE_TTL`; expires by itself; removed early by purge |
| Tag index `tag:<Type>` / `tag:<Type>:<id>` | `set` | Payload keys that registered this tag | Created/extended with `SADD` on every MISS; given `EXPIRE = 2 × CACHE_TTL` of the writing subgraph; deleted by purge |

Design points from the code:

- **Separation of concerns:** payload keys hold data; tag indexes hold only *keys*. Invalidation never has to parse payloads or URLs.
- Tag indexes get a TTL of twice the payload TTL so they expire on their own if nobody purges (prevents unbounded growth).
- Tags are written only on a MISS, not refreshed on a HIT.

### 4. Tag-to-cache-key relationship and invalidation (Deliverable 3)

`purgeTags(tags)` in `server.js` implements the invalidation flow:

```
SMEMBERS tag:Account:acct-1001        → all payload keys registered under the tag
DEL <each payload key>                → cached entries removed
DEL tag:Account:acct-1001             → the tag index itself removed
```

Exposed by a small management HTTP server per subgraph (`MGMT_PORT`, kept separate from the GraphQL endpoint):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness + Valkey status (`{"service":"accounts","cache":"ready"}`) |
| `GET /tags/:tag` | Lists payload keys registered under a tag (wraps `SMEMBERS`) |
| `POST /purge` `{"tags":[...]}` | Deletes all entries registered under any listed tag, then the tag indexes |

Host ports: accounts `5001`, policies `5002`, funds `5003`.

How downstream invalidation tasks should use the indexes:

| Change event | Tag(s) to purge | Effect |
|---|---|---|
| Account `acct-1001` updated | `Account:acct-1001` | Removes the account, its policies list, its funds list |
| Any account changes / bulk migration | `Account` | Removes every cached account-related entry |
| Policy `pol-life-3001` updated | `Policy:pol-life-3001` | Removes that policy entry |
| Any policy change | `Policy` | Removes all policy entries and account/fund policy lists |
| Customer `cust-501` changed | `Customer:cust-501` | Removes that customer's account list |

## Cache configuration used

**Subgraph layer (the layer this story is about)** — [docker-compose.yml](../docker-compose.yml):

| Setting | accounts | policies | funds |
|---|---|---|---|
| `CACHE_URL` | `redis://valkey:6379` | `redis://valkey:6379` | `redis://valkey:6379` |
| `CACHE_TTL` (payload) | 120 s | 30 s | 300 s |
| Tag index TTL (`2 × CACHE_TTL`) | 240 s | 60 s | 600 s |
| `MGMT_PORT` (container → host) | 5000 → 5001 | 5000 → 5002 | 5000 → 5003 |
| Rationale (from compose comments) | changes infrequently | status can change | prices update daily |

- Valkey: `valkey/valkey:8-alpine`, port `6379`, named volume `valkey-data` mounted at `/data`, healthcheck `valkey-cli ping`. Subgraphs `depends_on` Valkey `service_healthy`.
- Client: `ioredis` (`lazyConnect`), connected only when `CACHE_URL` is set. Default TTL in code is 60 s if `CACHE_TTL` is unset.

**Gateway layer** — [grafbase/grafbase.toml](../grafbase/grafbase.toml) (context only, not part of the tagging implementation):

```toml
[entity_caching]
enabled = true
ttl = "60s"
# [entity_caching.redis]   # commented out: requires Enterprise image + GRAFBASE_LICENSE_KEY
# url = "redis://valkey:6379"

[subgraphs.accounts.entity_caching]  enabled = true  ttl = "120s"
[subgraphs.policies.entity_caching]  enabled = true  ttl = "30s"
[subgraphs.funds.entity_caching]     enabled = true  ttl = "300s"
```

With the OSS gateway image (`ghcr.io/grafbase/gateway:latest`) this cache is in-memory; the gateway does **not** write to Valkey. All keys inspected in this POC are written by the subgraphs.

## Project Architecture / Flow

```
GraphQL query
   │
   ▼
Grafbase Gateway (:5050/graphql, in-memory entity cache, OSS)
   │  subgraph request (federation)
   ▼
Subgraph resolver (accounts | policies | funds, :4000)   ← subgraph-server/server.js
   │
   ▼
cachedRequestJson(route)
   ├── GET subgraph:<svc>:<route> ── HIT ──► return cached JSON (REST not called)
   │
   └── MISS ─► REST API (:3001 / :3002 / :3003, X-Api-Key)
                  │
                  ▼
           Valkey pipeline:  SET payload EX ttl
                             SADD tag:<Type>, tag:<Type>:<id>  + EXPIRE 2×ttl

Invalidation path (management port :5001/:5002/:5003)
   POST /purge {"tags":[...]} → SMEMBERS tag → DEL payload keys → DEL tag indexes
```

## How the Project Works

| File | Role |
|---|---|
| [subgraph-server/server.js](../subgraph-server/server.js) | Apollo Federation subgraph (selected by `SERVICE_NAME`); Valkey client, `cachedRequestJson`, `tagsForRoute`, `tagIndexKey`, `purgeTags`, management HTTP API |
| [subgraph-server/schemas/*.graphql](../subgraph-server/schemas) | Federation SDL (`Account`, `Policy`, `Fund` entities with `@key(fields: "id")`) |
| [mock-rest-api/server.js](../mock-rest-api/server.js) | Three mock REST services (3001/3002/3003) that are the source of cached data |
| [docker-compose.yml](../docker-compose.yml) | Valkey service, per-subgraph `CACHE_URL`/`CACHE_TTL`/`MGMT_PORT`, port mappings |
| [grafbase/grafbase.toml](../grafbase/grafbase.toml) | Gateway config incl. in-memory entity caching TTLs |

A federated query touches several subgraphs and therefore several keys. Example `account(id:"acct-1001") { policies {…} availableFunds {…} }`: accounts subgraph resolves the account, policies subgraph resolves `Account.policies`, funds subgraph resolves `Account.availableFunds`. Three payload keys are created, all registered under `tag:Account:acct-1001`.

## What is Grafbase Caching? (Operation vs Entity)

| | Operation-level caching | Entity-level caching |
|---|---|---|
| Unit cached | The full response of a GraphQL operation (query text + variables) | The data for an individual entity / subgraph request, reusable across different operations |
| Reuse | Only when the same operation repeats | Any operation needing the same entity can reuse it |
| Invalidation | Hard to target — many operations may contain one entity | Targetable per entity (`Type` / `Type:id`) |

Grafbase's own documentation describes **entity caching** in the gateway: it caches requests to subgraphs, defaults to an in-memory store, and can use Redis to share the cache across gateway instances (see references). Its per-entity granularity is what makes entity-aware invalidation possible.

**What this POC uses:** neither of the gateway's built-in modes to store data in Valkey. The persistent cache is a **subgraph-layer, entity-oriented cache**: each REST resource (an entity or entity relationship such as `/accounts/acct-1001/policies`) is cached under a route key, and **entity tags** (`Account`, `Account:acct-1001`) provide the entity-level grouping for invalidation. It mirrors the `Type` / `Type:id` tag model of gateway-level entity caching, but is implemented in Node.js so it works on the OSS gateway image. It is keyed by REST route, not by GraphQL operation, so it is not operation-level caching.

## Key Benefits

| Benefit | Evidence in this POC |
|---|---|
| **Cache key visibility** | Deterministic `subgraph:<svc>:<route>` keys; `[cache HIT/MISS/SET]` log lines per key |
| **Entity-based tagging** | `Type` and `Type:id` tags derived automatically from the route |
| **Targeted invalidation** | One `POST /purge` on `Account:acct-1001` removed 3 payload keys across 3 subgraphs |
| **Reproducibility** | Fixed sample data (`acct-1001`) and a CLI playbook (below) give identical results |
| **Debugging / observability** | `GET /tags/:tag`, `GET /health`, standard `valkey-cli` inspection |
| **Payload vs index separation** | Payloads are `string`, tag indexes are `set` of keys; purge never parses payloads |

## Validation Playbook (Deliverable 2)

Prerequisite: `docker compose up --build` (container name `grafbasepoc-valkey-1`). Shorthand: `V="docker exec grafbasepoc-valkey-1 valkey-cli"`.

```bash
# 0. Start from an empty cache (optional, local only)
docker exec grafbasepoc-valkey-1 valkey-cli FLUSHALL

# 1. Execute a query (first call = cache MISS)
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'

# 2. List keys
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"

# 3. TYPE of each key
docker exec grafbasepoc-valkey-1 valkey-cli TYPE "subgraph:accounts:/accounts/acct-1001"   # string
docker exec grafbasepoc-valkey-1 valkey-cli TYPE "tag:Account"                              # set
docker exec grafbasepoc-valkey-1 valkey-cli TYPE "tag:Account:acct-1001"                    # set

# 4. GET the cached payload
docker exec grafbasepoc-valkey-1 valkey-cli GET "subgraph:accounts:/accounts/acct-1001"

# 5. SMEMBERS of the tag indexes
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account"
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account:acct-1001"

# 6. TTL (positive = active; -1 = no expiry; -2 = key missing)
docker exec grafbasepoc-valkey-1 valkey-cli TTL "subgraph:accounts:/accounts/acct-1001"
docker exec grafbasepoc-valkey-1 valkey-cli TTL "tag:Account:acct-1001"

# 7. Repeat the query → HIT; confirm in subgraph logs
docker logs grafbasepoc-accounts-subgraph-1 2>&1 | grep "cache "

# 8. Federated query → keys from all three subgraphs
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName policies { id } availableFunds { id } } }"}'
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account:acct-1001"

# 9. Targeted invalidation
curl -s http://localhost:5001/tags/Account:acct-1001
curl -s -X POST http://localhost:5001/purge -H "Content-Type: application/json" \
  -d '{"tags":["Account:acct-1001"]}'
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
```

### Validation results

Executed on the running stack (2026-09-24) after `FLUSHALL`. Outputs are copied from the terminal.

**Query 1 → keys created** (`account(id:"acct-1001")`; subgraph log: `[cache MISS]`, then `[cache SET] … tags=[Account, Account:acct-1001]`):

| Key | `TYPE` | `TTL` (s) at check |
|---|---|---|
| `subgraph:accounts:/accounts/acct-1001` | `string` | 112 (configured 120) |
| `tag:Account` | `set` | 232 (configured 240) |
| `tag:Account:acct-1001` | `set` | 232 (configured 240) |

```text
> SMEMBERS tag:Account              → subgraph:accounts:/accounts/acct-1001
> SMEMBERS tag:Account:acct-1001    → subgraph:accounts:/accounts/acct-1001
> GET subgraph:accounts:/accounts/acct-1001
{"id":"acct-1001","customerId":"cust-501","holderName":"Anika Rao","accountType":"PENSION", … "fundHoldings":[…]}
```

Repeat query → subgraph log `[cache HIT] subgraph:accounts:/accounts/acct-1001`.

**Federated query** (account + policies + availableFunds) added:

```text
subgraph:policies:/accounts/acct-1001/policies   (TTL 17 of 30)
subgraph:funds:/accounts/acct-1001/funds         (TTL 287 of 300)
tag:Policy, tag:Fund
SMEMBERS tag:Account:acct-1001 →
   subgraph:accounts:/accounts/acct-1001
   subgraph:policies:/accounts/acct-1001/policies
   subgraph:funds:/accounts/acct-1001/funds
```

**Funds TTL check:** `fund(id:"fund-global-equity")` → `subgraph:funds:/funds/fund-global-equity` is `string`, `TTL 300`; `tag:Fund:fund-global-equity` is `set`, `TTL 600`.

**Purge:** `POST :5001/purge {"tags":["Account:acct-1001"]}` →

```json
{"purgedKeys":3,"purgedTags":1,"keys":["subgraph:accounts:/accounts/acct-1001","subgraph:policies:/accounts/acct-1001/policies","subgraph:funds:/accounts/acct-1001/funds"]}
```

Afterwards `KEYS "*"` no longer contained the three payload keys or `tag:Account:acct-1001`; the next `account(id:"acct-1001")` query logged `[cache MISS]` then `[cache SET]` again.

## Official References

- Grafbase Gateway – Entity caching: https://grafbase.com/docs/gateway/performance/entity-caching
- Valkey `TTL`: https://valkey.io/commands/ttl/
- Valkey `SMEMBERS`: https://valkey.io/commands/smembers/
- Valkey `SADD`: https://valkey.io/commands/sadd/
- Valkey `TYPE`: https://valkey.io/commands/type/
- Valkey `GET`: https://valkey.io/commands/get/

## Future Scope

Realistic follow-ups building on this implementation:

- **Invalidation trigger integration:** call `POST /purge` from the write path / events that change accounts, policies and funds (the POC only exposes the endpoint).
- **Cross-subgraph purge orchestration** and authentication on the management API.
- **Extend tag rules** for new routes/entities (`tagsForRoute` is the single place to change); add a test that every resolver route produces the expected tags.
- **Automated validation:** script the playbook above (query → `TYPE`/`SMEMBERS`/`TTL` assertions → purge → assert gone).
- **Production hardening:** use `SCAN` instead of `KEYS` for inspection, make purge atomic (Lua/`MULTI`), and align tag-index TTL handling (see limitations).
- **Gateway-level tagging** via the Enterprise image + `[entity_caching.redis]` if a license becomes available.

## Limitations / Known Considerations

Items 1–4 were observed or derived directly from `server.js` and the validation run.

1. **Payload TTL vs the story's "TTL > 2 mins" check.** The accounts payload TTL is configured at 120 s, so an active `subgraph:accounts:…` key returns a positive TTL (112 and 99 observed) but never *more than* 120 s. Funds payloads (300 s) and all tag indexes (240 s / 60 s / 600 s) exceed 2 minutes at write time; policies payloads (30 s) and the `tag:Policy` index (60 s) do not.
2. **Tag namespace is shared across subgraphs.** All three subgraphs use one Valkey and the same `tag:<name>` keys. `POST /purge` on the accounts port (`5001`) removed policies and funds keys as well (3 keys purged). The Readme statement "each subgraph manages only its own cache" does not match observed behaviour.
3. **Tag index TTL is "last writer wins".** `EXPIRE` is reset on every MISS by whichever subgraph wrote last. Observed `TTL tag:Account:acct-1001` = 587 after the funds subgraph wrote it (2 × 300), while `tag:Policy` was 47 (2 × 30). A short-TTL subgraph can shorten a shared index below the payload TTL of a longer-TTL subgraph, leaving that payload unregistered for the tail of its life (not reproduced in this run — derived from the code and observed TTLs).
4. **Purge only removes the tags named in the request.** Other indexes containing the purged keys (e.g. `tag:Account`) are left in place and may reference removed keys until they expire. Purge is also `SMEMBERS` then `DEL`, not atomic.
5. Entries with routes that match no `tagsForRoute` pattern are cached but cannot be purged by tag.
6. This POC covers the subgraph-layer cache only. The gateway's in-memory entity cache (OSS) is separate and was not exercised by the purge tests.
7. If Valkey is down, subgraphs bypass the cache and call REST directly; if the mock REST APIs are down on a cache miss, the query fails (accepted for POC).
8. The Grafbase gateway GitHub repository states it is in maintenance mode; this is relevant to any long-term reliance on gateway-level features.

## Summary

The POC documents and demonstrates how a GraphQL account query becomes Valkey data: one payload key per REST route (`subgraph:<service>:<route>`, type `string`, TTL 120/30/300 s) and entity tag indexes (`tag:<Type>`, `tag:<Type>:<id>`, type `set`, TTL 2× payload) that list the payload keys for targeted invalidation. The mapping in `server.js` is traced route by route, verified with `GET`, `TYPE`, `SMEMBERS` and `TTL` on `acct-1001`, and a working tag purge (`POST /purge`) shows how the indexes will be used downstream. Findings on shared tag namespaces and tag TTL behaviour are recorded above as inputs to the invalidation work.

## Jira Acceptance Criteria Mapping

| Acceptance Criteria | Implementation / Evidence | Status |
|---|---|---|
| Executing a GraphQL query creates the expected cache key and tag index keys in Valkey | `account(id:"acct-1001")` created `subgraph:accounts:/accounts/acct-1001` (`string`), `tag:Account` and `tag:Account:acct-1001` (`set`); federated query added policies/funds payloads and `tag:Policy`, `tag:Fund` | Met |
| Role and lifecycle of each key type (payload, tag index) is documented | "How payloads and tag indexes are stored" table: type, content, creation, TTL, removal | Met |
| Route-to-cache-key mapping logic in `server.js` is clearly mapped out | "Route-to-key mapping" table (`cachedRequestJson`, `tagsForRoute`, `tagIndexKey`) | Met |
| Verification steps with executable CLI examples using `GET`, `TYPE`, `SMEMBERS`, `TTL` | "Validation Playbook" plus captured outputs. Note: accounts payload TTL is ≤ 120 s, so it is positive but not "> 2 mins" (see Limitations #1); funds payload is 300 s | Met, with TTL note |
| Documentation should be published | This page (source: `GrafbaseAnalysis/confluence-valkey-entity-tagging.md`) | Ready to publish |

## Deliverables Completed

| Deliverable | Where |
|---|---|
| 1. Route-to-Key Mapping | "Route-to-key mapping" table under Solution Implemented |
| 2. Reproducible Validation Playbook | "Validation Playbook" CLI sequence + "Validation results" |
| 3. Invalidation Reference | "Tag-to-cache-key relationship and invalidation" (`purgeTags`, management API, tag-to-event table) |
