# RECEPCIONISTA IA WHATSAPP

# SYSTEM ARCHITECTURE

# Version 0.1 (Prototype)

## 1. PURPOSE

Build a backend-centric WhatsApp AI receptionist prototype.
Architecture-first.
Model is non-authoritative.
Backend is source of truth.

---

## 2. CORE PRINCIPLES

1. Backend decides truth.
2. AI never performs business decisions.
3. All external input must be validated.
4. All conversations are persisted.
5. Idempotency required for webhooks.
6. Observability from day one.
7. No generic states.

---

## 3. HIGH LEVEL ARCHITECTURE

WhatsApp (Twilio)
↓
Webhook (channel)
↓
Validation Layer
↓
Persistence (DB)
↓
Orchestrator (State Machine)
↓
Rules Engine (Deterministic)
↓
AI Adapter (Optional)
↓
Response Builder
↓
Persist Outgoing
↓
Reply to Channel

---

## 4. MODULE STRUCTURE

src/
├─ channel/ # Webhooks, signature verification
├─ orchestrator/ # State machine per conversation
├─ rules/ # Deterministic business logic
├─ ai_adapter/ # OpenAI wrapper
├─ persistence/ # Prisma models and DB logic
├─ observability/ # Logging and metrics
└─ server.ts # Bootstrapping only

---

## 5. DATABASE ENTITIES (INITIAL)

- Conversation
- Message
- Customer
- HandoffTicket

All writes must be traceable.

---

## 6. NON-GOALS (MVP)

- CRM
- Multi-tenant
- Advanced automation
- Payment flows
