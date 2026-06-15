const fs = require("fs");
const http = require("http");
const path = require("path");
const { ApolloServer } = require("@apollo/server");
const { startStandaloneServer } = require("@apollo/server/standalone");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { parse } = require("graphql");
const Redis = require("ioredis");

const serviceName = process.env.SERVICE_NAME || "accounts";
const port = Number(process.env.PORT || 4000);
const mgmtPort = Number(process.env.MGMT_PORT || port + 1000);
const restBaseUrl = process.env.REST_BASE_URL;
const restApiKey = process.env.REST_API_KEY || "";
const cacheUrl = process.env.CACHE_URL || "";
const cacheTtl = Number(process.env.CACHE_TTL || 60);

if (!restBaseUrl) {
  throw new Error("REST_BASE_URL is required");
}

// ---------------------------------------------------------------------------
// Valkey / Redis cache client
// Only connects when CACHE_URL is provided. Falls back to direct REST calls
// if Valkey is unreachable — subgraphs continue to work without cache.
// ---------------------------------------------------------------------------
const redis = cacheUrl ? new Redis(cacheUrl, { lazyConnect: true }) : null;
if (redis) {
  redis
    .connect()
    .then(() => console.log(`[cache] Connected to Valkey at ${cacheUrl} (TTL ${cacheTtl}s)`))
    .catch((e) => console.warn("[cache] Valkey unavailable, caching disabled:", e.message));
}

