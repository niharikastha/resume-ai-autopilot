/**
 * The library's rules, in the order they matter.
 *
 * The two things worth testing here are not CRUD. They are:
 *
 *   1. A CLIENT CANNOT WIDEN WHAT TAILORING MAY CLAIM. Every atom that arrives has
 *      its tags derived from its own text, so a `tech` array sent from a browser goes
 *      nowhere. The provenance guard treats those tags as the complete list of
 *      technologies a rewrite is allowed to name, so a tag accepted here would be a
 *      permission granted to the model - and it would fail open, silently, on a real
 *      application.
 *   2. AN UPLOAD ID CANNOT NAME A FILE OUTSIDE ITS OWNER'S DIRECTORY. The id is
 *      resolved by regex and joined to a directory derived from the SESSION user, so
 *      the traversal is not merely rejected, it is not expressible.
 *
 * Then the selection rules, which are ordinary logic with an unpleasant failure
 * mode: a candidate left with no active resume gets a matching run that fails at
 * 07:00 with a message about a screen they were last on days ago.
 *
 * WHAT IS FAKED. Prisma is a hand-written stub, so nothing here checks SQL - most
 * importantly not the partial unique index that makes "one active per user" true.
 * What IS checked is the order of the two writes the service hands to
 * `$transaction`, because that order is the reason the index does not reject them.
 * The FILESYSTEM IS REAL, under a temp directory: the whole point of the upload
 * tests is which path gets written, and a mocked fs would assert on the mock.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { AtomKind } from '@prisma/client';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ResumeLibraryService, type AtomInput } from './resume-library.service';
import { ProfileIngestError } from './profile.service';
import type { ParsedProfile } from './parse';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

/** A parse result shaped like the real one, with nothing interesting in it. */
function parsed(overrides: Partial<ParsedProfile> = {}): ParsedProfile {
  return {
    fullName: 'Test Candidate',
    email: 'candidate@example.com',
    phone: null,
    location: null,
    linkedIn: null,
    github: null,
    portfolio: null,
    headline: null,
    atoms: [],
    warnings: [],
    ...overrides,
  };
}

interface FakeAtom {
  id: string;
  profileId: string;
  kind: AtomKind;
  text: string;
  tech: string[];
  metrics: string[];
  employer: string | null;
  dateRange: string | null;
  ordinal: number;
}

function atom(overrides: Partial<FakeAtom> = {}): FakeAtom {
  return {
    id: 'atom-1',
    profileId: 'profile-1',
    kind: AtomKind.BULLET,
    text: 'Improved ingestion throughput by 65% using Node.js worker threads.',
    tech: ['Node.js', 'Worker Threads'],
    metrics: ['65%'],
    employer: 'Merqube',
    dateRange: 'Jan 2024 - Present',
    ordinal: 3,
    ...overrides,
  };
}

interface FakeProfileRow {
  id: string;
  userId: string;
  label: string;
  isActive: boolean;
  confirmedAt: Date | null;
  sourceResumePath: string | null;
  sourceFilename: string | null;
  createdAt: Date;
  updatedAt: Date;
  fullName: string;
  email: string;
  atoms: { kind: AtomKind; tech: string[] }[];
  variants: number;
}

function profileRow(overrides: Partial<FakeProfileRow> = {}): FakeProfileRow {
  return {
    id: 'profile-1',
    userId: USER,
    label: 'primary',
    isActive: true,
    confirmedAt: new Date('2026-01-01'),
    sourceResumePath: null,
    sourceFilename: 'My Resume.pdf',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-02-01'),
    fullName: 'Test Candidate',
    email: 'candidate@example.com',
    atoms: [],
    variants: 0,
    ...overrides,
  };
}

/** Records every call in order, so the tests can assert on the query, not the answer. */
class FakePrisma {
  readonly calls: string[] = [];
  readonly args: Record<string, unknown[]> = {};

  constructor(
    private rows: FakeProfileRow[] = [profileRow()],
    private atomRows: FakeAtom[] = [],
  ) {}

