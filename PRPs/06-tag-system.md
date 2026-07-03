# 06 — Tag System

> **How to use this file:** Copy the entire contents of this PRP into GitHub Copilot Chat (or any AI coding assistant, including Claude Sonnet) along with the instruction below, and let it implement the feature end-to-end against this codebase.

## 🤖 Prompt for AI Coding Assistant (Claude Sonnet in GitHub Copilot)

```
You are implementing a feature for an existing Next.js 16 (App Router) Todo App.

Before writing any code:
1. Read .github/copilot-instructions.md for project-wide conventions (folder structure,
   naming, error handling, API response shapes, coding style).
2. Read USER_GUIDE.md for how this feature should behave from a user's perspective.
3. Read lib/timezone.ts and confirm whether this feature needs any date/time handling
   in Asia/Singapore timezone (tags themselves are timezone-agnostic, but audit fields
   such as created_at/updated_at must use the project's existing timezone utilities).
4. Confirm Todo CRUD (01-todo-crud-operations.md) is already implemented, since the
   Tag System depends on it (todos table must already exist).

Your task is to implement the "Tag System" feature described in full below. Follow the
Technical Requirements exactly (schema, endpoints, types). Match existing patterns for:
- Next.js 16 API routes with async params (`{ params }: { params: Promise<{ id: string }> }`)
- better-sqlite3 synchronous database calls (no async/await around DB calls themselves)
- Client components in app/page.tsx for UI, API routes under app/api/ for data access
- Tailwind CSS 4 for styling
- Playwright for E2E tests, and the project's existing unit test runner for logic tests

Implement the feature in this order:
1. Database migration/schema changes (tags table + todo_tags junction table)
2. Shared TypeScript types
3. API routes (tags CRUD + todo-tag association endpoints)
4. UI components (tag badge, tag picker, tag manager, tag filter)
5. Wire tag filtering into the existing todo list/search
6. Edge case handling (see below)
7. Tests (unit + E2E) based on the Testing Requirements section
8. Validate every item in the Acceptance Criteria section before declaring the feature done

Ask me before making destructive schema changes (e.g. dropping columns) or before
changing any existing API contract used by other already-implemented features
(Todo CRUD, Priority System, Search & Filtering).

Here is the full PRP:
```

---

## 1. Feature Overview

The Tag System lets users create color-coded, reusable labels ("tags") and attach any
number of them to any todo, and any tag to any number of todos (many-to-many). Tags give
users a flexible, user-defined way to organize todos that cuts across the app's other
organizational dimensions (priority, due date, recurrence) — e.g. `#work`, `#urgent-client`,
`#groceries`, `#waiting-on-someone`.

This feature is a **dependency for Search & Filtering (08)**: once tags exist, the
Search & Filtering feature will let users filter and search by tag in combination with
text search and other criteria.

Core capabilities:
- Create, rename, recolor, and delete tags (Tag Management / CRUD)
- Attach/detach one or more tags to/from a todo
- Display tags as color-coded badges on todo cards
- Filter the todo list by one or more tags
- Prevent duplicate tag names and orphaned todo-tag associations

---

## 2. User Stories

- **As a user organizing many todos**, I want to create custom tags (e.g. `#billing`,
  `#personal`) so that I can group related todos beyond the built-in priority levels.
- **As a user scanning my todo list**, I want to see color-coded tag badges on each
  todo card so I can visually identify categories at a glance.
- **As a user with many tags**, I want to manage my tags in one place (rename, recolor,
  delete) so my tag list stays clean and doesn't accumulate unused or duplicate tags.
- **As a user focused on one area of work**, I want to filter my todo list by tag (or
  combination of tags) so I only see relevant todos.
- **As a user creating a new todo**, I want to attach existing tags or create a new tag
  inline, without leaving the todo creation flow.
- **As a user who deletes a tag**, I want that tag to be removed from all todos it was
  attached to, without deleting the todos themselves.

---

## 3. User Flow

### 3.1 Creating a tag (inline, while editing a todo)
1. User opens the todo creation/edit form.
2. User clicks the "Add tag" control, which shows a searchable dropdown of existing tags.
3. User types a name that doesn't match an existing tag → an "Create tag '<name>'" option
   appears.
4. User selects it → a color picker (preset palette, 8–10 swatches) appears.
5. User picks a color → tag is created via `POST /api/tags` and immediately attached to
   the todo being edited (optimistically, then confirmed).

### 3.2 Attaching an existing tag to a todo
1. User opens the tag dropdown on a todo (in the create/edit form).
2. User searches/scrolls the list of existing tags.
3. User clicks a tag → it's added to the todo's selected-tags list (visually, as a chip)
   and persisted via `POST /api/todos/[id]/tags` on save (or immediately if editing an
   existing todo — optimistic UI update, matching pattern from 01-todo-crud-operations.md).

