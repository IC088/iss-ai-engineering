'use client'

// app/page.tsx
// Monolithic client component for the main todo page.
// All data flows through API routes — never import lib/db.ts here.
// Implements PRP 01 (Todo CRUD) and PRP 02 (Priority System).

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import type { Todo, Priority, RecurrencePattern, Subtask, Tag, TodoWithTags, Template, SubtaskTemplate } from '@/lib/db'
import {
  getSingaporeNow,
  formatRelativeDueDate,
  formatForDatetimeLocalInput,
  getMinDueDateForPicker,
} from '@/lib/timezone'
import { useNotifications } from '@/lib/hooks/useNotifications'

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function capitalize(str: string | null | undefined): string {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// PRP 04 — Reminder options (inlined for client bundle compatibility; canonical source: lib/db.ts)
const REMINDER_OPTIONS: { label: string; minutes: number }[] = [
  { label: '15 minutes before', minutes: 15 },
  { label: '30 minutes before', minutes: 30 },
  { label: '1 hour before',     minutes: 60 },
  { label: '2 hours before',    minutes: 120 },
  { label: '1 day before',      minutes: 1440 },
  { label: '2 days before',     minutes: 2880 },
  { label: '1 week before',     minutes: 10080 },
]

function shortLabelFor(minutes: number): string {
  const map: Record<number, string> = {
    15: '15m', 30: '30m', 60: '1h', 120: '2h', 1440: '1d', 2880: '2d', 10080: '1w',
  }
  return map[minutes] ?? `${minutes}m`
}

// ---------------------------------------------------------------------------
// PRP 02 — Priority constants
// Canonical source: lib/db.ts. Inlined here for client bundle compatibility
// (client components cannot import the server-only better-sqlite3 module graph).
// ---------------------------------------------------------------------------
const PRIORITY_ORDER: Record<Priority, number> = { high: 3, medium: 2, low: 1 }

// Fixed color mapping per PRP 02 §5.1 — must not be changed without updating the PRP
const PRIORITY_CLASSES: Record<Priority, string> = {
  high: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  low: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
}

const PRIORITY_LABELS: Record<Priority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

// ---------------------------------------------------------------------------
// PRP 06 — Tag System constants and utilities
// ---------------------------------------------------------------------------
const TAG_PRESET_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#84CC16', '#10B981',
  '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280',
]

/**
 * Returns a readable text color (#111827 or #ffffff) for a given hex background.
 * Computed via WCAG 2.1 relative luminance so it works for any valid hex color.
 */
function getContrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const toLinear = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
  return L > 0.179 ? '#111827' : '#ffffff'
}

// ---------------------------------------------------------------------------
// TagBadge — PRP 06 §5.1
// ---------------------------------------------------------------------------
interface TagBadgeProps {
  tag: Tag
  onRemove?: () => void
  size?: 'sm' | 'md'
  active?: boolean
  onClick?: () => void
}

