# PRP 09 — Export & Import

## 1. Feature Overview

The Export & Import feature enables users to back up all their todo data as a portable JSON file and restore it on any account. On export, the server serialises the authenticated user's todos, subtasks, and tags (including many-to-many relationships) into a single JSON document. On import, the server validates the document, remaps all IDs to avoid primary key collisions, and re-creates every record under the current user's account with relationships intact.

---

## 2. User Stories

### Persona A — Backup User
> *"I want a safety net. If something goes wrong, I need to restore my full task list without losing subtasks or tags."*

- As a logged-in user, I can download a JSON backup of all my todos, subtasks, and tags so that I have a local copy I can restore later.
- As a logged-in user, my exported file contains enough information to fully reconstruct my task list, including tag colours and subtask order.

### Persona B — Migration User
> *"I set up a new account. I want to bring my existing todos with me."*

- As a logged-in user, I can upload a previously exported JSON file to a new account so that all my todos are recreated with their tags and subtasks.
- As a logged-in user, if my import file contains IDs that already exist in the database, the import still succeeds by remapping them to new IDs.

### Persona C — Cautious User
> *"I'm not sure if my backup file is valid. I want the app to tell me what's wrong before it tries to import anything."*

- As a logged-in user, I receive a clear validation error if the file I upload is malformed or missing required fields, so I know what to fix.
- As a logged-in user, a failed import does not partially modify my data — either everything succeeds or nothing is written.

---

## 3. User Flow

### 3.1 Export

1. User clicks the **"Export"** button in the main page header.
2. `GET /api/todos/export` is called.
3. The server assembles the export document and returns it as `application/json`.
4. The browser triggers a file download named `todos-export-YYYY-MM-DD.json` (date in SGT).
5. A success toast confirms the download started.

### 3.2 Import

1. User clicks the **"Import"** button in the main page header.
2. An import modal opens with a file picker (accepts `.json` only).
3. User selects a file; a preview shows the counts: "X todos, Y subtasks, Z tags".
4. User clicks **"Import"**.
5. `POST /api/todos/import` is called with the file content as the request body.
6. On success (200): a toast shows "Imported X todos, Y subtasks, Z tags"; the todo list refreshes.
7. On validation failure (400): an inline error lists the specific issues (e.g., "Todo at index 2 is missing a title").
8. On server error (500): a generic error toast appears; no data has been written.

---

## 4. Out of Scope

- Exporting or importing templates separately from this feature.
- Merging duplicate todos (deduplication logic).
- Partial imports (importing only selected todos from a file).
- Exporting to formats other than JSON (CSV, iCal).
- Automatic scheduled backups.
- Import progress bar for very large files.

---

## 5. UI Components

### ExportButton
- Located in the main page header alongside existing action buttons.
- Single click triggers the export download; no modal required.
- Shows a brief loading state while the request is in flight.

### ImportModal
- Triggered by the **"Import"** button in the header.
- File picker input (`accept=".json"`); drag-and-drop optional.
- After file selection, displays a preview summary: todo count, subtask count, tag count.
- **"Import"** button (disabled until a valid JSON file is selected and parsed client-side).
- Inline error area for validation messages returned by the server.
- **"Cancel"** closes the modal without any action.

---

## 6. Technical Requirements

### Export Document Schema

```json
{
  "version": 1,
  "exported_at": "2026-07-03T10:00:00.000Z",
  "todos": [
    {
      "id": 1,
      "title": "Example todo",
      "completed": 0,
      "priority": "high",
      "due_date": "2026-07-10T08:00:00.000Z",
      "recurrence": null,
      "reminder_minutes": 60,
      "created_at": "2026-07-01T02:00:00.000Z",
      "updated_at": "2026-07-01T02:00:00.000Z"
    }
  ],
  "subtasks": [
    {
      "id": 10,
      "todo_id": 1,
      "title": "Step one",
      "completed": 0,
      "position": 1
    }
  ],
  "tags": [
    {
      "id": 5,
      "name": "work",
      "color": "#3b82f6"
    }
  ],
  "todo_tags": [
    { "todo_id": 1, "tag_id": 5 }
  ]
}
```

