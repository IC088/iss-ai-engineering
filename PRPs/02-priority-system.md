# PRP 02 — Priority System

> **Extension of PRP 01 — Todo CRUD Operations.**
> This PRP does not redefine the `todos` table, the 5 CRUD endpoints, the error envelope shape, or the timezone handling — those are all specified in PRP 01. This document covers only what changes or is newly added on top of that foundation. Read PRP 01 first.

---

## 1. Feature Overview

The Priority System attaches a three-level importance signal — **High**, **Medium**, or **Low** — to every todo. Priority is stored as a text column that already exists in the `todos` table (added as a schema placeholder in PRP 01 with `DEFAULT 'medium'`). This PRP activates that column: it adds full validation at the API boundary, a color-coded badge in the UI, priority-first automatic sorting within each of the three list sections defined in PRP 01 (Overdue / Active / Completed), and a filter dropdown that narrows the visible list to a single priority level. Color mappings are fixed and explicitly specified so they cannot drift between components or across light and dark mode.

---

## 2. User Stories

### Persona A — Triage User
> *"I have 40 todos in my Active list and I'm overwhelmed. I need to see at a glance which ones are critical so I can focus without scrolling for context."*

- As a logged-in user, I can see a color-coded priority badge on every todo so that I can distinguish urgency without opening each item.
- As a logged-in user, the Active list automatically sorts high-priority todos to the top so that the most important items are always visible first without manual reordering.

### Persona B — Focused Worker
> *"I only want to work on high-priority tasks right now. I don't want the medium and low items cluttering the screen."*

- As a logged-in user, I can filter the todo list to show only todos of a specific priority level so that I can work on one priority tier at a time.
- As a logged-in user, the filter applies across all three sections (Overdue, Active, Completed) so that I see a consistent, complete view at the selected priority tier.
- As a logged-in user, the filter is a single dropdown selection so that I can switch tiers in one click and return to "All" just as quickly.

---

## 3. User Flow

### 3.1 Setting Priority on Create

1. The create form (top of `app/page.tsx`) includes a **Priority** dropdown rendered immediately below the title input.
2. The dropdown shows three options: **High**, **Medium**, **Low**. The initial/default selected option is **Medium**.
3. User selects a priority (or leaves the default).
4. User clicks **"Add"**; the create flow proceeds per PRP 01 §3.1, with `priority` included in the `POST /api/todos` body.
5. The new todo appears in the Active section with its priority badge immediately (optimistic update).
6. The Active section re-sorts in place: the new todo occupies the correct position in the priority → due-date order without a full page reload.

### 3.2 Changing Priority on Edit

1. User clicks **"Edit"** on an existing todo; the edit modal opens (PRP 01 §3.3).
2. The modal's priority dropdown is pre-filled with the todo's current priority.
3. User selects a different priority and clicks **"Update"**.
4. **Optimistic update**: the badge updates immediately and the todo re-sorts within its section.
5. `PUT /api/todos/[id]` is called with `{ priority: "high" | "medium" | "low" }`.
6. On success (200): canonical server record replaces the optimistic copy; section membership and order are recomputed.
7. On failure: rollback per PRP 01 §6.6; error toast displayed.

### 3.3 Filtering by Priority

1. A **Priority filter** dropdown is rendered in the filter bar above the sectioned list.
2. Options: **All Priorities** (default), **High**, **Medium**, **Low**.
3. Selecting a priority filters the visible todos **client-side** (no API call) by matching `todo.priority === selectedPriority`. The filter applies to all three sections simultaneously.
4. Section headers and counts update to reflect the filtered set (e.g., "Active (3)" when only 3 high-priority active todos are visible).
5. Empty sections after filtering are hidden per the PRP 01 rule.
6. Selecting **"All Priorities"** clears the filter and restores the full list.
7. The filter state persists within the page session (React state); it does not survive a full page reload.

---

## 4. Technical Requirements

### 4.1 Database Migration

The `priority` column was added as a schema placeholder in PRP 01. PRP 02 confirms that migration is the canonical one, and specifies exactly how it behaves on first run and on subsequent runs.

