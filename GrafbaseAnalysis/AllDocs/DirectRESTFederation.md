## Direct REST Federation — What's Possible vs. What's Not

### What you're asking for
Skip the `subgraph-server` layer entirely. Point Grafbase Gateway directly at the REST APIs, and let it auto-generate the GraphQL schema from the OpenAPI specs — **no Apollo server, no resolvers, no Node.js middleware**.

---

### The honest answer: Blocked by the free gateway image

Grafbase Gateway has **two editions**:

| Edition | OpenAPI Connector | What you have |
|---|---|---|
| `ghcr.io/grafbase/gateway:latest` (open-source) | ❌ Not included | ✅ This one |
| Grafbase Cloud / Enterprise | ✅ Included | ❌ Requires account + paid plan |

The OpenAPI-to-GraphQL federation feature (`[subgraphs.X] schema = { type = "openapi", url = "..." }`) only exists in the **Enterprise** build. The open-source image simply doesn't have the connector — it only understands GraphQL Federation subgraphs.

---

### What the architecture would look like IF you had Enterprise

```toml
# grafbase.toml — Enterprise only
[subgraphs.accounts]
schema = { type = "openapi", url = "http://accounts-rest:3000/openapi.json" }
url    = "http://accounts-rest:3000"

[subgraphs.policies]
schema = { type = "openapi", url = "http://policies-rest:3000/openapi.json" }
url    = "http://policies-rest:3000"

[subgraphs.funds]
schema = { type = "openapi", url = "http://funds-rest:3000/openapi.json" }
url    = "http://funds-rest:3000"
```

This would let you **delete the entire `subgraph-server/` directory** — no Apollo, no resolvers, no compose step.

---

### Alternatives using the **free** gateway

| Option | What it means |
|---|---|
| **Keep current setup** | Apollo subgraphs stay as the resolver layer. Works today. |
| **Replace Apollo with a lighter proxy** | Write a tiny GraphQL-to-REST bridge in plain `http` (no Apollo overhead) — still Node.js resolvers but much thinner |
| **Switch to Grafbase Cloud** | Sign up at grafbase.com, use their hosted gateway or pull the Enterprise image — then the `subgraph-server` layer is gone entirely |
| **Use a different open-source gateway** | Tools like **Hasura** (v3 OSS), **StepZen** (cloud), or **Wundergraph** can federate REST directly for free, but require replacing Grafbase Gateway altogether |

---

### Bottom line

**You cannot do it with the current `ghcr.io/grafbase/gateway:latest` image** — the feature doesn't exist in that build. The subgraph resolver layer is mandatory with the free gateway. To remove it, you'd need either Grafbase Enterprise or a different gateway tool entirely.

Want me to explore swapping the gateway for an open-source alternative (like Hasura v3 or Wundergraph) that *can* federate REST directly?