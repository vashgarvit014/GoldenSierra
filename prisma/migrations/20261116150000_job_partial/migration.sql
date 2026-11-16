-- Additive: a crawl can finish with usable content and some failures.
ALTER TYPE "JobStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
