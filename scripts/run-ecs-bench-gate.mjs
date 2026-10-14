import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const contractOnly = args.has("--contract-only");
const requirePlatform = args.has("--require-platform") || process.env.LEARNVIS_REQUIRE_BENCH_PLATFORM === "1";
const attemptsArg = process.argv.find((arg) => arg.startsWith("--attempts="));
const thresholdArg = process.argv.find((arg) => arg.startsWith("--threshold="));
const worstArg = process.argv.find((arg) => arg.startsWith("--worst="));
const thresholdAverage = Number(thresholdArg?.slice("--threshold=".length) ?? "-15");
const thresholdWorst = Number(worstArg?.slice("--worst=".length) ?? "-25");
const baselineRelative = full
  ? "__tests__/ecs.bench-snapshot.json"
  : "__tests__/ecs.bench-snapshot-10k.json";
const harnessPath = resolve(root, "__tests__/ecs.bench.ts");
const manifestPath = resolve(root, "scripts/ecs-bench-platforms.json");
const baselinePath = resolve(root, baselineRelative);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const policy = manifest.baselines?.[baselineRelative];
const baselineBytes = readFileSync(baselinePath);
const baseline = JSON.parse(baselineBytes.toString("utf8"));
const harnessBytes = readFileSync(harnessPath);
const errors = [];

const isDestructiveCase = (name) => name.startsWith("destroy:") || name.startsWith("removeComponent:");
const destructiveCases = policy?.cases?.filter(isDestructiveCase) ?? [];
const isolatedCases = policy?.isolateAllCases === true ? (policy?.cases ?? []) : destructiveCases;
const batchCases = policy?.cases?.filter((name) => !isolatedCases.includes(name)) ?? [];

function fail(message) {
  errors.push(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function splitPerformanceModes(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  let splitIndex = -1;
  let largestRatio = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i - 1] <= 0) continue;
    const currentRatio = sorted[i] / sorted[i - 1];
    if (currentRatio > largestRatio) {
      largestRatio = currentRatio;
      splitIndex = i;
    }
  }
  if (
    largestRatio >= ratio &&
    splitIndex >= Math.max(2, Math.ceil(sorted.length * 0.2)) &&
    sorted.length - splitIndex >= Math.max(2, Math.ceil(sorted.length * 0.2))
  ) {
    return { fast: sorted.slice(0, splitIndex), slow: sorted.slice(splitIndex), ratio: largestRatio };
  }
  return { fast: sorted, slow: [], ratio: largestRatio };
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapMedianDelta(current, head, iterations = 5000) {
  const random = createRng(0x5eed);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const deltas = [];
  for (let i = 0; i < iterations; i++) {
    const currentSample = Array.from({ length: current.length }, () => pick(current));
    const headSample = Array.from({ length: head.length }, () => pick(head));
    const currentMedian = median(currentSample);
    const headMedian = median(headSample);
    deltas.push(((headMedian - currentMedian) / headMedian) * 100);
  }
  deltas.sort((a, b) => a - b);
  const at = (p) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor((deltas.length - 1) * p)))];
  return { lower20: at(0.2), median: at(0.5), upper80: at(0.8) };
}

function validatePolicy() {
  if (!policy) {
    fail(`missing platform policy for ${baselineRelative}`);
    return;
  }
  if (policy.version !== 2 || policy.comparison !== "head-vs-working-tree") {
    fail(`platform policy must be version=2 comparison=head-vs-working-tree`);
  }
  if (policy.isolateDestructiveCases !== true) {
    fail(`platform policy must isolate destructive cases into one process per case`);
  }
  if (!(policy.modeSplitRatio >= 1.2)) {
    fail(`platform policy modeSplitRatio must be >= 1.2`);
  }
  if (policy.platform === "darwin" && JSON.stringify(policy.taskPolicy) !== JSON.stringify(["-t", "0", "-l", "0"])) {
    fail(`darwin platform policy must pin taskpolicy to ${JSON.stringify(["-t", "0", "-l", "0"])}`);
  }
  const baselineHash = sha256(baselineBytes);
  const expectedBaselineHash = policy.baselineSha256 ?? policy.sha256;
  if (baselineHash !== expectedBaselineHash) {
    fail(`baseline hash changed: ${baselineHash} != ${expectedBaselineHash}; do not overwrite the ECS baseline without review`);
  }
  const harnessHash = sha256(harnessBytes);
  if (harnessHash !== policy.harnessSha256) {
    fail(`benchmark harness hash changed: ${harnessHash} != ${policy.harnessSha256}; update scripts/ecs-bench-platforms.json with an explicit review`);
  }
  for (const key of ["runtime", "mode", "N", "iter", "samples"]) {
    if (baseline[key] !== policy[key]) {
      fail(`baseline ${key}=${baseline[key]} but platform policy has ${policy[key]}`);
    }
  }
  const baselineCases = baseline.results?.map((row) => row.name) ?? [];
  if (baselineCases.length !== policy.cases.length) {
    fail(`baseline case count ${baselineCases.length} != policy ${policy.cases.length}`);
  }
  for (const name of policy.cases) {
    if (!baselineCases.includes(name)) fail(`baseline missing policy case: ${name}`);
  }
  for (const name of baselineCases) {
    if (!policy.cases.includes(name)) fail(`baseline has non-policy case: ${name}`);
  }
}

