-- Where each candidate is willing to work. See JobPreference in schema.prisma.
--
-- The differ's two `DROP INDEX ..._embedding_hnsw_idx` lines were deleted from
-- this file by hand, as in every migration since the vector indexes were added.
-- Prisma's schema language cannot express an HNSW index, so `Unsupported("vector")`
-- reads as "no index here" and every diff proposes dropping them again. Applying
-- that would silently turn stage 2 into a sequential scan over every embedding.
--
-- NO BACKFILL, ON PURPOSE. A row here means "this person stated their cities", and
-- inventing one for every existing account would be inventing the answer. Absent
-- means config/targets.yaml still applies, which is exactly the behaviour that was
-- in force before this table existed.

-- CreateTable
CREATE TABLE "job_preferences" (
    "userId" TEXT NOT NULL,
    "cities" TEXT[],
    "anywhereInIndia" BOOLEAN NOT NULL DEFAULT false,
    "remoteIndia" BOOLEAN NOT NULL DEFAULT true,
    "remoteUnspecified" BOOLEAN NOT NULL DEFAULT true,
    "remoteOutsideIndia" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_preferences_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "job_preferences" ADD CONSTRAINT "job_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
