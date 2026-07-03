'use client'
// lib/hooks/useNotifications.ts
// PRP 04 — 30-second polling hook for browser reminder notifications.
// SSR-guarded: all window/Notification references are behind typeof checks.
// No-ops when permission is not granted or the browser doesn't support notifications.

import { useEffect, useCallback } from 'react'

export function useNotifications(enabled: boolean) {
  const requestPermission = useCallback(async (): Promise<
    NotificationPermission | 'unsupported'
  > => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
    return Notification.requestPermission()
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission !== 'granted') return

    const poll = async () => {
      try {
        const res = await fetch('/api/notifications/check')
        if (!res.ok) return
        const { data } = await res.json()
        for (const todo of data as { title: string }[]) {
          new Notification(todo.title, { body: 'Due soon' })
        }
      } catch {
        // Network hiccup — silently skip this poll cycle.
      }
    }

    const interval = setInterval(poll, 30_000)
    poll() // fire once immediately on mount
    return () => clearInterval(interval)
  }, [enabled])

  return { requestPermission }
}
