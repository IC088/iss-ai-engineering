# Implementation Progress

**Date**: 2026-07-03  
**Status**: Phase 1 (PRP 01) ✅ COMPLETE | Phase 2 (PRP 02) ✅ COMPLETE | Phase 3 (PRP 03) ✅ COMPLETE | Phase 4 (PRP 04) ✅ COMPLETE | Phase 5 (PRP 05) ✅ COMPLETE

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

### Phase 3 — PRP 03: Recurring Todos

**Files created/modified:**
- `lib/db.ts` — `RecurrencePattern` type, `RECURRENCE_VALUES`, idempotent `ALTER TABLE` for `last_notification_sent`; existing `recurrence TEXT` column used as combined is_recurring + pattern (ground truth: routes use single column)
- `lib/auth.ts` — JWT session (`getSession`, `createSessionToken`, `SESSION_COOKIE_OPTIONS`) — was missing from repo
- `lib/timezone.ts` — `nextDueDate()` with `addMonthsClamped()` (Jan 31→Feb 28/29, Feb 29→Feb 28 clamping)
- `next.config.ts` — `serverExternalPackages: ['better-sqlite3']` — was missing from repo
- `app/api/todos/[id]/route.ts` — PUT completion path: detects `recurrence !== null`, inserts next instance inheriting title/priority/recurrence/reminder, resets `last_notification_sent = NULL`, does not copy subtasks
- `app/page.tsx` — `RecurrencePattern` import, `capitalize()` helper, `newRecurrence` state, Repeat checkbox + pattern select in create form, same in `EditTodoModal`, 🔄 badge in `TodoRow`, refetch on recurring completion to surface new instance

**Deviations from PRP:**
- PRP specifies two columns (`is_recurring INTEGER`, `recurrence_pattern TEXT`). Existing routes use a single `recurrence TEXT` column (null = not recurring, value = pattern). Followed code as ground truth per PRP §10 instruction.

**Tests:** skipped per PRP §10 ("skip tests — I'll verify manually")

---

### Phase 4 — PRP 04: Reminders & Notifications

**Files created/modified:**
- `lib/db.ts` — `REMINDER_OPTIONS` (7 entries), `REMINDER_MINUTES_VALUES`, idempotent `ALTER TABLE` for `reminder_minutes`
- `lib/timezone.ts` — `reminderTriggerTime()`, `isDueForNotification()` (pure, unit-testable)
- `lib/hooks/useNotifications.ts` — `useNotifications(enabled)` hook: SSR-guarded, 30s polling, fires once on mount, cleans up on unmount, no-ops without `Notification.permission === 'granted'`
- `app/api/notifications/check/route.ts` — auth-guarded GET; queries incomplete todos with due_date + reminder_minutes, filters with `isDueForNotification`, stamps `last_notification_sent` in a transaction, returns matched todos
- `app/page.tsx` — `REMINDER_OPTIONS` inline constant, `shortLabelFor()` helper, `useNotifications` hook wired with `perm` state (initialised from `Notification.permission` on mount), Enable Notifications button in header, reminder `<select>` in create form + `EditTodoModal` (disabled without due date, clears on date clear), 🔔 badge in `TodoRow`, `newReminderMinutes` state, `reminder_minutes` in optimistic todo + POST/PUT bodies

**Tests:** skipped per PRP §10 ("skip tests — I'll verify manually")

---

### Phase 5 — PRP 05: Subtasks & Progress

**Files created/modified:**
- `lib/db.ts` — `Subtask` interface, `subtaskDB` CRUD object (`create`, `listByTodo`, `toggle`, `updateTitle`, `delete`, `ownerUserId` — all prepared statements), `progress()` pure function, `CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON subtasks(todo_id)`
- `app/api/todos/[id]/subtasks/route.ts` — `GET` (list ordered by position ASC, ownership-checked) + `POST` (title validated, position = `COALESCE(MAX,0)+1`, returns 201)
- `app/api/subtasks/[id]/route.ts` — `PUT` (toggle `completed`, optional `updateTitle`, ownership via JOIN to todos) + `DELETE` (ownership-checked, returns `{ok:true}`)
- `app/page.tsx` — `Subtask` import, inline `progress()`, `SubtaskInput` component (Enter/Add submit, clears on success), `TodoRow` refactored to stateful with `expanded`/`subtasks` state; lazy-loads subtasks on first expand; optimistic add/toggle/delete with rollback; progress bar (blue → green at 100%) with `X/Y completed (Z%)` label; ▸/▾ toggle button in hover action group

**Tests:** skipped per PRP §10 ("skip tests — I'll verify manually")

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

### PRP 06 — Tag System
- `tags` and `todo_tags` tables already in schema
- Need: tag CRUD API, tag filtering UI, tag badges on todo rows

### PRP 07 — Template System
### PRP 08 — Search & Filtering  
### PRP 09 — Export & Import
### PRP 10 — Calendar View
### PRP 11 — WebAuthn Authentication

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
- `PRIORITY_ORDER`, `REMINDER_OPTIONS`, `progress()` are inlined in `app/page.tsx` for client bundle compatibility (see Deviations §3)

### Hooks pattern
- `lib/hooks/useNotifications.ts` — SSR-guarded with `typeof window` checks; safe for Next.js App Router

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
