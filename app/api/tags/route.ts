// app/api/tags/route.ts
// GET  /api/tags — list all tags for the authenticated user, each with todoCount
// POST /api/tags — create a new tag. Body: { name, color }. 409 on duplicate name.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { tagDB, validateTagName, validateTagColor } from '@/lib/db'

// ---------------------------------------------------------------------------
// GET /api/tags
// ---------------------------------------------------------------------------
export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  try {
    const tags = tagDB.list(session.userId)
    return NextResponse.json({ data: tags })
  } catch (err) {
    console.error('GET /api/tags error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// POST /api/tags
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
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

  // --- name ---
  let name: string
  try {
    name = validateTagName(body.name)
  } catch (err) {
    const e = err as { code: string; message: string }
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
  }

  // --- color ---
  let color: string
  try {
    color = validateTagColor(body.color)
  } catch (err) {
    const e = err as { code: string; message: string }
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
  }

  // --- duplicate check (case-insensitive) ---
  const existing = tagDB.findByName(session.userId, name)
  if (existing) {
    return NextResponse.json(
      {
        error: {
          code: 'DUPLICATE_TAG_NAME',
          message: `A tag named "${existing.name}" already exists`,
          existingTag: existing,
        },
      },
      { status: 409 }
    )
  }

  try {
    const tag = tagDB.create(session.userId, name, color)
    return NextResponse.json({ data: tag }, { status: 201 })
  } catch (err) {
    // Handle race-condition duplicate (UNIQUE index fires before app-level check resolves)
    const message = err instanceof Error ? err.message : ''
    if (message.includes('UNIQUE') || message.includes('unique')) {
      const dupe = tagDB.findByName(session.userId, name)
      return NextResponse.json(
        {
          error: {
            code: 'DUPLICATE_TAG_NAME',
            message: `A tag named "${dupe?.name ?? name}" already exists`,
            existingTag: dupe ?? null,
          },
        },
        { status: 409 }
      )
    }
    console.error('POST /api/tags error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
