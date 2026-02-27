# ADR-006
# AI Integration Strategy (Outbox Pattern)

## Status
Accepted

## Context

We need to integrate AI into the system without violating:

- ADR-002 State Machine
- ADR-003 AI Responsibility Boundary
- ADR-004 Webhook Idempotency
- ADR-005 Observability

AI calls introduce:
- Variable latency
- External dependency risk
- Timeout unpredictability
- Potential coupling to webhook lifecycle

Webhook stability and determinism must not depend on AI SLA.

---

## Decision

AI execution will be decoupled from the webhook request lifecycle.

We adopt an Outbox Pattern using PostgreSQL as the initial job mechanism.

AI will never execute inside the webhook HTTP request.

---

## Execution Model

### Webhook Flow

1. Validate request (Zod)
2. Verify signature
3. Enforce rate limiting
4. Enforce idempotency
5. Persist inbound message
6. Execute deterministic state transition
7. Persist Job record: `AI_REPLY_REQUESTED`
8. Return HTTP 200 immediately

Webhook MUST remain fast and deterministic.

---

### Job Processing Flow

Worker process:

1. Claim pending jobs (`status = PENDING`)
2. Lock job (avoid double execution)
3. Execute AI call with:
   - Explicit timeout
   - Token budget
4. Validate AI output with schema
5. Orchestrator evaluates AI suggestion
6. Persist outbound message
7. Send outbound via provider API
8. Mark job as DONE

If AI fails:
- Mark job FAILED
- Retry using deterministic retry policy

---

## Data Model Additions

New table: `Job`

Fields:

- id
- type (enum)
- conversationId
- payload (JSON)
- status (PENDING | PROCESSING | DONE | FAILED)
- attempts
- nextRunAt
- lockedAt
- lockedBy
- createdAt
- updatedAt

All job state transitions must be logged.

---

## AI Authority Constraints

AI:

CAN:
- Suggest intent
- Generate reply drafts
- Summarize context

CANNOT:
- Change conversation state
- Write directly to database
- Trigger HANDOFF directly
- Perform business decisions

All AI output must be validated before use.

---

## Observability Requirements

New event types:

- AI_JOB_STARTED
- AI_JOB_SUCCEEDED
- AI_JOB_FAILED
- AI_JOB_RETRY_SCHEDULED

All must include:
- conversationId
- jobId
- durationMs
- tokenUsage (if available)

No raw AI payload logging in production.

---

## Idempotency

Outbound messages must be idempotent.

Duplicate job execution must not create duplicate outbound messages.

Use unique constraints where applicable.

---

## Retry Policy

- MaxAttempts defined explicitly
- Exponential backoff
- Deterministic scheduling via `nextRunAt`
- Failed jobs must remain auditable

---

## Consequences

Pros:
- Webhook SLA independent from AI SLA
- Improved scalability
- Clear separation of concerns
- Deterministic orchestration preserved

Cons:
- Additional complexity
- Requires worker lifecycle management
- Requires monitoring of job backlog

---

## Future Evolution

If throughput increases:

- Replace PostgreSQL outbox with dedicated queue (e.g., Redis/BullMQ)
- Maintain same contract
- Introduce new ADR before migration

---

## Non-Goals

- Distributed task orchestration
- Event streaming architecture
- Microservices split

This remains a monolithic backend with internal job processing.

---

## Compliance Rule

If AI execution is ever placed inside webhook request lifecycle,
this ADR is violated and execution must be blocked.
