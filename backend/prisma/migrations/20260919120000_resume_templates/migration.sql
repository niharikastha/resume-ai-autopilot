-- Resume templates: how a resume is typeset, per resume.
--
-- WRITTEN BY HAND, like the migration before it, because `prisma migrate dev`
-- generates a DROP INDEX for the two HNSW vector indexes on every run - it cannot
-- see index types it has no schema syntax for, so it reads them as indexes that
-- ought not to exist. Everything below is additive and has a default, so no table
-- is rewritten and no existing row changes meaning.

-- CreateEnum
CREATE TYPE "ResumeTemplate" AS ENUM ('CLASSIC', 'COMPACT', 'MODERN');

-- AlterTable
-- CLASSIC for existing rows, which is what they were actually rendered in.
ALTER TABLE "candidate_profiles"
  ADD COLUMN "resumeTemplate" "ResumeTemplate" NOT NULL DEFAULT 'CLASSIC';

-- AlterTable
-- Same default, and here it is a statement of fact about files already on disk:
-- every tailored resume rendered before this migration was written by the classic
-- writer, so re-typesetting one starts from a true answer to "what is it now".
ALTER TABLE "tailored_resumes"
  ADD COLUMN "template" "ResumeTemplate" NOT NULL DEFAULT 'CLASSIC';
