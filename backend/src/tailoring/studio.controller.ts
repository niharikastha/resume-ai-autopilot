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
import { createReadStream } from 'fs';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.constants';
import { OnDemandTailoringService } from './on-demand.service';
import { PreviewService } from './preview.service';
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
  ) {
    return this.preview.render(user.id, id);
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
