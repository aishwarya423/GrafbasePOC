FROM nginx:alpine

# Remove default nginx static assets and config
RUN rm -rf /usr/share/nginx/html/*

# Inline nginx config — listen on 8080
RUN printf 'events {}\nhttp {\n  include /etc/nginx/mime.types;\n  default_type application/octet-stream;\n  server {\n    listen 8080;\n    server_name _;\n    root /usr/share/nginx/html;\n    index index.html;\n    location / { try_files $uri $uri/ /index.html; }\n  }\n}\n' > /etc/nginx/nginx.conf

# Inline GraphiQL explorer — no external files needed
RUN cat > /usr/share/nginx/html/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Grafbase Insurance GraphiQL</title>

    <!-- GraphiQL CSS from CDN -->
    <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />

    <style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
      #graphiql { height: 100vh; }
    </style>
  </head>
  <body>
    <div id="graphiql">Loading GraphiQL…</div>

    <!-- Dependencies from CDN -->
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>

    <script>
      const GRAPHQL_URL = "http://localhost:5050/graphql";

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

      const fetcher = GraphiQL.createFetcher({ url: GRAPHQL_URL });

      ReactDOM.createRoot(document.getElementById("graphiql")).render(
        React.createElement(GraphiQL, { fetcher, defaultQuery })
      );
    </script>
  </body>
</html>
EOF

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
