import { SLUGS } from './slugs.mjs';
const UA = 'job-autopilot-research/0.1 (personal job search research; low volume)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ATS = {
  greenhouse: {
    url: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
    count: j => Array.isArray(j.jobs) ? j.jobs.length : null,
  },
  lever: {
    url: s => `https://api.lever.co/v0/postings/${s}?mode=json`,
    count: j => Array.isArray(j) ? j.length : null,
  },
  ashby: {
    url: s => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
    count: j => Array.isArray(j.jobs) ? j.jobs.length : null,
  },
  workable: {
    url: s => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
    count: j => Array.isArray(j.jobs) ? j.jobs.length : null,
  },
};

const tasks = [];
for (const s of SLUGS) for (const [ats, cfg] of Object.entries(ATS)) tasks.push({ s, ats, cfg });

const hits = [];
let done = 0, errors = 0;
const LIMIT = 8;

async function worker() {
  while (tasks.length) {
    const { s, ats, cfg } = tasks.shift();
    try {
      const r = await fetch(cfg.url(s), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (r.status === 200) {
        const text = await r.text();
        let n = null;
        try { n = cfg.count(JSON.parse(text)); } catch { n = 'unparseable'; }
        if (typeof n === 'number' && n > 0) {
          hits.push({ ats, s, n });
          console.log(`HIT  ${ats.padEnd(11)} ${s.padEnd(20)} ${n} jobs`);
        }
      }
    } catch { errors++; }
    done++;
    await sleep(60 + Math.random() * 120);
  }
}
await Promise.all(Array.from({ length: LIMIT }, worker));
console.log(`\n--- swept ${done} probes, ${errors} network errors ---`);
const byAts = {};
for (const h of hits) { byAts[h.ats] ??= []; byAts[h.ats].push(h); }
for (const [ats, list] of Object.entries(byAts)) {
  const jobs = list.reduce((a, b) => a + b.n, 0);
  console.log(`${ats.padEnd(11)} ${String(list.length).padStart(3)} boards  ${String(jobs).padStart(6)} jobs`);
}
const fs = await import('node:fs');
fs.writeFileSync('hits.json', JSON.stringify(hits, null, 2));
