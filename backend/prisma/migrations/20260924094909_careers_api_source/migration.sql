-- CAREERS_API: an employer's own careers-site JSON, read by careers-api.connector.ts, for
-- employers whose ATS has no public board (Atlassian on iCIMS, MakeMyTrip on Darwinbox).
--
-- The differ's two `DROP INDEX ..._embedding_hnsw_idx` lines were deleted from this file
-- by hand, as in every migration since the vector indexes were added - see the tracker
-- migration for why applying them would be a silent performance regression.

-- AlterEnum
ALTER TYPE "AtsType" ADD VALUE 'CAREERS_API';
