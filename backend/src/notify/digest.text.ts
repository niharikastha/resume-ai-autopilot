/**
 * The digest as words. One renderer, three outputs: plain text, HTML, and Telegram.
 *
 * SEPARATE FROM THE SERVICE because rendering is where the digest is actually judged -
 * a number that reads as "0 of 0 = 0% failures" is worse than no number, and that is a
 * property of this file, not of the query that produced it. Pure functions over a
 * payload, so the tests read like the email.
 *
 * NO ONE-CLICK REJECT LINKS IN THE EMAIL, deliberately. They would need a GET route
 * that changes data and authenticates from a token in a URL - and mail clients, link
 * scanners and corporate gateways fetch every link in a message before a human sees it,
 * which would reject postings on their own. The email links to the digest page and the
 * buttons live there, behind a session. One extra tap, and it cannot be pressed by a
 * spam filter.
 */
import type { DigestPayload } from './digest.types';

/** The subject line, which is the only part most mornings that gets read. */
export function digestSubject(payload: DigestPayload): string {
  const { newMatches, undecided, preparedWaiting } = payload.candidate;

  // Front-loaded with the number that decides whether to open it. "AUTOPILOT daily
  // digest" as a subject is what an unread folder is made of.
  const parts: string[] = [];
  if (newMatches > 0)
    parts.push(`${newMatches} new match${plural(newMatches)}`);
  if (undecided > 0) parts.push(`${undecided} to review`);
  if (preparedWaiting > 0) parts.push(`${preparedWaiting} ready to send`);

  const summary = parts.length > 0 ? parts.join(', ') : 'nothing new';
  return `AUTOPILOT ${payload.day}: ${summary}`;
}

/**
 * The plain-text digest.
 *
 * Written to be read as text and not as a fallback nobody looks at. It is what Telegram
 * gets, what a text-only mail client gets, and what the CLI prints - so if it is wrong
 * here it is wrong in three places at once.
 */
export function digestText(payload: DigestPayload, appUrl: string): string {
  const c = payload.candidate;
  const lines: string[] = [`AUTOPILOT - ${payload.day}`, ''];

  lines.push(`New matches since the last digest: ${c.newMatches}`);
  const verdicts = Object.entries(c.byVerdict)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${count} ${verdict.toLowerCase()}`);
  if (verdicts.length > 0) lines.push(`  ${verdicts.join(', ')}`);

  lines.push(`Waiting for your yes or no: ${c.undecided}`);
  lines.push(`Forms filled and waiting for you to send: ${c.preparedWaiting}`);
  if (c.submitted > 0)
    lines.push(`Submitted since the last digest: ${c.submitted}`);

  if (c.tailored > 0) {
    lines.push(
      `Resumes written: ${c.tailored}, of which ${c.guardFailed} failed the ` +
        `provenance check (${percent(c.guardFailureRate)})`,
    );
  }

  if (c.missingAnswers.length > 0) {
    lines.push('');
    // Above the job list on purpose. It is the one item here that the reader can fix in
    // two minutes, and it silently leaves a required box empty on every form until they
    // do.
    lines.push('Your forms are missing these answers, so they are left blank:');
    for (const answer of c.missingAnswers) lines.push(`  - ${answer}`);
  }

  if (c.top.length > 0) {
    lines.push('');
    lines.push(`Top ${c.top.length} waiting for a decision:`);
    for (const match of c.top) {
      lines.push(`  ${match.score}  ${match.title} @ ${match.company}`);
      const detail = [
        match.location,
        match.salaryLpa === null ? null : `~${match.salaryLpa} LPA`,
      ].filter((part): part is string => part !== null && part.length > 0);
      if (detail.length > 0) lines.push(`      ${detail.join(' - ')}`);
    }
    lines.push('');
    lines.push(`Say yes or no here: ${appUrl}/app/digest`);
  }

  if (payload.system) {
    const s = payload.system;
    lines.push('');
    lines.push('--- the machine ---');
    lines.push(
      `New companies: ${s.newCompanies}. New postings: ${s.newPostings}.`,
    );
    if (s.boards.length > 0) {
      lines.push('Per board (new / seen / tried / errors):');
      for (const board of s.boards) {
        lines.push(
          `  ${board.source}: ${board.postingsNew} / ${board.postingsSeen} / ` +
            `${board.companiesTried} / ${board.errors}`,
        );
      }
    }
    if (s.deadBoards.length > 0) {
      lines.push('Worth a look:');
      for (const dead of s.deadBoards) {
        lines.push(`  ${dead.source}: ${dead.reason}`);
      }
    }
    if (s.modelUse.length > 0) {
      lines.push(
        `LLM calls: ${s.modelUse
          .map((use) => `${use.calls} x ${use.model}`)
          .join(', ')}`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * The HTML digest.
 *
 * Inline styles, no grid, no <style> block - the same constraints as the rest of
 * mail.service.ts, and for the same reason: Outlook. A table for the job list because
 * that is the one layout every mail client renders the same way.
 */
export function digestHtml(payload: DigestPayload, appUrl: string): string {
  const c = payload.candidate;
  const rows = c.top
    .map((match) => {
      const detail = [
        match.location,
        match.salaryLpa === null ? null : `~${escapeHtml(match.salaryLpa)} LPA`,
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .map(escapeHtml)
        .join(' &middot; ');
      return `<tr>
        <td style="padding:8px 12px 8px 0;vertical-align:top;font-weight:600;color:#3f3f46;">${match.score}</td>
        <td style="padding:8px 0;vertical-align:top;">
          <div style="font-weight:600;">${escapeHtml(match.title)}</div>
          <div style="color:#52525b;font-size:13px;">${escapeHtml(match.company)}${
            detail ? ` &middot; ${detail}` : ''
          }</div>
        </td>
      </tr>`;
    })
    .join('');

  const missing =
    c.missingAnswers.length === 0
      ? ''
      : `<p style="margin:16px 0;padding:12px;background:#fef3c7;border-radius:8px;font-size:14px;">
           <strong>Your forms are missing:</strong> ${c.missingAnswers
             .map(escapeHtml)
             .join(', ')}. Until you fill these in they are left blank on every
           application.</p>`;

  const guard =
    c.tailored === 0
      ? ''
      : `<li>${c.tailored} resume(s) written, ${c.guardFailed} failed the provenance
           check (${percent(c.guardFailureRate)})</li>`;

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 4px;font-size:18px;">Your job search this morning</h1>
    <p style="margin:0 0 20px;color:#71717a;font-size:13px;">${escapeHtml(payload.day)}</p>
    <ul style="margin:0 0 8px;padding-left:20px;font-size:14px;line-height:1.7;">
      <li><strong>${c.newMatches}</strong> new match(es) since the last digest</li>
      <li><strong>${c.undecided}</strong> waiting for your yes or no</li>
      <li><strong>${c.preparedWaiting}</strong> form(s) filled and waiting for you to send</li>
      ${c.submitted > 0 ? `<li>${c.submitted} submitted since the last digest</li>` : ''}
      ${guard}
    </ul>
    ${missing}
    ${
      rows
        ? `<h2 style="margin:24px 0 8px;font-size:15px;">Waiting for a decision</h2>
           <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>
           <p style="margin:24px 0 0;"><a href="${escapeHtml(appUrl)}/app/digest"
             style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;">Say yes or no</a></p>`
        : `<p style="margin:24px 0 0;color:#52525b;font-size:14px;">Nothing is waiting for a decision.</p>`
    }
    ${payload.system ? systemHtml(payload.system) : ''}
    <p style="margin:28px 0 0;color:#a1a1aa;font-size:12px;">Nothing is ever submitted
    for you. AUTOPILOT fills the forms in; you press the button.</p>
  </div>
