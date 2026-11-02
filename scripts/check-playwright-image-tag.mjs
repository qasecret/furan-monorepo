#!/usr/bin/env node
// Guards against a Playwright base-image / npm-package mismatch in
// apps/capture-worker. The runtime stage runs on
// mcr.microsoft.com/playwright:vX.Y.Z-<distro>, which ships only the browser
// builds of Playwright X.Y.Z under /ms-playwright, and the Dockerfile skips
// Playwright's own browser download. Each npm `playwright` release looks for
// its own browser revision (/ms-playwright/chromium_headless_shell-<rev>), so
// when the lockfile moves past the image tag `chromium.launch()` fails in the
// container with "Executable doesn't exist" — while CI stays green, because CI
// installs the matching browser itself. This fails CI when the image tag and
// the capture-worker's locked `playwright` version disagree, so a Dependabot
// bump of `playwright` has to bump the FROM line in the same PR.
//
// Deterministic + repo-only (no registry calls).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(
  join(root, "apps/capture-worker/Dockerfile"),
  "utf8",
);
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");

const fail = (msg) => {
  console.error(`check-playwright-image-tag: ${msg}`);
  process.exit(1);
};

const from =
  /^FROM\s+mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-\S+/m.exec(
    dockerfile,
  );
if (!from) {
  fail(
    "no `FROM mcr.microsoft.com/playwright:vX.Y.Z-<distro>` line in apps/capture-worker/Dockerfile — did the base image change?",
  );
}
const imageVersion = from[1];

// The capture-worker importer's own resolution, not any other `playwright`
// in the lockfile (e2e or a future package may pin a different one).
const importer =
  /^ {2}apps\/capture-worker:\n((?: {4}.*\n|\n)*)/m.exec(lockfile)?.[1] ?? "";
const locked =
  /^ {6}playwright:\n {8}specifier: .*\n {8}version: ([^\s(]+)/m.exec(importer);
if (!locked) {
  fail(
    "no `playwright` dependency under importers › apps/capture-worker in pnpm-lock.yaml — did the lockfile layout change?",
  );
}
const lockedVersion = locked[1];

if (imageVersion !== lockedVersion) {
  fail(
    `apps/capture-worker/Dockerfile runs on mcr.microsoft.com/playwright:v${imageVersion}, but pnpm-lock.yaml resolves the capture-worker's playwright to ${lockedVersion}. ` +
      `Playwright ${lockedVersion} cannot find v${imageVersion}'s browsers: bump the FROM tag to v${lockedVersion}-<distro>.`,
  );
}

console.log(
  `check-playwright-image-tag: OK — capture-worker image and lockfile both on Playwright ${lockedVersion}`,
);
