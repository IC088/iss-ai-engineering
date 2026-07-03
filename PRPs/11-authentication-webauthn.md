# PRP 11 — Authentication (WebAuthn/Passkeys)

> **Infrastructure PRP — retrofits onto all prior features.**
> PRPs 01–10 already call `session.userId` via `getSession()` and return `401 UNAUTHORIZED` using the shared `ApiError` envelope. This PRP implements that contract exactly. Nothing in PRPs 01–10's route handlers changes except the removal of `// TODO(PRP-11)` comments once rate limiting is wired up (see §4.6).

---

## 1. Feature Overview

Authentication is the gate that all other features stand behind. Every API route from PRP 01 onwards opens with `const session = await getSession(); if (!session) return 401` — this PRP provides the implementation of that call. The mechanism is **WebAuthn/Passkeys**: a phishing-resistant, passwordless authentication standard in which the private key never leaves the user's device. The server stores only a public key and a counter; it never holds a password or a plaintext secret.

The implementation uses `@simplewebauthn/server` on the server and `@simplewebauthn/browser` on the client. Sessions are represented as JWTs stored in HTTP-only cookies for stateless verification, with a server-side `sessions` table for proper revocation on logout. Challenges (the ephemeral nonces exchanged during registration and authentication) are stored in a `webauthn_challenges` table with a 5-minute TTL and single-use enforcement, preventing replay attacks.

---

## 2. User Stories

### Persona A — New User (First Device Registration)
> *"I've never used this app. I want to create an account using my laptop's fingerprint reader. I shouldn't need to invent or remember a password."*

- As a new visitor, I can register a passkey by entering a username and authenticating with my device's biometric so that an account is created and I am immediately logged in.
- As a new user, I receive a clear error if my browser or device does not support WebAuthn (e.g. a headless browser or old OS), so I'm not left with a broken form.

### Persona B — Returning User (Login on Known Device)
> *"I registered yesterday. I want to log back in on the same laptop with one tap — not re-enter anything."*

- As a returning user, I can log in by selecting my username and confirming with my device authenticator so that I reach my todo list in under 5 seconds.
- As a returning user, if I log in on a second device that has synced my passkey (iCloud Keychain, Google Password Manager), I am authenticated without additional setup.
- As a returning user, if I log out, my session is invalidated server-side so that clearing my browser cookies would not re-admit me.

---

## 3. User Flow

### 3.1 Registration Flow

1. New user navigates to `/login` (unauthenticated; the proxy redirects any protected path here).
2. User sees two sections: "Register" (for new accounts) and "Sign In" (for existing).
3. User enters a desired **username** in the registration form (1–50 chars, alphanumeric + hyphens/underscores).
4. User clicks **"Register with Passkey"**.
5. Client calls `POST /api/auth/register-options` with `{ username }`.
6. Server generates a registration challenge (32 random bytes, base64url-encoded), stores it in `webauthn_challenges` with `type = 'registration'`, `username`, and `expires_at = now + 5 minutes`, and returns `PublicKeyCredentialCreationOptions`.
7. Client calls `startRegistration(options)` from `@simplewebauthn/browser`, which triggers the browser's WebAuthn prompt (biometric, PIN, or security key).
8. On user approval, the browser returns a `RegistrationResponseJSON`.
9. Client calls `POST /api/auth/register-verify` with `{ username, response: RegistrationResponseJSON }`.
10. Server:
    a. Looks up the challenge by username in `webauthn_challenges`. If expired or already used, returns 400.
    b. Calls `verifyRegistrationResponse()` with `rpID`, `expectedOrigin`, and `expectedChallenge` from the stored row. Never trusts these from the client.
    c. Marks the challenge row `used_at = now` (single-use enforcement).
    d. If verification succeeds: creates the `users` row (if username not taken), creates the `authenticators` row with the verified credential data, creates a `sessions` row, issues a JWT cookie containing `{ userId, username, jti: sessionId }`.
    e. Returns 201 with `{ data: { userId, username } }`.
11. Client is redirected to `/` (or to the originally requested path if the registration was triggered by a redirect).

### 3.2 Login Flow

