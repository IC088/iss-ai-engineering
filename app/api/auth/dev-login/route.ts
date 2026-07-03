// app/api/auth/dev-login/route.ts
// Development/test authentication endpoint.
// Creates the user if they don't exist, then issues a JWT session cookie.
// PRP 11 (WebAuthn) will replace this with proper passkey-based authentication.

import { NextRequest, NextResponse } from 'next/server'
import { findOrCreateUser } from '@/lib/db'
import { createSessionToken, SESSION_COOKIE_OPTIONS } from '@/lib/auth'

const MAX_BODY_BYTES = 4 * 1024 // 4 KB — login body doesn't need the full 64 KB limit

export async function POST(request: NextRequest) {
  const contentLength = request.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } },
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

  const rawUsername = body.username
  if (typeof rawUsername !== 'string') {
    return NextResponse.json(
      { error: { code: 'USERNAME_REQUIRED', message: 'Username is required' } },
      { status: 400 }
    )
  }

  const username = rawUsername.trim()
  if (username.length === 0) {
    return NextResponse.json(
      { error: { code: 'USERNAME_REQUIRED', message: 'Username is required' } },
      { status: 400 }
    )
  }
  if (username.length > 50) {
    return NextResponse.json(
      { error: { code: 'USERNAME_TOO_LONG', message: 'Username must be 50 characters or less' } },
      { status: 400 }
    )
  }

  try {
    const user = findOrCreateUser(username)
    const token = createSessionToken(user.id, user.username)

    const response = NextResponse.json({ data: { userId: user.id, username: user.username } })
    response.cookies.set(SESSION_COOKIE_OPTIONS.name, token, {
      httpOnly: SESSION_COOKIE_OPTIONS.httpOnly,
      sameSite: SESSION_COOKIE_OPTIONS.sameSite,
      path: SESSION_COOKIE_OPTIONS.path,
      maxAge: SESSION_COOKIE_OPTIONS.maxAge,
      secure: SESSION_COOKIE_OPTIONS.secure,
    })
    return response
  } catch (err) {
    console.error('POST /api/auth/dev-login error:', {
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
      { status: 500 }
    )
  }
}
