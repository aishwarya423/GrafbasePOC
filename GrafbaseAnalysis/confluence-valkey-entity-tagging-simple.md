# POC for Cache Key Visibility & Valkey Entity Tagging

## Overview

When someone runs a GraphQL query (for example, "get account `acct-1001`"), our system saves the answer in **Valkey** (a fast in-memory store) so the next request is quicker. This POC answers a simple question: **what exactly gets saved in Valkey, and how can we clear it later?**

What we achieved:

- Showed exactly which entries a query creates in Valkey and what type each one is.
- Confirmed that there are two kinds of entries: **the saved data itself**, and **tag lists** that record which saved entries belong to which account, policy or fund.
- Ran real queries and checked the results with Valkey commands (`GET`, `TYPE`, `SMEMBERS`, `TTL`).
- Built and tested a "purge by tag" endpoint that clears all cached data for one account in a single call.

## Problem Statement

We cache REST responses in Valkey, but before this POC:

- Nobody had documented which Valkey entries a query produces.
- Cached entries only disappeared when their timer (TTL) ran out. If an account changed, users could see old data until then.
- Clearing "everything about account `acct-1001`" would mean knowing every REST URL that mentions it (the account, its policies, its funds…).

We needed a clear, repeatable picture of how the cache is organised, so later work on cache invalidation has a solid base.

## Solution Implemented

All of the logic is in one file: [subgraph-server/server.js](../subgraph-server/server.js). Each subgraph (accounts, policies, funds) runs this same file.

### The two kinds of entries in Valkey

| Kind | Valkey type | What it holds | Example |
|---|---|---|---|
| **Data entry** | `string` | The JSON answer from the REST API | `subgraph:accounts:/accounts/acct-1001` |
| **Tag list** | `set` | A list of data entries that share a label | `tag:Account:acct-1001` |

Think of the tags like hashtags. The tag `Account:acct-1001` keeps a list of every saved entry that relates to that account, so we can clear them all together.

### How a key name is built

Every data entry is named **`subgraph:<service>:<REST route>`**.
Example: the REST route `/accounts/acct-1001` in the accounts subgraph becomes `subgraph:accounts:/accounts/acct-1001`.

### What happens on each request

1. The subgraph looks for the key in Valkey.
2. **Found (HIT):** it returns the saved answer. The REST API is not called.
3. **Not found (MISS):** it calls the REST API, then saves two things:
   - the data entry, with an expiry timer, and
   - the entry's name added into its tag lists.
4. If Valkey is down, the subgraph simply calls the REST API directly. Nothing breaks.

### Route-to-key mapping (Deliverable 1)

Main routes, the key each creates, and the tags it joins (the other policies and funds routes follow the same pattern):

| Subgraph | REST route | Data entry (`string`) | Tag lists (`set`) |
|---|---|---|---|
| accounts | `/accounts/{id}` | `subgraph:accounts:/accounts/acct-1001` | `tag:Account`, `tag:Account:acct-1001` |
| accounts | `/accounts` | `subgraph:accounts:/accounts` | `tag:Account` |
| accounts | `/customers/{id}/accounts` | `subgraph:accounts:/customers/cust-501/accounts` | `tag:Customer:cust-501`, `tag:Account` |
| policies | `/accounts/{id}/policies` | `subgraph:policies:/accounts/acct-1001/policies` | `tag:Account:acct-1001`, `tag:Policy` |

The tag rules live in one function, `tagsForRoute()` in `server.js`. A route with no matching rule is still cached, but it has no tags, so it can't be cleared by tag.

### How clearing the cache works (Deliverable 3)

Each subgraph has a small extra web API, separate from GraphQL:

| Call | What it does |
|---|---|
| `GET /health` | Shows whether Valkey is connected |
| `GET /tags/<tag>` | Lists the data entries under a tag |
| `POST /purge` with `{"tags":["Account:acct-1001"]}` | Deletes every data entry under that tag, then the tag list |

Ports: accounts `5001`, policies `5002`, funds `5003`.

**Purge in three steps:** read the tag list → delete each data entry it names → delete the tag list.

How later work can use it:

| When this changes | Purge this tag | Result |
|---|---|---|
| Account `acct-1001` | `Account:acct-1001` | Its account, policies and funds entries are cleared |
| Accounts in bulk | `Account` | All account-related entries are cleared |
| Policy `pol-life-3001` | `Policy:pol-life-3001` | That policy entry is cleared |
| Customer `cust-501` | `Customer:cust-501` | That customer's account list is cleared |

### Cache configuration used

| Setting | accounts | policies | funds |
|---|---|---|---|
| Valkey address (`CACHE_URL`) | `redis://valkey:6379` | `redis://valkey:6379` | `redis://valkey:6379` |
| Data entry lifetime (`CACHE_TTL`) | 120 s | 30 s | 300 s |
| Tag list lifetime (2 × the above) | 240 s | 60 s | 600 s |
| Purge API port | 5001 | 5002 | 5003 |
| Why this TTL | Changes rarely | Status can change | Prices update daily |

