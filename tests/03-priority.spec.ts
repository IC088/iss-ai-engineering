// tests/03-priority.spec.ts
// E2E tests for PRP 02 — Priority System
// Test IDs match PRP 02 §8.1 naming exactly (TC-P01 through TC-P10, TC-V01 through TC-V05).
// All API calls use page.request which shares the browser session cookie.

import { test, expect } from '@playwright/test'
import { TestHelpers } from './helpers'

test.describe('Priority System', () => {
  let h: TestHelpers

  test.beforeEach(async ({ page, request }) => {
    h = new TestHelpers(page, request)
    await h.authenticate()
    await h.clearAllTodos()
    await page.reload()
    await page.waitForLoadState('networkidle')
  })

  // TC-P01: Create todo with High priority
  test('TC-P01: Create todo with High priority', async ({ page }) => {
    await page.getByLabel('Todo title').fill('Urgent task')
    await page.locator('#new-todo-priority').selectOption('high')
    await page.getByRole('button', { name: 'Add' }).click()

    await expect(page.getByText('Urgent task')).toBeVisible()

    const badge = page.getByLabel('Priority: High')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('High')

    const res = await page.request.get('/api/todos')
    expect(res.status()).toBe(200)
    const json = await res.json()
    const created = json.data.find((t: { title: string }) => t.title === 'Urgent task')
    expect(created).toBeTruthy()
    expect(created.priority).toBe('high')
  })

  // TC-P02: Create todo with Low priority
  test('TC-P02: Create todo with Low priority', async ({ page }) => {
    await page.getByLabel('Todo title').fill('Low priority task')
    await page.locator('#new-todo-priority').selectOption('low')
    await page.getByRole('button', { name: 'Add' }).click()

    await expect(page.getByText('Low priority task')).toBeVisible()
    await expect(page.getByLabel('Priority: Low')).toBeVisible()

    const res = await page.request.get('/api/todos')
    const json = await res.json()
    const created = json.data.find((t: { title: string }) => t.title === 'Low priority task')
    expect(created).toBeTruthy()
    expect(created.priority).toBe('low')
  })

  // TC-P03: Create todo with default priority (Medium)
  test('TC-P03: Create todo with default priority (Medium)', async ({ page }) => {
    await page.getByLabel('Todo title').fill('Default priority task')
    // Do NOT change priority dropdown — should default to medium
    await page.getByRole('button', { name: 'Add' }).click()

    await expect(page.getByText('Default priority task')).toBeVisible()
    await expect(page.getByLabel('Priority: Medium')).toBeVisible()

    const res = await page.request.get('/api/todos')
    const json = await res.json()
    const created = json.data.find((t: { title: string }) => t.title === 'Default priority task')
    expect(created).toBeTruthy()
    expect(created.priority).toBe('medium')
  })

  // TC-P04: Create todo via direct API without priority field
  test('TC-P04: Create todo via direct API without priority field', async ({ page }) => {
    const res = await page.request.post('/api/todos', {
      data: { title: 'API todo' }, // no priority field
    })
    expect(res.status()).toBe(201)
    const json = await res.json()
    expect(json.data.priority).toBe('medium')

    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByLabel('Priority: Medium').first()).toBeVisible()
  })

  // TC-P05: Edit priority on an existing todo
  test('TC-P05: Edit priority on an existing todo', async ({ page }) => {
    await h.createTodo({ title: 'Change my priority', priority: 'low' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    await expect(page.getByLabel('Priority: Low')).toBeVisible()

    const todoRow = page.getByText('Change my priority').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Edit "Change my priority"/ }).click()

    await expect(page.locator('#edit-priority')).toHaveValue('low')

    await page.locator('#edit-priority').selectOption('high')
    await page.getByRole('button', { name: 'Update' }).click()

    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).not.toBeVisible()
    await expect(page.getByLabel('Priority: High')).toBeVisible()
    await expect(page.getByLabel('Priority: Low')).not.toBeVisible()

    const res = await page.request.get('/api/todos')
    const json = await res.json()
    const updated = json.data.find((t: { title: string }) => t.title === 'Change my priority')
    expect(updated).toBeTruthy()
    expect(updated.priority).toBe('high')
  })

  // TC-P06: Filter by priority — High
  test('TC-P06: Filter by priority — High', async ({ page }) => {
    await h.createTodo({ title: 'High task', priority: 'high' })
    await h.createTodo({ title: 'Medium task', priority: 'medium' })
    await h.createTodo({ title: 'Low task', priority: 'low' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    await page.locator('#priority-filter').selectOption('high')

    await expect(page.getByText('High task')).toBeVisible()
    await expect(page.getByText('Medium task')).not.toBeVisible()
    await expect(page.getByText('Low task')).not.toBeVisible()
  })

  // TC-P07: Filter by priority — clear filter
  test('TC-P07: Filter by priority — clear filter', async ({ page }) => {
    await h.createTodo({ title: 'High task 2', priority: 'high' })
    await h.createTodo({ title: 'Medium task 2', priority: 'medium' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    await page.locator('#priority-filter').selectOption('high')
    await expect(page.getByText('Medium task 2')).not.toBeVisible()

    await page.locator('#priority-filter').selectOption('all')
    await expect(page.getByText('High task 2')).toBeVisible()
    await expect(page.getByText('Medium task 2')).toBeVisible()
  })

  // TC-P08: Verify sort order — high → medium → low
  test('TC-P08: Verify sort order — high → medium → low', async ({ page }) => {
    // Create in reverse order to verify sorting overrides creation order
    await h.createTodo({ title: 'Task L', priority: 'low' })
    await h.createTodo({ title: 'Task M', priority: 'medium' })
    await h.createTodo({ title: 'Task H', priority: 'high' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    const titles = await page.getByRole('listitem').allTextContents()
    const highIdx = titles.findIndex((t) => t.includes('Task H'))
    const medIdx = titles.findIndex((t) => t.includes('Task M'))
    const lowIdx = titles.findIndex((t) => t.includes('Task L'))

    expect(highIdx).toBeGreaterThanOrEqual(0)
    expect(highIdx).toBeLessThan(medIdx)
    expect(medIdx).toBeLessThan(lowIdx)
  })

  // TC-P09: Invalid priority rejected
  test('TC-P09: Invalid priority rejected', async ({ page }) => {
    const res = await page.request.post('/api/todos', {
      data: { title: 'X', priority: 'critical' },
    })
    expect(res.status()).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_PRIORITY')
    expect(json.error.message).toBe('Priority must be one of: high, medium, low')
  })

  // TC-P10: Invalid priority filter param rejected
  test('TC-P10: Invalid priority filter param rejected', async ({ page }) => {
    const res = await page.request.get('/api/todos?priority=urgent')
    expect(res.status()).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_PRIORITY')
  })
})

test.describe('Priority Visual / Accessibility', () => {
  let h: TestHelpers

  test.beforeEach(async ({ page, request }) => {
    h = new TestHelpers(page, request)
    await h.authenticate()
    await h.clearAllTodos()
    await h.createTodo({ title: 'High item', priority: 'high' })
    await h.createTodo({ title: 'Medium item', priority: 'medium' })
    await h.createTodo({ title: 'Low item', priority: 'low' })
    await page.reload()
    await page.waitForLoadState('networkidle')
  })

  // TC-V03: Badge text label present (not color-only)
  test('TC-V03: Badge text label present (not color-only)', async ({ page }) => {
    await expect(page.getByLabel('Priority: High')).toHaveText('High')
    await expect(page.getByLabel('Priority: Medium')).toHaveText('Medium')
    await expect(page.getByLabel('Priority: Low')).toHaveText('Low')
  })

  // TC-V04: Badge aria-label attributes present
  test('TC-V04: Badge aria-label attributes present', async ({ page }) => {
    const highBadge = page.getByLabel('Priority: High')
    const medBadge = page.getByLabel('Priority: Medium')
    const lowBadge = page.getByLabel('Priority: Low')

    await expect(highBadge).toBeVisible()
    await expect(medBadge).toBeVisible()
    await expect(lowBadge).toBeVisible()

    expect(await highBadge.getAttribute('aria-label')).toBe('Priority: High')
    expect(await medBadge.getAttribute('aria-label')).toBe('Priority: Medium')
    expect(await lowBadge.getAttribute('aria-label')).toBe('Priority: Low')
  })

  // TC-V01 / TC-V02: Badge Tailwind classes match PRP 02 §5.1 specification
  test('TC-V01: Badge Tailwind classes match PRP 02 §5.1 specification', async ({ page }) => {
    const highBadge = page.getByLabel('Priority: High')
    const medBadge = page.getByLabel('Priority: Medium')
    const lowBadge = page.getByLabel('Priority: Low')

    const highClass = (await highBadge.getAttribute('class')) ?? ''
    const medClass = (await medBadge.getAttribute('class')) ?? ''
    const lowClass = (await lowBadge.getAttribute('class')) ?? ''

    // Light mode classes
    expect(highClass).toContain('bg-red-100')
    expect(highClass).toContain('text-red-800')
    // Dark mode classes
    expect(highClass).toContain('dark:bg-red-900')
    expect(highClass).toContain('dark:text-red-200')

    expect(medClass).toContain('bg-yellow-100')
    expect(medClass).toContain('text-yellow-800')
    expect(medClass).toContain('dark:bg-yellow-900')
    expect(medClass).toContain('dark:text-yellow-200')

    expect(lowClass).toContain('bg-blue-100')
    expect(lowClass).toContain('text-blue-800')
    expect(lowClass).toContain('dark:bg-blue-900')
    expect(lowClass).toContain('dark:text-blue-200')
  })

  // TC-V05: Priority dropdowns are labelled for accessibility
  test('TC-V05: Priority dropdowns are labelled for accessibility', async ({ page }) => {
    const createSelect = page.locator('#new-todo-priority')
    await expect(createSelect).toBeVisible()

    // sr-only label exists in DOM
    const label = page.locator('label[for="new-todo-priority"]')
    await expect(label).toBeAttached()

    // Open edit modal and check edit priority dropdown
    const todoRow = page.getByText('High item').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Edit "High item"/ }).click()

    const editSelect = page.locator('#edit-priority')
    await expect(editSelect).toBeVisible()

    const editLabel = page.locator('label[for="edit-priority"]')
    await expect(editLabel).toBeAttached()

    // Close modal
    await page.getByRole('button', { name: 'Cancel' }).click()
  })
})
