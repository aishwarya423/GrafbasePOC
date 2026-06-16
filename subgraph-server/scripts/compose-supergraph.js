const fs = require("fs");
const path = require("path");
const { composeServices } = require("@apollo/composition");
const { parse } = require("graphql");

const root = path.resolve(__dirname, "..", "..");
const schemasDir = path.join(root, "subgraph-server", "schemas");
const outputPath = path.join(root, "grafbase", "supergraph.graphql");

const services = [
  {
    name: "accounts",
    url: process.env.ACCOUNTS_SUBGRAPH_URL || "http://accounts-subgraph:4000/graphql",
    typeDefs: parse(fs.readFileSync(path.join(schemasDir, "accounts.graphql"), "utf8"))
  },
  {
    name: "policies",
    url: process.env.POLICIES_SUBGRAPH_URL || "http://policies-subgraph:4000/graphql",
    typeDefs: parse(fs.readFileSync(path.join(schemasDir, "policies.graphql"), "utf8"))
  },
  {
    name: "funds",
    url: process.env.FUNDS_SUBGRAPH_URL || "http://funds-subgraph:4000/graphql",
    typeDefs: parse(fs.readFileSync(path.join(schemasDir, "funds.graphql"), "utf8"))
  }
];

const result = composeServices(services);

if (result.errors?.length) {
  for (const error of result.errors) {
    console.error(error.message);
  }
  process.exit(1);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, result.supergraphSdl);
console.log(`Composed Grafbase/Apollo Federation supergraph at ${outputPath}`);
