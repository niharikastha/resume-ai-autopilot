/**
 * The resume LIBRARY: several resumes per candidate, one of them active, and the
 * parsed pieces of each one editable by hand.
 *
 * WHY A LIBRARY RATHER THAN ONE RESUME. `CandidateProfile` was always keyed
 * `@@unique([userId, label])`, so the schema permitted several from the start, but
 * nothing could USE several: matching and tailoring both refused to run when they
 * found more than one, because choosing wrong produces a complete, plausible,
 * wrong shortlist and there was no way for a candidate to say which they meant.
 * `isActive` is that way, and this service is where it is set.
 *
 * THE CONFIRMATION GATE IS PRESERVED, in the shape ProfileService's own docstring
 * anticipated: POST the file to get a preview that writes nothing, then POST the
 * atoms back to confirm. The second request carries the atoms rather than the
 * server re-parsing the file, and that is deliberate - it is what lets a candidate
 * fix a mis-split bullet BEFORE it becomes ground truth, and it means the thing
 * confirmed is provably the thing that was displayed.
 *
 * UPLOADS ARE STORED PER USER, in `<RESUME_UPLOAD_DIR>/<userId>/<uuid><ext>`,
 * which is `backend/uploads/<userId>/<uuid><ext>` unless that variable says
 * otherwise - see `uploadDir` for why it is not under .artifacts. An
 * upload id is resolved only inside the caller's own directory, so asking for
 * somebody else's file is not merely rejected but unexpressible - the same
 * property MeController relies on everywhere else. The extension is taken from an
 * allowlist and never from the uploaded name; the original name is kept in a
 * column for display and is never part of a path.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AtomKind, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { retagAtom, type ParsedAtom, type ParsedProfile } from './parse';
import { ProfileIngestError, ProfileService } from './profile.service';

/**
 * The size cap, enforced here as well as by multer.
 *
 * Two layers because they fail differently: multer's limit aborts the stream and
 * is the one that stops a large body being buffered at all, while this check is
 * the one that produces a sentence a person can act on. 5 MB is generous for a
 * two-page document - a text resume is single-digit kilobytes and a PDF with an
 * embedded photograph is a few hundred - and a file above it is a scan, which the
 * text extractor cannot read anyway.
 */
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

/**
 * Extensions accepted, and the ONLY source of the stored file's extension.
 *
 * Mirrors `isSupportedResume`, which the preview would reject a moment later
 * anyway; checking here means an unusable file is refused before it is written to
 * disk rather than after. .doc and .docx are absent because the text extractor
 * cannot read them - the app WRITES docx and does not read it.
 */
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.txt', '.md']);

/** An upload id is a uuid plus an allowed extension, and nothing else. */
const UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|txt|md)$/;

/** The contact block, editable at the gate. */
export interface ResumeContact {
  fullName: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedIn: string | null;
  github: string | null;
  portfolio: string | null;
}

/**
 * One atom as the web app sends it back.
 *
 * NO `tech` FIELD, and its absence is the enforcement rather than a convention.
 * `retagAtom` UNIONS any tags it is handed with the ones it derives - correct for
 * a "Tech Stack:" line inside a resume, wrong for anything arriving over HTTP -
 * so a `tech` field here would be a tag the words need not support, and the
 * provenance guard reads those tags as the complete list of technologies a
 * rewrite may name. The controller's schema already drops it; there is no type
 * through which it could be passed on either.
 */
export interface AtomInput {
  kind: AtomKind;
  text: string;
  employer?: string | null;
  dateRange?: string | null;
  /**
   * The hand-typed extras: a project's link, what a role paid, and the parts an
   * education line was assembled from. FLAT here rather than nested, because this
   * is the shape of a JSON body and one level is easier to validate and to read in
   * a network tab. `toParsedAtom` groups them.
   */
  link?: string | null;
  ctc?: string | null;
  degree?: string | null;
  fieldOfStudy?: string | null;
  score?: string | null;
  scoreOutOf?: string | null;
}

/**
 * The hand-typed columns, in one place.
 *
 * Listed as data rather than repeated in three method bodies because the rule they
 * share is what matters: each one is written on every save, and a field this list
 * forgets is a field the next save silently erases.
 */
