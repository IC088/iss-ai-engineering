'use client'

// app/calendar/page.tsx
// PRP 10 — Monthly calendar view.
// Fetches todos with due_date in the displayed SGT month and Singapore public holidays.
// All date operations use lib/timezone.ts helpers.

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import type { Todo } from '@/lib/db'
import { getSingaporeNow, formatCalendarDate } from '@/lib/timezone'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Holiday {
  id: number
  date: string  // YYYY-MM-DD
  name: string
}

interface CalendarData {
  todos: Todo[]
  holidays: Holiday[]
}

// ---------------------------------------------------------------------------
// Priority constants (inlined for client bundle)
// ---------------------------------------------------------------------------
const PRIORITY_CLASSES: Record<string, string> = {
  high:   'bg-red-500',
  medium: 'bg-yellow-500',
  low:    'bg-blue-500',
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function pad(n: number) {
  return String(n).padStart(2, '0')
}

/** Returns YYYY-MM-DD in SGT for "today". */
function getTodayStr(): string {
  return formatCalendarDate(getSingaporeNow().toISOString())
}

interface GridCell {
  dateStr: string
  day: number
  currentMonth: boolean
}

/** Builds the Mon-first grid cells for a given year/month (1-indexed). */
function buildCalendarGrid(year: number, month: number): GridCell[] {
  const firstDay = new Date(year, month - 1, 1)
  const daysInMonth = new Date(year, month, 0).getDate()

  // Convert to Mon-first index: Mon=0 … Sun=6
  let startDow = firstDay.getDay() // Sun=0, Mon=1 … Sat=6
  startDow = (startDow + 6) % 7

  const cells: GridCell[] = []

  // Leading cells from previous month
  const prevYear = month === 1 ? year - 1 : year
  const prevMonth = month === 1 ? 12 : month - 1
  const daysInPrevMonth = new Date(prevYear, prevMonth, 0).getDate()
  for (let i = startDow - 1; i >= 0; i--) {
    const d = daysInPrevMonth - i
    cells.push({
      dateStr: `${prevYear}-${pad(prevMonth)}-${pad(d)}`,
      day: d,
      currentMonth: false,
    })
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      dateStr: `${year}-${pad(month)}-${pad(d)}`,
      day: d,
      currentMonth: true,
    })
  }

  // Trailing cells to complete the last row
  const trailing = (7 - (cells.length % 7)) % 7
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  for (let i = 1; i <= trailing; i++) {
    cells.push({
      dateStr: `${nextYear}-${pad(nextMonth)}-${pad(i)}`,
      day: i,
      currentMonth: false,
    })
  }

  return cells
}

// ---------------------------------------------------------------------------
// DayDetailPanel
// ---------------------------------------------------------------------------
interface DayDetailPanelProps {
  dateStr: string
  todos: Todo[]
  onClose: () => void
  onToggle: (todo: Todo) => void
}

