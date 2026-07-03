# PRP 07 — Template System

## 1. Feature Overview

The Template System allows users to save frequently used todo patterns and reuse them to create new todos instantly. A template captures a title, priority, recurrence pattern, reminder offset, optional due date offset (in days from creation), and an ordered list of subtask titles. When a user creates a todo from a template, all fields are pre-populated and the due date is calculated forward from the current Singapore time. Templates are grouped into categories for easy browsing.

---

## 2. User Stories

### Persona A — Routine Task User
> *"I have the same weekly review checklist every Friday. I want to save it once and spin up a new instance in two clicks."*

- As a logged-in user, I can save any existing todo (with its subtasks) as a template so that I don't have to re-enter the same information repeatedly.
- As a logged-in user, I can create a new todo from a template so that all fields are pre-filled and ready to submit or tweak.

### Persona B — Team Process Owner
> *"Our team has standard procedures. I want to categorise templates by process type so team members find the right one quickly."*

- As a logged-in user, I can assign a category label to a template so that I can group related templates together.
- As a logged-in user, I can filter the template list by category so that I find the right template without scrolling through everything.

### Persona C — Template Manager
> *"Templates get outdated. I need to rename, edit, or remove them."*

- As a logged-in user, I can rename and edit an existing template so that outdated templates stay relevant.
- As a logged-in user, I can delete a template I no longer need so that the list stays clean.

---

## 3. User Flow

### 3.1 Save a Todo as a Template

