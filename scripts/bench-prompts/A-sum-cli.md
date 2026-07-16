# Task: TypeScript sum CLI

You are in an empty workspace. Build a small TypeScript CLI project from scratch.

## Requirements

1. Create `package.json` with name `sum-cli`, type `module`, scripts:
   - `"build": "tsc"`
   - `"test": "bun test"` (or node test runner if you prefer, but make `npm test` / `bun test` work)
2. Create `tsconfig.json` targeting modern ES, `strict: true`, outDir `dist`, rootDir `src`.
3. Implement `src/index.ts` (or `src/sum.ts` + thin CLI):
   - Export `sum(nums: number[]): number` that adds numbers.
   - CLI: read numbers from `process.argv.slice(2)`, print the sum, exit 0.
   - If no args or non-numeric arg, print a short usage message to stderr and exit 1.
4. Add at least one test file (e.g. `src/sum.test.ts` or `test/sum.test.ts`) that covers:
   - empty list → 0
   - several positives
   - negatives mixed in
5. Run the tests and ensure they pass. Prefer the `check` tool for typecheck if available; use shell for `bun test` / `npm test`.

## Constraints

- Use tools (list_dir, write, search_replace, run_terminal_command, etc.). Do not invent file contents you never wrote.
- Keep the project minimal — no frameworks.
- Prefer specialized tools over shell when they exist (e.g. `check` over raw `tsc` if present).

## Done when

- [ ] `package.json` + `tsconfig.json` exist
- [ ] CLI sums argv numbers
- [ ] Tests pass
- [ ] Typecheck/build is clean enough to run tests
