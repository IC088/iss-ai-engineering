# PRP 05 — Subtasks & Progress Tracking

> **Extension of PRP 01 — Todo CRUD Operations.**
> This PRP does not redefine the `todos` table, the CRUD endpoints, the error envelope, or the timezone handling — those are in PRP 01. It adds a new `subtasks` table (with cascade delete), three subtask endpoints, a progress calculation, and checklist UI on top of that foundation. Read PRP 01 first.

---

## 1. Feature Overview

The Subtasks & Progress feature lets each todo hold an ordered checklist of subtasks and shows completion as a **progress bar**. Subtasks live in their own table with a foreign key to `todos` and `ON DELETE CASCADE`, so deleting a parent todo removes its subtasks atomically. Progress is derived — `completed / total × 100` — and rendered as "X/Y completed (Z%)" with a bar that is **blue below 100% and green at 100%**. Subtasks are unlimited per todo, individually toggleable and deletable, and maintain a stable display order via a `position` column. This feature is a dependency of the Template System (PRP 07), which serializes subtasks; that serialization is defined in PRP 07, not here.

---

## 2. User Stories

### Persona A — Project Breaker-Downer
> *"A todo like 'Launch landing page' is really five steps. I want to tick them off one by one and see how close I am, not just stare at one big unchecked box."*

- As a logged-in user, I can add multiple subtasks to a todo so that I can break a large task into concrete steps.
- As a logged-in user, I can see a progress bar and a "3/5 completed" count so that I know how far along I am at a glance.

### Persona B — Tidy Finisher
> *"When I delete a task, I don't want its leftover checklist items lingering in the database. And if I remove a step that no longer applies, the progress should update immediately."*

- As a logged-in user, deleting a todo also removes all its subtasks so that no orphaned data remains.
- As a logged-in user, adding, toggling, or deleting a subtask updates the progress instantly so that the bar always reflects reality.

---

## 3. User Flow

### 3.1 Adding Subtasks

1. Each todo row has an expandable **Subtasks** section (collapsed by default; a chevron/▸ toggles it).
2. Expanded, it shows an **"Add subtask"** text input and button. Pressing **Enter** or clicking **Add** submits.
3. `POST /api/todos/[id]/subtasks` creates the subtask; it appears at the bottom of the list (highest `position`).
4. The progress bar and "X/Y completed (Z%)" label update immediately (optimistic, reconciled with the API response).

### 3.2 Toggling & Deleting Subtasks

1. Each subtask has a checkbox and a delete (🗑) button.
2. Checking/unchecking calls `PUT /api/subtasks/[id]` with `{ completed }`; the progress recomputes instantly.
3. Deleting calls `DELETE /api/subtasks/[id]`; the item is removed and totals recompute.

### 3.3 Cascade on Parent Delete

1. The user deletes the parent todo (PRP 01 §3.5).
2. The database's `ON DELETE CASCADE` removes all rows in `subtasks` for that `todo_id` in the same operation. No application-level cleanup is needed.

---

## 4. Technical Requirements

### 4.1 Database Schema

A new table is created at `lib/db.ts` init. `CREATE TABLE IF NOT EXISTS` makes it idempotent and non-destructive:

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS subtasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id    INTEGER NOT NULL,
    title      TEXT    NOT NULL,
    completed  INTEGER NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON subtasks(todo_id)`);
```

**Cascade prerequisite**: SQLite enforces foreign keys only when the pragma is on. This must be set once at connection init (PRP 01 owns the DB connection — confirm it exists, add if missing):

```typescript
db.pragma('foreign_keys = ON');
```

Without this pragma, `ON DELETE CASCADE` is silently ignored and orphaned subtasks accumulate.

### 4.2 Types & DB Methods

Defined **once** in `lib/db.ts`:

```typescript
// lib/db.ts — single source of truth
export interface Subtask {
  id: number;
  todo_id: number;
  title: string;
  completed: 0 | 1;
  position: number;
}

export const subtaskDB = {
  create(todoId: number, title: string): Subtask { /* position = max(position)+1 */ },
  listByTodo(todoId: number): Subtask[] { /* ORDER BY position ASC */ },
  toggle(id: number, completed: boolean): void { /* UPDATE completed */ },
  updateTitle(id: number, title: string): void { /* optional edit */ },
  delete(id: number): void { /* DELETE by id */ },
  ownerUserId(subtaskId: number): number | null { /* JOIN todos for ownership check */ },
};
```