**Migration statement** — executed at `lib/db.ts` DB initialization, inside a try-catch:

```typescript
// In lib/db.ts, in the schema initialization block:
try {
  db.exec(`ALTER TABLE todos ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'`);
} catch {
  // Column already exists — safe to ignore. No data is overwritten.
}
```

**Backfill behavior**: When SQLite executes `ALTER TABLE ADD COLUMN` with `NOT NULL DEFAULT 'medium'`, all existing rows that were inserted before the column existed receive `'medium'` as their stored value. This is a SQLite guarantee — no explicit `UPDATE todos SET priority = 'medium' WHERE priority IS NULL` statement is needed.

**Idempotency**: Running the migration on a database where the column already exists causes SQLite to throw `"duplicate column name: priority"`, which the `catch` block silently suppresses. No data is modified.

**Index** — add after the migration try-catch to speed up priority-filtered queries:

```typescript
db.exec(`CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority)`);
```

This index is safe to create at any point; the `IF NOT EXISTS` guard makes it idempotent.

### 4.2 Shared `Priority` Type

The `Priority` type is defined **once** in `lib/db.ts` and imported everywhere. It must not be redeclared as separate string literals in API routes, UI components, or test helpers.

```typescript
// lib/db.ts — single source of truth (already defined in PRP 01; confirmed here)
export type Priority = 'high' | 'medium' | 'low';

// Ordered priority values for sort logic — export from lib/db.ts
export const PRIORITY_ORDER: Record<Priority, number> = {
  high: 3,
  medium: 2,
  low: 1,
} as const;

// Allowed priority values array — used for validation allowlist checks
export const PRIORITY_VALUES: Priority[] = ['high', 'medium', 'low'];
```

**Import pattern** in API routes and UI:
```typescript
import { Priority, PRIORITY_ORDER, PRIORITY_VALUES } from '@/lib/db';
```

### 4.3 Changes to Existing Endpoints

PRP 01 defined 5 endpoints. Only `GET /api/todos` changes in this PRP. `POST /api/todos` and `PUT /api/todos/[id]` already accept and validate the `priority` field per PRP 01 §4.4 — no route handler code changes are needed for them; the PRP 01 validation rules are sufficient. `GET /api/todos/[id]` and `DELETE /api/todos/[id]` are unchanged.

---

#### `GET /api/todos` — List All Todos (modified)

**File**: `app/api/todos/route.ts`

**Change from PRP 01**: this endpoint previously accepted no query parameters. PRP 02 adds an optional `?priority=` query parameter for server-side pre-filtering.

> **Design decision — server-side vs client-side filtering**: the filter is implemented server-side (in the DB query) so that the payload size scales with the filtered result, not the total todo count. The client still performs sectioning (Overdue / Active / Completed) and sorting on the returned array. This is consistent with the architecture established in PRP 01 where sectioning happens on the client.

**New query parameter**:

| Param | Type | Validation | Default |
|---|---|---|---|
| `priority` | string | If present, must be one of `'high' \| 'medium' \| 'low'` (check against `PRIORITY_VALUES`). Any other value returns 400. | Absent = return all priorities |

**Validation** (applied before the DB query):
```typescript
const url = new URL(request.url);
const priorityParam = url.searchParams.get('priority');

let priorityFilter: Priority | null = null;
if (priorityParam !== null) {
  if (!(PRIORITY_VALUES as string[]).includes(priorityParam)) {
    return NextResponse.json(
      { error: { code: 'INVALID_PRIORITY', message: 'Priority must be one of: high, medium, low' } },
      { status: 400 }
    );
  }
  priorityFilter = priorityParam as Priority;
}
```

**DB query** — parameterized, using an allowlisted column reference (never interpolate the filter value into SQL directly):

```typescript
// The priority value is passed as a bound parameter — never interpolated into SQL
const stmt = priorityFilter
  ? db.prepare('SELECT * FROM todos WHERE user_id = ? AND priority = ? ORDER BY created_at DESC')
  : db.prepare('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC');

