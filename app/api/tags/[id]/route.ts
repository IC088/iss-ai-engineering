// app/api/tags/[id]/route.ts
// PUT    /api/tags/[id] — rename and/or recolor a tag. Body: { name?, color? }
// DELETE /api/tags/[id] — delete a tag (cascades to todo_tags)

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { tagDB, validateTagName, validateTagColor } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string }> }

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

// ---------------------------------------------------------------------------
// PUT /api/tags/[id]
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
      { error: { code: 'INVALID_ID', message: 'Tag ID must be a positive integer' } },
      { status: 400 }
    )
  }

  const tag = tagDB.findById(numericId, session.userId)
  if (!tag) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Tag not found' } },
      { status: 404 }
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

  // At least one field must be present
  if (body.name === undefined && body.color === undefined) {
    return NextResponse.json(
      { error: { code: 'NO_FIELDS', message: 'Provide at least one of: name, color' } },
      { status: 400 }
    )
  }

  // --- name (optional) ---
  let name: string | undefined
  if (body.name !== undefined) {
    try {
      name = validateTagName(body.name)
    } catch (err) {
      const e = err as { code: string; message: string }
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
    }

    // Case-insensitive duplicate check (excluding this tag's own id)
    const conflict = tagDB.findByName(session.userId, name, numericId)
    if (conflict) {
      return NextResponse.json(
        {
          error: {
            code: 'DUPLICATE_TAG_NAME',
            message: `A tag named "${conflict.name}" already exists`,
            existingTag: conflict,
          },
        },
        { status: 409 }
      )
    }
  }

  // --- color (optional) ---
  let color: string | undefined
  if (body.color !== undefined) {
    try {
      color = validateTagColor(body.color)
    } catch (err) {
      const e = err as { code: string; message: string }
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
    }
  }

  try {
    const updated = tagDB.update(numericId, session.userId, { name, color })
    if (!updated) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Tag not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (message.includes('UNIQUE') || message.includes('unique')) {
      return NextResponse.json(
        {
          error: {
            code: 'DUPLICATE_TAG_NAME',
            message: `A tag named "${name}" already exists`,
          },
        },
        { status: 409 }
      )
    }
    console.error('PUT /api/tags/[id] error:', {
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
// DELETE /api/tags/[id]
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
      { error: { code: 'INVALID_ID', message: 'Tag ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const deleted = tagDB.delete(numericId, session.userId)
    if (!deleted) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Tag not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: { deleted: true } })
  } catch (err) {
    console.error('DELETE /api/tags/[id] error:', {
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
