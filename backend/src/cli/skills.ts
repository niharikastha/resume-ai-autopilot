/**
 * The skills reserve: what tailoring is allowed to mention beyond the resume's own
 * tech tags.
 *
 *   npm run cli -- skills:list
 *   npm run cli -- skills:add --skill "TypeScript, Python"
 *   npm run cli -- skills:add --skill Kafka --staged --note "one project, 2022"
 *   npm run cli -- skills:remove --skill Kafka
 *
 * WHY THIS COMMAND EXISTS. The provenance guard checks every technology named in a
 * tailored resume against one union: the tech tags on the candidate's atoms plus
 * their ENABLED SkillsReserve rows. When a rewrite names something outside that
 * union the whole variant is discarded and the base resume goes out instead. The
 * guard's own message says "add it to SkillsReserve and enable it" - and until this
 * file existed there was no way to do that short of hand-written SQL, which meant
 * the one repair the guard asks for was the one repair nobody could perform.
 *
 * It is not a hypothetical gap. A real run rejected a tailored resume for naming
 * TypeScript, JavaScript and Python: the resume's atoms tag frameworks and
 * databases, so the languages underneath them were never tagged anywhere, and the
 * guard - correctly, on the information it had - called them fabricated.
 *
 * NEW ROWS ARE ENABLED BY DEFAULT, which inverts the column's own default. The
 * column defaults to false so that nothing arriving in bulk widens the guard by
 * accident; this command is a person typing a skill they have, one at a time, and a
 * row that silently does nothing is a trap - the resume gets rejected again and the
 * command that was supposed to fix it reported success. `--staged` writes it
 * switched off for the cases where holding one back is the point.
 *
 * ADDING A SKILL IS A CLAIM ABOUT THE CANDIDATE. Everything here ends up asserted
 * to an employer, so `--note` exists to record where the claim comes from, and the
 * list prints it.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from 'dotenv';
import { resolve } from 'path';
import { canonicalise, techIn } from '../profile/tech';

config({ path: resolve(__dirname, '../../../.env') });

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/**
 * The skills named on the command line, canonically spelled.
 *
 * Canonicalised on the way IN rather than at read time, because the guard compares
 * canonical forms and a reserve row is worth reading later: a table holding
 * "nodejs" tells whoever opens it less than one holding "Node.js", even though both
 * work.
 *
 * Comma-separated so that the three languages one resume forgot to tag are one
 * command and not three round trips.
 */
function skillsFromArgv(): string[] {
  const raw = flag('skill');
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((item) => canonicalise(item.trim()))
        .filter((item) => item.length > 0),
    ),
  ];
}

/**
 * Whose reserve this is.
 *
 * `--user` is optional and resolves to the only account when there is only one,
 * which is the normal case for a single-candidate install. It is REQUIRED as soon
 * as there are two, rather than guessing: the wrong reserve row widens what a
 * different person's resume may claim, and nothing downstream would ever say so.
 */
async function resolveUser(
  prisma: PrismaClient,
  email?: string,
): Promise<{ id: string; email: string }> {
  if (email) {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`no user with email ${email}`);
    return user;
  }

  const users = await prisma.user.findMany({
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
    take: 2,
  });
  if (users.length === 0)
    throw new Error('no users yet - run create-user first');
  if (users.length > 1) {
    throw new Error(
      'more than one account exists, so --user <email> is required: a reserve row ' +
        "widens what one specific person's resume may claim",
    );
  }
  return users[0];
}

async function list(prisma: PrismaClient, userId: string, email: string) {
  const rows = await prisma.skillsReserve.findMany({
    where: { userId },
    orderBy: [{ enabled: 'desc' }, { skill: 'asc' }],
  });

  if (rows.length === 0) {
    console.log(
      `\n${email}: the reserve is empty, which is the intended starting state - ` +
        'tailoring may name only the technologies the resume itself tags.\n',
    );
    return;
  }

  console.log(`\n${email}: ${rows.length} reserve skill(s)\n`);
  for (const row of rows) {
    console.log(
      `  ${(row.enabled ? 'enabled ' : 'STAGED  ').padEnd(9)}${row.skill}` +
        (row.note ? `   - ${row.note}` : ''),
    );
  }

  const enabled = rows.filter((r) => r.enabled).length;
  console.log(
    `\n${enabled} of these widen what the provenance guard accepts. ` +
      'STAGED rows do nothing until added again without --staged.\n',
  );
}

async function add(prisma: PrismaClient, userId: string) {
  const skills = skillsFromArgv();
  if (skills.length === 0) {
    throw new Error(
      'usage: skills:add --skill "TypeScript, Python" [--staged] [--note ...]',
    );
  }

  const enabled = !process.argv.includes('--staged');
  const note = flag('note') ?? null;

  for (const skill of skills) {
    // Upsert rather than create, so re-running with a skill already present is how
    // a STAGED row is switched on - there is no separate enable verb to remember,
    // and the command is idempotent.
    const before = await prisma.skillsReserve.findUnique({
      where: { userId_skill: { userId, skill } },
      select: { enabled: true },
    });

    await prisma.skillsReserve.upsert({
      where: { userId_skill: { userId, skill } },
      // A second --note overwrites; omitting it leaves the existing one alone,
      // because "add Python again to enable it" should not erase why it is there.
      update: { enabled, ...(note ? { note } : {}) },
      create: { userId, skill, enabled, note },
    });

    const state = enabled ? 'enabled' : 'staged (does nothing yet)';
    console.log(
      before === null
        ? `added ${skill}, ${state}`
        : `${skill} was already there (${before.enabled ? 'enabled' : 'staged'}) -> ${state}`,
    );

    // The guard finds technologies with the tech dictionary, so a name the
    // dictionary does not know can never be flagged as invented in the first place
    // and this row will never be consulted. Said out loud because the alternative
    // is someone adding a skill, seeing "added", and still having their resume
    // rejected for a spelling the dictionary matched instead.
    if (techIn(skill).length === 0) {
      console.log(
        `  note: "${skill}" is not in the tech dictionary, so the guard would not ` +
          'have flagged it anyway. The row is harmless and does no work.',
      );
    }
  }

  if (enabled) {
    console.log(
      '\nTailoring may now name these. Everything in the reserve is asserted to an ' +
        'employer eventually, so it should be true.\n',
    );
  }
}

async function remove(prisma: PrismaClient, userId: string) {
  const skills = skillsFromArgv();
  if (skills.length === 0) {
    throw new Error('usage: skills:remove --skill "Kafka"');
  }

  for (const skill of skills) {
    const { count } = await prisma.skillsReserve.deleteMany({
      where: { userId, skill },
    });
    console.log(
      count > 0 ? `removed ${skill}` : `${skill} was not in the reserve`,
    );
  }
  console.log('');
}

async function main(): Promise<void> {
  // argv[2] is the dispatcher's own command name - `skills:add`, not `add`.
  const verb = (process.argv[2] ?? '').split(':')[1];

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const user = await resolveUser(prisma, flag('user'));

    if (verb === 'list') await list(prisma, user.id, user.email);
    else if (verb === 'add') await add(prisma, user.id);
    else if (verb === 'remove') await remove(prisma, user.id);
    else throw new Error(`unknown skills verb "${verb ?? ''}"`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
