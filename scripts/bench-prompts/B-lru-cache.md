# Task: Typed LRU cache

Empty workspace. Implement a small, well-tested TypeScript LRU (Least Recently Used) cache library.

## Requirements

1. Scaffold `package.json` (type module), `tsconfig.json` (strict), scripts `build` = `tsc`, `test` = `bun test`.
2. Implement `src/lru.ts` exporting class or factory:

```ts
export class LruCache<K, V> {
  constructor(capacity: number)
  get(key: K): V | undefined
  set(key: K, value: V): void
  has(key: K): boolean
  delete(key: K): boolean
  get size(): number
  clear(): void
}
```

Semantics:
- Capacity must be ≥ 1 (throw on invalid).
- `get` marks the key as most-recently used.
- `set` inserts or updates; if over capacity, evict the least-recently used key.
- `delete` / `clear` behave as expected.

3. Tests in `src/lru.test.ts` (or `test/lru.test.ts`) covering at least:
   - basic set/get
   - eviction order after capacity exceeded
   - get refreshes recency (a key that would have been evicted survives if re-gotten)
   - invalid capacity throws

4. Run tests until green. Use tools; verify with `bun test` or `npm test`.

## Constraints

- No external deps beyond what the harness already allows.
- Prefer parallel tool calls for independent reads; batch edits when possible.
- Do not claim tests passed without running them.

## Done when

- [ ] LRU semantics correct
- [ ] Tests pass
- [ ] Project typechecks
