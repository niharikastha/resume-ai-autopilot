/**
 * Tailoring the candidate asked for, against a job description they chose.
 *
 * WHAT IS DIFFERENT FROM TailoringService, and it is not the tailoring. The prompt, the
 * atoms, the provenance guard, the document builder and the renderer are all the same
 * ones - there is no second template and no second guard, which is the property the
 * whole feature rests on. What differs is everything around the call:
 *
 *   the shortlist    There is none. The candidate named the posting, or pasted the
 *                    description in. MatchScore, the verdict filter, the company
 *                    cooldown and the daily cap are all the pipeline deciding what to
 *                    spend a call on when nobody is watching; none of them should stop a
 *                    person who is sitting there asking for one resume.
 *   the posting       May not exist. A pasted JD has no JobPosting row, which is why
 *                    these rows live in `TailoredResume` with a nullable jobId rather
 *                    than in `ResumeVariant` - see the model's own comment.
 *   the file name     Carries the row's id, so a hand-made resume for a company can
 *                    never overwrite the pipeline's variant for that same company.
 *
 * THE GUARD STILL FAILS CLOSED. A failed run renders and stores the BASE resume, the
 * row records `guardPassed: false` with the full report, and the screen says what
 * happened. That is the same fallback the pipeline uses and for the same reason: the
 * candidate should end up with something to send either way, and it must not be the
 * thing that failed the check.
 *
 * THREE THINGS A STORED RUN CAN DO AFTERWARDS, all of them rebuilt from the same row
 * and none of them a second LLM call:
 *
 *   changes     What is different from the candidate's own words, word by word.
 *   retypeset   The same decision in another template.
 *   markReview  A copy with the rewritten lines highlighted, to read rather than send.
 *
 * ALL THREE REBUILD FROM THE RESUME'S PIECES AS THEY ARE NOW, because the atoms are
 * where the candidate's words live and this row stores a decision about them, not a
 * copy of them. So editing a bullet and then re-typesetting a month-old run produces a
 * document with the edited bullet in it. That is the honest outcome - the alternative is
 * a frozen snapshot that quietly disagrees with the resume the candidate is looking at -
 * but it does mean a diff shown here is against today's resume, and the screen says so.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AtomKind, Prisma, ResumeTemplate } from '@prisma/client';
import { randomUUID } from 'crypto';
import { stat, unlink } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { LLM_PROVIDER, type LlmProvider } from '../llm/llm.types';
import {
  tailorResumeTask,
  type TailorInput,
  type TailorOutput,
} from '../llm/tasks/tailor-resume.task';
import { PrismaService } from '../prisma/prisma.service';
import {
  checkProvenance,
  summarize,
  type ProvenanceReport,
} from './provenance.guard';
import { buildResume, resumeFilename } from './resume.document';
import { renderResume } from './resume.render';
import { ResumeSourceService, type ResumeSource } from './resume.source';
import { templateWriter } from './resume.templates';
import { diffWords, type DiffSegment } from './text.diff';

export interface TailorRequest {
  /** Which resume to build from. Absent means the selected one. */
  resumeId?: string;
  /** A posting this system discovered. Mutually exclusive with `jdText`. */
  jobId?: string;
  /** A description pasted in by hand. */
  jdText?: string;
  /** Only read on the pasted path; a posting brings its own. */
  title?: string;
  company?: string;
}

export interface TailoredSummary {
  id: string;
  resumeId: string;
  jobId: string | null;
  title: string;
  company: string;
  /** The first line or two of the JD, so the history is readable. */
  jdPreview: string;
  guardPassed: boolean;
  /** One sentence per violation, for the screen. Empty when it passed. */
  violations: string[];
  /** What the guard actually looked at. See GuardCounts. */
  counts: ProvenanceReport['counts'] | null;
  coverLetter: string | null;
  docx: boolean;
  pdf: boolean;
  /** The template the files on disk are written in. */
  template: ResumeTemplate;
  createdAt: string;
  model: string | null;
}

export type TailoredFormat = 'pdf' | 'docx';

