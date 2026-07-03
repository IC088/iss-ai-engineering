# PRP 01 — Todo CRUD Operations

## 1. Feature Overview

Todo CRUD Operations form the foundational layer of the app: users can create tasks with an optional due date, read back a sorted and sectioned list of all their todos, update any field, toggle completion, and permanently delete items. Every timestamp is stored in UTC and converted to/from Singapore Standard Time (`Asia/Singapore`, UTC+8) exclusively through `lib/timezone.ts` — the client never performs timezone arithmetic itself. Validation is strict and fail-fast: a title that is empty or whitespace-only is rejected at the API boundary, and a due date that falls in the past (relative to current SGT time) is rejected before it ever touches the database.

---

## 2. User Stories

### Persona A — Quick Capture User
> *"I just remembered something I need to do. I want to type a title and hit Add — nothing else required."*

- As a logged-in user, I can create a todo with only a title so that I can capture a thought without context-switching to fill optional fields.
- As a logged-in user, my todo appears immediately in the Active list after creation so that I get visual confirmation without waiting for a full page reload.

### Persona B — Structured Planner
> *"I plan my week on Sunday. I want to set a precise deadline in Singapore time, knowing the app won't silently accept a past date or one without a valid format."*

- As a logged-in user, I can create a todo with a title, due date (SGT), and placeholder fields for priority/reminder/recurrence so that the data model is ready for later features without requiring a schema migration.
- As a logged-in user, I receive a clear, field-level error message if the due date I entered is already in the past, so I can correct it without guessing what went wrong.
- As a logged-in user, I can edit any todo I previously created — title, due date, or completion state — so that plans that change don't require deleting and re-creating tasks.

---

## 3. User Flow

### 3.1 Create a Todo

1. User is authenticated and on the main page (`/`).
2. User types a title in the top input field (required; max 200 characters after trimming).
3. User optionally opens the date-time picker and selects a date/time in SGT; the picker must not allow selecting a time that is less than 1 minute ahead of the current SGT moment.
4. User clicks **"Add"**.
5. **Optimistic update**: the new todo is appended to the Active section immediately with a temporary client-generated key; the form is cleared.
6. `POST /api/todos` is called in the background.
7. On **success** (201): the temporary todo is replaced with the server-returned record (which carries the canonical `id`, `created_at`, `updated_at`).
8. On **failure** (4xx/5xx): the optimistic todo is removed from the list; a non-blocking error toast appears with the server's `error.message`.

### 3.2 View Todos (Sectioned List)

1. On page load, `GET /api/todos` is called.
2. The response is split client-side into three sections rendered in this order:
   - **Overdue** — incomplete todos whose `due_date` (converted to SGT) is before the current SGT time; sorted by `due_date` ASC (most overdue first), then `priority` DESC (high → medium → low).
   - **Active** — incomplete todos with no `due_date`, or a `due_date` still in the future; sorted by `priority` DESC first, then `due_date` ASC (nulls last).
   - **Completed** — todos with `completed = 1`; sorted by `updated_at` DESC (most recently completed first).
3. Each section header shows a count badge: "Overdue (3)", "Active (12)", "Completed (5)".
4. An empty section is hidden entirely (no empty section header rendered).

### 3.3 Edit a Todo

1. User clicks the **"Edit"** (pencil) button on any todo row.
2. An edit modal opens with all current field values pre-filled (title, due date in SGT format, completed state).
3. User modifies one or more fields; the same validation rules apply as on create.
4. User clicks **"Update"**.
5. **Optimistic update**: the local todo state is updated immediately in-place within its current section.
6. `PUT /api/todos/[id]` is called.
7. On **success** (200): server-returned record replaces the local optimistic copy; section membership is recomputed (e.g., the todo may move from Active to Overdue if the new due date is in the past — but note that a past due date is only valid for already-existing todos being updated without changing the due date; see Edge Cases §6.2).
8. On **failure**: the optimistic change is rolled back to the pre-edit snapshot; error toast displayed.

### 3.4 Toggle Completion

1. User clicks the checkbox next to a todo title.
2. **Optimistic update**: `completed` flips immediately; the todo moves to the Completed section (if marking complete) or back to Active/Overdue (if unmarking).
3. `PUT /api/todos/[id]` is called with `{ completed: true/false }`.
4. On **failure**: `completed` is rolled back to its previous value; error toast displayed.
5. When a todo is in the **Completed** section, its due date display is replaced by "Completed [relative time ago]" — the due date timestamp is no longer highlighted as overdue.

### 3.5 Delete a Todo

1. User clicks the **"Delete"** (trash) button on any todo row.
2. A confirmation dialog appears with the copy:
   > **"Delete todo?"**
   > "This will permanently delete *"{todo title}"* and all its subtasks. This action cannot be undone."
   > Buttons: **"Cancel"** (secondary style) | **"Delete"** (destructive/red style)
3. User clicks **"Delete"** to confirm.
4. **Optimistic update**: the todo is removed from the list immediately.
5. `DELETE /api/todos/[id]` is called. The server wraps the delete in a SQLite transaction that cascades to `subtasks` and `todo_tags` rows.
6. On **success** (200 with `{ deleted: true }`): no further action needed.
7. On **failure**: the todo is restored to its previous position in the list; error toast displayed.
8. User clicks **"Cancel"** to dismiss without action.

---

## 4. Technical Requirements

### 4.1 Database Schema

All DB operations live in `lib/db.ts` using **better-sqlite3** (synchronous — never use `async`/`await` for DB calls). All queries use prepared statements created with `db.prepare()`; no string concatenation or template literals in SQL.