  private record(name: string, arg: unknown) {
    this.calls.push(name);
    (this.args[name] ??= []).push(arg);
  }

  private withCount(row: FakeProfileRow) {
    return { ...row, _count: { resumeVariants: row.variants } };
  }

  candidateProfile = {
    findMany: (arg: unknown) => {
      this.record('profile.findMany', arg);
      return Promise.resolve(this.rows.map((r) => this.withCount(r)));
    },
    findFirst: (arg: {
      where: { id?: string; userId?: string; confirmedAt?: unknown };
    }) => {
      this.record('profile.findFirst', arg);
      const match = this.rows.find(
        (r) =>
          (arg.where.id === undefined || r.id === arg.where.id) &&
          (arg.where.userId === undefined || r.userId === arg.where.userId) &&
          (arg.where.confirmedAt === undefined || r.confirmedAt !== null),
      );
      return Promise.resolve(match ? this.withCount(match) : null);
    },
    count: (arg: { where: { isActive?: boolean; id?: { not: string } } }) => {
      this.record('profile.count', arg);
      return Promise.resolve(
        this.rows.filter(
          (r) =>
            r.isActive === (arg.where.isActive ?? r.isActive) &&
            r.id !== arg.where.id?.not,
        ).length,
      );
    },
    update: (arg: { where: { id: string }; data: Record<string, unknown> }) => {
      this.record('profile.update', arg);
      const row = this.rows.find((r) => r.id === arg.where.id);
      if (row) Object.assign(row, arg.data);
      return Promise.resolve(row);
    },
    updateMany: (arg: { where: unknown; data: Record<string, unknown> }) => {
      this.record('profile.updateMany', arg);
      for (const row of this.rows) if (row.isActive) row.isActive = false;
      return Promise.resolve({ count: 1 });
    },
    delete: (arg: { where: { id: string } }) => {
      this.record('profile.delete', arg);
      this.rows = this.rows.filter((r) => r.id !== arg.where.id);
      return Promise.resolve({ id: arg.where.id });
    },
  };

  profileAtom = {
    findMany: (arg: unknown) => {
      this.record('atom.findMany', arg);
      return Promise.resolve(this.atomRows);
    },
    findFirst: (arg: {
      where: { id?: string; profileId?: string };
      orderBy?: unknown;
    }) => {
      this.record('atom.findFirst', arg);
      const pool = this.atomRows.filter(
        (a) =>
          (arg.where.id === undefined || a.id === arg.where.id) &&
          (arg.where.profileId === undefined ||
            a.profileId === arg.where.profileId),
      );
      // `orderBy: { ordinal: 'desc' }` is how the append finds the last one, so the
      // stub has to honour it or every added atom would land on ordinal 1.
      if (arg.orderBy) {
        return Promise.resolve(
          [...pool].sort((a, b) => b.ordinal - a.ordinal)[0] ?? null,
        );
      }
      return Promise.resolve(pool[0] ?? null);
    },
    create: (arg: { data: Record<string, unknown> }) => {
      this.record('atom.create', arg);
      return Promise.resolve({ id: 'atom-new', ...arg.data });
    },
    update: (arg: { where: { id: string }; data: Record<string, unknown> }) => {
      this.record('atom.update', arg);
      const row = this.atomRows.find((a) => a.id === arg.where.id);
      return Promise.resolve({ ...row, ...arg.data });
    },
    deleteMany: (arg: { where: { id: string; profileId: string } }) => {
      this.record('atom.deleteMany', arg);
      const before = this.atomRows.length;
      this.atomRows = this.atomRows.filter(
        (a) => !(a.id === arg.where.id && a.profileId === arg.where.profileId),
      );
      return Promise.resolve({ count: before - this.atomRows.length });
    },
  };

  /**
   * The stub runs its operations eagerly, so by the time this is called both writes
   * have already happened. That is fine for what the test is for: what is asserted
   * is the ORDER OF THE ARRAY the service built, and in real Prisma that array order
   * is exactly what decides which statement runs first.
   */
  $transaction(ops: unknown[]) {
    this.record('$transaction', ops.length);
    return Promise.all(ops as Promise<unknown>[]);
  }
}