1. Returning user is on `/login`.
2. User enters their **username** in the "Sign In" form and clicks **"Sign In with Passkey"**.
3. Client calls `POST /api/auth/login-options` with `{ username }`.
4. Server generates an authentication challenge, stores it in `webauthn_challenges` with `type = 'authentication'` and a user lookup, returns `PublicKeyCredentialRequestOptions` (including the list of `allowCredentials` from the user's registered authenticators).
5. Client calls `startAuthentication(options)` from `@simplewebauthn/browser`.
6. On user approval, the browser returns an `AuthenticationResponseJSON`.
7. Client calls `POST /api/auth/login-verify` with `{ username, response: AuthenticationResponseJSON }`.
8. Server:
    a. Looks up the challenge. If expired or used, returns 400 with a generic error.
    b. Looks up the user and the matching authenticator by `credentialId`. If not found, returns 400 with the **same generic error** as step (a) to prevent username enumeration.
    c. Calls `verifyAuthenticationResponse()` with server-configured `rpID`, `expectedOrigin`, and `expectedChallenge`.
    d. Marks the challenge `used_at = now`.
    e. Validates that the returned `newCounter > authenticator.counter`. If not (counter stale or reset), rejects with 400 and logs a security warning — **does not silently accept**.
    f. Updates `authenticators.counter` with `newCounter`.
    g. Creates a `sessions` row, issues a JWT cookie.
    h. Returns 200 with `{ data: { userId, username } }`.
9. Client is redirected to `/` (or to the originally requested path preserved in session storage).

### 3.3 Logout

1. User clicks **"Logout"** button (visible in the app header on all protected pages).
2. Client calls `POST /api/auth/logout`.
3. Server reads the `jti` from the JWT, calls `deleteSession(jti)` to delete the row from `sessions`.
4. Server clears the session cookie by setting `Max-Age=0`.
5. Returns 200 `{ data: { loggedOut: true } }`.
6. Client redirects to `/login`.

### 3.4 Session Expiry and Redirect

- The JWT has `expiresIn: '7d'`. After 7 days (or after logout), `getSession()` returns `null`.
- Protected API routes immediately return `401 UNAUTHORIZED` (existing `ApiError` envelope).
- Protected page routes: the proxy detects the absent/expired cookie and redirects to `/login?next=<original-path>`.
- The `/login` page reads `?next=` from the URL and uses it as the post-authentication redirect target. If absent, redirects to `/`.

---

## 4. Technical Requirements

### 4.1 Database Schema

All operations use `getDb()` from `lib/db.ts` (synchronous, better-sqlite3). Execute these at DB initialization alongside the existing `todos`, `users`, etc. tables.

```sql
-- Users table (already exists from PRP 01 scaffold — add the display_name column)
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT    NOT NULL UNIQUE,        -- 1–50 chars, alphanumeric/hyphen/underscore
  display_name TEXT,                           -- optional friendly display name
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Authenticators: one user can register multiple devices
CREATE TABLE IF NOT EXISTS authenticators (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id   TEXT    NOT NULL UNIQUE,  -- base64url-encoded; UNIQUE enforces no duplicate device registration
  public_key      TEXT    NOT NULL,         -- base64url-encoded CBOR public key (from @simplewebauthn/server)
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,                     -- JSON array of AuthenticatorTransport strings, nullable
  device_name     TEXT,                     -- user-readable label, e.g. "iPhone 15 Face ID"; nullable, set by client hint
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_authenticators_user_id ON authenticators(user_id);

-- Sessions: server-side session store for proper revocation
-- The JWT contains `jti` = sessions.id so revocation is O(1) via primary key lookup.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,   -- high-entropy random (crypto.randomUUID()), this is the JWT jti claim
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT    NOT NULL       -- ISO 8601 UTC; checked by getSession() in addition to JWT exp
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- WebAuthn challenges: single-use, 5-minute TTL
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         TEXT    PRIMARY KEY,              -- UUID (not the challenge itself; used to correlate client requests)
  challenge  TEXT    NOT NULL UNIQUE,          -- base64url-encoded 32-byte random value
  type       TEXT    NOT NULL,                 -- 'registration' | 'authentication'
  user_id    INTEGER,                          -- NULL during initial registration before user exists
  username   TEXT,                             -- used during registration to find/create the user in register-verify
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT    NOT NULL,                 -- created_at + 5 minutes
  used_at    TEXT                              -- NULL = unused; set to now on first use; non-null = replayed
);
```

**Migration guards** (wrap each in try-catch, consistent with existing pattern):
```typescript
try { db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`) } catch { /* exists */ }
```
All other tables use `CREATE TABLE IF NOT EXISTS`, so they are inherently idempotent.

**Cascade cleanup** — expired and used challenges accumulate silently. Add a cleanup step to DB initialization:
```typescript
// Run at startup — purge challenges older than 24 hours (already expired or used)
db.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < ?`)
  .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
```

### 4.2 Environment Variables

These must be set in `.env.local` (development) and the production environment. The app must throw an error at startup if they are missing in production:

| Variable | Purpose | Example |
|---|---|---|
| `JWT_SECRET` | Signs/verifies JWT session tokens; must be ≥ 32 random bytes | `openssl rand -hex 32` |
| `WEBAUTHN_RP_ID` | WebAuthn Relying Party ID; must be the domain (no scheme/port) | `localhost` (dev), `app.example.com` (prod) |
| `WEBAUTHN_RP_NAME` | Human-readable RP name shown in browser prompts | `Todo App` |
| `WEBAUTHN_ORIGIN` | Expected origin for WebAuthn verification; must match the actual request origin | `http://localhost:3000` (dev), `https://app.example.com` (prod) |

```typescript
// lib/webauthn-config.ts — fail fast if config is missing in production
export function getWebAuthnConfig(): { rpID: string; rpName: string; expectedOrigin: string } {
  const rpID = process.env.WEBAUTHN_RP_ID
  const rpName = process.env.WEBAUTHN_RP_NAME
  const expectedOrigin = process.env.WEBAUTHN_ORIGIN

  if (!rpID || !rpName || !expectedOrigin) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('WEBAUTHN_RP_ID, WEBAUTHN_RP_NAME, and WEBAUTHN_ORIGIN must be set in production')
    }
    // Development fallback — safe only for localhost
    return {
      rpID: rpID ?? 'localhost',
      rpName: rpName ?? 'Todo App (Dev)',
      expectedOrigin: expectedOrigin ?? 'http://localhost:3000',
    }
  }
  return { rpID, rpName, expectedOrigin }
}
```

### 4.3 `lib/auth.ts` — Updated Signatures

The `Session` interface and `getSession()` signature are **unchanged** — PRPs 01–10 route handlers require no modification. The internal implementation gains a DB session lookup for revocation support.

