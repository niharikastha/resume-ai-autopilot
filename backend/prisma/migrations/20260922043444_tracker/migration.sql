-- The hand-kept tracker: applications you made yourself, and the people who might
-- refer you. See TrackedApplication and TrackedContact in schema.prisma for why these
-- are two new tables rather than nullable columns on `applications`.
--
-- The differ's two `DROP INDEX ..._embedding_hnsw_idx` lines were deleted from this file
-- by hand, as in every migration since the vector indexes were added. Prisma's schema
-- language cannot express an HNSW index, so `Unsupported("vector")` reads as "no index
-- here" and every diff proposes dropping them again. Applying that would silently turn
-- stage 2 into a sequential scan over every embedding.
--
-- NO BACKFILL, and here that is not even a judgement call: there is no existing row
-- anywhere from which a hand-typed log could be derived. `applications` rows are the
-- machine's, and copying them in would put entries in this list that the candidate never
-- wrote - which is the one thing a personal log must never contain.
--
-- TWO CHECKS DO WORK THAT A SERVICE CANNOT DO ALONE:
--
--   1. `referrer_without_referral_check`. A row naming who referred you while also saying
--      no referral was given is a contradiction, not a partial record, and it is the kind
--      that appears when a form clears one field and not the other. The reverse - a
--      referral with no name - is allowed on purpose: you can know it happened and not
--      remember through whom.
--   2. The nonempty checks. `company` and `name` are the fields every read displays and
--      every other field hangs off; a row that is blank there is invisible in a list and
--      cannot be corrected through the UI that fails to show it.

-- CreateEnum
CREATE TYPE "TrackedStage" AS ENUM ('SAVED', 'APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'GHOSTED');

-- CreateTable
CREATE TABLE "tracked_contacts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "role" TEXT,
    "linkedInUrl" TEXT,
    "email" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracked_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT,
    "jobUrl" TEXT,
    "careersUrl" TEXT,
    "stage" "TrackedStage" NOT NULL DEFAULT 'APPLIED',
    "appliedOn" DATE,
    "linkedInInviteSent" BOOLEAN NOT NULL DEFAULT false,
    "referralGiven" BOOLEAN NOT NULL DEFAULT false,
    "referrerId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracked_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tracked_contacts_userId_name_idx" ON "tracked_contacts"("userId", "name");

-- CreateIndex
CREATE INDEX "tracked_applications_userId_stage_idx" ON "tracked_applications"("userId", "stage");

-- CreateIndex
CREATE INDEX "tracked_applications_userId_appliedOn_idx" ON "tracked_applications"("userId", "appliedOn");

-- CreateIndex
CREATE INDEX "tracked_applications_referrerId_idx" ON "tracked_applications"("referrerId");

-- AddForeignKey
ALTER TABLE "tracked_contacts" ADD CONSTRAINT "tracked_contacts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_applications" ADD CONSTRAINT "tracked_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracked_applications" ADD CONSTRAINT "tracked_applications_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "tracked_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity, in the same spirit as 20260906120000_integrity_constraints.
ALTER TABLE "tracked_contacts"
  ADD CONSTRAINT "tracked_contacts_name_nonempty_check" CHECK (length(trim("name")) > 0);

ALTER TABLE "tracked_applications"
  ADD CONSTRAINT "tracked_applications_company_nonempty_check" CHECK (length(trim("company")) > 0),
  ADD CONSTRAINT "tracked_applications_referrer_without_referral_check"
    CHECK ("referrerId" IS NULL OR "referralGiven");
