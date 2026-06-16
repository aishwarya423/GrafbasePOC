The cached data is stored in **Valkey** (the Redis-compatible container running in your Docker Compose stack).

## Where exactly:

**1. Inside the Valkey container's memory + disk**
- The Valkey process holds keys in RAM (fast reads)
- Valkey periodically snapshots to disk at `/data` inside the container

**2. On your host machine — Docker named volume `valkey-data`**
- Defined at the bottom of `docker-compose.yml`:
  ```yaml
  volumes:
    valkey-data:
  ```
- Mounted into the container at `/data`:
  ```yaml
  volumes:
    - valkey-data:/data
  ```
- Physical location on Mac (via Docker Desktop's VM):
  ```
  /var/lib/docker/volumes/grafbasepoc_valkey-data/_data/
  ```
- This is what makes the cache **survive container restarts** — even if you `docker compose down` and `up` again, the cached data is still there.

## What the stored keys look like:

Cache keys follow the pattern `subgraph:<service>:<route>`, for example:
```
subgraph:accounts:/accounts/acct-1001
subgraph:policies:/accounts/acct-1001/policies
subgraph:funds:/funds/fund-001
```

Each value is the JSON response from the REST API, with a TTL of 120s / 30s / 300s depending on which subgraph wrote it.

## See it for yourself:

```bash
# List all cached keys
docker exec grafbasepoc-valkey-1 valkey-cli KEYS "*"

# Read one cached value
docker exec grafbasepoc-valkey-1 valkey-cli GET "subgraph:accounts:/accounts/acct-1001"

# How long until this key expires (in seconds)
docker exec grafbasepoc-valkey-1 valkey-cli TTL "subgraph:accounts:/accounts/acct-1001"

# Total number of cached entries
docker exec grafbasepoc-valkey-1 valkey-cli DBSIZE

# Inspect the host-side volume location
docker volume inspect grafbasepoc_valkey-data
```

## Persistence flow:

```
Client query
    ↓
Subgraph server (Node.js, ioredis client)
    ↓ writes JSON with TTL
Valkey container (RAM)
    ↓ snapshots periodically
/data inside container
    ↓ mounted from
Docker volume `valkey-data` on host disk  ← survives container restarts
```

So in short: **RAM inside the Valkey container for speed, backed by the `valkey-data` Docker volume on your host for persistence.**