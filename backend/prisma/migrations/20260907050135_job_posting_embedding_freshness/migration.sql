-- Stage 2 of the matching funnel needs two things this table did not have: a way to
-- tell a stale vector from a current one, and an index to search vectors with.

-- 1. STALENESS.
--
-- `embedding` is `Unsupported("vector(384)")`, so Prisma cannot put it in an update
-- payload. The discovery upsert therefore rewrites `descriptionText` and
-- `contentHash` when an employer edits a posting and leaves `embedding` untouched -
-- a vector describing text that is no longer there, indistinguishable from a good
-- one. Recording which contentHash the vector came from is what makes the difference
-- visible, and it is the same pattern profile_atoms.embeddedTextHash already uses.
ALTER TABLE "job_postings" ADD COLUMN "embeddedContentHash" TEXT;

-- A vector with no hash is the state a raw-SQL write that forgot the second column
-- would leave behind, and it is worse than no vector at all: it looks fresh and
-- can never be checked. Made unrepresentable rather than documented.
ALTER TABLE "job_postings"
  ADD CONSTRAINT "job_postings_embedding_has_hash_check"
    CHECK ("embedding" IS NULL OR "embeddedContentHash" IS NOT NULL);

-- 2. THE INDEX.
--
-- HNSW with vector_cosine_ops, per PLAN-v2 phase 4 stage 2. Cosine because the
-- embeddings are L2-normalised by EmbeddingsService, which makes cosine distance and
-- the inner product equivalent - and `<=>` is the operator the vector_cosine_ops
-- class answers, so an index built for any other operator would simply never be used.
--
-- WHAT THIS INDEX IS AND IS NOT FOR. Stage 2 computes the distance from the profile
-- vector to a KNOWN SET of stage-1 survivor ids, and an ANN index cannot serve that:
-- it accelerates an unfiltered `ORDER BY embedding <=> $1 LIMIT n` over the whole
-- table, not a distance projection over a few hundred ids the planner already has.
-- Stage 2's query is an exact sequential distance computation on purpose - a few
-- hundred 384-dimension dot products is microseconds, and exact beats approximate
-- when the candidate set is already small.
--
-- The index is here for the searches that scan the whole table: "postings most like
-- this one", the UI's semantic search, and any future recall check that has to look
-- past the deterministic filters. Building it now costs nothing (every row is NULL
-- today) and building it later costs a lock on a large table.
--
-- m/ef_construction are left at the defaults (16/64). Tuning them is meaningless
-- before there is a corpus to measure recall against.
CREATE INDEX "job_postings_embedding_hnsw_idx"
  ON "job_postings" USING hnsw ("embedding" vector_cosine_ops);

-- Same reasoning for the profile side, which had no vector index either. There is one
-- row per profile so the index is decorative today, but per-atom search ("which of my
-- bullets is this requirement about") is what phase 5's tailoring selection reads,
-- and that one runs per application.
CREATE INDEX "profile_atoms_embedding_hnsw_idx"
  ON "profile_atoms" USING hnsw ("embedding" vector_cosine_ops);
