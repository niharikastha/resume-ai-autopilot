-- Six more things a piece of a resume can carry. See ProfileAtom in schema.prisma.
--
-- All NULLABLE and none backfilled, which is the whole safety of this migration:
-- every atom already stored keeps working exactly as it did, and a null here means
-- "never asked", not "empty". The pieces read out of a pdf by the parser have no
-- values for these - only the upload form asks for them - so a backfill would be
-- inventing a CGPA.
--
-- `ctc` is the sensitive one: it is what a job paid. It is written only by the
-- candidate's own form and read only back into that form. Nothing renders it, and
-- the tailoring prompt is built from `text`, `tech` and `metrics` - so it cannot
-- reach a generated resume even by accident.
--
-- The differ's two `DROP INDEX ..._embedding_hnsw_idx` lines were deleted from this
-- file by hand, as in every migration since the vector indexes were added. Prisma's
-- schema language cannot express an HNSW index, so `Unsupported("vector")` reads as
-- "no index here" and every diff proposes dropping them again. Applying that would
-- silently turn stage 2 into a sequential scan over every embedding.

-- AlterTable
ALTER TABLE "profile_atoms" ADD COLUMN     "ctc" TEXT,
ADD COLUMN     "degree" TEXT,
ADD COLUMN     "fieldOfStudy" TEXT,
ADD COLUMN     "link" TEXT,
ADD COLUMN     "score" TEXT,
ADD COLUMN     "scoreOutOf" TEXT;