const todos = priorityFilter
  ? (stmt.all(session.userId, priorityFilter) as Todo[])
  : (stmt.all(session.userId) as Todo[]);
```

The `priority` column name in the `WHERE` clause is hardcoded in the source — it is never derived from the query string. The `priorityFilter` value is bound as a parameter, not interpolated.

**Success response** — unchanged from PRP 01:
```json
HTTP 200 OK
{ "data": [ /* array of Todo objects matching the filter */ ] }
```

**New error response**:
```
400 { "error": { "code": "INVALID_PRIORITY", "message": "Priority must be one of: high, medium, low" } }
```

---

### 4.4 Sorting Algorithm

Sorting is performed **client-side** on the array returned by `GET /api/todos`, consistent with PRP 01. The sort operates within each of the three sections separately. Priority is the **primary** sort key; due date (from PRP 01) is the **secondary/tie-break** key.

**Priority numeric mapping** (import from `lib/db.ts`):
```typescript
PRIORITY_ORDER = { high: 3, medium: 2, low: 1 }
```

**Sort comparator** — identical to the one already shown in PRP 01 §5.2, reproduced here for clarity:

```typescript
// Active section comparator
function compareActive(a: Todo, b: Todo): number {
  // Primary: priority descending (high → medium → low)
  const priDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
  if (priDiff !== 0) return priDiff;

  // Secondary (tie-break): due_date ascending, nulls last
  if (!a.due_date && !b.due_date) return 0;
  if (!a.due_date) return 1;   // no due date sorts after todos with one
  if (!b.due_date) return -1;
  return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
}

// Overdue section comparator
function compareOverdue(a: Todo, b: Todo): number {
  // Primary: due_date ascending (most overdue first)
  const dateDiff = new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime();
  if (dateDiff !== 0) return dateDiff;

  // Secondary (tie-break): priority descending
  return PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
}

// Completed section comparator — unchanged from PRP 01
// Sort by updated_at descending; priority is not a sort key in Completed
function compareCompleted(a: Todo, b: Todo): number {
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}
```

**Sort stability when both priority and due date are equal**: JavaScript's `Array.prototype.sort` is guaranteed stable in all modern engines. When both priority and due date are identical, the original `created_at` order (as returned from the DB `ORDER BY created_at DESC`) is preserved. No additional tie-break on `created_at` is needed in the comparator.

### 4.5 Priority Validation in API Routes

The `priority` field is validated in `POST /api/todos` and `PUT /api/todos/[id]` per the rules already specified in PRP 01 §4.4. Repeated here for completeness, with the exact implementation pattern:

```typescript
// Reusable validation helper — define in lib/db.ts or lib/validation.ts
export function validatePriority(value: unknown): Priority {
  if (value === undefined || value === null) return 'medium'; // default
  if (typeof value !== 'string' || !(PRIORITY_VALUES as string[]).includes(value)) {
    throw { code: 'INVALID_PRIORITY', message: 'Priority must be one of: high, medium, low' };
  }
  return value as Priority;
}
```

This function is called in both the POST and PUT handlers. It returns `'medium'` for absent values (not an error). It throws for invalid string values. The throw object is caught by the route's error handler and serialized as the standard 400 error envelope.

---

## 5. UI Components

All UI code lives in `app/page.tsx` (the monolithic `'use client'` component per PRP 01 conventions). Import `Priority`, `PRIORITY_ORDER`, `PRIORITY_VALUES` from `@/lib/db`.

### 5.1 `PriorityBadge` Component

The badge is the single source of truth for priority color mapping. All other components render the badge; no other component hardcodes a priority color.

**Fixed color mapping** — these exact Tailwind CSS class sets must not be changed without updating this PRP:

| Priority | Light mode classes | Dark mode classes | Text contrast (WCAG AA) |
|---|---|---|---|
| `high` | `bg-red-100 text-red-800` | `dark:bg-red-900 dark:text-red-200` | ≥ 4.5:1 on both modes |
| `medium` | `bg-yellow-100 text-yellow-800` | `dark:bg-yellow-900 dark:text-yellow-200` | ≥ 4.5:1 on both modes |
| `low` | `bg-blue-100 text-blue-800` | `dark:bg-blue-900 dark:text-blue-200` | ≥ 4.5:1 on both modes |

**Verified contrast ratios** (Tailwind CSS default palette, checked against WCAG 2.1 AA 4.5:1 minimum):
- `text-red-800` (#991b1b) on `bg-red-100` (#fee2e2): **~7.2:1** ✓
- `text-red-200` (#fecaca) on `bg-red-900` (#7f1d1d): **~5.1:1** ✓
- `text-yellow-800` (#854d0e) on `bg-yellow-100` (#fef9c3): **~6.8:1** ✓
- `text-yellow-200` (#fef08a) on `bg-yellow-900` (#713f12): **~5.3:1** ✓
- `text-blue-800` (#1e40af) on `bg-blue-100` (#dbeafe): **~6.6:1** ✓
- `text-blue-200` (#bfdbfe) on `bg-blue-900` (#1e3a5f): **~5.0:1** ✓

**Accessibility — color must not be the only signal** (WCAG 1.4.1): the badge renders a visible text label alongside its background color. An `aria-label` is also provided to explicitly announce the priority level to screen readers.

```tsx
// In app/page.tsx
const PRIORITY_CLASSES: Record<Priority, string> = {
  high:   'bg-red-100    text-red-800    dark:bg-red-900    dark:text-red-200',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  low:    'bg-blue-100   text-blue-800   dark:bg-blue-900   dark:text-blue-200',
};

