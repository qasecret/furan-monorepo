CREATE TYPE "public"."run_status" AS ENUM (
  'new','running','passed','unresolved','failed','aborted','empty'
);
--> statement-breakpoint
ALTER TABLE "test_runs"
  ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "test_runs"
  ALTER COLUMN "status" TYPE "public"."run_status" USING (
    CASE
      WHEN status = 'failed'   THEN 'unresolved'::run_status
      WHEN status = 'ok'       THEN 'passed'::run_status
      WHEN status IN ('new','running','passed','unresolved','aborted','empty')
                              THEN status::run_status
      WHEN status IS NULL      THEN 'running'::run_status
      ELSE                          'aborted'::run_status
    END
  );
--> statement-breakpoint
ALTER TABLE "test_runs"
  ALTER COLUMN "status" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "test_runs"
  ALTER COLUMN "status" SET DEFAULT 'running';
