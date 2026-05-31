---
title: Caching Strategy
tags: [performance, cache]
---

## Choosing an eviction policy
Use **LRU** when recent access predicts future access — request-scoped data and
session lookups. Use **LFU** when a small hot set is queried far more often than
the long tail and you want to keep the hot set resident regardless of recency.
Use **TTL** when entries go stale on a clock rather than on access — feature
flags and short-lived tokens.

## Sizing
Cache capacity is a memory-versus-hit-rate trade. Measure the hit rate at a few
capacities and pick the knee of the curve; past it, each extra megabyte buys
very little.
