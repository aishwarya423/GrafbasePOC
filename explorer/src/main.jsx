import React from "react";
import { createRoot } from "react-dom/client";
import { createGraphiQLFetcher } from "@graphiql/toolkit";
import { GraphiQL } from "graphiql";
import "graphiql/style.css";
import "./style.css";

const fetcher = createGraphiQLFetcher({
  url: "http://localhost:5050/graphql"
});

const defaultQuery = `query InsurancePortfolio {
  account(id: "acct-1001") {
    id
    holderName
    accountType
    totalValue
    policies {
      policyNumber
      productName
      status
      linkedFunds {
        name
        assetClass
        oneYearReturnPercent
      }
    }
    fundHoldings {
      allocationPercent
      currentValue
      fund {
        name
        riskRating
        sustainabilityLabel
      }
    }
  }
}`;

function App() {
  return <GraphiQL fetcher={fetcher} defaultQuery={defaultQuery} />;
}

createRoot(document.getElementById("root")).render(<App />);
