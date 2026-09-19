-- The differ's two DROP INDEX lines for the HNSW indexes were deleted from this file
-- before it was applied. They are invisible to Prisma (Unsupported("vector(384)")), so
-- every migration proposes dropping them - see the note at the top of schema.prisma.

-- CreateTable
CREATE TABLE "tailored_resumes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "jobId" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "jdText" TEXT NOT NULL,
    "atomSelection" JSONB NOT NULL,
    "coverLetter" TEXT,
    "docxPath" TEXT,
    "pdfPath" TEXT,
    "provenanceReport" JSONB NOT NULL,
    "guardPassed" BOOLEAN NOT NULL,
    "llmProvider" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tailored_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tailored_resumes_userId_createdAt_idx" ON "tailored_resumes"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "tailored_resumes_profileId_idx" ON "tailored_resumes"("profileId");

-- CreateIndex
CREATE INDEX "tailored_resumes_jobId_idx" ON "tailored_resumes"("jobId");

-- AddForeignKey
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "candidate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