```sql
-- Primary todos table
CREATE TABLE IF NOT EXISTS todos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT    NOT NULL,                     -- trimmed, 1–200 chars
  description     TEXT,                                 -- optional, max 2000 chars
  due_date        TEXT,                                 -- ISO 8601 UTC string, nullable
  completed       INTEGER NOT NULL DEFAULT 0,           -- 0 = false, 1 = true (SQLite boolean)
  -- FK placeholders — columns exist now so later PRPs need no migration
  priority        TEXT    NOT NULL DEFAULT 'medium',    -- 'high' | 'medium' | 'low'  (PRP 02)
  recurrence      TEXT,                                 -- 'daily'|'weekly'|'monthly'|'yearly'|NULL (PRP 03)
  reminder_minutes INTEGER,                             -- minutes before due_date (PRP 04)
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- CASCADE subtasks (PRP 05) — schema reference only, not implemented in this PRP
-- CREATE TABLE IF NOT EXISTS subtasks (
--   id        INTEGER PRIMARY KEY AUTOINCREMENT,
--   todo_id   INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
--   ...
-- );

-- CASCADE tag junction (PRP 06) — schema reference only
-- CREATE TABLE IF NOT EXISTS todo_tags (
--   todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
--   tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
--   PRIMARY KEY (todo_id, tag_id)
-- );

-- Trigger to auto-update updated_at on every UPDATE
CREATE TRIGGER IF NOT EXISTS todos_updated_at
  AFTER UPDATE ON todos
  FOR EACH ROW
  BEGIN
    UPDATE todos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = OLD.id;
  END;

-- Index to speed up per-user queries
CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date);
```

**Migration strategy**: wrap any `ALTER TABLE` statements in a try-catch `db.exec()` block, as is the pattern in the existing codebase. The `priority`, `recurrence`, and `reminder_minutes` columns should be added via migration if they don't exist:

```typescript
try {
  db.exec(`ALTER TABLE todos ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'`);
} catch { /* column already exists */ }
```

### 4.2 TypeScript Types

Defined in `lib/db.ts` and imported wherever needed.

```typescript
// Allowed priority values — extended by PRP 02
export type Priority = 'high' | 'medium' | 'low';

// Allowed recurrence values — extended by PRP 03
export type RecurrencePattern = 'daily' | 'weekly' | 'monthly' | 'yearly';

// Full database row shape (matches column names exactly)
export interface Todo {
  id: number;
  user_id: number;
  title: string;
  description: string | null;
  due_date: string | null;        // UTC ISO 8601 as stored in DB
  completed: number;              // 0 | 1 (better-sqlite3 returns integers)
  priority: Priority;
  recurrence: RecurrencePattern | null;
  reminder_minutes: number | null;
  created_at: string;             // UTC ISO 8601
  updated_at: string;             // UTC ISO 8601
}

// Request body shape for POST /api/todos (all optional except title)
export interface CreateTodoBody {
  title: string;
  description?: string;
  due_date?: string;              // client sends SGT ISO 8601 string; API converts to UTC
  priority?: Priority;
  recurrence?: RecurrencePattern;
  reminder_minutes?: number;
}

// Request body shape for PUT /api/todos/[id]
// All fields optional; only allowlisted fields are applied
export interface UpdateTodoBody {
  title?: string;
  description?: string;
  due_date?: string | null;       // null = remove due date
  completed?: boolean;
  priority?: Priority;
  recurrence?: RecurrencePattern | null;
  reminder_minutes?: number | null;
}

// Standard API error envelope — used by ALL 5 endpoints
export interface ApiError {
  error: {
    code: string;    // e.g. "VALIDATION_ERROR", "NOT_FOUND", "INTERNAL_ERROR"
    message: string; // human-readable, safe to display in UI
  };
}

// Successful response wrapper
export interface ApiResponse<T> {
  data: T;
}
```

### 4.3 Singapore Timezone Handling

All date/time operations **must** use functions from `lib/timezone.ts`. Never call `new Date()` directly in API routes or client components.

```typescript
import { getSingaporeNow, formatSingaporeDate } from '@/lib/timezone';
```

**Storage rule**: `due_date` is stored in the database as a UTC ISO 8601 string (e.g., `"2026-07-04T05:30:00.000Z"`). The client-facing API accepts and returns dates in ISO 8601 format that may carry an explicit offset (e.g., `"2026-07-04T13:30:00+08:00"`), which the server converts to UTC before storage.

**Conversion flow at the API boundary**:

```
Client sends:  "2026-07-04T13:30:00+08:00"  (SGT with explicit offset)
               OR "2026-07-04T13:30:00"     (no offset — interpreted as SGT by server)

Server does:
  1. Parse the string strictly — reject malformed dates before any conversion.
  2. If no offset is present, treat as SGT (UTC+8): add 8 hours to get UTC.
  3. If an offset is present, convert to UTC using the offset as given.
  4. Store the UTC string in DB.
  5. On read, return the UTC string; the client converts to SGT for display.

Client displays using:
  formatSingaporeDate(todo.due_date)  // converts UTC→SGT for rendering
