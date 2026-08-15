ALTER TABLE "profile_record"
ADD COLUMN "last_device_id" TEXT NOT NULL DEFAULT 'legacy-unknown';

ALTER TABLE "profile_record"
ALTER COLUMN "last_device_id" DROP DEFAULT;