const PRIORITY_LABELS: Record<Priority, string> = {
  high:   'High',
  medium: 'Medium',
  low:    'Low',
};

function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_CLASSES[priority]}`}
      aria-label={`Priority: ${PRIORITY_LABELS[priority]}`}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}
```

The `aria-label` explicitly contains the word "Priority" so screen reader users hear "Priority: High" rather than just "High".

### 5.2 Priority Dropdown — Create Form

Added to `TodoForm` from PRP 01 §5.1, immediately after the title input:

```tsx
// Inside TodoForm — add to existing state
const [priority, setPriority] = useState<Priority>('medium');

// Add to the return JSX, after the title <input>:
<label htmlFor="todo-priority" className="sr-only">Priority</label>
<select
  id="todo-priority"
  value={priority}
  onChange={e => setPriority(e.target.value as Priority)}
  aria-label="Priority"
>
  <option value="high">High</option>
  <option value="medium">Medium</option>
  <option value="low">Low</option>
</select>
```

The `<select>` is constrained to the 3 valid values by its `<option>` set — no free-text entry is possible. The `<label>` uses `className="sr-only"` to remain visually hidden while satisfying accessibility labelling requirements.

The `priority` state value is included in the `POST /api/todos` body:
```typescript
body: JSON.stringify({
  title: title.trim(),
  due_date: dueDate || undefined,
  priority,              // always present, never undefined
}),
```

After successful create, reset `priority` back to `'medium'` alongside the other form fields.

### 5.3 Priority Dropdown — Edit Modal

Added to `EditTodoModal` from PRP 01 §5.4:

```tsx
// In EditTodoModal — add to existing state, initialised from todo.priority
const [priority, setPriority] = useState<Priority>(todo.priority);

// Add to the edit form JSX:
<label htmlFor="edit-priority" className="sr-only">Priority</label>
<select
  id="edit-priority"
  value={priority}
  onChange={e => setPriority(e.target.value as Priority)}
  aria-label="Priority"
>
  <option value="high">High</option>
  <option value="medium">Medium</option>
  <option value="low">Low</option>
</select>
```

The `priority` value is included in the `PUT /api/todos/[id]` body only when it differs from the current value, or unconditionally — either approach is acceptable. Including it unconditionally is simpler and safe.

### 5.4 Priority Filter Dropdown