function DayDetailPanel({ dateStr, todos, onClose, onToggle }: DayDetailPanelProps) {
  const [year, month, day] = dateStr.split('-').map(Number)
  const label = `${MONTH_NAMES[month - 1]} ${day}, ${year}`

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="day-detail-title"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-t-2xl sm:rounded-lg shadow-xl w-full max-w-md max-h-[70vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <h2 id="day-detail-title" className="text-base font-semibold">
            Todos for {label}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close day detail"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <ul className="overflow-y-auto flex-1 divide-y divide-gray-100 dark:divide-gray-700">
          {todos.length === 0 ? (
            <li className="px-4 py-6 text-sm text-center text-gray-400">No todos due on this day.</li>
          ) : (
            todos.map((todo) => (
              <li key={todo.id} className="flex items-center gap-3 px-4 py-3">
                <input
                  type="checkbox"
                  checked={!!todo.completed}
                  onChange={() => onToggle(todo)}
                  aria-label={`Mark "${todo.title}" as ${todo.completed ? 'incomplete' : 'complete'}`}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 cursor-pointer flex-shrink-0"
                />
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_CLASSES[todo.priority] ?? 'bg-gray-400'}`}
                  aria-hidden="true"
                />
                <span
                  className={`flex-1 text-sm min-w-0 truncate ${todo.completed ? 'line-through text-gray-400' : ''}`}
                  title={todo.title}
                >
                  {todo.title}
                </span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                    todo.priority === 'high'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                      : todo.priority === 'low'
                      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                      : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                  }`}
                >
                  {todo.priority.charAt(0).toUpperCase() + todo.priority.slice(1)}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CalendarPage — main component
// ---------------------------------------------------------------------------
export default function CalendarPage() {
  const router = useRouter()

  // Initialise to current SGT month
  const todayStr = getTodayStr()
  const [currentYear, setCurrentYear] = useState(() => {
    const now = getSingaporeNow()
    return now.getFullYear()
  })
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = getSingaporeNow()
    return now.getMonth() + 1 // 1-indexed
  })

  const [data, setData] = useState<CalendarData>({ todos: [], holidays: [] })
  const [isLoading, setIsLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  useEffect(() => {
    fetchCalendarData(currentYear, currentMonth)
  }, [currentYear, currentMonth])

  async function fetchCalendarData(year: number, month: number) {
    setIsLoading(true)
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/calendar?year=${year}&month=${month}`)
      if (res.status === 401) {
        router.push('/login')
        return
      }
      const json = await res.json()
      if (!res.ok) throw new Error(json.error?.message ?? 'Failed to load calendar data')
      setData(json as CalendarData)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load calendar data')
    } finally {
      setIsLoading(false)
    }
  }

  function navigatePrev() {
    if (currentMonth === 1) {
      setCurrentYear((y) => y - 1)
      setCurrentMonth(12)
    } else {
      setCurrentMonth((m) => m - 1)
    }
    setSelectedDate(null)
  }

  function navigateNext() {
    if (currentMonth === 12) {
      setCurrentYear((y) => y + 1)
      setCurrentMonth(1)
    } else {
      setCurrentMonth((m) => m + 1)
    }
    setSelectedDate(null)
  }

  function goToToday() {
    const now = getSingaporeNow()
    setCurrentYear(now.getFullYear())
    setCurrentMonth(now.getMonth() + 1)
    setSelectedDate(null)
  }

  // Group todos by SGT calendar date
  const todosByDate = useMemo(() => {
    const map: Record<string, Todo[]> = {}
    for (const todo of data.todos) {
      if (!todo.due_date) continue
      const day = formatCalendarDate(todo.due_date)
      if (!map[day]) map[day] = []
      map[day].push(todo)
    }
    return map
  }, [data.todos])

  // Build holiday lookup by date
  const holidayByDate = useMemo(() => {
    const map: Record<string, string> = {}
    for (const h of data.holidays) {
      map[h.date] = h.name
    }
    return map
  }, [data.holidays])

  const gridCells = useMemo(
    () => buildCalendarGrid(currentYear, currentMonth),
    [currentYear, currentMonth]
  )

  // Optimistic toggle for todos in the day panel
  async function handleToggle(todo: Todo) {
    const newCompleted = todo.completed ? 0 : 1
    setData((prev) => ({
      ...prev,
      todos: prev.todos.map((t) =>
        t.id === todo.id ? { ...t, completed: newCompleted as 0 | 1 } : t
      ),
    }))
    try {
      const res = await fetch(`/api/todos/${todo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: newCompleted === 1 }),
      })
      if (!res.ok) {
        // rollback
        setData((prev) => ({
          ...prev,
          todos: prev.todos.map((t) => (t.id === todo.id ? { ...t, completed: todo.completed } : t)),
        }))
      }
    } catch {
      setData((prev) => ({
        ...prev,
        todos: prev.todos.map((t) => (t.id === todo.id ? { ...t, completed: todo.completed } : t)),
      }))
    }
  }

  const selectedTodos = selectedDate ? (todosByDate[selectedDate] ?? []) : []

  return (
    <main className="min-h-screen p-4 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Calendar</h1>
          <a
            href="/"
            className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
          >
            ← Back to Todos
          </a>
        </div>
      </div>

      {/* Calendar header: prev / month-year / next / today */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={navigatePrev}
          aria-label="Previous month"
          className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          ← Prev
        </button>
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">
            {MONTH_NAMES[currentMonth - 1]} {currentYear}
          </h2>
          <button
            type="button"
            onClick={goToToday}
            className="text-xs px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Today
          </button>
        </div>
        <button
          type="button"
          onClick={navigateNext}
          aria-label="Next month"
          className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          Next →
        </button>
      </div>

      {/* Error */}
      {errorMsg && (
        <div role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400 text-center">
          {errorMsg}
        </div>
      )}

      {/* Calendar grid */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow overflow-hidden">
        {/* Day-of-week header row */}
        <div className="grid grid-cols-7 border-b border-gray-200 dark:border-gray-700">
          {DAY_HEADERS.map((d) => (
            <div
              key={d}
              className="py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide"
            >
              {d}
            </div>
          ))}
        </div>

        {/* Date cells */}
        {isLoading ? (
          <div className="py-20 text-center text-gray-400 text-sm">Loading…</div>
        ) : (
          <div className="grid grid-cols-7">
            {gridCells.map((cell) => {
              const cellTodos = todosByDate[cell.dateStr] ?? []
              const holiday = holidayByDate[cell.dateStr]
              const isToday = cell.dateStr === todayStr
              const isSelected = cell.dateStr === selectedDate
              const hasOverdue = cellTodos.some(
                (t) => !t.completed && t.due_date && new Date(t.due_date) < new Date()
              )
              const MAX_CHIPS = 3
              const overflow = cellTodos.length - MAX_CHIPS

              return (
                <div
                  key={cell.dateStr}
                  onClick={() => {
                    if (!cell.currentMonth) return
                    setSelectedDate(cell.dateStr === selectedDate ? null : cell.dateStr)
                  }}
                  className={`
                    min-h-[90px] p-1.5 border-b border-r border-gray-100 dark:border-gray-700 last:border-r-0 flex flex-col gap-0.5
                    ${cell.currentMonth ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50' : 'bg-gray-50 dark:bg-gray-800/50'}
                    ${isToday ? 'ring-2 ring-inset ring-blue-500' : ''}
                    ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}
                  `}
                  role={cell.currentMonth ? 'button' : undefined}
                  aria-pressed={cell.currentMonth ? isSelected : undefined}
                  aria-label={
                    cell.currentMonth
                      ? `${cell.dateStr}${cellTodos.length > 0 ? `, ${cellTodos.length} todo${cellTodos.length !== 1 ? 's' : ''}` : ''}`
                      : undefined
                  }
                >
                  {/* Date number */}
                  <span
                    className={`text-xs font-medium leading-none ${
                      !cell.currentMonth
                        ? 'text-gray-300 dark:text-gray-600'
                        : isToday
                        ? 'text-blue-600 dark:text-blue-400 font-bold'
                        : 'text-gray-700 dark:text-gray-200'
                    }`}
                  >
                    {cell.day}
                  </span>

                  {/* Holiday label */}
                  {holiday && cell.currentMonth && (
                    <span
                      className="text-[10px] leading-tight text-emerald-700 dark:text-emerald-400 truncate"
                      title={holiday}
                    >
                      {holiday}
                    </span>
                  )}

                  {/* Todo chips */}
                  {cellTodos.slice(0, MAX_CHIPS).map((todo) => (
                    <span
                      key={todo.id}
                      className={`text-[10px] leading-tight rounded px-1 py-0.5 truncate flex items-center gap-0.5 ${
                        todo.completed
                          ? 'line-through text-gray-400 bg-gray-100 dark:bg-gray-700'
                          : hasOverdue && !todo.completed && todo.due_date && new Date(todo.due_date) < new Date()
                          ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                          : 'bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                      }`}
                      title={todo.title}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_CLASSES[todo.priority] ?? 'bg-gray-400'}`}
                        aria-hidden="true"
                      />
                      {todo.title}
                    </span>
                  ))}

                  {overflow > 0 && (
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 leading-tight">
                      +{overflow} more
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Day detail panel */}
      {selectedDate && (
        <DayDetailPanel
          dateStr={selectedDate}
          todos={selectedTodos}
          onClose={() => setSelectedDate(null)}
          onToggle={handleToggle}
        />
      )}
    </main>
  )
}
