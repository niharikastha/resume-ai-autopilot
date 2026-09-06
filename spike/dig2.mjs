const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const get = async (url) => {
  try { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, url: r.url, body: await r.text() }; }
  catch (e) { return { status: 0, body: '', err: e.message }; }
};
const strip = h => h.replace(/<script[\s\S]*?<\/script>/g,' ').replace(/<style[\s\S]*?<\/style>/g,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

console.log('##### KEKA 1783b page (techjays) — shell or real? #####');
const a = await get('https://techjays.keka.com/careers/');
console.log('final url:', a.url, '| status', a.status);
console.log(strip(a.body).slice(0, 700));

console.log('\n##### KEKA wingify — full text, looking for job rows #####');
const w = await get('https://wingify.keka.com/careers/');
console.log(strip(w.body).slice(0, 900));

console.log('\n##### KEKA: jobdetails / json attempts on wingify #####');
for (const p of ['careers/api/jobs','api/careers/jobs','careers/jobs.json','api/jobs','careers/api/embedjobs/all']) {
  const r = await get(`https://wingify.keka.com/${p}`);
  console.log(`  ${String(r.status).padEnd(4)} /${p}  ${r.body.length}b  ${r.body.slice(0,80).replace(/\s+/g,' ')}`);
}

console.log('\n##### KEKA robots.txt #####');
const kr = await get('https://wingify.keka.com/robots.txt');
console.log(kr.status, kr.body.slice(0, 400));

console.log('\n##### ZOHO RECRUIT: what is that 2592b body? #####');
const z = await get('https://hyscaler.zohorecruit.in/jobs/Careers');
console.log('final url:', z.url, '| status', z.status);
console.log(z.body.slice(0, 1200));
