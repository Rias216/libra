/**
 * Lightweight latency collector for tool + sample timings.
 * Used by benches and optional debug dumps (p50/p95).
 */

export type LatencyBucket =
  | "tool"
  | "shell"
  | "fs"
  | "search"
  | "sample"
  | "turn"
  | "other";

export interface LatencySample {
  bucket: LatencyBucket;
  name: string;
  ms: number;
  ok?: boolean;
  at: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

export function summarizeMs(samples: number[]): {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
} {
  if (!samples.length) {
    return { n: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

export function bucketForTool(name: string): LatencyBucket {
  if (name === "run_terminal_command" || name === "bash" || name === "process") {
    return "shell";
  }
  if (
    name === "list_dir" ||
    name === "read_file" ||
    name === "write" ||
    name === "search_replace"
  ) {
    return "fs";
  }
  if (name === "grep" || name === "glob") return "search";
  return "tool";
}

export class LatencyCollector {
  private samples: LatencySample[] = [];
  private maxSamples: number;

  constructor(maxSamples = 5_000) {
    this.maxSamples = maxSamples;
  }

  record(
    bucket: LatencyBucket,
    name: string,
    ms: number,
    ok?: boolean,
  ): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push({ bucket, name, ms, ok, at: Date.now() });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  recordTool(name: string, ms: number, ok?: boolean): void {
    this.record(bucketForTool(name), name, ms, ok);
  }

  clear(): void {
    this.samples = [];
  }

  all(): LatencySample[] {
    return [...this.samples];
  }

  byBucket(): Record<string, ReturnType<typeof summarizeMs>> {
    const groups = new Map<string, number[]>();
    for (const s of this.samples) {
      const arr = groups.get(s.bucket) ?? [];
      arr.push(s.ms);
      groups.set(s.bucket, arr);
    }
    const out: Record<string, ReturnType<typeof summarizeMs>> = {};
    for (const [k, v] of groups) out[k] = summarizeMs(v);
    return out;
  }

  byName(): Record<string, ReturnType<typeof summarizeMs>> {
    const groups = new Map<string, number[]>();
    for (const s of this.samples) {
      const arr = groups.get(s.name) ?? [];
      arr.push(s.ms);
      groups.set(s.name, arr);
    }
    const out: Record<string, ReturnType<typeof summarizeMs>> = {};
    for (const [k, v] of groups) out[k] = summarizeMs(v);
    return out;
  }

  summary(): {
    total: ReturnType<typeof summarizeMs>;
    byBucket: Record<string, ReturnType<typeof summarizeMs>>;
    byName: Record<string, ReturnType<typeof summarizeMs>>;
    slowest: LatencySample[];
  } {
    return {
      total: summarizeMs(this.samples.map((s) => s.ms)),
      byBucket: this.byBucket(),
      byName: this.byName(),
      slowest: [...this.samples].sort((a, b) => b.ms - a.ms).slice(0, 20),
    };
  }
}

/** Process-wide collector for agent sessions / benches. */
export const globalLatency = new LatencyCollector();
