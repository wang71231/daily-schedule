import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{passwordHash} from '../cloudflare/worker.mjs';

// SQLite-backed D1 adapter: real SQL and transactions, only the platform transport is substituted.
class D1 {
  constructor(sqlite){this.db=sqlite;}
  prepare(sql){
    const db=this.db;
    const make=args=>({
      bind:(...next)=>make(next),
      first:async()=>db.prepare(sql).get(...args)||null,
      all:async()=>({results:db.prepare(sql).all(...args)}),
      run:async()=>({meta:{changes:Number(db.prepare(sql).run(...args).changes)}})
    });
    return make([]);
  }
  async batch(statements){
    this.db.exec('BEGIN IMMEDIATE');
    try{const results=[];for(const statement of statements)results.push(await statement.run());this.db.exec('COMMIT');return results;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
let sqlite,env,cookie,csrf,serverId;
const password='isolated-test-password';
const D=globalThis.ScheduleData;
function record(code,hours=1){return {date:'2026-11-10',day:2,code,name:code,room:'test',time:'09:00–10:00',status:'done',hours};}
function request(path,method='GET',body,extra={}){
  return worker.fetch(new Request('https://test.invalid'+path,{
    method,headers:{Cookie:cookie||'','X-CSRF-Token':csrf||'','CF-Connecting-IP':'192.0.2.1',...extra},
    body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)
  }),env);
}
async function login(p=password){
  const r=await request('/api/login','POST','password='+encodeURIComponent(p));
  if(r.status===303){cookie=r.headers.get('Set-Cookie').split(';')[0];const data=await(await request('/api/state')).json();csrf=data.csrf;serverId=data.serverId;}
  return r;
}
async function put(revision,state,id=serverId){return request('/api/state','POST',{revision,state,serverId:id});}
beforeEach(async()=>{
  sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../cloudflare/schema.sql',import.meta.url),'utf8'));
  env={DB:new D1(sqlite),SCHEDULE_PASSWORD_HASH:await passwordHash(password),ASSETS:{fetch:async()=>new Response('test asset')}};
  cookie='';csrf='';serverId='';
});
afterEach(()=>sqlite.close());

test('login protects pages/API and sets secure HttpOnly cookie',async()=>{
  assert.equal((await request('/training.html')).status,302);
  assert.equal((await request('/api/state')).status,401);
  const r=await login();assert.equal(r.status,303);
  assert.match(r.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await request('/training.html')).status,200);
});
test('every accepted update retains the previous full state; stale device cannot overwrite',async()=>{
  await login();const state=D.empty();state.logs['2026-11-10|A']=record('A');
  assert.equal((await put(0,state)).status,200);
  assert.equal((await put(0,D.empty())).status,409);
  assert.equal((await put(1,D.empty())).status,200);
  const saved=await(await request('/api/history?revision=1')).json();
  assert.equal(saved.logs['2026-11-10|A'].hours,1);
  assert.equal(saved.format,'training-backup');
  assert.equal((await(await request('/api/state')).json()).revision,2);
});
test('malformed data and wrong database identity never overwrite records',async()=>{
  await login();const invalid=D.empty();invalid.logs.bad={status:'done'};
  assert.equal((await put(0,invalid)).status,400);
  assert.equal((await put(0,D.empty(),'wrong-db')).status,409);
  assert.equal((await request('/api/state','POST','{bad')).status,400);
  const current=await(await request('/api/state')).json();assert.equal(current.revision,0);
});
test('history and current state roll back together on a storage failure',async()=>{
  await login();sqlite.exec("CREATE TRIGGER simulated_failure BEFORE UPDATE ON schedule_state BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END;");
  assert.equal((await put(0,D.empty())).status,500);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM schedule_history').get().n,0);
  assert.equal((await(await request('/api/state')).json()).revision,0);
});
test('five failures are rate limited; expiry releases the lock',async()=>{
  for(let i=0;i<5;i++)assert.equal((await login('wrong')).status,403);
  assert.equal((await login()).status,429);
  sqlite.exec('UPDATE login_attempts SET expires=0');
  assert.equal((await login()).status,303);
});
test('password changes invalidate all sessions without deleting hours',async()=>{
  await login();const state=D.empty();state.logs['2026-11-10|A']=record('A');await put(0,state);
  assert.equal((await request('/api/password','POST',{oldPassword:password,newPassword:'12345'})).status,400);
  assert.equal((await request('/api/password','POST',{oldPassword:password,newPassword:'test-new-password'})).status,200);
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await login()).status,403);
  assert.equal((await login('test-new-password')).status,303);
  assert.deepEqual((await(await request('/api/state')).json()).state,state);
});
test('CSRF and cross origin writes are refused',async()=>{
  await login();
  assert.equal((await request('/api/state','POST',{revision:0,state:D.empty(),serverId},{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await request('/api/login','POST','password='+password,{Origin:'https://attacker.invalid'})).status,403);
});
test('three-way merge preserves independent edits and intentional deletion',()=>{
  const base=D.empty();base.logs['2026-11-10|A']=record('A');
  const local=structuredClone(base);delete local.logs['2026-11-10|A'];local.logs['2026-11-10|B']=record('B');
  const remote=structuredClone(base);remote.logs['2026-11-10|C']=record('C');
  const merged=D.merge(base,local,remote);assert.deepEqual(merged.conflicts,[]);
  assert.deepEqual(Object.keys(merged.state.logs).sort(),['2026-11-10|B','2026-11-10|C']);
});
test('editing vs deletion conflicts until an explicit choice; input property order irrelevant',()=>{
  const base=D.empty();base.logs['2026-11-10|A']=record('A');
  const local=structuredClone(base);delete local.logs['2026-11-10|A'];
  const remote=structuredClone(base);remote.logs['2026-11-10|A'].hours=2;
  assert.equal(D.merge(base,local,remote).conflicts.length,1);
  assert.equal(D.merge(base,local,remote,'remote').state.logs['2026-11-10|A'].hours,2);
  assert.deepEqual(D.merge(base,local,remote,'local').state.logs,{});
  assert.ok(D.equal({a:1,b:2},{b:2,a:1}));
});