function makeHeadSource() {
  const dir = mkdtempSync(join(tmpdir(), "zero-ecs-head-"));
  const archivePath = join(dir, "head.tar");
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD", "src"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    fail(`cannot archive HEAD ECS source: ${archive.stderr.toString().trim()}`);
    return null;
  }
  writeFileSync(archivePath, archive.stdout);
  const extract = spawnSync("tar", ["-xf", archivePath, "-C", dir], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (extract.status !== 0) {
    fail(`cannot extract HEAD ECS source: ${(extract.stderr || extract.stdout).trim()}`);
    return null;
  }
  return {
    dir,
    url: pathToFileURL(join(dir, "src/index.ts")).href,
  };
}

function parseHarness(stdout) {
  const line = stdout.split("\n").find((entry) => entry.startsWith("BENCH_JSON "));
  if (!line) throw new Error("benchmark did not emit BENCH_JSON");
  return JSON.parse(line.slice("BENCH_JSON ".length));
}

function runHarness(sourceUrl, selectedCases) {
  const bunArgs = [harnessPath, "--json", ...(full ? ["--full"] : [])];
  const command = process.platform === "darwin" ? "taskpolicy" : "bun";
  const commandArgs = process.platform === "darwin"
    ? ["-t", "0", "-l", "0", "bun", ...bunArgs]
    : bunArgs;
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      ECS_BENCH_SOURCE_URL: sourceUrl,
      ECS_BENCH_CASE: JSON.stringify(selectedCases),
    },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`benchmark exited ${result.status}`);
  }
  return parseHarness(result.stdout);
}

function validateRun(run, label, selectedCases) {
  for (const key of ["runtime", "mode", "N", "iter", "samples"]) {
    if (run[key] !== baseline[key]) {
      fail(`${label} ${key}=${run[key]} != baseline ${baseline[key]}`);
    }
  }
  const names = run.results?.map((row) => row.name) ?? [];
  const missing = policy.cases.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !policy.cases.includes(name));
  if (missing.length > 0) fail(`${label} missing benchmark cases: ${missing.join(", ")}`);
  if (extra.length > 0) fail(`${label} extra benchmark cases: ${extra.join(", ")}`);
  if (names.length !== policy.cases.length) fail(`${label} case count ${names.length} != ${policy.cases.length}`);

  const expectedSelected = new Set(selectedCases);
  const reportedSelected = new Set(run.selectedCases ?? []);
  if (reportedSelected.size !== expectedSelected.size || [...expectedSelected].some((name) => !reportedSelected.has(name))) {
    fail(`${label} selected case mismatch: ${JSON.stringify(run.selectedCases)}`);
  }

  for (const row of run.results ?? []) {
    if (expectedSelected.has(row.name)) {
      if (!Array.isArray(row.samples) || row.samples.length !== run.samples) {
        fail(`${label} case ${row.name} has invalid raw samples`);
        continue;
      }
      for (const sample of row.samples) {
        if (!Number.isFinite(sample.usPerIter) || sample.usPerIter <= 0) {
          fail(`${label} case ${row.name} has invalid sample value`);
        }
        if (row.destructive && (!Array.isArray(sample.iterationNs) || sample.iterationNs.length !== run.iter)) {
          fail(`${label} destructive case ${row.name} missing per-iteration samples`);
        }
      }
    } else if (!Array.isArray(row.samples) || row.samples.length !== 0) {
      fail(`${label} unselected case ${row.name} ran unexpectedly`);
    }
  }
}