```typescript
// lib/auth.ts (PRP 11 final form)

// ----- Types (unchanged from PRP 01 scaffold) -----

export interface Session {
  userId: number    // <-- exact field name used by all PRPs 01-10 routes
  username: string
}

// ----- getSession() (unchanged signature, enhanced implementation) -----

/**
 * Reads the session cookie, verifies the JWT, then confirms the session
 * has not been revoked (jti present in `sessions` table, not expired).
 * Returns null on any failure — never throws.
 * Called by every API route handler in PRPs 01–10 and 11.
 */
export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_OPTIONS.name)?.value
  if (!token) return null

  let payload: Session & { jti: string; exp: number }
  try {
    payload = jwt.verify(token, JWT_SECRET) as Session & { jti: string; exp: number }
  } catch {
    return null // expired, tampered, or wrong key
  }

  // Server-side revocation check: confirm session row still exists and is not past expires_at
  try {
    const db = getDb()
    const row = db.prepare(
      'SELECT id FROM sessions WHERE id = ? AND user_id = ? AND expires_at > ?'
    ).get(payload.jti, payload.userId, new Date().toISOString()) as { id: string } | undefined
    if (!row) return null
  } catch {
    return null
  }

  return { userId: payload.userId, username: payload.username }
}

// ----- createSession() (replaces createSessionToken) -----

/**
 * Creates a server-side session row and returns the signed JWT token.
 * The JWT contains `jti` (the session ID), `userId`, and `username`.
 * Session expires in 7 days. Sets cookie via the response object.
 *
 * Call this after a successful WebAuthn register-verify or login-verify.
 */
export function createSession(userId: number, username: string): string {
  const db = getDb()
  const sessionId = crypto.randomUUID() // high-entropy, non-sequential
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    sessionId, userId, expiresAt
  )

  return jwt.sign({ userId, username, jti: sessionId }, JWT_SECRET, { expiresIn: '7d' })
}

// ----- deleteSession() (new in PRP 11) -----

/**
 * Invalidates the server-side session by deleting the sessions row.
 * A cleared cookie alone does not constitute logout — the server-side
 * record must be removed so a reused token (e.g. from history/cache) is rejected.
 *
 * @param sessionId  The `jti` claim from the JWT (extracted before calling this).
 */
export function deleteSession(sessionId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

// ----- getSessionId() (helper for logout) -----

/**
 * Decodes the JWT without verifying (useful when we want to extract jti even
 * from an expired token at logout time). Returns null if the token is not
 * a valid JWT structure.
 */
export function getSessionIdFromToken(token: string): string | null {
  try {
    const decoded = jwt.decode(token) as { jti?: string } | null
    return decoded?.jti ?? null
  } catch {
    return null
  }
}

// ----- Session cookie options (unchanged from PRP 01 scaffold) -----

export const SESSION_COOKIE_OPTIONS = {
  name: 'session',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,   // See §4.3 note on SameSite
  maxAge: 7 * 24 * 60 * 60,  // 7 days in seconds
  path: '/',
} as const
```

**SameSite rationale**: `Lax` (not `Strict`) is chosen because `Strict` would strip the cookie on first navigation from an external link (e.g. clicking a todo link shared by a colleague would land the user on `/login`). `Lax` still blocks cross-site POST/PUT/DELETE requests, which covers the primary CSRF risk. If a future feature requires cross-site cookie transmission, document that explicitly and add CSRF tokens.

### 4.4 `proxy.ts` — Updated Route Protection

The proxy runs in the **Edge Runtime** and cannot use `better-sqlite3` or `jsonwebtoken`. It performs a lightweight check (cookie presence) for browser page routes and adds API route protection with a `401` response.

```typescript
// proxy.ts (PRP 11 final form)

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Browser page routes: redirect unauthenticated users to /login, preserving ?next=
const PROTECTED_PAGE_PATHS = ['/', '/calendar']

// API route prefixes: return 401 ApiError for unauthenticated requests
// (actual JWT/session verification happens inside each route handler via getSession())
const PROTECTED_API_PREFIXES = ['/api/todos', '/api/notifications', '/api/templates', '/api/tags']

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl
  const token = request.cookies.get('session')?.value

  // API routes: return the existing ApiError 401 shape (not a redirect)
  const isProtectedApi = PROTECTED_API_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )
  if (isProtectedApi && !token) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 }
    )
  }

  // Page routes: redirect to /login, preserving the originally requested path
  const isProtectedPage = PROTECTED_PAGE_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  )
  if (isProtectedPage && !token) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

**Note**: The proxy only checks cookie presence (Edge Runtime constraint). Full JWT signature verification and session DB lookup happen inside each API route handler via `getSession()`. A present-but-invalid token will pass the proxy and be rejected at the route handler level with a 401.

### 4.5 Dependencies

Add to `package.json`:
```json
{
  "dependencies": {
    "@simplewebauthn/server": "^13.0.0",
    "@simplewebauthn/browser": "^13.0.0"
  }
}
```

The `@simplewebauthn/browser` package is a client-side library — it is safe to import in `'use client'` components.

### 4.6 Rate Limiting — Resolution of PRP 01/02 `// TODO(PRP-11)` Markers

PRPs 01–10 write endpoints (`POST /api/todos`, `PUT /api/todos/[id]`, `DELETE /api/todos/[id]`) have `// TODO(PRP-11): add per-session rate limiting` comments. PRP 11 implements rate limiting for the auth endpoints directly and provides the utility function for other routes.

**Auth-specific limits (enforced in this PRP):**

| Endpoint | Limit |
|---|---|
| `POST /api/auth/register-verify` | 5 attempts per IP per minute |
| `POST /api/auth/login-verify` | 5 attempts per IP per minute |
| `POST /api/auth/register-options` | 20 requests per IP per minute |
| `POST /api/auth/login-options` | 20 requests per IP per minute |

