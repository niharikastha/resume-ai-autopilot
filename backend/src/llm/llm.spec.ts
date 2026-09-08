/**
 * The LLM boundary, tested without spending anything.
 *
 * Two groups of tests, and both are about failures that produce no error message on
 * their own.
 *
 * THE CACHE CONTRACT. `prefix(shared)` is sent on every request in a run and paid
 * for once - IF it is byte-identical every time. If it is not, everything still
 * works, every answer is still correct, and the bill is roughly 10x. There is no
 * exception, no warning and no wrong output to notice. So the properties are
 * asserted here: the prefix depends only on `shared`, it is stable across calls, and
 * the varying part of the prompt does not leak into it.
 *
 * THE SCHEMA BOUNDARY. The task schemas are the only definition of what a valid
 * score is, and they are what stands between a model's output and a database row.
 * A `score: 150` that Zod lets through becomes a posting ranked above every real
 * match, forever, with nothing in the logs.
 *
 * Nothing here calls the API. The one thing that cannot be tested without a key is
 * whether a real model satisfies these schemas - that is the cross-provider golden
 * set, PLAN-v2's fourth anti-drift defense, and it needs both providers and two
 * live keys.
 */
import { ConfigService } from '@nestjs/config';
import { ClaudeProvider, jsonSchemaOf } from './claude.provider';
import { LlmError } from './llm.types';
import {
  ScoreJobInput,
  ScoreJobOutputSchema,
  ScoreJobShared,
  scoreJobTask,
} from './tasks/score-job.task';
import {
  TailorOutputSchema,
  TailorShared,
  tailorResumeTask,
} from './tasks/tailor-resume.task';

/** A config that reports whatever the test puts in the map, and nothing else. */
function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function shared(): ScoreJobShared {
  return {
    candidateYears: 2,
    headline: 'Backend engineer',
    atoms: [
      {
        kind: 'BULLET',
        text: 'Cut p99 latency by 65% by batching writes.',
        tech: ['postgres', 'node.js'],
        employer: 'Acme',
      },
      { kind: 'SKILL', text: 'TypeScript, Python', tech: ['typescript'] },
    ],
    tech: ['node.js', 'postgres', 'typescript'],
  };
}

function job(overrides: Partial<ScoreJobInput> = {}): ScoreJobInput {
  return {
    title: 'Backend Engineer',
    company: 'Databricks',
    location: 'Bengaluru',
    description: 'Build data pipelines. 2-4 years. Python, Postgres.',
    ...overrides,
  };
}

describe('the cached prefix', () => {
  it('is byte-identical for two equal-but-distinct shared objects', () => {
    // The realistic failure: the profile is re-read from the database between two
    // scoring runs, producing a new object with the same contents. If anything in
    // prefix() depended on identity, ordering of a Map, or a Date, this is where it
    // shows up - and nowhere else, ever.
    expect(scoreJobTask.prefix(shared())).toBe(scoreJobTask.prefix(shared()));
    expect(scoreJobTask.prefix(shared())).toBe(scoreJobTask.prefix(shared()));
  });

  it('does not vary with the posting', () => {
    // The whole point of the shared/input split. A prefix that mentioned the job
    // would be a cache that never hits.
    const a = scoreJobTask.prefix(shared());
    const b = scoreJobTask.prefix(shared());
    scoreJobTask.question(job({ title: 'Frontend Engineer' }));
    expect(a).toBe(b);
  });

  it('keeps the posting out of the prefix and the profile out of the question', () => {
    const prefix = scoreJobTask.prefix(shared());
    const question = scoreJobTask.question(job());

    expect(prefix).not.toContain('Databricks');
    expect(prefix).not.toContain('data pipelines');
    expect(question).not.toContain('p99 latency');
  });

  it('carries the profile facts the rubric refers to', () => {
    // A prefix that is stable but empty would pass every test above.
    const prefix = scoreJobTask.prefix(shared());
    expect(prefix).toContain('Cut p99 latency by 65% by batching writes.');
    expect(prefix).toContain('Years of professional experience: 2');
    expect(prefix).toContain('STRONG');
  });

  it('contains no digits that look like a clock', () => {
    // A timestamp is the classic silent invalidator. This will not catch every
    // possible one, but it catches the shape - an ISO date or a millisecond epoch -
    // that gets added by someone adding "as of <date>" to a prompt.
    const prefix = `${scoreJobTask.instruction}\n${scoreJobTask.prefix(shared())}`;
    expect(prefix).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(prefix).not.toMatch(/\b1[6-9]\d{11}\b/);
  });
});

