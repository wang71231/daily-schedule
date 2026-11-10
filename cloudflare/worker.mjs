import '../state.js';

const D=globalThis.ScheduleData;
const encoder=new TextEncoder();
const TYPES={html:'text/html; charset=utf-8',json:'application/json; charset=utf-8'};
const HEADERS={
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff',
  // Form POSTs with no-referrer may send Origin:null, breaking strict same-origin validation.
  'Referrer-Policy':'same-origin',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security':'max-age=31536000'
};
const files=new Set(['/','/index.html','/training.html','/university.html','/users.html','/state.js','/storage.js','/server-mode.js','/glass.css','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png']);
const login=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>课表登录</title><style>body{font:16px system-ui;background:#f5f7fa;display:grid;place-items:center;min-height:90vh;color:#263343}main{width:min(340px,85vw);padding:24px;background:white;border-radius:20px}input,button{box-sizing:border-box;width:100%;padding:13px;font:inherit;margin:8px 0;border:1px solid #ccd2df;border-radius:10px}button{background:#59679f;color:white}</style><main><h1>我的课表</h1><p>登录后同步课时记录。</p><form action="/api/login" method="post"><input aria-label="登录密码" name="password" type="password" autocomplete="current-password" required maxlength="128"><button>登录</button></form></main></html>`;

function response(status,body,type='json',extra={}) {
  return new Response(type==='json'?JSON.stringify(body):body,{status,headers:{...HEADERS,'Content-Type':TYPES[type]||type,...extra}});
}
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const unhex=s=>Uint8Array.from(s.match(/../g)||[],b=>parseInt(b,16));
const token=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
async function digest(value){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
async function derive(password,salt,iterations){
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:unhex(salt),iterations},key,256));
}
export async function passwordHash(password){
  const salt=token().slice(0,32);
  return `pbkdf2_sha256$100000$${salt}$${hex(await derive(password,salt,100000))}`;
}
async function verify(password,stored){
  const [algorithm,rounds,salt,expected]=stored.split('$');
  // Workerd's PBKDF2 limit is 100,000. Unsupported hashes fail closed.
  if(algorithm!=='pbkdf2_sha256'||Number(rounds)!==100000||!/^[a-f0-9]{32}$/.test(salt)||!/^[a-f0-9]{64}$/.test(expected))return false;
  const actual=await derive(password,salt,100000),expectedBytes=unhex(expected);
  return actual.reduce((diff,b,i)=>diff|(b^expectedBytes[i]),0)===0;
}
async function readBody(request){
  if(Number(request.headers.get('Content-Length')||0)>2000000)throw Error('body_too_large');
  const reader=request.body?.getReader();let size=0;const chunks=[];
  if(!reader)return '';
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw Error('body_too_large');}chunks.push(value);}
  const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(all);
}
async function limited(db,key){
  const now=Math.floor(Date.now()/1000);
  await db.prepare('DELETE FROM login_attempts WHERE expires<=?').bind(now).run();
  const row=await db.prepare('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=min(attempts+1,6) RETURNING attempts,expires').bind(key,now+300).first();
  return row.attempts>5?Math.max(1,row.expires-now):0;
}
async function getSession(request,db){
  const value=request.headers.get('Cookie')?.match(/(?:^|;\s*)schedule_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(!value)return null;
  const hash=await digest(value);
  const session=await db.prepare('SELECT * FROM auth_sessions WHERE token_hash=? AND expires>?').bind(hash,Math.floor(Date.now()/1000)).first();
  return session;
}
async function currentPassword(env){
  return (await env.DB.prepare('SELECT password_hash FROM auth_config WHERE id=1').first())?.password_hash||env.SCHEDULE_PASSWORD_HASH||'';
}
async function handle(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/sw.js')return response(200,"self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('daily-schedule-')).map(k=>caches.delete(k)))).then(()=>self.registration.unregister())));",'application/javascript');
  if(request.method==='GET'&&path==='/login')return response(200,login,'html');
  if(request.method!=='GET'&&request.method!=='POST')return response(405,{error:'method_not_allowed'});
  if(request.method==='POST'){
    const origin=request.headers.get('Origin');
    if(origin&&origin!==url.origin)return response(403,{error:'origin_mismatch'});
  }
  const rateKey=await digest(request.headers.get('CF-Connecting-IP')||'unknown-client');
  if(request.method==='POST'&&path==='/api/login'){
    const wait=await limited(env.DB,rateKey);
    if(wait)return response(429,`尝试过多，请 ${wait} 秒后重试。`,'text/plain; charset=utf-8',{'Retry-After':String(wait)});
    const password=new URLSearchParams(await readBody(request)).get('password')||'';
    const stored=await currentPassword(env);
    if(!stored)return response(503,'网站正在配置，请稍后再试。','text/plain; charset=utf-8');
    if(password.length>128||!await verify(password,stored))return response(403,'密码错误','text/plain; charset=utf-8');
    const value=token(),hash=await digest(value),csrf=token(),now=Math.floor(Date.now()/1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(rateKey),
      env.DB.prepare('DELETE FROM auth_sessions WHERE expires<=?').bind(now),
      env.DB.prepare('INSERT INTO auth_sessions VALUES (?,?,?)').bind(hash,csrf,now+14*86400)
    ]);
    return response(303,'','text/plain',{'Location':'/','Set-Cookie':`schedule_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600`});
  }
  const session=await getSession(request,env.DB);
  if(!session)return path.startsWith('/api/')?response(401,{error:'login_required'}):response(302,'','text/plain',{'Location':'/login'});
  if(request.method==='GET'){
    if(path==='/api/state'){
      const row=await env.DB.prepare('SELECT * FROM schedule_state WHERE id=1').first();
      return response(200,{revision:row.revision,state:JSON.parse(row.content),serverId:row.server_id,csrf:session.csrf});
    }
    if(path==='/api/history'){
      const revision=url.searchParams.get('revision');
      if(revision!==null){
        if(!/^\d+$/.test(revision))return response(400,{error:'invalid_revision'});
        const row=await env.DB.prepare('SELECT * FROM schedule_history WHERE revision=?').bind(Number(revision)).first();
        return row?response(200,{revision:row.revision,updatedAt:row.updated_at,...D.backup(JSON.parse(row.content))}):response(404,{error:'not_found'});
      }
      const rows=await env.DB.prepare('SELECT revision,updated_at FROM schedule_history ORDER BY revision DESC LIMIT 100').all();
      return response(200,{history:rows.results});
    }
    if(!files.has(path))return response(404,{error:'not_found'});
    const assetUrl=new URL(request.url);if(path==='/')assetUrl.pathname='/index.html';
    const asset=await env.ASSETS.fetch(new Request(assetUrl,request));
    const headers=new Headers(asset.headers);for(const [k,v] of Object.entries(HEADERS))headers.set(k,v);
    return new Response(asset.body,{status:asset.status,headers});
  }
  if(request.headers.get('X-CSRF-Token')!==session.csrf)return response(403,{error:'csrf_failed'});
  if(path==='/api/logout'){
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(session.token_hash).run();
    return response(200,{ok:true},'json',{'Set-Cookie':'schedule_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'});
  }
  if(path==='/api/password'){
    const wait=await limited(env.DB,rateKey);
    if(wait)return response(429,{error:`请 ${wait} 秒后重试`},'json',{'Retry-After':String(wait)});
    const {oldPassword,newPassword}=JSON.parse(await readBody(request));
    if(typeof newPassword!=='string'||newPassword.length<6||newPassword.length>128)return response(400,{error:'新密码需要6–128个字符'});
    const before=await currentPassword(env);
    if(typeof oldPassword!=='string'||oldPassword.length>128||!await verify(oldPassword,before))return response(403,{error:'原密码错误'});
    const next=await passwordHash(newPassword);
    // Compare the old hash in SQL too: a simultaneous change cannot overwrite a newer password.
    const results=await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO auth_config VALUES (1,?)').bind(before),
      env.DB.prepare('UPDATE auth_config SET password_hash=? WHERE id=1 AND password_hash=?').bind(next,before),
      env.DB.prepare('DELETE FROM auth_sessions WHERE EXISTS(SELECT 1 FROM auth_config WHERE id=1 AND password_hash=?)').bind(next),
      env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(rateKey)
    ]);
    return results[1].meta.changes?response(200,{ok:true}):response(409,{error:'密码已被其他设备修改，请重新登录'});
  }
  if(path==='/api/state'){
    const payload=JSON.parse(await readBody(request));
    if(!Number.isSafeInteger(payload.revision)||payload.revision<0||typeof payload.serverId!=='string')return response(400,{error:'invalid_revision'});
    try{D.validate(payload.state);}catch(error){return response(400,{error:error.message});}
    const now=new Date().toISOString();
    const results=await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO schedule_history SELECT revision,content,updated_at FROM schedule_state WHERE id=1 AND revision=? AND server_id=?').bind(payload.revision,payload.serverId),
      env.DB.prepare('UPDATE schedule_state SET revision=revision+1,content=?,updated_at=? WHERE id=1 AND revision=? AND server_id=?').bind(JSON.stringify(payload.state),now,payload.revision,payload.serverId)
    ]);
    if(!results[1].meta.changes)return response(409,{error:'revision_conflict'});
    return response(200,{revision:payload.revision+1});
  }
  return response(404,{error:'not_found'});
}

export default {
  async fetch(request,env){
    // D1 sessions pin reads to primary after writes, avoiding stale replicas in sync decisions.
    const db=typeof env.DB.withSession==='function'?env.DB.withSession('first-primary'):env.DB;
    try{return await handle(request,{...env,DB:db});}
    catch(error){
      if(error.message==='body_too_large')return response(413,{error:'body_too_large'});
      if(error instanceof SyntaxError)return response(400,{error:'invalid_json'});
      console.error('schedule request failed',error.name); // Never log bodies, cookies or passwords.
      return response(500,{error:'server_error'});
    }
  }
};
