/**
 * The other templates, and the one place that maps a stored choice to a writer.
 *
 * A TEMPLATE CHANGES THE TYPESETTING AND NOTHING ELSE. Every writer here calls
 * `layout` from resume.render.ts, so which lines appear and in what order is decided
 * once, for all of them. That is not tidiness: the ordering is the ATS contract - the
 * parser walks the body top to bottom, and a template that moved education above
 * experience or split skills into two columns would be changing what the machine
 * reads, not how the page looks. So what a template gets to choose is margins,
 * sizes, weights, alignment, colour and rules. Switching template can change how
 * many pages the resume runs to. It cannot change one word of it.
 *
 * EVERY RULE IN resume.render.ts's HEADER STILL APPLIES to all of them: no tables, no
 * text boxes, no images, no headers or footers, no columns, one common font, real
 * numbering for bullets. A "designed" template would be a template that parses badly,
 * and the reader who cares about typography is downstream of the parser that does not.
 * This is why none of these change the font: Calibri is present everywhere, and a
 * template built on a font the machine substitutes is a template whose line breaks are
 * decided by whatever was installed.
 *
 * CLASSIC IS NOT HERE. It is `toDocx` in resume.render.ts, unchanged, because resumes
 * already sent to employers came out of it and a candidate re-downloading one must get
 * the document they sent. The two writers below are new work; that file is not.
 */
import { ResumeTemplate } from '@prisma/client';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Paragraph,
  TextRun,
} from 'docx';
import type { ResumeDocument } from './resume.document';
import {
  isMarked,
  layout,
  MARK,
  roleHeadingText,
  toDocx,
  type ResumeBlock,
  type ResumeWriter,
} from './resume.render';

/** One font for all of them, for the reason in the header. */
const FONT = 'Calibri';

/** Letter, in twips. The right tab stop is this less the two side margins. */
const PAGE_WIDTH = 12240;

/**
 * What one template is, as data.
 *
 * Written this way so that adding a template is a paragraph of numbers rather than a
 * fourth copy of the block switch below - and so that two templates cannot quietly
 * disagree about which block kinds exist.
 */
interface Style {
  /** Page margin, twips, all four sides. */
  margin: number;
  /** Body text, half-points. 22 = 11pt. */
  body: number;
  name: { size: number; align: 'center' | 'left'; upper: boolean };
  headline: { size: number; italic: boolean };
  contact: { size: number };
  section: {
    size: number;
    /** Hex, no leading hash. */
    colour: string;
    /** A paragraph border under the heading, not a row of underscores. */
    rule: boolean;
    before: number;
    after: number;
  };
  entry: { before: number; after: number };
  bullet: { after: number; indent: number; hanging: number };
  /** Space after a plain line - the skills lines. */
  line: { after: number };
}

/** The numbering reference. One per document, shared by every bullet in it. */
const BULLETS = 'resume-bullets';

/**
 * A style as a writer.
 *
 * `mark` highlights the lines a model rewrote, and the highlight is applied to the
 * same run the text is in rather than to the paragraph, so the marking survives a
 * conversion to pdf and disappears completely when it is off. Only the review copy
 * ever asks for it - see `WriterOptions`.
 */
function writerFor(style: Style): ResumeWriter {
  const run = (
    text: string,
    extra: {
      size?: number;
      bold?: boolean;
      italics?: boolean;
      colour?: string;
      marked?: boolean;
    } = {},
  ): TextRun =>
    new TextRun({
      text,
      font: FONT,
      size: extra.size ?? style.body,
      ...(extra.bold ? { bold: true } : {}),
      ...(extra.italics ? { italics: true } : {}),
      ...(extra.colour ? { color: extra.colour } : {}),
      ...(extra.marked ? { highlight: MARK } : {}),
    });

  const paragraphFor = (block: ResumeBlock, mark: boolean): Paragraph => {
    const marked = mark && isMarked(block);

    switch (block.kind) {
      case 'name':
        return new Paragraph({
          alignment:
            style.name.align === 'center'
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
          spacing: { after: 40 },
          children: [
            run(style.name.upper ? block.text.toUpperCase() : block.text, {
              size: style.name.size,
              bold: true,
            }),
          ],
        });

      case 'headline':
        return new Paragraph({
          alignment:
            style.name.align === 'center'
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
          spacing: { after: 40 },
          children: [
            run(block.text, {
              size: style.headline.size,
              italics: style.headline.italic,
              marked,
            }),
          ],
        });

      case 'contact':
        return new Paragraph({
          alignment:
            style.name.align === 'center'
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
          spacing: { after: 120 },
          children: [run(block.text, { size: style.contact.size })],
        });

      case 'section':
        return new Paragraph({
          heading: HeadingLevel.HEADING_2,
          // A heading with nothing under it is meaningless, and a word processor
          // has no way of knowing that - same reason as the classic template.
          keepNext: true,
          keepLines: true,
          spacing: { before: style.section.before, after: style.section.after },
          ...(style.section.rule
            ? {
                border: {
                  bottom: {
                    style: BorderStyle.SINGLE,
                    size: 6,
                    color: '999999',
                    space: 2,
                  },
                },
              }
            : {}),
          children: [
            run(block.text.toUpperCase(), {
              size: style.section.size,
              bold: true,
              colour: style.section.colour,
            }),
          ],
        });

      case 'entry': {
        const children = [
          run(roleHeadingText(block.title, block.employer), {
            bold: true,
            marked,
          }),
        ];
        if (block.dateRange) children.push(run(`\t${block.dateRange}`));
        return new Paragraph({
          keepNext: true,
          keepLines: true,
          spacing: { before: style.entry.before, after: style.entry.after },
          // A right tab stop, not a table cell and not a run of spaces: one
          // character the parser skips, instead of a structure it has to read.
          tabStops: [
            { type: 'right', position: PAGE_WIDTH - style.margin * 2 },
          ],
          children,
        });
      }

      case 'line':
        return new Paragraph({
          spacing: { after: style.line.after },
          children: [run(block.text, { marked })],
        });

      case 'bullet':
        return new Paragraph({
          numbering: { reference: BULLETS, level: 0 },
          spacing: { after: style.bullet.after },
          children: [run(block.text, { marked })],
        });
    }
  };

  return (doc: ResumeDocument, options): Document => {
    const mark = options?.mark === true;
    return new Document({
      styles: {
        default: {
          document: { run: { font: FONT, size: style.body } },
          heading2: {
            run: {
              font: FONT,
              size: style.section.size,
              bold: true,
              color: style.section.colour,
            },
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
                // A real bullet through numbering, so the text of the paragraph is
                // the text of the bullet and nothing else.
                text: '•',
                alignment: AlignmentType.LEFT,
                style: {
                  paragraph: {
                    indent: {
                      left: style.bullet.indent,
                      hanging: style.bullet.hanging,
                    },
                  },
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
              margin: {
                top: style.margin,
                right: style.margin,
                bottom: style.margin,
                left: style.margin,
              },
            },
          },
          children: layout(doc).map((block) => paragraphFor(block, mark)),
        },
      ],
    });
  };
}

