# Design Document

## Story Title

Enable Valkey or Redis Caching for Graphbase Local Federation Runtime

---

# 1. Overview

## Objective

Enable Redis/Valkey-based caching in the local Graphbase federation runtime to validate caching feasibility, configuration patterns, persistence behavior, and query performance improvements within a Proof of Concept (POC) environment.

The POC will demonstrate:

* Graphbase integration with Redis or Valkey cache backend
* Query and entity cache behavior
* Cache TTL configuration
* Cache persistence across Graphbase restarts
* Docker Compose based local deployment
* Validation and verification procedures

---

# 2. Background

Graphbase Gateway federates multiple backend services into a unified GraphQL API.

For production-scale federation, caching is critical for:

* Reducing backend API calls
* Improving response latency
* Reducing load on federated services
* Supporting cache invalidation strategies

This POC validates whether Graphbase can effectively leverage Redis/Valkey as an external cache backend.

---

# 3. Problem Statement

Currently:

* Graphbase federation fetches data directly from backend services.
* No external cache layer exists.
* Repeated queries always invoke source APIs.
* Cache persistence behavior is unknown.

Need:

* External cache backend.
* Configurable cache TTL.
* Persistence validation.
* Local development pattern that can later be promoted to higher environments.

---

# 4. Scope

## In Scope

### Infrastructure

* Redis or Valkey container deployment
* Docker Compose orchestration
* Persistent volume configuration

### Graphbase

* Cache backend configuration
* Environment-based endpoint configuration
* Query caching validation
* Entity caching validation

### Validation

* TTL verification
* Cache hit verification
* Persistence verification

### Documentation

* Setup instructions
* Verification steps
* Troubleshooting guidance

---

## Out of Scope

* Production deployment
* HA Redis/Valkey clusters
* Cache invalidation APIs
* Distributed cache synchronization
* Performance benchmarking
* Multi-region caching

---

# 5. High-Level Architecture

```text
                +-------------------+
                | GraphQL Client    |
                +---------+---------+
                          |
                          v
                +-------------------+
                | Graphbase Gateway |
                +---------+---------+
                          |
                Cache Lookup
                          |
                          v
                +-------------------+
                | Redis / Valkey    |
                +-------------------+
                          |
                Cache Miss
                          |
                          v
     +----------------+  +----------------+  +----------------+
     | Mock API 1     |  | Mock API 2     |  | Mock API 3     |
     | Customer API   |  | Policy API     |  | Fund API       |
     +----------------+  +----------------+  +----------------+
```

---

# 6. Components

## 6.1 Graphbase Gateway

Responsibilities:

* Federates backend APIs
* Executes GraphQL queries
* Reads/writes cache entries
* Applies cache TTL policies

---

## 6.2 Redis / Valkey

Responsibilities:

* Store cache entries
* Persist cache data
* Return cached responses
* Manage key expiration

Persistence:

```text
Volume Mount
    |
    +--> /data
```

---

## 6.3 Mock APIs

Example Services:

### Customer Service

```http
GET /customers/{id}
```

### Policy Service

```http
GET /policies/{id}
```

### Fund Service

```http
GET /funds/{id}
```

---

# 7. Deployment Design

## Docker Compose Layout

```yaml
services:

  graphbase:
    image: ghcr.io/grafbase/gateway:latest
    ports:
      - "5000:5000"
    environment:
      CACHE_URL: redis://valkey:6379
    depends_on:
      - valkey

  valkey:
    image: valkey/valkey:latest
    ports:
      - "6379:6379"
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

Alternative:

```yaml
image: redis:7
```

---

# 8. Configuration Design

## Environment Variables

| Variable      | Description                 |
| ------------- | --------------------------- |
| CACHE_URL     | Redis/Valkey connection URL |
| CACHE_TTL     | Default cache duration      |
| CACHE_ENABLED | Enable cache layer          |

Example:

```env
CACHE_ENABLED=true
CACHE_URL=redis://valkey:6379
CACHE_TTL=300
```

---

# 9. Cache Strategy

## Query Cache

Cache GraphQL query responses.

Example:

```graphql
query PoliciesByAccount {
  policies(accountId: "acct-1001") {
    id
    policyNumber
  }
}
```

Flow:

```text
First Request
   |
   +--> Cache Miss
   +--> Backend APIs Called
   +--> Cache Stored

