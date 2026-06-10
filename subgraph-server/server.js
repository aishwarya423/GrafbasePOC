const fs = require("fs");
const path = require("path");
const { ApolloServer } = require("@apollo/server");
const { startStandaloneServer } = require("@apollo/server/standalone");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { parse } = require("graphql");
const Redis = require("ioredis");

const serviceName = process.env.SERVICE_NAME || "accounts";
const port = Number(process.env.PORT || 4000);
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
// Cache-aware wrapper around requestJson.
// Key pattern: subgraph:<service>:<route>  e.g. subgraph:accounts:/accounts/acct-1001
// On HIT  → returns parsed JSON from Valkey, REST API is NOT called.
// On MISS → calls REST API, stores result in Valkey with EX TTL, returns data.
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
    await redis.set(key, JSON.stringify(data), "EX", cacheTtl);
  }
  return data;
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
