/**
 * One candidate resume, loaded once, in every shape the three screens need it in.
 *
 * WHY THIS EXISTS AS ITS OWN SERVICE. Rendering a preview, asking for suggestions and
 * tailoring against a pasted JD all begin with the same four steps: find the profile
 * and prove the caller owns it, read its atoms in ordinal order, work out the contact
 * block, and compute the technology union the provenance guard will accept. Written
 * three times, those four steps drift - and the one that drifts silently is the union.
 * `allowedTech` is what decides whether a rewrite counts as a fabricated skill, so a
 * copy that forgot to read SkillsReserve would reject honest rewrites on one screen and
 * a copy that forgot to canonicalise would accept "nodejs" on another. It is one
 * function here, and `TailoringService` builds its own only because its version is
 * shared across fifteen postings in a single run.
 *
 * OWNERSHIP IS PART OF LOADING, not a check beside it. `load` takes a userId and a
 * resume id together and a row belonging to somebody else is indistinguishable from one
 * that does not exist - the same property `ResumeLibraryService.owned` gives the
 * library, for the same reason: these routes take an id from the URL.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AtomKind } from '@prisma/client';
import type { TailorShared } from '../llm/tasks/tailor-resume.task';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalise } from '../profile/tech';
import {
  contactOf,
  type DocumentAtom,
  type ResumeContact,
} from './resume.document';
import type { GuardAtom } from './provenance.guard';

/** The columns every caller here reads. */
const PROFILE_SELECT = {
  id: true,
  userId: true,
  label: true,
  isActive: true,
  confirmedAt: true,
  fullName: true,
  email: true,
  phone: true,
  location: true,
  linkedIn: true,
  github: true,
  portfolio: true,
} as const;

export interface ResumeSource {
  profile: {
    id: string;
    userId: string;
    label: string;
    isActive: boolean;
    fullName: string;
  };
  contact: ResumeContact;
  /**
   * The line under the name on the base resume: the first ROLE atom's text, which is
   * the closest thing a parsed resume has to one. Same rule as the pipeline's, so a
   * preview and a real run put the same words there.
   */
  headline: string | null;
  /** In ordinal order, which is the order the document is assembled in. */
  documentAtoms: DocumentAtom[];
  guardAtoms: GuardAtom[];
  /** The cached prefix for either LLM task. Carries `allowedTech`. */
  shared: TailorShared;
}

@Injectable()
export class ResumeSourceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Loads one resume, or the active one when no id is given.
   *
   * Unconfirmed resumes are refused rather than rendered. A profile that has not been
   * through the confirmation gate has atoms nobody has read, and every stage after
   * this treats atoms as ground truth - see ResumeController's header.
   */
  async load(userId: string, resumeId?: string): Promise<ResumeSource> {
    const profile = resumeId
      ? await this.prisma.candidateProfile.findFirst({
          where: { id: resumeId, userId },
          select: PROFILE_SELECT,
        })
      : await this.prisma.candidateProfile.findFirst({
          where: { userId, isActive: true, confirmedAt: { not: null } },
          select: PROFILE_SELECT,
        });

    if (!profile) {
      throw new NotFoundException(
        resumeId
          ? 'no such resume'
          : 'no resume is selected. Pick one under Resumes first.',
      );
    }
    if (!profile.confirmedAt) {
      throw new ConflictException(
        'that resume has not been confirmed yet, so nothing may build on it',
      );
    }

    const atoms = await this.prisma.profileAtom.findMany({
      where: { profileId: profile.id },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        kind: true,
        text: true,
        tech: true,
        metrics: true,
        employer: true,
        dateRange: true,
        ordinal: true,
      },
    });

    if (atoms.length === 0) {
      throw new BadRequestException(
        'that resume has no pieces in it, so there is nothing to build from',
      );
    }

    const reserve = await this.prisma.skillsReserve.findMany({
      // ENABLED only, exactly as the pipeline reads it. The table exists so that
      // widening what a rewrite may claim is a deliberate act, and reading disabled
      // rows here would undo that on a screen instead of in a run.
      where: { userId, enabled: true },
      select: { skill: true },
    });

    const allowedTech = [
      ...new Set(
        [...atoms.flatMap((a) => a.tech), ...reserve.map((r) => r.skill)]
          .map((tech) => canonicalise(tech.trim()))
          .filter((tech) => tech.length > 0),
      ),
    ];

    const headline =
      atoms.find((atom) => atom.kind === AtomKind.ROLE)?.text ?? null;

    return {
      profile: {
        id: profile.id,
        userId: profile.userId,
        label: profile.label,
        isActive: profile.isActive,
        fullName: profile.fullName,
      },
      contact: contactOf(profile),
      headline,
      documentAtoms: atoms.map((atom) => ({
        id: atom.id,
        kind: atom.kind,
        text: atom.text,
        employer: atom.employer,
        dateRange: atom.dateRange,
        ordinal: atom.ordinal,
      })),
      guardAtoms: atoms.map((atom) => ({
        id: atom.id,
        text: atom.text,
        tech: atom.tech,
        metrics: atom.metrics,
        employer: atom.employer,
        dateRange: atom.dateRange,
      })),
      shared: {
        fullName: profile.fullName,
        headline,
        atoms: atoms.map((atom) => ({
          id: atom.id,
          kind: atom.kind,
          text: atom.text,
          tech: atom.tech,
          metrics: atom.metrics,
          employer: atom.employer,
          dateRange: atom.dateRange,
        })),
        allowedTech,
      },
    };
  }
}
