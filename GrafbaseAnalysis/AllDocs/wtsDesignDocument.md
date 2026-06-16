Your manager is asking for a **design document in Confluence** before development starts.

**Confluence** is a documentation/wiki tool from [Atlassian Confluence](https://www.atlassian.com/software/confluence?utm_source=chatgpt.com). Teams use it to document requirements, architecture, designs, decisions, and project plans.

When your manager says:

> "We need a Confluence design page during day 2 of the sprint. Please don't start coding directly. Let's review the design page first, then you can start coding."

They likely mean:

### Step 1: Create a Design Page

Document what you're planning to build before writing code.

Typical sections:

#### 1. Problem Statement

What problem are you solving?

Example:

> Build a Grafbase federation layer that combines 3 REST APIs into a unified GraphQL endpoint.

#### 2. Requirements

Functional requirements:

* Expose customer data
* Expose policy data
* Expose claims data

Non-functional requirements:

* Caching support
* Low latency
* Scalability

#### 3. Current Architecture

How things work today.

```
Frontend
   |
REST API 1

REST API 2

REST API 3
```

#### 4. Proposed Architecture

```
Frontend
    |
 Grafbase Gateway
    |
 -------------------
 |        |        |
API1    API2     API3
```

#### 5. Technical Design

* Grafbase Federation
* OpenAPI schema generation
* Entity mapping
* Caching strategy (Redis/Valkey)
* Error handling

#### 6. API Flow

Example:

```
Query Customer

Gateway
   |
Customer API
   |
Policy API
   |
Response
```

#### 7. Risks

* API latency
* Schema changes
* Cache consistency

#### 8. Alternatives Considered

* Direct REST consumption
* Apollo Federation
* Grafbase Federation

#### 9. Implementation Plan

Sprint tasks:

| Task                 | Owner |
| -------------------- | ----- |
| Create OpenAPI specs | You   |
| Configure Grafbase   | You   |
| Add caching          | You   |
| Testing              | You   |

#### 10. Open Questions

Items needing review from manager.

---

### Why managers ask for this

They want to review:

* Architecture
* Approach
* Risks
* Assumptions

before you spend time coding.

A 1-hour design review can save several days of rework.

---

### For your Grafbase POC

A good Day-2 Confluence page would contain:

1. Objective
2. REST APIs involved
3. Federation approach
4. OpenAPI → GraphQL generation
5. Entity design
6. Redis/Valkey caching design
7. Architecture diagram
8. Sequence flow
9. Risks
10. Development plan

After approval, you start implementation.

This is a very common workflow in engineering teams: **Design Review → Approval → Development → Testing → Release**.
