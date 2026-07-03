# PRP 10 — Calendar View

## 1. Feature Overview

The Calendar View provides a monthly grid where users can see all their todos positioned on the days they are due. Singapore public holidays are displayed as background markers on their respective dates. Users can navigate between months, click a date cell to see a detail list of todos due that day, and click a todo directly from the calendar to open its edit modal. The calendar coexists with the existing list view; a tab or toggle in the main navigation switches between the two.

---

## 2. User Stories

### Persona A — Visual Planner
> *"I think in weeks and months, not lists. I want to see my tasks laid out on a calendar so I can spot overloaded days at a glance."*

- As a logged-in user, I can switch to a calendar view so that I can see which days have todos due.
- As a logged-in user, I can see a compact indicator (dot or count badge) on each day that has at least one todo due, so I can identify busy days without reading every title.

### Persona B — Singapore-Based User
> *"I work around public holidays. I want to see them on the calendar so I don't accidentally schedule work on a holiday."*

- As a logged-in user, I can see Singapore public holidays highlighted on the calendar grid so that I am aware of non-working days when planning.

### Persona C — Month-Level Navigator
> *"I want to jump forward or back a few months to plan ahead or review past tasks."*

- As a logged-in user, I can navigate to the previous and next month using arrow buttons so that I can plan across multiple months.
- As a logged-in user, clicking on a date cell shows a list of all todos due on that day so that I can review or act on them.

---

## 3. User Flow

### 3.1 Switching to Calendar View

1. User is on the main todo list page (`/`).
2. User clicks the **"Calendar"** tab or navigates directly to `/calendar`.
3. The calendar page loads showing the current month in SGT.
4. A `GET /api/calendar?year=YYYY&month=MM` request is made.
5. The server returns todos with `due_date` in the requested month, and holidays for that month.
6. The grid renders with todos on their due dates and holidays highlighted.

### 3.2 Navigating Months

1. User clicks the **"←"** (previous) or **"→"** (next) button flanking the month/year heading.
2. The displayed month changes and a new `GET /api/calendar?year=YYYY&month=MM` request fires.
3. The grid updates to show todos and holidays for the new month.

### 3.3 Viewing Todos on a Day

1. User clicks on a date cell that has one or more todo indicators.
2. A side panel or popover opens listing all todos due on that day: title, priority badge, completion status.
3. User can click any todo in the list to open the standard edit modal.
4. Completing or editing a todo from the detail panel refreshes the calendar indicators for that day.

### 3.4 Viewing a Holiday

1. Dates with a Singapore public holiday show the holiday name as a small label below the date number.
2. Hovering or tapping the label shows a tooltip with the full holiday name if the label is truncated.

---

## 4. Out of Scope

- Creating or editing todos directly within the calendar (editing happens via the existing edit modal).
- Week or day view granularity (month-only in this phase).
- Drag-and-drop to reschedule todos by moving them between calendar cells.
- Multi-user or shared calendars.
- Adding, editing, or deleting holidays from the UI.
- Recurring todo expansion (only existing `due_date` instances are shown, not projected future occurrences).

---

## 5. UI Components

### CalendarPage (`app/calendar/page.tsx`)
- Top-level `'use client'` component mounted at the `/calendar` route.
- Manages `currentYear` and `currentMonth` state (initialised to SGT now).
- Fetches `GET /api/calendar?year=YYYY&month=MM` on mount and on month navigation.
- Renders `CalendarHeader`, `CalendarGrid`, and optionally a `DayDetailPanel`.

### CalendarHeader
- Displays the current month and year (e.g., "July 2026") centred between two navigation arrow buttons.
- **"← Prev"** and **"Next →"** buttons change the month, wrapping year correctly (Dec → Jan of next year).
- A **"Today"** button resets the view to the current SGT month.

### CalendarGrid
- 7-column grid (Mon–Sun header row, then date cells for the month).
- Leading/trailing cells from adjacent months are shown in muted style and are non-interactive.
- Each date cell contains:
  - The date number (top-left).
  - Holiday label if applicable (below date number, accent colour).
  - Up to 3 todo title chips (truncated); an overflow badge ("+N more") if more than 3 todos are due.
  - Priority colour dot on each todo chip.
- "Today" cell has a highlighted border or background.
- Overdue todos (due date in a past date, incomplete) are displayed with a red tint on their chip.