describe('the tailoring prefix', () => {
  const profile: TailorShared = {
    fullName: 'A. Candidate',
    headline: null,
    atoms: [
      {
        id: 'atom-1',
        kind: 'BULLET',
        text: 'Cut p99 latency by 65%.',
        tech: ['postgres'],
        metrics: ['65%'],
        employer: 'Acme',
        dateRange: '2024-2025',
      },
    ],
    allowedTech: ['postgres', 'node.js'],
  };

  it('states the atom ids, because the output cites them', () => {
    // Rewrites are keyed by atom id. If the prompt showed positional numbers, the
    // ids in the response would be indices - and an atom added tomorrow would
    // silently re-point every stored rewrite at a different bullet.
    expect(tailorResumeTask.prefix(profile)).toContain('id: atom-1');
  });

  it('states the metrics and the allowed technologies verbatim', () => {
    // The three hard rules the provenance guard re-checks. The model cannot obey a
    // rule it was not shown the data for.
    const prefix = tailorResumeTask.prefix(profile);
    expect(prefix).toContain('metrics: 65%');
    expect(prefix).toContain('postgres, node.js');
    expect(prefix).toContain('employer: Acme');
  });

  it('is stable', () => {
    expect(tailorResumeTask.prefix(profile)).toBe(
      tailorResumeTask.prefix({ ...profile, atoms: [...profile.atoms] }),
    );
  });
});

