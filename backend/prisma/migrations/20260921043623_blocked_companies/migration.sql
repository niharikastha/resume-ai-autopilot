-- Employers a candidate will not apply to. See BlockedCompany in schema.prisma.
--
-- The differ's two `DROP INDEX ..._embedding_hnsw_idx` lines were deleted from
-- this file by hand, as in every migration since the vector indexes were added.
-- Prisma's schema language cannot express an HNSW index, so `Unsupported("vector")`
-- reads as "no index here" and every diff proposes dropping them again. Applying
-- that would silently turn stage 2 into a sequential scan over every embedding.
--
-- NO BACKFILL, ON PURPOSE, for the same reason job_preferences had none: a row here
-- is a statement somebody made, and there is no employer it would be honest to
-- invent for an existing account. An empty list matches nothing, so every account
-- is screened exactly as it was before this table existed.
--
-- `pattern` IS NOT NULLABLE AND IS UNIQUE PER USER. It is the normalised form of
-- `label` (src/config/blocked-companies.ts), and the index on it is what stops
-- "HyScaler" and "hyscaler pvt ltd" becoming two rows the candidate cannot tell
-- apart. Storing the derived form rather than computing it on read is what makes
-- that constraint expressible in the database rather than in a service.

-- CreateTable
CREATE TABLE "blocked_companies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_companies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blocked_companies_userId_idx" ON "blocked_companies"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_companies_userId_pattern_key" ON "blocked_companies"("userId", "pattern");

-- AddForeignKey
ALTER TABLE "blocked_companies" ADD CONSTRAINT "blocked_companies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
