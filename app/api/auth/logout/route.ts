// app/api/auth/logout/route.ts
import { NextResponse } from 'next/server'

export async function POST() {
  const response = NextResponse.json({ data: { loggedOut: true } })
  response.cookies.set('session', '', {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0, // expire immediately
  })
  return response
}
