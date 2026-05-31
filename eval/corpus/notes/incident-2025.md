---
title: Incident Post-Mortem 2025-03-14
tags: [incident, postmortem, database]
---

## Timeline
- 14:32 UTC — First alert: p99 database query latency spiked to 4 s.
- 14:38 UTC — On-call engineer paged; identified autovacuum blocked by long-running
  OLAP query held open by a reporting job.
- 14:55 UTC — Reporting query terminated; autovacuum resumed; latency normalized.
- 15:10 UTC — Full recovery confirmed; incident closed.

## Root cause
A nightly reporting job issued a `SELECT … FOR SHARE` that held an exclusive advisory
lock, preventing autovacuum from collecting dead tuples on the orders table. Table bloat
caused sequential scans to exceed buffer cache, cascading to high latency.

## Action items
1. Move reporting queries to the read replica.
2. Add a Grafana alert on table bloat (dead tuple ratio > 20 %).
3. Set `lock_timeout = 5s` on the reporting role to prevent future lockouts.
