-- Access + refresh token pair, self-signup awaiting approval, password resets.
--
-- PURELY ADDITIVE. Nothing is dropped or renamed, so no data is at risk and this
-- is safe to run against a populated database. The two fields whose MEANING
-- narrowed - sessions.tokenHash is now specifically the refresh token, and
-- sessions.expiresAt is now specifically the refresh window - keep their original
-- column names and are remapped in schema.prisma with @map. A tidier column name
-- was not worth a destructive migration.
--
-- Prisma generated this with two bare `ADD COLUMN ... NOT NULL` steps, which
-- cannot run against the existing rows. Both are rewritten below as
-- add-nullable / backfill / enforce.

-- AlterTable: sessions ------------------------------------------------------
ALTER TABLE "sessions"
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "familyId"          TEXT,
  ADD COLUMN "revokedAt"         TIMESTAMP(3),
  ADD COLUMN "revokedReason"     TEXT,
  ADD COLUMN "rotatedAt"         TIMESTAMP(3);

-- Backfill. Every pre-existing session becomes its own single-member family: they
-- were issued before rotation existed, so none of them is a rotation of another,
-- and giving them a shared family id would make one stale cookie able to revoke
-- all of them.
UPDATE "sessions"
   SET "familyId" = gen_random_uuid()::text
 WHERE "familyId" IS NULL;

-- The old single-cookie session had exactly one expiry, which is also the most
-- generous honest reading of its absolute ceiling. These sessions cannot refresh
-- anyway - no client holds a refresh cookie for them - so they simply run out.
UPDATE "sessions"
   SET "absoluteExpiresAt" = "expiresAt"
 WHERE "absoluteExpiresAt" IS NULL;

ALTER TABLE "sessions"
  ALTER COLUMN "familyId"          SET NOT NULL,
  ALTER COLUMN "absoluteExpiresAt" SET NOT NULL;

-- AlterTable: users --------------------------------------------------------
-- Nullable, so every EXISTING account reads as "never went through approval",
-- which is true: they were created by CLI, which bypasses the queue entirely.
-- Their `active` flag is untouched, so nobody is locked out by this migration.
ALTER TABLE "users"
  ADD COLUMN "approvedAt"   TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT;

-- CreateTable -------------------------------------------------------------
CREATE TABLE "access_tokens" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex -------------------------------------------------------------
CREATE UNIQUE INDEX "access_tokens_tokenHash_key" ON "access_tokens"("tokenHash");
CREATE INDEX "access_tokens_sessionId_idx" ON "access_tokens"("sessionId");
CREATE INDEX "access_tokens_expiresAt_idx" ON "access_tokens"("expiresAt");

CREATE UNIQUE INDEX "password_resets_tokenHash_key" ON "password_resets"("tokenHash");
CREATE INDEX "password_resets_userId_idx" ON "password_resets"("userId");
CREATE INDEX "password_resets_expiresAt_idx" ON "password_resets"("expiresAt");

CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");
CREATE INDEX "users_active_approvedAt_idx" ON "users"("active", "approvedAt");

-- AddForeignKey -----------------------------------------------------------
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
