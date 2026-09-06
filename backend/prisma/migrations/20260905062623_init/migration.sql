-- CreateEnum
CREATE TYPE "AtsType" AS ENUM ('GREENHOUSE', 'LEVER', 'ASHBY', 'SMARTRECRUITERS', 'WORKABLE', 'WORKDAY', 'CUSTOM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CompanyTier" AS ENUM ('T1_GLOBAL_INDIA_OFFICE', 'T2_FUNDED_INDIAN_STARTUP', 'T3_INDIAN_MIDMARKET', 'T4_SERVICES_STAFFING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProbeResult" AS ENUM ('HIT', 'MISS', 'TENANT_NOT_FOUND', 'FORBIDDEN', 'ERROR');

-- CreateEnum
CREATE TYPE "RemoteType" AS ENUM ('ONSITE', 'HYBRID', 'REMOTE_INDIA', 'REMOTE_GLOBAL', 'REMOTE_OTHER_REGION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SalarySource" AS ENUM ('STATED', 'ESTIMATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MatchVerdict" AS ENUM ('STRONG', 'GOOD', 'BORDERLINE', 'WEAK', 'REJECT');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('QUEUED', 'AWAITING_REVIEW', 'APPROVED', 'REJECTED', 'PREPARED', 'SUBMITTED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "candidate_profiles" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "location" TEXT,
    "linkedIn" TEXT,
    "github" TEXT,
    "portfolio" TEXT,
    "atoms" JSONB NOT NULL,
    "embedding" vector(384),
    "sourceResumePath" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidate_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_atom_embeddings" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "atomId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(384),

    CONSTRAINT "profile_atom_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills_reserve" (
    "id" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "note" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skills_reserve_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "atsType" "AtsType" NOT NULL DEFAULT 'UNKNOWN',
    "atsToken" TEXT,
    "tier" "CompanyTier" NOT NULL DEFAULT 'UNKNOWN',
    "isAgency" BOOLEAN NOT NULL DEFAULT false,
    "yieldStats" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_probes" (
    "id" TEXT NOT NULL,
    "slugTried" TEXT NOT NULL,
    "atsType" "AtsType" NOT NULL,
    "result" "ProbeResult" NOT NULL,
    "httpStatus" INTEGER,
    "jobsFound" INTEGER,
    "notes" TEXT,
    "probedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_probes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_runs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "companiesTried" INTEGER NOT NULL DEFAULT 0,
    "postingsSeen" INTEGER NOT NULL DEFAULT 0,
    "postingsNew" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "errorSample" JSONB,

    CONSTRAINT "source_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceJobId" TEXT NOT NULL,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "descriptionRaw" TEXT NOT NULL,
    "descriptionText" TEXT NOT NULL,
    "location" TEXT,
    "remoteType" "RemoteType" NOT NULL DEFAULT 'UNKNOWN',
    "seniority" TEXT,
    "yoeMin" INTEGER,
    "yoeMax" INTEGER,
    "salaryMin" INTEGER,
    "salaryMax" INTEGER,
    "salaryCurrency" TEXT,
    "salaryPeriod" TEXT,
    "salarySource" "SalarySource" NOT NULL DEFAULT 'UNKNOWN',
    "salaryConfidence" DOUBLE PRECISION,
    "applyUrl" TEXT NOT NULL,
    "atsType" "AtsType" NOT NULL DEFAULT 'UNKNOWN',
    "postedAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "embedding" vector(384),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_scores" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "verdict" "MatchVerdict" NOT NULL,
    "reasons" TEXT[],
    "missingSkills" TEXT[],
    "estimatedSalaryLPA" DOUBLE PRECISION,
    "salaryConfidence" DOUBLE PRECISION,
    "llmProvider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vectorDistance" DOUBLE PRECISION,
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_variants" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "atomSelection" JSONB NOT NULL,
    "coverLetter" TEXT,
    "docxPath" TEXT,
    "pdfPath" TEXT,
    "provenanceReport" JSONB NOT NULL,
    "guardPassed" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'QUEUED',
    "resumeVariantId" TEXT,
    "coverLetter" TEXT,
    "screeningAnswers" JSONB,
    "prefillCoverage" DOUBLE PRECISION,
    "submittedAt" TIMESTAMP(3),
    "confirmationText" TEXT,
    "screenshotPath" TEXT,
    "failureReason" TEXT,
    "llmProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_label_key" ON "candidate_profiles"("label");

-- CreateIndex
CREATE UNIQUE INDEX "profile_atom_embeddings_profileId_atomId_key" ON "profile_atom_embeddings"("profileId", "atomId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_reserve_skill_key" ON "skills_reserve"("skill");

-- CreateIndex
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

-- CreateIndex
CREATE INDEX "companies_atsType_active_idx" ON "companies"("atsType", "active");

-- CreateIndex
CREATE INDEX "companies_tier_idx" ON "companies"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "companies_atsType_atsToken_key" ON "companies"("atsType", "atsToken");

-- CreateIndex
CREATE INDEX "company_probes_result_idx" ON "company_probes"("result");

-- CreateIndex
CREATE UNIQUE INDEX "company_probes_slugTried_atsType_key" ON "company_probes"("slugTried", "atsType");

-- CreateIndex
CREATE INDEX "source_runs_source_startedAt_idx" ON "source_runs"("source", "startedAt");

-- CreateIndex
CREATE INDEX "job_postings_contentHash_idx" ON "job_postings"("contentHash");

-- CreateIndex
CREATE INDEX "job_postings_normalizedTitle_idx" ON "job_postings"("normalizedTitle");

-- CreateIndex
CREATE INDEX "job_postings_postedAt_idx" ON "job_postings"("postedAt");

-- CreateIndex
CREATE INDEX "job_postings_atsType_idx" ON "job_postings"("atsType");

-- CreateIndex
CREATE UNIQUE INDEX "job_postings_source_sourceJobId_key" ON "job_postings"("source", "sourceJobId");

-- CreateIndex
CREATE INDEX "match_scores_jobId_idx" ON "match_scores"("jobId");

-- CreateIndex
CREATE INDEX "match_scores_score_idx" ON "match_scores"("score");

-- CreateIndex
CREATE INDEX "resume_variants_jobId_idx" ON "resume_variants"("jobId");

-- CreateIndex
CREATE INDEX "resume_variants_guardPassed_idx" ON "resume_variants"("guardPassed");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "applications_companyId_normalizedTitle_key" ON "applications"("companyId", "normalizedTitle");

-- AddForeignKey
ALTER TABLE "profile_atom_embeddings" ADD CONSTRAINT "profile_atom_embeddings_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_variants" ADD CONSTRAINT "resume_variants_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_resumeVariantId_fkey" FOREIGN KEY ("resumeVariantId") REFERENCES "resume_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