- Valkey runs from the `valkey/valkey:8-alpine` image, with a saved volume (`valkey-data`) so data survives restarts.
- Tag lists live twice as long as their data so they clean themselves up if nobody purges.
- Settings are in [docker-compose.yml](../docker-compose.yml).

The gateway ([grafbase/grafbase.toml](../grafbase/grafbase.toml)) also has its own entity cache turned on (60 s default, and 120/30/300 s per subgraph). On the free (OSS) gateway that cache is **in memory only** and does not write to Valkey. Everything you see in Valkey in this POC is written by the subgraphs.

## Project Architecture / Flow

```
GraphQL query
   ↓
Grafbase Gateway (:5050)
   ↓
Subgraph (accounts / policies / funds)
   ↓
Look in Valkey ── found ──→ return saved answer
   │
   └─ not found ─→ call REST API ─→ save in Valkey:
                                     • the data entry (string, with timer)
                                     • the tag lists (sets)

To clear:  POST /purge {"tags":[...]} → find entries in tag list → delete them → delete tag list
```

## How the Project Works

| File | What it does |
|---|---|
| [subgraph-server/server.js](../subgraph-server/server.js) | Runs each subgraph; builds keys, saves to Valkey, adds tags, handles purge |
| [subgraph-server/schemas/](../subgraph-server/schemas) | GraphQL schemas for accounts, policies, funds |
| [mock-rest-api/server.js](../mock-rest-api/server.js) | Fake REST APIs that supply the data |
| [docker-compose.yml](../docker-compose.yml) | Starts Valkey and all services; sets TTLs and ports |
| [grafbase/grafbase.toml](../grafbase/grafbase.toml) | Gateway settings |

Example: the query `account(id:"acct-1001") { policies availableFunds }` calls all three subgraphs. That creates **three** data entries (account, policies, funds), and all three are listed under the tag `Account:acct-1001`. Purging that one tag clears all three.

## What is Grafbase Caching? (Operation vs Entity)

| | Operation caching | Entity caching |
|---|---|---|
| What is saved | The full result of one exact query | Data for individual items (an account, a policy…) |
| Reused when | The exact same query repeats | Any query needs that same item |
| Clearing | Hard to target: many queries may contain one account | Easy to target: clear by item |

Grafbase's documentation describes **entity caching** in the gateway: it caches requests to subgraphs, stores them in memory by default, and can use Redis to share the cache between gateways.

**What this POC uses:** a subgraph-level cache that behaves like entity caching. It saves each REST resource under a route-based key and groups them with entity tags such as `Account:acct-1001`. It is not the gateway's built-in cache and it is not operation caching. We built it ourselves so it works on the free gateway image.

## Key Benefits

| Benefit | How this POC shows it |
|---|---|
| **Key visibility** | Predictable key names, plus HIT/MISS/SET log lines |
| **Entity tagging** | Tags like `Account` and `Account:acct-1001` are added automatically |
| **Targeted clearing** | One purge call removed 3 entries across 3 subgraphs |
| **Repeatable** | Same sample account (`acct-1001`) and same commands give the same result |
| **Easy debugging** | `GET /tags/<tag>`, `GET /health`, and plain `valkey-cli` commands |
| **Data vs. index kept separate** | Data is a `string`, tag lists are a `set`; purge never needs to read the data |

## Validation Playbook (Deliverable 2)

Start the stack with `docker compose up --build`. Valkey's container is `grafbasepoc-valkey-1`.

```bash
# 1. Run a query (first time = MISS)
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'

# 2. See what was created
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"

# 3. Check the type of each key
docker exec grafbasepoc-valkey-1 valkey-cli TYPE "subgraph:accounts:/accounts/acct-1001"   # string
docker exec grafbasepoc-valkey-1 valkey-cli TYPE "tag:Account:acct-1001"                    # set

# 4. Read the saved data
docker exec grafbasepoc-valkey-1 valkey-cli GET "subgraph:accounts:/accounts/acct-1001"

# 5. See what is inside the tag lists
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account"
docker exec grafbasepoc-valkey-1 valkey-cli SMEMBERS "tag:Account:acct-1001"

# 6. Check time left (positive = active, -1 = no expiry, -2 = key gone)
docker exec grafbasepoc-valkey-1 valkey-cli TTL "subgraph:accounts:/accounts/acct-1001"

# 7. Run the same query again = HIT (check the log)
docker logs grafbasepoc-accounts-subgraph-1 2>&1 | grep "cache "

# 8. Clear it by tag
curl -s -X POST http://localhost:5001/purge -H "Content-Type: application/json" \
  -d '{"tags":["Account:acct-1001"]}'
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
```

### Validation results

Run on 2026-09-24 against a clean cache.

**After the first query** (log showed `MISS`, then `SET` with tags `Account, Account:acct-1001`):

| Key | Type | Time left |
|---|---|---|
| `subgraph:accounts:/accounts/acct-1001` | `string` | 112 s (set to 120) |
| `tag:Account` | `set` | 232 s (set to 240) |
| `tag:Account:acct-1001` | `set` | 232 s (set to 240) |

