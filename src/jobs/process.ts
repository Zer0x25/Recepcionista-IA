import { JobStatus, JobType, Direction } from "@prisma/client";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { callAI } from "../ai_adapter/adapter.js";
import { calcBackoffMs } from "./backoff.js";

const AI_TIMEOUT_MS = 1500;

/**
 * Process a single claimed Job row.
 *
 * Idempotency: OUTBOUND Message is upserted on providerMessageId = "job-${job.id}".
 * The unique DB constraint ensures no duplicate is created even if this function
 * runs twice for the same job (e.g. after a crash between message create and job update).
 */
export async function processJob(job: any): Promise<void> {
  const startTime = Date.now();
  const jobLogger = logger.child({
    jobId: job.id,
    type: job.type,
    conversationId: job.conversationId,
  });

  jobLogger.info({ eventType: "JOB_PROCESS_STARTED" });

  try {
    if (job.type !== JobType.AI_REPLY_REQUESTED) {
      throw new Error(`Unsupported job type: ${job.type}`);
    }

    // 1. Load conversation context (last inbound message)
    const conversation = await prisma.conversation.findUnique({
      where: { id: job.conversationId },
      include: {
        messages: {
          where: { direction: Direction.INBOUND },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!conversation) {
      throw new Error(`Conversation not found: ${job.conversationId}`);
    }

    const lastInbound = conversation.messages[0];
    if (!lastInbound) {
      throw new Error(
        `No inbound message found for conversation: ${job.conversationId}`,
      );
    }

    // 2. Call AI with timeout
    const aiResponse = await callAIWithTimeout(
      {
        requestId: job.id,
        conversationId: job.conversationId,
        text: lastInbound.content,
      },
      AI_TIMEOUT_MS,
    );

    if (!aiResponse.success) {
      throw new Error(aiResponse.error ?? "AI call returned failure");
    }

    // 3. Persist OUTBOUND message (upsert for idempotency)
    const outboundProviderMessageId = `job-${job.id}`;
    await prisma.message.upsert({
      where: { providerMessageId: outboundProviderMessageId },
      create: {
        conversationId: job.conversationId,
        providerMessageId: outboundProviderMessageId,
        direction: Direction.OUTBOUND,
        content: aiResponse.content,
        payload: {
          source: "worker",
          jobId: job.id,
          tokensUsed: aiResponse.tokensUsed,
        },
      },
      update: {}, // no-op on duplicate — already persisted
    });

    // 4. Mark job DONE
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.DONE,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });

    const durationMs = Date.now() - startTime;
    jobLogger.info({ eventType: "JOB_PROCESS_SUCCEEDED", durationMs });
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    const attemptsNext = (job.attempts ?? 0) + 1;

    if (attemptsNext >= (job.maxAttempts ?? 5)) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.FAILED,
          attempts: attemptsNext,
          lockedAt: null,
          lockedBy: null,
          lastError: errorMsg,
        },
      });

      jobLogger.error({
        eventType: "JOB_PROCESS_FAILED",
        durationMs,
        attempts: attemptsNext,
        nextRunAt: null,
        error: errorMsg,
      });
    } else {
      const nextRunAt = new Date(Date.now() + calcBackoffMs(attemptsNext));

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.PENDING,
          attempts: attemptsNext,
          nextRunAt,
          lockedAt: null,
          lockedBy: null,
          lastError: errorMsg,
        },
      });

      jobLogger.warn({
        eventType: "JOB_PROCESS_FAILED",
        durationMs,
        attempts: attemptsNext,
        nextRunAt: nextRunAt.toISOString(),
        error: errorMsg,
      });
    }
  }
}

/** Wraps callAI() with an AbortController-based timeout. */
async function callAIWithTimeout(
  input: { requestId: string; conversationId: string; text: string },
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const aiPromise = callAI(input);
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () =>
        reject(new Error(`AI call timed out after ${timeoutMs}ms`)),
      );
    });
    return await Promise.race([aiPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
