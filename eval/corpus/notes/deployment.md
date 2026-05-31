---
title: Deployment Runbook
tags: [ops, deploy]
---

## Rolling restart
Drain one node at a time; wait for health checks to go green before the next.

## Rollback
Re-point the alias to the previous image tag and restart. Database migrations are
forward-only, so a rollback must be paired with a compensating migration.

## Smoke tests
After every deploy, hit `/healthz` and `/readyz` on each replica before removing
the canary flag. Alert if p99 latency exceeds 200 ms in the first 5 minutes.
