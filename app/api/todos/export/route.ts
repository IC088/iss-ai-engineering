// app/api/todos/export/route.ts
// GET /api/todos/export — download all user data as a JSON attachment

import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { exportUserData } from '@/lib/db'

export async function GET() {
  const session = await getSession()
  if (!session) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  const data = exportUserData(session.userId)

  // Build date string in SGT for the filename (YYYY-MM-DD)
  const sgtDate = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const dateStr = `${sgtDate.getUTCFullYear()}-${pad(sgtDate.getUTCMonth() + 1)}-${pad(sgtDate.getUTCDate())}`
  const filename = `todos-export-${dateStr}.json`

  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
