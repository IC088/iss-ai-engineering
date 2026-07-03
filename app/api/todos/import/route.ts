// app/api/todos/import/route.ts
// POST /api/todos/import — import a previously exported JSON document

import { NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { importUserData } from '@/lib/db'

const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5 MB

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
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Import file exceeds 5 MB limit' } },
      { status: 413 }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' } },
      { status: 400 }
    )
  }

  try {
    const counts = importUserData(session.userId, body)
    return NextResponse.json({ imported: counts })
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const e = err as { code: string; errors?: string[] }
      if (e.code === 'VALIDATION_ERROR') {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Import validation failed',
              errors: e.errors ?? [],
            },
          },
          { status: 400 }
        )
      }
    }
    return NextResponse.json(
      { error: { code: 'IMPORT_FAILED', message: 'Import failed due to a server error' } },
      { status: 500 }
    )
  }
}