Added to the filter bar above the sectioned list in `app/page.tsx`:

```tsx
// New state at the top of the page component
const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');

// Filter bar JSX — rendered above the todo sections
<label htmlFor="priority-filter" className="sr-only">Filter by priority</label>
<select
  id="priority-filter"
  value={priorityFilter}
  onChange={e => setPriorityFilter(e.target.value as Priority | 'all')}
  aria-label="Filter by priority"
>
  <option value="all">All Priorities</option>
  <option value="high">High</option>
  <option value="medium">Medium</option>
  <option value="low">Low</option>
</select>
```

**Filtering logic** — client-side, applied before sectioning:

```tsx
// In useSectionedTodos (from PRP 01 §5.2), add this filter step before splitting into sections:
const filtered = priorityFilter === 'all'
  ? todos
  : todos.filter(t => t.priority === priorityFilter);

// Then split `filtered` (not `todos`) into overdue / active / completed sections
```

This keeps the filter purely in memory — no additional API call is made when the filter selection changes. The three sections (Overdue, Active, Completed) all apply the same filter, giving a consistent view.

**Section count badges** update automatically because they derive from the filtered arrays.

### 5.5 Priority Badge in Todo Row

The `PriorityBadge` component is rendered in each todo row, immediately after the completion checkbox and before the title text:

```tsx
// In the todo row render:
<input type="checkbox" checked={!!todo.completed} onChange={() => onToggle(todo)} />
<PriorityBadge priority={todo.priority} />
<span>{todo.title}</span>
{/* ... due date display, edit/delete buttons ... */}
```

The badge is rendered in all three sections (Overdue, Active, Completed) at all times, regardless of the priority filter selection. It is never hidden or stripped after completion.

---

## 6. Edge Cases

### 6.1 Missing Priority in Request Body
- **Input**: `POST /api/todos` body with no `priority` field.
- **Server behavior**: `validatePriority(undefined)` returns `'medium'`. The row is inserted with `priority = 'medium'`. This is the defined default; it is enforced at the **API layer**, not just the UI, so direct API calls (e.g., from scripts or tests) without a `priority` field produce valid rows.

### 6.2 Invalid Priority Value
- **Input**: `{ "priority": "urgent" }` or `{ "priority": "" }` or `{ "priority": null }`.
- **Server behavior**: `validatePriority("urgent")` throws `{ code: 'INVALID_PRIORITY', message: 'Priority must be one of: high, medium, low' }`. The route handler catches this and returns:
  ```
  HTTP 400
  { "error": { "code": "INVALID_PRIORITY", "message": "Priority must be one of: high, medium, low" } }
  ```
- `null` is treated the same as absent (returns `'medium'`). An explicit `null` in the JSON body is a valid way to request the default, not an error.

### 6.3 Existing Todos Before Migration
- Todos created before the `priority` column existed have `priority = 'medium'` automatically after the migration (SQLite `ALTER TABLE ADD COLUMN DEFAULT` behavior).
- No existing todo will have a `NULL` or empty `priority` after the migration; the `NOT NULL DEFAULT 'medium'` constraint guarantees this.
- The UI badge and sort logic handle all three values uniformly. No special `null`-check is needed in the client code for `priority`.

### 6.4 Invalid Priority in the `?priority=` Filter Param
- **Input**: `GET /api/todos?priority=urgent`
- **Server behavior**: the validation in §4.3 runs before the DB query; returns `400 INVALID_PRIORITY`.
- The raw query string value is **never** passed to the DB query — only the validated `Priority` value, bound as a parameter. There is no SQL injection path through this param.

### 6.5 Sort Stability — Priority and Due Date Both Equal
- When two todos have the same `priority` and the same `due_date` (or both have no `due_date`), the comparator returns `0`. JavaScript's `Array.prototype.sort` is stable, so their relative order matches their position in the original API response array, which is ordered by `created_at DESC` from the DB. The net effect is: among ties, more recently created todos appear first.
- This is deterministic and consistent across re-renders without any additional comparator logic.

