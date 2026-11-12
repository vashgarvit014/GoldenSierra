import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges Tailwind classes, resolving conflicts in favour of the last one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return 'Unknown';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2592000, 'month'],
  ];
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  let previous = 1;
  for (const [limit, unit] of units) {
    if (seconds < limit * (unit === 'minute' ? 60 : 1) || limit === 2592000) {
      if (seconds < limit) return formatter.format(-Math.floor(seconds / previous), unit);
    }
    previous = limit;
  }
  return formatter.format(-Math.floor(seconds / 2592000), 'month');
}

/** Host only, for compact display of a source link. */
export function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
