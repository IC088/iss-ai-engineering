# 08 — Search & Filtering

> **How to use this file:** Copy the entire contents of this PRP into GitHub Copilot Chat (or any AI coding assistant, including Claude Sonnet) along with the instruction below, and let it implement the feature end-to-end against this codebase.

## 🤖 Prompt for AI Coding Assistant (Claude Sonnet in GitHub Copilot)

```
You are implementing a feature for an existing Next.js 16 (App Router) Todo App.

Before writing any code:
1. Read .github/copilot-instructions.md for project-wide conventions (folder structure,
   naming, error handling, API response shapes, coding style).
2. Read USER_GUIDE.md for how this feature should behave from a user's perspective.
3. Confirm Todo CRUD (01-todo-crud-operations.md), Priority System (02-priority-system.md),
   and Tag System (06-tag-system.md) are already implemented — Search & Filtering is
   explicitly listed as depending on Tags (06), and it also composes with Priority
   filtering and due dates.
4. Read how the existing todo list is currently fetched and rendered in app/page.tsx (or
   equivalent) — this feature extends that list with search/filter state, it does not
   replace the underlying data-fetching pattern.
5. Read lib/timezone.ts if any due-date-range filtering is involved, to reuse existing
   Singapore timezone date utilities rather than raw Date math.

Your task is to implement the "Search & Filtering" feature described in full below. Follow
the Technical Requirements exactly (schema, endpoints, types). Match existing patterns for:
- Next.js 16 API routes with async params (`{ params }: { params: Promise<{ id: string }> }`)
- better-sqlite3 synchronous database calls (no async/await around DB calls themselves)
- Client components in app/page.tsx for UI, API routes under app/api/ for data access
- Tailwind CSS 4 for styling
- Playwright for E2E tests, and the project's existing unit test runner for logic tests

Implement the feature in this order:
1. Decide and implement the search/filter execution strategy (client-side filtering of
   an already-loaded todo list vs. server-side query params) — see Technical Requirements
   §4.1 for the recommended approach and rationale; confirm the existing todo list size
   assumptions in USER_GUIDE.md before committing to one approach.
2. Shared TypeScript types for search/filter state
3. Search/filter logic (pure, unit-testable functions) — text match + multi-criteria
4. If server-side: API route query param handling; if client-side: in-memory filter utils
5. UI components (search bar, filter panel, active-filter chips, empty state)
6. Wire into the existing todo list rendering, combined with existing Priority (02) and
   Tag (06) filter UI rather than duplicating it
7. Debouncing / performance handling for real-time search
8. Edge case handling (see below)
9. Tests (unit + E2E) based on the Testing Requirements section
10. Validate every item in the Acceptance Criteria section before declaring the feature done

Ask me before making destructive schema changes or before changing any existing API
contract used by other already-implemented features (Todo CRUD, Priority, Tags).

Here is the full PRP:
```

---

## 1. Feature Overview

Search & Filtering unifies and extends the app's existing organizational tools (Priority
badges from 02, Tags from 06, due dates from 01) into a single, fast, real-time search
and multi-criteria filter experience over the todo list. It adds:

- **Real-time text search** across todo titles (and, in Advanced Search, descriptions)
  as the user types, with no explicit "search" button required.
- **Advanced search** that scopes matching to specific fields — title only, or title +
  tags (matching todos whose tag names contain the query, in addition to title matches).
- **Multi-criteria filtering**: combine text search with priority, tag(s), completion
  status, and due-date range simultaneously, all narrowing the same result set with AND
  logic across criteria types (and OR logic within a multi-select criterion like tags,
  consistent with how tag filtering already works per 06-tag-system.md).
- **Client-side performance**: since this is a single-user, local-first todo app, the
  default implementation should filter an already-loaded in-memory todo list rather than
  round-tripping to the server on every keystroke, keeping search feel instantaneous.

This feature does not introduce new data — it is purely a query/presentation layer over
todos, tags, and priorities that already exist from earlier PRPs.

---

## 2. User Stories

- **As a user with a long todo list**, I want to type a few letters of a title and see
  matching todos instantly, without pressing Enter or waiting for a spinner.
- **As a user who half-remembers a todo**, I want to search by a tag name as well as the
  title, so I can find it even if I don't remember the exact wording.
- **As a user planning my day**, I want to combine "High priority" + "due this week" +
  a specific tag into one filtered view, so I see exactly the subset of todos I care
  about right now.
