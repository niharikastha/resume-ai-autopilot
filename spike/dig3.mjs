const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const get = async u => { try { const r = await fetch(u,{headers:{'User-Agent':UA},signal:AbortSignal.timeout(25000)});
  return {status:r.status,url:r.url,body:await r.text()}; } catch(e){ return {status:0,body:'',err:e.message}; } };
const strip = h => h.replace(/<script[\s\S]*?<\/script>/g,' ').replace(/<style[\s\S]*?<\/style>/g,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

console.log('##### 1. KEKA embedjobs widget — real job data? #####');
for (const t of ['wingify','nyusoft','sedin','peerbits','simform']) {
  const r = await get(`https://${t}.keka.com/careers/api/embedjobs/all`);
  const isNotFound = /Invalid Tenant|TenantNotFound/i.test(r.body);
  const txt = strip(r.body);
  console.log(`\n--- ${t}: ${r.status} ${r.body.length}b ${isNotFound?'[INVALID TENANT]':''}`);
  if (!isNotFound) console.log('    ', txt.slice(0, 320));
  const j = [...r.body.matchAll(/"(?:jobTitle|title)"\s*:\s*"([^"]{4,70})"/g)].map(m=>m[1]);
  if (j.length) console.log('    JSON titles found:', j.slice(0,8));
}

console.log('\n\n##### 2. ZOHO RECRUIT via live demo tenant (zylker) #####');
const z = await get('https://zylker.zohorecruit.com/jobs/Careers');
console.log('status', z.status, z.body.length, 'b');
const zt = [...z.body.matchAll(/"(?:Posting_Title|jobTitle|title)"\s*:\s*"([^"]{4,70})"/g)].map(m=>m[1]);
console.log('embedded JSON titles:', zt.slice(0,10));
console.log('text sample:', strip(z.body).slice(0, 400));
const zapi = [...new Set([...z.body.matchAll(/(https?:\/\/[a-z0-9.\-]*zoho[^"'\s)]*|\/recruit\/[A-Za-z0-9_\-\/.]+)/g)].map(m=>m[1]))].filter(u=>/api|json|Portal|getJob|Careers/i.test(u));
console.log('candidate API urls:', zapi.slice(0,15));

console.log('\n\n##### 3. SMARTRECRUITERS — India volume for big GCC employers #####');
for (const co of ['BoschGroup','Visa','Publicis','McDonalds','Sanofi','Ubisoft','IKEA','LinkedIn']) {
  const r = await get(`https://api.smartrecruiters.com/v1/companies/${co}/postings?country=in&limit=100`);
  if (r.status !== 200) { console.log(`  ${co}: ${r.status}`); continue; }
  try { const j = JSON.parse(r.body);
    console.log(`  ${co.padEnd(14)} totalFound(country=in)=${String(j.totalFound).padStart(5)}   e.g. ${(j.content||[]).slice(0,2).map(p=>`${p.name} @ ${p.location?.city}`).join(' | ')}`);
  } catch { console.log(`  ${co}: unparseable`); }
}