class FakeProfiles {
  readonly committed: {
    userId: string;
    label: string;
    atoms: { text: string; tech: string[] }[];
  }[] = [];
  readonly embedded: string[] = [];
  previewed: string[] = [];

  constructor(
    private readonly onPreview: (path: string) => ParsedProfile = () =>
      parsed(),
    private readonly onCommit: () => void = () => undefined,
  ) {}

  async preview(path: string) {
    this.previewed.push(path);
    const p = this.onPreview(path);
    // The real preview extracts the text of the file it was handed. Reading the
    // bytes back is the cheapest way for the fake to do the same thing, and it
    // means the text in the upload response is provably the file's own.
    const text = await readFile(path, 'utf8');
    return {
      parsed: p,
      text,
      resumePath: path,
      counts: {
        [AtomKind.BULLET]: 0,
        [AtomKind.SKILL]: 0,
        [AtomKind.ROLE]: 0,
        [AtomKind.EDU]: 0,
      },
      techUnion: [],
    };
  }

  commit(input: {
    userId: string;
    label: string;
    preview: { parsed: ParsedProfile };
  }) {
    this.onCommit();
    this.committed.push({
      userId: input.userId,
      label: input.label,
      atoms: input.preview.parsed.atoms,
    });
    return Promise.resolve({ profileId: 'profile-new', atomCount: 1 });
  }

  embedProfile(profileId: string) {
    this.embedded.push(profileId);
    return Promise.resolve();
  }
}

function build(options: {
  dir: string;
  rows?: FakeProfileRow[];
  atoms?: FakeAtom[];
  profiles?: FakeProfiles;
}) {
  const prisma = new FakePrisma(options.rows, options.atoms);
  const profiles = options.profiles ?? new FakeProfiles();
  const config = { get: () => options.dir };
  const service = new ResumeLibraryService(
    prisma as never,
    profiles as never,
    config as never,
  );
  return { service, prisma, profiles };
}

