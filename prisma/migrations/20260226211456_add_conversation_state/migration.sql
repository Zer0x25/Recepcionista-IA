-- CreateEnum
CREATE TYPE "State" AS ENUM ('NEW', 'CLASSIFYING', 'ANSWERING', 'WAITING_USER', 'HANDOFF', 'CLOSED');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "state" "State" NOT NULL DEFAULT 'NEW';