**Implementation** (SQLite-based, consistent with the project's no-external-service philosophy):

```typescript
// lib/rate-limit.ts

import { getDb } from './db'

export function checkRateLimit(ip: string, endpoint: string, maxPerMinute: number): boolean {
  const db = getDb()
  // Window key: IP + endpoint + current minute (truncated to minute boundary)
  const windowKey = new Date().toISOString().slice(0, 16) // 'YYYY-MM-DDTHH:MM'

  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_attempts (
      ip           TEXT    NOT NULL,
      endpoint     TEXT    NOT NULL,
      window_start TEXT    NOT NULL,
      count        INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (ip, endpoint, window_start)
    )
  `)

  // Upsert — increment counter for this window
  db.prepare(`
    INSERT INTO rate_limit_attempts (ip, endpoint, window_start, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(ip, endpoint, window_start) DO UPDATE SET count = count + 1
  `).run(ip, endpoint, windowKey)

  const row = db.prepare(
    'SELECT count FROM rate_limit_attempts WHERE ip = ? AND endpoint = ? AND window_start = ?'
  ).get(ip, endpoint, windowKey) as { count: number } | undefined

  return (row?.count ?? 1) <= maxPerMinute
}
```

Return `429 Too Many Requests` with `{ error: { code: 'RATE_LIMITED', message: 'Too many attempts, please wait a minute' } }` when the limit is exceeded.

**Wiring in existing route TODO markers**: After implementing this utility, replace `// TODO(PRP-11): add per-session rate limiting` in `app/api/todos/route.ts` and `app/api/todos/[id]/route.ts` with:
```typescript
const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
if (!checkRateLimit(ip, 'POST /api/todos', 60)) { // 60 writes per IP per minute
  return NextResponse.json(
    { error: { code: 'RATE_LIMITED', message: 'Too many attempts, please wait a minute' } },
    { status: 429 }
  )
}
```

### 4.7 API Endpoints

All 6 auth endpoints live under `app/api/auth/`. They share:
- Body size limit: 64 KB (per PRP 01 §4.4 pattern)
- Error shape: `{ error: { code: string, message: string } }` (identical to PRP 01)
- No stack traces or internal errors in responses
- `rpID` and `expectedOrigin` always read from server-side config (never from request body or headers)

---

#### `POST /api/auth/register-options` — Generate Registration Challenge

**File**: `app/api/auth/register-options/route.ts`

**Request body**:
```typescript
{ username: string }  // 1–50 chars, /^[a-zA-Z0-9_-]+$/
```

**Behavior**:
1. Validate `username` format. Return 400 on violation.
2. Check whether the username already has registered authenticators. If so, the registration is still allowed (the user may be adding a second device). If the username already exists as a `users` row, reuse that user's `id` for the challenge.
3. Look up existing `authenticators` for this user (if the user exists) to populate `excludeCredentials` in the options, preventing duplicate registration of the same device.
4. Call `generateRegistrationOptions({ rpName, rpID, userName: username, excludeCredentials: [...], authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' } })`.
5. Store the generated `challenge` in `webauthn_challenges` with `type = 'registration'`, `username`, `expires_at = now + 5m`.
6. Return 200 with the options object.

**Success response**: `HTTP 200 OK` with the raw `PublicKeyCredentialCreationOptionsJSON` from `@simplewebauthn/server`.

