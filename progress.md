# Implementation Progress

**Date**: 2026-07-03  
**Status**: Phase 1 (PRP 01) ✅ COMPLETE | Phase 2 (PRP 02) ✅ COMPLETE

---

## Completed Work

### Phase 1 — PRP 01: Todo CRUD Operations

All files created and all verification gates pass.

**Files created:**
- `package.json` — Next.js 16, React 19, better-sqlite3, jsonwebtoken, Tailwind CSS 4, Vitest, Playwright
- `tsconfig.json` — bundler moduleResolution, @/* alias
- `next.config.ts` — `serverExternalPackages: ['better-sqlite3']`
- `postcss.config.mjs` — `@tailwindcss/postcss`
- `proxy.ts` — route protection (renamed from middleware.ts per Next.js 16 convention)
- `lib/db.ts` — schema, types (`Todo`, `Priority`, `RecurrencePattern`, `CreateTodoBody`, `UpdateTodoBody`, `ApiError`, `ApiResponse<T>`), migration guards, user helpers
- `lib/timezone.ts` — `getSingaporeNow`, `parseDueDateToUtc`, `isDueDateValid`, `formatSingaporeDate`, `formatForDatetimeLocalInput`, `getMinDueDateForPicker`, `formatRelativeDueDate`
- `lib/auth.ts` — JWT session (`getSession`, `createSessionToken`, `SESSION_COOKIE_OPTIONS`)
- `app/layout.tsx`, `app/globals.css` — app shell
- `app/login/page.tsx` — dev-auth login form (replaced by WebAuthn in PRP 11)
- `app/page.tsx` — monolithic client component with all PRP 01+02 UI
- `app/api/auth/dev-login/route.ts` — POST: create user, issue JWT cookie
- `app/api/auth/logout/route.ts` — POST: clear session cookie
- `app/api/todos/route.ts` — POST + GET (with ?priority= filter per PRP 02)
- `app/api/todos/[id]/route.ts` — GET, PUT, DELETE
- `playwright.config.ts` — Chromium, SGT timezone, reuseExistingServer
- `tests/helpers.ts` — `TestHelpers` class (authenticate, createTodo, clearAllTodos)
- `tests/02-todo-crud.spec.ts` — TC-01 through TC-10 + API contract tests
- `tests/03-priority.spec.ts` — TC-P01 through TC-P10 + TC-V01 through TC-V05
- `lib/validation.test.ts` — UT-01 through UT-12 + UT-P01 through UT-P11
- `vitest.config.ts` — node environment, @/* alias

**Test results:**
- Unit tests: **27/27 passing** (UT-01–UT-12, UT-P01–UT-P11)
- E2E PRP 01: **17/17 passing** (TC-01–TC-10 + 7 API contract tests)
- E2E PRP 02: **14/14 passing** (TC-P01–TC-P10 + TC-V01–TC-V05)
- **Total: 58/58 tests passing**

---

### Phase 2 — PRP 02: Priority System

Implemented as part of Phase 1 (columns, `PRIORITY_ORDER`, `PRIORITY_VALUES`, `validatePriority` were already in the foundation).

**Additional files/changes for PRP 02:**
- `lib/db.ts` — `PRIORITY_ORDER`, `PRIORITY_VALUES`, `validatePriority()` exports
- `app/api/todos/route.ts` — `?priority=` filter with allowlist validation
- `app/page.tsx` — `PriorityBadge` with exact color mapping, priority dropdowns in create/edit forms, priority filter dropdown, `useSectionedTodos` with priority-first sort

---

## Deviations from PRPs

### 1. Dev-auth instead of WebAuthn (intentional)
**PRP 01/02 expectation**: Auth is "assumed to be in place".  
**Actual**: `app/api/auth/dev-login/route.ts` provides a username-only auth endpoint for testing. WebAuthn is specified in PRP 11.  
**Impact**: Tests use `page.request.post('/api/auth/dev-login', ...)` instead of virtual WebAuthn authenticators. When PRP 11 is implemented, update `tests/helpers.ts` `authenticate()` method to use the WebAuthn flow.

### 2. `middleware.ts` renamed to `proxy.ts`
Next.js 16 deprecated the `middleware` file convention and renamed it to `proxy`. The exported function is `proxy()` instead of `middleware()`.

### 3. `PRIORITY_ORDER` duplicated in `app/page.tsx`
**PRP 02 expectation**: "Import `Priority`, `PRIORITY_ORDER`, `PRIORITY_VALUES` from `@/lib/db`".  
**Actual**: `app/page.tsx` defines `PRIORITY_ORDER` locally with a comment referencing `lib/db.ts`. This is required because `lib/db.ts` imports `better-sqlite3` (a native Node module) dynamically; importing the module from a client component would fail.  
`import type { Todo, Priority }` is used in `app/page.tsx` for TypeScript types (erased at compile time — safe).  
**Grep verification**: No `type Priority` redeclaration outside `lib/db.ts` — only `import type` usage.

### 4. ISO 8601 regex allows optional seconds
**PRP 01 expectation**: The regex example shows `YYYY-MM-DDTHH:MM:SS` format required.  
**Actual fix**: `datetime-local` HTML inputs emit `YYYY-MM-DDTHH:MM` without seconds. The regex was updated to `(:[0-5]\d)?` (seconds optional). `parseDueDateToUtc('2026-07-04T13:30')` works correctly.  
**Verification**: UT-04 (`"tomorrow"` → throws) and UT-05 (`"2026-13-45T00:00:00"` → throws) still pass.

### 5. E2E tests use `page.request` not top-level `request` fixture
Playwright's top-level `request` fixture is an isolated context without the session cookie. All authenticated API calls in tests use `page.request` which shares the browser's cookie jar.

---

## Next Steps (remaining PRPs)

### PRP 03 — Recurring Todos
- `recurrence` and `reminder_minutes` columns already in schema
- Need: recurrence-completion logic in `PUT /api/todos/[id]`
- Need: `RecurrencePattern` type already exported from `lib/db.ts`

### PRP 04 — Reminders & Notifications
- `reminder_minutes` column already in schema
- Need: `app/api/notifications/check/route.ts`
- Need: `lib/hooks/useNotifications.ts`
- Need: polling logic in `app/page.tsx`

### PRP 05 — Subtasks & Progress
- `subtasks` table already in schema (with CASCADE)
- Need: subtask CRUD API routes, progress bar UI

### PRP 06 — Tag System
- `tags` and `todo_tags` tables already in schema
- Need: tag CRUD API, tag filtering

### PRP 07 — Template System
### PRP 08 — Search & Filtering  
### PRP 09 — Export & Import
### PRP 10 — Calendar View
### PRP 11 — WebAuthn Authentication
- Replace `app/api/auth/dev-login/route.ts` with WebAuthn registration/verification
- Update `tests/helpers.ts` `authenticate()` to use virtual WebAuthn authenticator
- Add `@simplewebauthn/server` and `@simplewebauthn/browser` dependencies
- Add `authenticators` table to `lib/db.ts`

---

## Architecture Notes for Next Agent

### Auth pattern
- `getSession()` in `lib/auth.ts` reads JWT from HTTP-only cookie `"session"`
- All 5 todo API routes call `await getSession()` first; return 401 if null
- `session.userId` is used for all DB queries (never trust client-supplied user_id)

### DB pattern
- `getDb()` in `lib/db.ts` returns the singleton `better-sqlite3` instance
- Global `_sqliteDb` prevents multiple instances during Next.js hot reload
- All queries use `db.prepare(...).run/get/all()` — zero string interpolation
- `PRAGMA foreign_keys = ON` set at init — CASCADE deletes work automatically

### Client component pattern
- `app/page.tsx` is `'use client'` — imports from `lib/db.ts` use `import type` only
- All data flows through API routes; never call DB directly from client components
- `PRIORITY_ORDER` is duplicated in `app/page.tsx` (see Deviations §3)

### Test pattern
- All authenticated E2E calls use `page.request` (shares browser cookie jar)
- Top-level `request` fixture is unauthenticated — only use it for TC-10 (401 test)
- `TestHelpers.authenticate()` calls dev-login via `page.request.post()`
- Run dev server first: `npm run dev`, then `npx playwright test`

### Timezone pattern
- `getSingaporeNow()` = `new Date()` (current UTC moment, named for clarity)
- `due_date` stored as UTC ISO 8601 in DB; client converts via `formatSingaporeDate()`
- No-offset input strings treated as SGT (UTC+8) by `parseDueDateToUtc()`
- Server-side future-check: `isDueDateValid()` — cannot be bypassed by client clock

---

## How to Run

```bash
npm install
npm run dev               # start dev server on :3000

# Unit tests
npx vitest run lib/validation.test.ts

# E2E tests (requires dev server running)
npx playwright test tests/02-todo-crud.spec.ts
npx playwright test tests/03-priority.spec.ts
npx playwright test        # all tests
```
