/**
 * Runs the e2e suites in parallel, each with its own port range (E2E_PORT_BASE) so they can't collide.
 *
 *   npm run e2e                       all suites
 *   npm run e2e -- snap locks         just those
 *   npm run e2e -- --jobs 2           limit concurrency (default: half the CPUs, 1–4; software GL is CPU-hungry and screenshots time out when oversubscribed)
 *
 * Output of each suite goes to .e2e/logs/<suite>.log; a failing suite's log tail is printed.
 * Exits non-zero if any suite fails.
 */
import { spawn } from "node:child_process";
import { mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Slowest first, so the long ones start immediately and short ones fill the gaps.
import { ALL } from "./select.mjs";

const args = process.argv.slice(2);
let jobs = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jobs") jobs = Math.max(1, Number(args[++i]) || 1);
  else names.push(args[i]);
}
const suites = names.length ? names : ALL;
for (const s of suites) {
  if (ALL.includes(s)) continue;
  console.error(`unknown suite: ${s} (have: ${ALL.join(", ")})`);
  process.exit(2);
}

// Per-suite wall-clock limit and the point after which failed suites are no longer retried (both in minutes).
const SUITE_LIMIT_MS = (Number(process.env.E2E_SUITE_MINUTES) || 20) * 60000;
const RETRY_UNTIL_MS = (Number(process.env.E2E_RETRY_UNTIL_MINUTES) || 22) * 60000;
const MAX_RETRIES = Number(process.env.E2E_MAX_RETRIES ?? 3);
const LOGS = path.resolve(".e2e/logs");
mkdirSync(LOGS, { recursive: true });
const t00 = Date.now();
const results = [];

function runSuite(name, index) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const logFile = path.join(LOGS, `${name}.log`);
    const log = createWriteStream(logFile);
    const child = spawn(process.execPath, ["--import", "tsx", "--import", path.join(HERE, "ci-timeouts.mjs"), path.join(HERE, `${name}.mjs`)], {
      env: { ...process.env, E2E_PORT_BASE: String(20000 + index * 20) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A suite that hangs must not eat the whole CI budget: kill it and report it as failed.
    const killer = setTimeout(() => { log.write(`\nE2E: suite exceeded ${SUITE_LIMIT_MS / 60000} min, killed\n`); child.kill("SIGKILL"); }, SUITE_LIMIT_MS);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("close", (code) => {
      clearTimeout(killer);
      log.end();
      const secs = (Date.now() - t0) / 1000;
      const summary = (readFileSync(logFile, "utf8").match(/\d+\/\d+ checks passed/g) ?? []).pop() ?? "";
      const timedOut = code !== 0 && /Timeout \d+ms exceeded/.test(readFileSync(logFile, "utf8"));
      results.push({ name, code, secs, summary, timedOut });
      console.log(`${code === 0 ? "PASS" : "FAIL"} ${name.padEnd(12)} ${secs.toFixed(1).padStart(6)}s  ${summary}`);
      if (code !== 0) console.log(readFileSync(logFile, "utf8").split("\n").filter((l) => /✗|Error|threw/.test(l)).slice(-15).join("\n") + `\n  full log: ${logFile}`);
      resolve();
    });
  });
}

const queue = suites.map((name, i) => [name, i]);
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) await runSuite(...next);
}));
// Software-GL browsers time out on screenshots when suites compete for CPU: give each failed suite
// one more go on its own before calling it failed.
// Only when suites really did compete (jobs > 1 and more than one suite), and only the ones that timed out:
// a deterministic failure fails the same way again, so retrying it just doubles the runtime.
// Retries are bounded so they can't multiply the runtime: at most MAX_RETRIES suites, and none once the run
// is already past RETRY_UNTIL_MS (a run that slow has a machine problem, not a flaky suite).
const wantRetry = jobs > 1 && suites.length > 1 ? results.filter((r) => r.code !== 0 && r.timedOut).map((r) => r.name) : [];
const retry = Date.now() - t00 > RETRY_UNTIL_MS ? [] : wantRetry.slice(0, MAX_RETRIES);
if (wantRetry.length > retry.length) console.log(`\nNot retrying (limit): ${wantRetry.filter((n) => !retry.includes(n)).join(", ")}`);
if (retry.length) {
  console.log(`\nRetrying alone: ${retry.join(", ")}`);
  for (const name of retry) {
    results.splice(results.findIndex((r) => r.name === name), 1);
    await runSuite(name, suites.indexOf(name));
  }
}
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} suites passed in ${((Date.now() - t00) / 1000).toFixed(1)}s (${jobs} parallel)`);
process.exit(failed.length ? 1 : 0);
