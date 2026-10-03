// Requires the isolated localhost:3009 server and synthetic fixtures from test:accounts:db.
// Never connects to the configured deployment or uses real account credentials.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3009';
function client() {
  const cookies = new Map<string, string>();
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, { ...init, redirect: 'manual', headers: { cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...init.headers } });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies.set(kv.slice(0,i), kv.slice(i+1)); }
    return res;
  };
}
async function login(provider: string, username: string, password: string) {
  const send = client();
  const csrf = await (await send('/api/auth/csrf')).json();
  const res = await send(`/api/auth/callback/${provider}`, { method:'POST', headers:{ 'content-type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ csrfToken:csrf.csrfToken, username, password, callbackUrl:base+'/account' }) });
  assert.equal(res.status,302);
  return send;
}
async function main() {
const owner = await login('credentials','account_test_owner','local-owner-test-password');
const own = await owner('/api/accounts'); assert.equal(own.status,200);
const rows: { id: string; name: string; username: string; designation: string; isActive: boolean; permissions: Record<string, string[]> }[] = await own.json(); const target = rows.find(a => a.username === 'account_test_controller');
assert.ok(target && target.name === 'Test Operations', 'Only synthetic local fixture may be mutated');
const body = { name:target.name, username:target.username, designation:target.designation, isActive:target.isActive, permissions:target.permissions };
const patch = async (value: typeof body) => { const r = await owner(`/api/accounts/${target.id}`, { method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify(value) }); assert.equal(r.status,200, await r.text()); };
const custom = await login('credentials', target.username,'local-controller-test-password');
try {
  assert.equal((await custom('/api/accounts')).status,403);
  assert.equal((await custom('/api/accounts', {headers:{'x-account-request-path':'/api/users/me/access','x-account-request-method':'GET'}})).status,403);
  assert.equal((await custom('/api/cn-requests')).status,403);
  assert.equal((await custom('/api/seasons')).status,200, 'Report season selector requires no Season Master management grant');
  assert.equal((await custom('/api/seasons',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  const denied = await custom('/masters/labels'); assert.equal(denied.status,307); assert.equal(denied.headers.get('location'),'/account?unavailable=1');
  const ownPage = await custom('/account?unavailable=1'); assert.equal(ownPage.status,200); assert.ok((await ownPage.text()).includes('Accounts Controller'));
  await patch({...body, permissions:{reports:['read'],cnRequests:['read']}});
  assert.equal((await custom('/api/cn-requests')).status,200,'New grants effective without another login');
  assert.equal((await custom('/api/cn-requests/missing/act',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reject'})})).status,403);
  await patch({...body, permissions:{}});
  assert.equal((await custom('/api/cn-requests')).status,403,'Removed grants effective immediately');
  await patch({...body,isActive:false});
  assert.equal((await custom('/api/users/me/access')).status,401,'Existing session rejected after deactivation');
  const bypass = await login('admin-bypass','','');
  assert.equal((await bypass('/api/accounts')).status,403,'Passwordless owner bypass cannot manage accounts');
  console.log('Live HTTP authorization passed: normal owner, restricted account, direct route, forged headers, read-only CN, live grant changes, deactivation and bypass rejection.');
} finally { await patch(body); }

}
void main();