- **As a user who's applied several filters**, I want to see which filters are active
  (as removable chips) and clear them all with one click, so I don't lose track of why
  my list looks the way it does.
- **As a user with zero matching results**, I want a clear "no todos match your search/
  filters" state (not a blank, ambiguous screen) so I know to adjust my criteria.
- **As a user typing quickly**, I want the search to feel smooth and not lag or flicker
  on every keystroke, even with a large todo list.

---

## 3. User Flow

### 3.1 Real-time text search
1. User types into a persistent search input (always visible above the todo list, not
   hidden behind a toggle).
2. As the user types, the todo list narrows to titles containing the query
   (case-insensitive, substring match), updating within ~150–300ms of the last keystroke
   (debounced, not on every raw keystroke, to avoid excessive re-renders).
3. Clearing the input (or clicking an "×" inside it) restores the full list immediately.

### 3.2 Advanced search (title + tags)
1. User opens an "Advanced" toggle/expander next to the search input.
2. User sees scope checkboxes/radio: "Title only" (default) vs. "Title + Tags".
3. With "Title + Tags" selected, the same query string additionally matches any todo
   that has a tag whose name contains the query — result set is the **union** of
   title-matches and tag-name-matches (not intersection).
4. The active scope is remembered for the session (not necessarily persisted across
   reloads unless USER_GUIDE.md specifies otherwise).

### 3.3 Multi-criteria filtering
1. User opens the filter panel (extends the existing Priority filter UI from 02 and Tag
   filter UI from 06 into one combined panel, rather than three separate ones).
2. Available filter criteria:
   - **Priority**: multi-select (High/Medium/Low) — OR within this criterion
   - **Tags**: multi-select (reuses `TagFilterBar` from 06-tag-system.md) — OR within
     this criterion
   - **Completion status**: All / Active / Completed
   - **Due date range**: presets (Overdue, Due Today, Due This Week, No Due Date) plus
     a custom date range picker
3. Selecting values in multiple criteria types combines them with AND logic (e.g.
   Priority=High AND Tag∈{work,urgent} AND Status=Active).
4. Each active filter renders as a removable chip in a summary row above the list (e.g.
   "Priority: High ×", "Tags: work, urgent ×", "Due: This Week ×").
5. A "Clear all filters" action resets every criterion (including the search text) back
   to defaults in one click.

### 3.4 Combined search + filter
1. Text search and multi-criteria filters compose together: the visible list is the
   result of applying the search query (per current scope) AND all active filters.
2. The result count is shown (e.g. "12 of 47 todos") so the user has a clear sense of how
   much the current view has narrowed the full list.

### 3.5 Empty state
1. If no todos match the combined search/filter criteria, show a dedicated empty state
   with the applied criteria summarized and a "Clear all filters" call to action —
   distinct from the "you have no todos at all" empty state from 01-todo-crud-operations.md.

---

## 4. Technical Requirements

### 4.1 Execution Strategy: Client-Side Filtering (Recommended Default)

Given this is a local-first, single-user app backed by SQLite (per the Technical Stack
Reference: better-sqlite3, no auth-scoped multi-tenant data at scale), the recommended
approach is:

- Fetch the **full todo list once** (already-existing endpoint from 01, extended to
  include tags per 06's join pattern) into client state.
- Perform all search/filter narrowing **client-side**, in memory, using pure JS/TS
  functions — no network round-trip per keystroke.
- Re-fetch from the server only on actual data mutations (create/update/delete/complete),
  same as the existing optimistic-update pattern from 01-todo-crud-operations.md.

This keeps search feel instantaneous and avoids adding server load or query complexity
for what is fundamentally a small, single-user dataset. If USER_GUIDE.md or
copilot-instructions.md indicates the dataset is expected to be large (e.g. thousands of
todos) or that the app is moving toward multi-user/server-scale data, escalate to a
server-side, paginated, indexed search instead (see §4.5 "Escalation Path") — but do not
default to server-side search without that signal, since it adds latency for the common
case.

### 4.2 TypeScript Types

```typescript
// types/search-filter.ts
export type SearchScope = 'title' | 'title-and-tags';

export type CompletionStatus = 'all' | 'active' | 'completed';

export type DueDateFilterPreset =
  | 'all'
  | 'overdue'
  | 'due-today'
  | 'due-this-week'
  | 'no-due-date'
  | 'custom';

export interface DueDateFilter {
  preset: DueDateFilterPreset;
  customStart?: string;   // ISO date, only used when preset = 'custom'
  customEnd?: string;     // ISO date, only used when preset = 'custom'
}

export interface FilterState {
  searchQuery: string;
  searchScope: SearchScope;
  priorities: Array<'High' | 'Medium' | 'Low'>;   // empty array = no priority filter applied
  tagIds: number[];                               // empty array = no tag filter applied
  completionStatus: CompletionStatus;
  dueDate: DueDateFilter;
}

export const DEFAULT_FILTER_STATE: FilterState = {
  searchQuery: '',
  searchScope: 'title',
  priorities: [],
  tagIds: [],
  completionStatus: 'all',
  dueDate: { preset: 'all' },
};
```

### 4.3 Core Filtering Logic (pure, unit-testable)

```typescript
// lib/filter-todos.ts
import type { TodoWithTags } from '@/types/tag';      // from 06-tag-system.md
import type { FilterState } from '@/types/search-filter';
import { nowInSingapore, isSameDayInSingapore, isWithinWeekInSingapore } from '@/lib/timezone';

export function filterTodos(todos: TodoWithTags[], filters: FilterState): TodoWithTags[] {
  return todos.filter(todo =>
    matchesSearch(todo, filters.searchQuery, filters.searchScope) &&
    matchesPriority(todo, filters.priorities) &&
    matchesTags(todo, filters.tagIds) &&
    matchesCompletion(todo, filters.completionStatus) &&
    matchesDueDate(todo, filters.dueDate)
  );
}

function matchesSearch(todo: TodoWithTags, query: string, scope: SearchScope): boolean {
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  const titleMatch = todo.title.toLowerCase().includes(q);
  if (scope === 'title') return titleMatch;
  const tagMatch = todo.tags.some(tag => tag.name.toLowerCase().includes(q));
  return titleMatch || tagMatch;
}

function matchesPriority(todo: TodoWithTags, priorities: FilterState['priorities']): boolean {
  return priorities.length === 0 || priorities.includes(todo.priority);
}

function matchesTags(todo: TodoWithTags, tagIds: number[]): boolean {
  if (tagIds.length === 0) return true;
  const todoTagIds = new Set(todo.tags.map(t => t.id));
  return tagIds.some(id => todoTagIds.has(id));   // OR logic, consistent with 06-tag-system.md
}

function matchesCompletion(todo: TodoWithTags, status: CompletionStatus): boolean {
  if (status === 'all') return true;
  return status === 'completed' ? todo.completed : !todo.completed;
}

function matchesDueDate(todo: TodoWithTags, filter: DueDateFilter): boolean {
  if (filter.preset === 'all') return true;
  if (filter.preset === 'no-due-date') return todo.dueDate === null;
  if (!todo.dueDate) return false;
  const now = nowInSingapore();
  switch (filter.preset) {
    case 'overdue': return new Date(todo.dueDate) < now && !todo.completed;
    case 'due-today': return isSameDayInSingapore(todo.dueDate, now);
    case 'due-this-week': return isWithinWeekInSingapore(todo.dueDate, now);
    case 'custom':
      return (!filter.customStart || todo.dueDate >= filter.customStart) &&
             (!filter.customEnd || todo.dueDate <= filter.customEnd);
    default: return true;
  }
}
```

All comparison/date helper functions (`nowInSingapore`, `isSameDayInSingapore`,
`isWithinWeekInSingapore`) should be added to or reused from the existing
`lib/timezone.ts`, not reimplemented locally, per project convention.

### 4.4 Debouncing

```typescript
// hooks/useDebouncedValue.ts
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
```

The raw search input should update local state immediately (so typing feels responsive),
but the value passed into `filterTodos` should be the **debounced** value (~200ms) to
avoid re-filtering the full list on every single keystroke when the list is large.

### 4.5 Escalation Path (server-side search, only if needed)

If client-side filtering proves insufficient (confirmed via USER_GUIDE.md scale
expectations or actual performance testing, not assumed upfront):

| Method | Route                                                            | Description |
|--------|-------------------------------------------------------------------|--------------|
| GET    | `/api/todos?q=<text>&scope=title\|title-and-tags&priority=High,Low&tags=1,4&status=active&dueFrom=&dueTo=` | Server-side filtered todo list, same query semantics as the client-side function above, translated to SQL `WHERE`/`JOIN` clauses. Must remain paginated if adopted, to justify the added complexity. |

Do not implement this endpoint speculatively — only build it if the client-side approach
is explicitly rejected, since maintaining two parallel filter implementations (client
logic + SQL) is a real maintenance cost this PRP recommends avoiding by default.

---

## 5. UI Components

### 5.1 `SearchBar`
Persistent, always-visible text input above the todo list, with a clear ("×") button
when non-empty and an "Advanced" toggle/expander revealing the scope selector.

```tsx
interface SearchBarProps {
  query: string;
  scope: SearchScope;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: SearchScope) => void;
  resultCount: number;
  totalCount: number;
}
```

### 5.2 `FilterPanel`
Combined panel/drawer housing Priority multi-select, the existing `TagFilterBar` (from
06-tag-system.md), Completion status toggle, and Due Date preset/custom picker. Reuses
existing Priority filter UI from 02-priority-system.md rather than re-implementing it —
this PRP's job is to compose and coordinate state, not duplicate controls.

```tsx
interface FilterPanelProps {
  filters: FilterState;
  allTags: Tag[];
  onChange: (filters: FilterState) => void;
}
```

### 5.3 `ActiveFilterChips`
Row of removable chips summarizing every non-default active criterion (search query,
priorities, tags, status, due date range), plus a single "Clear all" action.

```tsx
interface ActiveFilterChipsProps {
  filters: FilterState;
  allTags: Tag[];   // needed to render tag names, not just IDs, on chips
  onRemove: (criterion: keyof FilterState, value?: unknown) => void;
  onClearAll: () => void;
}
```

### 5.4 `SearchEmptyState`
Distinct empty state shown when `filterTodos` returns zero results but the underlying
todo list is non-empty — summarizes active criteria and offers "Clear all filters".

```tsx
interface SearchEmptyStateProps {
  filters: FilterState;
  allTags: Tag[];
  onClearAll: () => void;
}
```

---

## 6. Edge Cases

- **Empty search query with active filters:** filtering still applies (search is just
  one of several independent criteria — an empty query should not exclude everything or
  bypass other active filters).
- **Search query matches nothing but filters would otherwise show results:** correctly
  show the "no matches" empty state (AND logic across criteria means any single
  non-matching criterion zeroes out the result set).
- **Whitespace-only search query:** treated identically to an empty query (trimmed
  before matching), not as a literal space-matching search.
- **Very large todo lists (perf):** debounce search input (§4.4); ensure `filterTodos`
  is not re-run more often than necessary (e.g. memoize on `[todos, filters]` if using
  React, avoiding re-filtering on unrelated re-renders).
- **Tag deleted while a tag filter referencing it is active:** the filter should
  silently drop the now-invalid tag ID from `filters.tagIds` on the next tag list
  refresh, consistent with the same edge case already defined in 06-tag-system.md.
- **Due date range filter with `customStart` after `customEnd`:** validate in the UI
  (disable/auto-correct) before it reaches `matchesDueDate`, since the filter function
  itself will simply return no matches for an inverted range without erroring.
- **"Overdue" preset and completed todos:** overdue should only apply to incomplete
  todos — a completed todo with a past due date is not "overdue" in the user-facing
  sense; already reflected in `matchesDueDate`'s `!todo.completed` check, but call this
  out explicitly in tests since it's a common off-by-logic bug.
- **Case sensitivity:** all text matching (title, tag names) is case-insensitive by
  default — verify this matches the case-insensitivity already established for tag name
  uniqueness in 06-tag-system.md, for consistency.
- **Special characters / regex-like input in search query:** treat the query as a plain
  substring, not a regex — do not pass raw user input into `RegExp` construction
  (avoids both incorrect matches and potential ReDoS-style pathological input).
- **Switching search scope from "Title only" to "Title + Tags" mid-query:** should
  re-evaluate immediately against the current (debounced) query, not require the user to
  retype.
- **Filter state persistence across navigation/reload:** unless USER_GUIDE.md specifies
  otherwise, filter state (including search query) resets on full page reload but should
  survive client-side navigation within the app during the same session (kept in the
  parent list component's state, not local to an unmounted child).
- **Combining "No Due Date" preset with a tag/priority filter:** should correctly narrow
  to todos with `dueDate === null` AND matching the other active criteria — verify this
  combination explicitly in tests, since "no due date" is a null-check rather than a
  range comparison and is easy to implement incorrectly alongside the other presets.

---

## 7. Acceptance Criteria

- [ ] Typing in the search bar narrows the todo list in real time (debounced, not
      instant-per-keystroke) by title, with no explicit submit action required.
- [ ] Advanced search scope toggle correctly switches between "title only" and
      "title + tags" matching, with tag matches being a union (not intersection) with
      title matches.
- [ ] Priority, tag, completion status, and due-date-range filters can each be applied
      independently and combine with AND logic across criteria types.
- [ ] Tag and priority filters use OR logic within their own multi-select (matches
      existing behavior from 02 and 06).
- [ ] Active filters render as removable chips with a working "Clear all" action.
- [ ] A result count (e.g. "12 of 47 todos") is visible whenever any search/filter
      criterion is active.
- [ ] A distinct, actionable empty state appears when search/filter criteria match zero
      todos, separate from the "no todos exist at all" empty state from 01.
- [ ] Search and filtering perform smoothly (no visible jank) against a representative
      todo list, verified during implementation with a reasonably large seeded dataset.
- [ ] All filtering logic is implemented as pure, testable functions independent of any
      React component (`lib/filter-todos.ts` or equivalent).
- [ ] Existing Priority (02) and Tag (06) filter UI is reused/composed into the combined
      `FilterPanel`, not duplicated.

---

## 8. Testing Requirements

### 8.1 Unit Tests
- `matchesSearch`: case-insensitive substring match on title; scope `'title'` excludes
  tag-name matches; scope `'title-and-tags'` includes them (union, not intersection);
  empty/whitespace query matches everything.
- `matchesPriority` / `matchesTags`: empty selection arrays mean "no filter applied"
  (match everything); non-empty arrays apply correct OR logic.
- `matchesCompletion`: correctly separates active vs. completed vs. all.
- `matchesDueDate`: each preset (`overdue`, `due-today`, `due-this-week`, `no-due-date`,
  `custom`) tested against fixed reference dates and fixture todos, including the
  "overdue excludes completed todos" rule and the "no due date" null-check case.
- `filterTodos`: combined multi-criteria scenarios (e.g. priority + tag + status all
  active at once) produce the correct intersection of independently-passing todos.
- `useDebouncedValue`: value updates only after the delay elapses, and resets the timer
  on rapid successive changes (fake timers).

### 8.2 E2E Tests (Playwright)
- Type a partial title into the search bar; verify the list narrows in real time to only
  matching todos.
- Clear the search input; verify the full list is restored.
- Toggle Advanced Search to "Title + Tags", search a tag name that doesn't appear in any
  title; verify matching todos still appear.
- Apply a Priority filter and a Tag filter simultaneously; verify only todos matching
  both appear, and that the result count reflects the narrowed set.
- Apply a "Due This Week" filter; verify only todos due within the current week (SGT)
  appear, and overdue/completed todos are correctly excluded/included per the rules.
- Remove one active filter via its chip; verify the list updates to reflect only the
  remaining active filters (not a full reset).
- Click "Clear all filters"; verify search text, priority, tags, status, and due date
  all reset to defaults and the full list is restored.
- Trigger a zero-result combination of filters; verify the dedicated search/filter empty
  state appears with a working "Clear all filters" action.
- Delete a tag (via Tag Manager from 06) that is currently used as an active filter;
  verify the filter gracefully drops that tag without breaking the list.

---

## 9. Out of Scope

- Fuzzy/typo-tolerant search (e.g. Levenshtein-distance matching) — exact substring
  matching only for this iteration.
- Full-text search indexing (e.g. SQLite FTS5) — not needed at the client-side-filtering
  scale this PRP targets; revisit only if the Escalation Path (§4.5) is triggered.
- Saved searches / saved filter presets that persist across sessions.
- Search within subtask labels or template names (scoped to todo title + tags only).
- Server-side pagination of search results (only relevant if/when the Escalation Path is
  adopted).
- Natural-language date parsing in the search box (e.g. typing "due next Monday" as free
  text) — due date filtering is handled exclusively via the structured Due Date filter
  control, not the text search box.

---

## 10. Success Metrics

- Search results update within ~200–300ms of the user pausing typing, with no visible
  jank, against a representative seeded todo list.
- Zero discrepancies between client-side filter results and manually verified expected
  results across the unit test matrix (priority × tags × status × due date combinations).
- Users can go from "full todo list" to a precisely narrowed view (search + 2+ filter
  criteria) in under 10 seconds of interaction.
- No duplicate/parallel implementation of Priority or Tag filtering logic — verified by
  code review that `FilterPanel` composes the existing components from 02 and 06 rather
  than reimplementing them.