</body></html>`;
}

function systemHtml(system: NonNullable<DigestPayload['system']>): string {
  const boards = system.boards
    .map(
      (board) =>
        `<tr><td style="padding:4px 12px 4px 0;">${escapeHtml(board.source)}</td>
         <td style="padding:4px 12px 4px 0;">${board.postingsNew} new</td>
         <td style="padding:4px 12px 4px 0;">${board.postingsSeen} seen</td>
         <td style="padding:4px 0;color:${board.errors > 0 ? '#b91c1c' : '#71717a'};">${
           board.errors
         } error(s)</td></tr>`,
    )
    .join('');
  const dead = system.deadBoards
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.source)}</strong> &mdash; ${escapeHtml(
          item.reason,
        )}</li>`,
    )
    .join('');

  return `<hr style="border:none;border-top:1px solid #e4e4e7;margin:28px 0 20px;">
    <h2 style="margin:0 0 8px;font-size:15px;">The machine</h2>
    <p style="margin:0 0 12px;font-size:14px;">${system.newCompanies} new company(ies),
      ${system.newPostings} new posting(s).</p>
    ${
      boards
        ? `<table style="border-collapse:collapse;font-size:13px;color:#3f3f46;">${boards}</table>`
        : ''
    }
    ${
      dead
        ? `<p style="margin:12px 0 4px;font-size:14px;"><strong>Worth a look</strong></p>
           <ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;">${dead}</ul>`
        : ''
    }
    ${
      system.modelUse.length > 0
        ? `<p style="margin:12px 0 0;font-size:13px;color:#71717a;">LLM calls: ${system.modelUse
            .map((use) => `${use.calls} &times; ${escapeHtml(use.model)}`)
            .join(', ')}</p>`
        : ''
    }`;
}

/**
 * A rate as a percentage, or "n/a".
 *
 * Null is not 0%. `guardFailureRate` is null when nothing was tailored, and printing
 * "0%" for that would report a perfect record on a day when nothing happened.
 */
export function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
}

function plural(count: number): string {
  return count === 1 ? '' : 'es';
}

/** `&` first, or it would double-escape the entities added after it. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
