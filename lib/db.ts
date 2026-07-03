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