All queries use prepared statements (`db.prepare(...)`). New subtask `position = (SELECT COALESCE(MAX(position), 0) + 1 FROM subtasks WHERE todo_id = ?)`.

### 4.3 Progress Calculation

Pure and unit-testable. Guards divide-by-zero for empty checklists.

```typescript
export function progress(subtasks: Subtask[]): { done: number; total: number; pct: number } {
  const total = subtasks.length;
  const done = subtasks.filter(s => s.completed === 1).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}
```

Display string: `"{done}/{total} completed ({pct}%)"`. Bar fill width = `pct%`. Bar color: **green (`bg-green-500`) when `pct === 100`**, else **blue (`bg-blue-500`)**. When `total === 0`, hide the bar (or render an empty 0% track).

### 4.4 New Endpoints

All auth-guarded (`getSession()`, `401` if none). All ownership-checked: the parent todo (or the subtask's parent) must belong to `session.userId`, else `404`/`403`. `params` is a Promise in Next.js 16.

---

#### `POST /api/todos/[id]/subtasks` — Add Subtask

**File**: `app/api/todos/[id]/subtasks/route.ts`

- Body: `{ title: string }` (non-empty, trimmed; reuse PRP 01 title validation).
- Verify the parent todo `id` belongs to the session user.
- Create with next `position`; return the created subtask.

```json
HTTP 201 { "data": { "id": 7, "todo_id": 3, "title": "Draft copy", "completed": 0, "position": 2 } }
```

#### `PUT /api/subtasks/[id]` — Update Subtask

**File**: `app/api/subtasks/[id]/route.ts`

- Body: `{ completed?: boolean, title?: string }`.
- Verify ownership via `subtaskDB.ownerUserId(id) === session.userId`.
- Update and return the updated subtask (or `{ data: { ok: true } }`).

#### `DELETE /api/subtasks/[id]` — Delete Subtask

**File**: `app/api/subtasks/[id]/route.ts`

- Verify ownership; delete the row; return `200 { "data": { "ok": true } }`.

### 4.5 Loading Subtasks With Todos

Subtasks are fetched per todo. Either extend the `GET /api/todos/[id]` response to embed `subtasks`, or expose them via `listByTodo` when a row is expanded. To avoid an N+1 on the main list, the recommended approach is to fetch subtasks lazily on expand (one query per opened row), consistent with PRP 01's client-driven UI.

---

## 5. UI Components

### 5.1 Expandable Subtasks Section (Todo Row)

```tsx
const [expanded, setExpanded] = useState(false);
const [subtasks, setSubtasks] = useState<Subtask[]>([]);
const p = progress(subtasks);

<button onClick={() => setExpanded(v => !v)} aria-expanded={expanded} aria-label="Toggle subtasks">
  {expanded ? '▾' : '▸'} Subtasks
</button>

{expanded && (
  <div>
    {/* progress bar */}
    <div className="h-2 w-full rounded bg-gray-200 dark:bg-gray-700">
      <div
        className={`h-2 rounded ${p.pct === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
        style={{ width: `${p.pct}%` }}
        role="progressbar"
        aria-valuenow={p.pct}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
    <p className="text-xs mt-1">{p.done}/{p.total} completed ({p.pct}%)</p>

    {/* list */}
    {subtasks.map(s => (
      <div key={s.id} className="flex items-center gap-2">
        <input type="checkbox" checked={s.completed === 1} onChange={() => toggleSubtask(s)} />
        <span className={s.completed ? 'line-through opacity-60' : ''}>{s.title}</span>
        <button onClick={() => deleteSubtask(s.id)} aria-label="Delete subtask">🗑</button>
      </div>
    ))}

    {/* add */}
    <SubtaskInput onAdd={(title) => addSubtask(todo.id, title)} />
  </div>
)}
```

### 5.2 Add-Subtask Input

An input plus button; **Enter submits**; blank/whitespace titles are ignored client-side and rejected server-side.

---

## 6. Edge Cases

### 6.1 Empty Checklist (0 Subtasks)
`progress([])` returns `{ done: 0, total: 0, pct: 0 }` — no divide-by-zero. The bar is hidden or shows an empty 0% track.

### 6.2 All Subtasks Completed
When `done === total` and `total > 0`, `pct === 100` and the bar turns green. Toggling one back to incomplete returns it to blue.

### 6.3 Deleting the Parent Todo Cascades
With `foreign_keys = ON`, deleting the todo removes its subtasks in the same DB operation. Verified by TC-S05 asserting zero remaining subtask rows.

### 6.4 Empty / Whitespace Subtask Title
Rejected: client ignores blank input; server returns `400 EMPTY_TITLE` (reuse PRP 01 validation). No empty subtask is created.

### 6.5 Rounding Behavior
`progress` uses `Math.round`. 1/3 → 33%, 2/3 → 67%, 5/6 → 83%. The bar width matches the rounded percentage.

### 6.6 Cross-User Access Attempt
`PUT`/`DELETE /api/subtasks/[id]` for a subtask whose parent todo belongs to another user returns `404` (do not reveal existence). Enforced via the ownership join.

### 6.7 Rapid Add/Delete Ordering
`position` is assigned as `MAX(position)+1` at insert. After deletions, positions may be non-contiguous but remain monotonic; the list orders by `position ASC`. No reindexing is required.

### 6.8 Non-Integer or Unknown Subtask ID
`/api/subtasks/abc` or an unknown id → `400 INVALID_ID` / `404 NOT_FOUND` per PRP 01 §6.7.

---

## 7. Acceptance Criteria

1. **Unlimited subtasks**: a todo can hold any number of subtasks; each appears in insertion order.
2. **Toggle completion**: checking/unchecking a subtask persists via `PUT /api/subtasks/[id]` and updates the UI immediately.
3. **Real-time progress**: adding, toggling, or deleting a subtask recomputes "X/Y completed (Z%)" and the bar width without a page reload.
4. **Accurate bar**: bar fill equals `pct%`; color is green at exactly 100% and blue otherwise.
5. **Empty state safe**: a todo with zero subtasks shows 0/0 (0%) with no error.
6. **Cascade delete**: deleting a parent todo removes all its subtasks (zero orphaned rows).
7. **Ownership enforced**: subtask mutations are scoped to the owning user; cross-user access returns 404.
8. **Title validation**: blank/whitespace subtask titles are rejected.
9. **Stable ordering**: subtasks render by `position ASC`; new items append at the end.
10. **Types imported, not redeclared**: `Subtask` and `progress()` are declared only in `lib/db.ts` / the shared lib.

---

## 8. Out of Scope

The following are explicitly **not** part of this PRP:

- **Nested / multi-level subtasks**: subtasks are one level deep; a subtask cannot have its own subtasks.
- **Drag-and-drop reordering**: `position` is assigned at insert; manual reordering is not implemented.
- **Subtask due dates, priorities, reminders, or tags**: subtasks have only a title and a completed flag.
- **Bulk operations**: no "check all" / "clear completed" controls.
- **Template serialization** (PRP 07): converting subtasks to/from JSON for templates is defined in PRP 07.
- **Recurring inheritance** (PRP 03): recurring next-instances do not copy subtasks (see PRP 03 §6.7).
- **Progress on the parent's own completion**: completing all subtasks does not auto-complete the parent todo; they are independent.

---

## 9. Success Metrics

| Metric | Target |
|---|---|
| Cascade correctness | TC-S05 confirms zero orphaned subtasks after parent delete |
| Progress accuracy | Bar width == pct; green only at 100% (TC-S02) |
| No divide-by-zero | UT-S01 passes for the empty list |
| Ownership isolation | TC-S07 returns 404 for cross-user access |
| Idempotent schema | Running DB init twice creates no duplicate table and no data change |

---

## 10. GitHub Copilot Prompt

> **First read `lib/db.ts` and `app/page.tsx`** to see what's already built (PRP 01/02 and features 03–04 are in place) — I'm adding onto that work, not starting fresh. Then implement Subtasks & Progress per #file:PRPs/05-subtasks-progress.md and `.github/copilot-instructions.md`, **additively**: create the `subtasks` table with `ON DELETE CASCADE` via `CREATE TABLE IF NOT EXISTS` (ensure `PRAGMA foreign_keys = ON`), add `subtaskDB` CRUD (prepared statements) to `lib/db.ts`, build the three API routes (`POST /api/todos/[id]/subtasks`, `PUT` & `DELETE /api/subtasks/[id]` — async `params`, ownership-checked), add the pure `progress()` helper, and wire the expandable checklist + real-time progress bar (green at 100%, else blue) into `app/page.tsx`. **Do not rewrite, reformat, or delete any existing schema, routes, or UI.** Code only, no explanation, skip tests — I'll verify manually.
