-- Data-integrity pass: promote atoms to a real table, correct the money types,
-- close two open string domains, and add the CHECK constraints the schema had
-- only ever described in comments.
--
-- Before this migration the database had ZERO check constraints. `score Int /// 0-100`
-- accepted -5 and 9999; `salaryMin`/`salaryMax` could be inverted; a confidence
-- could be 4.2. Every one of those bounds was documentation.
--
-- The structural half of this file is what `prisma migrate diff` produced, with
-- two hand-written departures, both marked below: the salaryPeriod conversion
-- preserves its data instead of dropping the column, and normalizedTitle is
-- backfilled before its constraint is added.

-- ---------------------------------------------------------------------------
-- 1. NEW ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE "AtomKind" AS ENUM ('BULLET', 'SKILL', 'ROLE', 'EDU');
CREATE TYPE "SalaryPeriod" AS ENUM ('YEAR', 'MONTH', 'DAY', 'HOUR');

-- ---------------------------------------------------------------------------
-- 2. PROFILE ATOMS: json blob -> real table with a real foreign key
-- ---------------------------------------------------------------------------
--
-- `candidate_profiles.atoms` held an array of objects each with its own `id`, and
-- `profile_atom_embeddings.atomId` pointed at one of those ids. Postgres cannot
-- enforce a reference into a JSON document, so removing an atom from the array
-- left its embedding row behind - still matchable against a job description.
-- Tailoring could then surface a bullet the candidate had deleted.
--
-- Both tables collapse into one row per atom, carrying the vector, so there is
-- nothing left to keep in step.
--
-- SAFE: candidate_profiles and profile_atom_embeddings are both empty (verified
-- 2026-09-06). No atom data exists to migrate; this is a restructure before
-- Phase 2 fills these tables, which is the cheapest moment it will ever happen.

ALTER TABLE "profile_atom_embeddings" DROP CONSTRAINT "profile_atom_embeddings_profileId_fkey";
DROP TABLE "profile_atom_embeddings";

ALTER TABLE "candidate_profiles" DROP COLUMN "atoms";

CREATE TABLE "profile_atoms" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" "AtomKind" NOT NULL,
    "text" TEXT NOT NULL,
    "tech" TEXT[],
    "metrics" TEXT[],
    "employer" TEXT,
    "dateRange" TEXT,
    "ordinal" INTEGER NOT NULL,
    "embedding" vector(384),
    "embeddedTextHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_atoms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "profile_atoms_profileId_kind_idx" ON "profile_atoms"("profileId", "kind");
CREATE UNIQUE INDEX "profile_atoms_profileId_ordinal_key" ON "profile_atoms"("profileId", "ordinal");

ALTER TABLE "profile_atoms" ADD CONSTRAINT "profile_atoms_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. MONEY: double precision -> numeric
-- ---------------------------------------------------------------------------
--
-- These figures get typed into a real employer's salary field. A binary float
-- cannot represent 12.1 exactly, so Float turned a number the candidate entered
-- into a slightly different one.

ALTER TABLE "application_answers"
  ALTER COLUMN "currentCtcLpa"  SET DATA TYPE DECIMAL(6,2),
  ALTER COLUMN "expectedCtcLpa" SET DATA TYPE DECIMAL(6,2);

ALTER TABLE "match_scores"
  ALTER COLUMN "estimatedSalaryLPA" SET DATA TYPE DECIMAL(6,2);

-- Int truncated any hourly or monthly figure. Widening Int -> numeric is lossless.
ALTER TABLE "job_postings"
  ALTER COLUMN "salaryMin" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "salaryMax" SET DATA TYPE DECIMAL(14,2);

-- ---------------------------------------------------------------------------
-- 4. salaryPeriod: free string -> enum, WITHOUT dropping the column
-- ---------------------------------------------------------------------------
--
-- HAND-WRITTEN, replacing prisma's generated DROP COLUMN / ADD COLUMN pair, which
-- would have discarded the period on all 884 rows that have one.
--
-- The live column held only 'year' and NULL, but it was a free string, so the
-- synonyms below are the ones a connector could plausibly already have written.
-- Anything genuinely unrecognised becomes NULL rather than failing the migration:
-- an unparseable period is exactly what NULL means here, and salarySource still
-- records where the figure came from.

