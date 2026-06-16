# Design Document – Enable Valkey/Redis Caching for Graphbase Local Federation Runtime

## Objective

Enable Redis or Valkey caching in the local Graphbase federation runtime to validate caching behavior, persistence, and configuration patterns for the federation POC.

---

## Scope

### In Scope

* Redis/Valkey deployment via Docker Compose
* Graphbase cache backend configuration
* Query/entity cache validation
* TTL or cache tagging demonstration
* Cache persistence verification
* Documentation updates

### Out of Scope

* Production deployment
* HA/Cluster setup
* Performance benchmarking
* Advanced cache invalidation

---

## High-Level Architecture

```text
Client
  |
Graphbase Gateway
  |
Redis/Valkey Cache
  |
Mock REST APIs
(Customer, Policy, Fund)
```

---

## Solution Design

### Docker Compose

```yaml
services:
  graphbase:
    depends_on:
      - valkey

  valkey:
    image: valkey/valkey:latest
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

### Configuration

```env
CACHE_ENABLED=true
CACHE_URL=redis://valkey:6379
CACHE_TTL=300
```

Graphbase will use Redis/Valkey as the external cache store.

---

## Validation Scenarios

### 1. Cache Miss

* First query executes against backend APIs.
* Response is stored in cache.

### 2. Cache Hit

* Repeat query returns data from cache.
* Backend APIs are not called.

### 3. TTL Validation

* Cached entry expires after configured TTL.
* Subsequent request fetches fresh data and repopulates cache.

### 4. Persistence Validation

* Populate cache.
* Restart Graphbase container.
* Verify cached data remains available in Redis/Valkey.

---

## Risks / Limitation

If mock backend APIs are unavailable, cache validation will fail on the initial cache miss because source data cannot be fetched and cached.

This limitation is acceptable for the POC since the goal is to validate cache feasibility and configuration patterns.

---

## Acceptance Criteria Mapping

| Acceptance Criteria                   | Validation                |
| ------------------------------------- | ------------------------- |
| Redis/Valkey runs with Graphbase      | Docker Compose deployment |
| Runtime uses cache backend            | Cache connection verified |
| Repeat queries return cached response | Cache hit observed        |
| TTL/tagging demonstrated              | Expiry or tagging test    |
| Cache survives restart                | Persistence verified      |
| Documentation updated                 | README updated            |
