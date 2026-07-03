// tests/06-tags.spec.ts
// E2E tests for PRP 06 — Tag System
// Tests cover: tag creation, duplicate rejection, attach/detach, Tag Manager rename/delete,
// tag filtering (single, OR, AND-with-priority), and clear filter.

import { test, expect } from '@playwright/test'
import { TestHelpers } from './helpers'

test.describe('Tag System', () => {
  let h: TestHelpers

  test.beforeEach(async ({ page, request }) => {
    h = new TestHelpers(page, request)
    await h.authenticate()
    await h.clearAllTodos()
    // Clear all tags
    const tagsRes = await page.request.get('/api/tags')
    const tagsJson = await tagsRes.json()
    for (const tag of tagsJson.data ?? []) {
      await page.request.delete(`/api/tags/${tag.id}`)
    }
    await page.reload()
    await page.waitForLoadState('networkidle')
  })

  // TC-T01: Create tag inline while creating a new todo
  test('TC-T01: Create tag inline while creating a new todo', async ({ page }) => {
    await page.getByLabel('Todo title').fill('Tagged task')

    // Open the TagPicker and create a new tag
    await page.getByLabel('Tag search').click()
    await page.getByLabel('Tag search').fill('work')
    // Click "Create 'work'"
    await page.getByText('Create "work"').click()
    // Pick a color (click the first preset swatch)
    await page.locator('[aria-label="Color #EF4444"]').first().click()
    await page.getByRole('button', { name: 'Create' }).click()

    // Tag should appear as a chip in the picker
    await expect(page.getByText('work').first()).toBeVisible()

    // Submit the todo
    await page.getByRole('button', { name: 'Add' }).click()

    // Todo and its tag badge should be visible
    await expect(page.getByText('Tagged task')).toBeVisible()
    await expect(page.getByText('work').first()).toBeVisible()

    // Verify via API
    const todosRes = await page.request.get('/api/todos')
    const todosJson = await todosRes.json()
    const todo = todosJson.data.find((t: { title: string }) => t.title === 'Tagged task')
    expect(todo).toBeTruthy()
    expect(todo.tags.length).toBe(1)
    expect(todo.tags[0].name).toBe('work')
  })

  // TC-T02: Attempt to create duplicate tag name (different casing)
  test('TC-T02: Duplicate tag name (case-insensitive) is rejected', async ({ page }) => {
    // Create "Work" tag via API
    await page.request.post('/api/tags', { data: { name: 'Work', color: '#3B82F6' } })

    // Attempt to create "work" (lowercase) via API
    const dupRes = await page.request.post('/api/tags', { data: { name: 'work', color: '#EF4444' } })
    expect(dupRes.status()).toBe(409)
    const dupJson = await dupRes.json()
    expect(dupJson.error.code).toBe('DUPLICATE_TAG_NAME')
    expect(dupJson.error.message).toContain('already exists')

    // Verify only one tag exists
    const tagsRes = await page.request.get('/api/tags')
    const tagsJson = await tagsRes.json()
    expect(tagsJson.data.filter((t: { name: string }) => t.name.toLowerCase() === 'work').length).toBe(1)
  })

  // TC-T03: Attach existing tag to existing todo via edit form
  test('TC-T03: Attach existing tag to todo via edit form — persists after reload', async ({ page }) => {
    const tagRes = await page.request.post('/api/tags', { data: { name: 'billing', color: '#F97316' } })
    const tag = (await tagRes.json()).data
    await h.createTodo({ title: 'Todo to tag' })
    await page.reload()
    await page.waitForLoadState('networkidle')

    // Open edit modal
    const todoRow = page.getByText('Todo to tag').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Edit "Todo to tag"/ }).click()
    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).toBeVisible()

    // Click the tag picker and select existing tag
    await page.getByLabel('Tag search').click()
    await page.getByText('billing').first().click()

    // Submit update
    await page.getByRole('button', { name: 'Update' }).click()
    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).not.toBeVisible()

    // Tag badge should appear on the todo card
    await expect(page.getByText('billing').first()).toBeVisible()

    // Verify persists after reload
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('billing').first()).toBeVisible()

    // Verify via API
    const todosRes = await page.request.get('/api/todos')
    const todosJson = await todosRes.json()
    const todo = todosJson.data.find((t: { title: string }) => t.title === 'Todo to tag')
    expect(todo.tags.find((t: { id: number }) => t.id === tag.id)).toBeTruthy()
  })

  // TC-T04: Remove a tag from a todo via edit form
  test('TC-T04: Remove tag from todo via edit form — persists after reload', async ({ page }) => {
    // Create tag and todo with tag attached
    const tagRes = await page.request.post('/api/tags', { data: { name: 'personal', color: '#10B981' } })
    const tag = (await tagRes.json()).data
    const todo = await h.createTodo({ title: 'Todo with tag' })
    await page.request.post(`/api/todos/${todo.id}/tags`, { data: { tagIds: [tag.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Verify tag badge is shown
    await expect(page.getByText('personal').first()).toBeVisible()

    // Open edit modal and remove the tag
    const todoRow = page.getByText('Todo with tag').first().locator('..')
    await todoRow.hover()
    await page.getByRole('button', { name: /Edit "Todo with tag"/ }).click()
    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).toBeVisible()

    // Remove the tag chip
    await page.getByRole('button', { name: 'Remove tag personal' }).click()

    await page.getByRole('button', { name: 'Update' }).click()
    await expect(page.getByRole('dialog', { name: 'Edit Todo' })).not.toBeVisible()

    // Tag badge should be gone
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('personal')).not.toBeVisible({ timeout: 3000 })

    // Verify via API
    const todosRes = await page.request.get('/api/todos')
    const todosJson = await todosRes.json()
    const updatedTodo = todosJson.data.find((t: { title: string }) => t.title === 'Todo with tag')
    expect(updatedTodo.tags.find((t: { id: number }) => t.id === tag.id)).toBeUndefined()
  })

  // TC-T05: Tag Manager — rename a tag updates all tagged todos
  test('TC-T05: Rename tag in Tag Manager updates all todos', async ({ page }) => {
    const tagRes = await page.request.post('/api/tags', { data: { name: 'oldname', color: '#8B5CF6' } })
    const tag = (await tagRes.json()).data
    const todo = await h.createTodo({ title: 'Tagged todo' })
    await page.request.post(`/api/todos/${todo.id}/tags`, { data: { tagIds: [tag.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Open Tag Manager
    await page.getByRole('button', { name: 'Manage Tags' }).click()
    await expect(page.getByRole('dialog', { name: 'Manage Tags' })).toBeVisible()

    // Click the tag name to rename
    await page.getByText('oldname').first().click()
    const renameInput = page.getByLabel(/Rename tag oldname/)
    await renameInput.clear()
    await renameInput.fill('newname')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByText('newname')).toBeVisible()

    // Close manager and verify on todo card
    await page.getByLabel('Close tag manager').click()
    await expect(page.getByRole('dialog', { name: 'Manage Tags' })).not.toBeVisible()
    await expect(page.getByText('newname').first()).toBeVisible()
    await expect(page.getByText('oldname')).not.toBeVisible({ timeout: 2000 })
  })

  // TC-T06: Delete a tag shows correct affected count, removes from todos, keeps todos
  test('TC-T06: Delete tag — confirmation shows todo count, removes from todos', async ({ page }) => {
    const tagRes = await page.request.post('/api/tags', { data: { name: 'todelete', color: '#EC4899' } })
    const tag = (await tagRes.json()).data
    const todo1 = await h.createTodo({ title: 'First tagged' })
    const todo2 = await h.createTodo({ title: 'Second tagged' })
    await page.request.post(`/api/todos/${todo1.id}/tags`, { data: { tagIds: [tag.id] } })
    await page.request.post(`/api/todos/${todo2.id}/tags`, { data: { tagIds: [tag.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Open Tag Manager
    await page.getByRole('button', { name: 'Manage Tags' }).click()
    await expect(page.getByRole('dialog', { name: 'Manage Tags' })).toBeVisible()

    // Click delete on the tag
    await page.getByLabel('Delete tag todelete').click()

    // Confirmation dialog should show the count (2 todos)
    await expect(page.getByRole('dialog', { name: /Delete tag/ })).toBeVisible()
    await expect(page.getByText('2')).toBeVisible()
    await expect(page.getByText(/todos themselves will not be deleted/)).toBeVisible()

    // Confirm deletion
    await page.getByRole('button', { name: 'Delete' }).last().click()

    // Close manager
    await page.getByLabel('Close tag manager').click()

    // Tag badges should be gone
    await expect(page.getByText('todelete')).not.toBeVisible({ timeout: 3000 })

    // Todos themselves must still be present
    await expect(page.getByText('First tagged')).toBeVisible()
    await expect(page.getByText('Second tagged')).toBeVisible()

    // Tag no longer exists in API
    const tagsRes = await page.request.get('/api/tags')
    const tagsJson = await tagsRes.json()
    expect(tagsJson.data.find((t: { id: number }) => t.id === tag.id)).toBeUndefined()
  })

  // TC-T07: Filter by single tag
  test('TC-T07: Filter by single tag shows only matching todos', async ({ page }) => {
    const tagRes = await page.request.post('/api/tags', { data: { name: 'alpha', color: '#06B6D4' } })
    const tag = (await tagRes.json()).data
    const todo1 = await h.createTodo({ title: 'Todo with alpha' })
    await h.createTodo({ title: 'Todo without tag' })
    await page.request.post(`/api/todos/${todo1.id}/tags`, { data: { tagIds: [tag.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Click the 'alpha' tag chip in the filter bar
    await page.getByRole('button', { name: 'alpha' }).first().click()

    // Only the tagged todo should appear
    await expect(page.getByText('Todo with alpha')).toBeVisible()
    await expect(page.getByText('Todo without tag')).not.toBeVisible({ timeout: 3000 })
  })

  // TC-T08: Filter by two tags — OR logic
  test('TC-T08: Filter by two tags uses OR logic', async ({ page }) => {
    const tagARes = await page.request.post('/api/tags', { data: { name: 'tagA', color: '#3B82F6' } })
    const tagBRes = await page.request.post('/api/tags', { data: { name: 'tagB', color: '#8B5CF6' } })
    const tagA = (await tagARes.json()).data
    const tagB = (await tagBRes.json()).data

    const todo1 = await h.createTodo({ title: 'Only tagA' })
    const todo2 = await h.createTodo({ title: 'Only tagB' })
    await h.createTodo({ title: 'No tag' })

    await page.request.post(`/api/todos/${todo1.id}/tags`, { data: { tagIds: [tagA.id] } })
    await page.request.post(`/api/todos/${todo2.id}/tags`, { data: { tagIds: [tagB.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Enable both tag filters
    await page.getByRole('button', { name: 'tagA' }).first().click()
    await page.getByRole('button', { name: 'tagB' }).first().click()

    // Both tagged todos should appear; untagged should not
    await expect(page.getByText('Only tagA')).toBeVisible()
    await expect(page.getByText('Only tagB')).toBeVisible()
    await expect(page.getByText('No tag')).not.toBeVisible({ timeout: 3000 })
  })

  // TC-T09: Combine tag filter with priority filter — AND logic
  test('TC-T09: Tag filter AND priority filter uses AND logic', async ({ page }) => {
    const tagRes = await page.request.post('/api/tags', { data: { name: 'urgent', color: '#EF4444' } })
    const tag = (await tagRes.json()).data

    const highTagged = await h.createTodo({ title: 'High + urgent', priority: 'high' })
    const lowTagged = await h.createTodo({ title: 'Low + urgent', priority: 'low' })
    const highNoTag = await h.createTodo({ title: 'High no tag', priority: 'high' })

    await page.request.post(`/api/todos/${highTagged.id}/tags`, { data: { tagIds: [tag.id] } })
    await page.request.post(`/api/todos/${lowTagged.id}/tags`, { data: { tagIds: [tag.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Apply priority filter = High
    await page.locator('#priority-filter').selectOption('high')

    // Apply tag filter = urgent
    await page.getByRole('button', { name: 'urgent' }).first().click()

    // Only "High + urgent" should be visible
    await expect(page.getByText('High + urgent')).toBeVisible()
    await expect(page.getByText('Low + urgent')).not.toBeVisible({ timeout: 3000 })
    await expect(page.getByText('High no tag')).not.toBeVisible({ timeout: 3000 })
  })

  // TC-T10: Clear tag filters restores full list
  test('TC-T10: Clear tag filters restores full todo list', async ({ page }) => {
    const tagRes = await page.request.post('/api/tags', { data: { name: 'clearme', color: '#84CC16' } })
    const tag = (await tagRes.json()).data
    const todo1 = await h.createTodo({ title: 'Tagged' })
    await h.createTodo({ title: 'Untagged' })
    await page.request.post(`/api/todos/${todo1.id}/tags`, { data: { tagIds: [tag.id] } })

    await page.reload()
    await page.waitForLoadState('networkidle')

    // Apply filter
    await page.getByRole('button', { name: 'clearme' }).first().click()
    await expect(page.getByText('Untagged')).not.toBeVisible({ timeout: 3000 })

    // Clear
    await page.getByRole('button', { name: 'Clear tags' }).click()
    await expect(page.getByText('Tagged')).toBeVisible()
    await expect(page.getByText('Untagged')).toBeVisible()
  })
})
