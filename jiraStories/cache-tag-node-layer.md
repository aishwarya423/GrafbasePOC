# POC for Cache Key Visibility & Valkey Entity Tagging

## Key details

### Description

**User story**

As an engineer working on the GraphQL gateway and subgraph caching, when an account query executes and caches a response, I want to validate and understand how the cache key and entity tag index sets are structured and stored in Valkey so that cache behaviour is transparent, reproducible, and ready for subsequent cache invalidation implementations.

### Context

As part of the Grafbase federation pilot, responses are cached in Valkey. Clear visibility is needed into how cache entries and associated tag indexes are created during GraphQL query execution.

* Trace how `server.js` maps route paths and entity identifiers to Valkey keys.
* Confirm the separation between:

  * payload cache keys that store the cached REST/GraphQL payload as a `string`
  * entity tag indexes that store sets of related cache keys for targeted invalidation
* Execute sample queries, for example for `acct-1001`.
* Inspect the resulting Valkey data using:

  * `GET`
  * `TYPE`
  * `SMEMBERS`
  * `TTL`
* Verify the expected Valkey key schema and types. Ex: like below format:

  * `subgraph:accounts:/accounts/acct-1001` as `string`
  * `tag:Account` as `set`
  * `tag:Account:acct-1001` as `set`
* Confirm active cache entries return a positive TTL (`TTL > 2mins`).
* Deliver a reproducible proof-of-concept and reference documentation for future cache invalidation work.

## Other information

* This spike covers Valkey entity tagging and cache key visibility.
* The goal is to analyse, trace and document how GraphQL account queries generate Valkey cache keys and entity tag indexes.

## Acceptance Criteria

* ☐ Executing a GraphQL query creates the expected cache key and tag index keys in Valkey.
* ☐ Role and lifecycle of each key type, including cached payload and tag index, is documented.
* ☐ Route-to-cache-key mapping logic in `server.js` is clearly mapped out.
* ☐ Verification steps with executable CLI examples using `GET`, `TYPE`, `SMEMBERS` and `TTL` are provided.
* ☐ Documentation should be published.

## Deliverables

1. **Route-to-Key Mapping:** Reference of GraphQL/REST endpoints to Valkey key generation.
2. **Reproducible Validation Playbook:** CLI command sequence to inspect cache entries and tag membership.
3. **Invalidation Reference:** Summary of how tag index sets will be used in downstream invalidation tasks.