**Error responses**:
```
400 { "error": { "code": "INVALID_USERNAME", "message": "Username must be 1–50 alphanumeric characters, hyphens, or underscores" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

---

#### `POST /api/auth/register-verify` — Verify Registration and Create Account

**File**: `app/api/auth/register-verify/route.ts`

**Request body**:
```typescript
{ username: string; response: RegistrationResponseJSON }
```

**Rate limit**: 5 per IP per minute (§4.6).

**Behavior**:
1. Validate request body shape. Reject unknown fields.
2. Look up the most recent **unused, unexpired** `webauthn_challenges` row matching `username` and `type = 'registration'`. If not found or expired, return 400 with a generic error. Do not distinguish "no challenge" from "expired challenge" in the response.
3. Call `verifyRegistrationResponse({ response, expectedChallenge: row.challenge, expectedOrigin: getWebAuthnConfig().expectedOrigin, expectedRPID: getWebAuthnConfig().rpID })`.
4. Immediately set `used_at = now` on the challenge row — even if verification fails. A failed attempt burns the challenge.
5. If verification fails: return 400 `{ error: { code: 'VERIFICATION_FAILED', message: 'Registration verification failed' } }`.
6. If `credentialID` already exists in `authenticators` (concurrent duplicate registration): return 409 `{ error: { code: 'CREDENTIAL_ALREADY_EXISTS', message: 'This authenticator is already registered' } }`.
7. Create or look up the `users` row for `username`. Use a transaction to create user + authenticator atomically.
8. Insert the `authenticators` row:
   - `credential_id`: `isoBase64URL.fromBuffer(registrationInfo.credentialID)` — always use `isoBase64URL` for encoding
   - `public_key`: `isoBase64URL.fromBuffer(registrationInfo.credentialPublicKey)`
   - `counter`: `registrationInfo.counter ?? 0` — **always use `?? 0`** to handle undefined (documented in copilot-instructions.md)
   - `transports`: `JSON.stringify(response.response.transports ?? [])`
9. Call `createSession(user.id, user.username)` and issue the cookie.
10. Return 201 `{ data: { userId, username } }`.

**Success response**: `HTTP 201 Created`

**Error responses**:
```
400 { "error": { "code": "INVALID_CHALLENGE", "message": "Challenge expired or already used" } }
400 { "error": { "code": "VERIFICATION_FAILED", "message": "Registration verification failed" } }
409 { "error": { "code": "CREDENTIAL_ALREADY_EXISTS", "message": "This authenticator is already registered" } }
429 { "error": { "code": "RATE_LIMITED", "message": "Too many attempts, please wait a minute" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

---

#### `POST /api/auth/login-options` — Generate Authentication Challenge

**File**: `app/api/auth/login-options/route.ts`

**Request body**:
```typescript
{ username: string }
```

**Behavior**:
1. Validate `username` format.
2. Look up the user and their authenticators. **Critical**: if the user does not exist, still generate a valid challenge and return options (possibly with an empty `allowCredentials`). Do not return a distinct 404 — this would leak whether the username exists.
3. Call `generateAuthenticationOptions({ rpID, allowCredentials: authenticators.map(...), userVerification: 'preferred' })`.
4. Store challenge in `webauthn_challenges` with `type = 'authentication'`, `user_id` (or null if user not found), `expires_at = now + 5m`.
5. Return 200 with `PublicKeyCredentialRequestOptionsJSON`.

**Timing note**: whether or not the user exists, the response time should be indistinguishable (generate the challenge regardless; just return empty `allowCredentials` for unknown users).

**Success response**: `HTTP 200 OK`

**Error responses**:
```
400 { "error": { "code": "INVALID_USERNAME", "message": "Username must be 1–50 alphanumeric characters, hyphens, or underscores" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

---

#### `POST /api/auth/login-verify` — Verify Authentication and Issue Session

**File**: `app/api/auth/login-verify/route.ts`

**Request body**:
```typescript
{ username: string; response: AuthenticationResponseJSON }
```

**Rate limit**: 5 per IP per minute (§4.6).

**Behavior**:
1. Validate request body shape.
2. Look up the challenge (by `response.id` — the credential ID — correlated with the stored challenge, or by `username + type = 'authentication'`). If expired or used, return 400 with a generic error.
3. Look up the user and the authenticator matching `response.id` (the credential ID from the response). If the user or authenticator is not found, return 400 with **the same generic error** as an expired challenge. Never distinguish missing-user from bad-challenge in the response.
4. Call `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID, authenticator: { credentialPublicKey: ..., credentialID: ..., counter: authenticator.counter ?? 0, transports: ... } })`.
5. Immediately set `used_at = now` on the challenge row.
6. If verification fails: return 400 with generic error (same code as step 3).
7. **Counter validation** (critical — prevents cloned authenticator attacks):
   - If `authenticationInfo.newCounter <= authenticator.counter` **and** `authenticationInfo.newCounter !== 0`: reject with `400 COUNTER_REGRESSION`. Log a security warning server-side with `{ userId, credentialId, storedCounter, receivedCounter }` — **never log the public key**.
   - If `authenticator.counter === 0` and `authenticationInfo.newCounter === 0`: this is a hardware authenticator that does not increment counters (e.g. some security keys). This is **acceptable** — accept the login. Document this exception explicitly.
   - Otherwise (newCounter > storedCounter): accept and update.
8. Update `authenticators.counter = authenticationInfo.newCounter ?? 0` (use `?? 0` per copilot-instructions.md).
9. Call `createSession(user.id, user.username)` and issue the cookie.
10. Return 200 `{ data: { userId, username } }`.

**Success response**: `HTTP 200 OK`

**Error responses**:
```
400 { "error": { "code": "AUTHENTICATION_FAILED", "message": "Authentication failed" } }
400 { "error": { "code": "COUNTER_REGRESSION", "message": "Authentication failed" } }  ← same message, different code for server logs
429 { "error": { "code": "RATE_LIMITED", "message": "Too many attempts, please wait a minute" } }
500 { "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }
```

Note: `COUNTER_REGRESSION` uses the same human-readable message as `AUTHENTICATION_FAILED` intentionally — the distinction is in `code` for server-side monitoring, not revealed in the UI.

---

#### `POST /api/auth/logout` — Invalidate Session

**File**: `app/api/auth/logout/route.ts`

**Request**: No body required. Reads the session cookie.

**Behavior**:
1. Read the session cookie.
2. If present and parseable as a JWT (even if expired): extract `jti` using `getSessionIdFromToken()` (decode without verify) and call `deleteSession(jti)`.
3. Clear the cookie by setting `Max-Age=0` on the response.
4. Return 200 `{ data: { loggedOut: true } }` regardless of whether a session existed — this endpoint is always idempotent from the client's perspective.

**Success response**: `HTTP 200 OK` (no cookie in response after this call)

**Note on idempotency**: Calling logout when already logged out (no cookie or invalid cookie) returns 200, not 401. The client always lands on `/login` cleanly.

---

#### `GET /api/auth/me` — Return Current Session User

**File**: `app/api/auth/me/route.ts`

**Request**: No body. Reads the session cookie.

**Behavior**:
1. Call `getSession()`.
2. If null, return 401.
3. Return 200 with user info.

**Success response**:
```json
HTTP 200 OK
{ "data": { "userId": 42, "username": "alice" } }
```

**Error responses**:
```
401 { "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }
```

**Usage by existing routes**: PRPs 01–10 routes call `getSession()` directly — they do not call `/api/auth/me`. This endpoint is for client-side session refresh and for the `/login` page to check if the user is already authenticated on mount.

---

### 4.8 Challenge Generation Pattern

Both `register-options` and `login-options` generate challenges using `generateRegistrationOptions`/`generateAuthenticationOptions` from `@simplewebauthn/server`, which internally uses `crypto.getRandomValues` for the 32-byte challenge.

The challenge is stored as returned by `@simplewebauthn/server` (already base64url-encoded). On the verify side, pass it as `expectedChallenge` directly — no encoding/decoding needed.

```typescript
// Storing the challenge
const options = await generateRegistrationOptions({ ... })
db.prepare(`
  INSERT INTO webauthn_challenges (id, challenge, type, username, created_at, expires_at)
  VALUES (?, ?, 'registration', ?, ?, ?)
`).run(
  crypto.randomUUID(),      // challenge lookup ID
  options.challenge,        // already base64url; store as-is
  username,
  new Date().toISOString(),
  new Date(Date.now() + 5 * 60 * 1000).toISOString() // +5 minutes
)

// Retrieving for verification
const row = db.prepare(`
  SELECT challenge FROM webauthn_challenges
  WHERE username = ? AND type = 'registration'
    AND used_at IS NULL
    AND expires_at > ?
  ORDER BY created_at DESC LIMIT 1
`).get(username, new Date().toISOString()) as { challenge: string } | undefined
```

---

## 5. UI Components

All UI lives in `app/login/page.tsx` (replaces the existing dev-login scaffold). This is a `'use client'` component. Import `@simplewebauthn/browser` for the browser-side WebAuthn interaction.

### 5.1 Login Page Structure

The `/login` page has two panels, visually separated:
- **Register** panel — for new users creating a passkey
- **Sign In** panel — for returning users

```tsx
// app/login/page.tsx
'use client'

import { startRegistration, startAuthentication } from '@simplewebauthn/browser'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const nextPath = searchParams.get('next') ?? '/'

  // Check if already authenticated; redirect away if so
  useEffect(() => {
    fetch('/api/auth/me').then(res => {
      if (res.ok) router.replace(nextPath)
    })
  }, [])

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-center">Todo App</h1>
        <RegisterPanel nextPath={nextPath} />
        <SignInPanel nextPath={nextPath} />
      </div>
    </main>
  )
}
```

### 5.2 `RegisterPanel` Component

```tsx
function RegisterPanel({ nextPath }: { nextPath: string }) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = username.trim()
    if (!trimmed) { setErrorMessage('Username is required'); return }
    setStatus('loading')
    setErrorMessage(null)

    try {
      // Step 1: Get registration options from server
      const optionsRes = await fetch('/api/auth/register-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmed }),
      })
      const optionsJson = await optionsRes.json()
      if (!optionsRes.ok) throw new Error(optionsJson.error?.message ?? 'Failed to start registration')

      // Step 2: Trigger the browser WebAuthn prompt
      const registrationResponse = await startRegistration({ optionsJSON: optionsJson })

      // Step 3: Send the response to the server for verification
      const verifyRes = await fetch('/api/auth/register-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmed, response: registrationResponse }),
      })
      const verifyJson = await verifyRes.json()
      if (!verifyRes.ok) throw new Error(verifyJson.error?.message ?? 'Registration failed')

      setStatus('success')
      router.push(nextPath)
    } catch (err) {
      setStatus('error')
      // Check for user cancellation (NotAllowedError from WebAuthn)
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setErrorMessage('Registration cancelled. Please try again.')
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Registration failed')
      }
    }
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Create Account</h2>
      <form onSubmit={handleRegister} className="flex flex-col gap-3">
        <label htmlFor="register-username" className="text-sm font-medium">Username</label>
        <input
          id="register-username"
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Choose a username"
          maxLength={50}
          pattern="[a-zA-Z0-9_-]+"
          required
          autoComplete="username webauthn"
          className="border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
        />
        {errorMessage && <p role="alert" className="text-red-600 text-sm">{errorMessage}</p>}
        <button
          type="submit"
          disabled={status === 'loading'}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium"
        >
          {status === 'loading' ? 'Registering…' : 'Register with Passkey'}
        </button>
      </form>
    </section>
  )
}
```

### 5.3 `SignInPanel` Component

```tsx
function SignInPanel({ nextPath }: { nextPath: string }) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = username.trim()
    if (!trimmed) { setErrorMessage('Username is required'); return }
    setStatus('loading')
    setErrorMessage(null)

    try {
      const optionsRes = await fetch('/api/auth/login-options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmed }),
      })
      const optionsJson = await optionsRes.json()
      if (!optionsRes.ok) throw new Error(optionsJson.error?.message ?? 'Failed to start sign in')

      const authResponse = await startAuthentication({ optionsJSON: optionsJson })

      const verifyRes = await fetch('/api/auth/login-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: trimmed, response: authResponse }),
      })
      const verifyJson = await verifyRes.json()
      if (!verifyRes.ok) throw new Error(verifyJson.error?.message ?? 'Sign in failed')

      router.push(nextPath)
    } catch (err) {
      setStatus('error')
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setErrorMessage('Sign in cancelled. Please try again.')
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Sign in failed')
      }
    }
  }

  return (
    <section className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
      <h2 className="text-lg font-semibold mb-4">Sign In</h2>
      <form onSubmit={handleSignIn} className="flex flex-col gap-3">
        <label htmlFor="login-username" className="text-sm font-medium">Username</label>
        <input
          id="login-username"
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="Your username"
          maxLength={50}
          required
          autoComplete="username webauthn"
          className="border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600"
        />
        {errorMessage && <p role="alert" className="text-red-600 text-sm">{errorMessage}</p>}
        <button
          type="submit"
          disabled={status === 'loading'}
          className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium"
        >
          {status === 'loading' ? 'Signing in…' : 'Sign In with Passkey'}
        </button>
      </form>
    </section>
  )
}
```

### 5.4 Logout Button

Added to `app/page.tsx` (and any other protected page header) as part of the PRP 11 integration:

```tsx
// In app/page.tsx header section — replaces the existing handleLogout function
async function handleLogout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  router.push('/login')
}
```

The `POST /api/auth/logout` route deletes the server-side session row before the client redirects.

---

## 6. Edge Cases

### 6.1 Device Has No Platform Authenticator
- `startRegistration()` or `startAuthentication()` throws a `NotSupportedError` or `NotAllowedError`.
- The UI catches this and displays: *"Your device or browser doesn't support passkeys. Please try a different device or browser."*
- The server never receives an invalid request; no error response needed from the server side.

### 6.2 Login with a Revoked/Deleted Authenticator
- If a user deletes their account or an admin removes an `authenticators` row, the credential ID will not be found in `login-verify` step 3.
- Returns 400 `AUTHENTICATION_FAILED` — same generic error as a bad challenge. No information about whether the credential ever existed is leaked.

### 6.3 Expired Challenge
- The challenge `expires_at` is checked before any WebAuthn verification call: `WHERE used_at IS NULL AND expires_at > NOW()`.
- Returns 400 `INVALID_CHALLENGE` with the message "Challenge expired or already used".
- The user must start the flow again (click "Register" or "Sign In" again to get a fresh challenge).

### 6.4 Reused / Replayed Challenge
- `used_at` is set immediately after the first verify attempt (success **or** failure).
- A second attempt with the same registration/authentication response returns 400 `INVALID_CHALLENGE` (same message as expired).
- The 5-minute TTL and single-use marking together mean: a valid challenge/response packet captured in transit cannot be replayed, even within the TTL window.

### 6.5 Session Cookie Present but Session Invalid/Expired
- JWT is expired → `jwt.verify()` throws → `getSession()` returns null → API routes return 401 → proxy redirects to `/login`.
- JWT is valid but `jti` row is missing from `sessions` table (logged out on another device) → `getSession()` returns null → same behavior.
- The client eventually lands on `/login?next=<original-path>` and authenticates fresh.

### 6.6 Concurrent Registration of the Same Credential
- If two tabs simultaneously complete the registration flow for the same credential ID (unlikely but possible via automation), the `UNIQUE` constraint on `authenticators.credential_id` causes the second INSERT to fail.
- `register-verify` catches this DB error and returns 409 `CREDENTIAL_ALREADY_EXISTS`.
- The transaction in `register-verify` is wrapped: user creation and authenticator creation are atomic. If the authenticator insert fails, the user is not created either (preventing a half-created account).

### 6.7 Logout When Already Logged Out
- `POST /api/auth/logout` always returns 200, regardless of whether a session cookie was present or valid.
- If the cookie is present but the JWT decodes to a `jti` that no longer exists in `sessions`, `deleteSession()` runs a no-op DELETE — no error.
- The cookie `Max-Age=0` is always set on the response, ensuring it is cleared even if the server-side row was already gone.

### 6.8 Username Already Taken (Registration)
- `register-options` does not block on this — it generates a challenge even if the username exists. The check happens in `register-verify` when creating the user row.
- If the username row already exists in `users`, `register-verify` treats this as "adding a second authenticator to an existing account". It does **not** block registration unless the specific credential ID already exists.
- This means usernames are account identifiers but not passwords. A user who knows another user's username could attempt to add their own device to that account — however, WebAuthn requires physical possession of a registered authenticator to complete `login-verify`, and `register-verify` requires a registered authenticator to demonstrate authority (future improvement: require prior authenticated session to add new authenticators — flag as a follow-up).

### 6.9 No `WEBAUTHN_RP_ID` in Development
- `getWebAuthnConfig()` falls back to `localhost` / `http://localhost:3000` with a console warning.
- This is explicitly not safe for production; the startup guard throws an error if `NODE_ENV === 'production'` and the variables are missing.

