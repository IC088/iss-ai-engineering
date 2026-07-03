// app/api/calendar/route.ts
// GET /api/calendar?year=YYYY&month=MM
// Returns todos with due_date in the given SGT month, plus Singapore public holidays.

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getDb, holidayDB } from '@/lib/db'
import type { Todo } from '@/lib/db'
import { getMonthBoundsUtc } from '@/lib/timezone'

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  const { searchParams } = request.nextUrl
  const yearStr = searchParams.get('year')
  const monthStr = searchParams.get('month')

  if (!yearStr || !monthStr) {
    return NextResponse.json(
      { error: { code: 'MISSING_PARAMS', message: 'year and month query parameters are required' } },
      { status: 400 }
    )
  }

  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)

  if (isNaN(year) || year < 2000 || year > 2100 || String(year) !== yearStr) {
    return NextResponse.json(
      { error: { code: 'INVALID_YEAR', message: 'year must be an integer between 2000 and 2100' } },
      { status: 400 }
    )
  }

  if (isNaN(month) || month < 1 || month > 12 || String(month) !== monthStr) {
    return NextResponse.json(
      { error: { code: 'INVALID_MONTH', message: 'month must be an integer between 1 and 12' } },
      { status: 400 }
    )
  }

  const { startUtc, endUtc } = getMonthBoundsUtc(year, month)

  const db = getDb()
  const todos = db
    .prepare('SELECT * FROM todos WHERE user_id = ? AND due_date >= ? AND due_date < ?')
    .all(session.userId, startUtc, endUtc) as Todo[]

  const holidays = holidayDB.listByMonth(year, month)

  return NextResponse.json({ todos, holidays })
}
