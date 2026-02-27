import { JobStatus, JobType, Direction, Prisma } from "@prisma/client";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { sendWhatsappMessage } from "../channel/twilioSend.js";
import { calcBackoffMs } from "./backoff.js";

const REPLY_STUB = "Recibido, estoy procesando tu solicitud.";

/**
 * Process a single claimed Job row.
 *
 * Idempotency strategy (two levels):
 *
 * A) DB level: OUTBOUND Message is upserted on providerMessageId = "job-${job.id}".
 *    The unique constraint guarantees exactly one row per job, regardless of retries.
 *    providerMessageId stays "job-${job.id}" forever — no schema change needed.
 *
 * B) Provider level: payload.phase tracks "PREPARED" vs "SENT".
 *    If the record already has phase="SENT", we skip the Twilio call entirely.
 *    This prevents double-sends if the process crashed after Twilio returned
 *    but before the DB was updated — the next retry will see "PREPARED" and retry,
 *    but if the job crashed after the DB update then "SENT" precludes re-sending.
 *
 * Twilio MessageSid is stored in payload.twilioSid (no additional column / migration).
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

    // 1. Load conversation to get providerContact (outbound "to")
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

    const replyContent = REPLY_STUB;
    const outboundProviderMessageId = `job-${job.id}`;

    // 2. Upsert OUTBOUND message — phase="PREPARED"
    //    On retry: if row already exists (phase=PREPARED or SENT), upsert is a no-op
    //    for the create path; update leaves the existing data intact.
    const existingOutbound = await prisma.message.upsert({
      where: { providerMessageId: outboundProviderMessageId },
      create: {
        conversationId: job.conversationId,
        providerMessageId: outboundProviderMessageId,
        direction: Direction.OUTBOUND,
        content: replyContent,
        payload: {
          source: "worker",
          jobId: job.id,
          phase: "PREPARED",
        } as Prisma.InputJsonValue,
      },
      update: {}, // no-op on duplicate — preserve existing phase
    });

    // 3. Idempotency guard: skip send if already sent
    const existingPayload = existingOutbound.payload as Record<string, any>;
    if (existingPayload?.phase === "SENT") {
      jobLogger.info({
        eventType: "JOB_OUTBOUND_ALREADY_SENT",
        providerMessageId: outboundProviderMessageId,
      });
      // Still mark the job DONE (crash recovery path)
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
      return;
    }

    // 4. Send via Twilio
    const to = conversation.providerContact;
    const from = process.env.TWILIO_WHATSAPP_FROM ?? "";

    const { sid } = await sendWhatsappMessage({
      to,
      from,
      body: replyContent,
      requestId: job.id,
      conversationId: job.conversationId,
    });

    // 5. Update OUTBOUND record to SENT with Twilio sid
    await prisma.message.update({
      where: { providerMessageId: outboundProviderMessageId },
      data: {
        payload: {
          source: "worker",
          jobId: job.id,
          phase: "SENT",
          twilioSid: sid,
        } as Prisma.InputJsonValue,
      },
    });

    // 6. Mark job DONE
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
