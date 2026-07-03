// scripts/seed-holidays.ts
// Seeds Singapore public holidays for the current year and next year.
// Run once with: npx tsx scripts/seed-holidays.ts
// Uses INSERT OR IGNORE so it is idempotent — safe to re-run at any time.

import { holidayDB } from '../lib/db'

const HOLIDAYS_BY_YEAR: Record<number, Array<{ date: string; name: string }>> = {
  2025: [
    { date: '2025-01-01', name: "New Year's Day" },
    { date: '2025-01-29', name: 'Chinese New Year' },
    { date: '2025-01-30', name: 'Chinese New Year (Day 2)' },
    { date: '2025-03-31', name: 'Hari Raya Puasa' },
    { date: '2025-04-18', name: 'Good Friday' },
    { date: '2025-05-01', name: 'Labour Day' },
    { date: '2025-05-12', name: 'Vesak Day' },
    { date: '2025-06-07', name: 'Hari Raya Haji' },
    { date: '2025-08-09', name: 'National Day' },
    { date: '2025-10-20', name: 'Deepavali' },
    { date: '2025-12-25', name: 'Christmas Day' },
  ],
  2026: [
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-02-17', name: 'Chinese New Year' },
    { date: '2026-02-18', name: 'Chinese New Year (Day 2)' },
    { date: '2026-03-20', name: 'Hari Raya Puasa' },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-05-01', name: 'Labour Day' },
    { date: '2026-05-31', name: 'Vesak Day' },
    { date: '2026-05-27', name: 'Hari Raya Haji' },
    { date: '2026-08-09', name: 'National Day' },
    { date: '2026-11-08', name: 'Deepavali' },
    { date: '2026-12-25', name: 'Christmas Day' },
  ],
  2027: [
    { date: '2027-01-01', name: "New Year's Day" },
    { date: '2027-02-06', name: 'Chinese New Year' },
    { date: '2027-02-07', name: 'Chinese New Year (Day 2)' },
    { date: '2027-03-09', name: 'Hari Raya Puasa' },
    { date: '2027-03-26', name: 'Good Friday' },
    { date: '2027-05-01', name: 'Labour Day' },
    { date: '2027-05-20', name: 'Vesak Day' },
    { date: '2027-05-17', name: 'Hari Raya Haji' },
    { date: '2027-08-09', name: 'National Day' },
    { date: '2027-10-28', name: 'Deepavali' },
    { date: '2027-12-25', name: 'Christmas Day' },
  ],
}

function seedYear(year: number) {
  const holidays = HOLIDAYS_BY_YEAR[year]
  if (!holidays) {
    console.log(`No holiday data for ${year} — skipping.`)
    return
  }
  let inserted = 0
  for (const { date, name } of holidays) {
    holidayDB.upsert(date, name)
    inserted++
  }
  console.log(`Seeded ${inserted} holidays for ${year}.`)
}

const currentYear = new Date().getFullYear()
seedYear(currentYear - 1)
seedYear(currentYear)
seedYear(currentYear + 1)

console.log('Holiday seeding complete.')
