// lib/auth.ts
// JWT session management.
// getSession() reads the HTTP-only cookie and returns the verified session,
// or null if the cookie is absent or the token is invalid/expired.
// Runs only in the Node.js runtime (API routes) — never in Edge middleware.

import { cookies } from 'next/headers'
import jwt from 'jsonwebtoken'

// Fall back to a weak dev secret so the app starts without configuration.
// In production, JWT_SECRET must be set in the environment.
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-production'

export const SESSION_COOKIE_OPTIONS = {
  name: 'session',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
  path: '/',
}

export interface Session {
  userId: number
  username: string
}

/** Read and verify the session cookie. Returns null on any failure. */
export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_OPTIONS.name)?.value
  if (!token) return null

  try {
    const payload = jwt.verify(token, JWT_SECRET) as Session & { iat: number; exp: number }
    return { userId: payload.userId, username: payload.username }
  } catch {
    // Token expired, tampered, or signed with a different secret.
    return null
  }
}

/** Sign a new session token. Expires in 7 days. */
export function createSessionToken(userId: number, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '7d' })
}
