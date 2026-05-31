---
title: System Architecture
tags: [architecture, design, services]
---

## Overview
The platform uses a layered service mesh: an API gateway fronts all public traffic,
routing to domain microservices that own their own databases (PostgreSQL for OLTP,
Redis for ephemeral state, S3 for blobs).

## Event bus
All cross-service side-effects flow through a Kafka topic per domain aggregate.
Consumers are idempotent; they write a processed-event ID to a deduplication table
before applying state changes so replay is safe.

## Data model
Each tenant is row-level isolated using a `tenant_id` discriminator on every table.
Foreign keys cascade deletes within a tenant; cross-tenant references are forbidden
at the application layer and enforced by a linting rule in CI.

## Scaling
Stateless API pods autoscale on CPU + RPS via KEDA. The search service scales on
queue depth. Database read replicas handle the analytics queries.