function runPair(selectedCases, headRuns, currentRuns, currentFirst) {
  if (currentFirst) {
    currentRuns.push(runHarness(currentSourceUrl, selectedCases));
    headRuns.push(runHarness(headSource.url, selectedCases));
  } else {
    headRuns.push(runHarness(headSource.url, selectedCases));
    currentRuns.push(runHarness(currentSourceUrl, selectedCases));
  }
}

function collectCaseSamples(runs, name) {
  const samples = [];
  const iterationNs = [];
  let destructive = false;
  for (const run of runs) {
    const row = run.results.find((entry) => entry.name === name);
    if (!row) continue;
    destructive = row.destructive === true;
    for (const sample of row.samples) {
      samples.push(sample.usPerIter);
      if (Array.isArray(sample.iterationNs) && sample.iterationNs.length > 0) {
        iterationNs.push(...sample.iterationNs);
      }
    }
  }
  return { samples, iterationNs, destructive };
}

validatePolicy();
if (errors.length > 0) {
  for (const error of errors) console.error(`[bench:ecs] error: ${error}`);
  process.exit(1);
}

const host = {
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model ?? "unknown",
  runtime: `Bun ${process.versions.bun ?? "unknown"}`,
};
const platformMatches =
  host.platform === policy.platform &&
  host.arch === policy.arch &&
  host.cpu === policy.cpu &&
  host.runtime === policy.runtime;

console.log(
  `[bench:ecs] reference=HEAD ${policy.referenceCommit ?? "unknown"} current=working-tree comparison=head-vs-working-tree`,
);
console.log(
  `[bench:ecs] baseline=${baselineRelative} cases=${policy.cases.length} isolated=${isolatedCases.length} batch=${batchCases.length}`,
);
console.log(
  `[bench:ecs] policyPlatform=${policy.platform}/${policy.arch}/${policy.cpu} runtime=${policy.runtime}`,
);
console.log(
  `[bench:ecs] host=${host.platform}/${host.arch}/${host.cpu} runtime=${host.runtime} match=${platformMatches}`,
);

if (!platformMatches && requirePlatform) {
  console.error("[bench:ecs] FAIL: absolute throughput gate requires an exact baseline platform; refusing to compare");
  process.exit(1);
}

const headSource = makeHeadSource();
if (!headSource) {
  for (const error of errors) console.error(`[bench:ecs] error: ${error}`);
  process.exit(1);
}

const currentSourceUrl = pathToFileURL(resolve(root, "src/index.ts")).href;
const attemptCount = contractOnly || !platformMatches
  ? 1
  : Math.max(1, Number.parseInt(attemptsArg?.slice("--attempts=".length) ?? String(policy.gateAttempts), 10) || policy.gateAttempts);
const batchRuns = { head: [], current: [] };
const isolatedRuns = new Map(
  isolatedCases.map((name) => [name, { head: [], current: [] }]),
);

