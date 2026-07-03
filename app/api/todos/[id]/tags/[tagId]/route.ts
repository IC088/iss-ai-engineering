// app/api/todos/[id]/tags/[tagId]/route.ts
// DELETE /api/todos/[id]/tags/[tagId] — detach a single tag from a todo

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, tagDB } from '@/lib/db'
import type { Todo } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string; tagId: string }> }

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

// ---------------------------------------------------------------------------
// DELETE /api/todos/[id]/tags/[tagId]
// ---------------------------------------------------------------------------
export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  const { id, tagId } = await params

  const todoId = validateNumericId(id)
  if (!todoId) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Todo ID must be a positive integer' } },
      { status: 400 }
    )
  }

  const numericTagId = validateNumericId(tagId)
  if (!numericTagId) {
    return NextResponse.json(
      { error: { code: 'INVALID_TAG_ID', message: 'Tag ID must be a positive integer' } },
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

    tagDB.detachTag(todoId, numericTagId)
    return NextResponse.json({ data: { detached: true } })
  } catch (err) {
    console.error('DELETE /api/todos/[id]/tags/[tagId] error:', {
      id,
      tagId,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