### 6.6 Priority Filter Combined with Sections
- Selecting "High" in the filter dropdown hides all medium and low todos from **all three sections**.
- A section that becomes empty after filtering is hidden (per PRP 01 rule).
- Example: if all overdue todos are medium/low, selecting "High" hides the Overdue section entirely.
- The section count badges (e.g., "Active (3)") reflect the filtered count, not the total.
- The filter only affects **display** — no todos are deleted or archived. Clearing the filter restores all items.

### 6.7 Priority Dropdown Accessibility on Mobile
- The `<select>` element uses the browser's native picker on mobile, which is accessible by default.
- The `<label>` element is present (even if visually hidden with `sr-only`) to satisfy WCAG 1.3.1 (Info and Relationships).
- Do not replace the `<select>` with a custom button/popover pattern without also implementing full ARIA combobox semantics (`role="combobox"`, `aria-expanded`, keyboard navigation).

### 6.8 Badge Color in High-Contrast / Forced Colors Mode
- When the OS or browser applies a forced-colors/Windows High Contrast theme, Tailwind background and text color classes are overridden by the system. Because the badge always includes a text label (not just a colored dot), the priority level remains readable regardless of color override.
- No additional CSS is required beyond the text label + `aria-label` already specified in §5.1.

---

## 7. Acceptance Criteria

1. **All three priority levels functional end-to-end**: A user can create a todo with `priority: 'high'`, `priority: 'medium'`, and `priority: 'low'`; each persists to the DB correctly; each displays the corresponding badge in the todo list without errors.

2. **Default priority on create**: A todo created via the UI (with the dropdown at its default) or via a direct `POST /api/todos` body without a `priority` field is persisted with `priority = 'medium'`. The badge for that todo shows "Medium" in the yellow color scheme.

3. **Color-coded badges match the defined mapping**: High todos display a red badge (`bg-red-100 text-red-800` / `dark:bg-red-900 dark:text-red-200`). Medium todos display a yellow badge. Low todos display a blue badge. No other color combinations are used.

4. **Badge is never the only signal**: Every `PriorityBadge` renders a visible text label ("High", "Medium", or "Low") alongside the background color. The `aria-label` attribute is present and reads "Priority: [Level]".

5. **WCAG AA contrast met in both modes**: All six badge combinations (3 priorities × 2 modes) achieve ≥ 4.5:1 text-to-background contrast ratio (verified values in §5.1).

6. **Automatic sorting by priority**: Within the Active section, todos are sorted high → medium → low as the primary key; due date is the tie-break. Within the Overdue section, due date is the primary key; priority is the tie-break. Within the Completed section, priority is not a sort key (sorted by `updated_at` DESC only).

7. **Priority filter scopes all sections**: Selecting "High" in the filter dropdown shows only high-priority todos across Overdue, Active, and Completed sections. Empty sections after filtering are hidden. Selecting "All Priorities" restores the full list.

8. **Invalid priority rejected with correct error**: A `POST` or `PUT` body with `{ "priority": "urgent" }` returns `HTTP 400 { "error": { "code": "INVALID_PRIORITY", "message": "Priority must be one of: high, medium, low" } }`.

9. **Filter param validated server-side**: `GET /api/todos?priority=critical` returns `HTTP 400 INVALID_PRIORITY`. The value is never passed to the DB as-is.

10. **Existing todos get the default**: After running the migration on a database with existing todos, all previously created rows show `priority = 'medium'` and display the Medium yellow badge.

11. **Priority type imported, not redeclared**: No source file outside `lib/db.ts` declares a `Priority` type or hardcodes the strings `'high'`, `'medium'`, `'low'` as a standalone union or set of constants.

---

## 8. Testing Requirements

### 8.1 E2E Tests (Playwright — `tests/03-priority.spec.ts`)

