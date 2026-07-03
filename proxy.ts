// proxy.ts (formerly middleware.ts — renamed for Next.js 16)
// Protects / and /calendar routes by checking for a session cookie.
// Full JWT verification happens in individual API route handlers (lib/auth.ts).
// Runs in the Next.js Edge Runtime — cannot use jsonwebtoken or better-sqlite3 here.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

const PROTECTED_PATHS = ['/', '/calendar']

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  const isProtected = PROTECTED_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )

  if (!isProtected) {
    return NextResponse.next()
  }

  // Lightweight presence check only — API routes do full JWT verification
  const token = request.cookies.get('session')?.value
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/', '/calendar', '/calendar/:path*'],
}
