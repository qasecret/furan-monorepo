#!/usr/bin/env node
// Guards against a partial app-image bump. Releases pin all five furan service
// images (api, capture-worker, diff-worker, integrations, dashboard) to the
// SAME tag in infra/docker/compose.yml; a chore(compose) PR that updates only
// some of them ships a mismatched stack where one service runs older code than
// the migrations / its siblings — the exact image-drift class the deploy
// runbook warns about. This fails CI when the five tags disagree.
//
// Deterministic + repo-only (no registry calls), so it never false-positives on
// a normal migration PR (app images are released out-of-band, not per PR).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const composePath = join(root, "infra/docker/compose.yml");
const compose = readFileSync(composePath, "utf8");

const re = /image:\s*docker\.io\/qasecret\/(furan-[a-z-]+):(\S+)/g;
const found = [];
for (const m of compose.matchAll(re)) {
  found.push({ service: m[1], tag: m[2] });
}

if (found.length === 0) {
  console.error(
    "check-compose-image-tags: no docker.io/qasecret/furan-* images found in infra/docker/compose.yml — did the image path change?",
  );
  process.exit(1);
}

const tags = [...new Set(found.map((f) => f.tag))];
if (tags.length !== 1) {
  console.error(
    "check-compose-image-tags: furan service image tags disagree — a release must bump ALL of them together:",
  );
  for (const f of found) console.error(`  ${f.service.padEnd(24)} ${f.tag}`);
  process.exit(1);
}

console.log(
  `check-compose-image-tags: OK — ${found.length} furan images all pinned to ${tags[0]}`,
);
