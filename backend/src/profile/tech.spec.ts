/**
 * Tests for the tech dictionary.
 *
 * Written when phase 5's provenance guard started depending on `techIn` for
 * CORRECTNESS rather than for convenience. Ingestion can afford a missed tag - the
 * candidate loses a word on their resume. The guard cannot: it asks this function
 * what technologies a rewritten bullet names, and a name it fails to report is a
 * fabricated skill that reaches an employer.
 *
 * The boundary cases below are therefore the point of the file, and the
 * sentence-final ones are a regression test - `techIn('...on Kafka.')` returned an
 * empty array, which defeated the guard's headline example.
 */
import { canonicalise, knownTech, splitTechList, techIn } from './tech';

describe('techIn', () => {
  it('finds a technology in the middle of a sentence', () => {
    expect(techIn('Built the ingestion pipeline with Node.js')).toContain('Node.js');
  });

  it('finds a technology at the END of a sentence', () => {
    // The regression. A flat ban on a following dot made every sentence-final
    // technology invisible.
    expect(techIn('Deployed the service with Docker.')).toEqual(['Docker']);
    expect(techIn('Built the pipeline on Kafka.')).toEqual(['Kafka']);
  });

  it('finds one before a comma, a semicolon and a closing bracket', () => {
    expect(techIn('Used Redis, then Kafka; also (Docker)')).toEqual([
      'Redis',
      'Kafka',
      'Docker',
    ]);
  });

  it('still does not tag plain React inside React.js', () => {
    // The reason the dot exclusion exists at all. React.js is the canonical name;
    // the danger was tagging a bare "React" from text that said "React.js".
    expect(techIn('Wrote the UI in React.js')).toEqual(['React.js']);
  });

  it('does not match inside a dotted name that is not a technology', () => {
    expect(techIn('see jest.config for the setup')).toEqual([]);
    expect(techIn('docs at spring.io')).toEqual([]);
  });

  it('does not tag a language from a word that merely contains it', () => {
    expect(techIn('JavaScript')).toEqual(['JavaScript']);
    expect(techIn('JavaScript')).not.toContain('Java');
  });

  it('does not tag C from C++', () => {
    expect(techIn('Wrote it in C++')).toEqual(['C++']);
  });

  it('leaves the deliberately-omitted one-word names alone', () => {
    // Documented in the dictionary: bare "Go" is a common English word, and
    // "Go to market" must not tag a language.
    expect(techIn('Go to market strategy')).toEqual([]);
    expect(techIn('C level stakeholders')).toEqual([]);
  });

  it('returns dictionary order, not text order', () => {
    // So that re-ingesting a profile produces a byte-identical tag array and a diff
    // shows only real changes.
    expect(techIn('Kubernetes and Kafka')).toEqual(techIn('Kafka and Kubernetes'));
  });

  it('is case insensitive and returns the canonical spelling', () => {
    expect(techIn('mongodb and POSTGRES')).toEqual(['PostgreSQL', 'MongoDB']);
  });
});

describe('canonicalise', () => {
  it('maps an alias to the canonical spelling', () => {
    expect(canonicalise('nodejs')).toBe('Node.js');
    expect(canonicalise('k8s')).toBe('Kubernetes');
  });

  it('returns an unknown skill unchanged rather than dropping it', () => {
    // A SkillsReserve entry the dictionary has not heard of is still a real skill,
    // and the guard compares against it as a string.
    expect(canonicalise('Docling')).toBe('Docling');
  });
});

describe('splitTechList', () => {
  it('drops the label and keeps the items', () => {
    expect(splitTechList('Tech Stack: Node.js, MongoDb, PostgreSQL')).toEqual([
      'Node.js',
      'MongoDB',
      'PostgreSQL',
    ]);
  });

  it('keeps an item the dictionary does not know, verbatim', () => {
    expect(splitTechList('Tools: Docling, pgvector')).toEqual([
      'Docling',
      'pgvector',
    ]);
  });
});

describe('the dictionary itself', () => {
  it('has no duplicate canonical names', () => {
    const names = knownTech();
    expect(new Set(names).size).toBe(names.length);
  });
});
