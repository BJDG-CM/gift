import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScheduleDates, daysUntilExpiryOn } from './notification-schedule.mjs';

const defaults = { t1: 'monthly', t2: 'weekly', t3: 'daily' };

test('creates reminders throughout the former D-13 to D-8 gap', () => {
  const now = new Date(2026, 7, 8, 8, 0, 0);
  const dates = buildScheduleDates('2026-08-18', defaults, '10:00', now);
  assert.ok(dates.length > 0);
  assert.equal(dates[0].getDate(), 11);
});

test('includes a reminder on the expiry day', () => {
  const now = new Date(2026, 7, 17, 12, 0, 0);
  const dates = buildScheduleDates('2026-08-18', defaults, '10:00', now);
  assert.ok(dates.some(date => date.getDate() === 18 && date.getHours() === 10));
});

test('deduplicates reminders where tier boundaries meet', () => {
  const now = new Date(2026, 0, 1, 0, 0, 0);
  const dates = buildScheduleDates('2026-12-31', defaults, '10:00', now, 100);
  const timestamps = dates.map(date => date.getTime());
  assert.equal(new Set(timestamps).size, timestamps.length);
});

test('notification copy can use the D-day value for each scheduled date', () => {
  assert.equal(daysUntilExpiryOn('2026-08-18', new Date(2026, 7, 11, 10, 0, 0)), 7);
  assert.equal(daysUntilExpiryOn('2026-08-18', new Date(2026, 7, 18, 10, 0, 0)), 0);
});
