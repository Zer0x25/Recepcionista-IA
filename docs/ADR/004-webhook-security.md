# ADR-004

# Webhook Security and Idempotency

## Status

Accepted

## Requirements

- Verify Twilio signature
- Enforce rate limiting
- Validate schema using Zod
- Prevent duplicate processing

## Idempotency Rule

Each incoming message must have a unique provider ID.

If already processed:
→ Return 200 OK without reprocessing.

## Logging

All rejected requests must be logged.