ALTER TABLE "job_postings"
  ALTER COLUMN "salaryPeriod" TYPE "SalaryPeriod"
  USING (
    CASE upper(trim("salaryPeriod"))
      WHEN 'YEAR'    THEN 'YEAR'
      WHEN 'YEARLY'  THEN 'YEAR'
      WHEN 'ANNUAL'  THEN 'YEAR'
      WHEN 'ANNUM'   THEN 'YEAR'
      WHEN 'MONTH'   THEN 'MONTH'
      WHEN 'MONTHLY' THEN 'MONTH'
      WHEN 'DAY'     THEN 'DAY'
      WHEN 'DAILY'   THEN 'DAY'
      WHEN 'HOUR'    THEN 'HOUR'
      WHEN 'HOURLY'  THEN 'HOUR'
      ELSE NULL
    END
  )::"SalaryPeriod";

-- ---------------------------------------------------------------------------
-- 5. app_settings.updatedBy: unenforced id -> real foreign key
-- ---------------------------------------------------------------------------
--
-- SET NULL, not CASCADE. Deleting the admin who last changed a setting must not
-- delete the setting.

CREATE INDEX "app_settings_updatedBy_idx" ON "app_settings"("updatedBy");

ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. BACKFILL before the constraint that would reject it
-- ---------------------------------------------------------------------------
--
-- Two rows have an EMPTY normalizedTitle. Both are Japanese-titled Greenhouse
-- postings; the spike's normalizer stripped non-ASCII and left nothing behind.
--
-- This is not cosmetic. applications has UNIQUE(userId, companyId, normalizedTitle),
-- so every posting that normalizes to '' collides with every other one at the same
-- company - and the second application would be refused as a duplicate of a role
-- it has nothing to do with. The CHECK below is what stops that class of row
-- existing; the Phase 1 normalizer must preserve non-ASCII titles.

UPDATE "job_postings"
   SET "normalizedTitle" = lower(trim("title"))
 WHERE length(trim("normalizedTitle")) = 0
   AND length(trim("title")) > 0;

-- ---------------------------------------------------------------------------
-- 7. CHECK CONSTRAINTS
-- ---------------------------------------------------------------------------
--
-- Prisma cannot express these, which is why they were missing. Hand-written here
-- so they are enforced by the database rather than by whichever service happens
-- to remember. Every bound is mirrored in src/validation/domain.constants.ts,
-- and domain.schema.spec.ts fails if the two drift apart.

-- users -------------------------------------------------------------------
ALTER TABLE "users"
  ADD CONSTRAINT "users_email_shape_check" CHECK (position('@' in "email") > 1),
  ADD CONSTRAINT "users_name_nonempty_check" CHECK (length(trim("name")) > 0),
  -- An approver implies an approval date. NOT the reverse: setActive() stamps
  -- approvedAt = createdAt with a null approver when suspending an account that
  -- predates the column, and that is a legitimate state.
  ADD CONSTRAINT "users_approver_implies_date_check"
    CHECK ("approvedById" IS NULL OR "approvedAt" IS NOT NULL);

-- sessions ----------------------------------------------------------------
ALTER TABLE "sessions"
  -- The sliding refresh window can never outlive the ceiling set at login. If it
  -- could, the 90-day absolute cap would be advisory.
  ADD CONSTRAINT "sessions_expiry_within_absolute_check"
    CHECK ("absoluteExpiresAt" >= "expiresAt"),
  ADD CONSTRAINT "sessions_expiry_after_creation_check"
    CHECK ("expiresAt" > "createdAt");

-- access_tokens -----------------------------------------------------------
ALTER TABLE "access_tokens"
  ADD CONSTRAINT "access_tokens_expiry_after_creation_check"
    CHECK ("expiresAt" > "createdAt");

-- password_resets ---------------------------------------------------------
ALTER TABLE "password_resets"
  ADD CONSTRAINT "password_resets_expiry_after_creation_check"
    CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "password_resets_used_after_creation_check"
    CHECK ("usedAt" IS NULL OR "usedAt" >= "createdAt");

-- app_settings ------------------------------------------------------------
ALTER TABLE "app_settings"
  ADD CONSTRAINT "app_settings_key_nonempty_check" CHECK (length(trim("key")) > 0);

-- application_answers -----------------------------------------------------
ALTER TABLE "application_answers"
  ADD CONSTRAINT "application_answers_notice_range_check"
    CHECK ("noticePeriodDays" IS NULL OR ("noticePeriodDays" >= 0 AND "noticePeriodDays" <= 365)),
  -- 0..1000 LPA is a typo guard, not a salary cap: it catches 1200000 entered by
  -- someone who meant 12.
  ADD CONSTRAINT "application_answers_current_ctc_range_check"
    CHECK ("currentCtcLpa" IS NULL OR ("currentCtcLpa" >= 0 AND "currentCtcLpa" <= 1000)),
  ADD CONSTRAINT "application_answers_expected_ctc_range_check"
    CHECK ("expectedCtcLpa" IS NULL OR ("expectedCtcLpa" >= 0 AND "expectedCtcLpa" <= 1000));

