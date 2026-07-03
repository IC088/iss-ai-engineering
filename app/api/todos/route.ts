// app/api/todos/route.ts
// POST /api/todos — create a todo
// GET  /api/todos — list all todos (optional ?priority= filter, PRP 02)
// TODO(PRP-11): add per-session rate limiting once authentication is complete

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, validatePriority, PRIORITY_VALUES } from '@/lib/db'
import type { Todo } from '@/lib/db'
import { parseDueDateToUtc, isDueDateValid } from '@/lib/timezone'

const MAX_BODY_BYTES = 64 * 1024 // 64 KB

const CREATE_ALLOWLIST = [
  'title',
  'description',
  'due_date',
  'priority',
  'recurrence',
  'reminder_minutes',
] as const

const VALID_RECURRENCE = ['daily', 'weekly', 'monthly', 'yearly'] as const
const VALID_REMINDER_MINUTES = [15, 30, 60, 120, 1440, 2880, 10080] as const

function hasInvalidChars(str: string): boolean {
  return str.includes('<') || str.includes('>') || str.includes('javascript:')
}

// ---------------------------------------------------------------------------
// POST /api/todos — create a todo
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  // Body size guard
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

  // Unknown field rejection
  const unknownKeys = Object.keys(body).filter(
    (k) => !(CREATE_ALLOWLIST as readonly string[]).includes(k)
  )
  if (unknownKeys.length > 0) {
    return NextResponse.json(
      { error: { code: 'UNKNOWN_FIELDS', message: `Unknown fields: ${unknownKeys.join(', ')}` } },
      { status: 400 }
    )
  }

  // --- title ---
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

  // --- description ---
  let description: string | null = null
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_DESCRIPTION', message: 'Description must be a string' } },
        { status: 400 }
      )
    }
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
    description = body.description
  }

  // --- due_date ---
  let dueDateUtc: string | null = null
  if (body.due_date !== undefined && body.due_date !== null) {
    if (typeof body.due_date !== 'string') {
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
  }

  // --- priority ---
  let priority: 'high' | 'medium' | 'low'
  try {
    priority = validatePriority(body.priority)
  } catch (err) {
    const e = err as { code: string; message: string }
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
  }

  // --- recurrence ---
  let recurrence: string | null = null
  if (body.recurrence !== undefined && body.recurrence !== null) {
    if (
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
    }
    recurrence = body.recurrence
  }

  // --- reminder_minutes ---
  let reminderMinutes: number | null = null
  if (body.reminder_minutes !== undefined && body.reminder_minutes !== null) {
    if (
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
    }
    reminderMinutes = body.reminder_minutes
  }

  try {
    const db = getDb()
    const stmt = db.prepare(`
      INSERT INTO todos (user_id, title, description, due_date, priority, recurrence, reminder_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const result = stmt.run(
      session.userId,
      title,
      description,
      dueDateUtc,
      priority,
      recurrence,
      reminderMinutes
    )
    const todo = db
      .prepare('SELECT * FROM todos WHERE id = ?')
      .get(result.lastInsertRowid) as Todo

    return NextResponse.json({ data: todo }, { status: 201 })
  } catch (err) {
    console.error('POST /api/todos error:', {
      endpoint: 'POST /api/todos',
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// GET /api/todos — list todos (optional ?priority= filter, PRP 02)
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  // PRP 02: validate optional ?priority= query parameter
  const url = new URL(request.url)
  const priorityParam = url.searchParams.get('priority')

  let priorityFilter: string | null = null
  if (priorityParam !== null) {
    if (!(PRIORITY_VALUES as string[]).includes(priorityParam)) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_PRIORITY',
            message: 'Priority must be one of: high, medium, low',
          },
        },
        { status: 400 }
      )
    }
    priorityFilter = priorityParam
  }

  try {
    const db = getDb()
    // Priority column name is hardcoded — never interpolated from user input
    // Priority filter value is bound as a parameter
    const stmt = priorityFilter
      ? db.prepare(
          'SELECT * FROM todos WHERE user_id = ? AND priority = ? ORDER BY created_at DESC'
        )
      : db.prepare('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC')

    const todos = priorityFilter
      ? (stmt.all(session.userId, priorityFilter) as Todo[])
      : (stmt.all(session.userId) as Todo[])

    return NextResponse.json({ data: todos })
  } catch (err) {
    console.error('GET /api/todos error:', {
      endpoint: 'GET /api/todos',
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
