/**
 * The description pipeline, tested on the shapes that actually broke things.
 *
 * `descriptionText` is the only thing scoring reads, so a bug here is not cosmetic -
 * it is the difference between the matcher seeing a job's requirements and seeing
 * `<div>` soup or, worse, a truncated fragment that reads as a complete posting.
 */
import { decodeEntities, decodeGreenhouseContent, htmlToText } from './html';

describe('decodeEntities', () => {
  it('handles named, decimal and hex forms', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&#8377;25 LPA')).toBe('₹25 LPA');
    expect(decodeEntities('&#x20B9;25')).toBe('₹25');
  });

  it('decodes ONCE, so double-escaped markup does not become a tag', () => {
    // A web-developer posting discussing a script tag writes `&amp;lt;script&gt;`.
    // Looping until the string stopped changing would turn that into a real tag on
    // the second pass - a decoder an input can steer.
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('leaves an unknown entity visible rather than dropping it', () => {
    expect(decodeEntities('5 &widehat; 3')).toBe('5 &widehat; 3');
  });

  it('leaves out-of-range and surrogate code points alone', () => {
    // String.fromCodePoint throws on these. Returning the entity unchanged keeps one
    // malformed posting from ending a whole board's fetch.
    expect(decodeEntities('&#1114112;')).toBe('&#1114112;');
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#0;')).toBe('&#0;');
  });

  it('converts &nbsp; to a real space', () => {
    expect(decodeEntities('Senior&nbsp;Engineer')).toBe('Senior Engineer');
  });
});

describe('htmlToText', () => {
  it('keeps list items on separate lines', () => {
    // The load-bearing case. Flattened to one line, "Python Java Kubernetes" reads as
    // a single requirement instead of three, which changes what the matcher sees.
    const text = htmlToText(
      '<ul><li>Python</li><li>Java</li><li>Kubernetes</li></ul>',
    );
    expect(text).toBe('- Python\n- Java\n- Kubernetes');
  });

  it('preserves a paragraph break as a blank line and collapses runs of them', () => {
    // Two newlines, not one: `</p><p>` legitimately means a new paragraph, and a
    // blank line is how that reads. Six <br>s do not mean six blank lines though -
    // past two the extra newlines are tokens with no information in them.
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
    expect(htmlToText('<p>One</p><br><br><br><br><p>Two</p>')).toBe(
      'One\n\nTwo',
    );
  });

  it('removes script and style BODIES, not just their tags', () => {
    // Stripping tags first would leave the JavaScript behind as body text, and a
    // posting's analytics snippet would end up in what the LLM reads.
    expect(htmlToText('<p>Real</p><script>var x = "hire me";</script>')).toBe(
      'Real',
    );
    expect(htmlToText('<style>.a{color:red}</style><p>Real</p>')).toBe('Real');
  });

  it('drops the tail of an unclosed script rather than emitting it', () => {
    expect(htmlToText('<p>Real</p><script>var x = 1;')).toBe('Real');
  });

  it('strips comments, which sometimes hold internal notes', () => {
    const text = htmlToText('<p>A</p><!-- internal req id 4471 --><p>B</p>');
    expect(text).toBe('A\n\nB');
    expect(text).not.toContain('4471');
  });

  it('does not let a malformed tag swallow the document', () => {
    // `[^>]*` rather than `.*` in the tag pattern is what makes this hold.
    expect(htmlToText('<p>Before</p><a href="x">link</a>')).toContain('Before');
    expect(htmlToText('<p>Before</p><a href="x">link</a>')).toContain('link');
  });

  it('normalises non-breaking and zero-width spaces', () => {
    // Escapes, not the characters: a literal zero-width space in a test is
    // invisible to whoever reads the assertion next.
    expect(htmlToText('<p>Senior\u00a0Engineer\u200b</p>')).toBe(
      'Senior Engineer',
    );
  });

  it('returns empty string for empty input rather than throwing', () => {
    expect(htmlToText('')).toBe('');
  });

  it('keeps text the employer escaped on purpose', () => {
    // Entities are decoded AFTER tags are stripped, so a `&lt;b&gt;` written as
    // visible prose survives instead of becoming a tag that then gets eaten along
    // with the words around it.
    expect(htmlToText('<p>Use &lt;b&gt; for bold</p>')).toBe(
      'Use <b> for bold',
    );
  });
});

describe('decodeGreenhouseContent', () => {
  it('turns the escaped payload into real HTML', () => {
    // Greenhouse genuinely returns this. Fed straight to htmlToText it would yield
    // the literal text "<p>About the role</p>" with the angle brackets intact.
    expect(decodeGreenhouseContent('&lt;p&gt;About the role&lt;/p&gt;')).toBe(
      '<p>About the role</p>',
    );
  });

  it('composes with htmlToText to give clean prose', () => {
    expect(
      htmlToText(
        decodeGreenhouseContent(
          '&lt;p&gt;We need:&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Node&lt;/li&gt;&lt;li&gt;SQL&lt;/li&gt;&lt;/ul&gt;',
        ),
      ),
    ).toBe('We need:\n- Node\n- SQL');
  });

  it('tolerates a missing body', () => {
    expect(decodeGreenhouseContent('')).toBe('');
  });
});