---

## 7. Acceptance Criteria

1. **Register and immediately access the app**: A new user can enter a username, click "Register with Passkey", interact with the browser's authenticator prompt once, and land on `/` with a valid session — no additional steps.

2. **Login on the same device**: A registered user can return to `/login`, enter their username, click "Sign In with Passkey", and land on `/` without re-entering credentials.

3. **Session persists across reloads**: After registration or login, refreshing the page within 7 days maintains the session. After 7 days (or after explicit logout), the user is redirected to `/login`.

4. **Proper logout**: After clicking "Logout", the session row is deleted from the `sessions` table. Re-accessing a protected route with the now-cleared cookie sends the user to `/login`. Re-presenting the old JWT (e.g. from a cached HTTP response) is also rejected because the `sessions` row no longer exists.

5. **401 shape preserved**: All protected API endpoints (`/api/todos`, etc.) continue to return exactly `{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }` with HTTP 401 when unauthenticated. No new error format is introduced. Existing client-side error handling in `app/page.tsx` requires no changes.

6. **Redirect preserves intended path**: A user who follows a direct link to `/` while logged out is redirected to `/login?next=/`, and after authenticating lands on `/` (not `/login`).

7. **Rate limiting active**: `register-verify` and `login-verify` reject a 6th request from the same IP within a 60-second window with HTTP 429 `RATE_LIMITED`. The `// TODO(PRP-11)` markers in `app/api/todos/route.ts` and `app/api/todos/[id]/route.ts` are replaced with working rate limit checks.

