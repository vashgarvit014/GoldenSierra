-- Additive: structured job listings extracted from indexed documents.
CREATE TABLE "JobListing" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "employer" TEXT,
    "county" TEXT,
    "location" TEXT,
    "requiredSkills" TEXT,
    "qualifications" TEXT,
    "salary" TEXT,
    "employmentType" TEXT,
    "datePosted" TEXT,
    "deadline" TEXT,
    "summary" TEXT,
    "sourceUrl" TEXT,
    "applyUrl" TEXT,
    "contact" TEXT,
    "occupations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sector" TEXT,
    "segment" TEXT NOT NULL,
    "segmentHash" TEXT NOT NULL,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobListing_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobListing_documentId_ordinal_key" ON "JobListing"("documentId", "ordinal");
CREATE INDEX "JobListing_documentId_idx" ON "JobListing"("documentId");
ALTER TABLE "JobListing" ADD CONSTRAINT "JobListing_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
