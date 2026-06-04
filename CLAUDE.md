# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A federation POC that exposes three mock REST APIs (accounts, policies, funds) through Apollo Federation subgraphs, unified by the Grafbase Gateway into a single GraphQL endpoint. A GraphiQL UI is served via Docker.

## Commands

**Run the full stack (primary workflow):**
```bash
docker compose up --build
```
- GraphiQL UI: http://localhost:8080
- Grafbase GraphQL endpoint: http://localhost:5050/graphql
- REST APIs: http://localhost:3001, :3002, :3003

**Stop / clean rebuild:**
```bash
docker compose down
docker compose build --no-cache && docker compose up
```

**Regenerate supergraph after schema changes** (must run before `docker compose up` or the gateway will use a stale schema):
```bash
npm --prefix subgraph-server install
npm --prefix subgraph-server run compose
```
This rewrites `grafbase/supergraph.graphql` from the three SDL files in `subgraph-server/schemas/`.

**Run mock REST API locally (all three services on separate ports):**
```bash
cd mock-rest-api && node server.js
# accounts → :3001, policies → :3002, funds → :3003
```

## Architecture

```
GraphiQL (:8080) → Grafbase Gateway (:5050/graphql)
                        ├── accounts-subgraph (:4000) → accounts-rest (:3001)
                        ├── policies-subgraph (:4000) → policies-rest (:3002)
                        └── funds-subgraph    (:4000) → funds-rest    (:3003)
```

### Key files

| File | Role |
|------|------|
| `mock-rest-api/server.js` | Single Node.js file that spawns three HTTP servers (one per service) on ports 3001/3002/3003 |
| `subgraph-server/server.js` | Single Node.js file that runs as any of the three Apollo Federation subgraphs, selected by `SERVICE_NAME` env var |
| `subgraph-server/schemas/*.graphql` | Apollo Federation SDL for each subgraph (accounts, policies, funds) — edit these to change the GraphQL schema |
| `subgraph-server/scripts/compose-supergraph.js` | Composes the three SDL files into a supergraph using `@apollo/composition` |
| `grafbase/supergraph.graphql` | **Generated file** — the composed supergraph fed to Grafbase Gateway; do not hand-edit |
| `grafbase/grafbase.toml` | Gateway config: subgraph URLs, CORS, timeouts |
| `docker-compose.yml` | Wires all services; passes API keys via environment variables |

### Federation model

- `Account`, `Fund`, and `Policy` are federation entities (`@key(fields: "id")`).
- The **accounts** subgraph owns `Account` fields; policies and funds subgraphs extend it with `policies` and `availableFunds` fields respectively.
- The **policies** subgraph extends `Fund` with `linkedPolicies`.
- Cross-subgraph references use `__resolveReference` in `subgraph-server/server.js`.

### API keys

REST services require `X-Api-Key`. Docker Compose passes matching keys through env vars (`ACCOUNTS_API_KEY`, `POLICIES_API_KEY`, `FUNDS_API_KEY`). Defaults are `*-local-key`. Override by creating a `.env` file.

### GraphiQL explorer

The `explorer/` directory is a **pure nginx container** — no Node.js, no build step, no React.

| File | Role |
|------|------|
| `explorer/Dockerfile` | `nginx:alpine` image — inlines both the nginx config and the GraphiQL HTML via `RUN` commands; no external files, no `npm install` |

The GraphQL endpoint URL (`http://localhost:5050/graphql`) is hardcoded in `index.html`. To change it, edit the `GRAPHQL_URL` constant near the bottom of that file.
