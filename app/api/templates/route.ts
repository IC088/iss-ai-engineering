// app/api/templates/route.ts
// GET  /api/templates — list all templates for the authenticated user
// POST /api/templates — create a new template

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import {
  templateDB,
  validatePriority,
  PRIORITY_VALUES,
  RECURRENCE_VALUES,
  REMINDER_MINUTES_VALUES,
} from '@/lib/db'
import type { SubtaskTemplate } from '@/lib/db'

const MAX_BODY_BYTES = 64 * 1024 // 64 KB

function hasInvalidChars(str: string): boolean {
  return str.includes('<') || str.includes('>') || str.includes('javascript:')
}

// ---------------------------------------------------------------------------
// GET /api/templates
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
    const templates = templateDB.list(session.userId)
    return NextResponse.json({ data: templates })
  } catch (err) {
    console.error('GET /api/templates error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}

// ---------------------------------------------------------------------------
// POST /api/templates
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
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
  if (typeof body.name !== 'string') {
    return NextResponse.json(
      { error: { code: 'NAME_REQUIRED', message: 'Template name is required' } },
      { status: 400 }
    )
  }
  const name = body.name.trim()
  if (name.length === 0) {
    return NextResponse.json(
      { error: { code: 'NAME_REQUIRED', message: 'Template name is required' } },
      { status: 400 }
    )
  }
  if (name.length > 200) {
    return NextResponse.json(
      { error: { code: 'NAME_TOO_LONG', message: 'Template name must be 200 characters or less' } },
      { status: 400 }
    )
  }
  if (hasInvalidChars(name)) {
    return NextResponse.json(
      { error: { code: 'NAME_INVALID_CHARS', message: 'Template name contains invalid characters' } },
      { status: 400 }
    )
  }

  // --- category ---
  let category: string | null = null
  if (body.category !== undefined && body.category !== null) {
    if (typeof body.category !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_CATEGORY', message: 'Category must be a string' } },
        { status: 400 }
      )
    }
    const trimmed = body.category.trim()
    if (trimmed.length > 50) {
      return NextResponse.json(
        { error: { code: 'CATEGORY_TOO_LONG', message: 'Category must be 50 characters or less' } },
        { status: 400 }
      )
    }
    category = trimmed || null
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
  }

  // --- reminder_minutes ---
  let reminderMinutes: number | null = null
  if (body.reminder_minutes !== undefined && body.reminder_minutes !== null) {
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
  }

  // --- due_offset_days ---
  let dueOffsetDays: number | null = null
  if (body.due_offset_days !== undefined && body.due_offset_days !== null) {
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
  }

  // --- subtasks ---
  let subtasks: SubtaskTemplate[] = []
  if (body.subtasks !== undefined && body.subtasks !== null) {
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
      const subtaskItem = item as Record<string, unknown>
      const title = (subtaskItem.title as string).trim()
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
    const template = templateDB.create(session.userId, {
      name,
      category,
      priority,
      recurrence: recurrence as typeof recurrence,
      reminder_minutes: reminderMinutes,
      due_offset_days: dueOffsetDays,
      subtasks,
    })
    return NextResponse.json({ data: template }, { status: 201 })
  } catch (err) {
    console.error('POST /api/templates error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