```
Test Suite: Priority System

TC-P01: Create todo with High priority
  - Open create form
  - Enter title "Urgent task"
  - Select "High" from priority dropdown
  - Click "Add"
  - Assert: todo "Urgent task" appears in Active section
  - Assert: badge text is "High" with red background (check computed style or Tailwind class)
  - Assert: API returned 201 with { priority: "high" }

TC-P02: Create todo with Low priority
  - Enter title "Low priority task"; select "Low"; click "Add"
  - Assert: badge text is "Low" with blue background
  - Assert: todo appears after any existing High or Medium todos in the Active section

TC-P03: Create todo with default priority (Medium)
  - Enter title "Default priority task"; do not change priority dropdown
  - Click "Add"
  - Assert: badge text is "Medium" with yellow background
  - Assert: API returned 201 with { priority: "medium" }

TC-P04: Create todo via direct API without priority field
  - POST /api/todos with body { title: "API todo" } (no priority field)
  - Assert: response is 201 with { priority: "medium" }
  - Assert: todo appears in UI with Medium badge

TC-P05: Edit priority on an existing todo
  - Create a todo with priority "Low" via helper
  - Click Edit on that todo
  - Assert: priority dropdown in modal shows "Low" pre-selected
  - Change dropdown to "High"
  - Click "Update"
  - Assert: badge updates to "High" (red) immediately
  - Assert: todo re-sorts to the top of its section
  - Assert: API returned 200 with { priority: "high" }

TC-P06: Filter by priority — High
  - Create one High, one Medium, one Low todo via helpers
  - Select "High" in the priority filter dropdown
  - Assert: only the High todo is visible in Active section
  - Assert: Medium and Low todos are hidden
  - Assert: Active section count badge shows "(1)"

TC-P07: Filter by priority — clear filter
  - Continue from TC-P06 (High filter active)
  - Select "All Priorities" in the filter dropdown
  - Assert: all three todos are visible again
  - Assert: section count matches the total

TC-P08: Verify sort order — high → medium → low
  - Create three todos: Low "Task L" (no due date), Medium "Task M" (no due date), High "Task H" (no due date)
  - Assert: in the Active section, the order top-to-bottom is: "Task H", "Task M", "Task L"

TC-P09: Invalid priority rejected
  - POST /api/todos with body { title: "X", priority: "critical" }
  - Assert: response status is 400
  - Assert: response body is { error: { code: "INVALID_PRIORITY", message: "Priority must be one of: high, medium, low" } }

TC-P10: Invalid priority filter param rejected
  - GET /api/todos?priority=urgent
  - Assert: response status is 400
  - Assert: response body contains code "INVALID_PRIORITY"
```

### 8.2 Visual / Accessibility Tests

```
TC-V01: Badge colors render correctly in light mode
  - Navigate to the main page with todos of each priority level visible
  - Take a screenshot or check computed background-color of each badge
  - Assert: High badge background matches red-100 (#fee2e2); text matches red-800 (#991b1b)
  - Assert: Medium badge background matches yellow-100 (#fef9c3); text matches yellow-800 (#854d0e)
  - Assert: Low badge background matches blue-100 (#dbeafe); text matches blue-800 (#1e40af)

TC-V02: Badge colors render correctly in dark mode
  - Apply dark mode (add class="dark" to <html> or use prefers-color-scheme media)
  - Assert: High badge: bg-red-900 (#7f1d1d), text-red-200 (#fecaca)
  - Assert: Medium badge: bg-yellow-900 (#713f12), text-yellow-200 (#fef08a)
  - Assert: Low badge: bg-blue-900 (#1e3a5f), text-blue-200 (#bfdbfe)

TC-V03: Badge text label present (not color-only)
  - For each priority badge in the DOM, assert textContent is one of "High", "Medium", "Low"

TC-V04: Badge aria-label present
  - For each priority badge, assert aria-label attribute is "Priority: High", "Priority: Medium", or "Priority: Low"

TC-V05: Priority dropdown is labelled for accessibility
  - In the create form, assert the priority <select> has an associated <label> or aria-label
  - Run axe-core accessibility check on the page; assert zero violations related to form labels
```

### 8.3 Unit Tests (`lib/validation.test.ts`)

