import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Thousands separators, and an em dash for absent rather than "0" - a missing
 *  number and a zero mean different things in this dashboard. */
export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-IN');
}

export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export const TIER_LABEL: Record<string, string> = {
  T1_GLOBAL_INDIA_OFFICE: 'T1 · Global, India office',
  T2_FUNDED_INDIAN_STARTUP: 'T2 · Funded Indian startup',
  T3_INDIAN_MIDMARKET: 'T3 · Indian mid-market',
  T4_SERVICES_STAFFING: 'T4 · Services / staffing',
  UNKNOWN: 'Unknown',
};

export const REMOTE_LABEL: Record<string, string> = {
  ONSITE: 'On-site',
  HYBRID: 'Hybrid',
  REMOTE_INDIA: 'Remote · India',
  REMOTE_GLOBAL: 'Remote · global',
  REMOTE_OTHER_REGION: 'Remote · other region',
  UNKNOWN: 'Unknown',
};

export const STATUS_LABEL: Record<string, string> = {
  QUEUED: 'Queued',
  AWAITING_REVIEW: 'Awaiting review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PREPARED: 'Form filled',
  SUBMITTED: 'Submitted',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
};

export function salaryText(job: {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
}): string {
  if (job.salaryMin === null && job.salaryMax === null) {
    // Not a gap to apologise for: the spike measured stated salary on 0.3% of
    // India postings. "Not stated" IS the normal case here.
    return 'Not stated';
  }
  const cur = job.salaryCurrency === 'INR' ? '₹' : '$';
  const fmt = (v: number) =>
    v >= 100_000 ? `${Math.round(v / 1000)}k` : v.toLocaleString('en-IN');
  if (job.salaryMin !== null && job.salaryMax !== null) {
    return `${cur}${fmt(job.salaryMin)}–${fmt(job.salaryMax)}`;
  }
  return `${cur}${fmt((job.salaryMin ?? job.salaryMax)!)}`;
}
