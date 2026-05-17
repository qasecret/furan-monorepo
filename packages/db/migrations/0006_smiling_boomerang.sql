ALTER TABLE "projects" ALTER COLUMN "image_comparison" SET DEFAULT 'odiff';--> statement-breakpoint
UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch';