CREATE TABLE "mutation_dedup" (
    "subject" TEXT NOT NULL,
    "mutation_id" UUID NOT NULL,
    "mutation_hash" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mutation_dedup_pkey" PRIMARY KEY ("subject", "mutation_id")
);

INSERT INTO "mutation_dedup" ("subject", "mutation_id", "mutation_hash", "revision", "created_at")
SELECT "subject", "mutation_id", "mutation_hash", "revision", "created_at"
FROM "mutation_receipt";

ALTER TABLE "mutation_dedup"
ADD CONSTRAINT "mutation_dedup_subject_fkey"
FOREIGN KEY ("subject") REFERENCES "user_sync_state"("subject")
ON DELETE CASCADE ON UPDATE CASCADE;