- `GET` returned the account JSON (`holderName: "Anika Rao"`, `totalValue: 186420.75`, …).
- `SMEMBERS tag:Account` and `SMEMBERS tag:Account:acct-1001` each returned `subgraph:accounts:/accounts/acct-1001`.
- Running the same query again logged `[cache HIT]`.

**After a query that also asked for policies and funds**, `SMEMBERS tag:Account:acct-1001` returned three entries:

```
subgraph:accounts:/accounts/acct-1001
subgraph:policies:/accounts/acct-1001/policies
subgraph:funds:/accounts/acct-1001/funds
```

**Funds TTL:** `subgraph:funds:/funds/fund-global-equity` was a `string` with `TTL 300`; its tag list `tag:Fund:fund-global-equity` was a `set` with `TTL 600`.

**Purge:** `POST :5001/purge {"tags":["Account:acct-1001"]}` returned `{"purgedKeys":3,"purgedTags":1, …}`. Those three entries and the tag list were gone from Valkey, and the next query logged `MISS` again.

## Official References

- Grafbase Gateway, Entity caching: https://grafbase.com/docs/gateway/performance/entity-caching
- Valkey `TTL`: https://valkey.io/commands/ttl/
- Valkey `SMEMBERS`: https://valkey.io/commands/smembers/
- Valkey `SADD`: https://valkey.io/commands/sadd/
- Valkey `TYPE`: https://valkey.io/commands/type/
- Valkey `GET`: https://valkey.io/commands/get/

## Future Scope

- Call the purge endpoint automatically when accounts, policies or funds change (today it must be called by hand).
- Add security to the purge API.
- Add tag rules for new routes or entities (all in `tagsForRoute()`).
- Turn the playbook above into an automated test.
- Production hardening: avoid `KEYS` (use `SCAN`), make purge a single atomic step, and fix the tag-lifetime issue below.
- If an Enterprise license is ever available, move tagging to the gateway using `[entity_caching.redis]`.

## Limitations / Known Considerations

1. **TTL "> 2 mins" check:** Accounts data lives 120 s, so its time-left is positive (we saw 112 and 99) but never above 2 minutes. Funds data (300 s) and the tag lists (240/60/600 s) do exceed it at write time. Policies data (30 s) does not.
2. **Tags are shared by all subgraphs.** One purge on any port clears matching entries from all three subgraphs (our test cleared 3 entries with one call to the accounts port).
3. **Tag list lifetime is set by whoever wrote last.** We saw `tag:Account:acct-1001` at 587 s (written by funds, 2 × 300) and `tag:Policy` at 47 s (2 × 30). A subgraph with a short TTL could shorten a shared tag list so it expires before a longer-lived data entry. This is based on the code and the observed timers; we did not reproduce the problem.
4. **Purge only removes the tags you name.** Other tag lists that mention the deleted entries (for example `tag:Account`) stay until they expire. Purge is also not atomic (it reads the list, then deletes).
5. Routes with no tag rule are cached but can't be purged by tag.
6. Only the subgraph cache is covered. The gateway's own in-memory cache was not part of the purge tests.
7. If Valkey is down, subgraphs call REST directly. If the mock REST APIs are down on a cache miss, the query fails (accepted for this POC).
8. The Grafbase gateway repository on GitHub says it is in maintenance mode, which matters for long-term plans.

## Summary

A GraphQL account query now has a clear, documented footprint in Valkey: one **data entry** per REST route (`string`, TTL 120/30/300 s) plus **tag lists** (`set`, TTL twice as long) that record which entries belong to which account, policy or fund. We traced the mapping in `server.js`, checked it with `GET`, `TYPE`, `SMEMBERS` and `TTL`, and showed that one purge call by tag clears all related entries. The limitations above are inputs for the next invalidation work.

## Jira Acceptance Criteria Mapping

| Acceptance Criteria | Implementation / Evidence | Status |
|---|---|---|
| Running a GraphQL query creates the expected cache key and tag keys in Valkey | `account(id:"acct-1001")` created `subgraph:accounts:/accounts/acct-1001` (`string`), `tag:Account` and `tag:Account:acct-1001` (`set`). The federated query added the policies and funds entries | Met |
| Role and lifecycle of each key type is documented | "The two kinds of entries in Valkey", plus the TTL table | Met |
| Route-to-cache-key mapping in `server.js` is mapped out | "Route-to-key mapping" table | Met |
| CLI verification steps using `GET`, `TYPE`, `SMEMBERS`, `TTL` | "Validation Playbook" and "Validation results". Note: accounts data TTL is at most 120 s, so it is positive but not "> 2 mins" (Limitation 1) | Met, with TTL note |
| Documentation is published | This page (source: `GrafbaseAnalysis/confluence-valkey-entity-tagging.md`) | Ready to publish |

## Deliverables Completed

| Deliverable | Where |
|---|---|
| 1. Route-to-Key Mapping | "Route-to-key mapping" table |
| 2. Reproducible Validation Playbook | "Validation Playbook" and "Validation results" |
| 3. Invalidation Reference | "How clearing the cache works" |