8. **Counter regression rejected**: A `login-verify` request where the authenticator counter does not increase is rejected with 400, a security warning is logged server-side, and the user is not logged in.

9. **Challenge single-use**: Submitting the same `login-verify` request body twice returns 400 on the second attempt, even if the JWT in the first response hasn't expired yet.

10. **`session.userId` contract**: `getSession()` returns `{ userId: number, username: string }`. Every route handler in PRPs 01–10 that calls `getSession()` compiles and runs without modification after PRP 11 replaces the dev-login scaffold.

11. **Dev-login removed in production**: `app/api/auth/dev-login/route.ts` either returns 404 in production (guarded by `process.env.NODE_ENV !== 'production'`) or is deleted entirely. It must not be accessible in a deployed build.

---

## 8. Out of Scope

- **Password fallback**: No username/password login path. WebAuthn only.
- **Account recovery**: No "forgot passkey" flow. Users who lose all registered authenticators with no synced passkey must contact support (out of scope; flag for post-launch).
- **Multi-factor (MFA)**: The passkey *is* the second factor (something you have + something you are/know via biometric/PIN). No additional OTP or TOTP layer.
- **Admin / role-based permissions**: All authenticated users have equivalent access to their own data. No admin roles.
- **Social / OAuth login**: No Google, GitHub, etc. WebAuthn only.
- **Email verification**: No email address collected or verified.
- **Multiple named devices**: The `device_name` column exists but the UI for listing/revoking individual authenticators is not specified in this PRP. Users can register multiple devices but cannot manage them via a UI until a future "Account Settings" PRP.
- **Passkey cross-device sync UX**: The passkey sync (iCloud Keychain, Google Password Manager) is handled by the platform; this PRP does not implement or test cross-device sync flows.
- **E2E encrypted credential storage**: Public keys are stored in SQLite as base64url strings. Encryption at rest for the database file is an infrastructure concern, not a PRP concern.