export const DETAIL_FIELDS = [
  'link',
  'ctc',
  'degree',
  'fieldOfStudy',
  'score',
  'scoreOutOf',
] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];

export interface UploadResult {
  uploadId: string;
  filename: string;
  contact: ResumeContact;
  headline: string | null;
  warnings: string[];
  atoms: ParsedAtom[];
  counts: Record<AtomKind, number>;
  techUnion: string[];
  /** What came out of the file, before parsing. See `extractedText` below. */
  extracted: ExtractedText;
}

/**
 * The raw text of the upload, for the confirmation screen to show.
 *
 * Sent whole rather than as a preview of the first few lines, because the question
 * it answers is "is anything MISSING", and a truncated sample cannot answer that.
 * Capped all the same - `chars` is the real length, so the screen can say how much
 * it is not showing rather than quietly ending mid-resume.
 */
export interface ExtractedText {
  text: string;
  chars: number;
  truncated: boolean;
}

/**
 * The cap on the text sent back with a preview.
 *
 * A two-page resume extracts to about 4 KB, so this is roughly twenty resumes'
 * worth and no real document reaches it. It exists because the size limit is on
 * the FILE: a 5 MB pdf of dense text extracts to far more than anyone will read on
 * a screen, and sending it would be a slow response nobody asked for.
 */
const MAX_EXTRACTED_CHARS = 80_000;

export interface ResumeSummary {
  id: string;
  label: string;
  filename: string | null;
  isActive: boolean;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  fullName: string;
  email: string;
  counts: Record<AtomKind, number>;
  atomCount: number;
  techCount: number;
  /** Tailored variants built from these atoms. Blocks a careless delete. */
  variantCount: number;
}

@Injectable()
export class ResumeLibraryService {
  private readonly logger = new Logger(ResumeLibraryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // The library
  // -------------------------------------------------------------------------

  async list(userId: string): Promise<ResumeSummary[]> {
    const rows = await this.prisma.candidateProfile.findMany({
      where: { userId },
      // Active first, then newest. A candidate with five resumes wants the one in
      // use at the top, not the one that happens to sort first alphabetically.
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        label: true,
        sourceFilename: true,
        isActive: true,
        confirmedAt: true,
        createdAt: true,
        updatedAt: true,
        fullName: true,
        email: true,
        atoms: { select: { kind: true, tech: true } },
        _count: { select: { resumeVariants: true } },
      },
    });

    return rows.map((row) => {
      const counts = emptyCounts();
      const tech = new Set<string>();
      for (const atom of row.atoms) {
        counts[atom.kind]++;
        for (const t of atom.tech) tech.add(t);
      }
      return {
        id: row.id,
        label: row.label,
        filename: row.sourceFilename,
        isActive: row.isActive,
        confirmedAt: row.confirmedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        fullName: row.fullName,
        email: row.email,
        counts,
        atomCount: row.atoms.length,
        techCount: tech.size,
        variantCount: row._count.resumeVariants,
      };
    });
  }

  /**
   * Saves an uploaded file and parses it. Writes NO database rows.
   *
   * The file is written to disk before parsing because the extractor takes a path,
   * and it is kept afterwards even on a parse failure: a resume that produced a
   * bad parse is the exact input worth having when fixing the parser.
   */
  async upload(
    userId: string,
    file: { originalname: string; buffer: Buffer; size: number },
  ): Promise<UploadResult> {
    if (file.size > MAX_RESUME_BYTES) {
      throw new PayloadTooLargeException(
        `that file is ${Math.round(file.size / 1024)} KB. The limit is ` +
          `${MAX_RESUME_BYTES / 1024 / 1024} MB - a resume above it is usually a ` +
          'scan, and scanned text cannot be read.',
      );
    }
    if (file.size === 0) {
      throw new BadRequestException('that file is empty');
    }

    const extension = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new UnsupportedMediaTypeException(
        `${extension || 'that file'} cannot be read. Upload a .pdf, .txt or .md. ` +
          'A .docx has to be exported first - the app writes Word files but ' +
          'cannot read them.',
      );
    }

