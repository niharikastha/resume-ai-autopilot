/**
 * One adapter per ATS. Each one is a host pattern and a table of field names.
 *
 * BUILD ORDER FROM MEASURED DATA, exactly as PLAN-v2 phase 6 asks ("now decided by
 * phase 1's measured atsType counts"). Counted over the live job_postings table:
 *
 *   GREENHOUSE       12322      tier 1
 *   ASHBY             2996      tier 2
 *   LEVER             1728      tier 1
 *   SMARTRECRUITERS    613      tier 2
 *   WORKABLE             6      cheap to add, and 6 postings is 6 forms
 *   WORKDAY              0      dropped, per the plan. Per-tenant accounts and a
 *                               stateful multi-step flow; manual links only.
 *
 * WHY THE NAME TABLES ARE SHORT. They only need the fields whose labels are
 * unreliable. The engine reads labels for everything else and gets it right on a form
 * written in any of the ways a customer might write it, so an entry here earns its
 * place by being MORE stable than the label above it - not by being another way to
 * say the same thing.
 *
 * A NAME MAPPED TO `null` IS A DELIBERATE EXCLUSION. The engine leaves those alone.
 * It is how Greenhouse's and Lever's EEO blocks are excluded as a group, which is
 * sturdier than matching each phrasing of "are you a protected veteran" - though
 * `classify()` refuses those by label too, and either mechanism alone is sufficient.
 */
import { AtsType } from '@prisma/client';
import type {
  AtsAdapter,
  NameMap,
  PreparedApplication,
  PrefillResult,
} from './ats.adapter';
import type { FormPage } from './form-page';
import { runPrefill, type PrefillOptions } from './prefill.engine';

/** Shared shape: a host test, a name table, and the engine. */
abstract class BoardAdapter implements AtsAdapter {
  abstract readonly atsType: AtsType;
  protected abstract readonly hosts: RegExp;
  protected abstract readonly names: NameMap;

  /**
   * Matched on the HOST, never on the posting's recorded atsType.
   *
   * The stored atsType says which connector found the posting; the URL says which
   * form is about to open. Those diverge - an aggregator link redirects, a company
   * moves from Lever to Ashby and the old posting still points at the old host - and
   * when they do, the URL is the one that is true right now.
   */
  canHandle(url: string): boolean {
    const host = hostOf(url);
    return host !== null && this.hosts.test(host);
  }

  prefill(page: FormPage, app: PreparedApplication): Promise<PrefillResult> {
    return runPrefill(page, app, {
      nameMap: this.names,
      ...(app.screenshotPath ? { screenshotPath: app.screenshotPath } : {}),
    });
  }
}

/**
 * TIER 1. Greenhouse.
 *
 * A React SPA at job-boards.greenhouse.io/{board}/jobs/{id}, and the plan is explicit
 * that it must be driven through the DOM rather than by constructing a POST - the
 * form carries CSRF state and a token the page fetches, and a hand-built request is
 * both fragile and indistinguishable from an attack from the board's side.
 */
export class GreenhouseAdapter extends BoardAdapter {
  readonly atsType = AtsType.GREENHOUSE;
  protected readonly hosts = /(^|\.)greenhouse\.io$/;
  protected readonly names: NameMap = {
    first_name: 'firstName',
    last_name: 'lastName',
    email: 'email',
    phone: 'phone',
    resume: 'resume',
    cover_letter: 'coverLetter',
    // The EEO block. Present on every US-registered board including the ones posting
    // Indian roles, and excluded as a group.
    gender: null,
    race: null,
    hispanic_ethnicity: null,
    veteran_status: null,
    disability_status: null,
  };
}

/**
 * TIER 1. Lever.
 *
 * Flat field names, and the only board in the set whose custom questions are
 * addressable at all: `cards[{uuid}][field0]`. Not mapped - the uuid is per posting,
 * so the label is the only durable handle and the engine already reads labels.
 */
export class LeverAdapter extends BoardAdapter {
  readonly atsType = AtsType.LEVER;
  protected readonly hosts = /(^|\.)lever\.co$/;
  protected readonly names: NameMap = {
    name: 'fullName',
    email: 'email',
    phone: 'phone',
    resume: 'resume',
    comments: null, // "Additional information" - a free-text box, left for the human.
    'urls[LinkedIn]': 'linkedIn',
    'urls[GitHub]': 'github',
    'urls[Portfolio]': 'portfolio',
    'urls[Other]': null,
    'eeo[gender]': null,
    'eeo[race]': null,
    'eeo[veteran]': null,
    'eeo[disability]': null,
  };
}

