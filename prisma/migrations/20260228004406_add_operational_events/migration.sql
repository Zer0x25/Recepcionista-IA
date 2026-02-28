-- CreateEnum
CREATE TYPE "OperationalEventType" AS ENUM ('CLAIM_COLLISION', 'CAS_COLLISION', 'TTL_EXPIRED', 'SEND_SUCCESS', 'SEND_FAIL');

-- CreateTable
CREATE TABLE "OperationalEvent" (
    "id" TEXT NOT NULL,
    "type" "OperationalEventType" NOT NULL,
    "jobId" TEXT,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationalEvent_type_createdAt_idx" ON "OperationalEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalEvent_jobId_idx" ON "OperationalEvent"("jobId");
