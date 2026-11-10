import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=new URL('../dist/',import.meta.url);
await mkdir(output,{recursive:true});
for(const name of ['index.html','training.html','university.html','users.html','state.js','storage.js','glass.css','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png']){
  if(name.endsWith('.html')){
    let html=await readFile(root+name,'utf8');
    html=html.replace('<head>','<head><script>window.SERVER_MODE=true;</script>');
    // training.html has <head> on a separate line as well; replacement is literal and checked below.
    if(!html.includes('window.SERVER_MODE=true;'))throw Error('Missing <head>: '+name);
    if(name==='training.html')html=html.replace('</body>',"<script src='/server-mode.js'></script></body>");
    if(name==='index.html')html=html.replace('</section>','<a href="/users.html"><strong>用户管理</strong><span>修改登录密码</span></a></section>');
    await writeFile(new URL(name,output),html);
  }else await copyFile(root+name,new URL(name,output));
}
await copyFile(root+'server/server-mode.js',new URL('server-mode.js',output));
console.log('Built authenticated assets (no database, backups or secrets).');
