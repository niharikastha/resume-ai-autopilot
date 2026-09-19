/**
 * Does the form reader still find the label next to each field?
 *
 *   npx ts-node -r tsconfig-paths/register scripts/label-extraction.check.ts
 *
 * WHY THIS EXISTS. The only real prefill this system has run scored 0.80 coverage, and
 * both misses - one of them a REQUIRED field - were reported as `"label":
 * "(unlabelled)"`. They were not unlabelled on screen. The label was a PRECEDING
 * SIBLING of the input's wrapper, which is what React form libraries emit and what
 * every path in `groupLabel` used to miss. A field with no label cannot be matched to a
 * stored answer and gives the LLM resolver an empty string to reason about, so it is
 * left blank - which is how a form that looks filled arrives with a required box empty.
 *
 * WHY IT IS A SCRIPT AND NOT A JEST TEST. `COLLECT` is a STRING evaluated inside a real
 * page, deliberately - see the header of playwright.page.ts. Its behaviour is a fact
 * about a browser's DOM, so jsdom would be testing a different engine than the one that
 * runs in production, and the interesting cases here are all about how a real layout
 * engine answers `closest`, `previousElementSibling` and `getClientRects`. So this
 * drives the same Chrome the submit session drives.
 *
 * THE FOUR "already worked" FIXTURES ARE THE POINT AS MUCH AS THE NEW ONES. The sibling
 * search reaches outside the control's own box, which is exactly the kind of widening
 * that starts stealing the previous question's text - hence the `must NOT` case, and
 * hence keeping the paths that already worked in the list so a future widening cannot
 * quietly replace a correct label with a nearer wrong one.
 *
 * Run against HEAD~ before the sibling fix, five of these fail and the other five pass.
 */
import { chromium } from 'playwright-core';
import { PlaywrightFormPage } from '../src/submission/playwright.page';

const FIXTURES: { name: string; html: string; expect: string }[] = [
  {
    name: 'aria-label (already worked)',
    html: `<input aria-label="Email Address" />`,
    expect: 'Email Address',
  },
  {
    name: 'label[for] (already worked)',
    html: `<label for="p">Phone Number</label><input id="p" />`,
    expect: 'Phone Number',
  },
  {
    name: 'wrapping label (already worked)',
    html: `<label>Legal Name<input /></label>`,
    expect: 'Legal Name',
  },
  {
    name: 'label inside own box (already worked)',
    html: `<div><span class="_label_a1">Current CTC</span><input /></div>`,
    expect: 'Current CTC',
  },
  {
    name: 'SIBLING label div, nested wrapper (Ashby/Greenhouse shape)',
    html: `<div>
             <div class="_label_h3k">Are you legally authorised to work in India?</div>
             <div><input /></div>
           </div>`,
    expect: 'Are you legally authorised to work in India?',
  },
  {
    name: 'SIBLING bare label element, no for=',
    html: `<div><label>Notice period in days</label><div><input /></div></div>`,
    expect: 'Notice period in days',
  },
  {
    name: 'SIBLING plain text div, one level up',
    html: `<div><div>How did you hear about us?</div><div><input /></div></div>`,
    expect: 'How did you hear about us?',
  },
  {
    name: 'SIBLING label two wrappers out',
    html: `<div>
             <p class="Label">Expected annual compensation</p>
             <div><div><input /></div></div>
           </div>`,
    expect: 'Expected annual compensation',
  },
  {
    name: 'must NOT steal the previous question label',
    html: `<div>
             <div class="_label_x">First question</div>
             <div><input id="q1" /></div>
           </div>
           <div><div><input id="q2" /></div></div>`,
    expect: '(q2 must not be labelled "First question")',
  },
  {
    name: 'textarea with sibling label',
    html: `<div><div class="_label_y">Additional Information</div><div><textarea></textarea></div></div>`,
    expect: 'Additional Information',
  },
];

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  let pass = 0;
  let fail = 0;

  for (const fixture of FIXTURES) {
    await page.setContent(`<!doctype html><body><form>${fixture.html}</form></body>`);
    const fields = await new PlaywrightFormPage(page).fields();
    const labels = fields.map((f) => `${f.name || f.handle}="${f.label}"`).join('  ');

    let ok: boolean;
    if (fixture.name.startsWith('must NOT')) {
      const q2 = fields[1];
      ok = !!q2 && q2.label !== 'First question';
    } else {
      ok = fields.some((f) => f.label === fixture.expect);
    }
    ok ? pass++ : fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${fixture.name}\n        got: ${labels}`);
  }

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
