/**
 * The only file in phase 6 that touches Playwright.
 *
 * It implements `FormPage`, and everything above it - the engine, all six adapters -
 * is written against that interface instead. That is what makes the "no submit
 * codepath" guarantee checkable by reading one file rather than by auditing every
 * adapter, and what lets the engine's tests run with no browser at all.
 *
 * WHY THE COLLECTION SCRIPT IS A STRING. Reading the form means running code in the
 * page, and that code needs `document`. Adding `"dom"` to the backend's tsconfig `lib`
 * would type it - and would also put `window`, `localStorage` and a browser `fetch`
 * into scope for every NestJS service in the repo, where each one is a bug waiting to
 * compile. Playwright accepts a string expression, so the browser-side code stays
 * browser-side and the Node side stays Node. The cost is that this one script is not
 * type-checked; it is therefore kept short, and its output is narrowed by
 * `RawField` at the boundary.
 *
 * WHY HANDLES ARE ATTRIBUTES WRITTEN BY THAT SCRIPT. An adapter names a field back to
 * this class by handle, and the handle has to survive React re-rendering the form
 * between the read and the write. An index into an array does not; a `data-` attribute
 * on the element does, and it also means an adapter cannot address a control that was
 * never reported to it, because nothing else on the page carries one.
 */
import type { Page } from 'playwright-core';
import type { FieldType, FormField, FormPage } from './form-page';

/** The attribute the collection script stamps on every control it reports. */
const HANDLE_ATTR = 'data-autopilot-field';

/**
 * A form with more controls than this is not a job application - it is a search page
 * or a settings screen the crawler followed by mistake. Capped so a wrong URL costs a
 * screenshot rather than a thousand LLM-mapped fields.
 */
const MAX_FIELDS = 120;

/** What the collection script returns, before radios are grouped. */
interface RawField {
  handle: string;
  tag: string;
  type: string;
  label: string;
  groupLabel: string;
  name: string | null;
  required: boolean;
  options: string[];
  value: string;
}

/**
 * Reads every fillable control on the page.
 *
 * Deliberately does NOT wait for anything. The caller has already waited for the form
 * - see BrowserService.open - and a wait in here would be a second, different opinion
 * about when a React form is ready.
 */
const COLLECT = `(() => {
  const ATTR = ${JSON.stringify(HANDLE_ATTR)};
  const MAX = ${MAX_FIELDS};
  document.querySelectorAll('[' + ATTR + ']').forEach(function (el) {
    el.removeAttribute(ATTR);
  });

  const SKIP = { hidden: 1, submit: 1, button: 1, image: 1, reset: 1 };
  const text = function (el) {
    return el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
  };
  const esc = function (value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value;
  };

  const ownLabel = function (el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const parts = by.split(/\\s+/).map(function (id) {
        return text(document.getElementById(id));
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    if (el.id) {
      const tied = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (tied) return text(tied);
    }
    const wrap = el.closest('label');
    if (wrap) return text(wrap);
    return '';
  };

  const groupLabel = function (el) {
    const set = el.closest('fieldset');
    if (set) {
      const legend = set.querySelector('legend');
      if (legend && text(legend)) return text(legend);
    }
    const role = el.closest('[role="group"],[role="radiogroup"]');
    if (role) {
      const aria = role.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
    }
    const box = el.closest('div,li,td,section');
    if (box) {
      const near = box.querySelector('label,legend,[class*="label"],[class*="Label"]');
      if (near && text(near)) return text(near);
    }
    return '';
  };

  const out = [];
  const controls = document.querySelectorAll('input,select,textarea');
  for (let i = 0; i < controls.length && out.length < MAX; i++) {
    const el = controls[i];
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag;
    if (SKIP[type]) continue;
    if (el.disabled || el.readOnly) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    // A file input is routinely styled out of sight and still works. Everything else
    // that renders nothing is a leftover from a hidden step.
    if (type !== 'file' && el.getClientRects().length === 0) continue;

    const handle = 'f' + out.length;
    el.setAttribute(ATTR, handle);

    const own = ownLabel(el);
    const group = groupLabel(el);
    let options = [];
    if (tag === 'select') {
      options = Array.prototype.map.call(el.options, function (option) {
        return (option.label || option.textContent || '').replace(/\\s+/g, ' ').trim();
      }).filter(Boolean);
    }

    let value = '';
    if (type === 'checkbox' || type === 'radio') value = el.checked ? 'checked' : '';
    else if (type !== 'file') value = el.value || '';

    const labelText = own || group;
    out.push({
      handle: handle,
      tag: tag,
      type: type,
      label: labelText,
      groupLabel: group,
      name: el.name || null,
      required: !!el.required
        || el.getAttribute('aria-required') === 'true'
        || /\\*/.test(labelText),
      options: options,
      value: value,
    });
  }
  return out;
})()`;