function file(name: string, body = 'Test Candidate\ncandidate@example.com\n') {
  const buffer = Buffer.from(body, 'utf8');
  return { originalname: name, buffer, size: buffer.length };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'resume-library-spec-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('upload', () => {
  it('writes the file under the session user, named from a uuid and never from the upload', async () => {
    const { service, profiles } = build({ dir });

    const result = await service.upload(USER, file('My Résumé (final).PDF'));

    // The extension came from the allowlist, lowercased. The BASENAME came from
    // randomUUID, so no part of the stored path is caller-controlled.
    expect(result.uploadId).toMatch(
      /^[0-9a-f-]{36}\.pdf$/, // a uuid plus an allowed extension, nothing else
    );
    const written = await readdir(join(dir, USER));
    expect(written).toEqual([result.uploadId]);
    expect(profiles.previewed).toEqual([join(dir, USER, result.uploadId)]);

    // The original name survives for display only, and is not a path.
    expect(result.filename).toBe('My Résumé (final).PDF');
  });

  it('keeps one user out of another user’s directory', async () => {
    const { service } = build({ dir });

    const mine = await service.upload(USER, file('a.txt'));
    await service.upload(OTHER_USER, file('b.txt'));

    expect(await readdir(join(dir, USER))).toEqual([mine.uploadId]);
    expect(await readdir(join(dir, OTHER_USER))).toHaveLength(1);
    expect(await readdir(join(dir, OTHER_USER))).not.toContain(mine.uploadId);
  });

  it('strips slashes and control characters from the displayed name', async () => {
    const { service } = build({ dir });

    // Escaped, not literal: a control character typed into a source file makes
    // the whole file read as binary to grep, which is the fourth time this
    // project has lost time to an invisible byte.
    const nasty = '../../etc/pa\u001fss\u007fwd.txt';
    const result = await service.upload(USER, file(nasty));

    expect(result.filename).toBe('....etcpasswd.txt');
    expect(result.filename).not.toContain('/');
  });

  it('refuses a file it cannot read, before writing anything', async () => {
    const { service } = build({ dir });

    await expect(service.upload(USER, file('resume.docx'))).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
    // Nothing was written, so a rejected upload leaves no orphan on disk.
    await expect(readdir(join(dir, USER))).rejects.toThrow();
  });

  it('refuses an empty file and one over the cap', async () => {
    const { service } = build({ dir });

    const empty = { originalname: 'r.txt', buffer: Buffer.alloc(0), size: 0 };
    await expect(service.upload(USER, empty)).rejects.toThrow(
      BadRequestException,
    );

    const big = {
      originalname: 'r.pdf',
      buffer: Buffer.alloc(8),
      size: 6 * 1024 * 1024,
    };
    await expect(service.upload(USER, big)).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('reports a parse failure as bad input but keeps the file', async () => {
    const profiles = new FakeProfiles(() => {
      throw new ProfileIngestError('no text could be extracted');
    });
    const { service } = build({ dir, profiles });

    await expect(service.upload(USER, file('r.pdf'))).rejects.toThrow(
      /no text could be extracted/,
    );
    // Kept deliberately: the file that produced a bad parse is the input worth
    // having when the parser is being fixed.
    expect(await readdir(join(dir, USER))).toHaveLength(1);
  });
});

describe('create', () => {
  async function uploaded(service: ResumeLibraryService) {
    const result = await service.upload(USER, file('Resume 2026.txt'));
    return result.uploadId;
  }

  /** The row `commit` reports back, so `activate` afterwards has something to find. */
  const saved = () =>
    profileRow({ id: 'profile-new', label: 'primary', isActive: false });

  const contact = {
    fullName: 'Test Candidate',
    email: 'candidate@example.com',
    phone: null,
    location: null,
    linkedIn: null,
    github: null,
    portfolio: null,
  };

  it('derives every tag from the text, and over-posted tags are inert', async () => {
    const { service, profiles } = build({ dir, rows: [saved()] });
    const uploadId = await uploaded(service);

    // `AtomInput` HAS NO `tech` FIELD, so this is what a client over-posting one
    // looks like from the service's side: an extra property on the body. The cast
    // is the test - it asserts the field cannot be routed anywhere even when it
    // arrives, because `retagAtom` would have unioned it with the derived tags and
    // licensed tailoring to claim Kubernetes on a real application.
    const atoms = [
      {
        kind: AtomKind.BULLET,
        text: 'Built a Node.js service backed by PostgreSQL.',
        tech: ['Kubernetes', 'Kafka'],
      } as unknown as AtomInput,
    ];

    await service.create(USER, {
      label: 'primary',
      uploadId,
      filename: 'Resume 2026.txt',
      contact,
      atoms,
    });

    const sent = profiles.committed[0].atoms;
    expect(sent).toHaveLength(1);
    expect(sent[0].tech).toEqual(
      expect.arrayContaining(['Node.js', 'PostgreSQL']),
    );
    expect(sent[0].tech).not.toContain('Kubernetes');
    expect(sent[0].tech).not.toContain('Kafka');
  });

  it('refuses an upload id it did not issue', async () => {
    const { service } = build({ dir, rows: [] });

    await expect(
      service.create(USER, {
        label: 'primary',
        uploadId: '../../../etc/passwd',
        contact,
        atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
      }),
    ).rejects.toThrow(BadRequestException);

    // A real uuid with the wrong extension is refused for the same reason: the
    // shape is the whole check, so there is no "close enough".
    await expect(
      service.create(USER, {
        label: 'primary',
        uploadId: '11111111-1111-4111-8111-111111111111.docx',
        contact,
        atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('stores the uploaded name for display, not the uuid', async () => {
    const { service, prisma } = build({ dir, rows: [saved()] });
    const uploadId = await uploaded(service);

    await service.create(USER, {
      label: 'primary',
      uploadId,
      filename: 'Resume 2026.txt',
      contact,
      atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
    });

    const update = prisma.args['profile.update'][0] as {
      data: { sourceFilename: string };
    };
    expect(update.data.sourceFilename).toBe('Resume 2026.txt');
    expect(update.data.sourceFilename).not.toContain(uploadId);
  });

  it('falls back to the label when no filename comes back', async () => {
    const { service, prisma } = build({ dir, rows: [saved()] });
    const uploadId = await uploaded(service);

    await service.create(USER, {
      label: 'ml-roles',
      uploadId,
      contact,
      atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
    });

    expect(
      (prisma.args['profile.update'][0] as { data: { sourceFilename: string } })
        .data.sourceFilename,
    ).toBe('ml-roles');
  });

  it('activates the first resume even when asked not to', async () => {
    // Nothing else is active, and a confirmed resume that nothing uses is a state
    // where every downstream screen is empty for a reason the candidate cannot see.
    const { service, prisma } = build({ dir, rows: [saved()] });
    const uploadId = await uploaded(service);

    const result = await service.create(USER, {
      label: 'primary',
      uploadId,
      contact,
      atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
      makeActive: false,
    });

    expect(result.isActive).toBe(true);
    expect(prisma.calls).toContain('$transaction');
  });

  it('leaves the current choice alone when asked not to activate', async () => {
    const { service, prisma } = build({
      dir,
      // An existing active resume, plus the row commit just wrote.
      rows: [profileRow({ id: 'profile-old', isActive: true }), saved()],
    });
    const uploadId = await uploaded(service);

    const result = await service.create(USER, {
      label: 'second',
      uploadId,
      contact,
      atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
      makeActive: false,
    });

    expect(result.isActive).toBe(false);
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('reports a label collision as a conflict and everything else as bad input', async () => {
    const conflicting = new FakeProfiles(
      () => parsed(),
      () => {
        throw new ProfileIngestError(
          'a resume variant already references these atoms',
        );
      },
    );
    const one = build({ dir, rows: [], profiles: conflicting });
    await expect(
      one.service.create(USER, {
        label: 'primary',
        uploadId: await uploaded(one.service),
        contact,
        atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
      }),
    ).rejects.toThrow(ConflictException);

    const other = build({
      dir,
      rows: [],
      profiles: new FakeProfiles(
        () => parsed(),
        () => {
          throw new ProfileIngestError('no email address was found');
        },
      ),
    });
    await expect(
      other.service.create(USER, {
        label: 'primary',
        uploadId: await uploaded(other.service),
        contact,
        atoms: [{ kind: AtomKind.SKILL, text: 'Go' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('choosing which resume is used', () => {
  it('clears every other resume before setting this one, in one transaction', async () => {
    const { service, prisma } = build({
      dir,
      rows: [profileRow({ id: 'profile-1', isActive: false })],
    });

    await service.activate(USER, 'profile-1');

    // Order matters and is not cosmetic: the partial unique index would reject the
    // new row while the old one is still true, so the clear has to be first.
    const writes = prisma.calls.filter((c) => c.startsWith('profile.update'));
    expect(writes).toEqual(['profile.updateMany', 'profile.update']);
    expect(prisma.calls).toContain('$transaction');
  });

  it('refuses a resume that was never confirmed', async () => {
    const { service } = build({
      dir,
      rows: [profileRow({ confirmedAt: null, isActive: false })],
    });

    await expect(service.activate(USER, 'profile-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('cannot see another account’s resume at all', async () => {
    const { service } = build({
      dir,
      rows: [profileRow({ id: 'profile-1', userId: OTHER_USER })],
    });

    // Not 403. A resume belonging to somebody else is indistinguishable from one
    // that does not exist, which is what stops the id being an oracle.
    await expect(service.activate(USER, 'profile-1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.atoms(USER, 'profile-1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.rename(USER, 'profile-1', 'mine')).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.remove(USER, 'profile-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('remove', () => {
  it('refuses while tailored resumes were built from it, unless forced', async () => {
    const { service } = build({
      dir,
      rows: [profileRow({ variants: 3, isActive: false })],
    });

    await expect(service.remove(USER, 'profile-1')).rejects.toThrow(
      ConflictException,
    );
    await expect(service.remove(USER, 'profile-1', true)).resolves.toEqual({
      promoted: null,
    });
  });

  it('promotes the next resume when the active one goes', async () => {
    const { service, prisma } = build({
      dir,
      rows: [
        profileRow({ id: 'profile-1', isActive: true }),
        profileRow({ id: 'profile-2', isActive: false }),
      ],
    });

    const result = await service.remove(USER, 'profile-1');

    expect(result.promoted).toBe('profile-2');
    expect(prisma.calls).toContain('$transaction');
  });

  it('promotes nothing when the deleted resume was not the one in use', async () => {
    const { service, prisma } = build({
      dir,
      rows: [
        profileRow({ id: 'profile-1', isActive: true }),
        profileRow({ id: 'profile-2', isActive: false }),
      ],
    });

    expect(await service.remove(USER, 'profile-2')).toEqual({ promoted: null });
    expect(prisma.calls).not.toContain('$transaction');
  });

  it('deletes the row even when the uploaded file cannot be removed', async () => {
    const { service, prisma } = build({
      dir,
      rows: [
        profileRow({
          isActive: false,
          sourceResumePath: join(dir, 'gone', 'never-existed.pdf'),
        }),
      ],
    });

    await expect(service.remove(USER, 'profile-1')).resolves.toEqual({
      promoted: null,
    });
    expect(prisma.calls).toContain('profile.delete');
  });
});

describe('editing the pieces', () => {
  it('re-tags from the new words and re-embeds when the text changed', async () => {
    const { service, prisma, profiles } = build({
      dir,
      atoms: [atom()],
    });

    await service.updateAtom(USER, 'profile-1', 'atom-1', {
      text: 'Cut latency 38% by adding a Django cache in front of PostgreSQL.',
    });

    const write = prisma.args['atom.update'][0] as {
      data: { tech: string[]; metrics: string[] };
    };
    // The old tags described the old sentence. Keeping them would leave the guard
    // checking a rewrite against facts that are no longer in the atom.
    expect(write.data.tech).toEqual(
      expect.arrayContaining(['Django', 'PostgreSQL']),
    );
    expect(write.data.tech).not.toContain('Worker Threads');
    expect(write.data.metrics).toEqual(['38%']);
    expect(profiles.embedded).toEqual(['profile-1']);
  });

  it('does not re-embed when only the employer or the dates changed', async () => {
    const { service, profiles } = build({ dir, atoms: [atom()] });

    await service.updateAtom(USER, 'profile-1', 'atom-1', {
      employer: 'Merqube Technologies',
    });

    // The vector is over the text. Re-embedding on a date correction would be a
    // model call, a write and a centroid recompute for no change in meaning.
    expect(profiles.embedded).toEqual([]);
  });

  it('refuses to empty a piece', async () => {
    const { service } = build({ dir, atoms: [atom()] });

    await expect(
      service.updateAtom(USER, 'profile-1', 'atom-1', { text: '   ' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('appends a new piece after the last one', async () => {
    const { service, prisma, profiles } = build({
      dir,
      atoms: [
        atom({ id: 'atom-1', ordinal: 0 }),
        atom({ id: 'atom-2', ordinal: 7 }),
      ],
    });

    await service.addAtom(USER, 'profile-1', {
      kind: AtomKind.SKILL,
      text: 'Terraform',
    });

    const created = prisma.args['atom.create'][0] as {
      data: { ordinal: number; tech: string[] };
    };
    expect(created.data.ordinal).toBe(8);
    expect(created.data.tech).toContain('Terraform');
    expect(profiles.embedded).toEqual(['profile-1']);
  });

  it('starts at zero on a resume with no pieces', async () => {
    const { service, prisma } = build({ dir, atoms: [] });

    await service.addAtom(USER, 'profile-1', {
      kind: AtomKind.SKILL,
      text: 'Go',
    });

    expect(
      (prisma.args['atom.create'][0] as { data: { ordinal: number } }).data
        .ordinal,
    ).toBe(0);
  });

  it('will not reach a piece belonging to a different resume', async () => {
    const { service } = build({
      dir,
      atoms: [atom({ id: 'atom-1', profileId: 'profile-other' })],
    });

    await expect(
      service.updateAtom(USER, 'profile-1', 'atom-1', { text: 'anything' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.deleteAtom(USER, 'profile-1', 'atom-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('re-embeds after a deletion, because the profile centroid moves', async () => {
    const { service, profiles } = build({ dir, atoms: [atom()] });

    await service.deleteAtom(USER, 'profile-1', 'atom-1');

    expect(profiles.embedded).toEqual(['profile-1']);
  });
});

describe('list', () => {
  it('counts the pieces by kind and the technologies once each', async () => {
    const { service, prisma } = build({
      dir,
      rows: [
        profileRow({
          variants: 2,
          atoms: [
            { kind: AtomKind.BULLET, tech: ['Node.js', 'Redis'] },
            { kind: AtomKind.BULLET, tech: ['Node.js'] },
            { kind: AtomKind.SKILL, tech: ['Docker'] },
          ],
        }),
      ],
    });

    const [row] = await service.list(USER);

    expect(row.counts).toEqual({ BULLET: 2, SKILL: 1, ROLE: 0, EDU: 0 });
    expect(row.atomCount).toBe(3);
    // Node.js appears twice and counts once - this number answers "how much does
    // tailoring have to work with", not "how many tags are stored".
    expect(row.techCount).toBe(3);
    expect(row.variantCount).toBe(2);
    expect(row.filename).toBe('My Resume.pdf');

    // The one in use has to be first, or a candidate with five resumes has to hunt
    // for the answer to the only question this screen exists to answer.
    expect(prisma.args['profile.findMany'][0]).toMatchObject({
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    });
  });
});

describe('the stored file', () => {
  it('is written with owner-only permissions', async () => {
    const { service } = build({ dir });
    const result = await service.upload(USER, file('r.txt'));

    // A whole resume carries a name, a phone number and an address. 0600/0700 is
    // not paranoia on a shared box, it is the difference between that file being
    // readable by every account on the machine and not.
    const { stat } = await import('fs/promises');
    const fileMode =
      (await stat(join(dir, USER, result.uploadId))).mode & 0o777;
    const dirMode = (await stat(join(dir, USER))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);

    expect(
      (await readFile(join(dir, USER, result.uploadId), 'utf8')).length,
    ).toBeGreaterThan(0);
  });
});

describe('the text read out of the file', () => {
  it('comes back with the preview, whole', async () => {
    const { service } = build({ dir });
    const body =
      'Astha Niharika\nastha@example.com\n\nEXPERIENCE\n- did a thing\n';
    const result = await service.upload(USER, file('r.txt', body));

    // Sent so the confirmation screen can show it. Everything else in the response
    // is derived from these words, and a missing bullet means one of two different
    // things depending on whether the words are here - see ExtractedText.
    expect(result.extracted.text).toBe(body);
    expect(result.extracted.chars).toBe(body.length);
    expect(result.extracted.truncated).toBe(false);
  });

  it('is cut short, and says so, when a file extracts to more than the cap', async () => {
    const { service } = build({ dir });
    // 80_001 characters: one past MAX_EXTRACTED_CHARS, which is the only boundary
    // worth a test. No real resume reaches it; a pdf of dense text can.
    const body = 'x'.repeat(80_001);
    const result = await service.upload(USER, file('r.txt', body));

    expect(result.extracted.text).toHaveLength(80_000);
    // The TRUE length, not the length of what was sent, so the screen can say how
    // much it is not showing rather than appearing to end mid-resume.
    expect(result.extracted.chars).toBe(80_001);
    expect(result.extracted.truncated).toBe(true);
  });

  it('is empty rather than absent when a file gives up no text at all', async () => {
    // What a scanned pdf does: it is a picture of a page, so there is nothing to
    // extract. The screen says so out loud, because the pieces below will be empty
    // and no amount of correcting them will help.
    const { service } = build({ dir });
    const result = await service.upload(USER, file('r.txt', ' '));

    expect(result.extracted.text).toBe(' ');
    expect(result.extracted.truncated).toBe(false);
  });
});
