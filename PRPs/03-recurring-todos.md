# PRP 03 — Recurring Todos

> **Extension of PRP 01 — Todo CRUD Operations.**
> This PRP does not redefine the `todos` table, the 5 CRUD endpoints, the error envelope shape, or the timezone handling — those are specified in PRP 01. It also assumes the `priority` column (PRP 02) and tag associations (PRP 06) carry forward via row copy. This document covers only what is newly added for recurrence. Read PRP 01 first.

---

## 1. Feature Overview

The Recurring Todos feature lets a user mark a todo as repeating on a fixed cadence — **daily**, **weekly**, **monthly**, or **yearly**. When a recurring todo is completed, the system automatically creates the **next instance** with a recalculated due date and the same metadata (priority, tags, reminder offset, recurrence pattern), leaving the completed instance in the Completed section. Recurrence is stored on the `todos` table via two columns (`is_recurring`, `recurrence_pattern`) and requires a due date to anchor the cadence. All date arithmetic is performed in **Singapore time** (`Asia/Singapore`) using `lib/timezone.ts`, with explicit month-end and leap-year clamping so the next due date is always a valid calendar date.

---

## 2. User Stories

### Persona A — Habit Builder
> *"I brush up my standup notes every weekday and water my plants every Sunday. I don't want to retype the same todo forever — when I finish today's, the next one should just appear."*

- As a logged-in user, I can mark a todo as recurring with a cadence so that completing it automatically schedules the next occurrence.
- As a logged-in user, the next occurrence inherits the priority, tags, and reminder I set so that I configure the routine once.

### Persona B — Compliance Scheduler
> *"I have a monthly report due on the last day of the month and an annual license renewal. The dates must land on valid calendar days — I can't have a 'February 31st'."*

- As a logged-in user, monthly and yearly recurrences roll forward to a valid date so that a task due on Jan 31 next lands on Feb 28/29, not an invalid date.
- As a logged-in user, I can turn recurrence off on an existing todo so that a routine can be retired without deleting its history.

---

## 3. User Flow

### 3.1 Creating a Recurring Todo

1. In the create form (top of `app/page.tsx`), the user sets a title and a **due date** (recurrence requires one).
2. The user checks the **"Repeat"** checkbox; this reveals a **recurrence pattern** dropdown with options **Daily / Weekly / Monthly / Yearly**.
3. The user selects a pattern and clicks **"Add"**; the create flow proceeds per PRP 01 §3.1 with `is_recurring: true` and `recurrence_pattern` included in the `POST /api/todos` body.
4. The new todo appears in the Active section (optimistic update) with a **🔄 badge** showing the pattern name.
5. If the user checks "Repeat" without a due date, the form blocks submission and shows an inline validation message (see §4.5).

### 3.2 Completing a Recurring Todo → Next Instance

1. The user toggles completion on a recurring todo (PRP 01 §3.4). `PUT /api/todos/[id]` is called with `{ completed: true }`.
2. Server-side, the handler detects `is_recurring === 1` and creates a **new todo row** for the same user with:
   - `due_date = nextDueDate(originalDueDate, pattern)` (§4.3),
   - copied `title`, `priority`, `recurrence_pattern`, `is_recurring`, `reminder_minutes`,
   - the same tag associations re-linked in `todo_tags`,
   - `completed = 0` and `last_notification_sent = NULL`.
3. The completed instance moves to the Completed section; the newly created instance appears in Active (or Overdue if its computed date is already past).
4. The client refetches (or optimistically inserts) so both the completed and the new instance render without a full reload.

### 3.3 Disabling Recurrence on an Existing Todo

1. The user clicks **"Edit"**; the edit modal shows the "Repeat" checkbox checked and the pattern pre-selected.
2. The user unchecks "Repeat" and clicks **"Update"**. `PUT /api/todos/[id]` is called with `{ is_recurring: false }`.
3. `recurrence_pattern` is set to `NULL` server-side. Completing the todo afterward no longer spawns a next instance. The 🔄 badge is removed.

---

## 4. Technical Requirements

### 4.1 Database Migration

Two columns are added to the `todos` table at `lib/db.ts` DB initialization, inside try-catch blocks so the migration is idempotent and non-destructive to PRP 01 / PRP 02 data:

```typescript
// In lib/db.ts, in the schema initialization block:
try {
  db.exec(`ALTER TABLE todos ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 0`);
} catch {
  // Column already exists — safe to ignore.
}
try {
  db.exec(`ALTER TABLE todos ADD COLUMN recurrence_pattern TEXT`);
} catch {
  // Column already exists — safe to ignore.
}
```

**Backfill behavior**: existing rows receive `is_recurring = 0` (from `NOT NULL DEFAULT 0`) and `recurrence_pattern = NULL`. No explicit `UPDATE` is required.

**Idempotency**: re-running throws `"duplicate column name"`, suppressed by the `catch`. No data is modified.

**Storage note**: SQLite has no boolean type. `is_recurring` is stored as `INTEGER` (`0`/`1`); the API layer converts to/from a JS `boolean`.

### 4.2 Types

Defined **once** in `lib/db.ts` and imported everywhere — never redeclared in routes, UI, or tests.

```typescript
// lib/db.ts — single source of truth
export type RecurrencePattern = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const RECURRENCE_VALUES: RecurrencePattern[] = ['daily', 'weekly', 'monthly', 'yearly'];

// Todo interface (extended from PRP 01):
//   is_recurring: 0 | 1;
//   recurrence_pattern: RecurrencePattern | null;
```

### 4.3 Due-Date Calculation Algorithm

A pure, unit-testable function computes the next due date. It lives in `lib/timezone.ts` (or `lib/recurrence.ts`) and operates in Singapore-time semantics — the input date is the anchor, **never** `new Date()` for "now".

```typescript
import { RecurrencePattern } from '@/lib/db';

/**
 * Returns the next due date for a recurring todo, computed from the
 * ORIGINAL due date (not "now"). Month/year rolls clamp to the last
 * valid day of the target month.
 */
export function nextDueDate(current: Date, pattern: RecurrencePattern): Date {
  const d = new Date(current);
  switch (pattern) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      return d;
    case 'weekly':
      d.setDate(d.getDate() + 7);
      return d;
    case 'monthly':
      return addMonthsClamped(d, 1);
    case 'yearly':
      return addMonthsClamped(d, 12);
  }
}

// Adds `months`, clamping the day to the last valid day of the target month.
// Jan 31 + 1 month -> Feb 28 (or Feb 29 in a leap year). Feb 29 + 12 months -> Feb 28.
function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const targetIndex = month + months;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate(); // day 0 of next month
  const clampedDay = Math.min(day, lastDay);
  const result = new Date(date);
  result.setFullYear(targetYear, targetMonth, clampedDay);
  return result;
}
```

**Time-of-day** of the original due date is preserved; only the calendar day advances.

### 4.4 Changes to Existing Endpoints

PRP 01 defined 5 endpoints. Recurrence touches **`POST /api/todos`** (accept + validate recurrence fields) and **`PUT /api/todos/[id]`** (validate on edit; spawn next instance on completion). `GET` and `DELETE` are unchanged.

---

#### `POST /api/todos` — Create Todo (modified)

**File**: `app/api/todos/route.ts`

**New body fields**:

| Field | Type | Validation | Default |
|---|---|---|---|
| `is_recurring` | boolean | Coerced to `0`/`1` for storage. | `false` |
| `recurrence_pattern` | string \| null | If `is_recurring` is true, must be one of `RECURRENCE_VALUES`; else stored `NULL`. | `null` |

**Cross-field rule**: if `is_recurring` is true, `due_date` MUST be present (§4.5) — otherwise `400 RECURRING_REQUIRES_DUE_DATE`.

---

#### `PUT /api/todos/[id]` — Update Todo (modified)

**File**: `app/api/todos/[id]/route.ts` (`params` is a Promise — `const { id } = await params`).

**Completion → next-instance logic** (the core of this PRP):

