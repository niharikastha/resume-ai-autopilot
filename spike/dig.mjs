const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const get = async (url, hdr={}) => {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...hdr }, signal: AbortSignal.timeout(20000) });
    return { status: r.status, ct: (r.headers.get('content-type')||'').split(';')[0], body: await r.text() };
  } catch (e) { return { status: 0, ct: '', body: '', err: e.message }; }
};

console.log('===== KEKA wingify shell =====');
const k = await get('https://wingify.keka.com/careers/');
console.log(k.body.slice(0, 2500));

console.log('\n===== KEKA: hunt for api routes in the JS bundle =====');
const scripts = [...k.body.matchAll(/src="([^"]+\.js[^"]*)"/g)].map(m => m[1]);
console.log('scripts:', scripts);
for (const s of scripts.slice(0, 4)) {
  const u = s.startsWith('http') ? s : new URL(s, 'https://wingify.keka.com/careers/').href;
  const js = await get(u);
  const apis = [...new Set([...js.body.matchAll(/["'`](\/?api\/[a-zA-Z0-9_\-\/{}$.]+)["'`]/g)].map(m => m[1]))];
  console.log(`\n${u}  (${js.body.length}b) ->`, apis.slice(0, 40));
}
