import {
  Briefcase,
  Building2,
  FileText,
  Gauge,
  History,
  LayoutDashboard,
  Plug,
  Search,
  Sun,
  Target,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Route } from 'next';

/**
 * The nav lives here rather than in shell.tsx because the sidebar, the mobile tab
 * bar and the command palette all need the same list. Three copies of it would
 * drift the moment a route is added.
 *
 * href is a typed route, not a string: next.config's typedRoutes turns a stale
 * nav link into a build error rather than a 404 someone finds later.
 */
export interface NavItem {
  href: Route;
  label: string;
  icon: LucideIcon;
  /** Shown in the command palette only, where there is room to explain. */
  hint?: string;
}

/** Candidate side. An admin sees these too - they are also a job seeker. */
export const CANDIDATE_NAV: NavItem[] = [
  {
    href: '/app',
    label: 'Overview',
    icon: LayoutDashboard,
    hint: 'Today at a glance',
  },
  {
    href: '/app/digest',
    label: 'Today',
    icon: Sun,
    hint: 'This morning, and the yes/no it is asking for',
  },
  {
    href: '/app/matches',
    label: 'Where I can apply',
    icon: Target,
    hint: 'Your postings ranked against your resume, with the apply buttons',
  },
  {
    href: '/app/jobs',
    label: 'All jobs',
    icon: Search,
    hint: 'Everything discovered for you, ranked or not',
  },
  {
    href: '/app/applications',
    label: 'Applications',
    icon: Briefcase,
    hint: 'What you sent, and where it got to',
  },
  {
    href: '/app/resumes',
    label: 'Resumes',
    icon: FileText,
    hint: 'Upload, choose the one in use, edit its pieces',
  },
  {
    href: '/app/profile',
    label: 'My profile',
    icon: UserRound,
    hint: 'Your answers, CTC and notice period',
  },
];

/**
 * The four tabs a phone gets, named rather than sliced.
 *
 * A slice of CANDIDATE_NAV would mean the tab bar's contents changed silently every
 * time a route was added to the sidebar - which is what happened when the digest went
 * in: a fifth 10px label starts truncating below about 380px. So the choice is written
 * down here. Nothing becomes unreachable: the command palette button is in the mobile
 * header too, and it lists every route.
 *
 * "Where I can apply" took the slot that "All jobs" had, rather than becoming a fifth
 * tab. It is the same list with the scores and the buttons attached, so a phone loses
 * nothing but the unscored postings - and staying at four keeps the labels readable on a
 * 380px screen.
 */
const MOBILE_HREFS = new Set<string>([
  '/app',
  '/app/digest',
  '/app/matches',
  '/app/applications',
]);

export const MOBILE_NAV: NavItem[] = CANDIDATE_NAV.filter((item) =>
  MOBILE_HREFS.has(item.href),
);

/** Admin side. Rendered only for ADMIN - but the server refuses these routes
 *  for a USER regardless, which is the actual control (PLAN-v2 2A.1). */
export const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Pipeline', icon: Gauge, hint: 'Funnel and health' },
  {
    href: '/admin/companies',
    label: 'Companies',
    icon: Building2,
    hint: 'Boards being watched',
  },
  {
    href: '/admin/runs',
    label: 'Connector runs',
    icon: History,
    hint: 'Every fetch, with its errors',
  },
  {
    href: '/admin/users',
    label: 'Accounts',
    icon: Users,
    hint: 'Approve and suspend people',
  },
  {
    href: '/admin/integrations',
    label: 'Integrations',
    icon: Plug,
    hint: 'Which keys are configured',
  },
];

/** True when a nav item should be highlighted for the current pathname.
 *
 *  The two section roots need an exact match: `/app` is a prefix of every
 *  candidate route, so a plain startsWith would light up Overview on all of them.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/app' || href === '/admin') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
