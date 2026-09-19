/**
 * The resume as it will actually look, rendered by the renderer that sends it.
 *
 * WHY THE REAL RENDERER AND NOT AN HTML PREVIEW. The edit screen shows pieces - a
 * bullet, an employer, a date range - and a candidate editing pieces cannot see the
 * document. The obvious fix is to draw a resume in the browser, and that fix quietly
 * introduces a SECOND layout: two implementations of the same template, one of which is
 * what the employer receives and the other of which is what the candidate approved.
 * They agree on the day they are written and not for long after - a spacing change, a
 * section that renders in one and not the other, a role heading that wraps differently
 * - and every disagreement is invisible until an employer is the one looking at it.
 *
 * So this runs `buildResume` and `renderResume`: the same two functions the pipeline
 * calls, with `tailoring` null, which is precisely the base resume. Nothing in
 * resume.render.ts is touched or duplicated. What the preview shows is the document.
 *
 * ONE FILE PER RESUME, OVERWRITTEN. The preview is derived state, regenerable from the
 * atoms in a second, and a directory that accumulated one pdf per click would be a
 * disk-space leak holding the candidate's phone number and address. It lives under
 * `<RESUME_OUTPUT_DIR>/previews/`, which is gitignored along with the rest of that
 * directory.
 *
 * A MISSING PDF IS REPORTED, NOT THROWN. `renderResume` returns a null pdfPath when
 * LibreOffice is absent - see its header - and the docx is still correct and still
 * downloadable. The screen says so rather than showing an error where a document should
 * be.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { stat } from 'fs/promises';
import { join, resolve } from 'path';
import { buildResume } from './resume.document';
import { renderResume } from './resume.render';
import { ResumeSourceService } from './resume.source';

export interface PreviewResult {
  resumeId: string;
  label: string;
  /** Pieces that went into it, so the screen can say what it is showing. */
  atomCount: number;
  headline: string | null;
  /** False when LibreOffice could not be run. The docx is still there. */
  pdf: boolean;
  renderedAt: string;
  /** Bytes, for the "still rendering" case to be distinguishable from an empty file. */
  bytes: number | null;
}

export type PreviewFormat = 'pdf' | 'docx';

@Injectable()
export class PreviewService {
  private readonly logger = new Logger(PreviewService.name);

  constructor(
    private readonly source: ResumeSourceService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Renders the base resume and reports what came out.
   *
   * Always re-renders. There is no staleness check because there is nothing reliable
   * to check against: an atom edit, a contact change and a deleted piece all change the
   * document, and a preview that was right ten seconds ago is exactly the preview that
   * misleads. Rendering costs a docx write plus one LibreOffice conversion, and the
   * screen asks for it on a click.
   */
  async render(userId: string, resumeId?: string): Promise<PreviewResult> {
    const source = await this.source.load(userId, resumeId);

    const document = buildResume(
      source.documentAtoms,
      source.contact,
      source.headline,
      // The base resume. Same call the pipeline makes when a guard failure sends it
      // back to the candidate's own words.
      null,
    );

    const rendered = await renderResume(
      document,
      this.dir(),
      basenameFor(source.profile.id),
    );

    const size = rendered.pdfPath
      ? await stat(rendered.pdfPath).then(
          (s) => s.size,
          () => null,
        )
      : null;

    if (!rendered.pdfPath) {
      this.logger.warn(
        `preview for ${source.profile.label} rendered to docx but not to pdf - ` +
          'LibreOffice is probably not installed on this machine',
      );
    }

    return {
      resumeId: source.profile.id,
      label: source.profile.label,
      atomCount: source.documentAtoms.length,
      headline: source.headline,
      pdf: rendered.pdfPath !== null,
      renderedAt: new Date().toISOString(),
      bytes: size,
    };
  }

  /**
   * The path of an already-rendered preview.
   *
   * Never renders. The two are split so that the slow call and the download are
   * separate requests: a browser fetching a pdf that is being rendered inside the same
   * request would hold the connection open for the whole LibreOffice run, and a retry
   * would start a second one over the same file.
   *
   * The path is built from the profile id, which was proved to belong to the caller by
   * `load`, so no part of it comes from the request.
   */
  async file(
    userId: string,
    resumeId: string,
    format: PreviewFormat,
  ): Promise<{ path: string; filename: string }> {
    const source = await this.source.load(userId, resumeId);
    const path = join(
      this.dir(),
      `${basenameFor(source.profile.id)}.${format}`,
    );

    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) {
      throw new NotFoundException(
        format === 'pdf'
          ? 'no pdf preview has been rendered for this resume yet, or LibreOffice ' +
              'could not produce one'
          : 'no preview has been rendered for this resume yet',
      );
    }

    // What the browser saves it as. The internal name is a uuid, which is right for
    // the disk and useless in a downloads folder.
    return {
      path,
      filename: `${source.profile.fullName.replace(/[^\w-]+/g, '_')}_${
        source.profile.label
      }.${format}`.replace(/_+/g, '_'),
    };
  }

  /** `<RESUME_OUTPUT_DIR>/previews`, absolute - LibreOffice needs an absolute path. */
  private dir(): string {
    return resolve(
      this.config.getOrThrow<string>('RESUME_OUTPUT_DIR'),
      'previews',
    );
  }
}

/** One stable name per resume, so a re-render replaces rather than accumulates. */
function basenameFor(profileId: string): string {
  return `preview-${profileId}`;
}
