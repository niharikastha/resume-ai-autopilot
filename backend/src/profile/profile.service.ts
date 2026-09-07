/**
 * Profile ingestion: resume file in, confirmed atoms and vectors out.
 *
 * The confirmation gate is the point of this file. PLAN-v2 phase 3 step 2 requires
 * a human to see the atoms before they land, and the reason is that EVERYTHING
 * downstream inherits them: matching embeds them, tailoring may draw from nothing
 * else, and the provenance guard treats them as ground truth. A parse that turned
 * "reducing hallucinations by 65%" into two fragments is not a display bug, it is
 * a wrong fact that a real resume then gets built on.
 *
 * So `preview` and `commit` are separate methods, and `commit` takes the atoms
 * `preview` produced rather than re-parsing. Nothing in this file writes without
 * having been handed a parse a human has already looked at.
 *
 * `confirmedAt` is set only in `commit`. A profile row with a null `confirmedAt`
 * is one nothing may use, and no code path here creates one - the column exists so
 * that a future upload-then-review flow in the web app can, with the same meaning.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AtomKind, Prisma } from '@prisma/client';
import { resolve } from 'path';
import {
  EMBEDDING_DIM,
  EmbeddingsService,
  embeddedTextHash,
  toVectorLiteral,
} from '../embeddings/embeddings.service';
import { PrismaService } from '../prisma/prisma.service';
import { ParsedAtom, ParsedProfile, parseResume } from './parse';
import { extractResume, isSupportedResume } from './resume.text';

/** What `preview` found, before anything is written. */
export interface ProfilePreview {
  parsed: ParsedProfile;
  /** The absolute path, which is what gets stored in `sourceResumePath`. */
  resumePath: string;
  /** Counts by kind, for the summary line at the top of the printout. */
  counts: Record<AtomKind, number>;
  /** Every tech tag across every atom - the set tailoring will be limited to. */
  techUnion: string[];
}

/** What `commit` did. */
export interface CommitResult {
  profileId: string;
  created: boolean;
  atomsCreated: number;
  atomsUpdated: number;
  atomsDeleted: number;
  atomsEmbedded: number;
  atomsReused: number;
}

