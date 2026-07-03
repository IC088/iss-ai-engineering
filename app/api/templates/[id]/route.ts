// app/api/templates/[id]/route.ts
// GET    /api/templates/[id] — read one template
// PUT    /api/templates/[id] — update a template
// DELETE /api/templates/[id] — delete a template

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import {
  templateDB,
  validatePriority,
  RECURRENCE_VALUES,
  REMINDER_MINUTES_VALUES,
} from '@/lib/db'
import type { SubtaskTemplate } from '@/lib/db'

const MAX_BODY_BYTES = 64 * 1024 // 64 KB

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
// GET /api/templates/[id]
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
      { error: { code: 'INVALID_ID', message: 'Template ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const template = templateDB.findById(numericId)
    if (!template || template.user_id !== session.userId) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Template not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: template })
  } catch (err) {
    console.error('GET /api/templates/[id] error:', {
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
// PUT /api/templates/[id]
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
      { error: { code: 'INVALID_ID', message: 'Template ID must be a positive integer' } },
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

  // --- name ---
  let name: string | undefined
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return NextResponse.json(
        { error: { code: 'NAME_REQUIRED', message: 'Template name is required' } },
        { status: 400 }
      )
    }
    const trimmed = body.name.trim()
    if (trimmed.length === 0) {
      return NextResponse.json(
        { error: { code: 'NAME_REQUIRED', message: 'Template name is required' } },
        { status: 400 }
      )
    }
    if (trimmed.length > 200) {
      return NextResponse.json(
        { error: { code: 'NAME_TOO_LONG', message: 'Template name must be 200 characters or less' } },
        { status: 400 }
      )
    }
    if (hasInvalidChars(trimmed)) {
      return NextResponse.json(
        { error: { code: 'NAME_INVALID_CHARS', message: 'Template name contains invalid characters' } },
        { status: 400 }
      )
    }
    name = trimmed
  }

  // --- category ---
  let category: string | null | undefined
  if (body.category !== undefined) {
    if (body.category !== null && typeof body.category !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_CATEGORY', message: 'Category must be a string or null' } },
        { status: 400 }
      )
    }
    if (typeof body.category === 'string') {
      const trimmed = body.category.trim()
      if (trimmed.length > 50) {
        return NextResponse.json(
          { error: { code: 'CATEGORY_TOO_LONG', message: 'Category must be 50 characters or less' } },
          { status: 400 }
        )
      }
      category = trimmed || null
    } else {
      category = null
    }
  }

  // --- priority ---
  let priority: 'high' | 'medium' | 'low' | undefined
  if (body.priority !== undefined) {
    try {
      priority = validatePriority(body.priority)
    } catch (err) {
      const e = err as { code: string; message: string }
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: 400 })
    }
  }

  // --- recurrence ---
  let recurrence: string | null | undefined
  if (body.recurrence !== undefined) {
    if (body.recurrence !== null) {
      if (
        typeof body.recurrence !== 'string' ||
        !(RECURRENCE_VALUES as readonly string[]).includes(body.recurrence)
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
    } else {
      recurrence = null
    }
  }

  // --- reminder_minutes ---
  let reminderMinutes: number | null | undefined
  if (body.reminder_minutes !== undefined) {
    if (body.reminder_minutes !== null) {
      if (
        typeof body.reminder_minutes !== 'number' ||
        !Number.isInteger(body.reminder_minutes) ||
        !(REMINDER_MINUTES_VALUES as readonly number[]).includes(body.reminder_minutes)
      ) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_REMINDER_MINUTES',
              message: 'Reminder minutes must be one of: 15, 30, 60, 120, 1440, 2880, 10080',
            },
          },
          { status: 400 }
        )
      }
      reminderMinutes = body.reminder_minutes
    } else {
      reminderMinutes = null
    }
  }

  // --- due_offset_days ---
  let dueOffsetDays: number | null | undefined
  if (body.due_offset_days !== undefined) {
    if (body.due_offset_days !== null) {
      if (
        typeof body.due_offset_days !== 'number' ||
        !Number.isInteger(body.due_offset_days) ||
        body.due_offset_days < 0 ||
        body.due_offset_days > 3650
      ) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_DUE_OFFSET_DAYS',
              message: 'Due offset days must be an integer between 0 and 3650',
            },
          },
          { status: 400 }
        )
      }
      dueOffsetDays = body.due_offset_days
    } else {
      dueOffsetDays = null
    }
  }

  // --- subtasks ---
  let subtasks: SubtaskTemplate[] | undefined
  if (body.subtasks !== undefined) {
    if (!Array.isArray(body.subtasks)) {
      return NextResponse.json(
        { error: { code: 'INVALID_SUBTASKS', message: 'Subtasks must be an array' } },
        { status: 400 }
      )
    }
    if (body.subtasks.length > 50) {
      return NextResponse.json(
        { error: { code: 'TOO_MANY_SUBTASKS', message: 'A template may have at most 50 subtasks' } },
        { status: 400 }
      )
    }
    for (const item of body.subtasks) {
      if (typeof item !== 'object' || item === null || typeof (item as Record<string, unknown>).title !== 'string') {
        return NextResponse.json(
          { error: { code: 'INVALID_SUBTASK', message: 'Each subtask must have a title string' } },
          { status: 400 }
        )
      }
      const title = ((item as Record<string, unknown>).title as string).trim()
      if (title.length === 0 || title.length > 200) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_SUBTASK_TITLE',
              message: 'Each subtask title must be 1–200 characters',
            },
          },
          { status: 400 }
        )
      }
    }
    subtasks = (body.subtasks as Array<{ title: string; position: number }>).map((item, idx) => ({
      title: (item.title as string).trim(),
      position: typeof item.position === 'number' ? item.position : idx + 1,
    }))
  }

  try {
    const updated = templateDB.update(numericId, session.userId, {
      name,
      category,
      priority,
      recurrence: recurrence as typeof recurrence,
      reminder_minutes: reminderMinutes,
      due_offset_days: dueOffsetDays,
      subtasks,
    })
    if (!updated) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Template not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: updated })
  } catch (err) {
    console.error('PUT /api/templates/[id] error:', {
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
// DELETE /api/templates/[id]
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
      { error: { code: 'INVALID_ID', message: 'Template ID must be a positive integer' } },
      { status: 400 }
    )
  }

  try {
    const deleted = templateDB.delete(numericId, session.userId)
    if (!deleted) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Template not found' } },
        { status: 404 }
      )
    }
    return NextResponse.json({ data: { id: numericId } })
  } catch (err) {
    console.error('DELETE /api/templates/[id] error:', {
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
