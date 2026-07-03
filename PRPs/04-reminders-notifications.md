# PRP 04 — Reminders & Notifications

> **Extension of PRP 01 — Todo CRUD Operations.**
> This PRP does not redefine the `todos` table, the CRUD endpoints, the error envelope, or the timezone handling — those are in PRP 01. It adds reminder columns, one new read endpoint, a client polling hook, and browser-notification UI on top of that foundation. Read PRP 01 first.

---

## 1. Feature Overview

The Reminders & Notifications feature fires a **browser notification** a configurable interval before a todo's due date. A user picks one of seven offsets (**15m, 30m, 1h, 2h, 1d, 2d, 1w** before due), stored on the `todos` table as `reminder_minutes`. The client requests OS notification permission, then **polls** a server endpoint every 30 seconds; the endpoint returns todos whose reminder window is currently open and that have not already been notified. A `last_notification_sent` timestamp guarantees each reminder fires **once**. All windowing math is in **Singapore time** (`Asia/Singapore`) via `lib/timezone.ts`. Reminders require a due date (there is nothing to count back from otherwise).

---

## 2. User Stories

### Persona A — Deadline-Driven Professional
> *"I miss things unless something pings me. If a report is due at 5pm, I want a nudge an hour before while I still have time to act."*

- As a logged-in user, I can attach a reminder offset to a todo with a due date so that I get a browser notification ahead of the deadline.
- As a logged-in user, I only get notified once per reminder so that I'm not spammed by repeat alerts.

### Persona B — Privacy-Conscious User
> *"I want to decide whether this app can send me notifications. It shouldn't nag me before I opt in, and it shouldn't break if I say no."*

- As a logged-in user, I explicitly grant notification permission before any notification appears so that I stay in control.
- As a logged-in user, the app keeps working normally if I deny permission so that reminders are additive, not required.

---

## 3. User Flow

### 3.1 Enabling Notifications

1. A **"Enable Notifications"** button is visible in the app header (`app/page.tsx`).
2. Clicking it calls `Notification.requestPermission()`. The button reflects the resulting state (granted / denied / default).
3. Once granted, the polling hook begins issuing reminder checks (§4.4). If denied, no notifications fire; the rest of the app is unaffected.

### 3.2 Setting a Reminder on a Todo

1. In the create form and edit modal, a **Reminder** dropdown offers **None** plus the seven offsets.
2. The dropdown is **disabled unless a due date is set** (there is nothing to offset without one).
3. On submit, `reminder_minutes` (an integer, or `null` for None) is included in the `POST`/`PUT` body.
4. The todo row shows a **🔔 badge** with the human label (e.g., "🔔 1h before").

### 3.3 Receiving a Notification

1. While the app is open and permission is granted, the client polls `GET /api/notifications/check` every 30 seconds.
2. The endpoint returns any of the user's todos currently inside their reminder window and not yet notified, stamping `last_notification_sent` for each.
3. For each returned todo, the client calls `new Notification(title, { body })`. The same reminder does not fire again on later polls.

---

## 4. Technical Requirements

### 4.1 Database Migration

Two columns are added to `todos` at `lib/db.ts` init, inside idempotent try-catch blocks:

```typescript
try {
  db.exec(`ALTER TABLE todos ADD COLUMN reminder_minutes INTEGER`);
} catch {
  // Column already exists — safe to ignore.
}
try {
  db.exec(`ALTER TABLE todos ADD COLUMN last_notification_sent TEXT`);
} catch {
  // Column already exists — safe to ignore.
}
```

**Backfill**: existing rows get `reminder_minutes = NULL` (no reminder) and `last_notification_sent = NULL`. `last_notification_sent` stores an ISO-8601 string in Singapore semantics, or `NULL` if never sent.

### 4.2 Types & Reminder Options

Defined **once** in `lib/db.ts`:

