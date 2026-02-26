# ADR-001
# Core Architecture Decision

## Status
Accepted

## Context

We need a production-grade prototype architecture.
Must be simple but scalable.

## Decision

Use:

- Node.js
- TypeScript
- Fastify
- Prisma ORM
- PostgreSQL
- Pino logger
- Docker environment

## Rationale

- Type safety
- Performance
- Clean separation of concerns
- Easy future scalability

## Consequences

- Slightly more setup overhead
- Better long-term structure
