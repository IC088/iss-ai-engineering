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
        created_at TEXT  NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS todo_tags (
        todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
        tag_id  INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
        PRIMARY KEY (todo_id, tag_id)
      );

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
