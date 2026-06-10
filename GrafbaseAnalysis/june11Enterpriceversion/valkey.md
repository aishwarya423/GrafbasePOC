**No, don't change it — Valkey is the right choice and Grafbase will work with it as-is.**

## Why Valkey works with Grafbase's `redis://` config

The `redis://` URL scheme in `grafbase.toml` is **not** a brand name — it's the **wire protocol identifier** (RESP, the REdis Serialization Protocol). Grafbase's Redis client connects, speaks RESP, and doesn't care whether the server on the other end identifies itself as Redis or Valkey.

Think of it like `http://` — it works against Apache, nginx, Caddy, or any HTTP server. The URL scheme is the protocol, not the implementation.

```toml
[entity_caching.redis]
url = "redis://valkey:6379"   # ← this works with Valkey, Redis, KeyDB,
                              #   DragonflyDB, or any RESP-compatible server
```

## Should you switch to Redis anyway?

**No. Stay on Valkey.** Reasons:

| | Valkey (current) | Redis |
|---|---|---|
| License | BSD — fully open source | SSPL/RSAL — restrictive since 2024 |
| Cost | Free forever | Free for now, but commercial restrictions exist |
| Performance | Slightly faster (8.x multi-threading) | Baseline |
| Cloud providers | AWS/GCP/Oracle backing | Less community support going forward |
| Compatibility with Grafbase | ✅ Works | ✅ Works |
| Code changes needed | None | None |

If you *did* want to switch (you don't need to), it's literally just one line:

```yaml
# valkey:
#   image: valkey/valkey:8-alpine

redis:
  image: redis:7-alpine
```

And update the hostname in `grafbase.toml`:
```toml
url = "redis://redis:6379"   # hostname matches the service name
```

But **there's no benefit** to doing this. Valkey is the open-source successor to Redis, fully wire-compatible, and recommended for new projects.

## Quick proof it'll work

When you start the stack with the Enterprise license, the gateway will:
1. Read `url = "redis://valkey:6379"` from `grafbase.toml`
2. Open a TCP connection to `valkey:6379` (Docker DNS resolves `valkey` to the Valkey container)
3. Speak RESP — send `SET Account:acct-1001 "{...}" EX 120`
4. Valkey replies `+OK` (same protocol Redis uses)
5. Done — caching works

You can verify the protocol compatibility right now without even running Grafbase:

```bash
docker exec grafbasepoc-valkey-1 valkey-cli SET test-key "hello" EX 60
docker exec grafbasepoc-valkey-1 valkey-cli GET test-key
# → "hello"
```

That's the same `SET`/`GET` commands Grafbase will use.

## TL;DR

✅ Keep `valkey/valkey:8-alpine` — no change needed
✅ Keep `redis://valkey:6379` in `grafbase.toml` — the `redis://` scheme is protocol, not branding
✅ Code is correct as-is; will work the moment you add a valid `GRAFBASE_LICENSE_KEY`