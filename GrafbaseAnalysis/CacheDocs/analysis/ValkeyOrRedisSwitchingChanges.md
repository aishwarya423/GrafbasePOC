## Current Setup — What's Actually Running

Right now you have **Valkey** configured. Here's the current state:

**`docker-compose.yml`**
```yaml
valkey:
  image: valkey/valkey:8-alpine   # ← Valkey container
```

**`grafbase/grafbase.toml`**
```toml
[entity_caching.redis]
url = "redis://valkey:6379"       # ← pointing at the Valkey container
```

---

## Why Both Work With The Same Config

Valkey is a **fork of Redis**. It is 100% wire-protocol compatible — meaning any client or server that speaks the Redis protocol can talk to Valkey without any changes. Grafbase Gateway uses the Redis protocol internally, so:

```
Grafbase Gateway
      │
      │  speaks Redis protocol
      ▼
  redis://valkey:6379   ← could be either Redis or Valkey, gateway doesn't care
```

The URL `redis://` is just the **protocol name** (like `http://`), not the product. It works for both.

---

## Switching Between Them — Only 1 Line Changes

### Currently on Valkey → switch to Redis

**`docker-compose.yml`** — change the image and service name:

```yaml
# BEFORE (Valkey)
valkey:
  image: valkey/valkey:8-alpine
  healthcheck:
    test: ["CMD", "valkey-cli", "ping"]

# AFTER (Redis)
redis:
  image: redis:7-alpine
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
```

**`grafbase/grafbase.toml`** — update the hostname in the URL:

```toml
# BEFORE (Valkey)
[entity_caching.redis]
url = "redis://valkey:6379"

# AFTER (Redis)
[entity_caching.redis]
url = "redis://redis:6379"
```

The hostname (`valkey` / `redis`) must match the **service name** in `docker-compose.yml` because Docker uses service names as internal DNS hostnames.

---

### Currently on Redis → switch back to Valkey

Exact reverse — change `redis:7-alpine` → `valkey/valkey:8-alpine`, `redis-cli` → `valkey-cli`, and the URL hostname back to `valkey`.

---

## Summary Table

| Thing to change | Valkey | Redis |
|---|---|---|
| `docker-compose.yml` image | `valkey/valkey:8-alpine` | `redis:7-alpine` |
| `docker-compose.yml` healthcheck | `valkey-cli ping` | `redis-cli ping` |
| `grafbase.toml` URL hostname | `redis://valkey:6379` | `redis://redis:6379` |
| `grafbase.toml` `[entity_caching.redis]` key | unchanged | unchanged |
| Node.js code | nothing | nothing |
| Grafbase config structure | nothing | nothing |

**That's it — 3 lines total across 2 files.** Everything else stays identical because they speak the same protocol.