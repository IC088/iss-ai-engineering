// tests/unit/tags.test.ts
// Unit tests for PRP 06 — Tag System
// Covers: tag name validation, color hex validation, groupTagsByTodoId helper,
// and tag filter OR logic.

import { describe, it, expect } from 'vitest'
import { validateTagName, validateTagColor, groupTagsByTodoId } from '@/lib/db'
import type { Tag } from '@/lib/db'

// ---------------------------------------------------------------------------
// validateTagName
// ---------------------------------------------------------------------------
describe('validateTagName', () => {
  it('accepts a valid tag name', () => {
    expect(validateTagName('work')).toBe('work')
  })

  it('trims whitespace from valid names', () => {
    expect(validateTagName('  billing  ')).toBe('billing')
  })

  it('accepts name at exactly 30 characters', () => {
    const name = 'a'.repeat(30)
    expect(validateTagName(name)).toBe(name)
  })

  it('throws TAG_NAME_REQUIRED for empty string', () => {
    expect(() => validateTagName('')).toThrow()
    try {
      validateTagName('')
    } catch (e) {
      expect((e as { code: string }).code).toBe('TAG_NAME_REQUIRED')
    }
  })

  it('throws TAG_NAME_REQUIRED for whitespace-only string', () => {
    expect(() => validateTagName('   ')).toThrow()
    try {
      validateTagName('   ')
    } catch (e) {
      expect((e as { code: string }).code).toBe('TAG_NAME_REQUIRED')
    }
  })

  it('throws TAG_NAME_TOO_LONG for name exceeding 30 characters', () => {
    const long = 'a'.repeat(31)
    expect(() => validateTagName(long)).toThrow()
    try {
      validateTagName(long)
    } catch (e) {
      expect((e as { code: string }).code).toBe('TAG_NAME_TOO_LONG')
    }
  })

  it('throws TAG_NAME_REQUIRED for non-string input', () => {
    expect(() => validateTagName(42)).toThrow()
    expect(() => validateTagName(null)).toThrow()
    expect(() => validateTagName(undefined)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// validateTagColor
// ---------------------------------------------------------------------------
describe('validateTagColor', () => {
  it('accepts valid 6-digit lowercase hex', () => {
    expect(validateTagColor('#3b82f6')).toBe('#3b82f6')
  })

  it('accepts valid 6-digit uppercase hex', () => {
    expect(validateTagColor('#EF4444')).toBe('#EF4444')
  })

  it('accepts mixed-case hex', () => {
    expect(validateTagColor('#3B82F6')).toBe('#3B82F6')
  })

  it('throws INVALID_TAG_COLOR for missing #', () => {
    expect(() => validateTagColor('3b82f6')).toThrow()
    try {
      validateTagColor('3b82f6')
    } catch (e) {
      expect((e as { code: string }).code).toBe('INVALID_TAG_COLOR')
    }
  })

  it('throws INVALID_TAG_COLOR for 3-digit short hex', () => {
    expect(() => validateTagColor('#fff')).toThrow()
    try {
      validateTagColor('#fff')
    } catch (e) {
      expect((e as { code: string }).code).toBe('INVALID_TAG_COLOR')
    }
  })

  it('throws INVALID_TAG_COLOR for 8-digit hex', () => {
    expect(() => validateTagColor('#3b82f6ff')).toThrow()
  })

  it('throws INVALID_TAG_COLOR for invalid characters', () => {
    expect(() => validateTagColor('#GGGGGG')).toThrow()
  })

  it('throws INVALID_TAG_COLOR for non-string input', () => {
    expect(() => validateTagColor(null)).toThrow()
    expect(() => validateTagColor(0x3b82f6)).toThrow()
  })

  it('throws INVALID_TAG_COLOR for empty string', () => {
    expect(() => validateTagColor('')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// groupTagsByTodoId
// ---------------------------------------------------------------------------
describe('groupTagsByTodoId', () => {
  const makeTag = (id: number, name: string): Tag => ({
    id,
    user_id: 1,
    name,
    color: '#000000',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
  })

  it('returns empty arrays for all todoIds when rows is empty', () => {
    const result = groupTagsByTodoId([], [1, 2, 3])
    expect(result.get(1)).toEqual([])
    expect(result.get(2)).toEqual([])
    expect(result.get(3)).toEqual([])
  })

  it('groups tags correctly by todo_id', () => {
    const rows = [
      { todo_id: 1, ...makeTag(10, 'work') },
      { todo_id: 1, ...makeTag(20, 'urgent') },
      { todo_id: 2, ...makeTag(10, 'work') },
    ]
    const result = groupTagsByTodoId(rows, [1, 2])
    expect(result.get(1)?.map((t) => t.id)).toEqual([10, 20])
    expect(result.get(2)?.map((t) => t.id)).toEqual([10])
  })

  it('returns empty array (not undefined) for todos with no tags', () => {
    const rows = [{ todo_id: 1, ...makeTag(10, 'work') }]
    const result = groupTagsByTodoId(rows, [1, 2, 3])
    expect(result.get(2)).toEqual([])
    expect(result.get(3)).toEqual([])
  })

  it('initializes every todoId in the map even if not in rows', () => {
    const result = groupTagsByTodoId([], [99, 100])
    expect(result.has(99)).toBe(true)
    expect(result.has(100)).toBe(true)
    expect(result.get(99)).toEqual([])
  })

  it('does not add entries for todoIds not in the initial list', () => {
    const rows = [{ todo_id: 5, ...makeTag(10, 'personal') }]
    // todoIds does not include 5
    const result = groupTagsByTodoId(rows, [1])
    expect(result.has(5)).toBe(false)
    expect(result.get(1)).toEqual([])
  })

  it('handles a single todo with multiple tags', () => {
    const rows = [
      { todo_id: 7, ...makeTag(1, 'a') },
      { todo_id: 7, ...makeTag(2, 'b') },
      { todo_id: 7, ...makeTag(3, 'c') },
    ]
    const result = groupTagsByTodoId(rows, [7])
    expect(result.get(7)?.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Tag filter OR logic (pure client-side equivalent, mirrors useSectionedTodos)
// ---------------------------------------------------------------------------
describe('tag filter OR logic', () => {
  type SimpleTodo = { id: number; tagIds: number[] }

  function filterByTags(todos: SimpleTodo[], activeTagIds: number[]): SimpleTodo[] {
    if (activeTagIds.length === 0) return todos
    return todos.filter((t) => t.tagIds.some((id) => activeTagIds.includes(id)))
  }

  const todos: SimpleTodo[] = [
    { id: 1, tagIds: [10] },
    { id: 2, tagIds: [20] },
    { id: 3, tagIds: [10, 20] },
    { id: 4, tagIds: [] },
  ]

  it('returns all todos when no tag filter is active', () => {
    expect(filterByTags(todos, []).length).toBe(4)
  })

  it('returns only todos matching a single tag', () => {
    const result = filterByTags(todos, [10])
    expect(result.map((t) => t.id)).toEqual([1, 3])
  })

  it('returns union of todos matching either tag (OR logic)', () => {
    const result = filterByTags(todos, [10, 20])
    expect(result.map((t) => t.id)).toEqual([1, 2, 3])
  })

  it('excludes todos with no tags when a filter is active', () => {
    const result = filterByTags(todos, [10])
    expect(result.find((t) => t.id === 4)).toBeUndefined()
  })

  it('returns empty array when no todos match the filter', () => {
    expect(filterByTags(todos, [99]).length).toBe(0)
  })

  it('returns correct results when filtering by a non-existent tag', () => {
    expect(filterByTags(todos, [999]).length).toBe(0)
  })
})
