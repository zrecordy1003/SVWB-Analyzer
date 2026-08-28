-- Ranked play uses two mutually exclusive point systems:
--   below Grand Master -> BP only (the result screen shows no CR)
--   Grand Master and above -> MP + CR (the result screen shows no BP)
-- Storing MP separately from BP keeps later analysis from having to guess which
-- system a given number came from.
ALTER TABLE "Match" ADD COLUMN "mp" INTEGER;

ALTER TABLE "Match" ADD COLUMN "delta_mp" INTEGER;