1. User is on the main todo page and locates a todo they want to save.
2. User clicks the **"Save as Template"** action in the todo row's action menu.
3. A modal opens pre-filled with:
   - Template name (defaults to the todo's title)
   - Category (free-text input, optional)
   - Due date offset in days (optional integer ≥ 0; blank means no due date)
   - Subtask list (read from the todo's current subtasks, titles only)
4. User adjusts the template name and fields if needed, then clicks **"Save Template"**.
5. `POST /api/templates` is called with the serialised payload.
6. On success (201): a success toast appears; the modal closes.
7. On failure: an inline error message appears inside the modal.

### 3.2 Create a Todo from a Template

1. User clicks the **"Use Template"** button in the main page header or create area.
2. A panel/modal lists all the user's templates, grouped by category.
3. User optionally filters by category using a dropdown.
4. User clicks a template to preview: title, priority, subtasks, due offset, recurrence, reminder.
5. User clicks **"Create from Template"**.
6. `POST /api/templates/:id/use` is called.
7. The server calculates `due_date = getSingaporeNow() + offset_days` (null if no offset), creates the todo, and inserts subtasks in their saved position order.
8. On success (201): the new todo appears in the Active section; the modal closes.

### 3.3 Manage Templates

1. User clicks **"Manage Templates"** (accessible from the template picker or settings area).
2. A list of all templates is displayed with name, category badge, and subtask count.
3. User can:
   - Click **"Edit"** on a template → opens an edit modal (same fields as save modal).
   - Click **"Delete"** on a template → a confirmation prompt appears; on confirm, `DELETE /api/templates/:id` is called.
4. Changes reflect immediately in the list.

---

## 4. Out of Scope

- Sharing templates between users.
- Template versioning or history.
- Importing/exporting templates separately from the main export feature.
- Nested categories or category hierarchy.
- Scheduling automatic todo creation from templates.

---

## 5. UI Components

### TemplatePickerModal
- Triggered by **"Use Template"** button in the main header.
- Search input to filter templates by name.
- Category filter dropdown (populated from distinct categories in user's templates).
- Template list: card per template showing name, category badge, priority, subtask count, due offset.
- Selected template card is highlighted; clicking it shows a preview pane.
- **"Create from Template"** button (disabled until a template is selected).

### SaveAsTemplateModal
- Opens from a todo row's action menu ("Save as Template").
- Fields: Template Name (text, required), Category (text, optional), Due Date Offset in Days (number, optional), read-only subtask list (checked items shown as titles only).
- **"Save Template"** / **"Cancel"** buttons.

### ManageTemplatesModal
- Lists all templates in a scrollable list.
- Each row: template name, category badge, action buttons (Edit, Delete).
- Inline edit form expands on "Edit" click; separate confirmation modal for delete.

### TemplateFormFields (shared between Save and Edit modals)
- Reusable controlled form section: name, category, due offset, priority selector, recurrence selector, reminder selector.

---

## 6. Technical Requirements

### Database

**New table: `templates`**
```sql
CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  category   TEXT,
  priority   TEXT    NOT NULL DEFAULT 'medium',
  recurrence TEXT,
  reminder_minutes INTEGER,
  due_offset_days  INTEGER,
  subtasks   TEXT    NOT NULL DEFAULT '[]',  -- JSON array: [{title, position}]
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
```

**Subtasks JSON schema** (stored in `subtasks` column):
```json
[
  { "title": "Step 1", "position": 1 },
  { "title": "Step 2", "position": 2 }
]
```

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/templates` | List all templates for the authenticated user |
| `POST` | `/api/templates` | Create a new template |
| `GET` | `/api/templates/:id` | Get a single template |
| `PUT` | `/api/templates/:id` | Update a template |
| `DELETE` | `/api/templates/:id` | Delete a template |
| `POST` | `/api/templates/:id/use` | Create a todo from a template |

**POST `/api/templates/:id/use` logic:**
1. Load template; verify ownership (return 404 if not found/not owned).
2. Parse `subtasks` JSON column.
3. Calculate `due_date`:
   - If `due_offset_days` is a non-negative integer: `due_date = getSingaporeNow() + due_offset_days * 86400000` (converted to UTC ISO string).
   - If `due_offset_days` is null: `due_date = null`.
4. Insert into `todos` with `title`, `priority`, `recurrence`, `reminder_minutes`, `due_date`, `user_id`.
5. Insert each subtask from the parsed array into `subtasks` table preserving `position`.
6. Return the created todo with `201`.

### `lib/db.ts` additions
- `Template` interface matching the table columns.
- `templateDB` export with methods: `create`, `list`, `findById`, `update`, `delete`, `ownerUserId`.
- `parseSubtasks(json: string): SubtaskTemplate[]` — JSON.parse with fallback to `[]`.
- `serializeSubtasks(items: SubtaskTemplate[]): string` — JSON.stringify.

### Validation
- `name`: required, trimmed, 1–200 characters.
- `category`: optional, trimmed, max 50 characters.
- `due_offset_days`: optional, integer ≥ 0, max 3650 (10 years).
- `priority`: must be one of `PRIORITY_VALUES` (allowlist check).
- `subtasks` array: max 50 items; each title trimmed, 1–200 characters.
- Ownership check on all update/delete/use operations: compare `template.user_id` to `session.userId`.

---

## 7. Acceptance Criteria

| ID | Criterion |
|----|-----------|
| TC-T01 | User can create a template with a name, category, priority, recurrence, reminder, due offset, and up to 50 subtasks. |
| TC-T02 | Template subtasks are serialised to JSON and deserialised correctly on read. |
| TC-T03 | Creating a todo from a template with `due_offset_days = 3` sets `due_date` to exactly 3 days from the current SGT time (UTC stored). |
| TC-T04 | Creating a todo from a template with `due_offset_days = null` creates a todo with no due date. |
| TC-T05 | Subtasks are created for the new todo in the same order (by `position`) as in the template. |
| TC-T06 | Editing a template's name and category is reflected immediately on subsequent `GET /api/templates`. |
| TC-T07 | Deleting a template removes it and returns 200; subsequent `GET /api/templates/:id` returns 404. |
| TC-T08 | Template operations on another user's template return 404 (ownership isolation). |
| TC-T09 | Category filter in the UI shows only templates matching the selected category. |
| TC-T10 | A template name longer than 200 characters is rejected with a 400 error. |