export class ProfileIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileIngestError';
  }
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingsService,
  ) {}

  /**
   * Reads and parses a resume. Writes nothing, touches no model.
   *
   * Deliberately does no database work either, so `--dry-run` works against a
   * file before there is a user to attach it to.
   */
  async preview(path: string): Promise<ProfilePreview> {
    const resumePath = resolve(path);
    if (!isSupportedResume(resumePath)) {
      throw new ProfileIngestError(
        `${resumePath} is not a .pdf, .txt or .md file`,
      );
    }

    const { text, links } = await extractResume(resumePath);
    const parsed = parseResume(text, links);

    const counts: Record<AtomKind, number> = {
      [AtomKind.BULLET]: 0,
      [AtomKind.SKILL]: 0,
      [AtomKind.ROLE]: 0,
      [AtomKind.EDU]: 0,
    };
    for (const atom of parsed.atoms) counts[atom.kind]++;

    return {
      parsed,
      resumePath,
      counts,
      techUnion: [...new Set(parsed.atoms.flatMap((a) => a.tech))].sort((a, b) =>
        a.localeCompare(b),
      ),
    };
  }

  /**
   * Writes a previewed profile, then embeds it.
   *
   * The write and the embedding are SEPARATE transactions on purpose. Embedding
   * loads a model and takes tens of seconds on a cold cache, and holding a
   * Postgres transaction open for that would pin a connection and block the
   * vacuum. An atom with a null embedding is a well-defined state - the schema
   * says so, and matching skips it - whereas a transaction that times out
   * mid-embed would leave nothing at all.
   */
  async commit(input: {
    userId: string;
    label: string;
    preview: ProfilePreview;
    /** Replace atoms even though past resume variants reference them. */
    force?: boolean;
  }): Promise<CommitResult> {
    const { userId, label, preview } = input;
    const { parsed, resumePath } = preview;

    if (parsed.atoms.length === 0) {
      throw new ProfileIngestError(
        'the parse produced no atoms, so there is nothing to confirm',
      );
    }
    const email = parsed.email;
    if (!email) {
      throw new ProfileIngestError(
        'no email address was found in the resume. Every application needs one, ' +
          'and guessing it from the account is exactly the kind of invented ' +
          'credential this pipeline refuses to produce. Add it to the resume, or ' +
          'ingest a .txt copy with the address in the header.',
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ProfileIngestError(`no user with id ${userId}`);

    const written = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.candidateProfile.findUnique({
        where: { userId_label: { userId, label } },
        include: { _count: { select: { resumeVariants: true } } },
      });

      if (existing && existing._count.resumeVariants > 0 && !input.force) {
        throw new ProfileIngestError(
          `profile "${label}" has ${existing._count.resumeVariants} resume ` +
            'variant(s) built from its current atoms. Re-ingesting rewrites those ' +
            'atoms, and a variant records the atom ids it used inside a JSON ' +
            'column that Postgres cannot enforce - so any atom this ingest ' +
            'removes leaves a past variant pointing at nothing. Pass --force if ' +
            'that is acceptable, or ingest under a new --label.',
        );
      }

      const profile = await tx.candidateProfile.upsert({
        where: { userId_label: { userId, label } },
        create: {
          userId,
          label,
          fullName: parsed.fullName,
          email,
          phone: parsed.phone,
          location: parsed.location,
          linkedIn: parsed.linkedIn,
          github: parsed.github,
          portfolio: parsed.portfolio,
          sourceResumePath: resumePath,
          confirmedAt: new Date(),
        },
        update: {
          fullName: parsed.fullName,
          email,
          phone: parsed.phone,
          location: parsed.location,
          linkedIn: parsed.linkedIn,
          github: parsed.github,
          portfolio: parsed.portfolio,
          sourceResumePath: resumePath,
          // Re-confirmed: this write is only reached after the gate passed again.
          confirmedAt: new Date(),
        },
      });

      const reconciled = await this.reconcileAtoms(
        tx,
        profile.id,
        parsed.atoms,
      );

      return { profileId: profile.id, created: !existing, ...reconciled };
    });

    const embedded = await this.embedProfile(written.profileId);

    this.logger.log(
      `profile "${label}": ${written.atomsCreated} new, ${written.atomsUpdated} ` +
        `updated, ${written.atomsDeleted} removed, ${embedded.embedded} embedded, ` +
        `${embedded.reused} vectors reused`,
    );

    return {
      ...written,
      atomsEmbedded: embedded.embedded,
      atomsReused: embedded.reused,
    };
  }

  /**
   * Brings the stored atoms in line with a fresh parse, by TEXT rather than by id.
   *
   * Delete-all-and-recreate would be four lines shorter and wrong in two ways: it
   * throws away the embedding of every atom that did not change - a full re-embed
   * for a one-word edit - and it hands every atom a new id, which breaks the
   * `atomSelection` of every resume variant that ever referenced one.
   *
   * So an atom is IDENTIFIED BY ITS TEXT within a kind. That is the right key
   * because the text is what an atom is: a bullet whose wording changed is a
   * different claim and deserves a new id and a new vector, while a bullet that
   * merely moved is the same claim and keeps both.
   */
  private async reconcileAtoms(
    tx: Prisma.TransactionClient,
    profileId: string,
    desired: ParsedAtom[],
  ): Promise<{
    atomsCreated: number;
    atomsUpdated: number;
    atomsDeleted: number;
  }> {
    const existing = await tx.profileAtom.findMany({ where: { profileId } });
    // The colon is safe as a separator because no AtomKind value contains one, so
    // the key cannot be ambiguous between kind and text. Written as a visible
    // character on purpose: this line held a literal NUL byte for one draft, which
    // made the whole file read as binary to grep - the fourth invisible-character
    // bug in this project, after a non-breaking space and a zero-width space in
    // the HTML pipeline and a NUL in discovery.
    const key = (kind: AtomKind, text: string): string => `${kind}:${text}`;
    const byText = new Map(existing.map((a) => [key(a.kind, a.text), a]));

    // Vacate the ordinals before assigning new ones. `@@unique([profileId,
    // ordinal])` is not deferrable, so moving atom 3 to position 1 while
    // something still occupies 1 fails mid-update. Negating is enough: the
    // negatives are as distinct as the positives were, and nothing else in the
    // codebase reads a negative ordinal because this state never outlives the
    // transaction.
    await tx.$executeRaw`
      UPDATE profile_atoms SET ordinal = -ordinal - 1 WHERE "profileId" = ${profileId}
    `;

    const keep = new Set<string>();
    let created = 0;
    let updated = 0;

    for (const [ordinal, atom] of desired.entries()) {
      const match = byText.get(key(atom.kind, atom.text));

      if (match) {
        keep.add(match.id);
        await tx.profileAtom.update({
          where: { id: match.id },
          data: {
            ordinal,
            tech: atom.tech,
            metrics: atom.metrics,
            employer: atom.employer ?? null,
            dateRange: atom.dateRange ?? null,
            // embedding and embeddedTextHash deliberately untouched - the text is
            // identical, so the vector is still current.
          },
        });
        updated++;
        continue;
      }

      await tx.profileAtom.create({
        data: {
          profileId,
          kind: atom.kind,
          text: atom.text,
          tech: atom.tech,
          metrics: atom.metrics,
          employer: atom.employer ?? null,
          dateRange: atom.dateRange ?? null,
          ordinal,
        },
      });
      created++;
    }

    const removed = existing.filter((a) => !keep.has(a.id));
    if (removed.length > 0) {
      await tx.profileAtom.deleteMany({
        where: { id: { in: removed.map((a) => a.id) } },
      });
    }

    return {
      atomsCreated: created,
      atomsUpdated: updated,
      atomsDeleted: removed.length,
    };
  }

  /**
   * Embeds any atom whose vector is missing or stale, then the profile itself.
   *
   * Staleness is `embeddedTextHash != sha256(text)`, which is the check
   * `JobPosting.contentHash` performs for postings. Without it an edited atom
   * keeps a vector describing its previous wording and nothing anywhere says so -
   * the match scores stay plausible and are simply about the wrong sentence.
   */
  async embedProfile(
    profileId: string,
  ): Promise<{ embedded: number; reused: number }> {
    const atoms = await this.prisma.profileAtom.findMany({
      where: { profileId },
      orderBy: { ordinal: 'asc' },
      select: { id: true, text: true, embeddedTextHash: true },
    });

    const stale = atoms.filter(
      (a) => a.embeddedTextHash !== embeddedTextHash(a.text),
    );

    if (stale.length > 0) {
      const vectors = await this.embeddings.embed(stale.map((a) => a.text));
      for (const [at, atom] of stale.entries()) {
        await this.prisma.$executeRaw`
          UPDATE profile_atoms
             SET embedding = ${toVectorLiteral(vectors[at])}::vector,
                 "embeddedTextHash" = ${embeddedTextHash(atom.text)},
                 "updatedAt" = now()
           WHERE id = ${atom.id}
        `;
      }
    }

    await this.setProfileVector(profileId);

    return { embedded: stale.length, reused: atoms.length - stale.length };
  }

  /**
   * The whole-profile vector: the normalised MEAN of the atom vectors.
   *
   * Not an encode of the concatenated resume, which is the obvious reading of
   * "whole-profile vector" and is wrong here. bge-small truncates at 512 tokens
   * and a two-page resume is longer than that, so encoding the joined text would
   * silently drop the education and leadership sections and produce a vector that
   * describes the top of the page. The mean of normalised atom vectors covers
   * every atom at any resume length, and averaging normalised vectors is the
   * standard way to build a centroid.
   *
   * Averaged in Node rather than in SQL. `AVG(embedding)` exists in pgvector, but
   * dividing a vector by a scalar to renormalise it does NOT - there is no
   * `vector / float8` operator, and `l2_normalize` only arrived in pgvector 0.7.
   * Reading 40 rows of 384 floats to average them here costs nothing and does not
   * depend on which extension version the container happens to ship.
   */
  private async setProfileVector(profileId: string): Promise<void> {
    // `::text` because Prisma has no type for a vector column, so it comes back
    // as pgvector's own literal - "[0.1,0.2,...]" - and is parsed below.
    const rows = await this.prisma.$queryRaw<{ embedding: string }[]>`
      SELECT embedding::text AS embedding
        FROM profile_atoms
       WHERE "profileId" = ${profileId}
         AND embedding IS NOT NULL
    `;

    if (rows.length === 0) {
      // Nothing embedded, so there is no centroid to store. Leaving the column
      // null is correct and visible; writing a zero vector would be a value that
      // sits at distance 1 from everything and looks like a real profile.
      this.logger.warn(
        `profile ${profileId} has no embedded atoms - whole-profile vector left null`,
      );
      return;
    }

    const sum = new Array<number>(EMBEDDING_DIM).fill(0);
    for (const row of rows) {
      const vector = JSON.parse(row.embedding) as number[];
      if (vector.length !== EMBEDDING_DIM) {
        throw new Error(
          `a stored atom vector has ${vector.length} dimensions, expected ${EMBEDDING_DIM}`,
        );
      }
      for (let i = 0; i < EMBEDDING_DIM; i++) sum[i] += vector[i];
    }

    // Renormalise rather than just dividing by the count: the mean of unit
    // vectors is not itself a unit vector, and every distance downstream assumes
    // one - `1 - dot` is only cosine distance if both sides have length 1.
    const norm = Math.sqrt(sum.reduce((acc, x) => acc + x * x, 0));
    const centroid = norm > 0 ? sum.map((x) => x / norm) : sum;

    await this.prisma.$executeRaw`
      UPDATE candidate_profiles
         SET embedding = ${toVectorLiteral(centroid)}::vector,
             "updatedAt" = now()
       WHERE id = ${profileId}
    `;
  }
}
