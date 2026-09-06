-- Extensions the pipeline depends on.
--
-- vector   : embedding columns on CandidateProfile atoms and JobPosting.
--            Prisma cannot express this type, so the columns are declared
--            Unsupported("vector(384)") in schema.prisma and queried with raw
--            SQL through @prisma/adapter-pg. See PLAN-v2.txt phase 4 stage 2.
-- pg_trgm  : fuzzy cross-source dedupe on (company, normalizedTitle, location).
--            The same job reached via Greenhouse and via an aggregator must
--            collapse to one row. See PLAN-v2.txt phase 1c.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Also into template1, so every database CREATEd later inherits them.
--
-- This is not belt-and-braces, it is required: `prisma migrate dev` diffs
-- against a throwaway SHADOW DATABASE it creates and drops on each run. That
-- database is not touched by this init directory, so without the template1 copy
-- every migration after the first fails with `type "vector" does not exist` -
-- the schema is fine, the shadow is what is missing the type.
\connect template1
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
