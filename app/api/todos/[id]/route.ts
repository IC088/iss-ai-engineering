// app/api/todos/[id]/route.ts
// GET    /api/todos/[id] — read one todo
// PUT    /api/todos/[id] — update todo (allowlist enforced)
// DELETE /api/todos/[id] — delete todo (transaction-wrapped cascade)
// TODO(PRP-11): add per-session rate limiting once authentication is complete

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, validatePriority } from '@/lib/db'
import type { Todo, RecurrencePattern } from '@/lib/db'
import { parseDueDateToUtc, isDueDateValid, nextDueDate } from '@/lib/timezone'

const MAX_BODY_BYTES = 64 * 1024 // 64 KB

// Fields a client is allowed to send in a PUT body.
// Server-controlled fields (id, user_id, created_at, updated_at) are not in this list
// and are silently dropped if present — they are never applied.
const UPDATE_ALLOWLIST = [
  'title',
  'description',
  'due_date',
  'completed',
  'priority',
  'recurrence',
  'reminder_minutes',
] as const

const VALID_RECURRENCE = ['daily', 'weekly', 'monthly', 'yearly'] as const
const VALID_REMINDER_MINUTES = [15, 30, 60, 120, 1440, 2880, 10080] as const

function hasInvalidChars(str: string): boolean {
  return str.includes('<') || str.includes('>') || str.includes('javascript:')
}

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

type RouteContext = { params: Promise<{ id: string }> }

