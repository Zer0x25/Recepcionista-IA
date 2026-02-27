import { State, JobType } from "@prisma/client";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { isValidTransition } from "./stateMachine.js";
import { shouldHandoff } from "../rules/handoff.js";

export async function processIncomingMessage(
  conversationId: string,
  providerMessageId: string,
  requestId?: string,
  inboundMessageData?: { content: string; payload: any },
) {
  const startTime = Date.now();
  const orchestratorLogger = logger.child({ requestId, conversationId });

  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const lastMessage = conversation.messages[0];
    const initialState = conversation.state;

    orchestratorLogger.info({
      msg: "Processing message in orchestrator",
      providerMessageId,
      currentState: initialState,
    });

    let currentState = initialState;
    let lastMessageContent = conversation.messages[0]?.content;

    // 1. Persist message + Transition to CLASSIFYING + Enqueue Job (Atomic)
    if (inboundMessageData) {
      lastMessageContent = inboundMessageData.content;
      const canTransition = isValidTransition(currentState, State.CLASSIFYING);
      const targetState = canTransition ? State.CLASSIFYING : currentState;
      const jobIdempotencyKey = `ai-reply:${conversationId}:${providerMessageId}`;

      await prisma.$transaction(async (tx) => {
        await tx.message.create({
          data: {
            conversationId,
            providerMessageId,
            direction: "INBOUND",
            content: inboundMessageData.content,
            payload: inboundMessageData.payload,
          },
        });

        if (canTransition) {
          await tx.conversation.update({
            where: { id: conversationId },
            data: { state: targetState },
          });
          await tx.stateTransition.create({
            data: {
              conversationId,
              fromState: currentState,
              toState: targetState,
              triggeredBy: providerMessageId,
            },
          });
        }

        // Enqueue AI reply job — skipDuplicates handles idempotent re-delivery
        await tx.job.createMany({
          data: [
            {
              type: JobType.AI_REPLY_REQUESTED,
              conversationId,
              payload: { providerMessageId, reason: "inbound_received" },
              idempotencyKey: jobIdempotencyKey,
            },
          ],
          skipDuplicates: true,
        });
      });

      if (canTransition) {
        orchestratorLogger.info({
          msg: "State transition",
          eventType: "STATE_TRANSITION",
          providerMessageId,
          fromState: currentState,
          toState: targetState,
          reason: "Initial classification",
        });
        currentState = targetState;
      }
    } else if (isValidTransition(currentState, State.CLASSIFYING)) {
      currentState = await transitionState(
        conversationId,
        currentState,
        State.CLASSIFYING,
        providerMessageId,
        requestId,
      );
    }

    // 2. Decision Logic (Stub)
    let nextState: State;
    if (lastMessageContent && shouldHandoff(lastMessageContent)) {
      orchestratorLogger.info({
        msg: "Handoff triggered by content",
        eventType: "HANDOFF_TRIGGERED",
      });
      nextState = State.HANDOFF;
    } else {
      // In a real scenario, this would involve more complex logic or AI
      // For now, we follow the NEW -> CLASSIFYING -> ANSWERING -> WAITING_USER path
      nextState = State.ANSWERING;
    }

    // 3. Apply Decision
    if (isValidTransition(currentState, nextState)) {
      currentState = await transitionState(
        conversationId,
        currentState,
        nextState,
        providerMessageId,
        requestId,
        nextState === State.HANDOFF
          ? "Handoff triggered by content"
          : undefined,
      );
    }

    // 4. If ANSWERING, move to WAITING_USER
    if (
      currentState === State.ANSWERING &&
      isValidTransition(State.ANSWERING, State.WAITING_USER)
    ) {
      currentState = await transitionState(
        conversationId,
        currentState,
        State.WAITING_USER,
        providerMessageId,
        requestId,
      );
    }

    orchestratorLogger.info({
      msg: "Orchestrator processing complete",
      finalState: currentState,
      durationMs: Date.now() - startTime,
    });

    return currentState;
  } catch (error) {
    orchestratorLogger.error({
      msg: "Orchestrator error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function transitionState(
  conversationId: string,
  from: State,
  to: State,
  providerMessageId: string,
  requestId?: string,
  reason?: string,
): Promise<State> {
  const transitionLogger = logger.child({ requestId, conversationId });

  if (from === to) {
    transitionLogger.info({
      msg: "State transition skipped (no-op)",
      eventType: "STATE_TRANSITION_SKIPPED",
      providerMessageId,
      state: to,
    });
    return to;
  }

  await prisma.$transaction([
    prisma.conversation.update({
      where: { id: conversationId },
      data: { state: to },
    }),
    prisma.stateTransition.create({
      data: {
        conversationId,
        fromState: from,
        toState: to,
        triggeredBy: providerMessageId,
      },
    }),
  ]);

  transitionLogger.info({
    msg: "State transition",
    eventType: "STATE_TRANSITION",
    providerMessageId,
    fromState: from,
    toState: to,
    reason,
  });

  return to;
}
