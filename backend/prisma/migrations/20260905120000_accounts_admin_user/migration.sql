-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- DropIndex
DROP INDEX "applications_companyId_normalizedTitle_key";

-- DropIndex
DROP INDEX "candidate_profiles_label_key";

-- DropIndex
DROP INDEX "match_scores_score_idx";

-- DropIndex
DROP INDEX "skills_reserve_skill_key";

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "candidate_profiles" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "match_scores" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "skills_reserve" ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "application_answers" (
    "userId" TEXT NOT NULL,
    "workAuthorization" TEXT,
    "needsSponsorship" BOOLEAN,
    "noticePeriodDays" INTEGER,
    "currentCtcLpa" DOUBLE PRECISION,
    "expectedCtcLpa" DOUBLE PRECISION,
    "willingToRelocate" BOOLEAN,
    "earliestStartDate" TIMESTAMP(3),
    "customAnswers" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_answers_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "applications_userId_status_idx" ON "applications"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "applications_userId_companyId_normalizedTitle_key" ON "applications"("userId", "companyId", "normalizedTitle");

-- CreateIndex
CREATE INDEX "candidate_profiles_userId_idx" ON "candidate_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "candidate_profiles_userId_label_key" ON "candidate_profiles"("userId", "label");

-- CreateIndex
CREATE INDEX "match_scores_userId_score_idx" ON "match_scores"("userId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "match_scores_userId_jobId_key" ON "match_scores"("userId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_reserve_userId_skill_key" ON "skills_reserve"("userId", "skill");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_profiles" ADD CONSTRAINT "candidate_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills_reserve" ADD CONSTRAINT "skills_reserve_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_scores" ADD CONSTRAINT "match_scores_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