// ---------------------------------------------------------------------------
// GET /api/todos/[id] — read one todo
// ---------------------------------------------------------------------------
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  const { id } = await params
  const numericId = validateNumericId(id)
  if (!numericId) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const db = getDb()
    // AND user_id = ? prevents enumeration: other-user IDs also return 404
    const todo = db
      .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
      .get(numericId, session.userId) as Todo | undefined

    if (!todo) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: todo })
  } catch (err) {
    console.error('GET /api/todos/[id] error:', {
      endpoint: 'GET /api/todos/[id]',
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// PUT /api/todos/[id] — update todo
// ---------------------------------------------------------------------------
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  const { id } = await params
  const numericId = validateNumericId(id)
  if (!numericId) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } },
      { status: 400 }
    )
  }

  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 64 KB limit' } },
      { status: 413 }
    )
  }

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
      { status: 400 }
    )
  }

  // Reject unknown fields — server-controlled fields like id/created_at are also unknown here
  const unknownKeys = Object.keys(body).filter(
    (k) => !(UPDATE_ALLOWLIST as readonly string[]).includes(k)
  )
  if (unknownKeys.length > 0) {
    return NextResponse.json(
      { error: { code: 'UNKNOWN_FIELDS', message: `Unknown fields: ${unknownKeys.join(', ')}` } },
      { status: 400 }
    )
  }

  // Build the validated updates object — only from allowlisted keys present in the body
  const updates: Record<string, unknown> = {}

  if ('title' in body) {
    if (typeof body.title !== 'string') {
      return NextResponse.json(
        { error: { code: 'TITLE_REQUIRED', message: 'Title is required' } },
        { status: 400 }
      )
    }
    const title = body.title.trim()
    if (title.length === 0) {
      return NextResponse.json(
        { error: { code: 'TITLE_REQUIRED', message: 'Title is required' } },
        { status: 400 }
      )
    }
    if (title.length > 200) {
      return NextResponse.json(
        { error: { code: 'TITLE_TOO_LONG', message: 'Title must be 200 characters or less' } },
        { status: 400 }
      )
    }
    if (hasInvalidChars(title)) {
      return NextResponse.json(
        { error: { code: 'TITLE_INVALID_CHARS', message: 'Title contains invalid characters' } },
        { status: 400 }
      )
    }
    updates.title = title
  }

  if ('description' in body) {
    if (body.description === null) {
      updates.description = null
    } else if (typeof body.description !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_DESCRIPTION', message: 'Description must be a string' } },
        { status: 400 }
      )
    } else {
      if (body.description.length > 2000) {
        return NextResponse.json(
          {
            error: {
              code: 'DESCRIPTION_TOO_LONG',
              message: 'Description must be 2000 characters or less',
            },
          },
          { status: 400 }
        )
      }
      if (hasInvalidChars(body.description)) {
        return NextResponse.json(
          {
            error: {
              code: 'DESCRIPTION_INVALID_CHARS',
              message: 'Description contains invalid characters',
            },
          },
          { status: 400 }
        )
      }
      updates.description = body.description
    }
  }

  if ('due_date' in body) {
    if (body.due_date === null) {
      updates.due_date = null
    } else if (typeof body.due_date !== 'string') {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_DUE_DATE',
            message: 'Due date must be a valid ISO 8601 date-time string',
          },
        },
        { status: 400 }
      )
    } else {
      let dueDateUtc: string
      try {
        dueDateUtc = parseDueDateToUtc(body.due_date)
      } catch {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_DUE_DATE',
              message: 'Due date must be a valid ISO 8601 date-time string',
            },
          },
          { status: 400 }
        )
      }
      // Only apply future check if due_date is explicitly present and non-null
      if (!isDueDateValid(dueDateUtc)) {
        return NextResponse.json(
          {
            error: {
              code: 'DUE_DATE_IN_PAST',
              message: 'Due date must be at least 1 minute in the future',
            },
          },
          { status: 400 }
        )
      }
      updates.due_date = dueDateUtc
    }
  }

  if ('completed' in body) {
    if (typeof body.completed !== 'boolean') {
      return NextResponse.json(
        {
          error: { code: 'INVALID_COMPLETED', message: 'completed must be a boolean' },
        },
        { status: 400 }
      )
    }
    updates.completed = body.completed ? 1 : 0
  }

  if ('priority' in body) {
    try {
      updates.priority = validatePriority(body.priority)
    } catch (err) {
      const e = err as { code: string; message: string }
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
    }
  }

  if ('recurrence' in body) {
    if (body.recurrence === null) {
      updates.recurrence = null
    } else if (
      typeof body.recurrence !== 'string' ||
      !(VALID_RECURRENCE as readonly string[]).includes(body.recurrence)
    ) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_RECURRENCE',
            message: 'Recurrence must be one of: daily, weekly, monthly, yearly',
          },
        },
        { status: 400 }
      )
    } else {
      updates.recurrence = body.recurrence
    }
  }

  if ('reminder_minutes' in body) {
    if (body.reminder_minutes === null) {
      updates.reminder_minutes = null
    } else if (
      typeof body.reminder_minutes !== 'number' ||
      !(VALID_REMINDER_MINUTES as readonly number[]).includes(body.reminder_minutes)
    ) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_REMINDER',
            message: 'Reminder must be one of: 15, 30, 60, 120, 1440, 2880, 10080 minutes',
          },
        },
        { status: 400 }
      )
    } else {
      updates.reminder_minutes = body.reminder_minutes
    }
  }

  try {
    const db = getDb()

    // Load existing todo upfront for ownership check and recurring completion logic.
    const existing = db
      .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
      .get(numericId, session.userId) as Todo | undefined

    if (!existing) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ data: existing })
    }

    // Build SET clause from the validated updates object only —
    // column names come from the hardcoded UPDATE_ALLOWLIST, never from user input
    const setClauses = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(', ')
    const values = Object.values(updates)

    db
      .prepare(`UPDATE todos SET ${setClauses} WHERE id = ? AND user_id = ?`)
      .run(...values, numericId, session.userId)

    // PRP 03 — spawn the next instance when a recurring todo is completed.
    // Guards: must be a completion (not un-completion), todo must have been active,
    // recurrence and due_date must be set.
    if (
      updates.completed === 1 &&
      existing.completed !== 1 &&
      existing.recurrence !== null &&
      existing.recurrence !== undefined &&
      existing.due_date !== null &&
      existing.due_date !== undefined
    ) {
      const next = nextDueDate(
        new Date(existing.due_date),
        existing.recurrence as RecurrencePattern
      )
      db
        .prepare(
          `INSERT INTO todos
             (user_id, title, description, due_date, priority, recurrence, reminder_minutes, last_notification_sent)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          session.userId,
          existing.title,
          existing.description,
          next.toISOString(),
          existing.priority,
          existing.recurrence,
          existing.reminder_minutes ?? null
        )
    }

    const updated = db
      .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
      .get(numericId, session.userId) as Todo

    return NextResponse.json({ data: updated })
  } catch (err) {
    console.error('PUT /api/todos/[id] error:', {
      endpoint: 'PUT /api/todos/[id]',
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/todos/[id] — delete todo (with cascade)
// ---------------------------------------------------------------------------
export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  const { id } = await params
  const numericId = validateNumericId(id)
  if (!numericId) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const db = getDb()

    // Wrap in a transaction so that the CASCADE delete to subtasks/todo_tags is atomic.
    // PRAGMA foreign_keys = ON (set at DB init) ensures ON DELETE CASCADE fires.
    // If the transaction throws, no partial deletes occur.
    const deleteTransaction = db.transaction((todoId: number, userId: number) => {
      return db.prepare('DELETE FROM todos WHERE id = ? AND user_id = ?').run(todoId, userId)
    })

    const result = deleteTransaction(numericId, session.userId)

    if (result.changes === 0) {
      // Already deleted or belongs to another user — return 404 (not silent 200)
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }

    return NextResponse.json({ data: { deleted: true } })
  } catch (err) {
    console.error('DELETE /api/todos/[id] error:', {
      endpoint: 'DELETE /api/todos/[id]',
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