-- candidate_profiles ------------------------------------------------------
ALTER TABLE "candidate_profiles"
  ADD CONSTRAINT "candidate_profiles_label_nonempty_check" CHECK (length(trim("label")) > 0),
  ADD CONSTRAINT "candidate_profiles_fullname_nonempty_check" CHECK (length(trim("fullName")) > 0),
  ADD CONSTRAINT "candidate_profiles_email_shape_check" CHECK (position('@' in "email") > 1);

-- profile_atoms -----------------------------------------------------------
ALTER TABLE "profile_atoms"
  ADD CONSTRAINT "profile_atoms_text_nonempty_check" CHECK (length(trim("text")) > 0),
  ADD CONSTRAINT "profile_atoms_ordinal_nonneg_check" CHECK ("ordinal" >= 0),
  -- A vector with no record of what it was computed from cannot be checked for
  -- staleness, so it must not exist.
  ADD CONSTRAINT "profile_atoms_embedding_has_hash_check"
    CHECK ("embedding" IS NULL OR "embeddedTextHash" IS NOT NULL);

-- skills_reserve ----------------------------------------------------------
ALTER TABLE "skills_reserve"
  ADD CONSTRAINT "skills_reserve_skill_nonempty_check" CHECK (length(trim("skill")) > 0);

-- companies ---------------------------------------------------------------
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_name_nonempty_check" CHECK (length(trim("name")) > 0),
  ADD CONSTRAINT "companies_slug_nonempty_check" CHECK (length(trim("slug")) > 0);

-- company_probes ----------------------------------------------------------
ALTER TABLE "company_probes"
  ADD CONSTRAINT "company_probes_slug_nonempty_check" CHECK (length(trim("slugTried")) > 0),
  ADD CONSTRAINT "company_probes_http_status_range_check"
    CHECK ("httpStatus" IS NULL OR ("httpStatus" >= 100 AND "httpStatus" <= 599)),
  ADD CONSTRAINT "company_probes_jobs_found_nonneg_check"
    CHECK ("jobsFound" IS NULL OR "jobsFound" >= 0);

-- source_runs -------------------------------------------------------------
ALTER TABLE "source_runs"
  ADD CONSTRAINT "source_runs_source_nonempty_check" CHECK (length(trim("source")) > 0),
  ADD CONSTRAINT "source_runs_counts_nonneg_check"
    CHECK ("companiesTried" >= 0 AND "postingsSeen" >= 0 AND "postingsNew" >= 0 AND "errors" >= 0),
  -- New postings are a subset of the ones seen. A connector reporting otherwise
  -- is miscounting, and this table exists to make miscounting visible.
  ADD CONSTRAINT "source_runs_new_within_seen_check" CHECK ("postingsNew" <= "postingsSeen"),
  ADD CONSTRAINT "source_runs_finished_after_started_check"
    CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt");

-- job_postings ------------------------------------------------------------
ALTER TABLE "job_postings"
  ADD CONSTRAINT "job_postings_source_nonempty_check" CHECK (length(trim("source")) > 0),
  ADD CONSTRAINT "job_postings_title_nonempty_check" CHECK (length(trim("title")) > 0),
  -- See the backfill in section 6: an empty normalizedTitle silently collides in
  -- the applications unique index.
  ADD CONSTRAINT "job_postings_normalized_title_nonempty_check"
    CHECK (length(trim("normalizedTitle")) > 0),
  ADD CONSTRAINT "job_postings_content_hash_nonempty_check"
    CHECK (length(trim("contentHash")) > 0),
  ADD CONSTRAINT "job_postings_apply_url_shape_check" CHECK ("applyUrl" ~ '^https?://'),
  ADD CONSTRAINT "job_postings_yoe_nonneg_check"
    CHECK (("yoeMin" IS NULL OR ("yoeMin" >= 0 AND "yoeMin" <= 60))
       AND ("yoeMax" IS NULL OR ("yoeMax" >= 0 AND "yoeMax" <= 60))),
  ADD CONSTRAINT "job_postings_yoe_ordered_check"
    CHECK ("yoeMin" IS NULL OR "yoeMax" IS NULL OR "yoeMax" >= "yoeMin"),
  ADD CONSTRAINT "job_postings_salary_nonneg_check"
    CHECK (("salaryMin" IS NULL OR "salaryMin" >= 0) AND ("salaryMax" IS NULL OR "salaryMax" >= 0)),
  ADD CONSTRAINT "job_postings_salary_ordered_check"
    CHECK ("salaryMin" IS NULL OR "salaryMax" IS NULL OR "salaryMax" >= "salaryMin"),
  ADD CONSTRAINT "job_postings_salary_confidence_range_check"
    CHECK ("salaryConfidence" IS NULL OR ("salaryConfidence" >= 0 AND "salaryConfidence" <= 1)),
  -- ISO 4217. Not an enum: the value set is large, externally defined, and not
  -- ours to close.
  ADD CONSTRAINT "job_postings_currency_shape_check"
    CHECK ("salaryCurrency" IS NULL OR "salaryCurrency" ~ '^[A-Z]{3}$'),
  -- STATED means the employer published a figure. Without one, the label is a
  -- claim the row cannot support.
  ADD CONSTRAINT "job_postings_stated_has_salary_check"
    CHECK ("salarySource" <> 'STATED' OR "salaryMin" IS NOT NULL OR "salaryMax" IS NOT NULL),
  ADD CONSTRAINT "job_postings_seen_ordered_check" CHECK ("lastSeenAt" >= "firstSeenAt"),
  ADD CONSTRAINT "job_postings_closed_after_first_seen_check"
    CHECK ("closedAt" IS NULL OR "closedAt" >= "firstSeenAt");

