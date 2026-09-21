/**
 * The resume studio over HTTP: see the document, ask for suggestions, tailor to a JD.
 *
 * Three surfaces, two controllers, and the split is by lifetime rather than by feature:
 *
 *   api/me/resume-preview/:id     Derived, overwritten, belongs to a resume. Rendering
 *                                 it twice leaves one file.
 *   api/me/tailor                 Kept. Every run is a row with the JD that produced it,
 *                                 because the candidate asked for a history.
 *
 * Suggestions live under `tailor` rather than under `resume-preview` because they cost a
 * deep-tier call and nothing about them is derived from the document - they are about the
 * atoms.
 *
 * EVERY ROUTE IS SESSION-SCOPED AND ID-CHECKED. The id in the path is resolved through
 * `ResumeSourceService.load` or a `findFirst` that includes the userId, so a row
 * belonging to another account is indistinguishable from one that does not exist. No
 * route takes a userId.
 *
 * FILES ARE STREAMED FROM PATHS THE SERVER BUILT, never from a path in a request. The
 * preview's name is `preview-<profileId>` and a tailored resume's comes out of its own
 * row, so there is no request-shaped string anywhere near the filesystem.
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
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ResumeTemplate } from '@prisma/client';
import { createReadStream } from 'fs';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { OnDemandTailoringService } from './on-demand.service';
import { PreviewService } from './preview.service';
import { TEMPLATE_CHOICES, type TemplateChoice } from './resume.templates';
import { SuggestionsService } from './suggestions.service';

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

const format = z.enum(['pdf', 'docx']);

/**
 * A template name, validated against the enum Prisma generated.
 *
 * `z.nativeEnum` rather than a hand-written list: a template added to the schema and
 * forgotten here would be a value the API rejects for a document it can render.
 */
const templateBody = z.object({
  template: z.nativeEnum(ResumeTemplate).optional(),
});

/** The same, required - for the routes whose whole purpose is to change it. */
const retypesetBody = z.object({ template: z.nativeEnum(ResumeTemplate) });

/** What a browser does with each. A pdf is for looking at; a docx is for keeping. */
const CONTENT_TYPE = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

function stream(
  file: { path: string; filename: string },
  kind: 'pdf' | 'docx',
  inline: boolean,
): StreamableFile {
  return new StreamableFile(createReadStream(file.path), {
    type: CONTENT_TYPE[kind],
    // The filename is server-generated - a uuid-derived preview name or a sanitised
    // `resumeFilename` - so it cannot carry a quote or a newline into this header.
    disposition: `${inline ? 'inline' : 'attachment'}; filename="${file.filename}"`,
  });
}

@Controller('api/me/resume-preview')
export class ResumePreviewController {
  constructor(private readonly preview: PreviewService) {}

  /**
   * The templates that can be written, with the copy describing each.
   *
   * A ROUTE OF ITS OWN because the tailor screen needs the list and does not render a
   * preview to get it. Hardcoding the list in the frontend instead would let it offer a
   * template the renderer has no writer for, which is a picker that produces the wrong
   * document; `TEMPLATE_CHOICES` sits beside that writer table.
   *
   * Declared before `:id/:format` - `templates` is one segment, so it cannot be read as
   * an id there, but it would be read as one by a future single-segment GET.
   */
  @Get('templates')
  templates(): readonly TemplateChoice[] {
    return TEMPLATE_CHOICES;
  }

  /**
   * Renders the resume and says what came out. POST because it writes files.
   *
   * Separate from the download so the slow part is one request: LibreOffice takes
   * seconds, and a GET that rendered on the way past would hold the connection open for
   * all of them and start a second conversion over the same file on a retry.
   */
  @Post(':id')
  render(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    // An absent template means "render it in whatever this resume is set to", which is
    // what an ordinary re-render after an edit wants. A present one is the picker, and
    // it is saved - see PreviewService.render.
    const { template } = parse(templateBody, body ?? {});
    return this.preview.render(user.id, id, template);
  }

