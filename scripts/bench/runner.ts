/**
 * Tiny benchmark runner — timing, assertions, suite reporting.
 */

export type Status = "pass" | "fail" | "skip";

export interface CaseResult {
  suite: string;
  name: string;
  status: Status;
  ms: number;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface SuiteResult {
  name: string;
  cases: CaseResult[];
  ms: number;
}

export interface BenchReport {
  startedAt: string;
  suites: SuiteResult[];
  totalMs: number;
  passed: number;
  failed: number;
  skipped: number;
}

export class BenchAssertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchAssertError";
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new BenchAssertError(msg);
}

export function assertEq<T>(a: T, b: T, msg?: string): void {
  if (a !== b) {
    throw new BenchAssertError(
      msg ?? `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`,
    );
  }
}

export function assertIncludes(hay: string, needle: string, msg?: string): void {
  if (!hay.includes(needle)) {
    throw new BenchAssertError(
      msg ?? `expected to include ${JSON.stringify(needle)}, got ${JSON.stringify(hay.slice(0, 200))}`,
    );
  }
}

export function assertGt(n: number, min: number, msg?: string): void {
  if (!(n > min)) {
    throw new BenchAssertError(msg ?? `expected ${n} > ${min}`);
  }
}

export function assertGte(n: number, min: number, msg?: string): void {
  if (!(n >= min)) {
    throw new BenchAssertError(msg ?? `expected ${n} >= ${min}`);
  }
}

export type CaseFn = () => void | Promise<void | Record<string, unknown>>;

export class Suite {
  readonly cases: Array<{ name: string; fn: CaseFn }> = [];
  constructor(public readonly name: string) {}

  test(name: string, fn: CaseFn): this {
    this.cases.push({ name, fn });
    return this;
  }

  async run(): Promise<SuiteResult> {
    const t0 = Date.now();
    const out: CaseResult[] = [];
    for (const c of this.cases) {
      const start = Date.now();
      try {
        const detail = await c.fn();
        out.push({
          suite: this.name,
          name: c.name,
          status: "pass",
          ms: Date.now() - start,
          detail: detail ?? undefined,
        });
        process.stdout.write(`  ✓ ${c.name} (${Date.now() - start}ms)\n`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        out.push({
          suite: this.name,
          name: c.name,
          status: "fail",
          ms: Date.now() - start,
          error,
        });
        process.stdout.write(`  ✗ ${c.name} (${Date.now() - start}ms) — ${error}\n`);
      }
    }
    return { name: this.name, cases: out, ms: Date.now() - t0 };
  }
}

export async function runSuites(suites: Suite[]): Promise<BenchReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results: SuiteResult[] = [];
  for (const s of suites) {
    process.stdout.write(`\n━━ ${s.name} ━━\n`);
    results.push(await s.run());
  }
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const s of results) {
    for (const c of s.cases) {
      if (c.status === "pass") passed++;
      else if (c.status === "fail") failed++;
      else skipped++;
    }
  }
  return {
    startedAt,
    suites: results,
    totalMs: Date.now() - t0,
    passed,
    failed,
    skipped,
  };
}

export function printReport(r: BenchReport): void {
  console.log("\n════════ BENCH SUMMARY ════════");
  console.log(
    `passed=${r.passed} failed=${r.failed} skipped=${r.skipped} totalMs=${r.totalMs}`,
  );
  for (const s of r.suites) {
    const p = s.cases.filter((c) => c.status === "pass").length;
    const f = s.cases.filter((c) => c.status === "fail").length;
    console.log(
      `  ${s.name.padEnd(28)} ${String(p).padStart(3)} pass  ${String(f).padStart(3)} fail  ${s.ms}ms`,
    );
  }
  if (r.failed) {
    console.log("\n── Failures ──");
    for (const s of r.suites) {
      for (const c of s.cases.filter((x) => x.status === "fail")) {
        console.log(`  [${s.name}] ${c.name}: ${c.error}`);
      }
    }
  }
}
