/**
 * The candidate's resume library, over HTTP.
 *
 * Mounted under api/me alongside MeController and scoped the same way: the session
 * decides whose resumes these are, and every route that names one by id resolves it
 * through `ResumeLibraryService.owned`, which cannot see another account's rows.
 *
 * TWO REQUESTS TO ADD A RESUME, not one:
 *
 *   POST   api/me/resumes/upload   multipart file  -> a preview, nothing written
 *   POST   api/me/resumes          the atoms back  -> the profile, confirmed
 *
 * That is PLAN-v2 phase 3's confirmation gate, moved from the CLI to a screen. The
 * upload response is the printout the CLI produced; the second request is
 * `--confirm`. Collapsing them into one POST would be a smaller API and would
 * delete the gate, which exists because every stage downstream - matching,
 * tailoring, the provenance guard - treats these atoms as ground truth.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AtomKind } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import {
  MAX_RESUME_BYTES,
  ResumeLibraryService,
} from './resume-library.service';

/** Zod at the HTTP boundary, same as everywhere else in this API. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  return result.data;
}

/**
 * A label is a filename-ish handle the candidate chooses ("primary", "ml-roles").
 *
 * Restricted rather than free text because it is passed to the CLI as
 * `--label`, appears in log lines, and is part of a `@@unique([userId, label])`
 * key. Nothing here depends on it being safe for a path, but it is one substituted
 * into enough messages that keeping it boring is cheap.
 */
const label = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 _-]*$/,
    'letters, numbers, spaces, hyphens and underscores only',
  );

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length > 0 ? v : null))
    .nullable()
    .optional()
    .transform((v) => v ?? null);

const contact = z.object({
  fullName: z.string().trim().min(1).max(120),
  // Required, and the one field the parse cannot be allowed to leave empty: every
  // application needs an address, and filling it in from the account would be
  // exactly the kind of invented detail this pipeline refuses to produce.
  email: z.string().trim().email().max(200),
  phone: optionalText(40),
  location: optionalText(120),
  linkedIn: optionalText(300),
  github: optionalText(300),
  portfolio: optionalText(300),
});

/**
 * The hand-typed extras every atom may carry. See AtomDetails in parse.ts.
 *
 * Every one is optional and every one is a string, including the two numeric-looking
 * ones. `score` is "8.6" and stays "8.6": a JSON number round-trip is how 8.6
 * becomes 8.600000000000001, and this figure gets read back and typed into a real
 * application form. The caps are small on purpose - these are single values, and a
 * paragraph in the CGPA box is a form being misused rather than a long answer.
 */
const detailFields = {
  link: optionalText(500),
  ctc: optionalText(40),
  degree: optionalText(120),
  fieldOfStudy: optionalText(160),
  score: optionalText(12),
  scoreOutOf: optionalText(12),
};

/**
 * A score with nothing to compare it to is unreadable.
 *
 * "8.6" alone could be out of ten, out of four, or a percentage of a hundred that
 * somebody typed wrong - and this value ends up in front of an employer. The pair is
 * therefore all-or-nothing, and it is checked here rather than in the service so the
 * message names the field the browser can highlight.
 */
const scorePair = <
  T extends { score: string | null; scoreOutOf: string | null },
>(
  v: T,
  ctx: z.RefinementCtx,
): void => {
  if (v.score && !v.scoreOutOf) {
    ctx.addIssue({
      code: 'custom',
      path: ['scoreOutOf'],
      message:
        'say what the score is out of, e.g. 10 for a CGPA or 100 for a percentage',
    });
  }
  if (v.scoreOutOf && !v.score) {
    ctx.addIssue({
      code: 'custom',
      path: ['score'],
      message: 'there is an "out of" here but no score',
    });
  }
};

const atomInput = z
  .object({
    kind: z.nativeEnum(AtomKind),
    // 2000 is well above a real bullet and well below a whole section pasted in by
    // accident, which is the failure this cap is actually for.
    text: z.string().trim().min(2).max(2000),
    employer: optionalText(160),
    dateRange: optionalText(80),
    ...detailFields,
    // NOT accepted from the client. Tech tags are re-derived from the text by
    // `retagAtom`, because the provenance guard uses them as the list of
    // technologies a rewrite may name - a tag the words do not support would
    // license the model to claim a skill the resume never mentions. SkillsReserve
    // is the deliberate, noted way to add one.
  })
  .superRefine(scorePair);