function TagBadge({ tag, onRemove, size = 'sm', active, onClick }: TagBadgeProps) {
  const textColor = getContrastColor(tag.color)
  const sizeClasses = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1'
  const interactiveClasses = onClick ? 'cursor-pointer hover:opacity-85 transition-opacity' : ''
  const activeRing = active ? 'ring-2 ring-offset-1 ring-gray-400' : ''

  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full font-medium ${sizeClasses} ${interactiveClasses} ${activeRing}`}
      style={{ backgroundColor: tag.color, color: textColor }}
      title={tag.name.length > 20 ? tag.name : undefined}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-pressed={active !== undefined ? active : undefined}
    >
      <span className="truncate max-w-[100px]">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove() }}
          aria-label={`Remove tag ${tag.name}`}
          className="ml-0.5 leading-none hover:opacity-75 flex-shrink-0"
        >
          ×
        </button>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// TagPicker — PRP 06 §5.2
// Searchable multi-select dropdown used in todo create/edit forms.
// ---------------------------------------------------------------------------
interface TagPickerProps {
  selectedTags: Tag[]
  onChange: (tags: Tag[]) => void
  allTags: Tag[]
  onCreateTag: (name: string, color: string) => Promise<Tag>
}

function TagPicker({ selectedTags, onChange, allTags, onCreateTag }: TagPickerProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const [pendingColor, setPendingColor] = useState(TAG_PRESET_COLORS[6])
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const trimmed = search.trim()
  const selectedIds = useMemo(() => new Set(selectedTags.map((t) => t.id)), [selectedTags])

  const filtered = useMemo(
    () =>
      allTags.filter(
        (t) =>
          t.name.toLowerCase().includes(trimmed.toLowerCase()) && !selectedIds.has(t.id)
      ),
    [allTags, trimmed, selectedIds]
  )

  const exactMatch = useMemo(
    () => allTags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase()),
    [allTags, trimmed]
  )

  const canCreate = trimmed.length > 0 && trimmed.length <= 30 && !exactMatch

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setShowColorPicker(false)
        setSearch('')
        setCreateError(null)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function selectTag(tag: Tag) {
    onChange([...selectedTags, tag])
    setSearch('')
    setCreateError(null)
  }

  function removeTag(tag: Tag) {
    onChange(selectedTags.filter((t) => t.id !== tag.id))
  }

  async function confirmCreate() {
    if (!canCreate) return
    setIsCreating(true)
    setCreateError(null)
    try {
      const tag = await onCreateTag(trimmed, pendingColor)
      onChange([...selectedTags, tag])
      setSearch('')
      setShowColorPicker(false)
      setIsOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create tag'
      if (msg.includes('already exists')) {
        const existing = allTags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase())
        if (existing && !selectedIds.has(existing.id)) {
          setCreateError(`"${existing.name}" already exists — click it to select.`)
        } else {
          setCreateError(msg)
        }
      } else {
        setCreateError(msg)
      }
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div
        className="flex flex-wrap gap-1 border rounded px-2 py-1.5 cursor-text min-h-[36px] dark:bg-gray-700 dark:border-gray-600 focus-within:ring-2 focus-within:ring-blue-500"
        onClick={() => setIsOpen(true)}
      >
        {selectedTags.map((t) => (
          <TagBadge key={t.id} tag={t} onRemove={() => removeTag(t)} />
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setIsOpen(true); setCreateError(null) }}
          onFocus={() => setIsOpen(true)}
          placeholder={selectedTags.length === 0 ? 'Add tags…' : ''}
          maxLength={30}
          aria-label="Tag search"
          className="flex-1 min-w-[80px] bg-transparent text-xs outline-none"
        />
      </div>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {filtered.map((t) => (
            <button
              key={t.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); selectTag(t) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 text-left"
            >
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: t.color }}
              />
              {t.name}
            </button>
          ))}

          {exactMatch && selectedIds.has(exactMatch.id) && (
            <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
              &quot;{exactMatch.name}&quot; already added
            </div>
          )}

          {exactMatch && !selectedIds.has(exactMatch.id) && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); selectTag(exactMatch) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 text-left"
            >
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: exactMatch.color }} />
              {exactMatch.name}
            </button>
          )}

          {canCreate && !showColorPicker && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setShowColorPicker(true) }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-left"
            >
              <span className="text-base leading-none">+</span>
              Create &quot;{trimmed}&quot;
            </button>
          )}

          {showColorPicker && canCreate && (
            <div className="p-3 border-t border-gray-100 dark:border-gray-700">
              <p className="text-xs text-gray-500 mb-2">Pick a color for &quot;{trimmed}&quot;</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {TAG_PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setPendingColor(c)}
                    className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${pendingColor === c ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`}
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
              {createError && <p className="text-xs text-red-600 mb-2">{createError}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={confirmCreate}
                  disabled={isCreating}
                  className="flex-1 px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                >
                  {isCreating ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setShowColorPicker(false); setCreateError(null) }}
                  className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Back
                </button>
              </div>
            </div>
          )}

          {filtered.length === 0 && !canCreate && !exactMatch && (
            <div className="px-3 py-2 text-xs text-gray-400 dark:text-gray-500">
              {trimmed ? 'No matching tags' : 'No tags yet — type to create one'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TagFilterBar — PRP 06 §5.4
// ---------------------------------------------------------------------------
interface TagFilterBarProps {
  allTags: Tag[]
  activeTagIds: number[]
  onToggleTag: (id: number) => void
  onClear: () => void
}

function TagFilterBar({ allTags, activeTagIds, onToggleTag, onClear }: TagFilterBarProps) {
  if (allTags.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">Tags:</span>
      {allTags.map((tag) => (
        <TagBadge
          key={tag.id}
          tag={tag}
          active={activeTagIds.includes(tag.id)}
          onClick={() => onToggleTag(tag.id)}
          size="sm"
        />
      ))}
      {activeTagIds.length > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline ml-1"
        >
          Clear tags
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TagManager — PRP 06 §5.3
// Modal listing all tags with inline rename, recolor palette, and delete.
// ---------------------------------------------------------------------------
interface TagManagerProps {
  tags: (Tag & { todo_count: number })[]
  onRename: (id: number, name: string) => Promise<void>
  onRecolor: (id: number, color: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
  onClose: () => void
}

function TagManager({ tags, onRename, onRecolor, onDelete, onClose }: TagManagerProps) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const deletingTag = tags.find((t) => t.id === deletingId)

  async function submitRename(id: number) {
    const name = editName.trim()
    if (!name) { setEditError('Name is required'); return }
    if (name.length > 30) { setEditError('Max 30 characters'); return }
    setIsSaving(true)
    setEditError(null)
    try {
      await onRename(id, name)
      setEditingId(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to rename')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tag-manager-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 id="tag-manager-title" className="text-lg font-semibold">Manage Tags</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close tag manager"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {tags.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
            No tags yet. Create tags by adding them to a todo.
          </p>
        ) : (
          <ul className="space-y-2 overflow-y-auto flex-1">
            {tags.map((tag) => (
              <li
                key={tag.id}
                className="flex items-center gap-2 py-2 border-b border-gray-100 dark:border-gray-700 last:border-0"
              >
                {/* Color swatch + preset palette */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {TAG_PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => onRecolor(tag.id, c)}
                      className={`w-3.5 h-3.5 rounded-full transition-transform hover:scale-110 ${tag.color === c ? 'ring-1 ring-offset-1 ring-gray-400' : ''}`}
                      style={{ backgroundColor: c }}
                      aria-label={`Set color ${c} for ${tag.name}`}
                    />
                  ))}
                </div>

                {editingId === tag.id ? (
                  <div className="flex-1 flex items-center gap-1">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => { setEditName(e.target.value); setEditError(null) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename(tag.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      maxLength={30}
                      autoFocus
                      aria-label={`Rename tag ${tag.name}`}
                      className="flex-1 border rounded px-2 py-0.5 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => submitRename(tag.id)}
                      disabled={isSaving}
                      className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingId(null); setEditError(null) }}
                      className="px-2 py-0.5 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Cancel
                    </button>
                    {editError && <p className="text-xs text-red-600 ml-1">{editError}</p>}
                  </div>
                ) : (
                  <>
                    <span
                      className="flex-1 text-sm truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                      onClick={() => { setEditingId(tag.id); setEditName(tag.name); setEditError(null) }}
                      title="Click to rename"
                    >
                      {tag.name}
                    </span>
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {tag.todo_count} {tag.todo_count === 1 ? 'todo' : 'todos'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDeletingId(tag.id)}
                      aria-label={`Delete tag ${tag.name}`}
                      className="text-xs text-gray-400 hover:text-red-600 transition-colors flex-shrink-0 px-1"
                    >
                      🗑
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {deletingTag && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-delete-title"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
            <h3 id="tag-delete-title" className="text-base font-semibold mb-2">
              Delete tag &quot;{deletingTag.name}&quot;?
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              This will remove &quot;<strong>{deletingTag.name}</strong>&quot; from{' '}
              <strong>{deletingTag.todo_count}</strong>{' '}
              {deletingTag.todo_count === 1 ? 'todo' : 'todos'}. The todos themselves will not be
              deleted.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setDeletingId(null)}
                className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  await onDelete(deletingTag.id)
                  setDeletingId(null)
                }}
                className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-700 text-white font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SaveAsTemplateModal — PRP 07 §5.2
// Opens from a todo row's action menu. Saves the todo as a reusable template.
// ---------------------------------------------------------------------------
function SaveAsTemplateModal({
  todo,
  onClose,
  onSaved,
  showError,
}: {
  todo: TodoWithTags
  onClose: () => void
  onSaved: () => void
  showError: (msg: string) => void
}) {
  const [name, setName] = useState(todo.title)
  const [category, setCategory] = useState('')
  const [dueOffsetDays, setDueOffsetDays] = useState('')
  const [subtasks, setSubtasks] = useState<SubtaskTemplate[]>([])
  const [loadingSubtasks, setLoadingSubtasks] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Load subtasks for the todo
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/todos/${todo.id}/subtasks`)
        if (!res.ok) return
        const json = await res.json()
        const loaded: Subtask[] = json.data ?? []
        setSubtasks(loaded.map((s) => ({ title: s.title, position: s.position })))
      } catch { /* non-fatal */ } finally {
        setLoadingSubtasks(false)
      }
    }
    load()
  }, [todo.id])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) { setFormError('Template name is required'); return }
    if (trimmedName.length > 200) { setFormError('Name must be 200 characters or less'); return }
    const categoryTrimmed = category.trim() || null
    if (categoryTrimmed && categoryTrimmed.length > 50) { setFormError('Category must be 50 characters or less'); return }

    let offsetDays: number | null = null
    if (dueOffsetDays.trim()) {
      const n = parseInt(dueOffsetDays, 10)
      if (isNaN(n) || n < 0 || n > 3650) { setFormError('Due offset must be 0–3650 days'); return }
      offsetDays = n
    }

    setIsSaving(true)
    setFormError(null)
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          category: categoryTrimmed,
          priority: todo.priority,
          recurrence: todo.recurrence ?? null,
          reminder_minutes: todo.reminder_minutes ?? null,
          due_offset_days: offsetDays,
          subtasks,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to save template')
      onSaved()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save template'
      setFormError(msg)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-template-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 overflow-y-auto max-h-[90vh]">
        <h2 id="save-template-title" className="text-lg font-semibold mb-4">Save as Template</h2>
        <form onSubmit={handleSave} className="flex flex-col gap-3">
          <div>
            <label htmlFor="tmpl-name" className="block text-sm font-medium mb-1">
              Template Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="tmpl-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="tmpl-category" className="block text-sm font-medium mb-1">Category</label>
            <input
              id="tmpl-category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={50}
              placeholder="e.g. Work, Personal"
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="tmpl-offset" className="block text-sm font-medium mb-1">
              Due Date Offset (days from creation)
            </label>
            <input
              id="tmpl-offset"
              type="number"
              value={dueOffsetDays}
              onChange={(e) => setDueOffsetDays(e.target.value)}
              min={0}
              max={3650}
              placeholder="Leave blank for no due date"
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {loadingSubtasks ? (
            <p className="text-xs text-gray-400">Loading subtasks…</p>
          ) : subtasks.length > 0 ? (
            <div>
              <p className="text-sm font-medium mb-1">Subtasks ({subtasks.length})</p>
              <ul className="space-y-1">
                {subtasks.map((s, i) => (
                  <li key={i} className="text-xs text-gray-600 dark:text-gray-300 flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-gray-400 flex-shrink-0" />
                    {s.title}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {formError && <p role="alert" className="text-xs text-red-600">{formError}</p>}
          <div className="flex gap-3 justify-end mt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving || !name.trim()}
              className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition-colors"
            >
              {isSaving ? 'Saving…' : 'Save Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TemplatePickerModal — PRP 07 §5.1
// Browse, filter by category, and create a todo from a template.
// ---------------------------------------------------------------------------
function TemplatePickerModal({
  templates,
  onClose,
  onCreated,
  showError,
  onManage,
}: {
  templates: Template[]
  onClose: () => void
  onCreated: (todo: TodoWithTags) => void
  showError: (msg: string) => void
  onManage: () => void
}) {
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const categories = useMemo(() => {
    const cats = new Set(templates.map((t) => t.category).filter(Boolean) as string[])
    return Array.from(cats).sort((a, b) => a.localeCompare(b))
  }, [templates])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return templates.filter((t) => {
      const matchesSearch = !q || t.name.toLowerCase().includes(q)
      const matchesCategory = categoryFilter === 'all' || t.category === categoryFilter
      return matchesSearch && matchesCategory
    })
  }, [templates, search, categoryFilter])

  const selectedTemplate = templates.find((t) => t.id === selectedId) ?? null

  async function handleCreate() {
    if (!selectedId) return
    setIsCreating(true)
    try {
      const res = await fetch(`/api/templates/${selectedId}/use`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to create todo')
      onCreated({ ...json.data, tags: [] })
      onClose()
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to create todo from template')
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-picker-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full p-6 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between mb-4">
          <h2 id="template-picker-title" className="text-lg font-semibold">Use Template</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onManage}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              Manage Templates
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close template picker"
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none ml-2"
            >
              ×
            </button>
          </div>
        </div>

        <div className="flex gap-2 mb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates"
            className="flex-1 border rounded px-3 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {categories.length > 0 && (
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              aria-label="Filter by category"
              className="border rounded px-2 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
            {templates.length === 0 ? 'No templates yet. Save a todo as a template to get started.' : 'No templates match the current filter.'}
          </p>
        ) : (
          <ul className="overflow-y-auto flex-1 space-y-1 mb-3">
            {filtered.map((t) => {
              const subtaskCount = (() => {
                try { return (JSON.parse(t.subtasks) as unknown[]).length } catch { return 0 }
              })()
              const isSelected = t.id === selectedId
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(isSelected ? null : t.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                      isSelected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-400'
                        : 'border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{t.name}</span>
                      {t.category && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex-shrink-0">
                          {t.category}
                        </span>
                      )}
                      <span className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${PRIORITY_CLASSES[t.priority]}`}>
                        {capitalize(t.priority)}
                      </span>
                      {subtaskCount > 0 && (
                        <span className="text-xs text-gray-400 flex-shrink-0">
                          {subtaskCount} subtask{subtaskCount !== 1 ? 's' : ''}
                        </span>
                      )}
                      {t.due_offset_days !== null && (
                        <span className="text-xs text-gray-400 flex-shrink-0">
                          +{t.due_offset_days}d
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {selectedTemplate && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-3 mb-3 text-xs text-gray-600 dark:text-gray-300 space-y-1">
            <p><strong>Priority:</strong> {capitalize(selectedTemplate.priority)}</p>
            {selectedTemplate.recurrence && <p><strong>Repeats:</strong> {capitalize(selectedTemplate.recurrence)}</p>}
            {selectedTemplate.due_offset_days !== null && (
              <p><strong>Due:</strong> {selectedTemplate.due_offset_days} day{selectedTemplate.due_offset_days !== 1 ? 's' : ''} after creation</p>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!selectedId || isCreating}
            className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition-colors"
          >
            {isCreating ? 'Creating…' : 'Create from Template'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ManageTemplatesModal — PRP 07 §5.3
// Lists all templates with edit and delete actions.
// ---------------------------------------------------------------------------
function ManageTemplatesModal({
  templates,
  onClose,
  onTemplatesChanged,
}: {
  templates: Template[]
  onClose: () => void
  onTemplatesChanged: () => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const deletingTemplate = templates.find((t) => t.id === deletingId)

  async function submitEdit(id: number) {
    const name = editName.trim()
    if (!name) { setEditError('Name is required'); return }
    if (name.length > 200) { setEditError('Max 200 characters'); return }
    const cat = editCategory.trim() || null
    if (cat && cat.length > 50) { setEditError('Category max 50 characters'); return }
    setIsSaving(true)
    setEditError(null)
    try {
      const res = await fetch(`/api/templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, category: cat }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to update template')
      onTemplatesChanged()
      setEditingId(null)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update template')
    } finally {
      setIsSaving(false)
    }
  }

  async function confirmDelete(id: number) {
    try {
      const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to delete template')
      onTemplatesChanged()
      setDeletingId(null)
    } catch { /* handled by state */ }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-templates-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 id="manage-templates-title" className="text-lg font-semibold">Manage Templates</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close template manager"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {templates.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
            No templates yet. Save a todo as a template to get started.
          </p>
        ) : (
          <ul className="space-y-2 overflow-y-auto flex-1">
            {templates.map((t) => {
              const subtaskCount = (() => {
                try { return (JSON.parse(t.subtasks) as unknown[]).length } catch { return 0 }
              })()
              return (
                <li
                  key={t.id}
                  className="py-2 border-b border-gray-100 dark:border-gray-700 last:border-0"
                >
                  {editingId === t.id ? (
                    <div className="flex flex-col gap-1.5">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => { setEditName(e.target.value); setEditError(null) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); submitEdit(t.id) }
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        maxLength={200}
                        autoFocus
                        aria-label="Template name"
                        placeholder="Template name"
                        className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        type="text"
                        value={editCategory}
                        onChange={(e) => { setEditCategory(e.target.value); setEditError(null) }}
                        maxLength={50}
                        aria-label="Category"
                        placeholder="Category (optional)"
                        className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      {editError && <p className="text-xs text-red-600">{editError}</p>}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => submitEdit(t.id)}
                          disabled={isSaving}
                          className="px-3 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingId(null); setEditError(null) }}
                          className="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <span
                          className="text-sm font-medium truncate block cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                          onClick={() => { setEditingId(t.id); setEditName(t.name); setEditCategory(t.category ?? ''); setEditError(null) }}
                          title="Click to edit"
                        >
                          {t.name}
                        </span>
                        <div className="flex gap-1.5 mt-0.5 flex-wrap">
                          {t.category && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                              {t.category}
                            </span>
                          )}
                          <span className="text-xs text-gray-400">{subtaskCount} subtask{subtaskCount !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => { setEditingId(t.id); setEditName(t.name); setEditCategory(t.category ?? ''); setEditError(null) }}
                          aria-label={`Edit template ${t.name}`}
                          className="text-xs text-gray-400 hover:text-blue-600 transition-colors px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingId(t.id)}
                          aria-label={`Delete template ${t.name}`}
                          className="text-xs text-gray-400 hover:text-red-600 transition-colors px-1"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {deletingTemplate && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tmpl-delete-title"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
        >
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
            <h3 id="tmpl-delete-title" className="text-base font-semibold mb-2">
              Delete template &quot;{deletingTemplate.name}&quot;?
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              This will permanently delete the template. Todos created from it will not be affected.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setDeletingId(null)}
                className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => confirmDelete(deletingTemplate.id)}
                className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-700 text-white font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ImportModal — PRP 09 §5 (Import feature)
// ---------------------------------------------------------------------------
interface ImportPreview {
  todos: number
  subtasks: number
  tags: number
}

function ImportModal({
  onClose,
  onImported,
  showError,
}: {
  onClose: () => void
  onImported: () => void
  showError: (msg: string) => void
}) {
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<string[]>([])
  const [isImporting, setIsImporting] = useState(false)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setParseError(null)
    setValidationErrors([])
    setPreview(null)
    setFileContent(null)
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      try {
        const parsed = JSON.parse(text)
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          Array.isArray(parsed.todos) &&
          Array.isArray(parsed.subtasks) &&
          Array.isArray(parsed.tags)
        ) {
          setPreview({
            todos: (parsed.todos as unknown[]).length,
            subtasks: (parsed.subtasks as unknown[]).length,
            tags: (parsed.tags as unknown[]).length,
          })
          setFileContent(text)
        } else {
          setParseError('File is missing required fields (todos, subtasks, tags).')
        }
      } catch {
        setParseError('Invalid JSON file. Please select a valid export file.')
      }
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    if (!fileContent) return
    setIsImporting(true)
    setValidationErrors([])
    try {
      const res = await fetch('/api/todos/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: fileContent,
      })
      const json = await res.json()
      if (!res.ok) {
        if (res.status === 400 && json.error?.errors) {
          setValidationErrors(json.error.errors as string[])
        } else {
          showError(json.error?.message ?? 'Import failed')
          onClose()
        }
        return
      }
      const { imported } = json as { imported: ImportPreview }
      showError(`Imported ${imported.todos} todos, ${imported.subtasks} subtasks, ${imported.tags} tags.`)
      onImported()
      onClose()
    } catch {
      showError('Import failed. Please try again.')
      onClose()
    } finally {
      setIsImporting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 id="import-modal-title" className="text-lg font-semibold">Import Todos</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close import modal"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <div>
            <label htmlFor="import-file" className="block text-sm font-medium mb-1">
              Select export file (.json)
            </label>
            <input
              id="import-file"
              type="file"
              accept=".json"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 dark:file:bg-blue-900/30 dark:file:text-blue-300"
            />
          </div>

          {parseError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">{parseError}</p>
          )}

          {preview && (
            <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3 text-sm">
              <p className="font-medium mb-1 text-gray-700 dark:text-gray-200">Preview</p>
              <ul className="space-y-0.5 text-gray-600 dark:text-gray-300">
                <li>{preview.todos} todo{preview.todos !== 1 ? 's' : ''}</li>
                <li>{preview.subtasks} subtask{preview.subtasks !== 1 ? 's' : ''}</li>
                <li>{preview.tags} tag{preview.tags !== 1 ? 's' : ''}</li>
              </ul>
            </div>
          )}

          {validationErrors.length > 0 && (
            <div role="alert" className="rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3">
              <p className="text-sm font-medium text-red-700 dark:text-red-400 mb-1">
                Validation errors:
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                {validationErrors.map((e, i) => (
                  <li key={i} className="text-xs text-red-600 dark:text-red-400">{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={!fileContent || isImporting}
              className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition-colors"
            >
              {isImporting ? 'Importing…' : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PriorityBadge — PRP 02 §5.1
// Renders text label + aria-label so color is never the only signal (WCAG 1.4.1)
// ---------------------------------------------------------------------------
function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_CLASSES[priority]}`}
      aria-label={`Priority: ${PRIORITY_LABELS[priority]}`}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  )
}

// ---------------------------------------------------------------------------
// useSectionedTodos — PRP 01 §5.2 + PRP 02 §5.4 (priority filter) + PRP 06 (tag filter)
// ---------------------------------------------------------------------------
function useSectionedTodos(
  todos: TodoWithTags[],
  priorityFilter: Priority | 'all',
  activeTagIds: number[]
) {
  return useMemo(() => {
    const now = getSingaporeNow()

    // PRP 02: apply priority filter
    let filtered: TodoWithTags[] =
      priorityFilter === 'all' ? todos : todos.filter((t) => t.priority === priorityFilter)

    // PRP 06: apply tag filter (OR logic across selected tag IDs, AND with priority)
    if (activeTagIds.length > 0) {
      filtered = filtered.filter((t) =>
        t.tags.some((tag) => activeTagIds.includes(tag.id))
      )
    }

    // Overdue: incomplete, due_date in the past — sort by due_date ASC then priority DESC
    const overdue = filtered
      .filter((t) => !t.completed && t.due_date && new Date(t.due_date) < now)
      .sort((a, b) => {
        const dateDiff = new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime()
        return dateDiff !== 0 ? dateDiff : PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]
      })

    // Active: incomplete, no due_date or due_date in the future — sort by priority DESC then due_date ASC (nulls last)
    const active = filtered
      .filter((t) => !t.completed && (!t.due_date || new Date(t.due_date) >= now))
      .sort((a, b) => {
        const priDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]
        if (priDiff !== 0) return priDiff
        if (!a.due_date && !b.due_date) return 0
        if (!a.due_date) return 1 // nulls last
        if (!b.due_date) return -1
        return new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
      })

    // Completed: sort by updated_at DESC (most recently completed first)
    const completed = filtered
      .filter((t) => !!t.completed)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())

    return { overdue, active, completed }
  }, [todos, priorityFilter, activeTagIds])
}

// ---------------------------------------------------------------------------
// DueDateDisplay — renders the relative/absolute due date per PRP 01 §5.3
// ---------------------------------------------------------------------------
function DueDateDisplay({ todo }: { todo: Todo }) {
  if (!todo.due_date && !todo.completed) return null

  // For completed todos, show "Completed X ago" based on updated_at
  if (todo.completed) {
    const result = formatRelativeDueDate(todo.updated_at, true)
    if (!result) return null
    return <span className={`text-xs ${result.colorClass}`}>{result.text}</span>
  }

  const result = formatRelativeDueDate(todo.due_date, false)
  if (!result) return null
  return <span className={`text-xs ${result.colorClass}`}>{result.text}</span>
}

// ---------------------------------------------------------------------------
// ErrorToast — PRP 01 §5.6
// ---------------------------------------------------------------------------
function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-4 right-4 z-50 max-w-sm bg-red-600 text-white text-sm rounded-lg px-4 py-3 shadow-lg flex items-center gap-2"
    >
      <span>{message}</span>
      <button onClick={onDismiss} aria-label="Dismiss error" className="ml-auto text-white/80 hover:text-white">
        ✕
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DeleteConfirmDialog — PRP 01 §5.5
// Exact copy per PRP: "Delete todo?" / "permanently delete … and all its subtasks"
// ---------------------------------------------------------------------------
function DeleteConfirmDialog({
  todo,
  onConfirm,
  onCancel,
}: {
  todo: TodoWithTags
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
        <h2 id="delete-dialog-title" className="text-lg font-semibold mb-2">
          Delete todo?
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
          This will permanently delete <strong>&quot;{todo.title}&quot;</strong> and all its
          subtasks. This action cannot be undone.
        </p>
        <div className="flex gap-3 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-700 text-white font-medium transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// EditTodoModal — PRP 01 §5.4 + PRP 02 §5.3 (priority dropdown)
// ---------------------------------------------------------------------------
function EditTodoModal({
  todo,
  onClose,
  onUpdated,
  showError,
  allTags,
  onCreateTag,
}: {
  todo: TodoWithTags
  onClose: () => void
  onUpdated: (updated: TodoWithTags) => void
  showError: (msg: string) => void
  allTags: Tag[]
  onCreateTag: (name: string, color: string) => Promise<Tag>
}) {
  const [title, setTitle] = useState(todo.title)
  const [dueDate, setDueDate] = useState(
    todo.due_date ? formatForDatetimeLocalInput(todo.due_date) : ''
  )
  const [priority, setPriority] = useState<Priority>(todo.priority)
  // PRP 03 — recurrence state (mirrors todo.recurrence)
  const [isRecurring, setIsRecurring] = useState(todo.recurrence !== null)
  const [recurrencePattern, setRecurrencePattern] = useState<RecurrencePattern>(
    todo.recurrence ?? 'weekly'
  )
  const [reminderMinutes, setReminderMinutes] = useState<number | null>(todo.reminder_minutes ?? null)
  // PRP 06 — tag state
  const [selectedTags, setSelectedTags] = useState<Tag[]>(todo.tags ?? [])
  const originalTagIds = useRef(new Set(todo.tags?.map((t) => t.id) ?? []))
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return

    const snapshot = { ...todo, tags: todo.tags ?? [] }
    const nextRecurrence = isRecurring ? recurrencePattern : null

    // Optimistic update with current tag selection
    onUpdated({ ...todo, title: title.trim(), due_date: dueDate || null, priority, recurrence: nextRecurrence, reminder_minutes: reminderMinutes, tags: selectedTags })
    onClose()
    setIsSubmitting(true)

    try {
      const res = await fetch(`/api/todos/${todo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          due_date: dueDate || null,
          priority,
          recurrence: nextRecurrence,
          reminder_minutes: reminderMinutes,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to update todo')

      // Sync tag changes: attach new, detach removed
      const newTagIds = new Set(selectedTags.map((t) => t.id))
      const toAttach = selectedTags.filter((t) => !originalTagIds.current.has(t.id))
      const toDetach = [...originalTagIds.current].filter((id) => !newTagIds.has(id))

      if (toAttach.length > 0) {
        await fetch(`/api/todos/${todo.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagIds: toAttach.map((t) => t.id) }),
        })
      }
      for (const tagId of toDetach) {
        await fetch(`/api/todos/${todo.id}/tags/${tagId}`, { method: 'DELETE' })
      }

      // Server response doesn't include tags — preserve the selected tags from state
      onUpdated({ ...json.data, tags: selectedTags })
    } catch (err) {
      onUpdated(snapshot) // rollback
      showError(err instanceof Error ? err.message : 'Failed to update todo')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6 overflow-y-auto max-h-[90vh]">
        <h2 id="edit-modal-title" className="text-lg font-semibold mb-4">
          Edit Todo
        </h2>
        <form onSubmit={handleUpdate} className="flex flex-col gap-3">
          <div>
            <label htmlFor="edit-title" className="block text-sm font-medium mb-1">
              Title <span aria-hidden="true">*</span>
            </label>
            <input
              id="edit-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label htmlFor="edit-due-date" className="block text-sm font-medium mb-1">
              Due date
            </label>
            <input
              id="edit-due-date"
              type="datetime-local"
              value={dueDate}
              onChange={(e) => {
                setDueDate(e.target.value)
                if (!e.target.value) {
                  setIsRecurring(false)
                  setReminderMinutes(null)
                }
              }}
              min={getMinDueDateForPicker()}
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {/* PRP 03 §5.1 — Repeat toggle + pattern select */}
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isRecurring}
                onChange={(e) => {
                  setIsRecurring(e.target.checked)
                  if (!e.target.checked) setRecurrencePattern('weekly')
                }}
                disabled={!dueDate}
                aria-label="Repeat this todo"
              />
              <span className="text-sm font-medium">Repeat</span>
            </label>
            {isRecurring && (
              <select
                value={recurrencePattern}
                onChange={(e) => setRecurrencePattern(e.target.value as RecurrencePattern)}
                aria-label="Recurrence pattern"
                className="mt-1 w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            )}
          </div>          {/* PRP 04 §5.2 — Reminder dropdown */}
          <div>
            <label htmlFor="edit-reminder" className="block text-sm font-medium mb-1">Reminder</label>
            <select
              id="edit-reminder"
              value={reminderMinutes ?? ''}
              onChange={(e) => setReminderMinutes(e.target.value ? Number(e.target.value) : null)}
              disabled={!dueDate}
              aria-label="Reminder"
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">No reminder</option>
              {REMINDER_OPTIONS.map((o) => (
                <option key={o.minutes} value={o.minutes}>{o.label}</option>
              ))}
            </select>
          </div>          <div>
            {/* PRP 02 §5.3 — priority dropdown pre-filled from todo.priority */}
            <label htmlFor="edit-priority" className="block text-sm font-medium mb-1">
              Priority
            </label>
            <select
              id="edit-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              aria-label="Priority"
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          {/* PRP 06 §5.2 — Tag picker */}
          <div>
            <label className="block text-sm font-medium mb-1">Tags</label>
            <TagPicker
              selectedTags={selectedTags}
              onChange={setSelectedTags}
              allTags={allTags}
              onCreateTag={onCreateTag}
            />
          </div>
          <div className="flex gap-3 justify-end mt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !title.trim()}
              className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition-colors"
            >
              Update
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// TodoRow — PRP 01 §5.3 + PRP 02 §5.5 (PriorityBadge) + PRP 05 §5.1 (subtasks)
// ---------------------------------------------------------------------------

// PRP 05 §4.3 — progress calculation (inlined for client bundle; canonical source: lib/db.ts)
function progress(subtasks: Subtask[]): { done: number; total: number; pct: number } {
  const total = subtasks.length
  const done = subtasks.filter((s) => s.completed === 1).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return { done, total, pct }
}

// PRP 05 §5.2 — add-subtask input (submits on Enter or Add click)
function SubtaskInput({ onAdd }: { onAdd: (title: string) => void }) {
  const [value, setValue] = useState('')
  function submit() {
    const t = value.trim()
    if (!t) return
    onAdd(t)
    setValue('')
  }
  return (
    <div className="flex gap-1 mt-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Add subtask…"
        maxLength={200}
        aria-label="New subtask title"
        className="flex-1 border rounded px-2 py-1 text-xs dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <button
        type="button"
        onClick={submit}
        className="px-2 py-1 text-xs rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
      >
        Add
      </button>
    </div>
  )
}

function TodoRow({
  todo,
  onToggle,
  onEdit,
  onDelete,
  onSaveAsTemplate,
}: {
  todo: TodoWithTags
  onToggle: (todo: TodoWithTags) => void
  onEdit: (todo: TodoWithTags) => void
  onDelete: (todo: TodoWithTags) => void
  onSaveAsTemplate: (todo: TodoWithTags) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [subtasks, setSubtasks] = useState<Subtask[]>([])
  const subtaskCounter = useRef(0)

  async function loadSubtasks() {
    try {
      const res = await fetch(`/api/todos/${todo.id}/subtasks`)
      if (!res.ok) return
      const json = await res.json()
      setSubtasks(json.data ?? [])
    } catch { /* ignore network errors */ }
  }

  function handleExpand() {
    const next = !expanded
    setExpanded(next)
    if (next && subtasks.length === 0) loadSubtasks()
  }

  async function addSubtask(title: string) {
    const optimisticId = -(++subtaskCounter.current)
    const optimistic: Subtask = {
      id: optimisticId,
      todo_id: todo.id,
      title,
      completed: 0,
      position: subtasks.length,
    }
    setSubtasks((prev) => [...prev, optimistic])
    try {
      const res = await fetch(`/api/todos/${todo.id}/subtasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      const json = await res.json()
      if (!res.ok) {
        setSubtasks((prev) => prev.filter((s) => s.id !== optimisticId))
        return
      }
      setSubtasks((prev) => prev.map((s) => (s.id === optimisticId ? json.data : s)))
    } catch {
      setSubtasks((prev) => prev.filter((s) => s.id !== optimisticId))
    }
  }

  async function toggleSubtask(s: Subtask) {
    const newCompleted = s.completed ? 0 : 1
    setSubtasks((prev) =>
      prev.map((x) => (x.id === s.id ? { ...x, completed: newCompleted as 0 | 1 } : x))
    )
    try {
      await fetch(`/api/subtasks/${s.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: newCompleted === 1 }),
      })
    } catch {
      setSubtasks((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, completed: s.completed } : x))
      )
    }
  }

  async function deleteSubtask(id: number) {
    const snapshot = [...subtasks]
    setSubtasks((prev) => prev.filter((s) => s.id !== id))
    try {
      const res = await fetch(`/api/subtasks/${id}`, { method: 'DELETE' })
      if (!res.ok) setSubtasks(snapshot)
    } catch {
      setSubtasks(snapshot)
    }
  }

  const p = progress(subtasks)

  return (
    <li className="flex flex-col py-2 px-3 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50">
      <div className="flex items-center gap-3 group">
        <input
          type="checkbox"
          checked={!!todo.completed}
          onChange={() => onToggle(todo)}
          aria-label={`Mark "${todo.title}" as ${todo.completed ? 'incomplete' : 'complete'}`}
          className="h-4 w-4 rounded border-gray-300 text-blue-600 cursor-pointer flex-shrink-0"
        />
        {/* PRP 02 §5.5 — badge always visible, before title */}
        <PriorityBadge priority={todo.priority} />
        {/* PRP 03 §5.2 — recurrence badge */}
        {todo.recurrence !== null && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 flex-shrink-0"
            aria-label={`Repeats ${todo.recurrence}`}
          >
            🔄 {capitalize(todo.recurrence)}
          </span>
        )}
        {/* PRP 04 §5.3 — reminder badge */}
        {todo.reminder_minutes != null && (
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 flex-shrink-0"
            aria-label={`Reminder ${shortLabelFor(todo.reminder_minutes)} before`}
          >
            🔔 {shortLabelFor(todo.reminder_minutes)}
          </span>
        )}
        {/* PRP 06 §5.1 — tag badges (omitted when no tags) */}
        {todo.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 flex-shrink-0 max-w-[200px]">
            {todo.tags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
          </div>
        )}
        <span
          className={`flex-1 text-sm min-w-0 truncate ${todo.completed ? 'line-through text-gray-400' : ''}`}
          title={todo.title}
        >
          {todo.title}
        </span>
        <DueDateDisplay todo={todo} />
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {/* PRP 05 — expand/collapse subtasks */}
          <button
            type="button"
            onClick={handleExpand}
            aria-expanded={expanded}
            aria-label="Toggle subtasks"
            className="px-2 py-1 text-xs rounded text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            type="button"
            onClick={() => onEdit(todo)}
            aria-label={`Edit "${todo.title}"`}
            className="px-2 py-1 text-xs rounded text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onSaveAsTemplate(todo)}
            aria-label={`Save "${todo.title}" as template`}
            className="px-2 py-1 text-xs rounded text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
          >
            Template
          </button>
          <button
            type="button"
            onClick={() => onDelete(todo)}
            aria-label={`Delete "${todo.title}"`}
            className="px-2 py-1 text-xs rounded text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
      {/* PRP 05 §5.1 — expandable subtask checklist + progress bar */}
      {expanded && (
        <div className="mt-2 pl-7 pr-2">
          {subtasks.length > 0 && (
            <>
              <div className="h-2 w-full rounded bg-gray-200 dark:bg-gray-700 mb-1">
                <div
                  className={`h-2 rounded transition-all ${p.pct === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
                  style={{ width: `${p.pct}%` }}
                  role="progressbar"
                  aria-valuenow={p.pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <p className="text-xs text-gray-500 mb-2">
                {p.done}/{p.total} completed ({p.pct}%)
              </p>
            </>
          )}
          <ul className="space-y-1 mb-2">
            {subtasks.map((s) => (
              <li key={s.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.completed === 1}
                  onChange={() => toggleSubtask(s)}
                  aria-label={`Mark subtask "${s.title}" complete`}
                  className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 cursor-pointer flex-shrink-0"
                />
                <span className={`flex-1 text-xs ${s.completed ? 'line-through opacity-60' : ''}`}>
                  {s.title}
                </span>
                <button
                  type="button"
                  onClick={() => deleteSubtask(s.id)}
                  aria-label={`Delete subtask "${s.title}"`}
                  className="text-xs text-gray-400 hover:text-red-500 transition-colors px-1"
                >
                  🗑
                </button>
              </li>
            ))}
          </ul>
          <SubtaskInput onAdd={addSubtask} />
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// TodoSection — renders one of Overdue / Active / Completed
// ---------------------------------------------------------------------------
function TodoSection({
  title,
  todos,
  sectionClass,
  onToggle,
  onEdit,
  onDelete,
  onSaveAsTemplate,
}: {
  title: string
  todos: TodoWithTags[]
  sectionClass?: string
  onToggle: (todo: TodoWithTags) => void
  onEdit: (todo: TodoWithTags) => void
  onDelete: (todo: TodoWithTags) => void
  onSaveAsTemplate: (todo: TodoWithTags) => void
}) {
  if (todos.length === 0) return null // Empty sections are hidden per PRP 01 §3.2

  return (
    <section className={`mb-6 ${sectionClass ?? ''}`}>
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2 px-3">
        {title}{' '}
        <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-gray-200 dark:bg-gray-600 text-xs font-bold text-gray-700 dark:text-gray-200">
          {todos.length}
        </span>
      </h2>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {todos.map((todo) => (
          <TodoRow
            key={todo.id}
            todo={todo}
            onToggle={onToggle}
            onEdit={onEdit}
            onDelete={onDelete}
            onSaveAsTemplate={onSaveAsTemplate}
          />
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------
export default function HomePage() {
  const router = useRouter()
  const [todos, setTodos] = useState<TodoWithTags[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorToast, setErrorToast] = useState<string | null>(null)
  const [editingTodo, setEditingTodo] = useState<TodoWithTags | null>(null)
  const [deletingTodo, setDeletingTodo] = useState<TodoWithTags | null>(null)

  // PRP 02 §5.4 — priority filter state
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all')

  // PRP 06 — tag state
  const [allTags, setAllTags] = useState<(Tag & { todo_count: number })[]>([])
  const [activeTagIds, setActiveTagIds] = useState<number[]>([])
  const [showTagManager, setShowTagManager] = useState(false)
  const [newTags, setNewTags] = useState<Tag[]>([]) // tags selected in create form

  // PRP 07 — template state
  const [templates, setTemplates] = useState<Template[]>([])
  const [showTemplatePicker, setShowTemplatePicker] = useState(false)
  const [showManageTemplates, setShowManageTemplates] = useState(false)
  const [savingAsTemplateFor, setSavingAsTemplateFor] = useState<TodoWithTags | null>(null)

  // PRP 09 — export/import state
  const [isExporting, setIsExporting] = useState(false)
  const [showImportModal, setShowImportModal] = useState(false)

  // Create form state
  const [newTitle, setNewTitle] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [newPriority, setNewPriority] = useState<Priority>('medium') // PRP 02 §5.2
  const [newRecurrence, setNewRecurrence] = useState<RecurrencePattern | null>(null) // PRP 03
  const [newReminderMinutes, setNewReminderMinutes] = useState<number | null>(null) // PRP 04
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Track temporary optimistic IDs for rollback
  const optimisticCounter = useRef(0)

  const showError = useCallback((msg: string) => setErrorToast(msg), [])

  // PRP 04 — notification permission state + 30s polling hook
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default')
  const { requestPermission } = useNotifications(true)
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPerm(Notification.permission)
    } else if (typeof window !== 'undefined') {
      setPerm('unsupported')
    }
  }, [])

  // Fetch todos and tags on mount
  useEffect(() => {
    fetchTodos()
    fetchAllTags()
    fetchTemplates()
  }, [])

  // Silently drop any active tag filter IDs that no longer exist
  useEffect(() => {
    if (activeTagIds.length === 0) return
    const validIds = new Set(allTags.map((t) => t.id))
    const filtered = activeTagIds.filter((id) => validIds.has(id))
    if (filtered.length !== activeTagIds.length) setActiveTagIds(filtered)
  }, [allTags])

  async function fetchTodos() {
    setIsLoading(true)
    try {
      const res = await fetch('/api/todos')
      if (res.status === 401) {
        router.push('/login')
        return
      }
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to load todos')
      setTodos(json.data as TodoWithTags[])
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to load todos')
    } finally {
      setIsLoading(false)
    }
  }

  async function fetchAllTags() {
    try {
      const res = await fetch('/api/tags')
      if (!res.ok) return
      const json = await res.json()
      setAllTags(json.data ?? [])
    } catch { /* non-fatal */ }
  }

  async function fetchTemplates() {
    try {
      const res = await fetch('/api/templates')
      if (!res.ok) return
      const json = await res.json()
      setTemplates(json.data ?? [])
    } catch { /* non-fatal */ }
  }

  async function handleCreateTag(name: string, color: string): Promise<Tag> {
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message ?? 'Failed to create tag')
    const newTag = json.data as Tag
    setAllTags((prev) =>
      [...prev, { ...newTag, todo_count: 0 }].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      )
    )
    return newTag
  }

  async function handleTagRename(id: number, name: string): Promise<void> {
    const res = await fetch(`/api/tags/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message ?? 'Failed to rename tag')
    const updated = json.data as Tag
    setAllTags((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)))
    // Update tag name on all todos in state
    setTodos((prev) =>
      prev.map((todo) => ({
        ...todo,
        tags: todo.tags.map((t) => (t.id === id ? { ...t, ...updated } : t)),
      }))
    )
  }

  async function handleTagRecolor(id: number, color: string): Promise<void> {
    const res = await fetch(`/api/tags/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message ?? 'Failed to recolor tag')
    const updated = json.data as Tag
    setAllTags((prev) => prev.map((t) => (t.id === id ? { ...t, ...updated } : t)))
    setTodos((prev) =>
      prev.map((todo) => ({
        ...todo,
        tags: todo.tags.map((t) => (t.id === id ? { ...t, ...updated } : t)),
      }))
    )
  }

  async function handleTagDelete(id: number): Promise<void> {
    const res = await fetch(`/api/tags/${id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error?.message ?? 'Failed to delete tag')
    setAllTags((prev) => prev.filter((t) => t.id !== id))
    // Remove deleted tag from all todos in state
    setTodos((prev) =>
      prev.map((todo) => ({ ...todo, tags: todo.tags.filter((t) => t.id !== id) }))
    )
  }

  // PRP 01 §3.1 — create todo with optimistic update
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title) {
      setCreateError('Title is required')
      return
    }
    setCreateError(null)
    setIsCreating(true)

    const tempId = -(++optimisticCounter.current) // negative to avoid collision with real IDs
    const tagsToAttach = [...newTags]
    const optimisticTodo: TodoWithTags = {
      id: tempId,
      user_id: 0,
      title,
      description: null,
      due_date: newDueDate ? new Date(newDueDate + '+08:00').toISOString() : null,
      completed: 0,
      priority: newPriority,
      recurrence: newRecurrence,
      reminder_minutes: newReminderMinutes,
      last_notification_sent: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      tags: tagsToAttach,
    }

    setTodos((prev) => [...prev, optimisticTodo])
    setNewTitle('')
    setNewDueDate('')
    setNewPriority('medium')
    setNewRecurrence(null)
    setNewReminderMinutes(null)
    setNewTags([])

    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          due_date: newDueDate || undefined,
          priority: newPriority,
          ...(newRecurrence ? { recurrence: newRecurrence } : {}),
          ...(newReminderMinutes !== null ? { reminder_minutes: newReminderMinutes } : {}),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to create todo')
      const createdTodo = json.data as TodoWithTags
      // Attach tags if any were selected
      if (tagsToAttach.length > 0) {
        await fetch(`/api/todos/${createdTodo.id}/tags`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagIds: tagsToAttach.map((t) => t.id) }),
        })
      }
      // Replace optimistic entry; include tags from selection
      setTodos((prev) =>
        prev.map((t) => (t.id === tempId ? { ...createdTodo, tags: tagsToAttach } : t))
      )
      // Refresh tag counts
      fetchAllTags()
    } catch (err) {
      setTodos((prev) => prev.filter((t) => t.id !== tempId))
      setNewTitle(title)
      setNewPriority(newPriority)
      showError(err instanceof Error ? err.message : 'Failed to create todo')
    } finally {
      setIsCreating(false)
    }
  }

  // PRP 01 §3.4 — toggle completion with optimistic update
  async function handleToggle(todo: TodoWithTags) {
    const newCompleted = todo.completed ? 0 : 1
    const snapshot = { ...todo, tags: todo.tags }

    setTodos((prev) =>
      prev.map((t) => (t.id === todo.id ? { ...t, completed: newCompleted } : t))
    )

    try {
      const res = await fetch(`/api/todos/${todo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: newCompleted === 1 }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to update todo')
      if (newCompleted === 1 && todo.recurrence !== null) {
        // Completing a recurring todo spawns a new instance — refetch to show it.
        await fetchTodos()
      } else {
        // Preserve tags — PUT /api/todos/[id] doesn’t return tags
        setTodos((prev) =>
          prev.map((t) => (t.id === todo.id ? { ...json.data, tags: todo.tags } : t))
        )
      }
    } catch (err) {
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? snapshot : t))) // rollback
      showError(err instanceof Error ? err.message : 'Failed to update todo')
    }
  }

  // PRP 01 §3.3 — edit modal: onUpdated is called both for optimistic update and server response
  function handleUpdated(updated: TodoWithTags) {
    setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
  }

  // PRP 01 §3.5 — delete with optimistic update
  async function handleDeleteConfirm() {
    if (!deletingTodo) return
    const todo = deletingTodo
    const snapshot = [...todos]

    setDeletingTodo(null)
    setTodos((prev) => prev.filter((t) => t.id !== todo.id)) // optimistic removal

    try {
      const res = await fetch(`/api/todos/${todo.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to delete todo')
    } catch (err) {
      setTodos(snapshot) // rollback
      showError(err instanceof Error ? err.message : 'Failed to delete todo')
    }
  }

  // PRP 02 §3.3 + PRP 06 — sectioned list with priority and tag filters applied
  const { overdue, active, completed } = useSectionedTodos(todos, priorityFilter, activeTagIds)

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  // PRP 09 — export all todos as a JSON file download
  async function handleExport() {
    setIsExporting(true)
    try {
      const res = await fetch('/api/todos/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const contentDisposition = res.headers.get('content-disposition') ?? ''
      const match = contentDisposition.match(/filename="([^"]+)"/)
      const filename = match ? match[1] : 'todos-export.json'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      showError('Export failed. Please try again.')
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <main className="min-h-screen p-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Todos</h1>
        <div className="flex items-center gap-3">
          {/* PRP 04 §5.1 — Enable-Notifications button */}
          {perm !== 'unsupported' && (
            <button
              onClick={async () => setPerm(await requestPermission())}
              aria-label="Enable browser notifications"
              className={`text-sm transition-colors ${
                perm === 'granted'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {perm === 'granted' ? '🔔 Notifications on' : 'Enable Notifications'}
            </button>
          )}
          <button
            onClick={handleLogout}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Logout
          </button>
          {/* PRP 06 — Manage Tags button */}
          <button
            type="button"
            onClick={() => setShowTagManager(true)}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Manage Tags
          </button>
          {/* PRP 07 — Use Template button */}
          <button
            type="button"
            onClick={() => setShowTemplatePicker(true)}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Use Template
          </button>
          {/* PRP 09 — Export button */}
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
          >
            {isExporting ? 'Exporting…' : 'Export'}
          </button>
          {/* PRP 09 — Import button */}
          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Import
          </button>
          {/* PRP 10 — Calendar link */}
          <a
            href="/calendar"
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            Calendar
          </a>
        </div>
      </div>

      {/* Create Form — PRP 01 §5.1 + PRP 02 §5.2 */}
      <form
        onSubmit={handleCreate}
        className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6 flex flex-col gap-3"
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="What needs to be done?"
            maxLength={200}
            aria-label="Todo title"
            className="flex-1 border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Priority dropdown — PRP 02 §5.2 */}
          <div className="flex flex-col">
            <label htmlFor="new-todo-priority" className="sr-only">
              Priority
            </label>
            <select
              id="new-todo-priority"
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as Priority)}
              aria-label="Priority"
              className="border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          {/* Due date picker — PRP 01 §5.1 */}
          <input
            type="datetime-local"
            value={newDueDate}
            onChange={(e) => {
              setNewDueDate(e.target.value)
              if (!e.target.value) {
                setNewRecurrence(null)
                setNewReminderMinutes(null)
              }
            }}
            min={getMinDueDateForPicker()}
            aria-label="Due date"
            className="border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 flex-1"
          />
          <button
            type="submit"
            disabled={isCreating || !newTitle.trim()}
            className="px-4 py-2 text-sm rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium transition-colors whitespace-nowrap"
          >
            {isCreating ? 'Adding…' : 'Add'}
          </button>
        </div>
        {/* PRP 03 §5.1 — Repeat checkbox + pattern select (shown when due date is set) */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={newRecurrence !== null}
              onChange={(e) => setNewRecurrence(e.target.checked ? 'weekly' : null)}
              disabled={!newDueDate}
              aria-label="Repeat this todo"
              className="rounded"
            />
            <span>Repeat</span>
          </label>
          {newRecurrence !== null && (
            <select
              value={newRecurrence}
              onChange={(e) => setNewRecurrence(e.target.value as RecurrencePattern)}
              aria-label="Recurrence pattern"
              className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          )}
        </div>
        {/* PRP 04 §5.2 — Reminder dropdown */}
        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor="new-reminder" className="text-sm">Reminder</label>
          <select
            id="new-reminder"
            value={newReminderMinutes ?? ''}
            onChange={(e) => setNewReminderMinutes(e.target.value ? Number(e.target.value) : null)}
            disabled={!newDueDate}
            aria-label="Reminder"
            className="border rounded px-2 py-1 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">No reminder</option>
            {REMINDER_OPTIONS.map((o) => (
              <option key={o.minutes} value={o.minutes}>{o.label}</option>
            ))}
          </select>
        </div>
        {/* PRP 06 §5.2 — Tag picker for create form */}
        <div>
          <label className="block text-sm mb-1">Tags</label>
          <TagPicker
            selectedTags={newTags}
            onChange={setNewTags}
            allTags={allTags}
            onCreateTag={handleCreateTag}
          />
        </div>
        {createError && (
          <p role="alert" className="text-red-600 text-xs">
            {createError}
          </p>
        )}
      </form>

      {/* Filter bar — PRP 02 §5.4 + PRP 06 §5.4 */}
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex gap-3 items-center">
          <label htmlFor="priority-filter" className="sr-only">
            Filter by priority
          </label>
          <select
            id="priority-filter"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as Priority | 'all')}
            aria-label="Filter by priority"
            className="border rounded px-3 py-1.5 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        {/* PRP 06 §5.4 — Tag filter chips */}
        <TagFilterBar
          allTags={allTags}
          activeTagIds={activeTagIds}
          onToggleTag={(id) =>
            setActiveTagIds((prev) =>
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            )
          }
          onClear={() => setActiveTagIds([])}
        />
      </div>

      {/* Todo sections */}
      {isLoading ? (
        <p className="text-center text-gray-500 py-8">Loading…</p>
      ) : (
        <div>
          {/* Overdue — red background section */}
          <TodoSection
            title="Overdue"
            todos={overdue}
            sectionClass="bg-red-50 dark:bg-red-900/10 rounded-lg"
            onToggle={handleToggle}
            onEdit={setEditingTodo}
            onDelete={setDeletingTodo}
            onSaveAsTemplate={setSavingAsTemplateFor}
          />
          {/* Active */}
          <TodoSection
            title="Active"
            todos={active}
            onToggle={handleToggle}
            onEdit={setEditingTodo}
            onDelete={setDeletingTodo}
            onSaveAsTemplate={setSavingAsTemplateFor}
          />
          {/* Completed */}
          <TodoSection
            title="Completed"
            todos={completed}
            onToggle={handleToggle}
            onEdit={setEditingTodo}
            onDelete={setDeletingTodo}
            onSaveAsTemplate={setSavingAsTemplateFor}
          />
          {/* Empty state */}
          {overdue.length === 0 && active.length === 0 && completed.length === 0 && (
            <p className="text-center text-gray-400 py-12">
              {activeTagIds.length > 0
                ? 'No todos match the selected tags.'
                : priorityFilter === 'all'
                ? 'No todos yet. Add one above!'
                : `No ${priorityFilter} priority todos.`}
            </p>
          )}
        </div>
      )}

      {/* Edit modal — PRP 01 §5.4 + PRP 02 §5.3 + PRP 06 */}
      {editingTodo && (
        <EditTodoModal
          todo={editingTodo}
          onClose={() => setEditingTodo(null)}
          onUpdated={handleUpdated}
          showError={showError}
          allTags={allTags}
          onCreateTag={handleCreateTag}
        />
      )}

      {/* Delete confirmation — PRP 01 §5.5 */}
      {deletingTodo && (
        <DeleteConfirmDialog
          todo={deletingTodo}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeletingTodo(null)}
        />
      )}

      {/* Tag Manager — PRP 06 §5.3 */}
      {showTagManager && (
        <TagManager
          tags={allTags}
          onRename={handleTagRename}
          onRecolor={handleTagRecolor}
          onDelete={handleTagDelete}
          onClose={() => setShowTagManager(false)}
        />
      )}

      {/* PRP 07 — Save as Template modal */}
      {savingAsTemplateFor && (
        <SaveAsTemplateModal
          todo={savingAsTemplateFor}
          onClose={() => setSavingAsTemplateFor(null)}
          onSaved={fetchTemplates}
          showError={showError}
        />
      )}

      {/* PRP 07 — Template Picker modal */}
      {showTemplatePicker && (
        <TemplatePickerModal
          templates={templates}
          onClose={() => setShowTemplatePicker(false)}
          onCreated={(todo) => {
            setTodos((prev) => [...prev, todo])
            fetchTodos()
          }}
          showError={showError}
          onManage={() => {
            setShowTemplatePicker(false)
            setShowManageTemplates(true)
          }}
        />
      )}

      {/* PRP 07 — Manage Templates modal */}
      {showManageTemplates && (
        <ManageTemplatesModal
          templates={templates}
          onClose={() => setShowManageTemplates(false)}
          onTemplatesChanged={fetchTemplates}
        />
      )}

      {/* PRP 09 — Import modal */}
      {showImportModal && (
        <ImportModal
          onClose={() => setShowImportModal(false)}
          onImported={fetchTodos}
          showError={showError}
        />
      )}

      {/* Error toast — PRP 01 §5.6 */}
      {errorToast && (
        <ErrorToast message={errorToast} onDismiss={() => setErrorToast(null)} />
      )}
    </main>
  )
}
