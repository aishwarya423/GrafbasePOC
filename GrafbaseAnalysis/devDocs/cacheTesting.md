Run 5 times and watch the time column
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "Request $i: %{time_total}s\n" \
    -X POST http://localhost:5050/graphql \
    -H "Content-Type: application/json" \
    -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}';
done
zsh: command not found: #
Request 1: 0.023647s
Request 2: 0.003268s
Request 3: 0.003019s
Request 4: 0.003127s
Request 5: 0.002516s

y im getting like this does this mean redis is not working?


No, this is **good news** — caching IS working.

---

## What the numbers tell you

```
Request 1: 0.023647s   ← cache MISS  — gateway called the subgraph + REST API
Request 2: 0.003268s   ← cache HIT   — served from cache (7x faster)
Request 3: 0.003019s   ← cache HIT
Request 4: 0.003127s   ← cache HIT
Request 5: 0.002516s   ← cache HIT
```

Request 1 is ~8x slower than the rest. That's the cache working — first request loads data, every request after that is served from memory instantly.

---

## But it's in-memory cache, not Valkey

The caching you're seeing is the **gateway's in-memory entity cache**, not Valkey. This is the OSS limitation explained earlier.

| | In-memory cache (now) | Valkey cache (Enterprise) |
|---|---|---|
| Request 1 slow, rest fast | ✅ Yes | ✅ Yes |
| `valkey-cli KEYS "*"` shows data | ❌ Empty | ✅ Has keys |
| Cache survives gateway restart | ❌ Lost | ✅ Persists |
| Cache shared across multiple gateway instances | ❌ No | ✅ Yes |

---

## The `zsh: command not found: #` error

That's nothing — you accidentally copied the comment line (`# Run 5 times...`) into the terminal. Just ignore it, it doesn't affect the output.