### DayDetailPanel
- Slides in from the right (or appears as an overlay on small screens) when a date cell is clicked.
- Header: "Todos for [Day, DD Month YYYY]".
- List of todos due that day: each row shows title, priority badge, subtask progress bar (if subtasks exist), completion checkbox.
- Clicking a todo row opens the existing `EditTodoModal` from the main page.
- Clicking outside the panel or pressing Escape closes it.

### HolidayTooltip
- Wraps the holiday label in each cell.
- On hover/focus, shows the full holiday name in a tooltip (for names truncated by cell width).

---

## 6. Technical Requirements

### Database

**New table: `holidays`** (seeded by a script; not user-editable via the UI)
```sql
CREATE TABLE IF NOT EXISTS holidays (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL UNIQUE,  -- YYYY-MM-DD in SGT
  name       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
```

The `holidays` table is pre-populated with Singapore public holidays via `scripts/seed-holidays.ts`. The API reads from this table; no write endpoints are exposed.

### API Route

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/calendar` | Fetch todos and holidays for a given year/month |

#### GET `/api/calendar?year=YYYY&month=MM`

1. Authenticate; return 401 if no session.
2. Validate query params:
   - `year`: integer 2000–2100.
   - `month`: integer 1–12.
   - Return 400 if either is missing or out of range.
3. Compute the SGT date range for the requested month:
   - `startUtc` = midnight SGT on the 1st of the month converted to UTC.
   - `endUtc` = midnight SGT on the 1st of the following month converted to UTC (exclusive upper bound).
4. Query todos: `SELECT * FROM todos WHERE user_id = ? AND due_date >= ? AND due_date < ?`.
5. Query holidays: `SELECT * FROM holidays WHERE date LIKE 'YYYY-MM-%'` (filtered by year-month prefix).
6. Return:
```json
{
  "todos": [ /* Todo objects */ ],
  "holidays": [
    { "date": "2026-07-09", "name": "Hari Raya Haji" }
  ]
}
```

### `lib/db.ts` additions
- `Holiday` interface: `{ id: number; date: string; name: string }`.
- `holidayDB.listByMonth(year: number, month: number): Holiday[]` — queries by date prefix.

### `lib/timezone.ts` additions
- `getMonthBoundsUtc(year: number, month: number): { startUtc: string; endUtc: string }` — returns the UTC ISO strings for the SGT-midnight boundaries of the requested month.
- `formatCalendarDate(isoUtc: string): string` — returns `"YYYY-MM-DD"` in SGT for grouping todos by day in the client.

### Routing

`/calendar` is an additional route in the Next.js App Router:
- `app/calendar/page.tsx` — the calendar client component.
- Middleware (`proxy.ts`) must protect this route (add `/calendar` to the protected paths matcher).

### Client-Side Data Grouping

The `CalendarPage` component groups the fetched todos by their SGT due date:
```typescript
const todosByDate = todos.reduce((map, todo) => {
  const day = formatCalendarDate(todo.due_date!)
  return { ...map, [day]: [...(map[day] ?? []), todo] }
}, {} as Record<string, Todo[]>)
```

### Holiday Seeding Script

`scripts/seed-holidays.ts`:
- Inserts Singapore public holidays for the current year and next year using `INSERT OR IGNORE`.
- Run once during setup: `npx tsx scripts/seed-holidays.ts`.
- Holiday dates are hardcoded constants (no external API dependency).

---

## 7. Acceptance Criteria

| ID | Criterion |
|----|-----------|
| TC-C01 | Navigating to `/calendar` renders a monthly grid for the current SGT month. |
| TC-C02 | Todos with a `due_date` in the displayed month appear on their correct date cell. |
| TC-C03 | Todos with `due_date` in a different month do not appear in the current month's grid. |
| TC-C04 | Singapore public holidays for the displayed month are shown on their respective date cells. |
| TC-C05 | Clicking the "← Prev" button changes the grid to the previous month; clicking "Next →" advances to the next month. |
| TC-C06 | Navigating from December to the previous month changes the year correctly (e.g., December 2026 → November 2026). |
| TC-C07 | Clicking a date cell with todos opens the DayDetailPanel listing all todos due on that day. |
| TC-C08 | Completing a todo from the DayDetailPanel updates the todo's chip appearance in the calendar grid. |
| TC-C09 | The "Today" button returns the view to the current SGT month regardless of how far the user has navigated. |
| TC-C10 | `/calendar` returns 401 for unauthenticated requests (middleware protection). |
| TC-C11 | `GET /api/calendar` with an invalid month value (e.g., `month=13`) returns a 400 error. |
| TC-C12 | Date cells from the previous/next month spillover are rendered in a muted style and are non-interactive. |
