/**
 * Compute the vectors for a profile whose atoms are already confirmed.
 *
 *   npm run cli -- profile:embed                        # every profile missing vectors
 *   npm run cli -- profile:embed --user me@example.com
 *   npm run cli -- profile:embed --all                  # re-check every profile
 *
 * REPAIR, not part of the normal flow - `profile:ingest --confirm` embeds as it
 * writes. This exists because that write and that embedding are deliberately
 * separate transactions (see the note on ProfileService.commit): embedding loads a
 * 130MB model, and holding a Postgres transaction open across it would pin a
 * connection for no benefit. The consequence is a real intermediate state - atoms
 * committed, vectors null - which the schema permits and matching skips.
 *
 * That state is not hypothetical. It is what this repository was in when this command
 * was written: 21 confirmed atoms with no vectors, because the model download had
 * written four zero-byte files into the cache and the embed step failed after the
 * atoms had landed. Without this command the only fix is to re-ingest, which rewrites
 * rows that were perfectly correct.
 *
 * A missing vector is invisible in normal use - stage 2 of the funnel just quietly
 * has less to compare - so the count this prints is worth reading.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from '../config/config.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileModule } from '../profile/profile.module';
import { ProfileService } from '../profile/profile.service';

@Module({
  imports: [AppConfigModule, PrismaModule, ProfileModule],
})
class ProfileEmbedCliModule {}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const email = flag('--user')?.toLowerCase();
  const all = process.argv.includes('--all');

  const app = await NestFactory.createApplicationContext(ProfileEmbedCliModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const profiles = app.get(ProfileService);

    const rows = await prisma.candidateProfile.findMany({
      where: {
        ...(email ? { user: { email } } : {}),
        // Only confirmed profiles. An unconfirmed one is a parse nobody has
        // approved, and embedding it would be work spent on atoms that may not
        // survive the gate.
        confirmedAt: { not: null },
      },
      select: {
        id: true,
        label: true,
        user: { select: { email: true } },
        _count: { select: { atoms: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (rows.length === 0) {
      console.log(
        email
          ? `\nno confirmed profile for ${email}\n`
          : '\nno confirmed profiles yet - run profile:ingest first\n',
      );
      return;
    }

    // Which of them actually need work. Raw SQL rather than prisma.groupBy because
    // `embedding` is Unsupported("vector(384)") and so does not exist on the
    // generated client at all - there is no `where: { embedding: null }` to write.
    // Counted in the database rather than by loading the atoms, because "how many
    // rows have a null vector" is exactly the question a count is for.
    const pending = await prisma.$queryRaw<
      { profileId: string; count: bigint }[]
    >`
      SELECT "profileId", COUNT(*) AS count
        FROM profile_atoms
       WHERE embedding IS NULL
         AND "profileId" = ANY(${rows.map((r) => r.id)}::text[])
       GROUP BY "profileId"
    `;
    // COUNT() comes back as bigint, which JSON cannot serialise and arithmetic
    // cannot mix with a number. Narrowed here, at the edge, once.
    const missing = new Map(pending.map((p) => [p.profileId, Number(p.count)]));

    const selected = all ? rows : rows.filter((r) => missing.has(r.id));

    if (selected.length === 0) {
      console.log(
        `\nall ${rows.length} confirmed profile(s) are fully embedded. ` +
          'Use --all to re-check for stale vectors.\n',
      );
      return;
    }

    console.log(
      `\n${selected.length} profile(s) to embed` +
        `${all ? ' (--all: checking every atom for staleness)' : ''}\n`,
    );

    for (const row of selected) {
      const gap = missing.get(row.id) ?? 0;
      console.log(
        `${row.user.email} / ${row.label}: ${row._count.atoms} atoms, ` +
          `${gap} without a vector`,
      );

      // Re-embeds only what is missing or stale - the hash check inside
      // embedProfile decides, so --all is cheap when there is nothing to do.
      const result = await profiles.embedProfile(row.id);
      console.log(
        `  -> ${result.embedded} computed, ${result.reused} already current\n`,
      );
    }

    console.log('done. Stage 2 of the matching funnel can read these now.\n');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