    const dir = this.uploadDir(userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // The stored name comes from randomUUID and the extension allowlist, so no
    // part of it is attacker-controlled. Writing under the uploaded name would
    // hand a caller the choice of path, which is a directory traversal and an
    // overwrite of somebody else's file in one.
    const uploadId = `${randomUUID()}${extension}`;
    const path = join(dir, uploadId);
    await writeFile(path, file.buffer, { mode: 0o600 });

    let preview;
    try {
      preview = await this.profiles.preview(path);
    } catch (error) {
      throw new BadRequestException(
        error instanceof ProfileIngestError
          ? error.message
          : `that file could not be read: ${(error as Error).message}`,
      );
    }

    const { parsed } = preview;
    return {
      uploadId,
      filename: displayName(file.originalname),
      contact: {
        fullName: parsed.fullName,
        // May be empty. The gate is where a missing address gets typed in, rather
        // than a dead end - commit refuses without one, and refusing at the point
        // where there is a form to fix it in is the difference between a
        // validation message and a wall.
        email: parsed.email ?? '',
        phone: parsed.phone,
        location: parsed.location,
        linkedIn: parsed.linkedIn,
        github: parsed.github,
        portfolio: parsed.portfolio,
      },
      headline: parsed.headline,
      warnings: parsed.warnings,
      atoms: parsed.atoms,
      counts: preview.counts,
      techUnion: preview.techUnion,
      extracted: {
        text: preview.text.slice(0, MAX_EXTRACTED_CHARS),
        chars: preview.text.length,
        truncated: preview.text.length > MAX_EXTRACTED_CHARS,
      },
    };
  }

  /**
   * Confirms an upload into a real profile.
   *
   * `atoms` are the ones the browser displayed, possibly edited. They are trusted
   * because they are the candidate's own claims about their own history - the
   * provenance guard exists to stop the MODEL inventing facts, not to stop a
   * person correcting their own resume. What it must not become is a way to smuggle
   * in a skill the resume does not support, which is why every atom is re-tagged
   * from its text here rather than accepting the tags as sent.
   */
  async create(
    userId: string,
    input: {
      label: string;
      uploadId: string;
      /**
       * The name the file arrived under, echoed back from the preview response.
       *
       * Client-supplied, because the two requests share no server-side state and
       * a sidecar file holding one string would be a second thing to clean up.
       * Safe because it is a display string and nothing else: it is sanitised
       * before storage and never used to build a path.
       */
      filename?: string;
      contact: ResumeContact;
      atoms: AtomInput[];
      makeActive?: boolean;
      force?: boolean;
    },
  ): Promise<{ id: string; isActive: boolean; atomCount: number }> {
    const path = this.resolveUpload(userId, input.uploadId);

    const atoms = input.atoms.map((a) => this.toParsedAtom(a));
    if (atoms.length === 0) {
      throw new BadRequestException(
        'a resume with no pieces cannot be saved - there would be nothing for ' +
          'matching to read',
      );
    }

    const parsed: ParsedProfile = {
      fullName: input.contact.fullName,
      email: input.contact.email,
      phone: input.contact.phone,
      location: input.contact.location,
      linkedIn: input.contact.linkedIn,
      github: input.contact.github,
      portfolio: input.contact.portfolio,
      // Not stored by commit; a headline is written fresh per role.
      headline: null,
      atoms,
      warnings: [],
    };

    const counts = emptyCounts();
    for (const atom of atoms) counts[atom.kind]++;

    let result;
    try {
      result = await this.profiles.commit({
        userId,
        label: input.label,
        force: input.force,
        preview: {
          parsed,
          resumePath: path,
          counts,
          techUnion: [...new Set(atoms.flatMap((a) => a.tech))].sort((a, b) =>
            a.localeCompare(b),
          ),
        },
      });
    } catch (error) {
      if (error instanceof ProfileIngestError) {
        // A variant-collision is a conflict the caller can resolve by re-sending
        // with force; everything else is bad input.
        throw error.message.includes('resume variant')
          ? new ConflictException(error.message)
          : new BadRequestException(error.message);
      }
      throw error;
    }

    await this.prisma.candidateProfile.update({
      where: { id: result.profileId },
      data: { sourceFilename: displayName(input.filename ?? '', input.label) },
    });

    // Active by default, and unconditionally when nothing else is: a resume
    // uploaded and confirmed and then not used by anything is a confusing
    // outcome, and "the newest one" is what a candidate means by uploading it.
    const others = await this.prisma.candidateProfile.count({
      where: { userId, isActive: true, id: { not: result.profileId } },
    });
    const activate = input.makeActive ?? true;
    if (activate || others === 0) await this.activate(userId, result.profileId);

    this.logger.log(
      `resume "${input.label}" confirmed for ${userId}: ${atoms.length} pieces`,
    );

    return {
      id: result.profileId,
      isActive: activate || others === 0,
      atomCount: atoms.length,
    };
  }

