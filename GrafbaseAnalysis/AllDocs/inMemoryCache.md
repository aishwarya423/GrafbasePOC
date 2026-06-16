## In-Memory Cache vs Valkey Cache

### In-Memory Cache (what you have now)

The cache lives **inside the gateway process itself**, in RAM.

```
GraphQL Query
      │
      ▼
┌─────────────────────────────┐
│   Grafbase Gateway Process  │
│                             │
│   ┌─────────────────────┐   │
│   │   Cache (in RAM)    │   │
│   │   acct-1001 → data  │   │
│   │   fund-001  → data  │   │
│   └─────────────────────┘   │
│                             │
└─────────────────────────────┘
```

- Cache is stored in the same process memory as the gateway
- When gateway restarts → **cache is gone**, everything starts fresh
- Only that one gateway instance can use it

---

### Valkey Cache (what you'd have with Enterprise)

The cache lives in a **separate container**, outside the gateway.

```
GraphQL Query
      │
      ▼
┌──────────────────┐        ┌──────────────────┐
│ Grafbase Gateway │◄──────►│  Valkey Container │
│                  │        │                  │
│  (no local cache)│        │  acct-1001→ data │
│                  │        │  fund-001 → data │
└──────────────────┘        └──────────────────┘
```

- Cache lives in its own container with its own memory
- Gateway restarts → **cache survives**, data still there
- Multiple gateways can share the same cache

---

### Real World Difference

**In-memory** — restart the gateway, cache is wiped:
```bash
# 1. Query — slow (cache miss)
# 2. Query — fast (cache hit)
# 3. Restart gateway
docker compose restart grafbase
# 4. Query — SLOW again (cache was wiped on restart)
```

**Valkey** — restart the gateway, cache survives:
```bash
# 1. Query — slow (cache miss, stored in Valkey)
# 2. Query — fast (cache hit from Valkey)
# 3. Restart gateway
docker compose restart grafbase
# 4. Query — STILL fast (Valkey still has the data)
```

---

### Simple Analogy

| | In-Memory | Valkey |
|---|---|---|
| Like a... | Post-it note on your desk | Notebook in a drawer |
| If you leave the room (restart) | Post-it is gone | Notebook is still there |
| Two people sharing it | ❌ Each has their own post-it | ✅ Both read the same notebook |
| Speed | Fastest | Very fast |
| Survives restart | ❌ No | ✅ Yes |

---

### Which one matters for this POC

For a **POC on one machine** — in-memory is completely fine. You won't notice the difference.

Valkey matters when you have:
1. A gateway that restarts frequently (cloud deployments)
2. Multiple gateway instances running in parallel (production scale)
3. A need to inspect/debug what's cached (you can `valkey-cli GET key` and read it)