/**
 * TIER 2. Ashby.
 *
 * Schema-driven, so its own fields carry a `_systemfield_` prefix and everything the
 * customer added is generated. The prefixed ones are worth mapping because they are
 * stable across every Ashby board; the rest are labels.
 */
export class AshbyAdapter extends BoardAdapter {
  readonly atsType = AtsType.ASHBY;
  protected readonly hosts = /(^|\.)ashbyhq\.com$/;
  protected readonly names: NameMap = {
    _systemfield_name: 'fullName',
    _systemfield_email: 'email',
    _systemfield_phone: 'phone',
    _systemfield_resume: 'resume',
    _systemfield_location: 'location',
  };
}

/**
 * TIER 2. SmartRecruiters.
 *
 * The plan notes that .../postings/{uuid}/apply-configuration returns the question
 * schema. Not used: reading it would mean a second HTTP call whose answer is the
 * labels that are already in the DOM, and the DOM is what the human is looking at.
 */
export class SmartRecruitersAdapter extends BoardAdapter {
  readonly atsType = AtsType.SMARTRECRUITERS;
  protected readonly hosts = /(^|\.)smartrecruiters\.com$/;
  protected readonly names: NameMap = {
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
    phoneNumber: 'phone',
    resume: 'resume',
  };
}

/** Six postings in the table, and a five-line adapter. */
export class WorkableAdapter extends BoardAdapter {
  readonly atsType = AtsType.WORKABLE;
  protected readonly hosts = /(^|\.)workable\.com$/;
  protected readonly names: NameMap = {
    firstname: 'firstName',
    lastname: 'lastName',
    email: 'email',
    phone: 'phone',
    resume: 'resume',
  };
}

/**
 * The dropped one, kept as a named refusal rather than as an absence.
 *
 * A Workday URL reaching the generic filler would half-fill page one of a six-page
 * wizard and report coverage for it, which reads as progress. Recognising the host and
 * declining says the true thing: this one is a manual link.
 */
export class WorkdayAdapter implements AtsAdapter {
  readonly atsType = AtsType.WORKDAY;

  canHandle(url: string): boolean {
    const host = hostOf(url);
    return (
      host !== null &&
      /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/.test(host)
    );
  }

  prefill(): Promise<PrefillResult> {
    return Promise.resolve({
      requiredTotal: 0,
      requiredFilled: 0,
      fields: [],
      needsHuman: [
        'Workday is not automated - per-tenant accounts and a multi-step wizard. ' +
          'Open the link and apply by hand.',
      ],
      screenshotPath: null,
    });
  }
}

/**
 * Everything else: an in-house careers form.
 *
 * No name table, and a `resolve` pass that asks the LLM which stored value each
 * unrecognised label wants. Less reliable than a real adapter, and the plan says so -
 * but a form arriving mostly filled is most of the win when a human reviews it
 * before sending, and it turns the long tail from a manual link into a short edit.
 *
 * The `resolve` function is injected rather than built here, so this class holds no
 * LLM dependency and the engine's test does not need one.
 */
export class GenericAdapter implements AtsAdapter {
  readonly atsType = AtsType.CUSTOM;

  constructor(private readonly resolve: PrefillOptions['resolve']) {}

  /** Last resort. The registry only reaches it when nothing else claimed the URL. */
  canHandle(): boolean {
    return true;
  }

  prefill(page: FormPage, app: PreparedApplication): Promise<PrefillResult> {
    return runPrefill(page, app, {
      resolve: this.resolve,
      ...(app.screenshotPath ? { screenshotPath: app.screenshotPath } : {}),
    });
  }
}

/**
 * Picks the adapter for a URL.
 *
 * Order is specific-to-general and the generic adapter is not in the list - it is the
 * documented fallback, because a class whose `canHandle` returns true unconditionally
 * would shadow every adapter after it if it were ever reordered into the middle.
 */
export class AdapterRegistry {
  constructor(
    private readonly adapters: readonly AtsAdapter[],
    private readonly fallback: AtsAdapter,
  ) {}

  for(url: string): AtsAdapter {
    return (
      this.adapters.find((adapter) => adapter.canHandle(url)) ?? this.fallback
    );
  }
}

/** The tier order, best-supported first. */
export function boardAdapters(): AtsAdapter[] {
  return [
    new GreenhouseAdapter(),
    new LeverAdapter(),
    new AshbyAdapter(),
    new SmartRecruitersAdapter(),
    new WorkableAdapter(),
    new WorkdayAdapter(),
  ];
}

/**
 * The host, lower-cased, or null for anything that is not an http(s) URL.
 *
 * Parsed rather than matched with a regex on the whole string, because
 * `evil.com/?x=jobs.lever.co` matches a naive pattern and is not Lever. The host is
 * the only part of a URL that says who is serving it.
 */
function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}