Second Request
   |
   +--> Cache Hit
   +--> Response Returned
```

---

## Entity Cache

Cache individual entities.

Example:

```graphql
customer(id: "1001")
```

Stored separately for reuse by future queries.

---

# 10. TTL Design

## Objective

Validate expiration behavior.

Example:

```text
TTL = 60 seconds
```

### Scenario

```text
Request #1
  Cache Miss

Request #2
  Cache Hit

Wait 60 sec

Request #3
  Cache Miss
```

Expected:

* Key automatically expires
* Backend re-fetch occurs

---

# 11. Cache Tagging Validation

POC-level validation only.

Example Tags:

```text
customer
policy
fund
```

Purpose:

* Demonstrate grouping capability.
* Verify metadata association.
* Foundation for future invalidation strategies.

---

# 12. Persistence Validation

## Objective

Verify cache survives Graphbase restart.

### Test

Step 1

```text
Start Graphbase
```

Step 2

```text
Execute query
```

Step 3

```text
Confirm key exists
```

Step 4

```bash
docker restart graphbase
```

Step 5

```text
Re-run query
```

Expected:

```text
Cache Hit
```

because cache remains in Valkey volume.

---

# 13. Verification Scenarios

## Scenario 1 – Cache Miss

Expected:

* Backend APIs invoked
* Cache populated

Pass Criteria:

```text
Response received
Cache key created
```

---

## Scenario 2 – Cache Hit

Expected:

* No backend call
* Cached response returned

Pass Criteria:

```text
Lower response time
No backend log activity
```

---

## Scenario 3 – TTL Expiration

Expected:

```text
Key expires
Fresh fetch occurs
```

Pass Criteria:

```text
New backend call observed
```

---

## Scenario 4 – Persistence

Expected:

```text
Cache survives gateway restart
```

Pass Criteria:

```text
Key remains available
```

---

# 14. Risks

| Risk                          | Impact              | Mitigation             |
| ----------------------------- | ------------------- | ---------------------- |
| Backend APIs unavailable      | Cache warm-up fails | Keep mock APIs running |
| Incorrect cache configuration | Cache not utilized  | Validate startup logs  |
| Persistence misconfigured     | Data loss           | Verify mounted volume  |
| TTL too small                 | Frequent misses     | Use configurable TTL   |

---

# 15. Assumptions

* Graphbase supports Redis-compatible cache backend.
* Valkey is Redis protocol compatible.
* Docker environment available locally.
* Mock APIs are accessible from Graphbase container.

---

# 16. Known Limitation

If backend mock APIs are unavailable:

```text
Initial cache miss cannot be populated.
```

Consequently:

* Cache validation requests fail.
* Gateway cannot fetch source data.

This limitation is acceptable for the POC because the objective is validating cache feasibility and configuration patterns rather than backend resiliency.

---

# 17. Acceptance Criteria Mapping

| Acceptance Criteria                      | Validation                   |
| ---------------------------------------- | ---------------------------- |
| Redis or Valkey runs alongside Graphbase | Docker Compose deployment    |
| Runtime uses Valkey backend caching      | Cache configuration verified |
| Repeat queries return cached response    | Cache hit validation         |
| Cache TTL or tagging demonstrated        | TTL expiry test              |
| Cache survives runtime restart           | Persistence test             |
| Readme updated                           | Documentation delivered      |

---

# 18. Success Criteria

The POC is considered successful when:

1. Graphbase connects successfully to Redis/Valkey.
2. Cache entries are created for federated queries.
3. Repeated queries return cache hits.
4. TTL expiration behaves as configured.
5. Cache persists across Graphbase restart.
6. Documentation enables reproducible local setup.