---

## 9. Testing Requirements

### 9.1 E2E Tests (Playwright — `tests/01-authentication.spec.ts`)

Tests run with Chromium using virtual WebAuthn authenticators (`--enable-experimental-web-platform-features`, virtual authenticator API via Playwright's CDP). The `playwright.config.ts` Chromium launch args must include:
```typescript
launchOptions: {
  args: ['--enable-experimental-web-platform-features']
}
```

```
Test Suite: Authentication (WebAuthn)

TC-A01: Register a new user
  - Navigate to /login
  - Add a virtual authenticator to the CDP session
  - Enter username "testuser-register-01"
  - Click "Register with Passkey"
  - Assert: browser sends WebAuthn registration request (intercepted via CDP)
  - Assert: redirected to /
  - Assert: GET /api/auth/me returns 200 with { userId: number, username: 'testuser-register-01' }
  - Assert: users table has a row; authenticators table has a row

TC-A02: Login with existing passkey
  - Register via TC-A01 helper
  - POST /api/auth/logout
  - Navigate to /login
  - Enter same username
  - Click "Sign In with Passkey"
  - Assert: redirected to /
  - Assert: GET /api/auth/me returns 200

TC-A03: Session persists across reload
  - Register and navigate to /
  - Reload the page
  - Assert: no redirect to /login; page loads normally

TC-A04: Logout invalidates session server-side
  - Register (get session cookie)
  - Note the session cookie value
  - POST /api/auth/logout
  - Assert: GET /api/auth/me returns 401
  - Assert: the sessions row is deleted from DB

TC-A05: Expired challenge rejected
  - POST /api/auth/register-options → get options
  - Manually expire the challenge (UPDATE webauthn_challenges SET expires_at = '2000-01-01' WHERE ...)
  - POST /api/auth/register-verify with the same response
  - Assert: 400 INVALID_CHALLENGE

TC-A06: Counter regression rejected
  - Register a user with virtual authenticator (counter = 0)
  - Manually set authenticators.counter = 999 in DB
  - Attempt login (virtual authenticator will send counter = 1)
  - Assert: 400 AUTHENTICATION_FAILED
  
TC-A07: Redirect preserves next path
  - Clear cookies
  - Navigate to / (unauthenticated)
  - Assert: redirected to /login?next=/
  - Register
  - Assert: redirected back to /

TC-A08: Rate limit on login-verify
  - Register a user
  - POST /api/auth/login-verify with invalid response 6 times from the same IP
  - Assert: 6th response is 429 RATE_LIMITED

TC-A09: dev-login unavailable in production
  - Set NODE_ENV=production (or test with a guard check)
  - POST /api/auth/dev-login
  - Assert: 404 (route disabled)
```

### 9.2 Unit Tests

```
UT-A01: createSession returns a JWT containing jti, userId, username
UT-A02: getSession returns null for an expired JWT
UT-A03: getSession returns null when jti is missing from sessions table
UT-A04: deleteSession removes the row; subsequent getSession returns null
UT-A05: getSessionIdFromToken correctly decodes jti from an expired JWT
UT-A06: checkRateLimit returns true for first 5 calls, false on 6th
UT-A07: checkRateLimit resets after a new minute window
UT-A08: Challenge TTL: webauthn_challenges with past expires_at are not returned
```

---

## 10. Success Metrics

| Metric | Target |
|---|---|
| E2E test pass rate | 100% (TC-A01 through TC-A09) |
| Unit test pass rate | 100% (UT-A01 through UT-A08) |
| PRPs 01–10 route handler changes required | 0 (getSession() contract identical) |
| `// TODO(PRP-11)` markers resolved | All in `app/api/todos/route.ts` and `app/api/todos/[id]/route.ts` |
| `app/api/auth/dev-login` disabled in production | Verified by TC-A09 |
| Session invalidated server-side on logout | Verified by TC-A04 |
| Challenge replay rejected | Verified by TC-A05 |
| Counter regression rejected | Verified by TC-A06 |
| No credentials logged in full | Confirmed by code review (no `console.log` of public_key or credential_id) |
| Build succeeds with `@simplewebauthn/server` and `@simplewebauthn/browser` | `npm run build` exits 0 |

---

*Last updated: 2026-07-03 | PRP version: 1.0 | Implements feature phase: Phase 5 — Infrastructure | Depends on: PRP 01 (session contract), all PRPs 02–10 (they all depend on this)*
