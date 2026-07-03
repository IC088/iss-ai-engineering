// lib/timezone.ts
// All date/time helpers for the app. Every date operation must go through here.
// Singapore timezone = UTC+8 (Asia/Singapore). No DST.
//
// This file is imported by both server-side API routes AND by 'use client'
// components (app/page.tsx). Keep it free of any server-only imports so the
// Next.js bundler doesn't pull in Node modules into the client bundle.
// RecurrencePattern is imported as a TYPE only — erased at compile time.

import type { RecurrencePattern } from '@/lib/db'

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000 // UTC+8 in milliseconds

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Returns the current moment as a Date. Named to clarify SGT intent throughout the codebase. */
export function getSingaporeNow(): Date {
  return new Date()
}

/**
 * Parses a `datetime-local` value (YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS),
 * treating it as Singapore time (UTC+8), and returns a UTC ISO 8601 string.
 * Throws if the format is invalid.
 */
export function parseDueDateToUtc(input: string): string {
  // Seconds are optional — datetime-local inputs omit them.
  const ISO_RE =
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
  if (!ISO_RE.test(input)) {
    throw new Error(`Invalid date-time format: ${input}`)
  }
  // Append the SGT offset so the Date constructor interprets it correctly on any host.
  const d = new Date(input + '+08:00')
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${input}`)
  }
  return d.toISOString()
}

/**
 * Returns true if a UTC ISO due date is at least 1 minute in the future.
 * Used server-side to reject past due dates on POST/PUT.
 */
export function isDueDateValid(utcIso: string): boolean {
  return new Date(utcIso).getTime() > Date.now() + 60 * 1000
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Formats a UTC ISO string as a human-readable SGT date/time string. */
export function formatSingaporeDate(utcIso: string): string {
  return new Date(utcIso).toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Converts a UTC ISO string to the YYYY-MM-DDTHH:MM format required by
 * `<input type="datetime-local">`, expressed in Singapore time.
 */
export function formatForDatetimeLocalInput(utcIso: string): string {
  const sgt = new Date(new Date(utcIso).getTime() + SGT_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${sgt.getUTCFullYear()}-${pad(sgt.getUTCMonth() + 1)}-${pad(sgt.getUTCDate())}` +
    `T${pad(sgt.getUTCHours())}:${pad(sgt.getUTCMinutes())}`
  )
}

/** Returns the minimum `datetime-local` value for the due-date picker (now + 1 min in SGT). */
export function getMinDueDateForPicker(): string {
  return formatForDatetimeLocalInput(new Date(Date.now() + 60 * 1000).toISOString())
}

interface DueDateResult {
  text: string
  colorClass: string
}

/**
 * Returns a human-readable relative label and a Tailwind color class for a due date.
 * Pass `isCompleted = true` to format as "Completed X ago" using the completed timestamp.
 */
export function formatRelativeDueDate(
  isoString: string | null | undefined,
  isCompleted: boolean
): DueDateResult | null {
  if (!isoString) return null

  const date = new Date(isoString)
  const now = getSingaporeNow()
  const diffMs = date.getTime() - now.getTime()
  const absDiffMinutes = Math.round(Math.abs(diffMs) / (1000 * 60))
  const absDiffHours = Math.round(Math.abs(diffMs) / (1000 * 60 * 60))
  const absDiffDays = Math.round(Math.abs(diffMs) / (1000 * 60 * 60 * 24))

  if (isCompleted) {
    if (absDiffMinutes < 60) return { text: `Completed ${absDiffMinutes}m ago`, colorClass: 'text-gray-400' }
    if (absDiffHours < 24) return { text: `Completed ${absDiffHours}h ago`, colorClass: 'text-gray-400' }
    return { text: `Completed ${absDiffDays}d ago`, colorClass: 'text-gray-400' }
  }

  if (diffMs < 0) {
    // Overdue
    if (absDiffMinutes < 60) return { text: `${absDiffMinutes}m overdue`, colorClass: 'text-red-600 dark:text-red-400' }
    if (absDiffHours < 24) return { text: `${absDiffHours}h overdue`, colorClass: 'text-red-600 dark:text-red-400' }
    return { text: `${absDiffDays}d overdue`, colorClass: 'text-red-600 dark:text-red-400' }
  }

  // Future
  const diffMinutes = Math.round(diffMs / (1000 * 60))
  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (diffMinutes < 60) return { text: `Due in ${diffMinutes}m`, colorClass: 'text-yellow-600 dark:text-yellow-400' }
  if (diffHours < 24) return { text: `Due in ${diffHours}h`, colorClass: 'text-yellow-600 dark:text-yellow-400' }
  if (diffDays <= 7) return { text: `Due in ${diffDays}d`, colorClass: 'text-blue-600 dark:text-blue-400' }
  return { text: formatSingaporeDate(isoString), colorClass: 'text-gray-500' }
}

