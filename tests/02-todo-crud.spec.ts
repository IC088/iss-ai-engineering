// tests/02-todo-crud.spec.ts
// E2E tests for PRP 01 — Todo CRUD Operations
// Test IDs match the PRP §8.1 naming exactly (TC-01 through TC-10).

import { test, expect } from '@playwright/test'
import { TestHelpers } from './helpers'

test.describe('Todo CRUD Operations', () => {
  let h: TestHelpers

  test.beforeEach(async ({ page, request }) => {
    h = new TestHelpers(page, request)
    await h.authenticate() // authenticates AND navigates to /
    await h.clearAllTodos() // uses page.request (shares browser cookies)
    await page.reload()
    await page.waitForLoadState('networkidle')
  })

  // TC-01: Create todo with title only
  test('TC-01: Create todo with title only', async ({ page }) => {
    await page.getByLabel('Todo title').fill('Buy groceries')
    await page.getByRole('button', { name: 'Add' }).click()

    await expect(page.getByText('Buy groceries')).toBeVisible()

    // Verify API persisted it (page.request shares the browser cookie)
    const res = await page.request.get('/api/todos')
    expect(res.status()).toBe(200)
    const json = await res.json()
    const created = json.data.find((t: { title: string }) => t.title === 'Buy groceries')
    expect(created).toBeTruthy()
    expect(created.due_date).toBeNull()
  })

  // TC-02: Create todo with all metadata
  test('TC-02: Create todo with all metadata', async ({ page }) => {
    const futureDate = h.getFutureDatetime(120)

    await page.getByLabel('Todo title').fill('Weekly report')
    await page.getByLabel('Due date').fill(futureDate)
    await page.getByRole('button', { name: 'Add' }).click()

    await expect(page.getByText('Weekly report')).toBeVisible()

    const res = await page.request.get('/api/todos')
    expect(res.status()).toBe(200)
    const json = await res.json()
    const created = json.data.find((t: { title: string }) => t.title === 'Weekly report')
    expect(created).toBeTruthy()
    expect(created.due_date).not.toBeNull()
  })

  // TC-03: Edit todo
  test('TC-03: Edit todo', async ({ page }) => {
    await h.createTodo({ title: 'Original title' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    const todoRow = page.getByText('Original title').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Edit "Original title"/ }).click()

    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).toBeVisible()
    const titleInput = page.locator('#edit-title')
    await expect(titleInput).toHaveValue('Original title')

    await titleInput.clear()
    await titleInput.fill('Updated title')
    await page.locator('#edit-due-date').fill(h.getFutureDatetime(60))
    await page.getByRole('button', { name: 'Update' }).click()

    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).not.toBeVisible()
    await expect(page.getByText('Updated title')).toBeVisible()
    await expect(page.getByText('Original title')).not.toBeVisible()
  })

  // TC-04: Toggle completion
  test('TC-04: Toggle completion', async ({ page }) => {
    await h.createTodo({ title: 'Toggle me' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    await page.getByLabel(/Mark "Toggle me" as complete/).click()

    // Completed section heading should appear
    await expect(
      page.locator('h2').filter({ hasText: /Completed/ }).first()
    ).toBeVisible({ timeout: 5000 })

    // Mark incomplete again
    await page.getByLabel(/Mark "Toggle me" as incomplete/).click()
    await expect(page.getByText('Toggle me')).toBeVisible()
  })

  // TC-05: Delete todo
  test('TC-05: Delete todo', async ({ page }) => {
    const todo = await h.createTodo({ title: 'Delete me' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    const todoRow = page.getByText('Delete me').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Delete "Delete me"/ }).click()

    await expect(page.getByRole('dialog', { name: 'Delete todo?' })).toBeVisible()
    await expect(page.getByText(/permanently delete/)).toBeVisible()
    // Dialog uses straight quotes per PRP §3.5
    await expect(page.getByText(/"Delete me"/)).toBeVisible()

    await page.getByRole('button', { name: 'Delete' }).last().click()

    await expect(page.getByText('Delete me')).not.toBeVisible({ timeout: 5000 })

    const res = await page.request.get(`/api/todos/${todo.id}`)
    expect(res.status()).toBe(404)
  })

  // TC-06: Delete todo — cancel
  test('TC-06: Delete todo — cancel', async ({ page }) => {
    await h.createTodo({ title: 'Keep me' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    const todoRow = page.getByText('Keep me').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Delete "Keep me"/ }).click()

    await expect(page.getByRole('dialog', { name: 'Delete todo?' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByRole('dialog', { name: 'Delete todo?' })).not.toBeVisible()
    await expect(page.getByText('Keep me')).toBeVisible()
  })

  // TC-07: Past due date validation — rejected with correct error
  test('TC-07: Past due date validation — rejected with correct error', async ({ page }) => {
    const pastDate = h.getPastDatetime()

    // page.request shares browser auth cookie
    const res = await page.request.post('/api/todos', {
      data: { title: 'Past due test', due_date: pastDate },
    })

    expect(res.status()).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('DUE_DATE_IN_PAST')
    expect(json.error.message).toBe('Due date must be at least 1 minute in the future')
  })

  // TC-08: Empty title rejected
  test('TC-08: Empty title rejected', async ({ page }) => {
    const res = await page.request.post('/api/todos', {
      data: { title: '   ' },
    })
    expect(res.status()).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('TITLE_REQUIRED')
    expect(json.error.message).toBe('Title is required')

    // UI: Add button disabled when title is empty
    await expect(page.getByRole('button', { name: 'Add' })).toBeDisabled()

    const todosRes = await page.request.get('/api/todos')
    const todosJson = await todosRes.json()
    expect(todosJson.data).toHaveLength(0)
  })

  // TC-09: Optimistic rollback on create failure
  test('TC-09: Optimistic rollback on create failure', async ({ page }) => {
    await page.route('/api/todos', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Server error' } }),
        })
      } else {
        route.continue()
      }
    })

    await page.getByLabel('Todo title').fill('Rollback test')
    await page.getByRole('button', { name: 'Add' }).click()

    // Use specific selector to avoid matching the Next.js route announcer (also role=alert)
    await expect(
      page.locator('[role="alert"][aria-live="assertive"]').filter({ hasText: 'Server error' })
    ).toBeVisible({ timeout: 5000 })

    await expect(page.getByText('Rollback test')).not.toBeVisible({ timeout: 3000 })
    await page.unroute('/api/todos')

    const res = await page.request.get('/api/todos')
    const json = await res.json()
    expect(json.data.find((t: { title: string }) => t.title === 'Rollback test')).toBeUndefined()
  })

  // TC-10: Unauthenticated request returns 401
  test('TC-10: Unauthenticated request returns 401', async ({ page }) => {
    await page.context().clearCookies()
    const res = await page.request.get('/api/todos')
    expect(res.status()).toBe(401)
    const json = await res.json()
    expect(json.error.code).toBe('UNAUTHORIZED')
  })
})