```typescript
// lib/db.ts — single source of truth
export const REMINDER_OPTIONS: { label: string; minutes: number }[] = [
  { label: '15 minutes before', minutes: 15 },
  { label: '30 minutes before', minutes: 30 },
  { label: '1 hour before',     minutes: 60 },
  { label: '2 hours before',    minutes: 120 },
  { label: '1 day before',      minutes: 1440 },
  { label: '2 days before',     minutes: 2880 },
  { label: '1 week before',     minutes: 10080 },
];

export const REMINDER_MINUTES_VALUES: number[] = REMINDER_OPTIONS.map(o => o.minutes);

// Todo interface (extended):
//   reminder_minutes: number | null;
//   last_notification_sent: string | null;
```

### 4.3 Reminder-Window Logic

The trigger time is `due_date - reminder_minutes`. A todo is **due for notification** when all hold:

- `completed = 0`
- `due_date` is set AND `reminder_minutes` is set
- `now >= (due_date - reminder_minutes)` — the window has opened
- `last_notification_sent IS NULL` OR `last_notification_sent < (due_date - reminder_minutes)` — not yet notified for this window

All comparisons use Singapore-time values from `lib/timezone.ts` (`getSingaporeNow()`), never `new Date()` directly. Pure helper for unit testing:

```typescript
export function reminderTriggerTime(dueDateISO: string, reminderMinutes: number): Date {
  return new Date(new Date(dueDateISO).getTime() - reminderMinutes * 60_000);
}

export function isDueForNotification(
  now: Date, dueDateISO: string | null, reminderMinutes: number | null,
  lastSentISO: string | null, completed: number,
): boolean {
  if (completed === 1 || !dueDateISO || reminderMinutes == null) return false;
  const trigger = reminderTriggerTime(dueDateISO, reminderMinutes);
  if (now < trigger) return false;
  if (lastSentISO && new Date(lastSentISO) >= trigger) return false; // already sent this window
  return true;
}
```

### 4.4 New Endpoint — `GET /api/notifications/check`

**File**: `app/api/notifications/check/route.ts`

- Auth first: `const session = await getSession()`; `401` if none (PRP 01 pattern).
- Load the user's candidate todos (`completed = 0`, `due_date` and `reminder_minutes` not null).
- Filter with `isDueForNotification(getSingaporeNow(), ...)`.
- For each match, **stamp** `last_notification_sent = getSingaporeNow().toISOString()` (single UPDATE per todo) so it will not be returned again.
- Return the matched todos.

**Success response** (PRP 01 envelope):
```json
HTTP 200 OK
{ "data": [ { "id": 12, "title": "Submit report", "due_date": "…", "reminder_minutes": 60 } ] }
```

**Design note — server stamps, client displays**: stamping happens server-side inside the check so that two overlapping poll cycles cannot both fire the same reminder (last-write-wins on a single connection; `better-sqlite3` is synchronous, so the read-filter-stamp sequence is not interleaved).

### 4.5 Client Hook — `lib/hooks/useNotifications.ts`

```typescript
'use client';
import { useEffect, useCallback } from 'react';

export function useNotifications(enabled: boolean) {
  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.requestPermission();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined' || Notification.permission !== 'granted') return;

    const poll = async () => {
      try {
        const res = await fetch('/api/notifications/check');
        if (!res.ok) return;
        const { data } = await res.json();
        for (const todo of data) {
          new Notification(todo.title, { body: 'Due soon' });
        }
      } catch { /* network hiccup — ignore this cycle */ }
    };

    const interval = setInterval(poll, 30_000); // 30s polling
    poll(); // fire once immediately on mount
    return () => clearInterval(interval);
  }, [enabled]);

  return { requestPermission };
}
```

SSR-guarded (`typeof window`), no-ops without permission, cleans up its interval on unmount.

---

## 5. UI Components

### 5.1 Enable-Notifications Button (Header)

```tsx
const { requestPermission } = useNotifications(true);
const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');

<button
  onClick={async () => setPerm(await requestPermission())}
  aria-label="Enable browser notifications"
>
  {perm === 'granted' ? '🔔 Notifications on' : 'Enable Notifications'}
</button>
```

### 5.2 Reminder Dropdown (Create Form & Edit Modal)

```tsx
<select
  value={reminderMinutes ?? ''}
  onChange={(e) => setReminderMinutes(e.target.value ? Number(e.target.value) : null)}
  disabled={!dueDate}                    // no due date -> no reminder
  aria-label="Reminder"
>
  <option value="">No reminder</option>
  {REMINDER_OPTIONS.map(o => (
    <option key={o.minutes} value={o.minutes}>{o.label}</option>
  ))}
</select>
```

