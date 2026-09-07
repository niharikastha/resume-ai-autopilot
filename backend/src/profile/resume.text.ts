/**
 * Getting text out of a resume file.
 *
 * Two things come out of a PDF, not one: the visible text, and the LINK
 * ANNOTATIONS. A resume header usually renders LinkedIn and GitHub as bare
 * handles - "niharikastha", "niharika-astha" - with the real URL hidden in the
 * anchor. Reading only the text leaves you reconstructing
 * `https://github.com/<handle>` by convention, which is a guess that is right
 * most of the time and silently wrong for a custom vanity domain or a handle
 * that differs between the two sites. The annotation is the actual answer, so
 * both are extracted and the profile's links come from the annotations.
 *
 * Uses poppler (`pdftotext`, `pdftohtml`) rather than a bundled JS parser.
 * `-layout` preserves the two-column header and the indentation that marks a
 * wrapped bullet, and that indentation is what the section parser reads to
 * rejoin continuation lines. The JS parsers give a flat token stream where a
 * bullet wrapping onto a second line is indistinguishable from two bullets.
 *
 * If poppler is missing the error says how to install it, because "spawn
 * pdftotext ENOENT" is not a diagnosis.
 */
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/** Text and links, in whatever quantity the file actually carried. */
export interface ExtractedResume {
  /** Layout-preserving plain text. Leading whitespace is SIGNIFICANT. */
  text: string;
  /** Absolute URLs found in link annotations, deduped, in document order. */
  links: string[];
}

/** Raised when the file cannot be read at all - a wrong path, an image-only scan. */
export class ResumeExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeExtractionError';
  }
}

/**
 * Whether text extraction has any chance of working on this file.
 *
 * Checked before spawning anything so a `.doc` gets a sentence about converting
 * it rather than poppler's own complaint about a file it was never given.
 */
export function isSupportedResume(path: string): boolean {
  return ['.pdf', '.txt', '.md'].includes(extname(path).toLowerCase());
}

/**
 * Reads a resume into text plus links.
 *
 * Plain-text formats are supported because a resume pasted into a .txt file is
 * a legitimate way to fix a parse the PDF got wrong: correct the text, re-ingest
 * that, and every atom downstream is verbatim from a file the candidate edited.
 */
export async function extractResume(path: string): Promise<ExtractedResume> {
  const ext = extname(path).toLowerCase();

  if (ext === '.txt' || ext === '.md') {
    const text = await readFile(path, 'utf8').catch((err: unknown) => {
      throw new ResumeExtractionError(
        `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // A .txt resume has no annotations, so any URL in it is already visible as
    // text and the parser will pick it up from there.
    return { text, links: [] };
  }

  if (ext !== '.pdf') {
    throw new ResumeExtractionError(
      `unsupported file type "${ext || '(none)'}". Supported: .pdf, .txt, .md. ` +
        'For a .doc or .docx, export to PDF first - a converter that guesses at ' +
        'layout would corrupt exactly the indentation this parser reads.',
    );
  }

  const text = await pdfText(path);

  if (text.trim().length < 100) {
    // The scanned-resume case. It "works" - poppler exits 0 and returns almost
    // nothing - and without this check the parse produces zero atoms and reads
    // as a parser bug rather than as a file with no text layer in it.
    throw new ResumeExtractionError(
      `${path} yielded almost no text (${text.trim().length} characters). ` +
        'This is usually a scanned or image-only PDF. Export a text-based PDF ' +
        'from the original document, or paste the resume into a .txt file and ' +
        'ingest that.',
    );
  }

  return { text, links: await pdfLinks(path) };
}

/** `pdftotext -layout`, which keeps columns and indentation. */
async function pdfText(path: string): Promise<string> {
  try {
    // `-` writes to stdout. maxBuffer raised well past any resume; the default
    // 1MB is close enough to a long PDF's text to be worth not thinking about.
    const { stdout } = await run(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', path, '-'],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    throw new ResumeExtractionError(popplerMessage(err, 'pdftotext', path));
  }
}

/**
 * The `href` values from the PDF's link annotations.
 *
 * `mailto:` and `tel:` are kept - the header's email and phone are often ONLY
 * present as annotations when the visible text is an icon, and a real address
 * beats one recovered by regex from a line that also contains a phone number.
 *
 * A failure here is not fatal: links are an improvement on the text parse, not a
 * requirement of it. An old poppler without `pdftohtml` should cost the profile
 * its LinkedIn URL, not its atoms.
 */
async function pdfLinks(path: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      'pdftohtml',
      ['-i', '-q', '-noframes', '-stdout', path],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const found = stdout.matchAll(/href="([^"]+)"/g);
    const seen = new Set<string>();
    for (const [, href] of found) {
      // `#page2` and other in-document jumps are not contact details.
      if (/^(https?:|mailto:|tel:)/i.test(href)) seen.add(href);
    }
    return [...seen];
  } catch {
    return [];
  }
}

/** Turns ENOENT into an install instruction and anything else into its stderr. */
function popplerMessage(err: unknown, binary: string, path: string): string {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e.code === 'ENOENT') {
    return (
      `${binary} is not installed. It comes from poppler-utils:\n` +
      '  sudo apt install poppler-utils\n' +
      'PDF text extraction needs it; nothing else in this project does.'
    );
  }
  const detail = (e.stderr ?? e.message ?? String(err)).trim();
  return `${binary} failed on ${path}: ${detail}`;
}
