// lib/db.ts
// Single source of truth for database schema, types, and CRUD helpers.
// All operations are synchronous (better-sqlite3 — no async/await needed).
// Import types only (`import type`) from client components to avoid bundling
// the server-only better-sqlite3 module into the client bundle.

import Database from 'better-sqlite3'
import path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Priority = 'high' | 'medium' | 'low'

// PRP 03 — recurrence pattern type (single source of truth; never redeclare elsewhere)
export type RecurrencePattern = 'daily' | 'weekly' | 'monthly' | 'yearly'

export const PRIORITY_VALUES: Priority[] = ['high', 'medium', 'low']
export const PRIORITY_ORDER: Record<Priority, number> = { high: 3, medium: 2, low: 1 }
export const RECURRENCE_VALUES: RecurrencePattern[] = ['daily', 'weekly', 'monthly', 'yearly']

// PRP 04 — reminder offset options (single source of truth; never redeclare elsewhere)
export const REMINDER_OPTIONS: { label: string; minutes: number }[] = [
  { label: '15 minutes before', minutes: 15 },
  { label: '30 minutes before', minutes: 30 },
  { label: '1 hour before',     minutes: 60 },
  { label: '2 hours before',    minutes: 120 },
  { label: '1 day before',      minutes: 1440 },
  { label: '2 days before',     minutes: 2880 },
  { label: '1 week before',     minutes: 10080 },
]
export const REMINDER_MINUTES_VALUES: number[] = REMINDER_OPTIONS.map((o) => o.minutes)

export interface Todo {
  id: number
  user_id: number
  title: string
  description: string | null
  due_date: string | null
  completed: 0 | 1
  priority: Priority
  // PRP 03: single column encodes both is_recurring (non-null = true) and the pattern value.
  // Existing routes use this column — never redeclare is_recurring / recurrence_pattern.
  recurrence: RecurrencePattern | null
  reminder_minutes: number | null
  last_notification_sent: string | null
  created_at: string
  updated_at: string
}

export interface User {
  id: number
  username: string
  created_at: string
}

// ---------------------------------------------------------------------------
// Tag types (PRP 06 — Tag System)
// ---------------------------------------------------------------------------
export interface Tag {
  id: number
  user_id: number
  name: string
  color: string  // hex code, e.g. '#3B82F6'
  created_at: string
  updated_at: string
  todo_count?: number  // populated only in tag-manager list queries
}

export interface CreateTagInput {
  name: string
  color: string
}

export interface UpdateTagInput {
  name?: string
  color?: string
}

export interface TodoWithTags extends Todo {
  tags: Tag[]
}

export const TAG_PRESET_COLORS = [
  '#EF4444', // red
  '#F97316', // orange
  '#F59E0B', // amber
  '#84CC16', // lime
  '#10B981', // emerald
  '#06B6D4', // cyan
  '#3B82F6', // blue
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#6B7280', // gray
] as const

// Standard API envelope shapes
export interface ApiError {
  code: string
  message: string
}
export interface ApiResponse<T> {
  data?: T
  error?: ApiError
}

// ---------------------------------------------------------------------------
// Singleton DB (Next.js hot-reload safe via global)
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var _sqliteDb: Database.Database | undefined
}