```

**"Future" validation rule** (applied server-side, never client-side alone):

```typescript
// Called inside POST and PUT handlers after parsing the due_date
function isDueDateValid(dueDateUtcString: string): boolean {
  const nowSgt = getSingaporeNow();                // current moment in SGT
  const dueMoment = new Date(dueDateUtcString);    // parsed UTC
  const minimumFuture = new Date(nowSgt.getTime() + 60_000); // now + 1 minute
  return dueMoment >= minimumFuture;
}
```

The 1-minute minimum is measured against `getSingaporeNow()` so it cannot be bypassed by a client that sends a pre-converted UTC timestamp calculated from their local clock. The check runs on the server with the server's current SGT reading.

**No-offset handling**: a `due_date` string that contains no timezone offset (e.g., `"2026-07-04T13:30:00"`) is assumed to be SGT. The server appends `+08:00` before parsing to prevent silent misinterpretation as UTC:

```typescript
function parseDueDateToUtc(raw: string): string {
  const normalized = /[Zz]|[+-]\d{2}:\d{2}$/.test(raw)
    ? raw                          // explicit offset present — use as-is
    : raw + '+08:00';              // no offset — assume SGT
  const d = new Date(normalized);
  if (isNaN(d.getTime())) throw new Error('INVALID_DUE_DATE');
  return d.toISOString();          // UTC ISO 8601
}
```

**Malformed date rejection**: any string that does not satisfy ISO 8601 (`YYYY-MM-DDTHH:MM:SS`) is rejected with a 400 before the timezone conversion is attempted. Strings like `"tomorrow"`, `"next week"`, `"2026-13-45T00:00:00"`, or an empty string all fail this check. The validation regex is:

```typescript
const ISO_DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d/;
if (!ISO_DATE_RE.test(raw)) {
  return { code: 'INVALID_DUE_DATE', message: 'Due date must be a valid ISO 8601 date-time string' };
}
```

### 4.4 API Endpoints

All routes live under `app/api/todos/`. All routes:
- Check authentication first; return 401 if no session.
- Use `session.userId` for all DB queries (never accept a `user_id` from the request body).
- Return the standard `ApiError` envelope on errors.
- Reject request bodies larger than **64 KB** before parsing (middleware or inline check).
- Log validation failures and 500s with `{ endpoint, id, errorType }` context; **never log request body contents** in server logs (forward-looking PII protection).

#### Request size guard (applies to all POST/PUT routes)

```typescript
const MAX_BODY_BYTES = 64 * 1024; // 64 KB
const contentLength = request.headers.get('content-length');
if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
  return NextResponse.json(
    { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 64 KB limit' } },
    { status: 413 }
  );
}
```

---

#### `POST /api/todos` — Create Todo

**File**: `app/api/todos/route.ts`

**Request**
```
Content-Type: application/json
Body: CreateTodoBody
```

**Field validation** (applied in order; return 400 on first failure):

| Field | Type | Rule | Error code |
|---|---|---|---|
| `title` | string | Required. Trim whitespace. Length 1–200 after trim. Reject if contains `<`, `>`, `&`, `"`, `'`, or any HTML/script tag pattern. | `TITLE_REQUIRED` / `TITLE_TOO_LONG` / `TITLE_INVALID_CHARS` |
| `description` | string | Optional. Max 2000 chars. Same HTML/script rejection rule. | `DESCRIPTION_TOO_LONG` / `DESCRIPTION_INVALID_CHARS` |
| `due_date` | string | Optional. If present: validate ISO 8601 format, parse to UTC via `parseDueDateToUtc()`, then check `isDueDateValid()`. | `INVALID_DUE_DATE` / `DUE_DATE_IN_PAST` |
| `priority` | string | Optional. If present, must be one of `'high' \| 'medium' \| 'low'`. Default `'medium'` if absent. | `INVALID_PRIORITY` |
| `recurrence` | string | Optional. If present, must be one of `'daily' \| 'weekly' \| 'monthly' \| 'yearly'`. Null if absent. | `INVALID_RECURRENCE` |
| `reminder_minutes` | number | Optional. If present, must be a positive integer from the set `[15, 30, 60, 120, 1440, 2880, 10080]`. Null if absent. | `INVALID_REMINDER` |

**Unknown fields**: iterate the parsed body's keys against the allowlist `['title', 'description', 'due_date', 'priority', 'recurrence', 'reminder_minutes']`. Return 400 with `UNKNOWN_FIELDS` if any extra key is present.