try {
  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    console.log(`[bench:ecs] sample ${attempt}/${attemptCount}`);
    if (batchCases.length > 0) {
      runPair(batchCases, batchRuns.head, batchRuns.current, attempt % 2 === 1);
    }
    for (const [index, name] of isolatedCases.entries()) {
      const runs = isolatedRuns.get(name);
      runPair([name], runs.head, runs.current, (attempt + index) % 2 === 0);
    }
  }

  if (batchCases.length > 0) {
    for (const [index, run] of batchRuns.current.entries()) validateRun(run, `current/batch#${index + 1}`, batchCases);
    for (const [index, run] of batchRuns.head.entries()) validateRun(run, `head/batch#${index + 1}`, batchCases);
  }
  for (const name of isolatedCases) {
    const runs = isolatedRuns.get(name);
    for (const [index, run] of runs.current.entries()) validateRun(run, `current/${name}#${index + 1}`, [name]);
    for (const [index, run] of runs.head.entries()) validateRun(run, `head/${name}#${index + 1}`, [name]);
  }
  if (errors.length > 0) throw new Error("benchmark contract mismatch");

  if (contractOnly || !platformMatches) {
    console.log(
      `[bench:ecs] STRUCTURAL PASS; ABSOLUTE COMPARISON ${contractOnly ? "SKIPPED (--contract-only)" : `NOT RUN (host does not match ${policy.platform}/${policy.arch}/${policy.cpu})`}`,
    );
    process.exit(0);
  }

  const comparisons = [];
  const raw = { head: {}, current: {} };
  for (const name of policy.cases) {
    const runs = isolatedCases.includes(name) ? isolatedRuns.get(name) : batchRuns;
    const current = collectCaseSamples(runs.current, name);
    const head = collectCaseSamples(runs.head, name);
    const destructive = current.destructive || head.destructive;
    const currentModes = destructive
      ? splitPerformanceModes(current.samples, policy.modeSplitRatio)
      : { fast: current.samples, slow: [], ratio: 1 };
    const headModes = destructive
      ? splitPerformanceModes(head.samples, policy.modeSplitRatio)
      : { fast: head.samples, slow: [], ratio: 1 };
    const currentComparable = currentModes.fast;
    const headComparable = headModes.fast;
    const currentMedian = median(currentComparable);
    const headMedian = median(headComparable);
    const medianChangePct = ((headMedian - currentMedian) / headMedian) * 100;
    const confidence = bootstrapMedianDelta(currentComparable, headComparable);
    comparisons.push({
      name,
      destructive,
      currentMedian,
      headMedian,
      medianChangePct,
      lower20: confidence.lower20,
      bootstrapMedian: confidence.median,
      upper80: confidence.upper80,
      stable: headMedian >= 20,
      currentModeSamples: currentComparable.length,
      headModeSamples: headComparable.length,
      currentSlowSamples: currentModes.slow.length,
      headSlowSamples: headModes.slow.length,
      splitRatio: Math.max(currentModes.ratio, headModes.ratio),
    });
    raw.head[name] = head.samples;
    raw.current[name] = current.samples;
  }

  const averageMedian =
    comparisons.reduce((sum, row) => sum + row.medianChangePct, 0) / comparisons.length;
  const averageLower20 =
    comparisons.reduce((sum, row) => sum + row.lower20, 0) / comparisons.length;
  const stable = comparisons.filter((row) => row.stable);
  const worstMedian = stable.reduce((worst, row) => Math.min(worst, row.medianChangePct), 0);
  const worstLower20 = stable.reduce((worst, row) => Math.min(worst, row.lower20), 0);

  console.log(`[bench:ecs] raw-samples ${JSON.stringify(raw)}`);
  if (policy.emitIterationSamples === true) {
    const iterationRaw = { head: {}, current: {} };
    for (const name of isolatedCases) {
      const runs = isolatedRuns.get(name);
      iterationRaw.head[name] = collectCaseSamples(runs.head, name).iterationNs;
      iterationRaw.current[name] = collectCaseSamples(runs.current, name).iterationNs;
    }
    console.log(`[bench:ecs] raw-iteration-samples ${JSON.stringify(iterationRaw)}`);
  }
  console.log("\n[bench:ecs] HEAD vs working tree");
  for (const row of comparisons) {
    const sign = row.medianChangePct >= 0 ? "+" : "";
    console.log(
      `  ${row.name.padEnd(52)} head=${row.headMedian.toFixed(1).padStart(8)}µs current=${row.currentMedian.toFixed(1).padStart(8)}µs ${sign}${row.medianChangePct.toFixed(1)}% lower20=${row.lower20 >= 0 ? "+" : ""}${row.lower20.toFixed(1)}% mode=${row.headModeSamples}/${row.currentModeSamples} slow=${row.headSlowSamples}/${row.currentSlowSamples}${row.destructive ? " destructive/isolated" : ""}`,
    );
  }
  console.log(`  average median ${averageMedian >= 0 ? "+" : ""}${averageMedian.toFixed(1)}%`);
  console.log(`  average lower20 ${averageLower20 >= 0 ? "+" : ""}${averageLower20.toFixed(1)}%`);
  console.log(`  worst stable median ${worstMedian >= 0 ? "+" : ""}${worstMedian.toFixed(1)}%`);
  console.log(`  worst stable lower20 ${worstLower20 >= 0 ? "+" : ""}${worstLower20.toFixed(1)}%`);

  if (averageMedian < thresholdAverage) fail(`average median ${averageMedian.toFixed(1)}% < ${thresholdAverage}%`);
  if (averageLower20 < thresholdWorst) fail(`average lower20 ${averageLower20.toFixed(1)}% < ${thresholdWorst}%`);
  if (worstMedian < thresholdWorst) fail(`worst stable median ${worstMedian.toFixed(1)}% < ${thresholdWorst}%`);
  if (errors.length > 0) throw new Error(errors.join("; "));
  console.log("[bench:ecs] ABSOLUTE GATE PASS");
} catch (error) {
  for (const message of errors.length > 0 ? errors : [error.message]) {
    console.error(`[bench:ecs] error: ${message}`);
  }
  process.exit(1);
} finally {
  rmSync(headSource.dir, { recursive: true, force: true });
}
