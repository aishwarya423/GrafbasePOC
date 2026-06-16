const fs = require("fs");
const path = require("path");
const { ApolloServer } = require("@apollo/server");
const { startStandaloneServer } = require("@apollo/server/standalone");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { parse } = require("graphql");

const serviceName = process.env.SERVICE_NAME || "accounts";
const port = Number(process.env.PORT || 4000);
const restBaseUrl = process.env.REST_BASE_URL;
const restApiKey = process.env.REST_API_KEY || "";

if (!restBaseUrl) {
  throw new Error("REST_BASE_URL is required");
}

// Subgraph-side caching removed — we are testing the gateway-layer
// [entity_caching.redis] config in grafbase.toml as the sole cache layer.
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

const cachedRequestJson = requestJson;

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
