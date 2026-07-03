// app/api/subtasks/[id]/route.ts
// PUT    /api/subtasks/[id] — update completed and/or title
// DELETE /api/subtasks/[id] — delete a subtask

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { subtaskDB } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string }> }

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

/** Returns true when the subtask's parent todo belongs to userId. Cross-user access gets 404. */
function checkOwnership(subtaskId: number, userId: number): boolean {
  return subtaskDB.ownerUserId(subtaskId) === userId
}

// ---------------------------------------------------------------------------
// PUT /api/subtasks/[id] — toggle completed, update title
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
      { error: { code: 'INVALID_ID', message: 'Subtask ID must be a positive integer' } },
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

  try {
    if (!checkOwnership(numericId, session.userId)) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Subtask not found' } },
        { status: 404 }
      )
    }

    if ('completed' in body && typeof body.completed === 'boolean') {
      subtaskDB.toggle(numericId, body.completed)
    }

    if ('title' in body) {
      if (typeof body.title !== 'string' || body.title.trim().length === 0) {
        return NextResponse.json(
          { error: { code: 'EMPTY_TITLE', message: 'Title is required' } },
          { status: 400 }
        )
      }
      subtaskDB.updateTitle(numericId, body.title.trim())
    }

    return NextResponse.json({ data: { ok: true } })
  } catch (err) {
    console.error('PUT /api/subtasks/[id] error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/subtasks/[id] — remove a subtask
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
      { error: { code: 'INVALID_ID', message: 'Subtask ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    if (!checkOwnership(numericId, session.userId)) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Subtask not found' } },
        { status: 404 }
      )
    }

    subtaskDB.delete(numericId)
    return NextResponse.json({ data: { ok: true } })
  } catch (err) {
    console.error('DELETE /api/subtasks/[id] error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
