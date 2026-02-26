import { State } from "@prisma/client";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { isValidTransition } from "./stateMachine.js";
import { shouldHandoff } from "../rules/handoff.js";

export async function processIncomingMessage(
  conversationId: string,
  providerMessageId: string,
  requestId?: string,
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

    // 1. Transition to CLASSIFYING (if allowed)
    let currentState = initialState;
    if (isValidTransition(currentState, State.CLASSIFYING)) {
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
    if (shouldHandoff(lastMessage.content)) {
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
): Promise<State> {
  const transitionLogger = logger.child({ requestId, conversationId });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { state: to },
  });

  // Persist transition for audit layer
  await prisma.stateTransition.create({
    data: {
      conversationId,
      fromState: from,
      toState: to,
      triggeredBy: providerMessageId,
    },
  });

  transitionLogger.info({
    msg: "State transition",
    eventType: "state_transition",
    providerMessageId,
    state_from: from,
    state_to: to,
  });

  return to;
}