/** One line the model rewrote, against the candidate's own wording. */
export interface TailoredChangeLine {
  atomId: string;
  kind: AtomKind;
  employer: string | null;
  /** The candidate's sentence, as this resume holds it now. */
  before: string;
  /** What the tailored version says instead. */
  after: string;
  /** `before` and `after` as one sequence of labelled runs. See text.diff.ts. */
  segments: DiffSegment[];
  added: number;
  removed: number;
}

/** A piece of the resume the tailored version leaves off the page. */
export interface TailoredDroppedLine {
  atomId: string;
  kind: AtomKind;
  employer: string | null;
  text: string;
}

/**
 * What tailoring did to the resume.
 *
 * `applied` is the difference between "this is what your resume says" and "this is what
 * was proposed and refused". On a rejected run the document on disk is the base resume,
 * so the lines below are a record of what the guard threw out - and showing them without
 * that flag would tell a candidate their resume says something it does not.
 */
export interface TailoredChanges {
  id: string;
  template: ResumeTemplate;
  applied: boolean;
  headline: {
    before: string | null;
    after: string;
    segments: DiffSegment[];
  } | null;
  rewritten: TailoredChangeLine[];
  dropped: TailoredDroppedLine[];
  /** Selected pieces printed word for word - the safest outcome, and usually the most. */
  kept: number;
  /** Selected ids that are no longer pieces of this resume, because it was edited since. */
  missing: number;
}

/** A JD shorter than this is a job title, not a description worth a deep-tier call. */
export const MIN_JD_CHARS = 120;