async function requestJson(route) {
  const response = await fetch(`${restBaseUrl}${route}`, {
    headers: restApiKey ? { "X-Api-Key": restApiKey } : {}
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`REST ${response.status} ${route}: ${body}`);
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Entity tagging
//
// Each cached entry carries a list of tags (e.g. ["Account", "Account:acct-1001"])
// derived from the REST route. Tags are stored as Valkey SETs:
//
//     tag:Account:acct-1001  →  { subgraph:accounts:/accounts/acct-1001, ... }
//
// Invalidating a tag (e.g. POST /purge {"tags":["Account:acct-1001"]}) deletes
// every cache entry that registered that tag in one operation — no need to
// know individual cache keys.
// ---------------------------------------------------------------------------
function tagsForRoute(route) {
  // Patterns we understand. Order matters — more specific patterns first.
  const patterns = [
    // /accounts/{id}/policies → tied to that account + the Policy collection
    { re: /^\/accounts\/([^/]+)\/policies$/, tags: (m) => [`Account:${m[1]}`, "Policy"] },
    // /accounts/{id}/funds → tied to that account + the Fund collection
    { re: /^\/accounts\/([^/]+)\/funds$/, tags: (m) => [`Account:${m[1]}`, "Fund"] },
    // /accounts/{id}
    { re: /^\/accounts\/([^/]+)$/, tags: (m) => ["Account", `Account:${m[1]}`] },
    // /accounts (list)
    { re: /^\/accounts$/, tags: () => ["Account"] },
    // /customers/{id}/accounts → tied to that customer + Account collection
    { re: /^\/customers\/([^/]+)\/accounts$/, tags: (m) => [`Customer:${m[1]}`, "Account"] },
    // /policies/{id}
    { re: /^\/policies\/([^/]+)$/, tags: (m) => ["Policy", `Policy:${m[1]}`] },
    // /policies (list)
    { re: /^\/policies$/, tags: () => ["Policy"] },
    // /funds/{id}/policies → tied to that fund + Policy collection
    { re: /^\/funds\/([^/]+)\/policies$/, tags: (m) => [`Fund:${m[1]}`, "Policy"] },
    // /funds/{id}
    { re: /^\/funds\/([^/]+)$/, tags: (m) => ["Fund", `Fund:${m[1]}`] },
    // /funds (list)
    { re: /^\/funds$/, tags: () => ["Fund"] }
  ];

  for (const { re, tags } of patterns) {
    const m = route.match(re);
    if (m) return tags(m);
  }
  return []; // unknown shape — no tags, cached but not purgable by tag
}

const tagIndexKey = (tag) => `tag:${tag}`;

// ---------------------------------------------------------------------------
// Cache-aware wrapper around requestJson.
// Key pattern: subgraph:<service>:<route>  e.g. subgraph:accounts:/accounts/acct-1001
// On HIT  → returns parsed JSON from Valkey, REST API is NOT called.
// On MISS → calls REST API, stores result in Valkey with EX TTL, registers tags.
// ---------------------------------------------------------------------------
async function cachedRequestJson(route) {
  const key = `subgraph:${serviceName}:${route}`;

  if (redis && redis.status === "ready") {
    const cached = await redis.get(key);
    if (cached !== null) {
      console.log(`[cache HIT]  ${key}`);
      return JSON.parse(cached);
    }
    console.log(`[cache MISS] ${key}`);
  }

  const data = await requestJson(route);

  if (redis && redis.status === "ready" && data !== null) {
    const tags = tagsForRoute(route);
    // Pipeline: set the entry + register the key under each tag SET.
    // Tag SETs are not TTL'd individually — stale members get cleaned up
    // when purgeTags runs (it deletes the SET entirely after invalidation).
    const pipeline = redis.pipeline();
    pipeline.set(key, JSON.stringify(data), "EX", cacheTtl);
    for (const tag of tags) {
      pipeline.sadd(tagIndexKey(tag), key);
      // Give the tag index a TTL slightly longer than the data TTL so it
      // expires on its own if nobody purges — prevents unbounded growth.
      pipeline.expire(tagIndexKey(tag), cacheTtl * 2);
    }
    await pipeline.exec();
    if (tags.length > 0) {
      console.log(`[cache SET]  ${key} tags=[${tags.join(", ")}]`);
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Tag-based invalidation: deletes every cache entry registered under any of
// the supplied tags, then deletes the tag indexes themselves.
// Returns { purgedKeys, purgedTags } for the response.
// ---------------------------------------------------------------------------
async function purgeTags(tags) {
  if (!redis || redis.status !== "ready") {
    return { purgedKeys: 0, purgedTags: 0, error: "cache unavailable" };
  }
  if (!Array.isArray(tags) || tags.length === 0) {
    return { purgedKeys: 0, purgedTags: 0 };
  }

  const indexKeys = tags.map(tagIndexKey);
  // Gather all cache keys registered under any of the tags
  const memberLists = await Promise.all(indexKeys.map((k) => redis.smembers(k)));
  const cacheKeys = [...new Set(memberLists.flat())];

  const pipeline = redis.pipeline();
  if (cacheKeys.length > 0) pipeline.del(...cacheKeys);
  if (indexKeys.length > 0) pipeline.del(...indexKeys);
  await pipeline.exec();

  console.log(`[cache PURGE] tags=[${tags.join(", ")}] removed ${cacheKeys.length} key(s)`);
  return { purgedKeys: cacheKeys.length, purgedTags: tags.length, keys: cacheKeys };
}

function loadTypeDefs(name) {
  return parse(fs.readFileSync(path.join(__dirname, "schemas", `${name}.graphql`), "utf8"));
}

function accountResolvers() {
  return {
    Account: {
      __resolveReference: (account) => cachedRequestJson(`/accounts/${account.id}`),
      fundHoldings: (account) =>
        account.fundHoldings.map((holding) => ({
          allocationPercent: holding.allocationPercent,
          units: holding.units,
          currentValue: holding.currentValue,
          fund: { __typename: "Fund", id: holding.fundId }
        }))
    },
    Query: {
      account: (_, { id }) => cachedRequestJson(`/accounts/${id}`),
      accounts: (_, { customerId }) =>
        customerId
          ? cachedRequestJson(`/customers/${customerId}/accounts`)
          : cachedRequestJson("/accounts")
    }
  };
}

function policyResolvers() {
  return {
    Account: {
      __resolveReference: (account) => account,
      policies: (account) => cachedRequestJson(`/accounts/${account.id}/policies`)
    },
    Policy: {
      __resolveReference: (policy) => cachedRequestJson(`/policies/${policy.id}`),
      account: (policy) => ({ __typename: "Account", id: policy.accountId }),
      linkedFunds: (policy) => policy.fundIds.map((id) => ({ __typename: "Fund", id }))
    },
    Fund: {
      __resolveReference: (fund) => fund,
      linkedPolicies: (fund) => cachedRequestJson(`/funds/${fund.id}/policies`)
    },
    Query: {
      policy: (_, { id }) => cachedRequestJson(`/policies/${id}`),
      policies: (_, { accountId }) =>
        accountId
          ? cachedRequestJson(`/accounts/${accountId}/policies`)
          : cachedRequestJson("/policies")
    }
  };
}

function fundResolvers() {
  return {
    Account: {
      __resolveReference: (account) => account,
      availableFunds: (account) => cachedRequestJson(`/accounts/${account.id}/funds`)
    },
    Fund: {
      __resolveReference: (fund) => cachedRequestJson(`/funds/${fund.id}`)
    },
    Query: {
      fund: (_, { id }) => cachedRequestJson(`/funds/${id}`),
      funds: () => cachedRequestJson("/funds")
    }
  };
}

const resolversByService = {
  accounts: accountResolvers,
  policies: policyResolvers,
  funds: fundResolvers
};

if (!resolversByService[serviceName]) {
  throw new Error(`Unknown SERVICE_NAME ${serviceName}`);
}

const schema = buildSubgraphSchema({
  typeDefs: loadTypeDefs(serviceName),
  resolvers: resolversByService[serviceName]()
});

const server = new ApolloServer({ schema });

startStandaloneServer(server, { listen: { host: "0.0.0.0", port } }).then(({ url }) => {
  console.log(`${serviceName} subgraph ready at ${url}`);
});

// ---------------------------------------------------------------------------
// Management HTTP endpoint for cache-tag invalidation.
//
//   POST /purge   { "tags": ["Account:acct-1001", "Policy"] }
//     → deletes every cached entry tagged with any of the given tags
//
//   GET /tags/:tag
//     → lists cache keys currently registered under a tag
//
//   GET /health
//     → simple liveness check
//
// Exposed on MGMT_PORT (default = PORT + 1000). Kept separate from the
// GraphQL endpoint so the federation contract stays clean.
// ---------------------------------------------------------------------------
const mgmt = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.method === "GET" && req.url === "/health") {
      return send(200, { service: serviceName, cache: redis?.status || "disabled" });
    }

    if (req.method === "GET" && req.url.startsWith("/tags/")) {
      const tag = decodeURIComponent(req.url.slice("/tags/".length));
      if (!redis || redis.status !== "ready") return send(503, { error: "cache unavailable" });
      const members = await redis.smembers(tagIndexKey(tag));
      return send(200, { tag, keys: members });
    }

    if (req.method === "POST" && req.url === "/purge") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", async () => {
        try {
          const { tags } = JSON.parse(raw || "{}");
          if (!Array.isArray(tags)) {
            return send(400, { error: "body must be { tags: string[] }" });
          }
          const result = await purgeTags(tags);
          return send(200, result);
        } catch (e) {
          return send(400, { error: e.message });
        }
      });
      return;
    }

    send(404, { error: "not found", routes: ["GET /health", "GET /tags/:tag", "POST /purge"] });
  } catch (e) {
    send(500, { error: e.message });
  }
});

mgmt.listen(mgmtPort, "0.0.0.0", () => {
  console.log(`${serviceName} cache management API ready at http://0.0.0.0:${mgmtPort}`);
});