```typescript
// After loading the existing todo (ownership-checked against session.userId):
if (body.completed === true && existing.is_recurring === 1 && existing.recurrence_pattern && existing.due_date) {
  const next = nextDueDate(new Date(existing.due_date), existing.recurrence_pattern);

  // Insert the next instance. Inherit metadata; RESET notification state.
  const newId = todoDB.create({
    user_id: session.userId,
    title: existing.title,
    due_date: next.toISOString(),
    priority: existing.priority,
    is_recurring: 1,
    recurrence_pattern: existing.recurrence_pattern,
    reminder_minutes: existing.reminder_minutes ?? null,
    last_notification_sent: null,   // CRITICAL: child must be able to notify again
    completed: 0,
  });

  // Re-link the same tags (PRP 06 join table)
  for (const tagId of getTagIdsForTodo(existing.id)) {
    linkTagToTodo(newId, tagId);
  }
  // NOTE: subtasks are intentionally NOT copied (see §6.7).
}
// Then proceed to mark the existing row completed per PRP 01.
```

**Edit rules**: `is_recurring` and `recurrence_pattern` may be updated. Setting `is_recurring: false` sets `recurrence_pattern = NULL`.

### 4.5 Validation

- **Recurring requires due date**: `is_recurring` true and `due_date` absent/null on `POST`/`PUT` →
  `400 { "error": { "code": "RECURRING_REQUIRES_DUE_DATE", "message": "A recurring todo must have a due date." } }`.
- **Pattern allowlist**: `is_recurring` true and `recurrence_pattern` not in `RECURRENCE_VALUES` →
  `400 { "error": { "code": "INVALID_RECURRENCE", "message": "Recurrence must be one of: daily, weekly, monthly, yearly." } }`.
- Reuse the standard error envelope and request-size guard from PRP 01 §4.5–4.6.

---

## 5. UI Components

### 5.1 Repeat Toggle + Pattern Select (Create Form & Edit Modal)

Rendered below the due-date field in both the create form and the edit modal in `app/page.tsx`.

```tsx
// State: const [isRecurring, setIsRecurring] = useState(false);
//        const [pattern, setPattern] = useState<RecurrencePattern>('weekly');
<label className="flex items-center gap-2">
  <input
    type="checkbox"
    checked={isRecurring}
    onChange={(e) => setIsRecurring(e.target.checked)}
    disabled={!dueDate}                 // recurrence needs a due date
    aria-label="Repeat this todo"
  />
  <span>Repeat</span>
</label>

{isRecurring && (
  <select
    value={pattern}
    onChange={(e) => setPattern(e.target.value as RecurrencePattern)}
    aria-label="Recurrence pattern"
  >
    <option value="daily">Daily</option>
    <option value="weekly">Weekly</option>
    <option value="monthly">Monthly</option>
    <option value="yearly">Yearly</option>
  </select>
)}
```

The checkbox is **disabled without a due date** (mirrors the server rule). Unchecking hides the select and clears the pattern on submit.

### 5.2 Recurrence Badge (Todo Row)

```tsx
{todo.is_recurring === 1 && (
  <span
    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded
               bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
    aria-label={`Repeats ${todo.recurrence_pattern}`}
  >
    🔄 {capitalize(todo.recurrence_pattern)}
  </span>
)}
```

Badge is never color-only: it carries the pattern text and an `aria-label`.

---

## 6. Edge Cases

### 6.1 Completing a Recurring Todo Whose Due Date Is Already Past
The next instance is computed forward from the **original due date**, not from "now". A daily todo three days overdue, when completed, yields a next instance one day after its original date (which may itself be past → renders in Overdue). This keeps the cadence anchored.

### 6.2 Monthly Recurrence on the 31st
`addMonthsClamped` clamps to the last valid day: Jan 31 → Feb 28/29, Mar 31 → Apr 30. Each step clamps from the previous result (the day does not "remember" 31).

### 6.3 Yearly Recurrence on Feb 29 (Leap Day)
Feb 29 + 12 months lands on Feb 28 in a non-leap year (clamped). It does not skip to Mar 1.

### 6.4 Disabling Recurrence Then Completing
With `is_recurring = false` and `recurrence_pattern` nulled, completion spawns no child (the guard requires both `is_recurring === 1` AND a non-null pattern).

### 6.5 Recurring Todo With No Due Date Reaching the Server
Blocked at validation (§4.5). The completion logic additionally guards on `existing.due_date` before calling `nextDueDate`; if null, it skips spawning rather than throwing.

### 6.6 Reminder Inheritance Without Re-Notifying
The child copies `reminder_minutes` but resets `last_notification_sent = NULL`, so the inherited reminder is eligible to fire for the new instance (interacts with PRP 04). Omitting this reset is a silent bug — the child would never notify.

