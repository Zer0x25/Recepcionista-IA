# ADR-002

# Conversation State Machine

## Status

Accepted

## Context

Conversations require deterministic progression.

Generic state fields are forbidden.

## Decision

Conversation states must be explicit and finite.

Example initial states:

- NEW
- CLASSIFYING
- ANSWERING
- WAITING_USER
- HANDOFF
- CLOSED

State transitions must be defined inside orchestrator.

## Rules

- No dynamic state names
- No string-based magic transitions
- All transitions logged