**DB write** (prepared statement, synchronous):
```typescript
const stmt = db.prepare(`
  INSERT INTO todos (user_id, title, description, due_date, priority, recurrence, reminder_minutes)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const result = stmt.run(
  session.userId,
  title,         // trimmed
  description ?? null,
  dueDateUtc ?? null,
  priority,
  recurrence ?? null,
  reminder_minutes ?? null
);
const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(result.lastInsertRowid) as Todo;
```

**Success response**
```json
HTTP 201 Created
{ "data": { /* Todo object with all fields */ } }
```

**Error responses**
```
400 { "error": { "code": "TITLE_REQUIRED", "message": "Title is required" } }
400 { "error": { "code": "DUE_DATE_IN_PAST", "message": "Due date must be at least 1 minute in the future" } }
401 { "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

**Rate limiting note**: This endpoint will require per-session rate limiting once authentication (PRP 11) is live. Flag in code with a `// TODO(PRP-11): add rate limit` comment on the route handler.

---

#### `GET /api/todos` — List All Todos

**File**: `app/api/todos/route.ts`

**Query parameters**: none for this PRP (filtering/search added in PRP 08).

**DB read** (prepared statement):
```typescript
const stmt = db.prepare('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC');
const todos = stmt.all(session.userId) as Todo[];
```

The client performs all sectioning (Overdue / Active / Completed) and sorting client-side using `getSingaporeNow()` for the overdue threshold. Keeping sectioning on the client avoids DB-level date math in SQLite and keeps the API simple.

**Success response**
```json
HTTP 200 OK
{ "data": [ /* array of Todo objects */ ] }
```

**Empty result**: returns `{ "data": [] }` — never 404.

**Error responses**
```
401 { "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

---

#### `GET /api/todos/[id]` — Read One Todo

**File**: `app/api/todos/[id]/route.ts`

**URL parameter validation**: `id` must be a positive integer. Reject before DB access:
```typescript
const { id } = await params;
const numericId = parseInt(id, 10);
if (isNaN(numericId) || numericId <= 0 || String(numericId) !== id) {
  return NextResponse.json({ error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } }, { status: 400 });
}
```

**DB read** (prepared statement):
```typescript
const stmt = db.prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?');
const todo = stmt.get(numericId, session.userId) as Todo | undefined;
if (!todo) {
  return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Todo not found' } }, { status: 404 });
}
```

Note: the `AND user_id = ?` clause means a valid `id` belonging to a different user also returns 404 (not 403), preventing enumeration.

**Success response**
```json
HTTP 200 OK
{ "data": { /* Todo object */ } }
```

**Error responses**
```
400 { "error": { "code": "INVALID_ID", "message": "Todo ID must be a positive integer" } }
401 { "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }
404 { "error": { "code": "NOT_FOUND", "message": "Todo not found" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

---

#### `PUT /api/todos/[id]` — Update Todo

**File**: `app/api/todos/[id]/route.ts`

**URL parameter validation**: same integer check as `GET /api/todos/[id]`.

**Allowlisted update fields**: `['title', 'description', 'due_date', 'completed', 'priority', 'recurrence', 'reminder_minutes']`

Server-controlled fields (`id`, `user_id`, `created_at`, `updated_at`) are silently dropped if present in the body — they are not errors, but they are not applied. Any field not in the allowlist is silently dropped in the same way.

**Body parsing and validation**:
- Parse the JSON body; reject bodies with unknown-field keys per the allowlist (same as POST — return 400 `UNKNOWN_FIELDS`).
- Apply the same per-field validation rules as `POST /api/todos` for any field present in the body.
- `completed` field: must be a boolean (`true` or `false`). The DB stores this as `1`/`0`; convert explicitly: `completed ? 1 : 0`.
- `due_date: null` in the body means "remove the due date" — store `NULL` in the DB.
- **Due date validation on update**: if `due_date` is present and non-null, apply the `isDueDateValid()` future check. If the existing todo already has an overdue `due_date` and the client sends a `PUT` that does **not** include `due_date` (i.e., updating only `title` or `completed`), the existing overdue `due_date` is preserved without re-validation — do not apply the future check to unchanged fields.

**DB write** (prepared statement — build the SET clause from the allowlist, not raw input):
```typescript
// Build SET clause dynamically but from a fixed allowlist only
const ALLOWED_COLUMNS = ['title', 'description', 'due_date', 'completed', 'priority', 'recurrence', 'reminder_minutes'] as const;
// ... build parameterized SET clause from only the keys present in body that match ALLOWED_COLUMNS
const stmt = db.prepare(`UPDATE todos SET ${setClauses} WHERE id = ? AND user_id = ?`);
const result = stmt.run(...values, numericId, session.userId);
if (result.changes === 0) {
  return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Todo not found' } }, { status: 404 });
}
```

The `ORDER BY`/filter column names used anywhere in DB queries must come from a hardcoded allowlist, never from user-supplied strings.

**`updated_at`** is handled by the DB trigger (see §4.1); do not set it manually.

**Success response**
```json
HTTP 200 OK
{ "data": { /* updated Todo object */ } }
```

**Error responses**
```
400 { "error": { "code": "TITLE_REQUIRED", "message": "Title is required" } }
400 { "error": { "code": "DUE_DATE_IN_PAST", "message": "Due date must be at least 1 minute in the future" } }
401 { "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }
404 { "error": { "code": "NOT_FOUND", "message": "Todo not found" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

**Note on upsert**: `PUT` on a nonexistent `id` returns 404. It does **not** create a new todo.

**Rate limiting note**: same as POST — `// TODO(PRP-11): add rate limit`.

---

#### `DELETE /api/todos/[id]` — Delete Todo

**File**: `app/api/todos/[id]/route.ts`

**URL parameter validation**: same integer check as above.

**Transaction requirement**: the delete must be wrapped in a SQLite transaction to ensure CASCADE deletes to `subtasks` and `todo_tags` are atomic. If the transaction fails for any reason, the DB is rolled back and no orphaned rows are left:

```typescript
const deleteTransaction = db.transaction((id: number, userId: number) => {
  // With ON DELETE CASCADE defined on subtasks.todo_id and todo_tags.todo_id,
  // SQLite handles child rows automatically when PRAGMA foreign_keys = ON is set.
  // Ensure the pragma is enabled at DB initialization in lib/db.ts:
  //   db.pragma('foreign_keys = ON');
  const stmt = db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?');
  return stmt.run(id, userId);
});
const result = deleteTransaction(numericId, session.userId);
if (result.changes === 0) {
  return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Todo not found' } }, { status: 404 });
}
```

**Idempotency**: `DELETE` on an already-deleted or nonexistent `id` returns **404**, not 200/204. Deletes are not silently idempotent-success.

**Success response**
```json
HTTP 200 OK
{ "data": { "deleted": true } }
```

*(200 with body chosen over 204 for consistency with the rest of the API envelope; no empty bodies.)*

**Error responses**
```
400 { "error": { "code": "INVALID_ID", "message": "Todo ID must be a positive integer" } }
401 { "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }
404 { "error": { "code": "NOT_FOUND", "message": "Todo not found" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

**Rate limiting note**: same — `// TODO(PRP-11): add rate limit`.

---

### 4.5 Input Sanitization Rules (applies to all endpoints)

HTML/script injection is prevented at **input rejection** time (not output encoding), because the data is also returned via API and could be consumed by other clients. The rule:

- `title` and `description` must not contain `<`, `>`, or the literal substring `javascript:`. If any of these are detected after trimming, return 400 with code `TITLE_INVALID_CHARS` or `DESCRIPTION_INVALID_CHARS` respectively.
- All other string fields (e.g. `priority`, `recurrence`) are validated against an allowlist of permitted values; no free-text content is stored.
- On output, `title` and `description` must still be HTML-escaped when rendered into the DOM (use React's default JSX escaping — never set `dangerouslySetInnerHTML` with todo content).

### 4.6 Standard Error Response Shape

Every error response across all 5 endpoints uses this exact envelope:
```typescript
{ error: { code: string; message: string } }
```
- `code` is a SCREAMING_SNAKE_CASE identifier for programmatic handling.
- `message` is a human-readable string safe for display in the UI.
- Internal errors (unhandled exceptions, DB failures) return `code: "INTERNAL_ERROR"` with a generic `message`; the real error and stack trace are written to server-side logs only.

---

## 5. UI Components

All UI lives in `app/page.tsx` (the monolithic `'use client'` component). Do not import `lib/db.ts` here — all data flows through the API routes.

### 5.1 Create Todo Form

```tsx
// Located at the top of the page, always visible when logged in
function TodoForm({ onTodoCreated }: { onTodoCreated: (todo: Todo) => void }) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Optimistic create: generate temp id, add to list, fire POST
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Title is required'); return; }
    setError(null);
    setIsSubmitting(true);

    const tempId = `temp-${Date.now()}`;
    const optimisticTodo: Todo = {
      id: tempId as unknown as number,
      title: title.trim(),
      due_date: dueDate || null,
      completed: 0,
      priority: 'medium',
      // ... other defaults
    };
    onTodoCreated(optimisticTodo); // adds to list immediately
    setTitle('');
    setDueDate('');

    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), due_date: dueDate || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message ?? 'Failed to create todo');
      }
      // Replace optimistic entry with canonical server record
      onTodoCreated(json.data); // caller deduplicates by tempId → real id
    } catch (err) {
      removeOptimisticTodo(tempId);  // rollback
      showErrorToast(err instanceof Error ? err.message : 'Failed to create todo');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="What needs to be done?"
        maxLength={200}
        aria-label="Todo title"
        required
      />
      <input
        type="datetime-local"
        value={dueDate}
        onChange={e => setDueDate(e.target.value)}
        min={getMinDueDateForPicker()} // SGT now + 1 minute, formatted for input
        aria-label="Due date"
      />
      {error && <p role="alert" className="text-red-600 text-sm">{error}</p>}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Adding…' : 'Add'}
      </button>
    </form>
  );
}
```

`getMinDueDateForPicker()` returns the current SGT time plus 1 minute formatted as `YYYY-MM-DDTHH:MM` (the format required by `datetime-local` inputs). This is a UX guardrail only; the server re-validates.

### 5.2 Sectioned Todo List

```tsx
// Client-side sectioning logic
function useSectionedTodos(todos: Todo[]) {
  const now = getSingaporeNow();
  return useMemo(() => {
    const overdue = todos
      .filter(t => !t.completed && t.due_date && new Date(t.due_date) < now)
      .sort((a, b) => {
        const dateDiff = new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime();
        return dateDiff !== 0 ? dateDiff : PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
      });
    const active = todos
      .filter(t => !t.completed && (!t.due_date || new Date(t.due_date) >= now))
      .sort((a, b) => {
        const priDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
        if (priDiff !== 0) return priDiff;
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;   // nulls last
        if (!b.due_date) return -1;
        return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      });
    const completed = todos
      .filter(t => !!t.completed)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    return { overdue, active, completed };
  }, [todos, now]);
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 3, medium: 2, low: 1 };
```

### 5.3 Todo Row

Each todo row renders:
- Checkbox (`<input type="checkbox">`) — clicking it calls the toggle handler.
- Title text.
- Due date display via `formatSingaporeDate()`:
  - If completed: "Completed [X time ago]" (no overdue styling).
  - If overdue: red text "X days/hours/minutes overdue".
  - If due in < 1 hour: red "Due in X minutes".
  - If due in < 24 hours: orange "Due in X hours".
  - If due in < 7 days: yellow "Due in X days".
  - If due in ≥ 7 days: blue full timestamp in SGT.
- Edit button (opens edit modal).
- Delete button (opens delete confirmation dialog).

### 5.4 Edit Modal

```tsx
function EditTodoModal({ todo, onClose, onUpdated }: EditTodoModalProps) {
  const [title, setTitle] = useState(todo.title);
  // Convert UTC due_date from DB to SGT string for the datetime-local input
  const [dueDate, setDueDate] = useState(
    todo.due_date ? formatForDatetimeLocalInput(todo.due_date) : ''
  );
  const [error, setError] = useState<string | null>(null);

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    // Capture pre-edit snapshot for rollback
    const snapshot = { ...todo };
    // Optimistic update
    onUpdated({ ...todo, title: title.trim(), due_date: dueDate || null });
    onClose();

    try {
      const res = await fetch(`/api/todos/${todo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), due_date: dueDate || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to update todo');
      onUpdated(json.data); // replace with canonical server record
    } catch (err) {
      onUpdated(snapshot); // rollback
      showErrorToast(err instanceof Error ? err.message : 'Failed to update todo');
    }
  }

  return (
    <dialog open aria-modal aria-labelledby="edit-modal-title">
      <h2 id="edit-modal-title">Edit Todo</h2>
      <form onSubmit={handleUpdate}>
        <input value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required />
        <input type="datetime-local" value={dueDate} onChange={e => setDueDate(e.target.value)} />
        {error && <p role="alert">{error}</p>}
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="submit">Update</button>
      </form>
    </dialog>
  );
}
```

### 5.5 Delete Confirmation Dialog

```tsx
function DeleteConfirmDialog({ todo, onConfirm, onCancel }: DeleteConfirmProps) {
  return (
    <dialog open aria-modal aria-labelledby="delete-dialog-title">
      <h2 id="delete-dialog-title">Delete todo?</h2>
      <p>
        This will permanently delete <strong>"{todo.title}"</strong> and all its subtasks.
        This action cannot be undone.
      </p>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button
        type="button"
        onClick={onConfirm}
        className="bg-red-600 text-white"
      >
        Delete
      </button>
    </dialog>
  );
}
```

The confirmation dialog is opened by clicking the Delete button on a todo row. The **"Delete"** confirm button uses a destructive (red) visual style. **"Cancel"** uses a secondary (neutral) style. The dialog is closed on either action.

### 5.6 Error Toast

A non-blocking toast component that appears in the bottom-right corner for 4 seconds:
```tsx
function showErrorToast(message: string) {
  // Implementation uses React state in the root component to render a toast overlay.
  // The toast auto-dismisses after 4000 ms.
}
```

---

## 6. Edge Cases

### 6.1 Empty / Whitespace-Only Title
- **Input**: `{ "title": "   " }` or `{ "title": "" }` or `{ "title": "\t\n" }`.
- **Server behavior**: trim the title; if empty after trim, return `400 { error: { code: "TITLE_REQUIRED", message: "Title is required" } }`.
- **Client behavior**: the form's `required` attribute and JS guard prevent submission, but the server enforces independently.

### 6.2 Due Date in the Past
- **Input**: a syntactically valid ISO 8601 date that resolves to a UTC moment already past.
- **Server behavior**: after parsing and converting to UTC, compare against `getSingaporeNow() + 1 minute`. If in the past or within the next minute, return `400 { error: { code: "DUE_DATE_IN_PAST", message: "Due date must be at least 1 minute in the future" } }`.
- **Special case — existing todo with overdue date**: if a `PUT` request updates `title` only and the existing `due_date` is already overdue, the server does **not** re-validate the existing `due_date`. The future-check only fires when `due_date` is explicitly present in the request body for a PUT.

### 6.3 Due Date Exactly "Now" (Boundary)
- A due date that is exactly `getSingaporeNow()` (0 seconds in the future) is rejected. The minimum is `getSingaporeNow() + 60_000 ms` (one full minute ahead). This is a strict greater-than-or-equal check: `dueMoment >= minimumFuture`.

### 6.4 Concurrent Edits
- No distributed locking is implemented at this stage. Last write wins: if two sessions update the same todo simultaneously, the second `PUT` overwrites the first. The `updated_at` field is updated by the DB trigger, giving clients a signal to detect staleness on the next `GET`.
- Future consideration: optimistic concurrency via `If-Match`/`ETag` headers (out of scope for this PRP).

### 6.5 Delete of a Todo with Dependent Subtasks / Tags
- The `todos` table's `ON DELETE CASCADE` referential rule propagates the delete to `subtasks` and `todo_tags` automatically, provided `PRAGMA foreign_keys = ON` is set at DB initialization.
- The `DELETE /api/todos/[id]` handler wraps the statement in a `db.transaction()` call. If the transaction throws (e.g., DB locked), no partial delete occurs; the API returns 500 with a generic error message.
- The delete confirmation dialog copy explicitly warns the user: *"and all its subtasks"*.

### 6.6 Network Failure During Optimistic Update (Rollback)
- On `POST` failure: the optimistic todo (identified by its `temp-{timestamp}` id) is removed from local state; error toast shown.
- On `PUT` failure: a snapshot of the todo state captured before the optimistic update is restored; error toast shown.
- On `DELETE` failure: the todo is re-inserted at its original index in the local list (the state snapshot before removal is restored); error toast shown.
- The error toast message comes from `json.error.message` if available, or a generic fallback string — never an unformatted stack trace.

### 6.7 Malformed or Non-Integer Todo ID in URL
- `GET /api/todos/abc`, `PUT /api/todos/0`, `DELETE /api/todos/-5`, `GET /api/todos/1.5`: all return `400 INVALID_ID` before the DB is queried.

### 6.8 Unknown Fields in Request Body
- A request body containing `{ "title": "Test", "user_id": 999 }` or any field not in the allowlist returns `400 UNKNOWN_FIELDS`. This prevents both mass-assignment attacks and accidental writes to server-controlled columns.

### 6.9 Due Date with No Timezone Offset
- `"2026-07-04T13:30:00"` (no `Z` or `+HH:MM`) is treated as SGT (UTC+8). The server appends `+08:00` before parsing. This is the expected behavior for the datetime-local HTML input, which emits local time without an offset.

### 6.10 Due Date with Explicit Non-SGT Offset
- `"2026-07-04T05:30:00Z"` (UTC) and `"2026-07-04T13:30:00+08:00"` (SGT) both refer to the same UTC moment and are both accepted. The server converts to UTC before storage; both are valid inputs.

---

## 7. Acceptance Criteria

1. **Title-only creation**: A user can create a todo by providing only a title. The API accepts the request, persists the record, and returns the created todo with a server-assigned `id`, `created_at`, and `updated_at`.

2. **Full-metadata creation**: A user can create a todo with `title`, `description`, `due_date` (SGT, ≥ 1 minute in the future), `priority`, `recurrence`, and `reminder_minutes` all populated. The API stores all fields without error and returns the complete record.

3. **Sorted display**: The client displays todos in three sections — Overdue (sorted by `due_date` ASC, then `priority` DESC), Active (sorted by `priority` DESC, then `due_date` ASC with nulls last), Completed (sorted by `updated_at` DESC). This sort is deterministic and matches the rules in §3.2.

4. **Completion toggle**: Marking a todo complete moves it immediately to the Completed section. Unmarking it moves it back to Active or Overdue depending on its `due_date`. The due date display text changes to "Completed [time ago]" when in the Completed section.

5. **Edit roundtrip**: Editing a todo updates its `title`, `due_date`, and/or `priority` fields; the updated record is reflected in the list in real time. The edit modal is pre-filled with the current field values.

6. **Delete cascade**: Deleting a todo removes it and all associated subtasks (via `ON DELETE CASCADE` with `PRAGMA foreign_keys = ON`). The confirmation dialog shows the exact copy from §3.5. After deletion, the todo no longer appears in any section.

7. **Past-due-date rejection**: Submitting a `POST` or `PUT` with a `due_date` that is less than 1 minute in the future returns `HTTP 400` with `{ error: { code: "DUE_DATE_IN_PAST", message: "Due date must be at least 1 minute in the future" } }`.

8. **Empty-title rejection**: Submitting a `POST` or `PUT` with a blank or whitespace-only title returns `HTTP 400` with `{ error: { code: "TITLE_REQUIRED", message: "Title is required" } }`.

9. **Optimistic UI with rollback**: All mutating operations (create, update, delete, toggle) update the UI immediately. If the API call fails, the UI reverts to its pre-operation state and an error toast is shown.

10. **Unauthenticated access rejected**: All 5 endpoints return `HTTP 401` if no valid session cookie is present.

11. **Nonexistent resource returns 404**: `GET`, `PUT`, and `DELETE` on a missing or other-user's `id` return `HTTP 404`, not 200 or 500.

12. **No mass assignment**: A `PUT` body containing `user_id`, `id`, or `created_at` silently ignores those fields; they are not applied to the DB record.

13. **HTML injection rejected at input**: A `POST` body with `{ "title": "<script>alert(1)</script>" }` returns `HTTP 400 TITLE_INVALID_CHARS`.

14. **Prepared statements only**: All DB queries use `db.prepare().run()` or `db.prepare().get()` / `.all()` — no raw string SQL building from user input.

---

## 8. Testing Requirements

### 8.1 E2E Tests (Playwright — `tests/02-todo-crud.spec.ts`)

All tests run against a Chromium browser with a virtual WebAuthn authenticator. The Playwright config sets `timezoneId: 'Asia/Singapore'`. Tests use helpers from `tests/helpers.ts` (`createTodo()`, etc.).

```
Test Suite: Todo CRUD Operations

TC-01: Create todo with title only
  - Navigate to the main page as authenticated user
  - Enter "Buy groceries" in the title field; leave all other fields blank
  - Click "Add"
  - Assert: the todo "Buy groceries" appears in the Active section
  - Assert: no due date badge is shown
  - Assert: API call returned HTTP 201

TC-02: Create todo with all metadata
  - Enter title "Weekly report"
  - Set due date to SGT now + 2 days
  - (Priority, recurrence, reminder set to non-default values once PRPs 02-04 are implemented;
     for this PRP the test verifies the fields are accepted without error)
  - Click "Add"
  - Assert: todo appears in Active section with the correct due date display
  - Assert: API returned 201 with all submitted fields reflected

TC-03: Edit todo
  - Create a todo via createTodo() helper
  - Click Edit button on the todo row
  - Assert: edit modal opens with current title pre-filled
  - Change title to "Updated title"; change due date to SGT now + 3 days
  - Click "Update"
  - Assert: todo row shows "Updated title"
  - Assert: due date badge reflects the new date
  - Assert: API returned 200

TC-04: Toggle completion
  - Create a todo via helper
  - Click the completion checkbox
  - Assert: todo moves to the Completed section
  - Assert: due date display changes to "Completed X ago" format
  - Click the checkbox again to unmark
  - Assert: todo moves back to Active section

TC-05: Delete todo
  - Create a todo via helper
  - Click Delete button
  - Assert: confirmation dialog appears with correct copy (including the todo title)
  - Click "Delete" to confirm
  - Assert: todo is removed from all sections
  - Assert: API returned 200 { "data": { "deleted": true } }

TC-06: Delete todo — cancel
  - Create a todo via helper
  - Click Delete button; dialog appears
  - Click "Cancel"
  - Assert: todo is still present in the list

TC-07: Past due date validation — rejected with correct error
  - In the create form, enter title "Test"
  - Bypass the datetime-local min attribute and set due_date to a past timestamp
    (inject directly via page.fill or API call with past date)
  - Assert: API returns 400 with code "DUE_DATE_IN_PAST"
  - Assert: UI shows error toast with "Due date must be at least 1 minute in the future"
  - Assert: no todo was added to the list

TC-08: Empty title rejected
  - Submit the form with whitespace-only title (e.g., "   ")
  - Assert: UI shows validation error "Title is required" before or after API call
  - Assert: no todo added to the list

TC-09: Optimistic rollback on create failure
  - Mock POST /api/todos to return 500
  - Enter a title and click "Add"
  - Assert: todo briefly appears in the list (optimistic)
  - Assert: after the mock 500 response, the todo is removed from the list
  - Assert: error toast is shown

TC-10: Unauthenticated request returns 401
  - Clear session cookie
  - Attempt to fetch /api/todos
  - Assert: response status is 401
```

### 8.2 Unit Tests (`lib/db.test.ts` or `app/api/todos/*.test.ts`)

```
UT-01: parseDueDateToUtc — no offset string is interpreted as SGT
  Input:  "2026-07-04T13:30:00"
  Expect: "2026-07-04T05:30:00.000Z"

UT-02: parseDueDateToUtc — explicit UTC offset preserved
  Input:  "2026-07-04T05:30:00Z"
  Expect: "2026-07-04T05:30:00.000Z"

UT-03: parseDueDateToUtc — explicit SGT offset
  Input:  "2026-07-04T13:30:00+08:00"
  Expect: "2026-07-04T05:30:00.000Z"

UT-04: parseDueDateToUtc — malformed string throws
  Input:  "tomorrow"
  Expect: throws Error with message 'INVALID_DUE_DATE'

UT-05: parseDueDateToUtc — invalid calendar date throws
  Input:  "2026-13-45T00:00:00"
  Expect: throws Error with message 'INVALID_DUE_DATE'

UT-06: isDueDateValid — returns false for a date 30 seconds in the future
  Mock getSingaporeNow() to return a fixed moment T
  Input:  T + 30 seconds
  Expect: false

UT-07: isDueDateValid — returns true for a date exactly 60 seconds in the future
  Mock getSingaporeNow() to return a fixed moment T
  Input:  T + 60 seconds
  Expect: true

UT-08: Title validation — rejects whitespace-only
  Input:  "   "
  Expect: { code: "TITLE_REQUIRED" }

UT-09: Title validation — rejects title exceeding 200 chars
  Input:  "a".repeat(201)
  Expect: { code: "TITLE_TOO_LONG" }

UT-10: Title validation — rejects HTML injection
  Input:  "<script>alert(1)</script>"
  Expect: { code: "TITLE_INVALID_CHARS" }

UT-11: PUT allowlist — id and created_at in body are silently dropped
  Simulate a PUT body with { title: "Valid", id: 999, created_at: "2000-01-01" }
  Expect: only title is updated; id and created_at are unchanged in the DB record

UT-12: Unknown field rejection
  Input body: { title: "Valid", injectedField: "value" }
  Expect: { code: "UNKNOWN_FIELDS" }
```

---

## 9. Out of Scope

The following features are explicitly **not** implemented in this PRP. The database schema and API include placeholder columns for future use, but no business logic is attached to them here:

- **Priority system** (PRP 02): The `priority` column exists in the schema with a default of `'medium'`, and the API accepts and stores `priority` values, but priority-based UI filtering, color-coded badges, and priority-first sorting are defined in PRP 02.
- **Recurring todos** (PRP 03): The `recurrence` column exists; the API accepts and stores `recurrence` values, but no automatic next-instance creation logic runs here.
- **Reminders & Notifications** (PRP 04): The `reminder_minutes` column exists; the API accepts and stores values, but the notification polling system and `last_notification_sent` tracking are defined in PRP 04.
- **Subtasks & Progress Tracking** (PRP 05): The `subtasks` table schema is shown as a reference comment only. Subtask CRUD and progress bar UI are in PRP 05.
- **Tag System** (PRP 06): The `todo_tags` junction table schema is shown as a reference comment only. Tag CRUD and filtering are in PRP 06.
- **Search & Filtering** (PRP 08): `GET /api/todos` returns all todos with no query parameters. Text search and multi-criteria filtering are in PRP 08.
- **Export & Import** (PRP 09)
- **Calendar View** (PRP 10)
- **Authentication / WebAuthn** (PRP 11): Auth is assumed to be in place (sessions exist). Implementation of the passkey flow is in PRP 11.
- **Dark mode** styling
- **Rate limiting enforcement**: flagged as a dependency of PRP 11; `// TODO(PRP-11)` comments mark the relevant routes.
- **Pagination** of the todo list

---

## 10. Success Metrics

| Metric | Target |
|---|---|
| E2E test suite pass rate | 100% (all TC-01 through TC-10 green) |
| API response time (p95) for `GET /api/todos` | < 100 ms on local SQLite with ≤ 500 todos |
| API response time (p95) for `POST /api/todos` | < 150 ms |
| Optimistic UI perceived latency (create/edit/delete) | Immediate (< 16 ms — next render frame) |
| Validation error coverage | All 12 unit tests (UT-01 through UT-12) pass |
| No stored-XSS vectors | HTML/script in title or description is rejected at input; confirmed by TC-07 equivalent security test |
| Delete cascade integrity | Zero orphaned subtask or todo_tag rows after any delete; verified by a DB-level unit test |
| No raw SQL string concatenation | Code review / static analysis confirms all DB queries use prepared statements |

---

*Last updated: 2026-07-03 | PRP version: 1.0 | Implements feature phase: Phase 1 — Foundation*
