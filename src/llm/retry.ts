/**
 * Retry transient LLM / network failures (OpenCode retry spirit).
 */

export interface RetryOptions {
  /** Max attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base delay ms (default 400). */
  baseMs?: number;
  /** Max delay ms (default 8000). */
  maxMs?: number;
  signal?: AbortSignal;
  /** Optional label for logging */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export function isRetryableError(err: unknown): boolean {
  if (err == null) return false;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg) && /signal/i.test(msg)) return false;
  // HTTP status codes in error messages
  if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  if (
    /rate.?limit|timeout|ECONNRESET|ETIMEDOUT|fetch failed|network|overloaded/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/HTTP 5\d\d/.test(msg)) return true;
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const base = opts.baseMs ?? 400;
  const cap = opts.maxMs ?? 8000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= max; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= max || !isRetryableError(err) || opts.signal?.aborted) {
        throw err;
      }
      const jitter = Math.random() * 0.3 + 0.85;
      const delay = Math.min(cap, Math.round(base * 2 ** (attempt - 1) * jitter));
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
