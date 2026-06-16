In GraphQL, **`__typename + id`** is a common pattern used to uniquely identify an object (often called an "entity") across the entire GraphQL schema.

### What is `__typename`?

`__typename` is a built-in GraphQL field that returns the type name of an object.

Example:

```graphql
query {
  user(id: "123") {
    __typename
    id
    name
  }
}
```

Response:

```json
{
  "data": {
    "user": {
      "__typename": "User",
      "id": "123",
      "name": "Alice"
    }
  }
}
```

### Why combine `__typename` and `id`?

An `id` alone may not be globally unique.

For example:

```json
{
  "__typename": "User",
  "id": "123"
}
```

and

```json
{
  "__typename": "Product",
  "id": "123"
}
```

Both have the same `id`, but they represent different entities.

By combining them:

```text
User:123
Product:123
```

you get a globally unique key.

### Common Use Case: Client Caching

GraphQL clients such as Apollo Client and Relay normalize data in a cache using:

```text
<__typename>:<id>
```

Example cache:

```json
{
  "User:123": {
    "id": "123",
    "name": "Alice"
  },
  "Product:123": {
    "id": "123",
    "title": "Laptop"
  }
}
```

This lets the client:

* Avoid duplicate copies of the same object
* Automatically update all references to an object
* Efficiently merge query results

### Example

Suppose a query returns:

```json
{
  "post": {
    "__typename": "Post",
    "id": "42",
    "title": "Hello"
  },
  "author": {
    "__typename": "User",
    "id": "42",
    "name": "Bob"
  }
}
```

A normalized cache might store:

```text
Post:42
User:42
```

even though both have `id = 42`.

### When people say "GraphQL entities by their `__typename + id`"

They usually mean:

> Treat every GraphQL object as uniquely identified by the pair (`__typename`, `id`).

This is the standard approach used by most GraphQL caching and federation systems to represent and look up entities.
