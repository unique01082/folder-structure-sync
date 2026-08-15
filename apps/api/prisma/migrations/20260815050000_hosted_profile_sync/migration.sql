CREATE TABLE "user_sync_state" (
    "subject" TEXT NOT NULL,
    "epoch" UUID NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_sync_state_pkey" PRIMARY KEY ("subject")
);

CREATE TABLE "profile_record" (
    "subject" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "profile" JSONB,
    "deleted_at" TIMESTAMP(3),
    "revision" BIGINT NOT NULL,
    "committed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "profile_record_pkey" PRIMARY KEY ("subject", "profile_id")
);

CREATE TABLE "sync_change" (
    "subject" TEXT NOT NULL,
    "revision" BIGINT NOT NULL,
    "record" JSONB NOT NULL,
    "committed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sync_change_pkey" PRIMARY KEY ("subject", "revision")
);

CREATE TABLE "mutation_receipt" (
    "subject" TEXT NOT NULL,
    "mutation_id" UUID NOT NULL,
    "revision" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mutation_receipt_pkey" PRIMARY KEY ("subject", "mutation_id")
);

CREATE INDEX "profile_record_subject_revision_idx" ON "profile_record"("subject", "revision");
CREATE INDEX "mutation_receipt_expires_at_idx" ON "mutation_receipt"("expires_at");
ALTER TABLE "profile_record" ADD CONSTRAINT "profile_record_subject_fkey" FOREIGN KEY ("subject") REFERENCES "user_sync_state"("subject") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sync_change" ADD CONSTRAINT "sync_change_subject_fkey" FOREIGN KEY ("subject") REFERENCES "user_sync_state"("subject") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mutation_receipt" ADD CONSTRAINT "mutation_receipt_subject_fkey" FOREIGN KEY ("subject") REFERENCES "user_sync_state"("subject") ON DELETE CASCADE ON UPDATE CASCADE;