export function getDb(): Database.Database {
  if (!global._sqliteDb) {
    const dbPath = path.join(process.cwd(), 'todos.db')
    const db = new Database(dbPath)

    // Performance and integrity settings
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // Schema — CREATE IF NOT EXISTS keeps this idempotent for new databases.
    // Existing tables are untouched; ALTER TABLE guards below handle migrations.
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT    UNIQUE NOT NULL,
        created_at TEXT  NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS todos (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT    NOT NULL,
        description TEXT,
        due_date    TEXT,
        completed   INTEGER NOT NULL DEFAULT 0,
        priority    TEXT    NOT NULL DEFAULT 'medium',
        recurrence  TEXT,
        reminder_minutes      INTEGER,
        last_notification_sent TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS subtasks (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        todo_id  INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        title    TEXT    NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        position  INTEGER NOT NULL DEFAULT 0,
        created_at TEXT  NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT  NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tags (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name     TEXT    NOT NULL,
        color    TEXT    NOT NULL DEFAULT '#6366f1',
        created_at TEXT  NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT  NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS todo_tags (
        todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
        PRIMARY KEY (todo_id, tag_id)
      );

      CREATE TRIGGER IF NOT EXISTS update_tags_updated_at
      AFTER UPDATE ON tags FOR EACH ROW
      WHEN OLD.name != NEW.name OR OLD.color != NEW.color
      BEGIN
        UPDATE tags SET updated_at = datetime('now') WHERE id = OLD.id;
      END;

      CREATE TRIGGER IF NOT EXISTS update_todos_updated_at
      AFTER UPDATE ON todos FOR EACH ROW
      BEGIN
        UPDATE todos SET updated_at = datetime('now') WHERE id = OLD.id;
      END;

      CREATE TABLE IF NOT EXISTS templates (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name             TEXT    NOT NULL,
        category         TEXT,
        priority         TEXT    NOT NULL DEFAULT 'medium',
        recurrence       TEXT,
        reminder_minutes INTEGER,
        due_offset_days  INTEGER,
        subtasks         TEXT    NOT NULL DEFAULT '[]',
        created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS holidays (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT    NOT NULL UNIQUE,
        name TEXT    NOT NULL
      );
    `)

    // PRP 05 — index on subtasks.todo_id for O(log n) lookups per parent todo
    db.exec(`CREATE INDEX IF NOT EXISTS idx_subtasks_todo ON subtasks(todo_id)`)

    // ---------------------------------------------------------------------------
    // Idempotent migrations — add columns that may be absent on existing databases.
    // Each ALTER TABLE is wrapped in try/catch; SQLite throws "duplicate column name"
    // if the column already exists, which we silently ignore.
    // ---------------------------------------------------------------------------

    // PRP 04 — reminder_minutes (may be absent on DBs created before this migration)
    try {
      db.exec(`ALTER TABLE todos ADD COLUMN reminder_minutes INTEGER`)
    } catch {
      // Column already exists — safe to ignore.
    }

    // PRP 03/04 — last_notification_sent (needed for reminder dedup; child todos reset it)
    try {
      db.exec(`ALTER TABLE todos ADD COLUMN last_notification_sent TEXT`)
    } catch {
      // Column already exists — safe to ignore.
    }

    // PRP 06 — tags.updated_at (may be absent on DBs created before this migration)
    try {
      db.exec(`ALTER TABLE tags ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`)
    } catch {
      // Column already exists — safe to ignore.
    }

    // PRP 06 — case-insensitive unique index on (user_id, name) for tags
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, name COLLATE NOCASE)`)

    // PRP 06 — indexes on todo_tags for fast joins in both directions
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_tags_todo_id ON todo_tags(todo_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_todo_tags_tag_id ON todo_tags(tag_id)`)

    // PRP 07 — index on templates.user_id
    db.exec(`CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id)`)

    // PRP 10 — index on holidays.date
    db.exec(`CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date)`)

    global._sqliteDb = db
  }
  return global._sqliteDb
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates and returns a Priority value.
 * Throws `{ code, message }` on invalid input (shape matches API error envelope).
 * Returns 'medium' when value is null/undefined (default per PRP 02).
 */
export function validatePriority(value: unknown): Priority {
  if (value === undefined || value === null) {
    return 'medium'
  }
  if (typeof value !== 'string' || !(PRIORITY_VALUES as string[]).includes(value)) {
    throw { code: 'INVALID_PRIORITY', message: 'Priority must be one of: high, medium, low' }
  }
  return value as Priority
}

const TAG_COLOR_RE = /^#[0-9A-Fa-f]{6}$/

/**
 * Validates and returns a trimmed tag name string.
 * Throws `{ code, message }` on invalid input.
 */
export function validateTagName(value: unknown): string {
  if (typeof value !== 'string') {
    throw { code: 'TAG_NAME_REQUIRED', message: 'Tag name is required' }
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw { code: 'TAG_NAME_REQUIRED', message: 'Tag name is required' }
  }
  if (trimmed.length > 30) {
    throw { code: 'TAG_NAME_TOO_LONG', message: 'Tag name must be 30 characters or less' }
  }
  return trimmed
}

/**
 * Validates a 6-digit hex color code.
 * Throws `{ code, message }` on invalid input.
 */
export function validateTagColor(value: unknown): string {
  if (typeof value !== 'string' || !TAG_COLOR_RE.test(value)) {
    throw { code: 'INVALID_TAG_COLOR', message: 'Color must be a valid 6-digit hex code (e.g. #3B82F6)' }
  }
  return value
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

/** Find an existing user by username or create a new one. Synchronous. */
export function findOrCreateUser(username: string): User {
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as User | undefined
  if (existing) return existing

  const result = db.prepare('INSERT INTO users (username) VALUES (?)').run(username)
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as User
}

// ---------------------------------------------------------------------------
// Subtask types + CRUD helpers (PRP 05)
// ---------------------------------------------------------------------------

export interface Subtask {
  id: number
  todo_id: number
  title: string
  completed: 0 | 1
  position: number
}

export const subtaskDB = {
  create(todoId: number, title: string): Subtask {
    const db = getDb()
    const { next_pos } = db
      .prepare(
        'SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM subtasks WHERE todo_id = ?'
      )
      .get(todoId) as { next_pos: number }
    const result = db
      .prepare('INSERT INTO subtasks (todo_id, title, position) VALUES (?, ?, ?)')
      .run(todoId, title, next_pos)
    return db
      .prepare(
        'SELECT id, todo_id, title, completed, position FROM subtasks WHERE id = ?'
      )
      .get(result.lastInsertRowid) as Subtask
  },

  listByTodo(todoId: number): Subtask[] {
    return getDb()
      .prepare(
        'SELECT id, todo_id, title, completed, position FROM subtasks WHERE todo_id = ? ORDER BY position ASC'
      )
      .all(todoId) as Subtask[]
  },

  toggle(id: number, completed: boolean): void {
    getDb().prepare('UPDATE subtasks SET completed = ? WHERE id = ?').run(completed ? 1 : 0, id)
  },

  updateTitle(id: number, title: string): void {
    getDb().prepare('UPDATE subtasks SET title = ? WHERE id = ?').run(title, id)
  },

  delete(id: number): void {
    getDb().prepare('DELETE FROM subtasks WHERE id = ?').run(id)
  },

  /** Returns the user_id of the parent todo, or null if the subtask doesn't exist. */
  ownerUserId(subtaskId: number): number | null {
    const row = getDb()
      .prepare(
        'SELECT t.user_id FROM subtasks s JOIN todos t ON s.todo_id = t.id WHERE s.id = ?'
      )
      .get(subtaskId) as { user_id: number } | undefined
    return row?.user_id ?? null
  },
}

/**
 * Computes subtask completion progress. Pure and unit-testable.
 * Returns pct = Math.round(done / total * 100); empty list returns pct = 0.
 */
export function progress(subtasks: Subtask[]): { done: number; total: number; pct: number } {
  const total = subtasks.length
  const done = subtasks.filter((s) => s.completed === 1).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return { done, total, pct }
}

// ---------------------------------------------------------------------------
// Tag helpers (PRP 06 — Tag System)
// ---------------------------------------------------------------------------

/**
 * Groups an array of tag rows (each with a todo_id property) by todo_id.
 * Pure and unit-testable. Ensures every entry in todoIds has a key (empty array).
 */
export function groupTagsByTodoId(
  rows: (Tag & { todo_id: number })[],
  todoIds: number[]
): Map<number, Tag[]> {
  const map = new Map<number, Tag[]>()
  for (const id of todoIds) map.set(id, [])
  for (const row of rows) {
    const { todo_id, ...tag } = row
    const bucket = map.get(todo_id)
    if (bucket) bucket.push(tag as Tag)
  }
  return map
}

export const tagDB = {
  /** List all tags for a user, each with a todo_count. */
  list(userId: number): (Tag & { todo_count: number })[] {
    return getDb()
      .prepare(
        `SELECT t.id, t.user_id, t.name, t.color, t.created_at, t.updated_at,
                CAST(COALESCE(COUNT(tt.todo_id), 0) AS INTEGER) AS todo_count
         FROM tags t
         LEFT JOIN todo_tags tt ON tt.tag_id = t.id
         WHERE t.user_id = ?
         GROUP BY t.id
         ORDER BY t.name COLLATE NOCASE`
      )
      .all(userId) as (Tag & { todo_count: number })[]
  },

  findById(id: number, userId: number): Tag | undefined {
    return getDb()
      .prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?')
      .get(id, userId) as Tag | undefined
  },

  /** Case-insensitive name lookup; pass excludeId to skip a specific tag (for updates). */
  findByName(userId: number, name: string, excludeId?: number): Tag | undefined {
    const db = getDb()
    if (excludeId !== undefined) {
      return db
        .prepare('SELECT * FROM tags WHERE user_id = ? AND name = ? COLLATE NOCASE AND id != ?')
        .get(userId, name, excludeId) as Tag | undefined
    }
    return db
      .prepare('SELECT * FROM tags WHERE user_id = ? AND name = ? COLLATE NOCASE')
      .get(userId, name) as Tag | undefined
  },

  create(userId: number, name: string, color: string): Tag {
    const db = getDb()
    const result = db
      .prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)')
      .run(userId, name, color)
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(result.lastInsertRowid) as Tag
  },

  update(id: number, userId: number, updates: UpdateTagInput): Tag | undefined {
    const db = getDb()
    const tag = db
      .prepare('SELECT * FROM tags WHERE id = ? AND user_id = ?')
      .get(id, userId) as Tag | undefined
    if (!tag) return undefined
    const newName = updates.name ?? tag.name
    const newColor = updates.color ?? tag.color
    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(newName, newColor, id)
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as Tag
  },

  delete(id: number, userId: number): boolean {
    const result = getDb()
      .prepare('DELETE FROM tags WHERE id = ? AND user_id = ?')
      .run(id, userId)
    return result.changes > 0
  },

  /** Return tags attached to a specific todo (ownership verified via todos.user_id). */
  listForTodo(todoId: number, userId: number): Tag[] {
    return getDb()
      .prepare(
        `SELECT tags.*
         FROM tags
         JOIN todo_tags ON todo_tags.tag_id = tags.id
         JOIN todos ON todos.id = todo_tags.todo_id
         WHERE todo_tags.todo_id = ? AND todos.user_id = ?
         ORDER BY tags.name COLLATE NOCASE`
      )
      .all(todoId, userId) as Tag[]
  },

  /**
   * Attach multiple tags to a todo.  Uses INSERT OR IGNORE so it is idempotent —
   * attaching an already-attached tag is a no-op (no error, no duplicate).
   */
  attachTags(todoId: number, tagIds: number[]): void {
    if (tagIds.length === 0) return
    const db = getDb()
    const insert = db.prepare('INSERT OR IGNORE INTO todo_tags (todo_id, tag_id) VALUES (?, ?)')
    const insertAll = db.transaction((ids: number[]) => {
      for (const tagId of ids) insert.run(todoId, tagId)
    })
    insertAll(tagIds)
  },

  /** Detach a single tag from a todo. Returns true if a row was deleted. */
  detachTag(todoId: number, tagId: number): boolean {
    const result = getDb()
      .prepare('DELETE FROM todo_tags WHERE todo_id = ? AND tag_id = ?')
      .run(todoId, tagId)
    return result.changes > 0
  },

  /**
   * Batch-fetch tags for multiple todo IDs. Chunks the query to respect SQLite’s
   * 999-variable limit. Returns a Map<todoId, Tag[]> with an empty array for
   * every todo that has no tags.
   */
  getTagsForTodos(todoIds: number[]): Map<number, Tag[]> {
    if (todoIds.length === 0) return new Map()
    const db = getDb()
    const map = new Map<number, Tag[]>()
    for (const id of todoIds) map.set(id, [])

    const CHUNK = 900
    for (let i = 0; i < todoIds.length; i += CHUNK) {
      const chunk = todoIds.slice(i, i + CHUNK)
      const ph = chunk.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT tt.todo_id, t.id, t.user_id, t.name, t.color, t.created_at, t.updated_at
           FROM todo_tags tt
           JOIN tags t ON t.id = tt.tag_id
           WHERE tt.todo_id IN (${ph})
           ORDER BY t.name COLLATE NOCASE`
        )
        .all(...chunk) as (Tag & { todo_id: number })[]

      for (const row of rows) {
        const { todo_id, ...tag } = row
        const bucket = map.get(todo_id)
        if (bucket) bucket.push(tag as Tag)
      }
    }
    return map
  },

  /** Return the todo_count for a single tag (for delete confirmation dialogs). */
  todoCount(id: number, userId: number): number {
    const row = getDb()
      .prepare(
        `SELECT CAST(COUNT(tt.todo_id) AS INTEGER) AS cnt
         FROM tags t
         LEFT JOIN todo_tags tt ON tt.tag_id = t.id
         WHERE t.id = ? AND t.user_id = ?`
      )
      .get(id, userId) as { cnt: number } | undefined
    return row?.cnt ?? 0
  },
}

