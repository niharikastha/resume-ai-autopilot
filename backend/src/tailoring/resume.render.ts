/**
 * Writing a ResumeDocument out as .docx, and then as .pdf.
 *
 * ATS-SAFE IS THE WHOLE SPECIFICATION HERE, and it is a specification of what NOT to
 * use. Applicant tracking systems read a docx by walking the document body in order,
 * and every layout feature that makes a resume look designed is a feature that
 * reorders or hides text on the way in:
 *
 *   - no tables. The most common cause of a mangled parse: a two-column table
 *     renders as name-then-contact to a human and interleaves cell by cell to a
 *     parser.
 *   - no text boxes, no shapes, no images. Frequently invisible to the parser
 *     entirely, so anything inside them is simply not in the resume.
 *   - no headers or footers. Several parsers drop them, which is where people put
 *     their phone number.
 *   - no columns.
 *   - one common font. Calibri, present everywhere, so nothing is substituted.
 *   - real bullet lists via numbering, not a literal "•" character, so the text of
 *     the bullet is the text of the paragraph.
 *
 * The result looks plain. That is the correct outcome: the reader who cares about
 * typography is downstream of the parser that does not.
 *
 * PDF conversion shells out to headless LibreOffice, per PLAN. Deliberately not a
 * JS pdf library: the docx is the artifact the ATS ingests and the pdf is what a
 * human reads, so they must be the same document rendered once, not two documents
 * generated from one model by two code paths that can disagree.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import type { ResumeDocument } from './resume.document';

const exec = promisify(execFile);

/** The one numbering reference, so every bullet in the document shares it. */
const BULLETS = 'resume-bullets';

const FONT = 'Calibri';
/** Half-points, which is how docx sizes text. 22 = 11pt. */
const BODY = 22;

function contactLine(doc: ResumeDocument): string {
  // Joined with a bullet separator rather than laid out in a table, for the reason
  // in the header. Empty fields drop out so there is no dangling separator.
  return [
    doc.contact.email,
    doc.contact.phone,
    doc.contact.location,
    doc.contact.linkedIn,
    doc.contact.github,
    doc.contact.portfolio,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join('  |  ');
}

/**
 * A section heading: bold, spaced, with a rule under it.
 *
 * The rule is a paragraph BORDER, not a row of underscores and not a table with one
 * visible edge. A border is invisible to a parser; underscores are text it has to
 * read and discard.
 *
 * `keepNext` is what stops EDUCATION sitting alone at the foot of page one with the
 * degree it names overleaf - measured on a real rendered resume. A word processor
 * breaks pages wherever the text runs out unless a paragraph says otherwise, and it
 * has no idea that a heading with nothing under it is meaningless. `keepLines` keeps
 * the heading's own line whole. Neither is a layout feature a parser has to
 * understand: both are properties on the paragraph, and the text is unchanged.
 */
function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    keepLines: true,
    spacing: { before: 240, after: 80 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 2 },
    },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        size: BODY,
        font: FONT,
      }),
    ],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    numbering: { reference: BULLETS, level: 0 },
    spacing: { after: 40 },
    children: [new TextRun({ text, size: BODY, font: FONT })],
  });
}

/**
 * The left-hand side of a role heading: "Employer - Title", written once.
 *
 * DEDUPED, because a PROJECT has no employer distinct from its name - ingestion
 * fills both fields with the same string, and a plain join printed "Walking Pal -
 * The First Walking Buddy App - Walking Pal - The First Walking Buddy App" across
 * two lines of a real rendered resume. Compared loosely: a trailing period or a
 * difference in case is the same name written twice.
 *
 * Exported for the tests. The heading is the first thing a recruiter's eye lands
 * on, and it is the one line on the page that no model wrote.
 */
export function roleHeadingText(
  title: string,
  employer: string | null,
): string {
  const parts = [employer, title]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const key = (part: string) =>
    part
      .toLowerCase()
      .replace(/[\s.]+/g, ' ')
      .trim();

  // First spelling wins, so the heading reads in field order and the same profile
  // renders the same string every time. `new Map` would keep the LAST value for a
  // repeated key, which would silently prefer the title's casing over the
  // employer's for no reason anyone could predict from reading the call.
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    if (seen.has(key(part))) continue;
    seen.add(key(part));
    kept.push(part);
  }
  return kept.join(' - ');
}