// ---------------------------------------------------------------------------
// PRP 03 — Recurring due-date calculation
// ---------------------------------------------------------------------------

/**
 * Computes the next due date for a recurring todo.
 * Uses the ORIGINAL due date as the anchor (never "now").
 * Month and year rolls clamp to the last valid day of the target month,
 * so Jan 31 + 1 month → Feb 28/29 and Feb 29 + 12 months → Feb 28.
 * Time-of-day is preserved.
 */
export function nextDueDate(current: Date, pattern: RecurrencePattern): Date {
  switch (pattern) {
    case 'daily': {
      const d = new Date(current)
      d.setDate(d.getDate() + 1)
      return d
    }
    case 'weekly': {
      const d = new Date(current)
      d.setDate(d.getDate() + 7)
      return d
    }
    case 'monthly':
      return addMonthsClamped(current, 1)
    case 'yearly':
      return addMonthsClamped(current, 12)
  }
}

/**
 * Adds `months` to `date`, clamping the day to the last valid day of the
 * target month. Each step advances from the previous result's clamped date
 * (the original day is NOT remembered across multiple steps).
 *
 * Examples:
 *   Jan 31 + 1 month  → Feb 28 (or Feb 29 in a leap year)
 *   Feb 29 + 12 months → Feb 28 in a non-leap year (not Mar 1)
 */
function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getFullYear()
  const month = date.getMonth() // 0-indexed
  const day = date.getDate()

  const targetIndex = month + months
  const targetYear = year + Math.floor(targetIndex / 12)
  const targetMonth = ((targetIndex % 12) + 12) % 12 // handle negative mod safely

  // Day 0 of (targetMonth + 1) is the last day of targetMonth
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate()
  const clampedDay = Math.min(day, lastDay)

  const result = new Date(date) // preserves time-of-day
  result.setFullYear(targetYear, targetMonth, clampedDay)
  return result
}

// ---------------------------------------------------------------------------
// PRP 04 — Reminder window helpers
// ---------------------------------------------------------------------------

/**
 * Returns the moment at which a reminder should first fire.
 * trigger = due_date − reminder_minutes
 */
export function reminderTriggerTime(dueDateISO: string, reminderMinutes: number): Date {
  return new Date(new Date(dueDateISO).getTime() - reminderMinutes * 60_000)
}

/**
 * Returns true when all of the following hold:
 *   1. The todo is incomplete.
 *   2. Both due_date and reminder_minutes are set.
 *   3. now >= trigger (the reminder window is open).
 *   4. last_notification_sent is null OR predates the trigger (not yet sent this window).
 *
 * Pure function — safe to unit test without touching the DB.
 */
export function isDueForNotification(
  now: Date,
  dueDateISO: string | null,
  reminderMinutes: number | null,
  lastSentISO: string | null,
  completed: number,
): boolean {
  if (completed === 1 || !dueDateISO || reminderMinutes == null) return false
  const trigger = reminderTriggerTime(dueDateISO, reminderMinutes)
  if (now < trigger) return false
  if (lastSentISO && new Date(lastSentISO) >= trigger) return false // already sent this window
  return true
}