test.describe('API contract validation', () => {
  let h: TestHelpers

  test.beforeEach(async ({ page, request }) => {
    h = new TestHelpers(page, request)
    await h.authenticate()
  })

  test('Unknown fields in POST body are rejected', async ({ page }) => {
    const res = await page.request.post('/api/todos', {
      data: { title: 'Test', injectedField: 'value' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error.code).toBe('UNKNOWN_FIELDS')
  })

  test('HTML injection in title is rejected', async ({ page }) => {
    const res = await page.request.post('/api/todos', {
      data: { title: '<script>alert(1)</script>' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error.code).toBe('TITLE_INVALID_CHARS')
  })

  test('GET /api/todos/abc returns 400 INVALID_ID', async ({ page }) => {
    const res = await page.request.get('/api/todos/abc')
    expect(res.status()).toBe(400)
    expect((await res.json()).error.code).toBe('INVALID_ID')
  })

  test('GET /api/todos/99999 returns 404 NOT_FOUND', async ({ page }) => {
    const res = await page.request.get('/api/todos/99999')
    expect(res.status()).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  test('DELETE on nonexistent ID returns 404', async ({ page }) => {
    const res = await page.request.delete('/api/todos/99999')
    expect(res.status()).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
  })

  test('PUT on nonexistent ID returns 404, not upsert', async ({ page }) => {
    const res = await page.request.put('/api/todos/99999', {
      data: { title: 'Should not create' },
    })
    expect(res.status()).toBe(404)
  })

  test('PUT body with id and created_at returns UNKNOWN_FIELDS', async ({ page }) => {
    const todo = await h.createTodo({ title: 'Allowlist test' })
    const res = await page.request.put(`/api/todos/${todo.id}`, {
      data: { title: 'Valid', id: 999, created_at: '2000-01-01' },
    })
    expect(res.status()).toBe(400)
    expect((await res.json()).error.code).toBe('UNKNOWN_FIELDS')
  })
})
