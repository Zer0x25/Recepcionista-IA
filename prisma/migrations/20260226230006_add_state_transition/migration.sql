-- CreateTable
CREATE TABLE "StateTransition" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "fromState" "State" NOT NULL,
    "toState" "State" NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StateTransition_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "StateTransition" ADD CONSTRAINT "StateTransition_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
