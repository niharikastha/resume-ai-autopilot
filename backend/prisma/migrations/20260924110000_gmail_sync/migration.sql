-- The tracker's Gmail sync: one encrypted read-only grant per candidate, and the
-- suggestions sync produces. Suggestions are never applied here or by sync - only the
-- candidate's Apply button writes to tracked_applications. See schema.prisma.
--
-- The differ's two `DROP INDEX ..._embedding_hnsw_idx` lines were deleted from this file
-- by hand, as in every migration since the vector indexes were added.

-- CreateEnum
CREATE TYPE "EmailSuggestionStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED');

-- CreateTable
CREATE TABLE "gmail_connections" (
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gmail_connections_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "email_suggestions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gmailMessageId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT,
    "proposedStage" "TrackedStage" NOT NULL,
    "trackedApplicationId" TEXT,
    "evidence" TEXT NOT NULL,
    "status" "EmailSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_suggestions_userId_status_idx" ON "email_suggestions"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "email_suggestions_userId_gmailMessageId_key" ON "email_suggestions"("userId", "gmailMessageId");

-- AddForeignKey
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_suggestions" ADD CONSTRAINT "email_suggestions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_suggestions" ADD CONSTRAINT "email_suggestions_trackedApplicationId_fkey" FOREIGN KEY ("trackedApplicationId") REFERENCES "tracked_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
