/**
 * The tracker: applications the candidate made by hand, and the people who might refer
 * them.
 *
 * WHY THIS EXISTS BESIDE THE PIPELINE RATHER THAN INSIDE IT. Everything else in this
 * codebase starts from a posting that was crawled: discovery finds it, matching scores
 * it, submission fills its form, and `applications` records the result. That covers the
 * applications this system found. It covers none of the ones a person finds themselves -
 * the job a friend forwarded, the role only on the company's own site, the opening
 * somebody mentioned on a call - and those are the applications a referral is usually
 * attached to, which makes them exactly the ones worth keeping notes on.
 *
 * So this is a log, and it is deliberately dumb. Nothing here scores, ranks, screens or
 * decides. It does not touch MatchScore, it does not create `applications` rows, and no
 * scheduler reads it. Every field is something the candidate typed, which is the property
 * that makes the list trustworthy six months later: nothing in it was inferred.
 *
 * THE PEOPLE ARE A TABLE AND NOT A TEXT FIELD, which is the one structural decision here.
 * See TrackedContact in schema.prisma: typed per application, one person becomes three
 * spellings and "who have I actually asked, and how often" stops being answerable.
 *
 * EVERY WRITE RETURNS THE WHOLE VIEW, like BlockedCompaniesService. Here there is a second
 * reason beyond keeping counts honest: the referrer picker on the applications tab is fed
 * by the contacts list, so a screen that refetched them separately could show a picker
 * that disagrees with the People tab beside it.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TrackedStage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How much one candidate may keep.
 *
 * Not storage limits - the rows are tiny. They are the points past which the thing has
 * stopped being a list somebody maintains: 500 hand-typed applications is more than
 * anyone types, and a contact list of 200 is an address book rather than the handful of
 * people who would actually vouch for you. They also bound the response, because every
 * write returns the whole view.
 */
const MAX_APPLICATIONS = 500;
const MAX_CONTACTS = 200;

/** One person. */
export interface TrackedContactRow {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  linkedInUrl: string | null;
  email: string | null;
  note: string | null;
  /**
   * Applications on the list that name them as the referrer.
   *
   * Sent rather than left to the screen to count, because it is also what makes a delete
   * refusable with a reason - and because it is the number that answers the question the
   * contact list exists for: who is actually vouching for you, as opposed to who you
   * happen to know.
   */
  referrals: number;
  createdAt: string;
}

