/**
 * Coalesced draw/emit scheduler — TS port of codex-cli's
 * `FrameRequester` / `FrameScheduler` / `FrameRateLimiter` actor pair
 * (codex-rs/tui/src/tui/frame_requester.rs, frame_rate_limiter.rs).
 *
 * The upstream design: callers never call `paint()` (or "emit a snapshot",
 * or anything else) directly. They call `scheduleFrame()` / `scheduleIn(ms)`
 * as often as they like — once per keystroke, once per stream delta, once
 * per parallel subagent round — and a single actor coalesces every request
 * that lands before the next deadline into ONE callback, rate-limited to a
 * configurable ceiling.
 *
 * Two properties fall out of that shape that a naive `setTimeout`-per-call
 * approach doesn't give you for free:
 *   1. N requests in a burst -> 1 callback (not N), because a pending
 *      timer is rescheduled forward only if the new deadline is earlier.
 *   2. The ceiling is enforced at emit time, not request time, so bursts
 *      right after a callback still collapse into the next allowed slot
 *      instead of firing immediately and again a moment later.
 *
 * This same primitive is reused for two different call sites in Libra:
 *   - `TuiRenderer` uses one at ~60fps to replace the old manual
 *     `paintRaf` / `PAINT_MIN_MS` throttle + always-on 50ms `setInterval`.
 *   - `SubagentRuntime` uses one at ~6Hz to coalesce per-round
 *     onUsage/onPhase hook callbacks from N parallel child agents into a
 *     single bounded `agent.snapshot` event, instead of pushing a store
 *     update per subagent round.
 */

export interface CoalescedSchedulerOptions {
  /** Ceiling on how often `onFire` may run, in calls/sec. */
  maxHz: number;
  /** Invoked at most once per coalesced batch, no more than `maxHz` times/sec. */
  onFire: () => void;
}

/**
 * Remembers the most recent fire time so a new deadline can be clamped
 * forward to respect the rate ceiling. Direct port of `FrameRateLimiter`.
 */
class RateLimiter {
  private lastFiredAt: number | null = null;

  constructor(private readonly minIntervalMs: number) {}

  /** Returns `requested`, pushed later if it would exceed the rate ceiling. */
  clampDeadline(requested: number): number {
    if (this.lastFiredAt == null) return requested;
    const minAllowed = this.lastFiredAt + this.minIntervalMs;
    return Math.max(requested, minAllowed);
  }

  markFired(at: number): void {
    this.lastFiredAt = at;
  }
}

/**
 * Coalesces many `scheduleFrame()` / `scheduleIn()` requests into a single
 * rate-limited `onFire` callback. Safe to call from hot paths (stream
 * deltas, per-round token hooks, resize handlers, spinner ticks) without
 * worrying about redraw storms — the ceiling and coalescing are handled
 * centrally instead of by every call site re-implementing its own
 * "have I painted too recently?" check.
 */
export class CoalescedScheduler {
  private readonly limiter: RateLimiter;
  private readonly onFire: () => void;
  private timer: NodeJS.Timeout | null = null;
  private nextDeadline: number | null = null;
  private stopped = false;

  constructor(opts: CoalescedSchedulerOptions) {
    this.limiter = new RateLimiter(Math.max(1, Math.floor(1000 / opts.maxHz)));
    this.onFire = opts.onFire;
  }

  /** Request a callback as soon as the rate ceiling allows. */
  scheduleFrame(): void {
    this.scheduleAt(Date.now());
  }

  /** Request a callback no sooner than `ms` from now. */
  scheduleIn(ms: number): void {
    this.scheduleAt(Date.now() + Math.max(0, ms));
  }

  private scheduleAt(requested: number): void {
    if (this.stopped) return;
    const clamped = this.limiter.clampDeadline(requested);
    if (this.nextDeadline != null && this.nextDeadline <= clamped) {
      // Already have an earlier-or-equal callback pending; this request
      // coalesces into it for free.
      return;
    }
    this.nextDeadline = clamped;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, clamped - Date.now());
    this.timer = setTimeout(() => this.fire(), wait);
  }

  private fire(): void {
    this.timer = null;
    const deadline = this.nextDeadline;
    this.nextDeadline = null;
    if (deadline == null || this.stopped) return;
    // Fire first, then mark — so a slow callback doesn't "use up" the slot
    // before work starts, and the next schedule measures from completion.
    // (marking before onFire made long paints look like they started earlier
    // and let the next frame be scheduled during the same turn via overdue timers.)
    try {
      this.onFire();
    } finally {
      this.limiter.markFired(Date.now());
    }
  }

  /** Cancel any pending callback without firing it. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextDeadline = null;
  }

  /** Cancel and permanently stop accepting new schedule requests. */
  stop(): void {
    this.cancel();
    this.stopped = true;
  }
}