import fs from 'node:fs';
const all = JSON.parse(fs.readFileSync('all-postings.json','utf8'));
const IN = /\b(india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurgaon|gurugram|noida|chennai|kolkata|bhubaneswar)\b/i;
const ENG = /\b(engineer|developer|sde|programmer|scientist|full[- ]?stack|backend|back[- ]end)\b/i;
const NON = /\b(sales|marketing|recruit|talent|people|hr\b|finance|account|legal|counsel|designer|product manager|program manager|customer success|support|partner|business development|content|intern|internship)\b/i;
const VERY_SENIOR = /\b(staff|principal|director|head of|vp\b|chief|distinguished|fellow|manager)\b/i;
const SENIOR_ONLY = /\b(senior|sr\.?\b|lead\b)\b/i;

const india = all.filter(p => IN.test(p.location));
const eng = india.filter(p => ENG.test(p.title) && !NON.test(p.title));
const reachable = eng.filter(p => !VERY_SENIOR.test(p.title));
const noSenior  = reachable.filter(p => !SENIOR_ONLY.test(p.title));

console.log(`India postings                      ${india.length}`);
console.log(`  engineering                       ${eng.length}`);
console.log(`  minus staff/principal/mgr+        ${reachable.length}`);
console.log(`  also minus senior/lead            ${noSenior.length}`);
console.log(`\nSALARY COVERAGE`);
console.log(`  all postings with salary          ${all.filter(p=>p.salary).length} / ${all.length}  (${(all.filter(p=>p.salary).length/all.length*100).toFixed(1)}%)`);
console.log(`  INDIA postings with salary        ${india.filter(p=>p.salary).length} / ${india.length}  (${(india.filter(p=>p.salary).length/india.length*100).toFixed(1)}%)`);
const inSal = india.filter(p=>p.salary);
console.log(`  the India ones that had it:`); inSal.slice(0,10).forEach(p=>console.log(`      [${p.company}] ${p.title} :: ${p.salary}`));

console.log(`\nBOARD YIELD (india eng, minus staff+)`);
const by = {};
for (const p of reachable) by[p.company] = (by[p.company]??0)+1;
console.log('  ' + Object.entries(by).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '));
console.log(`\n  boards probed: 34 | boards yielding >=1 reachable role: ${Object.keys(by).length}`);
console.log(`  reachable roles per yielding board: ${(reachable.length/Object.keys(by).length).toFixed(1)}`);