### 6.7 Subtasks Are Not Copied
Inheritance is limited to priority, tags, reminder, and pattern. Subtasks (PRP 05) are **not** duplicated; a fresh instance starts with an empty checklist.

### 6.8 Invalid Pattern String
`recurrence_pattern` not in `RECURRENCE_VALUES` → `400 INVALID_RECURRENCE`. The value is never used to build SQL.

---

## 7. Acceptance Criteria

1. **All four patterns compute correctly**: daily (+1 day), weekly (+7 days), monthly (+1 month clamped), yearly (+1 year clamped) — verified by `nextDueDate` unit tests.
2. **Next instance on completion**: completing a recurring todo creates exactly one new active todo for the same user with the recalculated due date.
3. **Metadata inheritance**: the next instance carries the same `priority`, `recurrence_pattern`, `reminder_minutes`, and tag associations as the completed one.
4. **Notification reset**: the next instance is created with `last_notification_sent = NULL`.
5. **Subtasks not inherited**: the next instance has zero subtasks regardless of the parent's subtasks.
6. **Singapore-timezone accuracy**: computed due dates preserve the original time-of-day and roll the calendar day in `Asia/Singapore` semantics.
7. **Month/leap clamping**: Jan 31 → Feb 28/29; Feb 29 → Feb 28 next year. No invalid calendar dates are ever produced.
8. **Recurring requires due date**: `POST`/`PUT` with `is_recurring: true` and no `due_date` returns `400 RECURRING_REQUIRES_DUE_DATE`.
9. **Can disable recurrence**: unchecking Repeat sets `recurrence_pattern = NULL`; subsequent completion spawns no child; the 🔄 badge disappears.
10. **Badge renders with pattern text**: recurring todos show a 🔄 badge labelled with the pattern and an `aria-label`.
11. **Type imported, not redeclared**: `RecurrencePattern` is declared only in `lib/db.ts`.

---

## 8. Out of Scope

The following are explicitly **not** part of this PRP:

- **Custom intervals**: "every 2 weeks", "every 3rd Tuesday", or cron-like schedules. Only the four fixed patterns are supported.
- **End conditions**: no "repeat until date" or "repeat N times". Recurrence continues until the user disables it.
- **Bulk generation**: only the single next instance is created on completion — not a batch of future occurrences.
- **Subtask inheritance**: not copied to the next instance (see §6.7).
- **Reminder firing mechanics** (PRP 04): this PRP only ensures the child inherits `reminder_minutes` and resets `last_notification_sent`.
- **Calendar rendering of a projected series** (PRP 10): only concrete created instances appear on the calendar.
- **Timezone selection**: all recurrence math is fixed to `Asia/Singapore` per PRP 01.

---

## 9. Success Metrics

| Metric | Target |
|---|---|
| Clamping correctness | Jan 31→Feb 28/29 and Feb 29→Feb 28 verified by UT-R04/05/07 |
| No orphaned child on disable | TC-R08 passes: disabled recurrence spawns no instance |
| Notification eligibility | TC-R06 confirms child `last_notification_sent` is null |
| Zero `RecurrencePattern` redeclarations | Confirmed by grep outside `lib/db.ts` |
| Idempotent migration | Running DB init twice adds no duplicate column and no data change |

---

## 10. GitHub Copilot Prompt

> **First read `PROGRESS.md` — my teammate's handoff summary of what's already built — then skim `lib/db.ts` and `app/page.tsx` to confirm the actual schema/UI state** (code is ground truth if it differs from the doc). I'm adding onto their work, not starting fresh. Then implement Recurring Todos per #file:PRPs/03-recurring-todos.md and `.github/copilot-instructions.md`, **additively**: add `is_recurring` + `recurrence_pattern` via idempotent `ALTER TABLE` guards, add `nextDueDate()` to `lib/timezone.ts` (month/leap clamping), wire next-instance creation into the *existing* PUT `/api/todos/[id]` completion path (inherit priority, tags, reminder; set child `last_notification_sent = NULL`; do not copy subtasks), and add the Repeat checkbox + pattern select + 🔄 badge into `app/page.tsx`. **Do not rewrite, reformat, or delete any existing schema, routes, or UI.** Code only, no explanation, skip tests — I'll verify manually.