Fields `user_id` and `last_notification_sent` are **excluded** from the export (they are account-specific and should not be restored verbatim).

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/todos/export` | Export all user data as JSON |
| `POST` | `/api/todos/import` | Import a previously exported JSON document |

#### GET `/api/todos/export`

1. Authenticate; return 401 if no session.
2. Query all todos for `session.userId`.
3. For each todo, query its subtasks.
4. Query all tags belonging to the user.
5. Query all `todo_tags` rows where `todo_id` is in the user's todo set.
6. Assemble and return the export document with `Content-Disposition: attachment; filename="todos-export-<date>.json"`.

#### POST `/api/todos/import`

1. Authenticate; return 401 if no session.
2. Parse request body as JSON; return 400 on parse failure.
3. **Validate** the document structure (see Validation section).
4. Begin a SQLite transaction.
5. **Remap IDs**:
   - Build `tagIdMap: Map<oldId, newId>` — for each tag in the import, check if a tag with the same `name` already exists for this user; if so, reuse that `id`; otherwise insert a new tag and record the new `id`.
   - Build `todoIdMap: Map<oldId, newId>` — insert each todo (with `user_id = session.userId`, reset `last_notification_sent = NULL`) and record the new auto-increment `id`.
   - Build `subtaskIdMap: Map<oldId, newId>` — insert each subtask using the remapped `todo_id` from `todoIdMap`.
   - Insert `todo_tags` rows using remapped `todo_id` and `tag_id`.
6. Commit transaction; return `{ imported: { todos, subtasks, tags } }` counts.
7. On any error: rollback transaction; return 500.

### `lib/db.ts` additions
- No new tables required.
- Export helper: `exportUserData(userId)` — assembles the full export object.
- Import helper: `importUserData(userId, payload)` — runs the transactional ID-remapping import, returns counts.

### Validation (server-side, run before the transaction)

The server validates the following before touching the database:

- `version` must be `1` (integer).
- `todos` must be an array; each item must have:
  - `title`: non-empty string, max 200 characters.
  - `completed`: 0 or 1.
  - `priority`: one of `PRIORITY_VALUES` or null.
  - `due_date`: ISO 8601 string or null.
  - `recurrence`: one of `RECURRENCE_VALUES` or null.
  - `reminder_minutes`: one of `REMINDER_MINUTES_VALUES` or null.
- `subtasks` must be an array; each item must have:
  - `todo_id`: integer present in the export's `todos[*].id` set.
  - `title`: non-empty string, max 200 characters.
  - `completed`: 0 or 1.
  - `position`: positive integer.
- `tags` must be an array; each item must have:
  - `name`: non-empty string, max 50 characters.
- `todo_tags` must be an array; each item must reference a valid `todo_id` and `tag_id` within the export.

Return a structured 400 with an array of error messages if any check fails; do not begin the transaction.

### Atomicity
- The entire import runs inside a single `better-sqlite3` transaction (`db.transaction(fn)()`).
- If any insert fails (e.g., constraint violation), the transaction rolls back automatically.
- The export endpoint is read-only and requires no transaction.

---

## 7. Acceptance Criteria

| ID | Criterion |
|----|-----------|
| TC-E01 | Clicking Export downloads a valid JSON file containing all the user's todos, subtasks, tags, and todo_tags. |
| TC-E02 | The exported file does not contain `user_id` or `last_notification_sent` fields. |
| TC-E03 | Importing the exported file into the same account creates duplicate todos alongside the originals (no deduplication). |
| TC-E04 | Importing the exported file into a different (empty) account recreates all todos, subtasks, tags, and relationships correctly. |
| TC-E05 | Tag names that already exist in the target account are reused (not duplicated) during import. |
| TC-E06 | All original todo–tag and todo–subtask relationships are preserved after import using remapped IDs. |
| TC-E07 | A malformed JSON file (e.g., missing `todos` array) returns a 400 with a descriptive error message and writes nothing to the database. |
| TC-E08 | A todo in the import file with an empty title returns a 400 referencing the specific index. |
| TC-E09 | If the import fails mid-way (e.g., database error), no partial records are written (full rollback). |
| TC-E10 | The import response includes counts of todos, subtasks, and tags that were successfully created. |