/** One application, with its referrer resolved. */
export interface TrackedApplicationRow {
  id: string;
  company: string;
  role: string | null;
  jobUrl: string | null;
  careersUrl: string | null;
  stage: TrackedStage;
  /** `YYYY-MM-DD`, or null for something saved but not yet applied to. */
  appliedOn: string | null;
  linkedInInviteSent: boolean;
  referralGiven: boolean;
  /**
   * Null with `referralGiven` true means a referral happened and who did it was not
   * recorded. That is a legitimate row, not a broken one - see the schema.
   */
  referrer: { id: string; name: string; company: string | null } | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerView {
  applications: TrackedApplicationRow[];
  contacts: TrackedContactRow[];
  /** So the screen can say how close the lists are to the cap rather than discovering it. */
  maxApplications: number;
  maxContacts: number;
}

/** What `add` accepts. `stage` and the two booleans have defaults, so they are optional. */
export interface TrackedApplicationInput {
  company: string;
  role?: string | null;
  jobUrl?: string | null;
  careersUrl?: string | null;
  stage?: TrackedStage;
  appliedOn?: string | null;
  linkedInInviteSent?: boolean;
  referralGiven?: boolean;
  referrerId?: string | null;
  notes?: string | null;
}

/** What `edit` accepts: the same fields, every one of them optional. */
export type TrackedApplicationPatch = Partial<TrackedApplicationInput>;

export interface TrackedContactInput {
  name: string;
  company?: string | null;
  role?: string | null;
  linkedInUrl?: string | null;
  email?: string | null;
  note?: string | null;
}

export type TrackedContactPatch = Partial<TrackedContactInput>;

/**
 * A bare date in, a Date out, matching `dayValue` in digest.service.
 *
 * Midnight UTC specifically, because the column is `@db.Date` and this is the value that
 * reads back as the same calendar day through `toISOString`. Building it from a local
 * midnight instead is how an application dated the 12th starts displaying as the 11th to
 * a reader in a negative offset.
 */
function dateValue(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Trims, and treats an all-whitespace string as "not given" rather than as an empty one. */
function text(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Injectable()
export class TrackerService {
  private readonly logger = new Logger(TrackerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async view(userId: string): Promise<TrackerView> {
    const [applications, contacts] = await Promise.all([
      this.prisma.trackedApplication.findMany({
        where: { userId },
        // The day you applied, newest first - which is the order somebody reads their own
        // log in. `nulls: 'last'` is load-bearing: a SAVED row has no date, and Postgres
        // sorts NULLs first on a DESC by default, so without it everything not yet applied
        // to would sit above this week's applications.
        orderBy: [
          { appliedOn: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        include: {
          referrer: { select: { id: true, name: true, company: true } },
        },
      }),
      this.prisma.trackedContact.findMany({
        where: { userId },
        orderBy: { name: 'asc' },
        // Counted in the same query rather than by walking the applications above: the
        // relation count is one join, and doing it here keeps the number right even for a
        // contact whose applications were all filtered out of some future paged read.
        include: { _count: { select: { referred: true } } },
      }),
    ]);

    return {
      applications: applications.map((row) => ({
        id: row.id,
        company: row.company,
        role: row.role,
        jobUrl: row.jobUrl,
        careersUrl: row.careersUrl,
        stage: row.stage,
        appliedOn: row.appliedOn?.toISOString().slice(0, 10) ?? null,
        linkedInInviteSent: row.linkedInInviteSent,
        referralGiven: row.referralGiven,
        referrer: row.referrer,
        notes: row.notes,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      contacts: contacts.map((row) => ({
        id: row.id,
        name: row.name,
        company: row.company,
        role: row.role,
        linkedInUrl: row.linkedInUrl,
        email: row.email,
        note: row.note,
        referrals: row._count.referred,
        createdAt: row.createdAt.toISOString(),
      })),
      maxApplications: MAX_APPLICATIONS,
      maxContacts: MAX_CONTACTS,
    };
  }

  // --- applications ---------------------------------------------------------

  async addApplication(
    userId: string,
    input: TrackedApplicationInput,
  ): Promise<TrackerView> {
    const count = await this.prisma.trackedApplication.count({
      where: { userId },
    });
    if (count >= MAX_APPLICATIONS) {
      throw new BadRequestException(
        `that is ${MAX_APPLICATIONS} applications tracked, which is as many as this ` +
          'list holds. Removing the ones that are long since closed is the intended ' +
          'way down from here.',
      );
    }

    const referral = await this.resolveReferral(userId, {
      referralGiven: input.referralGiven,
      referrerId: input.referrerId,
    });

    const created = await this.prisma.trackedApplication.create({
      data: {
        userId,
        company: input.company.trim(),
        role: text(input.role) ?? null,
        jobUrl: text(input.jobUrl) ?? null,
        careersUrl: text(input.careersUrl) ?? null,
        stage: input.stage ?? TrackedStage.APPLIED,
        appliedOn: input.appliedOn ? dateValue(input.appliedOn) : null,
        linkedInInviteSent: input.linkedInInviteSent ?? false,
        referralGiven: referral.referralGiven ?? false,
        referrerId: referral.referrerId ?? null,
        notes: text(input.notes) ?? null,
      },
      select: { id: true },
    });

    this.logger.log(
      `${userId} tracked an application to ${input.company.trim()} (${created.id})`,
    );
    return this.view(userId);
  }

  /**
   * Edits one row, field by field.
   *
   * PATCH AND NOT PUT, which is not the usual "fewer bytes" argument. This screen edits
   * one cell at a time - a stage dropdown, a LinkedIn checkbox - and a PUT would mean the
   * row as a whole is re-sent on every such click. A tab left open since the morning would
   * then quietly restore the notes it was still holding on top of the ones typed on a
   * phone since. With PATCH the untouched fields are absent rather than stale.
   *
   * `undefined` leaves a field alone; `null` clears it. That distinction is the whole
   * reason the body schema below marks the nullable fields `.nullable().optional()` rather
   * than just optional.
   */
  async editApplication(
    userId: string,
    id: string,
    patch: TrackedApplicationPatch,
  ): Promise<TrackerView> {
    const existing = await this.prisma.trackedApplication.findFirst({
      where: { id, userId },
      select: { referralGiven: true, referrerId: true, company: true },
    });
    if (!existing) throw new NotFoundException('no such tracked application');

    // Resolved against what the row already says, not against the patch alone: unticking
    // "referral given" on a row that names Priya has to clear Priya, and that is only
    // knowable with the current referrerId in hand.
    const referral = await this.resolveReferral(userId, {
      referralGiven: patch.referralGiven,
      referrerId: patch.referrerId,
      current: existing,
    });

    // UNCHECKED, i.e. the raw `referrerId` column rather than `referrer: { connect }`.
    // Not a shortcut: Prisma emits a nested relation write as its own statement after the
    // scalar UPDATE, so clearing a referral would send `referralGiven = false` while the
    // column still named Priya - and `..._referrer_without_referral_check` is a CHECK,
    // which Postgres cannot defer to the end of the transaction. It fired on the
    // intermediate row and turned a checkbox into a 500. Written as one column, both halves
    // of the rule move in the same statement and the constraint sees only the final row.
    // Safe here because ownership of the referrer was just confirmed above, which is the
    // only thing `connect` would have bought.
    const data: Prisma.TrackedApplicationUncheckedUpdateInput = {
      ...(patch.company !== undefined ? { company: patch.company.trim() } : {}),
      ...(patch.role !== undefined ? { role: text(patch.role) } : {}),
      ...(patch.jobUrl !== undefined ? { jobUrl: text(patch.jobUrl) } : {}),
      ...(patch.careersUrl !== undefined
        ? { careersUrl: text(patch.careersUrl) }
        : {}),
      ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
      ...(patch.appliedOn !== undefined
        ? { appliedOn: patch.appliedOn ? dateValue(patch.appliedOn) : null }
        : {}),
      ...(patch.linkedInInviteSent !== undefined
        ? { linkedInInviteSent: patch.linkedInInviteSent }
        : {}),
      ...(referral.referralGiven !== undefined
        ? { referralGiven: referral.referralGiven }
        : {}),
      ...(referral.referrerId !== undefined
        ? { referrerId: referral.referrerId }
        : {}),
      ...(patch.notes !== undefined ? { notes: text(patch.notes) } : {}),
    };

    // Nothing to do. Returning the view rather than throwing, because an empty patch is
    // what a form submitted with no edits sends, and that is not a failure.
    if (Object.keys(data).length === 0) return this.view(userId);

    await this.prisma.trackedApplication.update({ where: { id }, data });
    this.logger.log(`${userId} edited a tracked application (${id})`);
    return this.view(userId);
  }

  /**
   * Removes one row.
   *
   * `deleteMany` scoped by userId, so an id belonging to another account deletes nothing
   * and is reported as not found - indistinguishable from an id that never existed, which
   * is the rule every /api/me route here follows.
   */
  async removeApplication(userId: string, id: string): Promise<TrackerView> {
    const { count } = await this.prisma.trackedApplication.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw new NotFoundException('no such tracked application');

    this.logger.log(`${userId} removed a tracked application`);
    return this.view(userId);
  }

  // --- people ---------------------------------------------------------------

  /**
   * Adds a person.
   *
   * NO DUPLICATE CHECK, unlike BlockedCompaniesService, and the difference is the subject.
   * Two blocklist entries that normalise to one employer are the same rule typed twice and
   * cannot be separately useful. Two contacts called Priya Nair may be two people, and a
   * list that refuses the second one cannot describe the referral that actually happened.
   * The picker shows "name — company" instead, so the duplicate that IS a slip is visible.
   */
  async addContact(
    userId: string,
    input: TrackedContactInput,
  ): Promise<TrackerView> {
    const count = await this.prisma.trackedContact.count({ where: { userId } });
    if (count >= MAX_CONTACTS) {
      throw new BadRequestException(
        `that is ${MAX_CONTACTS} people, which is as many as this list holds. It is ` +
          'meant to be the people who would vouch for you rather than everyone you have met.',
      );
    }

    const created = await this.prisma.trackedContact.create({
      data: {
        userId,
        name: input.name.trim(),
        company: text(input.company) ?? null,
        role: text(input.role) ?? null,
        linkedInUrl: text(input.linkedInUrl) ?? null,
        email: text(input.email) ?? null,
        note: text(input.note) ?? null,
      },
      select: { id: true },
    });

    this.logger.log(`${userId} added a contact (${created.id})`);
    return this.view(userId);
  }

  async editContact(
    userId: string,
    id: string,
    patch: TrackedContactPatch,
  ): Promise<TrackerView> {
    const existing = await this.prisma.trackedContact.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('no such person on your list');

    const data: Prisma.TrackedContactUpdateInput = {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.company !== undefined ? { company: text(patch.company) } : {}),
      ...(patch.role !== undefined ? { role: text(patch.role) } : {}),
      ...(patch.linkedInUrl !== undefined
        ? { linkedInUrl: text(patch.linkedInUrl) }
        : {}),
      ...(patch.email !== undefined ? { email: text(patch.email) } : {}),
      ...(patch.note !== undefined ? { note: text(patch.note) } : {}),
    };
    if (Object.keys(data).length === 0) return this.view(userId);

    await this.prisma.trackedContact.update({ where: { id }, data });
    this.logger.log(`${userId} edited a contact (${id})`);
    return this.view(userId);
  }

  /**
   * Removes a person.
   *
   * REFUSED WHILE THEY ARE NAMED ON AN APPLICATION, and the message says which ones. The
   * foreign key is `onDelete: Restrict` for the same reason: SetNull would turn four
   * "referred by Priya" rows into four "referred by nobody" in one click, with nothing
   * afterwards to show that it happened - and the referral is usually the most useful
   * thing on the row. Detaching the contact from those applications first is a decision,
   * which is what it should be.
   */
  async removeContact(userId: string, id: string): Promise<TrackerView> {
    const contact = await this.prisma.trackedContact.findFirst({
      where: { id, userId },
      select: {
        name: true,
        referred: { select: { company: true }, orderBy: { company: 'asc' } },
      },
    });
    if (!contact) throw new NotFoundException('no such person on your list');

    if (contact.referred.length > 0) {
      const employers = [
        ...new Set(contact.referred.map((row) => row.company)),
      ];
      const named = employers.slice(0, 5).join(', ');
      const rest =
        employers.length > 5 ? `, and ${employers.length - 5} more` : '';
      throw new BadRequestException(
        `${contact.name} is named as the referrer on ${contact.referred.length} ` +
          `application${contact.referred.length === 1 ? '' : 's'} (${named}${rest}). ` +
          'Clear the referral on those first - removing them here would quietly erase ' +
          'who referred you.',
      );
    }

    await this.prisma.trackedContact.delete({ where: { id } });
    this.logger.log(`${userId} removed a contact`);
    return this.view(userId);
  }

  // --- the one rule that spans two fields -----------------------------------

  /**
   * Keeps `referralGiven` and `referrerId` telling the same story.
   *
   * Three rules, and each one exists because the other resolutions are worse:
   *
   *   1. NAMING A REFERRER SETS `referralGiven`. Recording who did it is the stronger
   *      statement, so requiring the tick as well would just be a way to fail.
   *   2. CLEARING `referralGiven` CLEARS THE REFERRER. The database CHECK forbids the
   *      combination, so the alternative is a 500 from a checkbox.
   *   3. SENDING BOTH IN CONTRADICTION IS REFUSED rather than silently resolved. A client
   *      that says "no referral" and "referred by Priya" in one request has a bug, and
   *      picking a winner for it hides the bug in the candidate's own records.
   *
   * The referrer is also confirmed to belong to THIS user. Without that check an id from
   * another account would attach, and the view would then read that stranger's name back -
   * a cross-account leak through a field that looks like a harmless foreign key.
   */
  private async resolveReferral(
    userId: string,
    input: {
      referralGiven?: boolean;
      referrerId?: string | null;
      current?: { referralGiven: boolean; referrerId: string | null };
    },
  ): Promise<{ referralGiven?: boolean; referrerId?: string | null }> {
    const { referralGiven, referrerId, current } = input;

    if (referralGiven === false && referrerId) {
      throw new BadRequestException(
        'that says both that no referral was given and who gave it. Send one or the other.',
      );
    }

    if (referrerId) {
      const owned = await this.prisma.trackedContact.count({
        where: { id: referrerId, userId },
      });
      if (owned === 0) {
        throw new NotFoundException('no such person on your list');
      }
      return { referralGiven: true, referrerId };
    }

    // Explicitly off: drop whoever was named, or the CHECK rejects the row.
    if (referralGiven === false) {
      return current?.referrerId
        ? { referralGiven: false, referrerId: null }
        : { referralGiven: false };
    }

    // `referrerId: null` on its own - "I know it happened, not through whom". Keeps the
    // tick, drops the name.
    if (referrerId === null) {
      return referralGiven === undefined
        ? { referrerId: null }
        : { referralGiven, referrerId: null };
    }

    return referralGiven === undefined ? {} : { referralGiven };
  }
}
