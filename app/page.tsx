'use client'

// app/page.tsx
// Monolithic client component for the main todo page.
// All data flows through API routes — never import lib/db.ts here.
// Implements PRP 01 (Todo CRUD) and PRP 02 (Priority System).

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import type { Todo, Priority } from '@/lib/db'
import {
  getSingaporeNow,
  formatRelativeDueDate,
  formatForDatetimeLocalInput,
  getMinDueDateForPicker,
} from '@/lib/timezone'

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
// useSectionedTodos — PRP 01 §5.2 + PRP 02 §5.4 (priority filter applied first)
// ---------------------------------------------------------------------------
function useSectionedTodos(todos: Todo[], priorityFilter: Priority | 'all') {
  return useMemo(() => {
    const now = getSingaporeNow()

    // PRP 02: apply priority filter before sectioning
    const filtered =
      priorityFilter === 'all' ? todos : todos.filter((t) => t.priority === priorityFilter)

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
  }, [todos, priorityFilter])
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
  todo: Todo
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
}: {
  todo: Todo
  onClose: () => void
  onUpdated: (updated: Todo) => void
  showError: (msg: string) => void
}) {
  const [title, setTitle] = useState(todo.title)
  const [dueDate, setDueDate] = useState(
    todo.due_date ? formatForDatetimeLocalInput(todo.due_date) : ''
  )
  const [priority, setPriority] = useState<Priority>(todo.priority)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return

    // Capture pre-edit snapshot for rollback
    const snapshot = { ...todo }

    // Optimistic update
    onUpdated({ ...todo, title: title.trim(), due_date: dueDate || null, priority })
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
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to update todo')
      onUpdated(json.data)
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
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
              onChange={(e) => setDueDate(e.target.value)}
              min={getMinDueDateForPicker()}
              className="w-full border rounded px-3 py-2 text-sm dark:bg-gray-700 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
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
// TodoRow — PRP 01 §5.3 + PRP 02 §5.5 (PriorityBadge)
// ---------------------------------------------------------------------------
function TodoRow({
  todo,
  onToggle,
  onEdit,
  onDelete,
}: {
  todo: Todo
  onToggle: (todo: Todo) => void
  onEdit: (todo: Todo) => void
  onDelete: (todo: Todo) => void
}) {
  return (
    <li className="flex items-center gap-3 py-2 px-3 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 group">
      <input
        type="checkbox"
        checked={!!todo.completed}
        onChange={() => onToggle(todo)}
        aria-label={`Mark "${todo.title}" as ${todo.completed ? 'incomplete' : 'complete'}`}
        className="h-4 w-4 rounded border-gray-300 text-blue-600 cursor-pointer flex-shrink-0"
      />
      {/* PRP 02 §5.5 — badge always visible, before title */}
      <PriorityBadge priority={todo.priority} />
      <span
        className={`flex-1 text-sm min-w-0 truncate ${todo.completed ? 'line-through text-gray-400' : ''}`}
        title={todo.title}
      >
        {todo.title}
      </span>
      <DueDateDisplay todo={todo} />
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
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
          onClick={() => onDelete(todo)}
          aria-label={`Delete "${todo.title}"`}
          className="px-2 py-1 text-xs rounded text-gray-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          Delete
        </button>
      </div>
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
}: {
  title: string
  todos: Todo[]
  sectionClass?: string
  onToggle: (todo: Todo) => void
  onEdit: (todo: Todo) => void
  onDelete: (todo: Todo) => void
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
  const [todos, setTodos] = useState<Todo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [errorToast, setErrorToast] = useState<string | null>(null)
  const [editingTodo, setEditingTodo] = useState<Todo | null>(null)
  const [deletingTodo, setDeletingTodo] = useState<Todo | null>(null)

  // PRP 02 §5.4 — priority filter state
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all')

  // Create form state
  const [newTitle, setNewTitle] = useState('')
  const [newDueDate, setNewDueDate] = useState('')
  const [newPriority, setNewPriority] = useState<Priority>('medium') // PRP 02 §5.2
  const [isCreating, setIsCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Track temporary optimistic IDs for rollback
  const optimisticCounter = useRef(0)

  const showError = useCallback((msg: string) => setErrorToast(msg), [])

  // Fetch todos on mount
  useEffect(() => {
    fetchTodos()
  }, [])

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
      setTodos(json.data)
    } catch (err) {
      showError(err instanceof Error ? err.message : 'Failed to load todos')
    } finally {
      setIsLoading(false)
    }
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
    const optimisticTodo: Todo = {
      id: tempId,
      user_id: 0,
      title,
      description: null,
      due_date: newDueDate ? new Date(newDueDate + '+08:00').toISOString() : null,
      completed: 0,
      priority: newPriority,
      recurrence: null,
      reminder_minutes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    setTodos((prev) => [...prev, optimisticTodo])
    setNewTitle('')
    setNewDueDate('')
    setNewPriority('medium')

    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          due_date: newDueDate || undefined,
          priority: newPriority,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to create todo')
      // Replace optimistic entry with canonical server record
      setTodos((prev) => prev.map((t) => (t.id === tempId ? json.data : t)))
    } catch (err) {
      // Rollback: remove the optimistic todo
      setTodos((prev) => prev.filter((t) => t.id !== tempId))
      // Restore form values
      setNewTitle(title)
      setNewPriority(newPriority)
      showError(err instanceof Error ? err.message : 'Failed to create todo')
    } finally {
      setIsCreating(false)
    }
  }

  // PRP 01 §3.4 — toggle completion with optimistic update
  async function handleToggle(todo: Todo) {
    const newCompleted = todo.completed ? 0 : 1
    const snapshot = { ...todo }

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
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? json.data : t)))
    } catch (err) {
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? snapshot : t))) // rollback
      showError(err instanceof Error ? err.message : 'Failed to update todo')
    }
  }

  // PRP 01 §3.3 — edit modal: onUpdated is called both for optimistic update and server response
  function handleUpdated(updated: Todo) {
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

  // PRP 02 §3.3 — sectioned list with priority filter applied
  const { overdue, active, completed } = useSectionedTodos(todos, priorityFilter)

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <main className="min-h-screen p-4 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Todos</h1>
        <button
          onClick={handleLogout}
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          Logout
        </button>
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
            onChange={(e) => setNewDueDate(e.target.value)}
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
        {createError && (
          <p role="alert" className="text-red-600 text-xs">
            {createError}
          </p>
        )}
      </form>

      {/* Filter bar — PRP 02 §5.4 */}
      <div className="flex gap-3 mb-4 items-center">
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
          />
          {/* Active */}
          <TodoSection
            title="Active"
            todos={active}
            onToggle={handleToggle}
            onEdit={setEditingTodo}
            onDelete={setDeletingTodo}
          />
          {/* Completed */}
          <TodoSection
            title="Completed"
            todos={completed}
            onToggle={handleToggle}
            onEdit={setEditingTodo}
            onDelete={setDeletingTodo}
          />
          {/* Empty state */}
          {overdue.length === 0 && active.length === 0 && completed.length === 0 && (
            <p className="text-center text-gray-400 py-12">
              {priorityFilter === 'all' ? 'No todos yet. Add one above!' : `No ${priorityFilter} priority todos.`}
            </p>
          )}
        </div>
      )}

      {/* Edit modal — PRP 01 §5.4 + PRP 02 §5.3 */}
      {editingTodo && (
        <EditTodoModal
          todo={editingTodo}
          onClose={() => setEditingTodo(null)}
          onUpdated={handleUpdated}
          showError={showError}
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

      {/* Error toast — PRP 01 §5.6 */}
      {errorToast && (
        <ErrorToast message={errorToast} onDismiss={() => setErrorToast(null)} />
      )}
    </main>
  )
}