describe('ScoreJobOutputSchema', () => {
  const valid = {
    score: 78,
    verdict: 'GOOD',
    reasons: ['Backend work matches', 'No Kafka experience'],
    missingSkills: ['kafka'],
    estimatedSalaryLPA: 18,
    salaryConfidence: 0.4,
  };

  it('accepts a well-formed score', () => {
    expect(ScoreJobOutputSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a null salary estimate with no confidence', () => {
    // The normal case for Indian postings (PLAN-v2 change 2: structured pay data
    // exists on 0.3% of them). This must not be the awkward path.
    expect(() =>
      ScoreJobOutputSchema.parse({
        ...valid,
        estimatedSalaryLPA: null,
        salaryConfidence: 0,
      }),
    ).not.toThrow();
  });

  it('rejects a score outside 0-100', () => {
    // Constrained decoding guarantees `number`, not `0 <= n <= 100`. A 150 would
    // rank above every real match and never be questioned again.
    expect(() =>
      ScoreJobOutputSchema.parse({ ...valid, score: 150 }),
    ).toThrow();
    expect(() => ScoreJobOutputSchema.parse({ ...valid, score: -1 })).toThrow();
  });

  it('rejects a non-integer score', () => {
    expect(() =>
      ScoreJobOutputSchema.parse({ ...valid, score: 78.5 }),
    ).toThrow();
  });

  it('rejects an unknown verdict', () => {
    // MatchVerdict is a Postgres enum. A verdict the database has never heard of
    // fails at INSERT with a message about an enum, three layers from the cause.
    expect(() =>
      ScoreJobOutputSchema.parse({ ...valid, verdict: 'EXCELLENT' }),
    ).toThrow();
  });

  it('rejects an empty reasons list', () => {
    // A score with no reasons is unreviewable, and reviewing them every morning is
    // the entire mechanism for noticing the scorer has drifted.
    expect(() =>
      ScoreJobOutputSchema.parse({ ...valid, reasons: [] }),
    ).toThrow();
  });

  it('rejects a missing field rather than defaulting it', () => {
    const { missingSkills, ...withoutSkills } = valid;
    void missingSkills;
    expect(() => ScoreJobOutputSchema.parse(withoutSkills)).toThrow();
  });

  it('rejects a confidence outside 0-1', () => {
    expect(() =>
      ScoreJobOutputSchema.parse({ ...valid, salaryConfidence: 40 }),
    ).toThrow();
  });
});

describe('TailorOutputSchema', () => {
  const valid = {
    selectedAtomIds: ['atom-1'],
    rewrites: [{ atomId: 'atom-1', text: 'Cut p99 latency by 65%.' }],
    headline: 'Backend engineer',
    coverLetter: '',
  };

  it('accepts a rewrite that cites an atom', () => {
    expect(TailorOutputSchema.parse(valid)).toEqual(valid);
  });

  it('accepts selection with no rewrite at all', () => {
    // Using an atom verbatim is the safest possible outcome and must not require
    // the model to restate it - a schema that forced a rewrite per selected atom
    // would be a schema that forced unnecessary paraphrasing.
    expect(() =>
      TailorOutputSchema.parse({ ...valid, rewrites: [] }),
    ).not.toThrow();
  });

  it('has no field in which an uncited bullet could arrive', () => {
    // Defense 1 of 3 (see the note on the task). A rewrite is {atomId, text}: there
    // is no shape this schema accepts that contains prose without an atom id.
    expect(() =>
      TailorOutputSchema.parse({
        ...valid,
        rewrites: [{ text: 'Led a team of 12 engineers.' }],
      }),
    ).toThrow();
  });

  it('rejects an empty selection', () => {
    expect(() =>
      TailorOutputSchema.parse({ ...valid, selectedAtomIds: [] }),
    ).toThrow();
  });
});

describe('ClaudeProvider', () => {
  it('maps tiers to the models the plan specifies', () => {
    const provider = new ClaudeProvider(config());
    // Haiku scores because scoring is high volume; Opus tailors because a bad
    // rewrite costs an application rather than a retry.
    expect(provider.modelFor('fast')).toBe('claude-haiku-4-5');
    expect(provider.modelFor('deep')).toBe('claude-opus-5');
    expect(scoreJobTask.tier).toBe('fast');
    expect(tailorResumeTask.tier).toBe('deep');
  });

  it('names the missing variable instead of failing with a 401', async () => {
    const provider = new ClaudeProvider(config());
    await expect(
      provider.complete(scoreJobTask, shared(), job()),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('does not construct a client at all for an empty batch', async () => {
    // Which is also the assertion that a scoring run with nothing left after stage 1
    // costs nothing and needs no credentials.
    const provider = new ClaudeProvider(config());
    await expect(
      provider.completeMany(scoreJobTask, shared(), []),
    ).resolves.toEqual(new Map());
  });

  it('refuses duplicate keys before spending anything', async () => {
    // Results are keyed, so a duplicate key silently drops one of the two postings.
    // Checked before the client is built, which is why this passes with no api key.
    const provider = new ClaudeProvider(config());
    await expect(
      provider.completeMany(scoreJobTask, shared(), [
        { key: 'job-1', input: job() },
        { key: 'job-1', input: job({ title: 'Other' }) },
      ]),
    ).rejects.toThrow(LlmError);
  });

  it('reports the provider id that MatchScore.llmProvider stores', () => {
    expect(new ClaudeProvider(config()).id).toBe('claude');
  });

  it('defaults to api-key mode when CLAUDE_AUTH_MODE is unset', () => {
    // The path with no AWS account in it. A default of bedrock would break every
    // existing install on upgrade.
    expect(new ClaudeProvider(config()).authMode()).toBe('api-key');
  });
});

/**
 * The Bedrock door.
 *
 * Everything here is what can be checked without an AWS account: which model id is
 * addressed, which variable is named when one is missing, and that the batch path is
 * refused rather than attempted. What is not testable here is model access - whether
 * this account may call these ids in this region - which is why the wrapped
 * BadRequestError names it first.
 */
describe('ClaudeProvider on Bedrock', () => {
  const bedrock = (extra: Record<string, string> = {}) =>
    new ClaudeProvider(
      config({
        CLAUDE_AUTH_MODE: 'bedrock',
        AWS_REGION: 'ap-south-1',
        ...extra,
      }),
    );

  it('addresses the same models behind the anthropic. prefix', () => {
    expect(bedrock().modelFor('deep')).toBe('anthropic.claude-opus-5');
    expect(bedrock().modelFor('fast')).toBe('anthropic.claude-haiku-4-5');
    // The region belongs to the client, not to the id. A geography prefix
    // (`apac.anthropic.…`) here would mean someone has reintroduced the legacy
    // InvokeModel path, which this provider deliberately does not use.
    expect(bedrock({ AWS_REGION: 'us-west-2' }).modelFor('fast')).toBe(
      'anthropic.claude-haiku-4-5',
    );
  });

  it('lets the env override the id, for the two things a prefix cannot express', () => {
    // A provisioned-throughput ARN, and pinning a dated snapshot in an account where
    // the alias is not what has been granted.
    const provider = bedrock({
      BEDROCK_MODEL_DEEP: 'arn:aws:bedrock:ap-south-1:1:provisioned-model/abc',
      BEDROCK_MODEL_FAST: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    expect(provider.modelFor('deep')).toBe(
      'arn:aws:bedrock:ap-south-1:1:provisioned-model/abc',
    );
    expect(provider.modelFor('fast')).toBe(
      'anthropic.claude-haiku-4-5-20251001-v1:0',
    );
  });

  it('does not consult ANTHROPIC_API_KEY at all', async () => {
    // The regression this guards: an api key left in .env from before the switch
    // must not make a bedrock run look configured.
    const provider = new ClaudeProvider(
      config({
        CLAUDE_AUTH_MODE: 'bedrock',
        ANTHROPIC_API_KEY: 'sk-ant-whatever',
      }),
    );
    expect(provider.bootNotes().join(' ')).toMatch(/AWS_REGION is unset/);
    await expect(
      provider.complete(scoreJobTask, shared(), job()),
    ).rejects.toThrow(/AWS_REGION is not set/);
  });

  it('refuses the batch path instead of attempting it', async () => {
    // Bedrock has no Batch API, and the Mantle client's types do not say so - it
    // exposes `messages.batches` like the direct one. So this test is the only thing
    // between `mode: 'batch'` and a 404, and it is refused with the reason rather than
    // downgraded silently: a caller who asked for half price should not have to read
    // the bill to find out they did not get it.
    await expect(
      bedrock().completeMany(
        scoreJobTask,
        shared(),
        [{ key: 'a', input: job() }],
        {
          mode: 'batch',
        },
      ),
    ).rejects.toThrow(/Batch API does not exist on Bedrock/);
  });

  it('refuses to resume a batch id it could never have issued', async () => {
    await expect(
      bedrock().completeMany(
        scoreJobTask,
        shared(),
        [{ key: 'a', input: job() }],
        {
          batchId: 'msgbatch_from_a_previous_life',
        },
      ),
    ).rejects.toThrow(/Batch API does not exist on Bedrock/);
  });

  it('says how the AWS credentials will be resolved', () => {
    // Leaning on the provider chain is a normal way to run on an EC2 instance role,
    // so it is a note rather than a warning - and the boot log is the only place
    // anyone finds out which of the three paths is in play.
    expect(bedrock().bootNotes().join(' ')).toMatch(/AWS provider chain/);
    expect(
      bedrock({ AWS_BEARER_TOKEN_BEDROCK: 'abc' }).bootNotes().join(' '),
    ).not.toMatch(/AWS provider chain/);
    expect(
      bedrock({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's' })
        .bootNotes()
        .join(' '),
    ).not.toMatch(/AWS provider chain/);
    // Half a static pair is not a credential. The SDK deprecates it and would sign
    // with something that cannot work.
    expect(
      bedrock({ AWS_ACCESS_KEY_ID: 'AKIA' }).bootNotes().join(' '),
    ).toMatch(/AWS provider chain/);
  });

  /**
   * The tool that replaces structured output there.
   *
   * Bedrock's Messages endpoint accepts neither `output_config.format` nor `strict`,
   * so the schema is sent as a forced tool call instead. Two properties of that
   * translation fail silently, which is why they are asserted here rather than left
   * to the live run: a tool block that is not byte-stable invalidates the profile
   * cache behind it on every request, and a schema whose constraints got dropped in
   * translation produces answers that are worse in a way no error reports.
   */
  describe('the schema as a tool', () => {
    it('is byte-identical every time it is derived', () => {
      // `tools` sits in front of `system` in the cache prefix, so a schema that
      // serialised differently between two calls of a run would cost ~10x with no
      // symptom other than the bill. This is the same hazard the prefix tests cover,
      // one field earlier in the request.
      expect(JSON.stringify(jsonSchemaOf(ScoreJobOutputSchema))).toBe(
        JSON.stringify(jsonSchemaOf(ScoreJobOutputSchema)),
      );
    });

    it('keeps the constraints as keywords the model can read', () => {
      // The reason this does not go through the SDK's `zodOutputFormat`: that helper
      // relocates every unsupported-by-the-decoder keyword into a description string.
      // A tool schema supports them, and `verdict` as a real enum of five values is
      // the difference between steering the model and describing the steering.
      const schema = jsonSchemaOf(ScoreJobOutputSchema);
      const props = schema.properties as Record<string, unknown>;
      expect(props.verdict).toMatchObject({
        enum: ['STRONG', 'GOOD', 'BORDERLINE', 'WEAK', 'REJECT'],
      });
      expect(props.score).toMatchObject({ minimum: 0, maximum: 100 });
      expect(schema.required).toContain('estimatedSalaryLPA');
    });

    it('is an object schema with nothing left to resolve', () => {
      // `type: 'object'` is asserted by a cast in the provider, and $refs would have
      // to be resolvable by the API rather than by us.
      const schema = jsonSchemaOf(TailorOutputSchema);
      expect(schema.type).toBe('object');
      expect(JSON.stringify(schema)).not.toContain('$ref');
      expect(JSON.stringify(schema)).not.toContain('$schema');
    });
  });

  it('says nothing at boot when the mode is fully configured', () => {
    // The counterpart to the warnings: a clean boot log means the region and the
    // credentials are both present, so anything that then fails is not configuration.
    expect(bedrock({ AWS_BEARER_TOKEN_BEDROCK: 'abc' }).bootNotes()).toEqual(
      [],
    );
  });
});
