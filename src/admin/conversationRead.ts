import { prisma } from "../persistence/prisma.js";

/**
 * Gets a complete snapshot of a conversation by its ID.
 * Includes the conversation details, the last N messages, and all state transitions.
 */
export async function getConversationSnapshotById(
  id: string,
  limitMessages: number = 50,
) {
  return await prisma.conversation.findUnique({
    where: { id },
    include: {
      messages: {
        take: limitMessages,
        orderBy: { createdAt: "desc" },
      },
      transitions: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

/**
 * Gets a complete snapshot of a conversation by the provider contact (e.g., phone number).
 */
export async function getConversationSnapshotByContact(
  providerContact: string,
  limitMessages: number = 50,
) {
  return await prisma.conversation.findUnique({
    where: { providerContact },
    include: {
      messages: {
        take: limitMessages,
        orderBy: { createdAt: "desc" },
      },
      transitions: {
        orderBy: { createdAt: "asc" },
      },
    },
  });
}
