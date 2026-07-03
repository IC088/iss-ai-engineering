// app/api/templates/[id]/use/route.ts
// POST /api/templates/[id]/use — create a new todo from a template

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, templateDB, parseSubtasks } from '@/lib/db'
import { getSingaporeNow } from '@/lib/timezone'

function validateNumericId(raw: string): number | null {
  const n = parseInt(raw, 10)
  if (isNaN(n) || n <= 0 || String(n) !== raw) return null
  return n
}

type RouteContext = { params: Promise<{ id: string }> }

// ---------------------------------------------------------------------------
// POST /api/templates/[id]/use
// ---------------------------------------------------------------------------
export async function POST(_request: NextRequest, { params }: RouteContext) {
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

    const subtaskTemplates = parseSubtasks(template.subtasks)

    // Calculate due date: now + offset_days (in milliseconds)
    let dueDateUtc: string | null = null
    if (template.due_offset_days !== null && template.due_offset_days >= 0) {
      const now = getSingaporeNow()
      const futureMs = now.getTime() + template.due_offset_days * 24 * 60 * 60 * 1000
      dueDateUtc = new Date(futureMs).toISOString()
    }

    const db = getDb()

    // Insert the todo
    const todoResult = db
      .prepare(
        `INSERT INTO todos (user_id, title, priority, recurrence, reminder_minutes, due_date)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.userId,
        template.name,
        template.priority,
        template.recurrence ?? null,
        template.reminder_minutes ?? null,
        dueDateUtc,
      )
    const todoId = todoResult.lastInsertRowid as number

    // Insert subtasks in position order
    if (subtaskTemplates.length > 0) {
      const insertSubtask = db.prepare(
        'INSERT INTO subtasks (todo_id, title, position) VALUES (?, ?, ?)'
      )
      const insertAll = db.transaction((items: typeof subtaskTemplates) => {
        for (const s of items) {
          insertSubtask.run(todoId, s.title, s.position)
        }
      })
      insertAll(subtaskTemplates)
    }

    const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(todoId)
    return NextResponse.json({ data: todo }, { status: 201 })
  } catch (err) {
    console.error('POST /api/templates/[id]/use error:', {
      id,
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
