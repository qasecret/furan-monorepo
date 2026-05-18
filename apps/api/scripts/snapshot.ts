import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import stringify from "json-stable-stringify";

import { generateOpenApiDocument } from "../src/openapi/generator.js";

const outPath = fileURLToPath(
  new URL("../openapi.snapshot.json", import.meta.url),
);

const doc = generateOpenApiDocument();
const json = stringify(doc, { space: 2 });
if (json === undefined) {
  throw new Error("openapi document failed to serialize");
}
writeFileSync(outPath, json + "\n");

console.log(`openapi.snapshot.json written (${json.length} bytes)`);
