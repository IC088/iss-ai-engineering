// tests/helpers.ts
// Reusable test helpers for Playwright E2E tests.
// Uses dev-login endpoint for authentication (WebAuthn is PRP 11).

import type { APIRequestContext, Page } from '@playwright/test'

export const TEST_USER = 'e2e-testuser'
export const BASE_URL = 'http://localhost:3000'

export class TestHelpers {
  constructor(
    private page: Page,
    private request: APIRequestContext
  ) {}

  /**
   * Authenticate via the dev-login endpoint using the PAGE's request context
   * (page.request shares cookies with the browser — the top-level `request`
   * fixture is a separate context and does NOT share cookies with the page).
   */
  async authenticate(username = TEST_USER) {
    await this.page.request.post('/api/auth/dev-login', {
      data: { username },
    })
    // Navigate after auth so the session cookie is picked up
    await this.page.goto('/')
    await this.page.waitForLoadState('networkidle')
  }

  /** Create a todo directly via the API using the page's browser cookie context. */
  async createTodo(data: {
    title: string
    priority?: 'high' | 'medium' | 'low'
    due_date?: string
    description?: string
  }) {
    const res = await this.page.request.post('/api/todos', { data })
    const json = await res.json()
    if (!res.ok()) throw new Error(`createTodo failed: ${JSON.stringify(json)}`)
    return json.data
  }

  /** Clear all todos for the test user (direct API delete loop). */
  async clearAllTodos() {
    const res = await this.page.request.get('/api/todos')
    const json = await res.json()
    if (!res.ok()) return
    for (const todo of json.data ?? []) {
      await this.page.request.delete(`/api/todos/${todo.id}`)
    }
  }

  /** Clear session cookie — used for TC-10 (unauthenticated access). */
  async clearSession() {
    await this.page.context().clearCookies()
  }

  /** Wait for a todo to appear in the list by title text. */
  async waitForTodoVisible(title: string) {
    await this.page.getByText(title).first().waitFor({ state: 'visible', timeout: 5000 })
  }

  /** Wait for a todo to disappear from the list by title text. */
  async waitForTodoGone(title: string) {
    await this.page
      .getByText(title)
      .first()
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {
        // Already gone
      })
  }

  /** Get a future datetime-local string (SGT, minutes ahead of now). */
  getFutureDatetime(minutesAhead = 120): string {
    const now = new Date()
    const future = new Date(now.getTime() + minutesAhead * 60_000)
    // Format as YYYY-MM-DDTHH:MM in SGT (UTC+8)
    const sgtMs = future.getTime() + 8 * 60 * 60 * 1000
    return new Date(sgtMs).toISOString().slice(0, 16)
  }

  /** Get a past ISO 8601 datetime string for validation tests. */
  getPastDatetime(): string {
    const past = new Date(Date.now() - 60 * 60 * 1000) // 1 hour ago
    return past.toISOString().replace('Z', '') // no offset → treated as SGT
  }
}