/**
 * One role heading: the name on the left, the dates on the right.
 *
 * The right-hand alignment is a TAB STOP, not a table cell and not a run of spaces.
 * A tab is one character the parser skips; a table is a structure it has to
 * understand.
 */
function roleHeading(
  title: string,
  employer: string | null,
  dateRange: string | null,
): Paragraph {
  const left = roleHeadingText(title, employer);
  const children = [
    new TextRun({ text: left, bold: true, size: BODY, font: FONT }),
  ];
  if (dateRange) {
    children.push(
      new TextRun({ text: `\t${dateRange}`, size: BODY, font: FONT }),
    );
  }
  return new Paragraph({
    // Same reason as the section heading: an employer and dates at the bottom of a
    // page with their bullets on the next one reads as a job with nothing in it.
    keepNext: true,
    keepLines: true,
    spacing: { before: 160, after: 40 },
    // 9360 twips = 6.5in, the width of Letter with one-inch margins, so the dates
    // end flush with the right margin.
    tabStops: [{ type: 'right', position: 9360 }],
    children,
  });
}

/**
 * One thing on the page, before it is XML.
 *
 * The point of this type is that WHICH SECTION A LINE LANDS IN is a decision worth
 * reading in a test, and a Paragraph cannot be read - it is an XML builder. So
 * `layout` makes the decisions and returns plain data, and `paragraphFor` turns each
 * item into the one paragraph it corresponds to. Nothing in the second step chooses
 * anything.
 */
export type ResumeBlock =
  | { kind: 'name'; text: string }
  | { kind: 'headline'; text: string }
  | { kind: 'contact'; text: string }
  | { kind: 'section'; text: string }
  | {
      kind: 'entry';
      title: string;
      employer: string | null;
      dateRange: string | null;
    }
  | { kind: 'line'; text: string }
  | { kind: 'bullet'; text: string };

/** Every line of the resume, in the order it prints. Exported for the tests. */
export function layout(doc: ResumeDocument): ResumeBlock[] {
  const blocks: ResumeBlock[] = [{ kind: 'name', text: doc.contact.fullName }];

  if (doc.headline) blocks.push({ kind: 'headline', text: doc.headline });
  blocks.push({ kind: 'contact', text: contactLine(doc) });

  if (doc.skills.length > 0) {
    blocks.push({ kind: 'section', text: 'Skills' });
    // As plain lines, not bullets: a skills line is already a comma-separated list,
    // and bulleting each one produces a page of single-item bullets.
    for (const skill of doc.skills) {
      blocks.push({ kind: 'line', text: skill.text });
    }
  }

  // An orphan block has no title and no employer, so nothing prints above its
  // bullets. Left inside Experience they appear directly under the previous job's
  // heading and READ AS THAT JOB'S BULLETS - on a real rendered resume, two
  // volunteer positions became two more Walking Pal bullets. Nothing about the text
  // is wrong; the page attributes it to an employer it never mentions.
  const jobs = doc.roles.filter((block) => block.title || block.employer);
  const loose = doc.roles.filter((block) => !block.title && !block.employer);

  // ...unless orphans are ALL there is. With no job above them there is nothing to
  // be misread as, and heading them "certifications" would be this renderer
  // inventing a claim about lines whose source section it cannot see.
  const separate = jobs.length > 0 && loose.length > 0;

  if (doc.roles.length > 0 && (jobs.length > 0 || !separate)) {
    blocks.push({ kind: 'section', text: 'Experience' });
    for (const block of separate ? jobs : doc.roles) {
      if (block.title || block.employer) {
        blocks.push({
          kind: 'entry',
          title: block.title,
          employer: block.employer,
          dateRange: block.dateRange,
        });
      }
      for (const item of block.bullets) {
        blocks.push({ kind: 'bullet', text: item.text });
      }
    }
  }

  if (doc.education.length > 0) {
    blocks.push({ kind: 'section', text: 'Education' });
    for (const item of doc.education) {
      // Same shape as a role entry - institution on the left, dates on the right -
      // because a degree and its university are the same kind of fact as a job and
      // its employer, and one layout means one thing for a parser to learn.
      blocks.push({
        kind: 'entry',
        title: item.text,
        employer: item.institution,
        dateRange: item.dateRange,
      });
    }
  }

  // Last, after education, which is where a reader expects the things that are
  // neither a job nor a degree. The heading names both kinds because the parser's
  // CERTIFICATIONS and LEADERSHIP sections are exactly what produces a standalone
  // bullet - see the BULLET case in resume.document.ts - and which of the two a
  // given line came from is not carried on the atom.
  if (separate) {
    blocks.push({ kind: 'section', text: 'Certifications & Activities' });
    for (const block of loose) {
      for (const item of block.bullets) {
        blocks.push({ kind: 'bullet', text: item.text });
      }
    }
  }

  return blocks;
}