/** The words that mean "this control sends the form". */
const SUBMITTING =
  /\b(submit|apply now|send application|send my application|finish|complete application)\b/i;

export class PlaywrightFormPage implements FormPage {
  constructor(private readonly page: Page) {}

  get url(): string {
    return this.page.url();
  }

  /**
   * Every control, with radio buttons collapsed into one field per group.
   *
   * A radio group is ONE question with several answers, and the engine has to see it
   * that way: fifteen separate boolean fields called "Yes"/"No" cannot be matched to a
   * stored answer, whereas one field labelled "Do you require sponsorship?" with
   * options can be.
   */
  async fields(): Promise<FormField[]> {
    // Asserted, because COLLECT is a STRING and not a function - the compiler cannot
    // check the shape of a script it never sees. The string form is deliberate: passing a
    // real function would need `"dom"` in tsconfig's lib, which would put `window` and
    // `localStorage` in scope for every NestJS service in this project. So the contract
    // lives in RawField and in COLLECT, and the two are kept in step by hand.
    const raw = await this.page.evaluate<RawField[]>(COLLECT);

    const fields: FormField[] = [];
    /** name -> index in `fields`, for the radio group already emitted. */
    const groups = new Map<string, number>();

    for (const field of raw) {
      if (field.type === 'radio' && field.name) {
        const at = groups.get(field.name);
        if (at !== undefined) {
          // Another answer to a question already emitted. Its own label is the option.
          const existing = fields[at];
          fields[at] = {
            ...existing,
            options: [...existing.options, field.label].filter(Boolean),
            // A group counts as answered if any member is checked.
            value: existing.value || field.value,
          };
          continue;
        }
        groups.set(field.name, fields.length);
        fields.push({
          handle: field.handle,
          type: 'radio',
          // The QUESTION, not this button's answer. Falls back to the option text only
          // when the markup gives no group label at all, which at least names
          // something rather than nothing.
          label: field.groupLabel || field.label,
          name: field.name,
          required: field.required,
          options: [field.label].filter(Boolean),
          value: field.value,
        });
        continue;
      }

      fields.push({
        handle: field.handle,
        type: normalizeType(field.tag, field.type),
        label: field.label,
        name: field.name,
        required: field.required,
        options: field.options,
        value: field.value,
      });
    }

    return fields;
  }

  async fill(handle: string, value: string): Promise<void> {
    await this.locate(handle).fill(value);
  }

  /**
   * Chooses an option, on a `<select>` or on a radio group.
   *
   * The radio branch re-queries the group by name rather than using a stored handle
   * per option, because the option that has to be clicked is decided by the engine
   * after the read - and on a React form the elements from the read may already have
   * been replaced.
   */
  async select(handle: string, value: string): Promise<void> {
    const target = this.locate(handle);
    const tag = await target.evaluate((el) =>
      (el as { tagName: string }).tagName.toLowerCase(),
    );

    if (tag === 'select') {
      await target.selectOption({ label: value });
      return;
    }

    const name = await target.getAttribute('name');
    if (!name)
      throw new Error(
        `radio ${handle} has no name, so its group cannot be found`,
      );

    const radios = this.page.locator(
      `input[type="radio"][name="${cssQuote(name)}"]`,
    );
    const count = await radios.count();
    for (let index = 0; index < count; index++) {
      const radio = radios.nth(index);
      const label = await radioLabel(radio);
      if (label === value) {
        await radio.check();
        return;
      }
    }
    throw new Error(`no radio in group "${name}" is labelled "${value}"`);
  }