### 3.3 Removing a tag from a todo
1. User clicks the "×" on a tag chip inside the todo edit form, or on the tag badge
   directly on the todo card (if the UI supports quick-remove).
2. Tag is detached via `DELETE /api/todos/[id]/tags/[tagId]`, with optimistic UI removal.

### 3.4 Managing tags (Tag Manager view)
1. User opens "Manage Tags" (e.g. from a settings menu or a dedicated `/tags` panel/modal).
2. User sees a list of all tags: name, color swatch, and count of todos using each tag.
3. User can:
   - Rename a tag (inline edit) → `PUT /api/tags/[id]`
   - Recolor a tag (color picker) → `PUT /api/tags/[id]`
   - Delete a tag → confirmation dialog ("This will remove '<tag>' from N todos. Todos
     themselves will not be deleted.") → `DELETE /api/tags/[id]`

### 3.5 Filtering by tag
1. User opens the filter panel/bar (shared with Priority filtering).
2. User sees all tags as clickable chips.
3. User clicks one or more tags → todo list updates to show only todos that have **at
   least one** of the selected tags (OR logic within tag filter; combined with AND logic
   against other active filters, e.g. Priority = High AND (tag = work OR tag = urgent)).
4. Selected tag chips are visually highlighted; a "Clear tag filters" control appears
   when at least one tag filter is active.

---

## 4. Technical Requirements

### 4.1 Database Schema

```sql
-- New table: tags
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL,              -- hex code, e.g. '#3B82F6'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (name COLLATE NOCASE)      -- case-insensitive uniqueness
);

-- New junction table: todo_tags (many-to-many)
CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (todo_id, tag_id),
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_todo_tags_todo_id ON todo_tags(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_tags_tag_id ON todo_tags(tag_id);
```

Notes:
- `ON DELETE CASCADE` on both foreign keys means deleting a todo automatically removes
  its tag associations, and deleting a tag automatically removes it from all todos —
  no manual cleanup code needed, but foreign keys must be enabled on the better-sqlite3
  connection (`PRAGMA foreign_keys = ON;`), matching the pattern used for Subtasks (05).
- Tag name uniqueness is case-insensitive (`work` and `Work` are the same tag) to avoid
  accidental duplicates.
- Preset color palette (suggested, adjust to match existing design tokens):
  `#EF4444 (red), #F97316 (orange), #F59E0B (amber), #84CC16 (lime), #10B981 (emerald),
  #06B6D4 (cyan), #3B82F6 (blue), #8B5CF6 (violet), #EC4899 (pink), #6B7280 (gray)`

### 4.2 TypeScript Types

```typescript
// types/tag.ts
export interface Tag {
  id: number;
  name: string;
  color: string;        // hex code
  createdAt: string;
  updatedAt: string;
  todoCount?: number;    // populated only in tag-manager list queries
}

export interface CreateTagInput {
  name: string;
  color: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
}

// Extend the existing Todo type (from 01-todo-crud-operations.md)
export interface TodoWithTags extends Todo {
  tags: Tag[];
}
```

### 4.3 API Endpoints

| Method | Route                          | Description                                                             |
|--------|---------------------------------|---------------------------------------------------------------------------|
| GET    | `/api/tags`                     | List all tags, each with `todoCount` (for the Tag Manager view)          |
| POST   | `/api/tags`                     | Create a new tag. Body: `{ name, color }`. 409 on duplicate name.        |
| PUT    | `/api/tags/[id]`                | Rename and/or recolor a tag. Body: `{ name?, color? }`.                   |
| DELETE | `/api/tags/[id]`                | Delete a tag (cascades to `todo_tags`).                                  |
| GET    | `/api/todos/[id]/tags`          | List tags attached to a specific todo.                                   |
| POST   | `/api/todos/[id]/tags`          | Attach one or more tags to a todo. Body: `{ tagIds: number[] }`.          |
| DELETE | `/api/todos/[id]/tags/[tagId]`  | Detach a single tag from a todo.                                         |
| GET    | `/api/todos?tags=1,4,7`         | Extend existing todo list endpoint to accept a `tags` query param (OR filter, comma-separated tag IDs). |

Response shape conventions (match existing API patterns from Todo CRUD):

```typescript
// Success
{ success: true, data: Tag | Tag[] | TodoWithTags | TodoWithTags[] }

// Error
{ success: false, error: string, code?: string }
```

Validation rules:
- `name`: required, 1–30 characters, trimmed, case-insensitive unique. Return `400` for
  empty/too-long names, `409` for duplicates.
- `color`: required, must be a valid 6-digit hex code (`^#[0-9A-Fa-f]{6}$`). Return `400`
  otherwise. Recommend restricting UI to the preset palette but validate server-side
  against the same regex regardless (don't hard-restrict to the palette server-side, in
  case the palette changes later).
- Attaching a `tagId` that doesn't exist → `404`.
- Attaching a tag already attached to the todo → idempotent no-op (`200`, not an error).
- Route handlers use Next.js 16 async params: `{ params }: { params: Promise<{ id: string }> }`,
  matching the rest of the codebase.

### 4.4 Query Patterns (better-sqlite3, synchronous)

```typescript
// Get todos with their tags (avoid N+1 by fetching all tags for the result set at once)
const todos = db.prepare(`SELECT * FROM todos WHERE ...`).all();
const todoIds = todos.map(t => t.id);
const tagRows = db.prepare(`
  SELECT tt.todo_id, t.id, t.name, t.color
  FROM todo_tags tt
  JOIN tags t ON t.id = tt.tag_id
  WHERE tt.todo_id IN (${todoIds.map(() => '?').join(',')})
`).all(...todoIds);
// group tagRows by todo_id in application code and attach to each todo

// Filter todos by tag (OR across selected tag ids)
const filtered = db.prepare(`
  SELECT DISTINCT t.*
  FROM todos t
  JOIN todo_tags tt ON tt.todo_id = t.id
  WHERE tt.tag_id IN (${tagIds.map(() => '?').join(',')})
`).all(...tagIds);
```

---

## 5. UI Components

### 5.1 `TagBadge`
Small, color-coded pill showing tag name. Rendered on todo cards (one per attached tag,
wrapped/truncated if many). Text color auto-computed for contrast against the background
color (light text on dark colors, dark text on light colors).

```tsx
interface TagBadgeProps {
  tag: Tag;
  onRemove?: () => void;  // shows an "×" when provided (edit context)
  size?: 'sm' | 'md';
}
```

### 5.2 `TagPicker`
Searchable multi-select dropdown used inside the todo create/edit form. Shows existing
tags matching the search query, plus a "Create '<query>'" option when no exact match
exists. Selecting "Create" opens an inline color picker before finalizing.

```tsx
interface TagPickerProps {
  selectedTags: Tag[];
  onChange: (tags: Tag[]) => void;
  allTags: Tag[];
  onCreateTag: (name: string, color: string) => Promise<Tag>;
}
```

### 5.3 `TagManager` (modal or panel)
Full list of all tags with inline rename, color swatch picker, todo-count, and delete
(with confirmation dialog stating how many todos will be affected).

```tsx
interface TagManagerProps {
  tags: Tag[];
  onRename: (id: number, name: string) => Promise<void>;
  onRecolor: (id: number, color: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}
```

### 5.4 `TagFilterBar`
Row of clickable tag chips (reuses `TagBadge` in a "toggle" mode) placed alongside the
existing Priority filter controls. Highlights active selections; shows a "Clear tags"
link when any are active.

```tsx
interface TagFilterBarProps {
  allTags: Tag[];
  activeTagIds: number[];
  onToggleTag: (id: number) => void;
  onClear: () => void;
}
```

---

## 6. Edge Cases

- **Duplicate tag name (case-insensitive):** reject with a clear inline error ("A tag
  named 'Work' already exists") rather than a generic 409 message; offer to select the
  existing tag instead of creating a duplicate.
- **Deleting a tag that's in use:** allowed, but require confirmation showing the exact
  count of affected todos; cascade delete removes the association, not the todos.
- **Deleting a tag while its edit is open in another browser tab/session:** the other
  tab's next save attempt against that tag should fail gracefully (404) and the UI should
  refresh its tag list rather than crash.
- **Very long tag names:** enforce a 30-character limit both client- and server-side;
  truncate with ellipsis + tooltip in badge display if a legacy/imported name exceeds it.
- **Empty or whitespace-only tag name:** rejected client-side before the request is sent,
  and server-side as a defense-in-depth `400`.
- **Attaching the same tag twice:** idempotent, no duplicate row (enforced by the
  composite primary key `(todo_id, tag_id)` in `todo_tags`).
- **Todo with zero tags:** no badges rendered; tag section of the card is simply omitted
  (no empty placeholder clutter).
- **Filtering by a tag that's just been deleted:** the filter should silently drop the
  now-invalid tag ID from the active filter set on the next tag list refresh.
- **Color contrast:** if a user picks a very light or very dark custom color (if custom
  color input is allowed beyond the preset palette), compute readable text color
  dynamically (e.g. via relative luminance) rather than assuming a fixed light/dark text.
- **Large numbers of tags (50+):** `TagPicker` and `TagFilterBar` must remain usable —
  implement client-side search/filter within the dropdown rather than rendering all tags
  unfiltered.
- **Race condition on inline tag creation:** if two requests attempt to create the same
  tag name concurrently (e.g. double-click), rely on the DB's `UNIQUE` constraint as the
  source of truth and handle the resulting `409` gracefully in the UI (re-fetch and
  select the now-existing tag rather than showing a raw error).
- **Todo deletion:** deleting a todo (from Todo CRUD, 01) must cascade-delete its
  `todo_tags` rows without leaving orphaned associations (covered by `ON DELETE CASCADE`
  — verify `PRAGMA foreign_keys = ON` is actually active in the DB connection setup).

---

## 7. Acceptance Criteria

- [ ] Users can create a new tag with a name and color, inline from the todo form and
      from the Tag Manager.
- [ ] Tag names are unique case-insensitively; duplicate creation attempts are rejected
      with a clear, actionable error message.
- [ ] Tags render as color-coded badges on todo cards, with readable text contrast.
- [ ] Users can attach and detach any number of tags to/from any todo.
- [ ] The Tag Manager lists every tag with its color, name, and current todo count, and
      supports rename, recolor, and delete.
- [ ] Deleting a tag removes it from all todos (association only) without deleting the
      todos, and requires user confirmation showing the affected todo count.
- [ ] The todo list can be filtered by one or more tags; multiple selected tags combine
      with OR logic; the tag filter combines with other active filters (e.g. Priority)
      using AND logic.
- [ ] All API endpoints return the standard success/error response shape used elsewhere
      in the app, with correct HTTP status codes (`400`, `404`, `409` as specified).
- [ ] No N+1 query patterns when loading todos with their tags for list views.
- [ ] Foreign key cascade behavior is verified: deleting a todo or a tag correctly and
      automatically cleans up `todo_tags` rows.
- [ ] Tag CRUD and filtering work correctly with 0 tags, 1 tag, and 50+ tags.

---

## 8. Testing Requirements

### 8.1 Unit Tests
- Tag name validation (empty, too long, valid, case-insensitive duplicate).
- Color hex validation (valid hex, invalid formats, missing `#`).
- Query helper that groups tag rows by `todo_id` produces correct grouping, including
  todos with zero tags (empty array, not `undefined`).
- Tag filter query (OR-across-tags, AND-against-other-filters) returns correct result
  sets for representative fixtures.

### 8.2 E2E Tests (Playwright)
- Create a tag inline while creating a new todo; verify the tag badge appears on the
  saved todo card.
- Attempt to create a duplicate tag name (different casing); verify the inline error and
  that no duplicate is created in the tag list.
- Attach an existing tag to an existing todo via the edit form; verify persistence after
  page reload.
- Remove a tag from a todo; verify the badge disappears and persists after reload.
- Open the Tag Manager, rename a tag, and verify the new name appears on all todos that
  had that tag.
- Delete a tag with the confirmation dialog; verify the confirmation shows the correct
  affected-todo count, and that after deletion the tag badge is gone from all previously
  tagged todos while the todos themselves remain.
- Filter the todo list by a single tag; verify only matching todos are shown.
- Filter by two tags simultaneously; verify OR logic (todos matching either tag appear).
- Combine a tag filter with a priority filter; verify AND logic across the two filter
  types.
- Clear tag filters; verify the full todo list is restored.

---

## 9. Out of Scope

- Nested/hierarchical tags (parent-child tag relationships).
- Tag-based automation or rules (e.g. "auto-tag todos containing 'invoice'").
- Sharing or syncing tags across multiple user accounts (single-user app for now).
- Bulk tag operations across multiple selected todos in one action (may be revisited
  after Search & Filtering, 08, is implemented).
- Tag usage analytics/history beyond the simple current todo count shown in Tag Manager.
- Custom/freeform hex color input beyond the preset palette (unless explicitly requested
  later — server-side validation still accepts any valid hex to keep this option open).

---

## 10. Success Metrics

- Users can create, attach, and filter by a tag in under 3 interactions each (click →
  type/select → confirm).
- Zero orphaned `todo_tags` rows after todo or tag deletion, verified via cascade tests.
- Tag list and filter UI remain responsive (no visible lag) with 50+ tags and 500+ todos
  in the dataset, verified via manual/perf testing during implementation.
- No duplicate tag names possible through the UI under normal or rapid double-click use.
