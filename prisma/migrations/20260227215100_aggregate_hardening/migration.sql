-- DropIndex
DROP INDEX "JobMetricAggregate_windowStart_idx";

-- DropIndex
DROP INDEX "JobMetricAggregate_status_idx";

-- AlterTable
ALTER TABLE "JobMetricAggregate" ADD COLUMN "avgProcessingLatencyMs" INTEGER;

-- CreateIndex
CREATE INDEX "Job_updatedAt_idx" ON "Job"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobMetricAggregate_windowStart_status_key" ON "JobMetricAggregate"("windowStart", "status");
