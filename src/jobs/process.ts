import {
  JobStatus,
  JobType,
  Direction,
  Prisma,
  OperationalEventType,
} from "@prisma/client";
import { prisma } from "../persistence/prisma.js";
import { logger } from "../observability/logger.js";
import { sendWhatsappMessage } from "../channel/twilioSend.js";
import { calcBackoffMs } from "./backoff.js";
import { SENDING_COLLISION_BACKOFF_MS, SENDING_TTL_MS } from "./constants.js";
import { recordOperationalEvent } from "../metrics/events.repository.js";

const REPLY_STUB = "Recibido, estoy procesando tu solicitud.";

/**
 * Process a single claimed Job row.
 *
 * Idempotency strategy — three levels:
 *
 * A) DB unique constraint: OUTBOUND Message is upserted on
 *    providerMessageId = "job-${job.id}". Exactly one row per job, always.
 *
 * B) CAS lock (PREPARED → SENDING): before calling Twilio, we do an atomic
 *    updateMany WHERE phase='PREPARED'. Only one worker can flip this;
 *    the loser sees count=0 and yields (requeues with 2s backoff without
 *    incrementing attempts).
 *
 * C) Post-send mark: after Twilio succeeds → phase='SENT' + twilioSid.
 *    If we crash after Twilio but before the DB write, the next retry
 *    will see phase='SENDING'. Since SENDING has no count=1 winner, it
 *    requeues again, and eventually a phase-revert on failure (or a
 *    SENDING-TTL cleanup in a future step) brings it back to PREPARED.
 *    For now: a crash between Twilio-success and SENT-write means the
 *    next attempt sees SENDING → yields to no-one → perpetual 2s requeue.
 *    Acceptable for Step 4.1; Step 4.2 will add SENDING TTL expiry.
 *
 * Phase field: stored inside Message.payload JSON (no schema change).
 * Twilio sid: stored in payload.twilioSid.
 */