@Injectable()
export class OnDemandTailoringService {
  private readonly logger = new Logger(OnDemandTailoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: ResumeSourceService,
    private readonly config: ConfigService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async run(userId: string, request: TailorRequest): Promise<TailoredSummary> {
    const source = await this.source.load(userId, request.resumeId);
    const target = await this.resolveTarget(request);

    // The id is minted before the render, because it is part of the filename - see
    // `basenameFor`. A row is written under this id below whether the guard passed or
    // not, so there is no orphan file naming a row that does not exist.
    const id = randomUUID();

    const call = await this.llm.complete(tailorResumeTask, source.shared, {
      title: target.title,
      company: target.company,
      description: target.jdText,
    } satisfies TailorInput);

    const output: TailorOutput = call.value;

    const report = checkProvenance({
      atoms: source.guardAtoms,
      allowedTech: source.shared.allowedTech,
      output,
    });

    if (report.passed) {
      this.logger.log(
        `${target.title} @ ${target.company}: ${summarize(report)}`,
      );
    } else {
      this.logger.warn(
        `${target.title} @ ${target.company}: ${summarize(report)} - falling back ` +
          'to the base resume',
      );
      for (const violation of report.violations) {
        this.logger.warn(`    ${violation.kind}: ${violation.detail}`);
      }
    }

    // `null` tailoring is the base resume, built by the same function. The fallback is
    // not a second renderer.
    const document = buildResume(
      source.documentAtoms,
      source.contact,
      source.headline,
      report.passed ? output : null,
    );

    // The resume's own template, chosen on the editing screen. Not a parameter of the
    // run: a candidate who picked Compact picked it for everything this resume produces,
    // and asking again per run would be asking the same question twice.
    const template = source.profile.resumeTemplate;

    const rendered = await renderResume(
      document,
      this.dir(),
      basenameFor(id, source.profile.fullName, target.company, target.title),
      { write: templateWriter(template) },
    );

    const row = await this.prisma.tailoredResume.create({
      data: {
        id,
        userId,
        profileId: source.profile.id,
        jobId: target.jobId,
        title: target.title,
        company: target.company,
        jdText: target.jdText,
        // The model's raw decision, kept verbatim even when it was rejected: a
        // rejected selection is the evidence for why it was rejected.
        atomSelection: {
          selectedAtomIds: output.selectedAtomIds,
          rewrites: output.rewrites,
          headline: output.headline,
        },
        // Only when it passed. A cover letter citing an invented figure must not sit in
        // the database where a later screen would offer it for sending.
        coverLetter: report.passed ? output.coverLetter || null : null,
        docxPath: rendered.docxPath,
        pdfPath: rendered.pdfPath,
        template,
        provenanceReport: report as unknown as Prisma.InputJsonValue,
        guardPassed: report.passed,
        llmProvider: call.provider,
        model: call.model,
      },
    });

    return summaryOf(row);
  }

  /** The history, newest first. */
  async list(userId: string, resumeId?: string): Promise<TailoredSummary[]> {
    const rows = await this.prisma.tailoredResume.findMany({
      where: { userId, ...(resumeId ? { profileId: resumeId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_MAX,
    });
    return rows.map((row) => summaryOf(row));
  }

  /**
   * One tailored file, ready to stream.
   *
   * The path comes out of the row rather than being rebuilt from its fields, so a
   * renaming of the filename rule cannot orphan documents that already exist. The row is
   * found by id AND userId together, so somebody else's resume is not merely refused but
   * unfindable.
   */
  async file(
    userId: string,
    id: string,
    format: TailoredFormat,
  ): Promise<{ path: string; filename: string }> {
    const row = await this.prisma.tailoredResume.findFirst({
      where: { id, userId },
      select: { docxPath: true, pdfPath: true, title: true, company: true },
    });
    if (!row) throw new NotFoundException('no such tailored resume');

    const path = format === 'pdf' ? row.pdfPath : row.docxPath;
    if (!path) {
      throw new NotFoundException(
        format === 'pdf'
          ? 'this one has no pdf - LibreOffice could not convert it. The Word file ' +
              'is the same document.'
          : 'this one has no file on disk any more',
      );
    }

    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) {
      throw new NotFoundException(
        'that file is no longer on disk. Tailor it again - it is rebuilt from the ' +
          'same pieces.',
      );
    }

    // The generated name is already `Name_Company_Role_id8.pdf`, which is what the
    // candidate wants in a downloads folder.
    return { path, filename: basename(path) };
  }

  /**
   * What tailoring changed, word by word.
   *
   * READS ONLY. No render, because the panel showing this should appear while the
   * document beside it is still converting - and because a diff is cheap and a
   * LibreOffice run is not.
   *
   * The comparison is against the resume's pieces AS THEY ARE NOW; see the header. A
   * selected id that no longer matches a piece is counted in `missing` rather than
   * dropped silently, so a candidate who has edited their resume since can tell that
   * this run describes a slightly different one.
   */
  async changes(userId: string, id: string): Promise<TailoredChanges> {
    const row = await this.prisma.tailoredResume.findFirst({
      where: { id, userId },
      select: {
        id: true,
        profileId: true,
        template: true,
        guardPassed: true,
        atomSelection: true,
      },
    });
    if (!row) throw new NotFoundException('no such tailored resume');

    const decision = decisionOf(row.atomSelection);
    const source = await this.source.load(userId, row.profileId);
    const atoms = new Map(source.documentAtoms.map((a) => [a.id, a]));

    const selected = new Set(decision?.selectedAtomIds ?? []);
    const rewrites = new Map(
      (decision?.rewrites ?? []).map((r) => [r.atomId, r.text]),
    );

    const rewritten: TailoredChangeLine[] = [];
    let kept = 0;
    for (const atomId of selected) {
      const atom = atoms.get(atomId);
      // Counted in `missing` below rather than here: there is nothing to diff against.
      if (!atom) continue;
      const after = rewrites.get(atomId);
      if (after === undefined || after === atom.text) {
        kept++;
        continue;
      }
      const diff = diffWords(atom.text, after);
      rewritten.push({
        atomId,
        kind: atom.kind,
        employer: atom.employer,
        before: atom.text,
        after,
        segments: diff.segments,
        added: diff.added,
        removed: diff.removed,
      });
    }

    // In the resume's own order, which is the order they are missing FROM. Sorted by
    // ordinal because a list of omissions is read against the document it came out of.
    const dropped: TailoredDroppedLine[] = source.documentAtoms
      .filter((atom) => !selected.has(atom.id))
      .map((atom) => ({
        atomId: atom.id,
        kind: atom.kind,
        employer: atom.employer,
        text: atom.text,
      }));

    const missing = [...selected].filter((atomId) => !atoms.has(atomId)).length;

    const headlineAfter = decision?.headline?.trim();
    return {
      id: row.id,
      template: row.template,
      applied: row.guardPassed,
      headline:
        headlineAfter && headlineAfter !== source.headline
          ? {
              before: source.headline,
              after: headlineAfter,
              segments: diffWords(source.headline ?? '', headlineAfter)
                .segments,
            }
          : null,
      rewritten,
      dropped,
      kept,
      missing,
    };
  }

  /**
   * The same run, typeset in another template.
   *
   * No LLM call: the decision is in the row and only the writer changes. The files are
   * overwritten under the same basename, so one run stays one pair of files however many
   * times the candidate switches - the alternative accumulates a document per template
   * per run on disk, each holding a home address.
   *
   * The row's `template` is updated and the resume's is NOT. Switching template on one
   * past run is a comparison; switching it for everything is a decision, and that one
   * belongs to the picker on the editing screen.
   */
  async retypeset(
    userId: string,
    id: string,
    template: ResumeTemplate,
  ): Promise<TailoredSummary> {
    const row = await this.prisma.tailoredResume.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('no such tailored resume');

    const source = await this.source.load(userId, row.profileId);
    const document = this.rebuild(source, row.atomSelection, row.guardPassed);

    const rendered = await renderResume(
      document,
      this.dir(),
      basenameFor(row.id, source.profile.fullName, row.company, row.title),
      { write: templateWriter(template) },
    );

    const updated = await this.prisma.tailoredResume.update({
      where: { id: row.id },
      data: {
        template,
        docxPath: rendered.docxPath,
        pdfPath: rendered.pdfPath,
      },
    });
    return summaryOf(updated);
  }

  /**
   * A copy with the rewritten lines highlighted, for reading.
   *
   * WHY A SEPARATE FILE AND NOT THE DOCUMENT ITSELF. The document is what an employer
   * opens, and a resume arriving with yellow marker on four bullets is worse than no
   * highlighting at all. So the review copy goes to its own directory under its own
   * name, only a pdf route serves it, and nothing offers it as a download.
   *
   * REFUSED FOR A REJECTED RUN. Those rendered the base resume - the candidate's own
   * words throughout - so a marked copy of one would be a page with nothing marked on
   * it, which reads as "the highlighting is broken" rather than as "nothing was changed".
   */
  async markReview(
    userId: string,
    id: string,
  ): Promise<{ pdf: boolean; marked: number }> {
    const row = await this.prisma.tailoredResume.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('no such tailored resume');
    if (!row.guardPassed) {
      throw new BadRequestException(
        'this run was rejected, so the document is your base resume - there is ' +
          'nothing on it that you did not write',
      );
    }

    const source = await this.source.load(userId, row.profileId);
    const document = this.rebuild(source, row.atomSelection, true);

    const rendered = await renderResume(
      document,
      this.reviewDir(),
      reviewBasename(row.id),
      { write: templateWriter(row.template), mark: true },
    );

    const marked =
      document.roles.reduce(
        (at, block) =>
          at +
          (block.titleRewritten ? 1 : 0) +
          block.bullets.filter((b) => b.rewritten).length,
        0,
      ) +
      document.skills.filter((s) => s.rewritten).length +
      document.education.filter((e) => e.rewritten).length;

    return { pdf: rendered.pdfPath !== null, marked };
  }

  /** The marked copy's pdf, if `markReview` has been run for this row. */
  async reviewFile(
    userId: string,
    id: string,
  ): Promise<{ path: string; filename: string }> {
    const row = await this.prisma.tailoredResume.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('no such tailored resume');

    const path = join(this.reviewDir(), `${reviewBasename(row.id)}.pdf`);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) {
      throw new NotFoundException(
        'no marked copy has been rendered for this one yet, or LibreOffice could ' +
          'not produce one',
      );
    }
    return { path, filename: `${reviewBasename(row.id)}.pdf` };
  }

  /** Forgets one, and removes what it wrote. */
  async remove(userId: string, id: string): Promise<void> {
    const row = await this.prisma.tailoredResume.findFirst({
      where: { id, userId },
      select: { id: true, docxPath: true, pdfPath: true },
    });
    if (!row) throw new NotFoundException('no such tailored resume');

    await this.prisma.tailoredResume.delete({ where: { id: row.id } });

    // Best effort, and after the row is gone: a resume that cannot be deleted because
    // of a permissions problem on a generated file would be a dead end, and a file left
    // behind is only wasted disk.
    //
    // The review copy is deleted here too, by name rather than from a column - it is
    // derived, it is never recorded, and leaving one behind would leave a marked-up
    // resume on disk after the candidate asked for it to be forgotten.
    const review = join(this.reviewDir(), reviewBasename(row.id));
    for (const path of [
      row.docxPath,
      row.pdfPath,
      `${review}.docx`,
      `${review}.pdf`,
    ]) {
      if (path) await unlink(path).catch(() => undefined);
    }
  }

  /**
   * The stored decision as a document, ready to render.
   *
   * ONE PLACE, because `retypeset` and `markReview` must produce the same page from the
   * same row - one of them differing in what it prints would make the marked copy a
   * description of a document that does not exist.
   *
   * A rejected run rebuilds as the BASE resume, which is what its files hold. Passing
   * the stored selection anyway would quietly render the thing the guard refused.
   */
  private rebuild(
    source: ResumeSource,
    atomSelection: Prisma.JsonValue,
    guardPassed: boolean,
  ) {
    const decision = guardPassed ? decisionOf(atomSelection) : null;
    return buildResume(
      source.documentAtoms,
      source.contact,
      source.headline,
      decision,
    );
  }

  /**
   * Which job description to tailor against.
   *
   * Exactly one of the two paths. A posting id and a pasted description together is not
   * a request with a sensible reading - which of the two the resume was written for is
   * the one thing the row has to record honestly.
   */
  private async resolveTarget(request: TailorRequest): Promise<{
    jobId: string | null;
    title: string;
    company: string;
    jdText: string;
  }> {
    const pasted = request.jdText?.trim() ?? '';

    if (request.jobId && pasted.length > 0) {
      throw new BadRequestException(
        'pick a job or paste a description, not both - the resume can only be ' +
          'written for one of them',
      );
    }

    if (request.jobId) {
      const job = await this.prisma.jobPosting.findUnique({
        where: { id: request.jobId },
        include: { company: true },
      });
      if (!job) throw new NotFoundException('no such job');
      if (!job.descriptionText || job.descriptionText.trim().length === 0) {
        // Thrown rather than falling back to the title, because a resume tailored to a
        // job title is a resume tailored to nothing, and it would have cost a
        // deep-tier call to find that out.
        throw new BadRequestException(
          'that posting was stored without a description, so there is nothing to ' +
            'tailor against. Paste the description in instead.',
        );
      }
      return {
        jobId: job.id,
        title: job.title,
        company: job.company?.name ?? 'the company',
        jdText: job.descriptionText,
      };
    }

    if (pasted.length < MIN_JD_CHARS) {
      throw new BadRequestException(
        `paste the job description - at least ${MIN_JD_CHARS} characters. Anything ` +
          'shorter is a job title, and tailoring to a title just reorders bullets at ' +
          'random.',
      );
    }

    return {
      jobId: null,
      // Defaults rather than a rejection: the two are for the file's name and for the
      // prompt's framing, and a pasted description usually says the role in its first
      // line anyway.
      title: request.title?.trim() || 'the role',
      company: request.company?.trim() || 'the company',
      jdText: pasted,
    };
  }

  /** `<RESUME_OUTPUT_DIR>/tailored`, absolute - LibreOffice needs an absolute path. */
  private dir(): string {
    return resolve(
      this.config.getOrThrow<string>('RESUME_OUTPUT_DIR'),
      'tailored',
    );
  }

  /**
   * `<RESUME_OUTPUT_DIR>/review`, absolute.
   *
   * A directory of its own, not a suffix beside the real documents. These are the only
   * files this system writes that must never be sent, and one wrong click in a file
   * manager is all it takes when they sit in the same folder one character apart.
   */
  private reviewDir(): string {
    return resolve(
      this.config.getOrThrow<string>('RESUME_OUTPUT_DIR'),
      'review',
    );
  }
}

/** How many past runs the history shows. */
const HISTORY_MAX = 100;

/**
 * `Astha_Niharika_<Company>_<Role>_<id8>`.
 *
 * The id suffix is the point. Without it, tailoring twice for the same company and role
 * - which is what iterating on a JD looks like - silently overwrites the earlier pdf
 * while its database row goes on pointing at the file, so a history entry would offer a
 * download of a different resume than the one it describes. Eight hex characters, which
 * is short enough to leave the readable part readable in a downloads folder.
 */
function basenameFor(
  id: string,
  fullName: string,
  company: string,
  title: string,
): string {
  return `${resumeFilename(fullName, company, title)}_${id.slice(0, 8)}`;
}

/**
 * The review copy's name: the row's id and the word REVIEW, in capitals.
 *
 * No candidate name and no company, deliberately. This file is not a resume anybody
 * should send, and a name that reads like one - `Astha_Niharika_HighRadius_...` sitting
 * in a downloads folder - is how it would get sent.
 */
function reviewBasename(id: string): string {
  return `REVIEW-marked-changes-${id}`;
}

/** The first couple of lines of a JD, for the history list. */
function previewOf(jdText: string): string {
  return jdText.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function summaryOf(row: {
  id: string;
  profileId: string;
  jobId: string | null;
  title: string;
  company: string;
  jdText: string;
  guardPassed: boolean;
  provenanceReport: Prisma.JsonValue;
  coverLetter: string | null;
  docxPath: string | null;
  pdfPath: string | null;
  template: ResumeTemplate;
  createdAt: Date;
  model: string | null;
}): TailoredSummary {
  const report = reportOf(row.provenanceReport);
  return {
    id: row.id,
    resumeId: row.profileId,
    jobId: row.jobId,
    title: row.title,
    company: row.company,
    jdPreview: previewOf(row.jdText),
    guardPassed: row.guardPassed,
    violations: report?.violations.map((v) => `${v.kind}: ${v.detail}`) ?? [],
    counts: report?.counts ?? null,
    coverLetter: row.coverLetter,
    docx: row.docxPath !== null,
    pdf: row.pdfPath !== null,
    template: row.template,
    createdAt: row.createdAt.toISOString(),
    model: row.model,
  };
}

/**
 * The stored report, read defensively.
 *
 * It is a Json column written by an earlier version of this code, so its shape is a
 * historical fact rather than a current type. A row whose report cannot be read still
 * lists and still downloads - the document on disk is the thing the candidate wants -
 * so this returns null instead of throwing.
 */
function reportOf(value: Prisma.JsonValue): ProvenanceReport | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const report = value as unknown as ProvenanceReport;
  return Array.isArray(report.violations) ? report : null;
}

/**
 * The stored selection, read defensively, as the thing `buildResume` takes.
 *
 * Same reasoning as `reportOf`: a Json column is a historical fact. The three fields
 * checked here are exactly the three `buildResume` reads - `coverLetter` is filled in
 * empty because the type carries it and the document never prints it - so a row this
 * returns is a row that renders, and a row it cannot read renders as the base resume
 * rather than throwing on a screen the candidate opened to download a file.
 */
function decisionOf(value: Prisma.JsonValue): TailorOutput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const stored = value as {
    selectedAtomIds?: unknown;
    rewrites?: unknown;
    headline?: unknown;
  };
  if (!Array.isArray(stored.selectedAtomIds)) return null;

  const rewrites = Array.isArray(stored.rewrites) ? stored.rewrites : [];
  return {
    selectedAtomIds: stored.selectedAtomIds.filter(
      (id): id is string => typeof id === 'string',
    ),
    rewrites: rewrites.filter(
      (r): r is { atomId: string; text: string } =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as { atomId?: unknown }).atomId === 'string' &&
        typeof (r as { text?: unknown }).text === 'string',
    ),
    headline: typeof stored.headline === 'string' ? stored.headline : '',
    coverLetter: '',
  };
}
