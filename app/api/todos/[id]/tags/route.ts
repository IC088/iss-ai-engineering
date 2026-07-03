// app/api/todos/[id]/tags/route.ts
// GET  /api/todos/[id]/tags       — list tags attached to a specific todo
// POST /api/todos/[id]/tags       — attach one or more tags to a todo. Body: { tagIds: number[] }

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, tagDB } from '@/lib/db'
import type { Todo } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string }> }

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

// ---------------------------------------------------------------------------
// GET /api/todos/[id]/tags
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
  const todoId = validateNumericId(id)
  if (!todoId) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const db = getDb()
    const todo = db
      .prepare('SELECT id FROM todos WHERE id = ? AND user_id = ?')
      .get(todoId, session.userId) as Pick<Todo, 'id'> | undefined
    if (!todo) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }

    const tags = tagDB.listForTodo(todoId, session.userId)
    return NextResponse.json({ data: tags })
  } catch (err) {
    console.error('GET /api/todos/[id]/tags error:', {
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
// POST /api/todos/[id]/tags
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
  const todoId = validateNumericId(id)
  if (!todoId) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } },
      { status: 400 }
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

  if (!Array.isArray(body.tagIds)) {
    return NextResponse.json(
      { error: { code: 'INVALID_TAG_IDS', message: 'tagIds must be an array of integers' } },
      { status: 400 }
    )
  }

  const tagIds = body.tagIds as unknown[]
  if (tagIds.some((id) => typeof id !== 'number' || !Number.isInteger(id) || (id as number) <= 0)) {
    return NextResponse.json(
      { error: { code: 'INVALID_TAG_IDS', message: 'Each tagId must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const db = getDb()
    // Verify todo ownership
    const todo = db
      .prepare('SELECT id FROM todos WHERE id = ? AND user_id = ?')
      .get(todoId, session.userId) as Pick<Todo, 'id'> | undefined
    if (!todo) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Todo not found' } },
        { status: 404 }
      )
    }

    // Verify all tagIds exist and belong to this user
    for (const tagId of tagIds as number[]) {
      const tag = tagDB.findById(tagId, session.userId)
      if (!tag) {
        return NextResponse.json(
          { error: { code: 'TAG_NOT_FOUND', message: `Tag ${tagId} not found` } },
          { status: 404 }
        )
      }
    }

    tagDB.attachTags(todoId, tagIds as number[])
    const updatedTags = tagDB.listForTodo(todoId, session.userId)
    return NextResponse.json({ data: updatedTags })
  } catch (err) {
    console.error('POST /api/todos/[id]/tags error:', {
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