const createBody = z.object({
  label,
  uploadId: z.string().trim().max(80),
  filename: z.string().trim().max(300).optional(),
  contact,
  atoms: z.array(atomInput).min(1).max(400),
  makeActive: z.boolean().optional(),
  force: z.boolean().optional(),
});

const renameBody = z.object({ label });

/**
 * A field in a PATCH, where LEAVING IT OUT AND SENDING IT EMPTY MEAN DIFFERENT
 * THINGS.
 *
 * `optionalText` above turns an absent field into null, which is right for a
 * confirmation - that body is the whole piece, so anything it omits was deleted.
 * It is wrong for a patch: the edit screen sends the three boxes it shows and knows
 * nothing about a CGPA or a project link, so an absent field becoming null would
 * mean editing the wording of an education line erased the score beside it.
 *
 * So this stops one transform earlier. Absent stays undefined and `updateAtom`
 * keeps the stored value; an explicit "" or null clears it.
 */
const patchable = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length > 0 ? v : null))
    .nullable()
    .optional();

const patchAtomBody = z
  .object({
    text: z.string().trim().min(2).max(2000).optional(),
    employer: patchable(160),
    dateRange: patchable(80),
    link: patchable(500),
    ctc: patchable(40),
    degree: patchable(120),
    fieldOfStudy: patchable(160),
    score: patchable(12),
    scoreOutOf: patchable(12),
  })
  // `some(defined)` rather than counting keys: every field above is optional, so a
  // body of `{}` parses to an object whose keys are all undefined, and counting them
  // would call that a change and re-embed an atom nobody touched.
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    'nothing to change',
  );

const addAtomBody = atomInput;

const deleteQuery = z.object({
  force: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

@Controller('api/me/resumes')
export class ResumeController {
  constructor(private readonly library: ResumeLibraryService) {}

  @Get()
  list(@CurrentUser() user: SessionUser) {
    return this.library.list(user.id);
  }

  /**
   * Step one: the file goes up, a preview comes back, nothing is stored in the
   * database.
   *
   * `memoryStorage` is the default and is what is wanted: the service writes the
   * file itself, to a per-user directory under a name it generates. Letting multer
   * choose the destination would put the naming decision in configuration, where
   * the reason the name must not come from the upload is invisible.
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_RESUME_BYTES, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: SessionUser,
    @UploadedFile()
    file?: { originalname: string; buffer: Buffer; size: number },
  ) {
    if (!file) {
      throw new BadRequestException(
        'no file arrived. Send it as multipart/form-data under the name "file".',
      );
    }
    return this.library.upload(user.id, file);
  }

  /** Step two: the atoms the candidate just read, possibly corrected. */
  @Post()
  create(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.library.create(user.id, parse(createBody, body));
  }

  @Patch(':id')
  @HttpCode(204)
  async rename(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.library.rename(user.id, id, parse(renameBody, body).label);
  }

  /** The one matching and tailoring will use from now on. */
  @Patch(':id/active')
  @HttpCode(204)
  async activate(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.library.activate(user.id, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.library.remove(user.id, id, parse(deleteQuery, query).force);
  }

  // -------------------------------------------------------------------------
  // The pieces
  // -------------------------------------------------------------------------

  @Get(':id/atoms')
  atoms(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.library.atoms(user.id, id);
  }

  @Post(':id/atoms')
  addAtom(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.library.addAtom(user.id, id, parse(addAtomBody, body));
  }

  @Patch(':id/atoms/:atomId')
  updateAtom(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('atomId', ParseUUIDPipe) atomId: string,
    @Body() body: unknown,
  ) {
    return this.library.updateAtom(
      user.id,
      id,
      atomId,
      parse(patchAtomBody, body),
    );
  }

  @Delete(':id/atoms/:atomId')
  @HttpCode(204)
  async deleteAtom(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('atomId', ParseUUIDPipe) atomId: string,
  ): Promise<void> {
    await this.library.deleteAtom(user.id, id, atomId);
  }
}
