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
 */
function heading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 2 },
    },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: BODY, font: FONT }),
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
 * The role heading: "Title, Employer" on the left and the dates on the right.
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
  const left = [employer, title].filter((part) => part && part.trim()).join(' - ');
  const children = [
    new TextRun({ text: left, bold: true, size: BODY, font: FONT }),
  ];
  if (dateRange) {
    children.push(
      new TextRun({ text: `\t${dateRange}`, size: BODY, font: FONT }),
    );
  }
  return new Paragraph({
    spacing: { before: 160, after: 40 },
    // 9360 twips = 6.5in, the width of Letter with one-inch margins, so the dates
    // end flush with the right margin.
    tabStops: [{ type: 'right', position: 9360 }],
    children,
  });
}

/** Builds the docx in memory. Exported for the renderer's tests. */
export function toDocx(doc: ResumeDocument): Document {
  const body: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: doc.contact.fullName,
          bold: true,
          size: 32,
          font: FONT,
        }),
      ],
    }),
  ];

  if (doc.headline) {
    body.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [new TextRun({ text: doc.headline, size: BODY, font: FONT })],
      }),
    );
  }

  body.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: contactLine(doc), size: 20, font: FONT })],
    }),
  );

  if (doc.skills.length > 0) {
    body.push(heading('Skills'));
    // As plain paragraphs, not bullets: a skills line is already a comma-separated
    // list, and bulleting each one produces a page of single-item bullets.
    for (const skill of doc.skills) {
      body.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [new TextRun({ text: skill.text, size: BODY, font: FONT })],
        }),
      );
    }
  }

  if (doc.roles.length > 0) {
    body.push(heading('Experience'));
    for (const block of doc.roles) {
      // An orphan block has no title and no employer worth printing a heading for -
      // its bullets are certifications or leadership lines, which stand alone.
      if (block.title || block.employer) {
        body.push(roleHeading(block.title, block.employer, block.dateRange));
      }
      for (const item of block.bullets) body.push(bullet(item.text));
    }
  }

  if (doc.education.length > 0) {
    body.push(heading('Education'));
    for (const item of doc.education) {
      // Same shape as a role heading - institution on the left, dates on the right -
      // because a degree and its university are the same kind of fact as a job and
      // its employer, and one layout means one thing for a parser to learn.
      body.push(roleHeading(item.text, item.institution, item.dateRange));
    }
  }

  return new Document({
    // Set at the document level so nothing depends on every paragraph remembering
    // to ask for the font.
    styles: {
      default: {
        document: { run: { font: FONT, size: BODY } },
        heading2: { run: { font: FONT, size: BODY, bold: true, color: '000000' } },
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
 */
async function toPdf(docxPath: string, outputDir: string): Promise<string | null> {
  const expected = docxPath.replace(/\.docx$/, '.pdf');
  const profile = path.join(outputDir, '.lo-profile');

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
