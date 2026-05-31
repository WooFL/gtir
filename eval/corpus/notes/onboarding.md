---
title: Developer Onboarding Guide
tags: [onboarding, setup, development]
---

## Prerequisites
Install Node 20+, Docker Desktop, and the AWS CLI. Request access to the `dev` AWS
account via the IT portal — approval usually takes one business day.

## Local development setup
Clone the monorepo and run `npm install` at the root. Start the stack with
`docker compose up -d`; this spins up PostgreSQL, Redis, and the LocalStack S3 emulator.

## Running tests
`npm test` runs unit tests. `npm run test:integration` requires the Docker stack
to be up. Keep the test database separate from local development data — the test
runner wipes and re-seeds it on every run.

## Code review
All PRs need at least one approval from a member of the `@platform` team. Link the
Jira ticket in the PR description. Squash-merge only; no merge commits on main.
