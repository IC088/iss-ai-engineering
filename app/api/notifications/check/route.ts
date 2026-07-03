// app/api/notifications/check/route.ts
// GET /api/notifications/check
// Returns todos whose reminder window is currently open and that have not yet been notified.
// Stamps last_notification_sent for each match so it fires exactly once per window.

import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb } from '@/lib/db'
import type { Todo } from '@/lib/db'
import { getSingaporeNow, isDueForNotification } from '@/lib/timezone'

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  try {
    const db = getDb()
    const now = getSingaporeNow()

    // Load incomplete todos with both due_date and reminder_minutes set.
    // completed=0 guard here keeps the result set small; isDueForNotification re-checks.
    const candidates = db
      .prepare(
        `SELECT * FROM todos
         WHERE user_id = ? AND completed = 0
           AND due_date IS NOT NULL
           AND reminder_minutes IS NOT NULL`
      )
      .all(session.userId) as Todo[]

    const due = candidates.filter((t) =>
      isDueForNotification(
        now,
        t.due_date,
        t.reminder_minutes,
        t.last_notification_sent,
        t.completed,
      )
    )

    if (due.length > 0) {
      const stamp = now.toISOString()
      const updateStmt = db.prepare(
        'UPDATE todos SET last_notification_sent = ? WHERE id = ?'
      )
      // Stamp all matches atomically; better-sqlite3 is synchronous so no interleaving.
      const stampAll = db.transaction((todos: Todo[]) => {
        for (const t of todos) {
          updateStmt.run(stamp, t.id)
        }
      })
      stampAll(due)
    }

    return NextResponse.json({ data: due })
  } catch (err) {
    console.error('GET /api/notifications/check error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