### 5.3 Reminder Badge (Todo Row)

```tsx
{todo.reminder_minutes != null && (
  <span
    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded
               bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
    aria-label={`Reminder ${labelFor(todo.reminder_minutes)}`}
  >
    🔔 {shortLabelFor(todo.reminder_minutes)}
  </span>
)}
```

---

## 6. Edge Cases

### 6.1 Reminder Selected Without a Due Date
Prevented in the UI (dropdown disabled) and rejected server-side: `reminder_minutes` set with no `due_date` → `400 REMINDER_REQUIRES_DUE_DATE`.

### 6.2 Permission Denied or Unsupported Browser
`requestPermission` returns `denied`/`unsupported`; the hook no-ops. No exceptions bubble; the app behaves exactly as without reminders.

### 6.3 Duplicate Suppression Across Poll Cycles
Two polls inside the same open window must fire once. After the first stamp, `last_notification_sent >= trigger`, so `isDueForNotification` returns false thereafter. Verified by unit test UT-N05.

### 6.4 App Closed During the Window
Notifications only fire while the app is open and polling. A missed window is not retro-fired beyond the next poll after reopening (at which point it is still inside the window if `now >= trigger` and not yet stamped).

### 6.5 Invalid `reminder_minutes` Value
A value not in `REMINDER_MINUTES_VALUES` → `400 INVALID_REMINDER`. Prevents arbitrary offsets.

### 6.6 Recurring Child Inherits the Reminder
A todo spawned by PRP 03 copies `reminder_minutes` and resets `last_notification_sent = NULL`, so its reminder is eligible to fire independently.

### 6.7 Reminder Window Already Passed at Creation
If a todo is created with a due date so near that `now >= trigger` immediately, the next poll fires the notification once (window is open), then stamps it.

---

## 7. Acceptance Criteria

1. **Permission request works**: clicking "Enable Notifications" invokes `Notification.requestPermission()` and the button reflects the outcome.
2. **Seven options available**: the reminder dropdown offers exactly the seven offsets plus "No reminder".
3. **Dropdown gated by due date**: the reminder select is disabled with no due date and enabled once one is set.
4. **Notification fires inside the window**: a todo whose `now >= due_date - reminder_minutes` is returned by the check endpoint and produces a browser notification.
5. **Fires once**: after firing, `last_notification_sent` is stamped and the same reminder is not returned on subsequent polls.
6. **Singapore timezone**: all window math uses `getSingaporeNow()`; a reminder computed for SGT does not drift by the local machine's offset.
7. **Badge renders with label**: todos with a reminder show a 🔔 badge with the human-readable timing and an `aria-label`.
8. **Graceful denial**: with permission denied, no notifications fire and no errors occur.
9. **Reminder requires due date**: `reminder_minutes` set with no `due_date` → `400 REMINDER_REQUIRES_DUE_DATE`.
10. **Invalid offset rejected**: `reminder_minutes` outside the allowlist → `400 INVALID_REMINDER`.

---

## 8. Out of Scope

The following are explicitly **not** part of this PRP:

- **Push notifications / service workers**: notifications fire only while the app tab is open. No background push, no Web Push API, no service worker.
- **Email or SMS reminders**: browser notifications only.
- **Custom offsets**: only the seven fixed offsets; no free-form "X minutes".
- **Snooze / repeat-until-acknowledged**: a reminder fires once; there is no snooze.
- **Multiple reminders per todo**: a todo has at most one `reminder_minutes` value.
- **Recurrence mechanics** (PRP 03): this PRP only consumes the inherited `reminder_minutes` on spawned instances.
- **Server-initiated delivery**: the server never pushes; the client pulls via polling.

---

## 9. Success Metrics

| Metric | Target |
|---|---|
| Duplicate suppression | TC-N04 confirms a reminder is returned at most once |
| Timezone correctness | Trigger time computed in SGT; UT-N01 exact |
| Graceful denial | App has zero console errors with permission denied |
| Idempotent migration | Running DB init twice adds no duplicate column and no data change |

