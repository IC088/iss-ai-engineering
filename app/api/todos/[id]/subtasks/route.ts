// app/api/todos/[id]/subtasks/route.ts
// GET  /api/todos/[id]/subtasks — list subtasks for a todo
// POST /api/todos/[id]/subtasks — add a subtask to a todo

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, subtaskDB } from '@/lib/db'

const MAX_BODY_BYTES = 4 * 1024

type RouteContext = { params: Promise<{ id: string }> }

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

// ---------------------------------------------------------------------------
// GET /api/todos/[id]/subtasks — list subtasks ordered by position
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
    const parentTodo = db
      .prepare('SELECT id FROM todos WHERE id = ? AND user_id = ?')
      .get(numericId, session.userId)
    if (!parentTodo) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: subtaskDB.listByTodo(numericId) })
  } catch (err) {
    console.error('GET /api/todos/[id]/subtasks error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// POST /api/todos/[id]/subtasks — create a subtask
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest, { params }: RouteContext) {
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
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } },
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

  if (typeof body.title !== 'string') {
    return NextResponse.json(
      { error: { code: 'EMPTY_TITLE', message: 'Title is required' } },
      { status: 400 }
    )
  }
  const title = body.title.trim()
  if (title.length === 0) {
    return NextResponse.json(
      { error: { code: 'EMPTY_TITLE', message: 'Title is required' } },
      { status: 400 }
    )
  }
  if (title.length > 200) {
    return NextResponse.json(
      { error: { code: 'TITLE_TOO_LONG', message: 'Title must be 200 characters or less' } },
      { status: 400 }
    )
  }

  try {
    const db = getDb()
    // Ownership check: parent todo must belong to this user
    const parentTodo = db
      .prepare('SELECT id FROM todos WHERE id = ? AND user_id = ?')
      .get(numericId, session.userId)
    if (!parentTodo) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }

    const subtask = subtaskDB.create(numericId, title)
    return NextResponse.json({ data: subtask }, { status: 201 })
  } catch (err) {
    console.error('POST /api/todos/[id]/subtasks error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
