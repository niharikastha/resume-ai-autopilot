import fs from 'node:fs';
const UA = 'job-autopilot-research/0.1 (personal job search research; low volume)';
const hits = JSON.parse(fs.readFileSync('hits.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const URLS = {
  greenhouse: s => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=true`,
  lever:      s => `https://api.lever.co/v0/postings/${s}?mode=json`,
  ashby:      s => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
  workable:   s => `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`,
};

// normalize each ATS into {title, location, salary?}
const NORM = {
  greenhouse: j => j.jobs.map(x => ({ title: x.title, location: x.location?.name ?? '', salary: null })),
  lever:      j => j.map(x => ({ title: x.text, location: x.categories?.location ?? '',
                                 salary: x.salaryRange ? `${x.salaryRange.min}-${x.salaryRange.max} ${x.salaryRange.currency}/${x.salaryRange.interval}` : null })),
  ashby:      j => j.jobs.map(x => ({ title: x.title, location: x.location ?? '',
                                 salary: x.compensation?.compensationTierSummary ?? null })),
  workable:   j => j.jobs.map(x => ({ title: x.title, location: [x.city, x.country].filter(Boolean).join(', '), salary: null })),
};

const IN_LOC = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|new delhi|delhi|gurgaon|gurugram|noida|chennai|kolkata|bhubaneswar|ahmedabad|jaipur|indore|kochi|coimbatore|trivandrum|thiruvananthapuram)\b/i;
const REMOTE = /\bremote\b/i;
const ENG = /\b(engineer|developer|sde|programmer|architect|scientist|technologist|full[- ]?stack|backend|back[- ]end)\b/i;
const RELEVANT_TECH = /\b(backend|back[- ]end|full[- ]?stack|node|nest|javascript|typescript|python|java\b|golang|go\b|api|platform|ai|ml|machine learning|llm|genai|data|software)\b/i;
const TOO_SENIOR = /\b(senior|staff|principal|lead|manager|director|head of|vp\b|chief|architect|sr\.?\b|ii+i|distinguished|fellow)\b/i;
const NON_ENG = /\b(sales|marketing|recruit|talent|people|hr\b|finance|account|legal|counsel|designer|design\b|product manager|program manager|customer success|support|solutions consultant|partner|business development|bdr|sdr|content|communications|intern|internship|apprentice)\b/i;

const all = [];
for (const h of hits) {
  try {
    const r = await fetch(URLS[h.ats](h.s), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    for (const p of NORM[h.ats](j)) all.push({ ...p, company: h.s, ats: h.ats });
  } catch (e) { console.log(`fetch fail ${h.ats}/${h.s}: ${e.message}`); }
  await sleep(250);
}

const india   = all.filter(p => IN_LOC.test(p.location));
const remote  = all.filter(p => !IN_LOC.test(p.location) && REMOTE.test(p.location));
const eng     = india.filter(p => ENG.test(p.title) && !NON_ENG.test(p.title));
const tech    = eng.filter(p => RELEVANT_TECH.test(p.title));
const junior  = tech.filter(p => !TOO_SENIOR.test(p.title));
const withSal = all.filter(p => p.salary);

console.log(`\n================ FUNNEL (one-time snapshot, all live postings) ================`);
console.log(`total postings on the 34 boards        ${all.length}`);
console.log(`  ...located in India                  ${india.length}`);
console.log(`  ...(remote, non-India-tagged)        ${remote.length}`);
console.log(`  India + engineering role             ${eng.length}`);
console.log(`  India + eng + backend/AI-relevant    ${tech.length}`);
console.log(`  India + eng + relevant + not senior  ${junior.length}   <<< YOUR ADDRESSABLE POOL`);
console.log(`postings with structured salary        ${withSal.length} (${(withSal.length/all.length*100).toFixed(1)}%)`);

console.log(`\n--- addressable pool by company ---`);
const byCo = {};
for (const p of junior) (byCo[`${p.company} (${p.ats})`] ??= []).push(p.title);
for (const [co, titles] of Object.entries(byCo).sort((a,b)=>b[1].length-a[1].length))
  console.log(`${String(titles.length).padStart(3)}  ${co}`);

console.log(`\n--- sample of the addressable pool ---`);
for (const p of junior.slice(0, 30)) console.log(`  [${p.company}] ${p.title}  @ ${p.location}${p.salary ? `  {${p.salary}}` : ''}`);

console.log(`\n--- India postings by company (all roles) ---`);
const byCo2 = {};
for (const p of india) byCo2[p.company] = (byCo2[p.company] ?? 0) + 1;
console.log(Object.entries(byCo2).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '));

console.log(`\n--- structured salary examples ---`);
for (const p of withSal.slice(0, 12)) console.log(`  [${p.company}] ${p.title} :: ${p.salary}`);
fs.writeFileSync('all-postings.json', JSON.stringify(all, null, 2));