  /**
   * Makes one resume the active one.
   *
   * Both writes in one transaction, because the partial unique index means the
   * order matters: setting the new one first would collide with the old one that
   * is still true. Clearing every row for the user - rather than only the known
   * active one - is idempotent and repairs a database that somehow holds none.
   */
  async activate(userId: string, id: string): Promise<void> {
    const profile = await this.owned(userId, id);
    if (!profile.confirmedAt) {
      throw new ConflictException(
        'that resume has not been confirmed yet, so nothing may use it',
      );
    }

    await this.prisma.$transaction([
      this.prisma.candidateProfile.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.candidateProfile.update({
        where: { id },
        data: { isActive: true },
      }),
    ]);
  }

  async rename(userId: string, id: string, label: string): Promise<void> {
    await this.owned(userId, id);
    try {
      await this.prisma.candidateProfile.update({
        where: { id },
        data: { label },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `you already have a resume called "${label}"`,
        );
      }
      throw error;
    }
  }

  /**
   * Deletes a resume, its atoms and its uploaded file.
   *
   * Refuses while tailored variants reference it, for the reason ingestion gives:
   * a variant records atom ids inside a JSON column that Postgres cannot enforce,
   * so the cascade that removes the atoms leaves those variants pointing at
   * nothing. `force` accepts that; the variants are deleted by the cascade on the
   * profile, so nothing is left dangling either way.
   */
  async remove(
    userId: string,
    id: string,
    force = false,
  ): Promise<{ promoted: string | null }> {
    const profile = await this.prisma.candidateProfile.findFirst({
      where: { id, userId },
      select: {
        id: true,
        isActive: true,
        sourceResumePath: true,
        _count: { select: { resumeVariants: true } },
      },
    });
    if (!profile) throw new NotFoundException('no such resume');

    if (profile._count.resumeVariants > 0 && !force) {
      throw new ConflictException(
        `${profile._count.resumeVariants} tailored resume(s) were built from this ` +
          'one. Deleting it deletes those too, because they are made of its ' +
          'pieces. Confirm to go ahead.',
      );
    }

    await this.prisma.candidateProfile.delete({ where: { id } });

    // Best effort, and after the row is gone. A file left behind is wasted disk;
    // a row deleted only if the unlink happens to succeed would be a resume that
    // cannot be removed because of a permissions problem on a cache file.
    if (profile.sourceResumePath) {
      await unlink(profile.sourceResumePath).catch(() => undefined);
    }

    // Deleting the active resume must not leave the candidate with none, or
    // matching starts failing with a message about a screen they were just on.
    if (!profile.isActive) return { promoted: null };

    const next = await this.prisma.candidateProfile.findFirst({
      where: { userId, confirmedAt: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    if (!next) return { promoted: null };
    await this.activate(userId, next.id);
    return { promoted: next.id };
  }

  // -------------------------------------------------------------------------
  // Editing the pieces
  // -------------------------------------------------------------------------

  async atoms(userId: string, id: string) {
    await this.owned(userId, id);
    return this.prisma.profileAtom.findMany({
      where: { profileId: id },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        kind: true,
        text: true,
        tech: true,
        metrics: true,
        employer: true,
        dateRange: true,
        // The hand-typed extras. Sent so the edit screen shows what was entered
        // rather than quietly dropping it on the next save - the columns are
        // rewritten on every reconcile, so a value the form cannot see is a value
        // the form will erase.
        link: true,
        ctc: true,
        degree: true,
        fieldOfStudy: true,
        score: true,
        scoreOutOf: true,
        ordinal: true,
        // Whether this piece has a vector yet, which is what decides if matching
        // can see it. Surfaced because an atom edited a second ago is briefly
        // without one, and silence there looks like a bug.
        embeddedTextHash: true,
      },
    });
  }

  /**
   * Edits one piece.
   *
   * Re-embedding is the part that matters. An atom whose text changed keeps a
   * vector describing its previous wording, and nothing anywhere says so - the
   * match scores stay plausible and are simply about the wrong sentence.
   * `embedProfile` re-embeds exactly the stale atoms and recomputes the
   * whole-profile centroid, so it is correct to call after any edit.
   */
  async updateAtom(
    userId: string,
    profileId: string,
    atomId: string,
    patch: {
      text?: string;
      employer?: string | null;
      dateRange?: string | null;
    } & Partial<Record<DetailField, string | null>>,
  ) {
    await this.owned(userId, profileId);
    const current = await this.prisma.profileAtom.findFirst({
      where: { id: atomId, profileId },
    });
    if (!current) throw new NotFoundException('no such piece');

    const text = patch.text?.trim() ?? current.text;
    if (text.length === 0) {
      throw new BadRequestException(
        'a piece cannot be empty. Delete it instead.',
      );
    }

    const employer =
      patch.employer === undefined
        ? current.employer
        : blankToNull(patch.employer);
    const dateRange =
      patch.dateRange === undefined
        ? current.dateRange
        : blankToNull(patch.dateRange);

    // Absent means unchanged, here and only here. A PATCH names the fields it wants
    // to change, so a body carrying only `text` must leave the CGPA alone - unlike a
    // confirmation, which sends the whole piece and therefore clears what it omits.
    const merged = {} as Record<DetailField, string | null>;
    for (const field of DETAIL_FIELDS) {
      merged[field] =
        patch[field] === undefined ? current[field] : blankToNull(patch[field]);
    }

    // Checked on the MERGED value, not on the patch: clearing "out of 10" while
    // leaving 8.6 behind would leave a figure nobody can read, and only the two
    // together say what happened.
    if (Boolean(merged.score) !== Boolean(merged.scoreOutOf)) {
      throw new BadRequestException(
        'a score and what it is out of go together - "8.6" on its own does not say ' +
          'whether it is out of 10 or a percentage',
      );
    }

    const retagged = retagAtom({
      kind: current.kind,
      text,
      employer: employer ?? undefined,
      dateRange: dateRange ?? undefined,
      details: merged,
    });

    const updated = await this.prisma.profileAtom.update({
      where: { id: atomId },
      data: {
        text,
        tech: retagged.tech,
        metrics: retagged.metrics,
        employer,
        dateRange,
        ...merged,
      },
    });

    if (updated.text !== current.text)
      await this.profiles.embedProfile(profileId);
    return updated;
  }

  /** Adds a piece at the end. */
  async addAtom(userId: string, profileId: string, input: AtomInput) {
    await this.owned(userId, profileId);

    const text = input.text.trim();
    if (text.length === 0)
      throw new BadRequestException('a piece needs some text');

    const retagged = this.toParsedAtom({ ...input, text });

    // Appended, not inserted. `@@unique([profileId, ordinal])` makes an insert a
    // renumbering of everything after it, which is a reorder feature rather than
    // an add one - and nothing in the schema requires the ordinals be gapless.
    const last = await this.prisma.profileAtom.findFirst({
      where: { profileId },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });

    const created = await this.prisma.profileAtom.create({
      data: {
        profileId,
        kind: retagged.kind,
        text: retagged.text,
        tech: retagged.tech,
        metrics: retagged.metrics,
        employer: retagged.employer ?? null,
        dateRange: retagged.dateRange ?? null,
        link: retagged.details?.link ?? null,
        ctc: retagged.details?.ctc ?? null,
        degree: retagged.details?.degree ?? null,
        fieldOfStudy: retagged.details?.fieldOfStudy ?? null,
        score: retagged.details?.score ?? null,
        scoreOutOf: retagged.details?.scoreOutOf ?? null,
        ordinal: (last?.ordinal ?? -1) + 1,
      },
    });

    await this.profiles.embedProfile(profileId);
    return created;
  }

  async deleteAtom(
    userId: string,
    profileId: string,
    atomId: string,
  ): Promise<void> {
    await this.owned(userId, profileId);
    const { count } = await this.prisma.profileAtom.deleteMany({
      where: { id: atomId, profileId },
    });
    if (count === 0) throw new NotFoundException('no such piece');

    // The centroid is a mean over the remaining atoms, so a deletion moves it.
    // Left stale, the profile vector would still carry a claim that was removed.
    await this.profiles.embedProfile(profileId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Loads a profile, or 404s. EVERY read and write above goes through this.
   *
   * The controller takes a resume id from the URL, which is the one place this
   * surface departs from MeController's "no identifiers in, so horizontal access
   * is unexpressible" property. This method is what replaces it: an id belonging
   * to somebody else is indistinguishable from one that does not exist.
   */
  private async owned(userId: string, id: string) {
    const profile = await this.prisma.candidateProfile.findFirst({
      where: { id, userId },
      select: { id: true, label: true, confirmedAt: true, isActive: true },
    });
    if (!profile) throw new NotFoundException('no such resume');
    return profile;
  }

  private uploadDir(userId: string): string {
    // `uploads` under whatever directory the API was started from, which for
    // `npm run dev` is backend/. Deliberately NOT inside .artifacts: everything
    // else in there is generated and can be deleted and rebuilt, whereas this is
    // the candidate's own file and the only copy the server has. RESUME_UPLOAD_DIR
    // moves it - a deployment that wants it on a mounted volume sets that.
    //
    // GITIGNORED, and it has to stay that way: these are real resumes with a real
    // phone number and address in them.
    const base = this.config.get<string>('RESUME_UPLOAD_DIR') ?? 'uploads';
    // userId is a uuid from the session, never from the request body.
    return resolve(base, userId);
  }

  /** Turns an upload id back into a path, inside the caller's directory only. */
  private resolveUpload(userId: string, uploadId: string): string {
    if (!UPLOAD_ID.test(uploadId)) {
      throw new BadRequestException('that upload id is not one we issued');
    }
    return join(this.uploadDir(userId), uploadId);
  }

  /** Tags come from the text, never from the caller. See `AtomInput`. */
  private toParsedAtom(input: AtomInput): ParsedAtom {
    return retagAtom({
      kind: input.kind,
      text: input.text.trim(),
      employer: blankToNull(input.employer) ?? undefined,
      dateRange: blankToNull(input.dateRange) ?? undefined,
      details: {
        link: blankToNull(input.link),
        ctc: blankToNull(input.ctc),
        degree: blankToNull(input.degree),
        fieldOfStudy: blankToNull(input.fieldOfStudy),
        score: blankToNull(input.score),
        scoreOutOf: blankToNull(input.scoreOutOf),
      },
    });
  }
}

function emptyCounts(): Record<AtomKind, number> {
  return {
    [AtomKind.BULLET]: 0,
    [AtomKind.SKILL]: 0,
    [AtomKind.ROLE]: 0,
    [AtomKind.EDU]: 0,
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * A filename safe to show in a list.
 *
 * Control characters go because a name containing them corrupts a terminal that
 * later prints it; slashes go because a name is never allowed to look like a path;
 * the length is capped because a 400-character name is a layout problem rather
 * than information. Never used to BUILD a path - the stored name is a uuid.
 *
 * Filtered by code point rather than by regex, for two reasons that both cost time
 * here. A character class written with the characters themselves makes this whole
 * file read as binary to grep - the fourth invisible-character bug in this project
 * - and the same class written with escapes still trips eslint's no-control-regex,
 * which is a rule worth keeping rather than suppressing.
 */
function displayName(original: string, fallback = 'resume'): string {
  const cleaned = [...original]
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      if (code < 0x20 || code === 0x7f) return false;
      return ch !== '/' && ch !== '\\';
    })
    .join('')
    .trim();
  return cleaned.slice(0, 180) || fallback;
}