  async check(handle: string): Promise<void> {
    await this.locate(handle).check();
  }

  async attach(handle: string, absolutePath: string): Promise<void> {
    await this.locate(handle).setInputFiles(absolutePath);
  }

  /**
   * Opens a collapsed widget.
   *
   * THE ONLY METHOD HERE THAT ACTIVATES ANYTHING, and it refuses submit controls twice
   * over: by element identity, and by the accessible text a human would read on the
   * button. Both, because a React form's submit control is often a `<div role=button>`
   * with no type attribute at all, and because a `<button type=submit>` labelled
   * "Continue" is a submit control whatever it says.
   *
   * A refusal throws rather than returning quietly. A form filler that silently did
   * nothing here would look like a form filler that could not find the dropdown, and
   * the difference matters when reading a failed run.
   */
  async reveal(handle: string): Promise<void> {
    const target = this.locate(handle);
    const identity = await target.evaluate((node) => {
      const el = node as {
        tagName: string;
        getAttribute(name: string): string | null;
        textContent: string | null;
      };
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') ?? '').toLowerCase(),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
        label: el.getAttribute('aria-label') ?? '',
        value: el.getAttribute('value') ?? '',
      };
    });

    if (
      identity.type === 'submit' ||
      (identity.tag === 'button' && identity.type === '')
    ) {
      // A `<button>` with no type IS a submit button - that is the HTML default, and
      // it is the single most common way a form gets sent by accident.
      throw new Error(
        `refusing to activate ${handle}: it is a submit control (${identity.tag}` +
          `${identity.type ? ` type=${identity.type}` : ', no type attribute'})`,
      );
    }

    const words = `${identity.text} ${identity.label} ${identity.value}`;
    if (SUBMITTING.test(words)) {
      throw new Error(
        `refusing to activate ${handle}: its text reads as a submit control ` +
          `("${words.trim().slice(0, 60)}")`,
      );
    }

    await target.click();
  }

  async screenshot(absolutePath: string): Promise<void> {
    await this.page.screenshot({ path: absolutePath, fullPage: true });
  }

  /**
   * A handle to a locator.
   *
   * Only ever by the attribute the collection script wrote, which is what stops an
   * adapter from addressing a control that was never reported - including a submit
   * button, which the script skips entirely.
   */
  private locate(handle: string) {
    if (!/^f\d+$/.test(handle)) {
      throw new Error(`"${handle}" is not a handle this page issued`);
    }
    return this.page.locator(`[${HANDLE_ATTR}="${handle}"]`);
  }
}

function normalizeType(tag: string, type: string): FieldType {
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  switch (type) {
    case 'text':
    case 'email':
    case 'tel':
    case 'url':
    case 'number':
    case 'date':
    case 'checkbox':
    case 'radio':
    case 'file':
      return type;
    default:
      return 'other';
  }
}

/** The label a human reads next to one radio button. */
async function radioLabel(radio: {
  getAttribute(name: string): Promise<string | null>;
  evaluate<R>(fn: (node: unknown) => R): Promise<R>;
}): Promise<string> {
  const aria = await radio.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  return radio.evaluate((node) => {
    const el = node as {
      id: string;
      closest(selector: string): { textContent: string | null } | null;
      ownerDocument: {
        querySelector(selector: string): { textContent: string | null } | null;
      };
      getAttribute(name: string): string | null;
    };
    const clean = (value: string | null | undefined) =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    if (el.id) {
      const tied = el.ownerDocument.querySelector(
        `label[for="${el.id.replace(/"/g, '\\"')}"]`,
      );
      if (tied) return clean(tied.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    return clean(el.getAttribute('value'));
  });
}

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
function cssQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
