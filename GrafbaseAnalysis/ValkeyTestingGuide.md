

## Layer 1 — Is Valkey Actually Receiving Data?

### Real-time monitor (like a live feed of every cache operation)
```bash
docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR
```
Run this in one terminal, then fire a GraphQL query in another. Every `SET` (write to cache) and `GET` (read from cache) will stream live. Right now you'll see **nothing** because the OSS gateway uses in-memory cache — this is how you'll confirm when Enterprise is activated.

### Check what keys are stored
```bash
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"
```

### See what's inside a key
```bash
docker exec grafbasepoc-valkey-1 valkey-cli GET "<key-name-from-above>"
```

### Check how many keys total
```bash
docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE
```

---

## Layer 2 — Is The Gateway Serving From Cache vs Live Data?

This is the practical developer test — **change the source data and watch what comes back**.

### Step 1 — Query and note the current value
```bash
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
```
You'll see:
```json
{"data":{"account":{"holderName":"Anika Rao","totalValue":186420.75}}}
```

### Step 2 — Change the data in the REST API

Change `totalValue` to something obvious, then rebuild just the REST container:
```bash
# Edit mock-rest-api/server.js — change totalValue: 186420.75 → totalValue: 999999.99
docker compose up --build -d accounts-rest
```

### Step 3 — Query immediately after rebuild

- **If data IS cached** → you still get `186420.75` (stale, from cache)
- **If data is NOT cached / cache expired** → you get `999999.99` (fresh, from source)

This is the clearest proof of caching behaviour.

---

## Layer 3 — Measure Response Time (Cache is Faster)

```bash
# Run 5 times and watch the time column
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "Request $i: %{time_total}s\n" \
    -X POST http://localhost:5050/graphql \
    -H "Content-Type: application/json" \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}';
done
```

Expected pattern:
```
Request 1: 0.045s   ← cache MISS, hits subgraph + REST API
Request 2: 0.008s   ← cache HIT, served from memory
Request 3: 0.007s   ← cache HIT
Request 4: 0.007s   ← cache HIT
Request 5: 0.008s   ← cache HIT
```

First request is always slowest. Subsequent ones are near-instant if cache is working.

Request 1 is 3x slower — in-memory entity cache is working. Requests 2–5 are served from cache.

---

## Layer 4 — Gateway Logs Show Cache Activity
```bash
# Watch live gateway logs while you query
docker logs -f grafbasepoc-grafbase-1
```
When a subgraph is **not** called (cache hit), you won't see a `subgraph-request` log line for it. When it **is** called (cache miss), you'll see the full `subgraph-request → subgraph-http-request` chain. That absence/presence tells you exactly which subgraphs were hit.

---

## Layer 5 — Verify TTL Expiry (Cache Timeout)

The TTLs set in `grafbase.toml` are:
- accounts → 120s
- policies → 30s  
- funds → 300s

Test TTL expiry:
```bash
# 1. Query (cache miss, data loaded)
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName } }"}'

# 2. Change the REST data (edit server.js totalValue, rebuild)
docker compose up --build -d accounts-rest

# 3. Query immediately → still old value (cache hit, TTL not expired)
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName } }"}'

# 4. Wait 120 seconds, then query again → new value (cache expired, fresh fetch)
sleep 120
curl -s -X POST http://localhost:5050/graphql -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName } }"}'
```

---

## The Full Testing Cheatsheet

| What you want to check | Command |
|---|---|
| Is Valkey receiving cache writes? | `docker exec grafbasepoc-valkey-1 valkey-cli MONITOR` |
| What keys are cached? | `docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"` |
| Read a cached value | `docker exec grafbasepoc-valkey-1 valkey-cli GET "<key>"` |
| How many items cached? | `docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE` |
| Wipe the entire cache | `docker exec grafbasepoc-valkey-1 valkey-cli FLUSHALL` |
| Is cache faster than source? | `curl` timing loop (Layer 3 above) |
| Is stale data being served? | Change REST data, query before TTL expires |
| Which subgraphs were hit? | `docker logs -f grafbasepoc-grafbase-1` |
| Force a cache miss | `FLUSHALL` then query again |

---

## Current Reality Summary

| Test | Result right now |
|---|---|
| `valkey-cli KEYS "*"` | Empty — OSS gateway uses in-memory cache, not Valkey |
| Response time test | ✅ Works — 2nd request is faster, in-memory cache is active |
| Stale data test | ✅ Works — changed data won't appear until TTL expires |
| `valkey-cli MONITOR` | Silent — no writes going to Valkey |
| All of the above | Will work fully once Enterprise gateway image is used |