/**
 * Everything tightened by one notch, to fit a page.
 *
 * The point of it is page count, which is the one complaint about a resume that a
 * candidate cannot fix by editing: 0.6in margins and 10pt body recover roughly a
 * fifth of the page. 0.6in is as narrow as this goes - some parsers start losing the
 * outermost characters below half an inch, which is a resume that reads as if it were
 * missing words.
 */
const compact = writerFor({
  margin: 864,
  body: 20,
  name: { size: 28, align: 'center', upper: false },
  headline: { size: 20, italic: false },
  contact: { size: 18 },
  section: { size: 20, colour: '000000', rule: true, before: 160, after: 60 },
  entry: { before: 100, after: 20 },
  bullet: { after: 20, indent: 300, hanging: 160 },
  line: { after: 20 },
});

/**
 * The same document with the name on the left and headings that carry colour.
 *
 * Left-aligned because that is where a reader's eye starts, and the centred block is
 * the one thing about the classic template that reads as a form rather than a letter.
 * The heading colour is a run property - invisible to a parser, which sees the same
 * uppercase word either way - and it replaces the rule rather than joining it, because
 * a coloured heading with a grey line under it is two devices doing one job.
 */
const modern = writerFor({
  margin: 1080,
  body: 22,
  name: { size: 34, align: 'left', upper: false },
  headline: { size: 22, italic: true },
  contact: { size: 19 },
  section: { size: 24, colour: '1F3864', rule: false, before: 280, after: 100 },
  entry: { before: 180, after: 40 },
  bullet: { after: 50, indent: 360, hanging: 180 },
  line: { after: 50 },
});

/**
 * Stored choice to writer.
 *
 * Keyed on the Prisma enum rather than on a string, so a template added to the schema
 * and not to this file does not compile.
 */
export const TEMPLATES: Record<ResumeTemplate, ResumeWriter> = {
  [ResumeTemplate.CLASSIC]: toDocx,
  [ResumeTemplate.COMPACT]: compact,
  [ResumeTemplate.MODERN]: modern,
};

export function templateWriter(template: ResumeTemplate): ResumeWriter {
  return TEMPLATES[template];
}

/**
 * What the screen offers, and what it says about each.
 *
 * Here rather than in the frontend because the list has to be the list of writers that
 * exist: a template offered in the UI and missing from `TEMPLATES` would be a picker
 * that renders the wrong document, and the `Record` above makes the reverse impossible.
 */
export interface TemplateChoice {
  id: ResumeTemplate;
  label: string;
  detail: string;
}

export const TEMPLATE_CHOICES: readonly TemplateChoice[] = [
  {
    id: ResumeTemplate.CLASSIC,
    label: 'Classic',
    detail:
      'Centred name, ruled section headings, 11pt on one-inch margins. The safest ' +
      'thing to send and what this system has always produced.',
  },
  {
    id: ResumeTemplate.COMPACT,
    label: 'Compact',
    detail:
      'The same resume tightened to fit a page — 10pt on 0.6in margins. Reach for ' +
      'it when yours runs a few lines onto a second page.',
  },
  {
    id: ResumeTemplate.MODERN,
    label: 'Modern',
    detail:
      'Name on the left, larger headings in navy, more air between sections. Reads ' +
      'less like a form; takes a little more room.',
  },
];

/**
 * A template name as it came off the wire.
 *
 * Returns null rather than throwing, so the caller decides whether an unknown value is
 * a bad request or a reason to fall back - the HTTP boundary wants the first and a row
 * written by an older version of this code wants the second.
 */
export function asTemplate(value: unknown): ResumeTemplate | null {
  return typeof value === 'string' &&
    (Object.values(ResumeTemplate) as string[]).includes(value)
    ? (value as ResumeTemplate)
    : null;
}
