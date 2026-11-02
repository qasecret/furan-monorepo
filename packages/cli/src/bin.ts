#!/usr/bin/env node
import { main } from "./main.js";

// The first Ctrl-C (or SIGTERM) aborts: tests still open are aborted and the
// process exits 130. A second one exits at once.
const controller = new AbortController();
const onSignal = (signal: NodeJS.Signals): void => {
  if (controller.signal.aborted) process.exit(130);
  controller.abort(new Error(`interrupted (${signal})`));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  signal: controller.signal,
});
