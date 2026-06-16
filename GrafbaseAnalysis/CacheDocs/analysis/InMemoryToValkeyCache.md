As discussed, the **only thing blocking Valkey cache is the OSS gateway image**. The config is already 100% wired correctly.

You just need to replace one line in `docker-compose.yml` — the gateway image.

There it is — line 79. That is the **only change needed**:

```
ghcr.io/grafbase/gateway:latest        ← OSS, in-memory only
ghcr.io/grafbase/gateway:latest-enterprise  ← Enterprise, uses Valkey
```

But the Enterprise image requires a **Grafbase account + license key**. Here's exactly what to do:

---

### Step 1 — Create a free Grafbase account
Go to → **https://grafbase.com** → Sign up

### Step 2 — Get your license key
Dashboard → Settings → License Key → Copy it

### Step 3 — Add it to your `.env` file
Create a `.env` file in the project root (if it doesn't exist):
```bash
GRAFBASE_LICENSE_KEY=your-key-here
```

### Step 4 — Update `docker-compose.yml`

Now add the license key env var to the gateway service:

### Step 5 — Restart the stack
```bash
docker compose down
docker compose up --build -d
```

### Step 6 — Verify Valkey is now receiving data
```bash
# In one terminal — watch live cache writes
docker exec -it grafbasepoc-valkey-1 valkey-cli MONITOR

# In another terminal — fire a query
curl -s -X POST http://localhost:5050/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"{ account(id:\"acct-1001\") { holderName totalValue } }"}'
```

You should now see `SET` commands streaming in the MONITOR terminal — that confirms Valkey cache is live.

---

### Summary — total changes needed

| File | Change |
|---|---|
| `docker-compose.yml` | `latest` → `latest-enterprise` + `GRAFBASE_LICENSE_KEY` env var |
| `.env` | Add `GRAFBASE_LICENSE_KEY=your-key-here` |
| `grafbase/grafbase.toml` | **Nothing** — already configured correctly |
| Any Node.js code | **Nothing** |

Everything else — the Valkey container, the `[entity_caching.redis]` config, the TTLs — is already in place and will activate the moment the Enterprise image starts.