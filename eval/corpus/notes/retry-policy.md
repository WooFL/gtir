---
title: Retry & Backoff Policy
tags: [reliability, http]
---

## When to retry
We retry only idempotent outbound calls, and only on transient failures —
network timeouts and 429/502/503/504 gateway responses. A 4xx other than 429 is
a client error and is never retried.

## How long to keep trying
Attempts use exponential backoff with full jitter, capped at four attempts. Past
that we give up and surface the error to the caller rather than queueing
indefinitely — a failing dependency should shed load, not amplify it.

## Why jitter
Synchronised retries from many clients create a thundering herd that keeps a
recovering service down. Jitter spreads the retries out so the dependency can
recover.
