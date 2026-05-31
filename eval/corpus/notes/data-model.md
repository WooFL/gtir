---
title: Data Model Reference
tags: [database, schema, postgres]
---

## Users table
`users(id uuid PK, email text UNIQUE NOT NULL, created_at timestamptz, tenant_id uuid FK)`.
Emails are stored in lowercase; a partial unique index enforces uniqueness per tenant.

## Sessions table
`sessions(id uuid PK, user_id uuid FK, token_hash text NOT NULL, expires_at timestamptz, revoked bool)`.
Token is stored as a SHA-256 hash — never the raw value. The query path uses `WHERE token_hash = $1
AND expires_at > NOW() AND NOT revoked`.

## Events table
Append-only event log: `events(id bigserial, stream_id uuid, position int, type text, payload jsonb,
created_at timestamptz)`. The `(stream_id, position)` pair is unique, enforcing per-stream
ordering. Consumers track their own offset in `consumer_offsets(consumer_id, stream_id, position)`.