/** One block as one paragraph. No decisions here - see ResumeBlock. */
function paragraphFor(block: ResumeBlock): Paragraph {
  switch (block.kind) {
    case 'name':
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [
          new TextRun({ text: block.text, bold: true, size: 32, font: FONT }),
        ],
      });
    case 'headline':
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [new TextRun({ text: block.text, size: BODY, font: FONT })],
      });
    case 'contact':
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 120 },
        children: [new TextRun({ text: block.text, size: 20, font: FONT })],
      });
    case 'section':
      return heading(block.text);
    case 'entry':
      return roleHeading(block.title, block.employer, block.dateRange);
    case 'line':
      return new Paragraph({
        spacing: { after: 40 },
        children: [new TextRun({ text: block.text, size: BODY, font: FONT })],
      });
    case 'bullet':
      return bullet(block.text);
  }
}

/** Builds the docx in memory. Exported for the renderer's tests. */
export function toDocx(doc: ResumeDocument): Document {
  const body = layout(doc).map(paragraphFor);

  return new Document({
    // Set at the document level so nothing depends on every paragraph remembering
    // to ask for the font.
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY } },
        heading2: {
          run: { font: FONT, size: BODY, bold: true, color: '000000' },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: { indent: { left: 360, hanging: 180 } },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            // One inch all round, in twips. Narrower margins fit more text and are
            // also where some parsers start losing the outermost characters.
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        children: body,
      },
    ],
  });
}

export interface RenderedResume {
  docxPath: string;
  /** Null when LibreOffice is not installed or the conversion failed. */
  pdfPath: string | null;
}

/**
 * Writes the docx and converts it.
 *
 * A FAILED PDF CONVERSION IS NOT FATAL. LibreOffice may be absent - PLAN's own split
 * puts tailoring on a server and `submit` on the laptop, and the server is the one
 * without a desktop suite installed. The docx is the artifact that matters, so a
 * missing pdf returns null and lets the caller carry on rather than throwing away a
 * variant that cost a deep-tier call.
 */
export async function renderResume(
  doc: ResumeDocument,
  outputDir: string,
  basename: string,
): Promise<RenderedResume> {
  await mkdir(outputDir, { recursive: true });

  const docxPath = path.join(outputDir, `${basename}.docx`);
  await writeFile(docxPath, await Packer.toBuffer(toDocx(doc)));

  const pdfPath = await toPdf(docxPath, outputDir);
  return { docxPath, pdfPath };
}

/**
 * Converts via headless LibreOffice.
 *
 * `-env:UserInstallation` points at a private profile directory. Without it,
 * concurrent conversions contend over the single default profile in $HOME and the
 * second one exits silently having produced nothing - which looks exactly like a
 * document LibreOffice could not read.
 *
 * ABSOLUTE, via path.resolve. `file://` takes an absolute path - everything after
 * the two slashes up to the next one is the HOST - so `file://.artifacts/resumes`
 * asks for a profile on a machine called ".artifacts", and RESUME_OUTPUT_DIR
 * defaults to exactly that kind of relative path. LibreOffice does not complain:
 * it hangs until the timeout and writes nothing, which this function then reports
 * as "conversion failed". Measured - every pdf was silently missing until the
 * resolve was added, on a machine with LibreOffice installed and working.
 */
async function toPdf(
  docxPath: string,
  outputDir: string,
): Promise<string | null> {
  const expected = docxPath.replace(/\.docx$/, '.pdf');
  const profile = path.resolve(outputDir, '.lo-profile');

  try {
    await exec(
      'soffice',
      [
        `-env:UserInstallation=file://${profile}`,
        '--headless',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        outputDir,
        docxPath,
      ],
      // A conversion is seconds; a minute means the first run is building the
      // profile, and anything past that is a hang rather than slow work.
      { timeout: 120_000 },
    );

    // LibreOffice reports success on stdout even when it wrote nothing, so the file
    // is checked rather than the exit code.
    const written = await readdir(outputDir);
    if (written.includes(path.basename(expected))) return expected;
    return null;
  } catch {
    return null;
  }
}
