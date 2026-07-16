# Task: Mini in-memory Todo HTTP API

Empty workspace. Build a tiny HTTP todo API in TypeScript (no Express required — Node/Bun `http` is fine).

## Requirements

1. Scaffold `package.json` (type module), `tsconfig.json` (strict), scripts:
   - `"build": "tsc"`
   - `"test": "bun test"`
   - optional `"start": "bun src/server.ts"` or similar
2. Implement an in-memory store + HTTP handlers:

### Data model
```ts
type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: string; // ISO
};
```

### Routes (JSON)
| Method | Path | Behavior |
|--------|------|----------|
| GET | `/health` | `{ ok: true }` |
| GET | `/todos` | list all todos |
| POST | `/todos` | body `{ title: string }` → create, 201 |
| PATCH | `/todos/:id` | body `{ title?: string, done?: boolean }` → update or 404 |
| DELETE | `/todos/:id` | delete or 404 |

3. Export pure helpers (store functions or a `createApp()` / `handleRequest(req)` style) so tests do not need a live port if possible. You may also spin up a server in tests.
4. Tests covering create/list/patch/delete/health and 404 paths.
5. Run tests until green.

## Constraints

- Keep it under ~4 source files if possible (`store`, `router`/`handlers`, `server`, tests).
- Use tools; prefer `check` for typecheck when available.
- Do not leave the server hanging forever in the background without need.

## Done when

- [ ] All five routes work
- [ ] Tests pass
- [ ] Build/typecheck clean enough for tests
