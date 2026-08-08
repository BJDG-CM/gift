export const TIER_OPTIONS = {
  t1: [
    { key: 'monthly', label: '한 달에 한 번', days: 30 },
    { key: 'biweekly', label: '2주에 한 번', days: 14 },
    { key: 'off', label: '끄기', days: null }
  ],
  t2: [
    { key: 'biweekly', label: '2주마다', days: 14 },
    { key: 'weekly', label: '주 1회', days: 7 },
    { key: 'twiceWeek', label: '주 2회', days: 3.5 }
  ],
  t3: [
    { key: 'everyOther', label: '격일', days: 2 },
    { key: 'daily', label: '매일', days: 1 },
    { key: 'twiceDay', label: '하루 2번', days: 0.5 }
  ]
};

// The ranges meet at their boundaries. Duplicate timestamps are removed below.
export const TIER_META = [
  { key: 't1', label: '1년 전 ~ 3개월 전', from: 365, to: 90, dot: '#5FA97E' },
  { key: 't2', label: '3개월 전 ~ 1주 전', from: 90, to: 7, dot: '#E0982F' },
  { key: 't3', label: '1주 전 ~ 만료일', from: 7, to: 0, dot: '#ED5E4C' }
];

function parseDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftDays(date, amount) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + amount);
  return shifted;
}

function parseTime(timeStr) {
  const [rawHour, rawMinute] = (timeStr || '10:00').split(':').map(Number);
  const hour = Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 10;
  const minute = Number.isInteger(rawMinute) && rawMinute >= 0 && rawMinute <= 59 ? rawMinute : 0;
  return { hour, minute };
}

function calendarOrdinal(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
}

export function daysUntilExpiryOn(expiryStr, notificationDate) {
  return calendarOrdinal(parseDate(expiryStr)) - calendarOrdinal(notificationDate);
}

export function buildScheduleDates(expiryStr, tiers, notifyTime = '10:00', now = new Date(), limit = 40) {
  const expiryDay = parseDate(expiryStr);
  if (Number.isNaN(expiryDay.getTime()) || limit <= 0) return [];

  const expiryEnd = new Date(expiryDay);
  expiryEnd.setHours(23, 59, 59, 999);
  if (expiryEnd <= now) return [];

  const { hour, minute } = parseTime(notifyTime);
  const timestamps = new Set();

  for (const meta of TIER_META) {
    const choice = TIER_OPTIONS[meta.key].find(option => option.key === tiers?.[meta.key]);
    if (!choice || choice.days == null) continue;

    const rangeStart = shiftDays(expiryDay, -meta.from);
    const rangeEnd = shiftDays(expiryDay, -meta.to);
    const stepDays = choice.days < 1 ? 1 : Math.max(1, Math.round(choice.days));
    const times = choice.days < 1
      ? [{ hour: 9, minute: 0 }, { hour: 20, minute: 0 }]
      : [{ hour, minute }];

    // Anchor the cadence to the tier boundary so reopening the app does not
    // move weekly/monthly reminders to a different day.
    for (let day = new Date(rangeStart); day <= rangeEnd; day = shiftDays(day, stepDays)) {
      for (const time of times) {
        const candidate = new Date(day);
        candidate.setHours(time.hour, time.minute, 0, 0);
        if (candidate > now && candidate <= expiryEnd) timestamps.add(candidate.getTime());
      }
    }
  }

  return [...timestamps]
    .sort((a, b) => a - b)
    .slice(0, limit)
    .map(timestamp => new Date(timestamp));
}
