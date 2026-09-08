-- CreateEnum
CREATE TYPE "MatchDecision" AS ENUM ('UNDECIDED', 'WANTED', 'NOT_WANTED');

-- The differ's two `DROP INDEX ... _embedding_hnsw_idx` lines were deleted from
-- this file by hand, as schema.prisma's header note requires: those indexes are
-- on Unsupported("vector(384)") columns, so Prisma cannot see them and reports
-- them as indexes that exist in the database and are declared nowhere. Applying
-- the drop would silently turn semantic search into a sequential scan.

-- AlterTable
ALTER TABLE "match_scores" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decision" "MatchDecision" NOT NULL DEFAULT 'UNDECIDED';

-- CreateTable
CREATE TABLE "daily_digests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "payload" JSONB NOT NULL,
    "emailedAt" TIMESTAMP(3),
    "telegramAt" TIMESTAMP(3),
    "deliveryError" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "daily_digests_userId_day_idx" ON "daily_digests"("userId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "daily_digests_userId_day_key" ON "daily_digests"("userId", "day");

-- CreateIndex
CREATE INDEX "match_scores_userId_decision_idx" ON "match_scores"("userId", "decision");

-- AddForeignKey
ALTER TABLE "daily_digests" ADD CONSTRAINT "daily_digests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
