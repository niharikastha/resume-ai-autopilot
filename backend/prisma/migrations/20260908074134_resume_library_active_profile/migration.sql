-- Resume library: several resumes per candidate, exactly one of them active.
--
-- The two `DROP INDEX` statements Prisma's differ emitted here have been DELETED,
-- per the note at the top of schema.prisma: the HNSW indexes sit on
-- Unsupported("vector") columns, so they are invisible to the schema and the
-- differ believes they are undeclared leftovers. Applying the drops would
-- silently degrade every semantic search to a sequential scan.

-- AlterTable
ALTER TABLE "candidate_profiles" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceFilename" TEXT;

-- ONE ACTIVE RESUME PER CANDIDATE, and no way around it.
--
-- A partial unique index, because the rule is about the true rows only. The
-- declarable alternative, UNIQUE ("userId", "isActive"), enforces the opposite of
-- what is wanted: it would cap each candidate at one INACTIVE resume while
-- happily allowing a second active one.
--
-- Enforced in the database rather than in the service because "make this one
-- active" is two writes - clear the old, set the new - and a crash between them
-- would leave a candidate with two active resumes and matching quietly picking
-- whichever row came back first.
CREATE UNIQUE INDEX "candidate_profiles_one_active_per_user"
    ON "candidate_profiles" ("userId")
 WHERE "isActive";

-- BACKFILL. Existing candidates have confirmed resumes and no active flag, which
-- would leave matching and tailoring with nothing selected and an error message
-- about a screen the candidate has never seen. The most recently updated
-- confirmed profile is the right guess: it is the one the CLI's own
-- `orderBy: { updatedAt: 'desc' }` already preferred when listing them.
UPDATE "candidate_profiles" SET "isActive" = true
 WHERE id IN (
   SELECT DISTINCT ON ("userId") id
     FROM "candidate_profiles"
    WHERE "confirmedAt" IS NOT NULL
    ORDER BY "userId", "updatedAt" DESC
 );