  @Get(':id/:format')
  async download(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') raw: string,
  ): Promise<StreamableFile> {
    const kind = parse(format, raw);
    const file = await this.preview.file(user.id, id, kind);
    // Inline for the pdf: this one is the preview pane, and a download prompt in place
    // of a preview is not a preview.
    return stream(file, kind, kind === 'pdf');
  }
}

const suggestBody = z.object({
  resumeId: z.string().uuid().optional(),
  /** What the candidate is aiming at, in their own words. */
  focus: z.string().trim().max(400).optional(),
  /** The pieces to look at. Absent means the whole resume. */
  atomIds: z.array(z.string().uuid()).max(400).optional(),
});

/**
 * A run request.
 *
 * `jobId` XOR `jdText` is checked in the service rather than here, because the message
 * it produces is about what a resume can be written for and belongs next to the code
 * that reads them. The caps are here: 40 000 characters is a long JD plus the boilerplate
 * pages some boards wrap them in, and anything past it is a page that was pasted whole.
 */
const runBody = z.object({
  resumeId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  jdText: z.string().trim().max(40_000).optional(),
  title: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
});

const listQuery = z.object({ resumeId: z.string().uuid().optional() });

@Controller('api/me/tailor')
export class TailorController {
  constructor(
    private readonly tailored: OnDemandTailoringService,
    private readonly suggestions: SuggestionsService,
  ) {}

  /**
   * AI suggestions on the resume as it stands. Writes nothing.
   *
   * Declared before the `:id` routes below, because `suggestions` would otherwise be
   * read as an id - and it is not a uuid, so the pipe would reject it with a message
   * about a malformed identifier for a route that exists.
   */
  @Post('suggestions')
  suggest(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.suggestions.suggest(user.id, parse(suggestBody, body));
  }

  /** Tailor now, against a chosen posting or a pasted description. */
  @Post()
  run(@CurrentUser() user: SessionUser, @Body() body: unknown) {
    return this.tailored.run(user.id, parse(runBody, body));
  }

  /** The history the candidate asked to keep. */
  @Get()
  list(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    return this.tailored.list(user.id, parse(listQuery, query).resumeId);
  }

  /**
   * What tailoring changed, against the candidate's own words.
   *
   * DECLARED BEFORE `:id/:format`, which would otherwise match this path and reject
   * `changes` as a format. Nest matches routes in declaration order, so this is load
   * order and not a coincidence - moving it below would 400 a route that exists.
   */
  @Get(':id/changes')
  changes(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tailored.changes(user.id, id);
  }

  /** The same run in another template. POST because it rewrites the files. */
  @Post(':id/retypeset')
  retypeset(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const { template } = parse(retypesetBody, body);
    return this.tailored.retypeset(user.id, id, template);
  }

  /**
   * Renders the marked-up copy. Split from the GET below for the same reason the
   * preview's render is split from its download: LibreOffice takes seconds.
   */
  @Post(':id/marked')
  mark(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tailored.markReview(user.id, id);
  }

  /**
   * The marked-up copy, inline.
   *
   * PDF ONLY, AND NO ATTACHMENT. This one is for reading on the screen beside the real
   * document - see `OnDemandTailoringService.markReview`. There is deliberately no route
   * that hands the candidate a highlighted Word file to send.
   */
  @Get(':id/marked/pdf')
  async marked(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StreamableFile> {
    const file = await this.tailored.reviewFile(user.id, id);
    return stream(file, 'pdf', true);
  }

  @Get(':id/:format')
  async download(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('format') raw: string,
  ): Promise<StreamableFile> {
    const kind = parse(format, raw);
    const file = await this.tailored.file(user.id, id, kind);
    // Attachment for both: this one is a finished document the candidate is about to
    // send, so the useful outcome is a file on disk rather than a browser tab. The
    // preview pane fetches it as a blob when it wants to show it.
    return stream(file, kind, false);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: SessionUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.tailored.remove(user.id, id);
  }
}