export async function processJob(job: any): Promise<void> {
  const startTime = Date.now();
  const jobLogger = logger.child({
    jobId: job.id,
    type: job.type,
    conversationId: job.conversationId,
    workerId: job.lockedBy ?? "unknown",
  });

  jobLogger.info({ eventType: "JOB_PROCESS_STARTED" });

  try {
    if (job.type !== JobType.AI_REPLY_REQUESTED) {
      throw new Error(`Unsupported job type: ${job.type}`);
    }

    // ── 1. Load conversation ─────────────────────────────────────────────
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

    // ── 2. Upsert OUTBOUND as PREPARED (idempotent row creation) ─────────
    // Under true concurrency two workers may race the INSERT path of the upsert.
    // Postgres will reject the second one with a unique-constraint error (P2002).
    // That's fine — the row already exists, and the CAS in step 3 will gate sends.
    try {
      await prisma.message.upsert({
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
        update: {}, // no-op — preserve whatever phase is already there
      });
    } catch (upsertErr: any) {
      if (upsertErr?.code !== "P2002") throw upsertErr;
      // P2002: row already exists from a concurrent worker — safe to continue
      jobLogger.info({
        eventType: "JOB_OUTBOUND_UPSERT_RACE",
        providerMessageId: outboundProviderMessageId,
      });
    }

    // ── 3. CAS: PREPARED → SENDING ───────────────────────────────────────
    //
    // updateMany matches only if phase is still "PREPARED".
    // Postgres evaluates this atomically; exactly one concurrent caller wins.
    // count==0 means someone else already flipped (or it's already SENT).
    const casResult = await prisma.message.updateMany({
      where: {
        providerMessageId: outboundProviderMessageId,
        payload: {
          path: ["phase"],
          equals: "PREPARED",
        },
      },
      data: {
        payload: {
          source: "worker",
          jobId: job.id,
          phase: "SENDING",
          sendingLockedAt: new Date().toISOString(),
          sendingLockedBy: job.lockedBy ?? "unknown",
        } as Prisma.InputJsonValue,
      },
    });

    if (casResult.count === 0) {
      // Lost the CAS race — read current phase to decide what to do
      const current = await prisma.message.findUnique({
        where: { providerMessageId: outboundProviderMessageId },
        select: { payload: true },
      });
      const currentPhase = (current?.payload as Record<string, any>)?.phase;

      if (currentPhase === "SENT") {
        // Another worker already completed the send → mark DONE and exit
        jobLogger.info({
          eventType: "JOB_OUTBOUND_ALREADY_SENT",
          providerMessageId: outboundProviderMessageId,
        });
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: JobStatus.DONE,
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });

        await recordOperationalEvent({
          type: OperationalEventType.SEND_SUCCESS,
          jobId: job.id,
          conversationId: job.conversationId,
        });

        const durationMs = Date.now() - startTime;
        jobLogger.info({ eventType: "JOB_PROCESS_SUCCEEDED", durationMs });
        return;
      }

      if (currentPhase === "SENDING") {
        // Another worker is mid-send. Check if it's stuck via TTL.
        const payload = current?.payload as Record<string, any>;
        const lockedAtStr = payload?.sendingLockedAt;
        const lockedAt = lockedAtStr ? Date.parse(lockedAtStr) : NaN;
        const now = Date.now();
        const ageMs = now - lockedAt;

        if (isNaN(lockedAt) || ageMs > SENDING_TTL_MS) {
          // Stuck or invalid lock -> revert to PREPARED so we can retry safely.
          await prisma.message.update({
            where: { providerMessageId: outboundProviderMessageId },
            data: {
              payload: {
                ...payload,
                phase: "PREPARED",
                lastSendError: "SENDING_TTL_EXPIRED",
                ttlExpiredAt: new Date(now).toISOString(),
                previousSendingLockedAt: lockedAtStr,
                previousSendingLockedBy: payload?.sendingLockedBy,
                sendingLockedAt: undefined,
                sendingLockedBy: undefined,
              } as Prisma.InputJsonValue,
            },
          });

          await recordOperationalEvent({
            type: OperationalEventType.TTL_EXPIRED,
            jobId: job.id,
            conversationId: job.conversationId,
          });

          // Requeue job with normal backoff (no attempts++ because it's a crash recovery).
          // Using current attempts to calculate backoff.
          const nextRunAt = new Date(now + calcBackoffMs(job.attempts ?? 0));
          await prisma.job.update({
            where: { id: job.id },
            data: {
              status: JobStatus.PENDING,
              nextRunAt,
              lockedAt: null,
              lockedBy: null,
            },
          });

          jobLogger.warn({
            eventType: "JOB_SENDING_TTL_EXPIRED",
            ageMs: isNaN(ageMs) ? null : ageMs,
            sendingLockedAt: lockedAtStr,
            nextRunAt: nextRunAt.toISOString(),
          });
          return;
        }

        // Lock is fresh -> yield with short backoff.
        // Do NOT increment attempts — this is a concurrency yield, not a failure.
        const nextRunAt = new Date(now + SENDING_COLLISION_BACKOFF_MS);
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: JobStatus.PENDING,
            nextRunAt,
            lockedAt: null,
            lockedBy: null,
          },
        });
        const durationMs = now - startTime;
        jobLogger.warn({
          currentPhase,
          nextRunAt: nextRunAt.toISOString(),
        });

        await recordOperationalEvent({
          type: OperationalEventType.CAS_COLLISION,
          jobId: job.id,
          conversationId: job.conversationId,
        });

        return;
      }

      // Unexpected phase value — surface as an error so the job retries
      throw new Error(
        `Unexpected outbound phase after CAS miss: ${currentPhase ?? "null"}`,
      );
    }

    // ── 4. Send via Twilio ───────────────────────────────────────────────
    const to = conversation.providerContact;
    const from = process.env.TWILIO_WHATSAPP_FROM ?? "";

    let sid: string;
    try {
      const result = await sendWhatsappMessage({
        to,
        from,
        body: replyContent,
        requestId: job.id,
        conversationId: job.conversationId,
      });
      sid = result.sid;
    } catch (sendError: any) {
      // Twilio failed — revert to PREPARED so the next retry can re-attempt.
      const errMsg =
        sendError instanceof Error ? sendError.message : String(sendError);
      await prisma.message.update({
        where: { providerMessageId: outboundProviderMessageId },
        data: {
          payload: {
            source: "worker",
            jobId: job.id,
            phase: "PREPARED",
            lastSendError: errMsg,
          } as Prisma.InputJsonValue,
        },
      });
      // Re-throw so the outer catch schedules the job retry
      throw sendError;
    }

    // ── 5. Mark SENT with Twilio sid ─────────────────────────────────────
    await prisma.message.update({
      where: { providerMessageId: outboundProviderMessageId },
      data: {
        payload: {
          source: "worker",
          jobId: job.id,
          phase: "SENT",
          twilioSid: sid,
          sentAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });

    // ── 6. Mark job DONE ─────────────────────────────────────────────────
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: JobStatus.DONE,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });

    recordOperationalEvent({
      type: OperationalEventType.SEND_SUCCESS,
      jobId: job.id,
      conversationId: job.conversationId,
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
        error: errorMsg,
      });

      await recordOperationalEvent({
        type: OperationalEventType.SEND_FAIL,
        jobId: job.id,
        conversationId: job.conversationId,
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
