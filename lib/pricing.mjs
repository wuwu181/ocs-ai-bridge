// CNY per million tokens. Snapshot: 2026-11-05; user-editable, never a bill.
export const defaultBilling = {
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', checkedAt: '2026-11-05',
  holidays: [
    ...Array.from({length:3},(_,i)=>`2026-01-${String(i+1).padStart(2,'0')}`),
    ...Array.from({length:9},(_,i)=>`2026-02-${i+15}`),
    '2026-04-04','2026-04-05','2026-04-06',
    ...Array.from({length:5},(_,i)=>`2026-05-0${i+1}`),
    '2026-06-19','2026-06-20','2026-06-21','2026-09-25','2026-09-26','2026-09-27',
    ...Array.from({length:7},(_,i)=>`2026-10-0${i+1}`)
  ], workdays: [], prices: {
    'deepseek-flash': { input: 1, cached: 0.02, output: 4, peakMultiplier: 2 },
    'deepseek-v4-pro': { input: 4.5, cached: 0.15, output: 13.5, peakMultiplier: 2 }
  }
};
export function chinaClock(at = Date.now(), settings = defaultBilling) {
  const d = new Date(new Date(at).getTime() + 8 * 3600000);
  const day = d.toISOString().slice(0, 10), minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  // An explicitly listed national holiday always takes precedence. Workday overrides are optional.
  const weekday = settings.workdays?.includes(day) || d.getUTCDay() > 0 && d.getUTCDay() < 6;
  const peak = weekday && !settings.holidays?.includes(day) && (minute >= 540 && minute < 720 || minute >= 840 && minute < 1080);
  return { day, peak, timezone: 'Asia/Shanghai' };
}
export function estimateCost(profile, usage, at = Date.now(), billing = defaultBilling) {
  const clock = chinaClock(at, billing);
  if (!usage?.reported) return { known: false, amount: 0, currency: 'CNY', ...clock };
  const official = new URL(profile.endpoint).hostname === 'api.deepseek.com';
  const alias = /^deepseek-v4-flash(?:-vision-exp)?$/.test(profile.model) ? 'deepseek-flash' : profile.model;
  const rate = profile.pricing || (official ? billing.prices[alias] : null);
  if (!rate) return { known: false, amount: 0, currency: 'CNY', ...clock };
  const hit = Math.min(usage.input_tokens, usage.cache_hit_tokens || 0);
  const multiplier = clock.peak ? rate.peakMultiplier ?? 1 : 1;
  return { known: true, amount: ((usage.input_tokens - hit) * rate.input + hit * (rate.cached ?? rate.input) + usage.output_tokens * rate.output) * multiplier / 1e6,
    currency: 'CNY', estimated: true, cache_split_reported: !!usage.cache_split_reported, price_date: billing.checkedAt, ...clock };
}