// ---------------------------------------------------------------------------
// Template types + CRUD helpers (PRP 07 — Template System)
// ---------------------------------------------------------------------------

export interface SubtaskTemplate {
  title: string
  position: number
}

export interface Template {
  id: number
  user_id: number
  name: string
  category: string | null
  priority: Priority
  recurrence: RecurrencePattern | null
  reminder_minutes: number | null
  due_offset_days: number | null
  subtasks: string  // JSON-serialized SubtaskTemplate[]
  created_at: string
  updated_at: string
}

export interface CreateTemplateInput {
  name: string
  category?: string | null
  priority?: Priority
  recurrence?: RecurrencePattern | null
  reminder_minutes?: number | null
  due_offset_days?: number | null
  subtasks?: SubtaskTemplate[]
}

export interface UpdateTemplateInput {
  name?: string
  category?: string | null
  priority?: Priority
  recurrence?: RecurrencePattern | null
  reminder_minutes?: number | null
  due_offset_days?: number | null
  subtasks?: SubtaskTemplate[]
}

export function parseSubtasks(json: string): SubtaskTemplate[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function serializeSubtasks(items: SubtaskTemplate[]): string {
  return JSON.stringify(items)
}

// ---------------------------------------------------------------------------
// Holiday types + CRUD helpers (PRP 10 — Calendar View)
// ---------------------------------------------------------------------------

export interface Holiday {
  id: number
  date: string  // YYYY-MM-DD in SGT
  name: string
}

export const holidayDB = {
  /** Return all holidays for a given year-month (e.g. year=2026, month=7). */
  listByMonth(year: number, month: number): Holiday[] {
    const prefix = `${year}-${String(month).padStart(2, '0')}`
    return getDb()
      .prepare('SELECT id, date, name FROM holidays WHERE date LIKE ?')
      .all(`${prefix}-%`) as Holiday[]
  },

  /** Insert a holiday; silently ignores duplicates (idempotent seeding). */
  upsert(date: string, name: string): void {
    getDb()
      .prepare('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)')
      .run(date, name)
  },
}

// ---------------------------------------------------------------------------
// Export / Import helpers (PRP 09 — Export & Import)
// ---------------------------------------------------------------------------

export interface ExportTodo {
  id: number
  title: string
  description: string | null
  completed: 0 | 1
  priority: Priority
  due_date: string | null
  recurrence: RecurrencePattern | null
  reminder_minutes: number | null
  created_at: string
  updated_at: string
}

export interface ExportTag {
  id: number
  name: string
  color: string
}

export interface ExportDocument {
  version: 1
  exported_at: string
  todos: ExportTodo[]
  subtasks: Subtask[]
  tags: ExportTag[]
  todo_tags: Array<{ todo_id: number; tag_id: number }>
}

export interface ImportResult {
  todos: number
  subtasks: number
  tags: number
}

/** Assembles the full export object for a given user. Read-only; no transaction needed. */
export function exportUserData(userId: number): ExportDocument {
  const db = getDb()

  const todos = db
    .prepare(
      'SELECT id, title, description, completed, priority, due_date, recurrence, reminder_minutes, created_at, updated_at FROM todos WHERE user_id = ?'
    )
    .all(userId) as ExportTodo[]

  const todoIds = todos.map((t) => t.id)

  const subtasks: Subtask[] = []
  const todo_tags: Array<{ todo_id: number; tag_id: number }> = []

  if (todoIds.length > 0) {
    const CHUNK = 900
    for (let i = 0; i < todoIds.length; i += CHUNK) {
      const chunk = todoIds.slice(i, i + CHUNK)
      const ph = chunk.map(() => '?').join(',')
      subtasks.push(
        ...(db
          .prepare(`SELECT id, todo_id, title, completed, position FROM subtasks WHERE todo_id IN (${ph})`)
          .all(...chunk) as Subtask[])
      )
      todo_tags.push(
        ...(db
          .prepare(`SELECT todo_id, tag_id FROM todo_tags WHERE todo_id IN (${ph})`)
          .all(...chunk) as Array<{ todo_id: number; tag_id: number }>)
      )
    }
  }

  const tags = db
    .prepare('SELECT id, name, color FROM tags WHERE user_id = ?')
    .all(userId) as ExportTag[]

  return {
    version: 1,
    exported_at: new Date().toISOString(),
    todos,
    subtasks,
    tags,
    todo_tags,
  }
}

function validateImportPayload(payload: unknown): string[] {
  const errors: string[] = []

  if (typeof payload !== 'object' || payload === null) {
    return ['Payload must be a JSON object']
  }

  const p = payload as Record<string, unknown>

  if (p.version !== 1) {
    errors.push('version must be 1')
  }

  const todoIdSet = new Set<number>()
  if (!Array.isArray(p.todos)) {
    errors.push('todos must be an array')
  } else {
    for (let i = 0; i < p.todos.length; i++) {
      const todo = p.todos[i]
      if (typeof todo !== 'object' || todo === null) {
        errors.push(`todos[${i}] must be an object`)
        continue
      }
      const t = todo as Record<string, unknown>
      if (typeof t.id === 'number') todoIdSet.add(t.id)
      if (typeof t.title !== 'string' || (t.title as string).trim().length === 0) {
        errors.push(`Todo at index ${i} is missing a title`)
      } else if ((t.title as string).length > 200) {
        errors.push(`Todo at index ${i} title exceeds 200 characters`)
      }
      if (t.completed !== 0 && t.completed !== 1) {
        errors.push(`Todo at index ${i}: completed must be 0 or 1`)
      }
      if (t.priority !== null && t.priority !== undefined && !(PRIORITY_VALUES as string[]).includes(t.priority as string)) {
        errors.push(`Todo at index ${i}: priority must be one of ${PRIORITY_VALUES.join(', ')} or null`)
      }
      if (t.due_date !== null && t.due_date !== undefined && typeof t.due_date !== 'string') {
        errors.push(`Todo at index ${i}: due_date must be an ISO 8601 string or null`)
      }
      if (t.recurrence !== null && t.recurrence !== undefined && !(RECURRENCE_VALUES as string[]).includes(t.recurrence as string)) {
        errors.push(`Todo at index ${i}: recurrence must be one of ${RECURRENCE_VALUES.join(', ')} or null`)
      }
      if (t.reminder_minutes !== null && t.reminder_minutes !== undefined && !REMINDER_MINUTES_VALUES.includes(t.reminder_minutes as number)) {
        errors.push(`Todo at index ${i}: reminder_minutes must be one of ${REMINDER_MINUTES_VALUES.join(', ')} or null`)
      }
    }
  }

  const tagIdSet = new Set<number>()
  if (!Array.isArray(p.tags)) {
    errors.push('tags must be an array')
  } else {
    for (let i = 0; i < p.tags.length; i++) {
      const tag = p.tags[i]
      if (typeof tag !== 'object' || tag === null) {
        errors.push(`tags[${i}] must be an object`)
        continue
      }
      const t = tag as Record<string, unknown>
      if (typeof t.id === 'number') tagIdSet.add(t.id)
      if (typeof t.name !== 'string' || (t.name as string).trim().length === 0) {
        errors.push(`Tag at index ${i} is missing a name`)
      } else if ((t.name as string).length > 50) {
        errors.push(`Tag at index ${i} name exceeds 50 characters`)
      }
    }
  }

  if (!Array.isArray(p.subtasks)) {
    errors.push('subtasks must be an array')
  } else {
    for (let i = 0; i < p.subtasks.length; i++) {
      const sub = p.subtasks[i]
      if (typeof sub !== 'object' || sub === null) {
        errors.push(`subtasks[${i}] must be an object`)
        continue
      }
      const s = sub as Record<string, unknown>
      if (typeof s.todo_id !== 'number' || !todoIdSet.has(s.todo_id)) {
        errors.push(`Subtask at index ${i}: todo_id references an invalid todo`)
      }
      if (typeof s.title !== 'string' || (s.title as string).trim().length === 0) {
        errors.push(`Subtask at index ${i} is missing a title`)
      } else if ((s.title as string).length > 200) {
        errors.push(`Subtask at index ${i} title exceeds 200 characters`)
      }
      if (s.completed !== 0 && s.completed !== 1) {
        errors.push(`Subtask at index ${i}: completed must be 0 or 1`)
      }
      if (typeof s.position !== 'number' || !Number.isInteger(s.position) || s.position < 1) {
        errors.push(`Subtask at index ${i}: position must be a positive integer`)
      }
    }
  }

  if (!Array.isArray(p.todo_tags)) {
    errors.push('todo_tags must be an array')
  } else {
    for (let i = 0; i < p.todo_tags.length; i++) {
      const tt = p.todo_tags[i]
      if (typeof tt !== 'object' || tt === null) {
        errors.push(`todo_tags[${i}] must be an object`)
        continue
      }
      const item = tt as Record<string, unknown>
      if (typeof item.todo_id !== 'number' || !todoIdSet.has(item.todo_id)) {
        errors.push(`todo_tags[${i}]: todo_id references an invalid todo`)
      }
      if (typeof item.tag_id !== 'number' || !tagIdSet.has(item.tag_id)) {
        errors.push(`todo_tags[${i}]: tag_id references an invalid tag`)
      }
    }
  }

  return errors
}

/**
 * Validates and imports an export document for a given user.
 * Runs entirely inside a SQLite transaction — all records created or none.
 * Throws `{ code: 'VALIDATION_ERROR', errors: string[] }` on invalid payload.
 */
export function importUserData(userId: number, payload: unknown): ImportResult {
  const errors = validateImportPayload(payload)
  if (errors.length > 0) {
    throw { code: 'VALIDATION_ERROR', errors }
  }

  const data = payload as ExportDocument
  const db = getDb()

  let todosInserted = 0
  let subtasksInserted = 0
  let tagsInserted = 0

  const runImport = db.transaction(() => {
    // Step 1: Tags — reuse existing by name (case-insensitive), or insert new
    const tagIdMap = new Map<number, number>()
    for (const tag of data.tags) {
      const existing = db
        .prepare('SELECT id FROM tags WHERE user_id = ? AND name = ? COLLATE NOCASE')
        .get(userId, tag.name) as { id: number } | undefined
      if (existing) {
        tagIdMap.set(tag.id, existing.id)
      } else {
        const result = db
          .prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)')
          .run(userId, tag.name, tag.color)
        tagIdMap.set(tag.id, result.lastInsertRowid as number)
        tagsInserted++
      }
    }

    // Step 2: Todos — insert under current user, reset notification timestamp
    const todoIdMap = new Map<number, number>()
    for (const todo of data.todos) {
      const result = db
        .prepare(
          `INSERT INTO todos
             (user_id, title, description, completed, priority, due_date, recurrence, reminder_minutes, last_notification_sent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          userId,
          todo.title,
          todo.description ?? null,
          todo.completed,
          todo.priority ?? 'medium',
          todo.due_date ?? null,
          todo.recurrence ?? null,
          todo.reminder_minutes ?? null,
        )
      todoIdMap.set(todo.id, result.lastInsertRowid as number)
      todosInserted++
    }

    // Step 3: Subtasks — insert using remapped todo IDs
    for (const subtask of data.subtasks) {
      const newTodoId = todoIdMap.get(subtask.todo_id)
      if (newTodoId === undefined) continue
      db.prepare(
        'INSERT INTO subtasks (todo_id, title, completed, position) VALUES (?, ?, ?, ?)'
      ).run(newTodoId, subtask.title, subtask.completed, subtask.position)
      subtasksInserted++
    }

    // Step 4: todo_tags — insert using remapped IDs
    for (const tt of data.todo_tags) {
      const newTodoId = todoIdMap.get(tt.todo_id)
      const newTagId = tagIdMap.get(tt.tag_id)
      if (newTodoId === undefined || newTagId === undefined) continue
      db.prepare('INSERT OR IGNORE INTO todo_tags (todo_id, tag_id) VALUES (?, ?)').run(newTodoId, newTagId)
    }
  })

  runImport()

  return { todos: todosInserted, subtasks: subtasksInserted, tags: tagsInserted }
}

export const templateDB = {
  create(userId: number, input: CreateTemplateInput): Template {
    const db = getDb()
    const subtasksJson = serializeSubtasks(input.subtasks ?? [])
    const result = db
      .prepare(
        `INSERT INTO templates (user_id, name, category, priority, recurrence, reminder_minutes, due_offset_days, subtasks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        input.name,
        input.category ?? null,
        input.priority ?? 'medium',
        input.recurrence ?? null,
        input.reminder_minutes ?? null,
        input.due_offset_days ?? null,
        subtasksJson,
      )
    return db.prepare('SELECT * FROM templates WHERE id = ?').get(result.lastInsertRowid) as Template
  },

  list(userId: number): Template[] {
    return getDb()
      .prepare('SELECT * FROM templates WHERE user_id = ? ORDER BY name COLLATE NOCASE')
      .all(userId) as Template[]
  },

  findById(id: number): Template | undefined {
    return getDb()
      .prepare('SELECT * FROM templates WHERE id = ?')
      .get(id) as Template | undefined
  },

  update(id: number, userId: number, input: UpdateTemplateInput): Template | undefined {
    const db = getDb()
    const existing = db
      .prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?')
      .get(id, userId) as Template | undefined
    if (!existing) return undefined

    const newName = input.name ?? existing.name
    const newCategory = input.category !== undefined ? input.category : existing.category
    const newPriority = input.priority ?? existing.priority
    const newRecurrence = input.recurrence !== undefined ? input.recurrence : existing.recurrence
    const newReminderMinutes =
      input.reminder_minutes !== undefined ? input.reminder_minutes : existing.reminder_minutes
    const newDueOffsetDays =
      input.due_offset_days !== undefined ? input.due_offset_days : existing.due_offset_days
    const newSubtasksJson =
      input.subtasks !== undefined ? serializeSubtasks(input.subtasks) : existing.subtasks

    db.prepare(
      `UPDATE templates
       SET name = ?, category = ?, priority = ?, recurrence = ?, reminder_minutes = ?,
           due_offset_days = ?, subtasks = ?, updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE id = ?`
    ).run(newName, newCategory, newPriority, newRecurrence, newReminderMinutes, newDueOffsetDays, newSubtasksJson, id)

    return db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Template
  },

  delete(id: number, userId: number): boolean {
    const result = getDb()
      .prepare('DELETE FROM templates WHERE id = ? AND user_id = ?')
      .run(id, userId)
    return result.changes > 0
  },

  ownerUserId(id: number): number | null {
    const row = getDb()
      .prepare('SELECT user_id FROM templates WHERE id = ?')
      .get(id) as { user_id: number } | undefined
    return row?.user_id ?? null
  },
}
