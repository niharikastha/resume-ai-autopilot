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
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { stat, unlink } from 'fs/promises';
import { basename, resolve } from 'path';
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
import { ResumeSourceService } from './resume.source';

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
  createdAt: string;
  model: string | null;
}

export type TailoredFormat = 'pdf' | 'docx';

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

    const rendered = await renderResume(
      document,
      this.dir(),
      basenameFor(id, source.profile.fullName, target.company, target.title),
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
    for (const path of [row.docxPath, row.pdfPath]) {
      if (path) await unlink(path).catch(() => undefined);
    }
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
