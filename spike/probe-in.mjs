const UA = 'job-autopilot-research/0.1 (personal job search research; low volume)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const try1 = async (label, url) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const b = await r.text();
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    if (r.status === 200 && b.length > 200)
      console.log(`200 ${label.padEnd(46)} ${ct.padEnd(18)} ${String(b.length).padStart(7)}b  ${b.slice(0,90).replace(/\s+/g,' ')}`);
    else if (r.status !== 404)
      console.log(`${r.status} ${label.padEnd(46)} ${ct.padEnd(18)} ${String(b.length).padStart(7)}b`);
  } catch (e) { /* silent */ }
  await sleep(120);
};

console.log('=== KEKA: does {sub}.keka.com/careers exist, and is there a JSON route? ===');
for (const s of ['hyscaler','mindfire','tekniko','cognizant','zluri','fluidscapes','wingify','pratiti','techjays','indusnet','sedin','nyusoft','clarion','peerbits','openxcell','hidden-brains','simform','tatvasoft']) {
  await try1(`keka/${s}`, `https://${s}.keka.com/careers/`);
  await try1(`keka-api/${s}`, `https://${s}.keka.com/careers/api/embedjobs/`);
}

console.log('\n=== ZOHO RECRUIT: careers page + known JSON routes ===');
for (const s of ['hyscaler','mindfire','zylker','sedin','techjays','nyusoft','peerbits','openxcell','simform','tatvasoft','clarion','indusnet']) {
  await try1(`zohorecruit.in/${s}`, `https://${s}.zohorecruit.in/jobs/Careers`);
  await try1(`zohorecruit.com/${s}`, `https://${s}.zohorecruit.com/jobs/Careers`);
}

console.log('\n=== DARWINBOX ===');
for (const s of ['hyscaler','swiggy','delhivery','nykaa','lenskart','myntra','tatadigital','arvind']) {
  await try1(`darwinbox/${s}`, `https://${s}.darwinbox.in/ms/candidate/careers`);
  await try1(`darwinbox-co/${s}`, `https://${s}.darwinbox.co.in/ms/candidate/careers`);
}

console.log('\n=== FRESHTEAM (may be sunset) / SMARTRECRUITERS / RECRUITEE ===');
await try1('smartrecruiters/Deloitte', 'https://api.smartrecruiters.com/v1/companies/Deloitte/postings');
await try1('smartrecruiters/Wipro', 'https://api.smartrecruiters.com/v1/companies/Wipro/postings');
await try1('smartrecruiters/Bosch', 'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings');
await try1('freshteam/freshworks', 'https://freshworks.freshteam.com/api/job_postings');

console.log('\n=== AGGREGATORS with India coverage ===');
await try1('remotive', 'https://remotive.com/api/remote-jobs?limit=5');
await try1('jobicy', 'https://jobicy.com/api/v2/remote-jobs?count=5');
await try1('arbeitnow', 'https://www.arbeitnow.com/api/job-board-api');
await try1('themuse', 'https://www.themuse.com/api/public/jobs?page=1&location=India');