-- match_scores ------------------------------------------------------------
ALTER TABLE "match_scores"
  ADD CONSTRAINT "match_scores_score_range_check" CHECK ("score" >= 0 AND "score" <= 100),
  ADD CONSTRAINT "match_scores_salary_confidence_range_check"
    CHECK ("salaryConfidence" IS NULL OR ("salaryConfidence" >= 0 AND "salaryConfidence" <= 1)),
  ADD CONSTRAINT "match_scores_estimated_salary_range_check"
    CHECK ("estimatedSalaryLPA" IS NULL OR ("estimatedSalaryLPA" >= 0 AND "estimatedSalaryLPA" <= 1000)),
  -- A distance is a magnitude; cosine distance in pgvector is 0..2.
  ADD CONSTRAINT "match_scores_vector_distance_nonneg_check"
    CHECK ("vectorDistance" IS NULL OR "vectorDistance" >= 0),
  ADD CONSTRAINT "match_scores_provider_nonempty_check"
    CHECK (length(trim("llmProvider")) > 0 AND length(trim("model")) > 0);

-- resume_variants ---------------------------------------------------------
ALTER TABLE "resume_variants"
  -- Paths are written only after the file exists, so an empty string means a
  -- failed write was recorded as a success.
  ADD CONSTRAINT "resume_variants_docx_path_nonempty_check"
    CHECK ("docxPath" IS NULL OR length(trim("docxPath")) > 0),
  ADD CONSTRAINT "resume_variants_pdf_path_nonempty_check"
    CHECK ("pdfPath" IS NULL OR length(trim("pdfPath")) > 0);

-- applications ------------------------------------------------------------
ALTER TABLE "applications"
  ADD CONSTRAINT "applications_normalized_title_nonempty_check"
    CHECK (length(trim("normalizedTitle")) > 0),
  ADD CONSTRAINT "applications_prefill_coverage_range_check"
    CHECK ("prefillCoverage" IS NULL OR ("prefillCoverage" >= 0 AND "prefillCoverage" <= 1)),
  -- ONE home for the cover letter. resume_variants.coverLetter holds it when a
  -- variant was generated; this column holds it only for a manual-open job that
  -- has no variant. Both set at once meant two copies and no answer to "which one
  -- was sent".
  ADD CONSTRAINT "applications_cover_letter_single_source_check"
    CHECK ("resumeVariantId" IS NULL OR "coverLetter" IS NULL),
  -- SUBMITTED is only ever written on a DETECTED confirmation, never
  -- optimistically (PLAN-v2). That rule now lives in the database: a row cannot
  -- claim SUBMITTED without carrying the evidence.
  ADD CONSTRAINT "applications_submitted_has_evidence_check"
    CHECK ("status" <> 'SUBMITTED'
        OR ("submittedAt" IS NOT NULL AND length(trim(coalesce("confirmationText", ''))) > 0)),
  -- The mirror image: a failure with no reason recorded is a dead end for whoever
  -- has to work out what went wrong.
  ADD CONSTRAINT "applications_failed_has_reason_check"
    CHECK ("status" <> 'FAILED' OR length(trim(coalesce("failureReason", ''))) > 0);
