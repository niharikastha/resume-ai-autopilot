/**
 * The employers a candidate will not apply to: reading, adding, removing.
 *
 * WHY THIS IS A SCREEN AND NOT A CONFIG FILE. Every other reason a posting is dropped
 * is a judgement about the job - the title, the place, the pay, the years. This one is
 * not about the job at all: it is "I worked there", "they already turned me down", "that
 * is the agency that calls me twice a week". No amount of reading a description produces
 * that answer, so the only place it can come from is the person, which means a screen.
 *
 * IT REPORTS WHAT EACH RULE COSTS, the same way the locations screen reports how many
 * postings its cities cover. A blocklist is matched on words (see
 * config/blocked-companies.ts), and a word is a rule whose reach is not obvious: `tech`
 * looks like one employer and covers eleven. So every entry comes back with the
 * employers on record that it actually covers and the number of open postings it is
 * keeping out. Typing something too broad is then visible immediately instead of six
 * weeks later as an unexplained drought.
 *
 * MATCHING IS NOT DONE HERE. It is a pure function in config/blocked-companies.ts,
 * because the match run and the apply plan apply the same rule and neither of them can
 * reach a provider in this module - see the note in profile.module.ts about the
 * containers cli/match.ts assembles by hand.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  blockedBy,
  normalizeCompany,
  type BlockedPattern,
} from '../config/blocked-companies';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How many employers one candidate may rule out.
 *
 * Not a storage limit - the rows are tiny. It is the point past which the list has
 * stopped being a blocklist and become an allowlist written backwards, and where the
 * honest fix is narrowing the title or location rules instead. Also bounds the work
 * `view` does: it is one pass over the company table per entry.
 */
const MAX_ENTRIES = 100;

/** One rule, with what it is actually doing. */
export interface BlockedCompanyRow {
  id: string;
  /** What the candidate typed. */
  label: string;
  reason: string | null;
  createdAt: string;
  /**
   * Employers on record whose name this rule covers.
   *
   * MAY BE EMPTY, and that is not an error: a candidate can rule out an employer this
   * system has never crawled, which is the ordinary case for the company they just
   * left. The screen says "nothing on record yet" rather than treating it as a typo -
   * the rule still applies the moment that board is discovered.
   */
  matches: string[];
  /** Open postings this rule is keeping out right now. */
  postings: number;
}

export interface BlockedCompaniesView {
  entries: BlockedCompanyRow[];
  /** Employer names on record, for the input's suggestion list. */
  known: string[];
  /** So the screen can say how close the list is to the cap rather than discovering it. */
  maxEntries: number;
}

@Injectable()
export class BlockedCompaniesService {
  private readonly logger = new Logger(BlockedCompaniesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async view(userId: string): Promise<BlockedCompaniesView> {
    const [entries, companies, openCounts] = await Promise.all([
      this.prisma.blockedCompany.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.company.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      // Grouped once for the whole screen rather than counted per entry: eleven rules
      // would otherwise be eleven aggregate queries over the postings table.
      this.prisma.jobPosting.groupBy({
        by: ['companyId'],
        where: { closedAt: null },
        _count: { _all: true },
      }),
    ]);

    const postingsByCompany = new Map(
      openCounts
        .filter((row): row is typeof row & { companyId: string } =>
          Boolean(row.companyId),
        )
        .map((row) => [row.companyId, row._count._all]),
    );

    return {
      entries: entries.map((entry) => {
        // The rule tested one at a time, so `matches` names the employers THIS entry
        // covers. `blockedBy` returns the first rule that fires, so passing the whole
        // list would attribute every company to whichever entry happened to be first.
        const rule: BlockedPattern = {
          pattern: entry.pattern,
          label: entry.label,
        };
        const covered = companies.filter(
          (company) => blockedBy(company.name, [rule]) !== undefined,
        );

        return {
          id: entry.id,
          label: entry.label,
          reason: entry.reason,
          createdAt: entry.createdAt.toISOString(),
          matches: covered.map((company) => company.name),
          postings: covered.reduce(
            (total, company) =>
              total + (postingsByCompany.get(company.id) ?? 0),
            0,
          ),
        };
      }),
      known: companies.map((company) => company.name),
      maxEntries: MAX_ENTRIES,
    };
  }

  /**
   * Rules an employer out.
   *
   * THE DUPLICATE IS REFUSED BY NAME, not silently merged. "HyScaler" and "hyscaler
   * pvt ltd" normalise to one pattern, and a list that accepts both shows the candidate
   * two rows that cannot be told apart and cannot be separately useful. The message
   * names the entry already there, because the honest response to "I already have this"
   * is to say which one.
   */
  async add(
    userId: string,
    input: { label: string; reason?: string },
  ): Promise<BlockedCompaniesView> {
    const label = input.label.trim();
    const pattern = normalizeCompany(label);

    // Reachable with a label that is entirely punctuation - "..." or "&". Refused here
    // because an empty pattern is a run inside every name, so it would silently block
    // the whole job market. `normalizeCompany` guards the same case from its own side;
    // this is the message a person gets.
    if (pattern.length === 0) {
      throw new BadRequestException(
        'that is not a name we can match on - it has no letters or digits in it.',
      );
    }

    const existing = await this.prisma.blockedCompany.findUnique({
      where: { userId_pattern: { userId, pattern } },
      select: { label: true },
    });
    if (existing) {
      throw new ConflictException(
        `${existing.label} is already on your list - the two names match the same employer.`,
      );
    }

    const count = await this.prisma.blockedCompany.count({ where: { userId } });
    if (count >= MAX_ENTRIES) {
      throw new BadRequestException(
        `that is ${MAX_ENTRIES} employers ruled out, which is as far as this list ` +
          'goes. A list this long is usually a sign the title or location rules are ' +
          'the ones worth narrowing.',
      );
    }

    await this.prisma.blockedCompany.create({
      data: {
        userId,
        label,
        pattern,
        reason: input.reason?.trim() ? input.reason.trim() : null,
      },
    });
    this.logger.log(`${userId} ruled out ${label} (matched as "${pattern}")`);

    return this.view(userId);
  }

  /**
   * Removes a rule.
   *
   * `deleteMany` scoped by userId, so an id belonging to another account deletes
   * nothing and is reported as not found - indistinguishable from an id that never
   * existed, which is the same rule every /api/me route in this codebase follows.
   */
  async remove(userId: string, id: string): Promise<BlockedCompaniesView> {
    const { count } = await this.prisma.blockedCompany.deleteMany({
      where: { id, userId },
    });
    if (count === 0) throw new NotFoundException('no such entry');

    this.logger.log(`${userId} removed a blocked employer`);
    return this.view(userId);
  }
}