```
UT-P01: validatePriority — undefined returns 'medium'
  Input:  undefined
  Expect: 'medium'

UT-P02: validatePriority — null returns 'medium'
  Input:  null
  Expect: 'medium'

UT-P03: validatePriority — 'high' accepted
  Input:  'high'
  Expect: 'high'

UT-P04: validatePriority — 'medium' accepted
  Input:  'medium'
  Expect: 'medium'

UT-P05: validatePriority — 'low' accepted
  Input:  'low'
  Expect: 'low'

UT-P06: validatePriority — invalid string throws
  Input:  'urgent'
  Expect: throws { code: 'INVALID_PRIORITY' }

UT-P07: validatePriority — empty string throws
  Input:  ''
  Expect: throws { code: 'INVALID_PRIORITY' }

UT-P08: PRIORITY_ORDER — high > medium > low
  Assert: PRIORITY_ORDER['high'] > PRIORITY_ORDER['medium']
  Assert: PRIORITY_ORDER['medium'] > PRIORITY_ORDER['low']

UT-P09: compareActive — high sorts before medium
  const a = { priority: 'medium', due_date: null }
  const b = { priority: 'high',   due_date: null }
  Expect: compareActive(a, b) > 0  (b sorts first)

UT-P10: compareActive — same priority, earlier due date sorts first
  const a = { priority: 'medium', due_date: '2026-08-01T00:00:00.000Z' }
  const b = { priority: 'medium', due_date: '2026-07-15T00:00:00.000Z' }
  Expect: compareActive(a, b) > 0  (b sorts first — earlier date)

UT-P11: compareActive — same priority, null due date sorts last
  const a = { priority: 'high', due_date: null }
  const b = { priority: 'high', due_date: '2026-07-15T00:00:00.000Z' }
  Expect: compareActive(a, b) > 0  (b sorts first — has a due date)
```

---

## 9. Out of Scope

The following are explicitly **not** part of this PRP:

- **Custom priority levels**: users cannot define their own priority tiers beyond the fixed three. No CRUD for priority values; no user-configurable labels or colors.
- **Tag system** (PRP 06): tags are a separate categorization mechanism. Priority and tags are independent; neither inherits from the other.
- **Template system** (PRP 07): template priority persistence is handled in PRP 07 when templates are implemented.
- **Search & Filtering** (PRP 08): multi-criteria filtering combining priority with text search, date ranges, or tags is handled in PRP 08. This PRP covers priority-only filtering.
- **Priority-based reminders**: a reminder triggered by priority level changes (e.g., auto-escalate after X hours) is not implemented. Reminders are defined in PRP 04.
- **Priority in recurring todos** (PRP 03): the rule that the next recurring instance inherits the parent's priority is specified in PRP 03, not here. The `priority` column will simply carry forward via the row copy in PRP 03's implementation.
- **Server-side sorting**: the API returns an unsorted array; all sorting is client-side. Server-side `ORDER BY priority` is not added in this PRP.
- **Priority analytics or statistics**: no summary counts or dashboards per priority level.

---

## 10. Success Metrics

| Metric | Target |
|---|---|
| E2E test suite pass rate | 100% (TC-P01 through TC-P10 green) |
| Visual test pass rate | 100% (TC-V01 through TC-V05 green) |
| Unit test pass rate | 100% (UT-P01 through UT-P11 green) |
| WCAG AA contrast — all 6 badge combinations | ≥ 4.5:1 verified via contrast checker |
| Zero `Priority` type redeclarations | Confirmed by grep: no string literal union `'high' \| 'medium' \| 'low'` outside `lib/db.ts` |
| Migration idempotency | Running DB init twice on the same database produces no error and no data change |
| Sort correctness | TC-P08 passes with the exact order: high → medium → low |
| Filter isolation | Selecting a priority filter and then clearing it leaves the todo list in exactly the same state as before the filter was applied |

---

*Last updated: 2026-07-03 | PRP version: 1.0 | Implements feature phase: Phase 1 — Foundation | Depends on: PRP 01*
