/**
 * The number extractor, tested on the digits that are NOT quantities.
 *
 * `metrics` is not a display field. Phase 5's provenance guard uses it as the
 * complete list of figures a rewritten bullet is permitted to contain, so every
 * false positive here is a number the model is licensed to put on a real resume,
 * and every false negative is an honest achievement the guard will reject.
 *
 * Both sides of that comparison run through this file, which is why
 * `supportsNumber` lives here rather than in the guard: two functions with two
 * notions of "the same number" would drift, and the drift would be invisible.
 */
import { metricsIn, numbersIn, supportsNumber } from './numbers';

describe('numbersIn', () => {
  it('reads a percentage, a count and a decimal', () => {
    expect(metricsIn('reducing hallucinations by 65%')).toEqual(['65%']);
    expect(metricsIn('indexing of 10,000+ documents')).toEqual(['10,000+']);
    expect(metricsIn('with 99.9% data accuracy')).toEqual(['99.9%']);
    expect(metricsIn('8.61 CGPA')).toEqual(['8.61']);
  });

  it('applies a K/M/B suffix to the value', () => {
    const [ten] = numbersIn('handle 10K+ CSV records daily');
    expect(ten).toMatchObject({ surface: '10K+', value: 10_000, atLeast: true });
    expect(numbersIn('2.5M requests')[0].value).toBe(2_500_000);
  });

  it('ignores digits that are part of a name', () => {
    // Every one of these is a real resume string, and every one of them would be
    // an invented metric the guard then permits. HL7 is the load-bearing case:
    // this candidate's resume contains it, so a `\d+` scan would put "7" in that
    // bullet's metrics and let a rewrite claim any 7 it liked.
    expect(metricsIn('using HL7/FHIR standards')).toEqual([]);
    expect(metricsIn('stored objects in S3 and ran on EC2')).toEqual([]);
    expect(metricsIn('patched Log4j')).toEqual([]);
    expect(metricsIn('trained on H100s')).toEqual([]);
  });

  it('does not split a version into three numbers', () => {
    // The `(?<!...\.)` guard. Without it "v1.2.3" yields 1.2 and 3, and the 3 is
    // then a figure a rewrite may use.
    expect(metricsIn('upgraded to v1.2.3')).toEqual([]);
    expect(metricsIn('OAuth 2.0 flows')).toEqual(['2.0']);
  });

  it('keeps a year, because a year is genuinely in the text', () => {
    // Not filtered. The guard's question is "did this figure come from the atom",
    // not "is this figure impressive" - and a rule that dropped four-digit numbers
    // would also drop "1,200 users" written without a separator.
    expect(metricsIn('shipped in 2024')).toEqual(['2024']);
  });

  it('deduplicates by surface form', () => {
    expect(metricsIn('cut latency 40% and cost 40%')).toEqual(['40%']);
  });

  it('distinguishes a percentage from a multiplier from a bare count', () => {
    expect(numbersIn('3x faster')[0]).toMatchObject({ value: 3, unit: 'x' });
    expect(numbersIn('3% faster')[0]).toMatchObject({ value: 3, unit: '%' });
    expect(numbersIn('3 services')[0]).toMatchObject({ value: 3, unit: '' });
  });

  it('does not read the x in a word as a multiplier', () => {
    expect(numbersIn('4 xml feeds')[0].unit).toBe('');
  });

  it('finds nothing in text with no numbers', () => {
    expect(metricsIn('Led development of an enterprise platform')).toEqual([]);
    expect(metricsIn('')).toEqual([]);
  });
});

describe('supportsNumber', () => {
  const atom = numbersIn('cut latency 45% for 100K+ users, 8.61 CGPA');

  it('accepts a figure the atom states', () => {
    expect(supportsNumber(atom, numbersIn('45%')[0])).toBe(true);
  });

  it('rejects a figure the atom does not state', () => {
    // The whole point. A tailored bullet claiming 50% where the atom says 45% is
    // a fabricated credential, and it is the single most likely way for one to
    // appear - a model rounding to a nicer number.
    expect(supportsNumber(atom, numbersIn('50%')[0])).toBe(false);
  });

  it('rejects the right number with the wrong unit', () => {
    // "45% faster" and "45x faster" are different claims by a factor of 45.
    expect(supportsNumber(atom, numbersIn('45x')[0])).toBe(false);
    expect(supportsNumber(atom, numbersIn('45 deployments')[0])).toBe(false);
  });

  it('allows dropping a plus, which understates, but not adding one', () => {
    expect(supportsNumber(atom, numbersIn('100K')[0])).toBe(true);
    expect(supportsNumber(atom, numbersIn('8.61+')[0])).toBe(false);
  });

  it('compares by value, so 100K and 100,000 are the same claim', () => {
    // The reason both sides must use this file: the atom says "100K+" and a
    // rewrite may well spell it "100,000". A string comparison would reject an
    // honest rewrite and send the base resume instead.
    expect(supportsNumber(atom, numbersIn('100,000')[0])).toBe(true);
  });
});
