(() => {
  const D=ScheduleData,S=ScheduleStore;
  const panel=document.createElement('div');
  panel.id='syncStatus';panel.setAttribute('role','status');
  panel.style.cssText='margin:0 0 14px;padding:12px;border:1px solid #d9dfed;border-radius:12px;background:#f5f7fc;font-size:13px;line-height:1.6';
  document.querySelector('.worklog').prepend(panel);
  let csrf='',running=false,paused=false,timer;
  const show=(message,actions=[])=>{
    panel.replaceChildren(document.createTextNode(message));
    for(const [title,handler] of actions){
      const button=document.createElement('button');button.textContent=title;
      button.style.cssText='margin:5px 0 0 8px;min-height:32px;padding:5px 9px;font-size:12px';
      button.onclick=handler;panel.append(button);
    }
  };
  async function api(url,options={}) {
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000),...options});
    if(response.status===401)throw Error('登录已过期，本机记录仍保留，请重新登录');
    return response;
  }
  const hasData=s=>Object.keys(s.logs).length||s.extraCourses.length||Number(s.historyHours)>0;
  function pause(remote,message) {
    paused=true;
    show(message,[
      ['备份本机',()=>exportState(S.current().state)],
      ['备份云端',()=>exportState(remote.state,'云端课时备份')],
      ['合并，冲突保留本机',()=>{if(confirm('合并所有不冲突的记录；冲突的记录采用本机版本（含删除）。继续？'))sync('local');}],
      ['合并，冲突保留云端',()=>{if(confirm('合并所有不冲突的记录；冲突的记录采用云端版本（含删除）。继续？'))sync('remote');}]
    ]);
  }
  async function run(choice) {
    if(running||paused&&!choice)return;
    running=true;paused=false;
    try {
      await S.ready;
      let response=await api('/api/state');
      if(!response.ok)throw Error(`读取失败（${response.status}）`);
      const remote=await response.json();D.validate(remote.state);
      if(!Number.isSafeInteger(remote.revision)||remote.revision<0||typeof remote.csrf!=='string')throw Error('云端返回格式不正确');
      csrf=remote.csrf;
      let doc=await S.refresh();
      const identity=remote.serverId||'legacy-server';
      const changedServer=doc.serverId && doc.serverId!==identity;
      const rollback=doc.serverRevision!==null && remote.revision<doc.serverRevision;
      const inconsistent=doc.base && remote.revision===doc.serverRevision && !D.equal(doc.base,remote.state);
      if((changedServer||rollback||inconsistent)&&!choice){
        pause(remote,'云端来源或版本发生变化，已暂停覆盖。请先备份两端，再选择合并。');return;
      }
      if(!doc.base&&hasData(doc.state)&&!hasData(remote.state)&&!choice){
        paused=true;
        show('云端尚无记录，本机有数据。先备份，再上传本机记录。',[
          ['备份本机',()=>exportState(S.current().state)],
          ['上传本机记录',()=>{if(confirm('将本机记录上传到当前空云端？'))sync('local');}]
        ]);return;
      }
      const base=changedServer||rollback||inconsistent?null:doc.base;
      const merged=!doc.base&&D.equal(doc.state,D.empty())
        ? {state:remote.state,conflicts:[]}
        : D.merge(base,doc.state,remote.state,choice);
      if(merged.conflicts.length&&!choice){
        pause(remote,`有 ${merged.conflicts.length} 项两端改动冲突，已暂停自动覆盖。${merged.conflicts.slice(0,3).join('；')}`);return;
      }
      doc=await S.setRemote(remote,doc.version,merged.state);
      if(!doc.dirty){show(`已同步到云端 · 版本 ${remote.revision}`);return;}
      show('本机已保存，正在上传云端…');
      const sent=doc;
      response=await api('/api/state',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
        body:JSON.stringify({revision:sent.serverRevision,serverId:identity,state:sent.state})
      });
      if(response.status===409){show('其他设备刚更新了记录，正在重新合并…');queue(1000);return;}
      if(!response.ok)throw Error(`上传失败（${response.status}）`);
      const result=await response.json();
      if(result.revision!==sent.serverRevision+1)throw Error('云端确认版本不正确，本机更改保留');
      const latest=await S.acknowledge(sent,result);
      show(latest.dirty?'本机还有新更改，继续同步…':`已同步到云端 · 版本 ${result.revision}`);
      if(latest.dirty)queue();
    }catch(error){
      show(`${error.message}。未同步的修改保留在本机。`,[['重试',()=>sync()],['重新登录',()=>{location.href='/login';}]]);
    }finally{running=false;}
  }
  async function sync(choice) {
    if(choice)paused=false;
    if(navigator.locks){
      await navigator.locks.request('daily-schedule-sync',{ifAvailable:true},async lock=>{if(lock)await run(choice);});
    }else await run(choice);
  }
  function queue(delay=500){clearTimeout(timer);timer=setTimeout(()=>sync(),delay);}
  window.scheduleBackend={queue};
  window.addEventListener('online',()=>queue());
  window.addEventListener('focus',()=>queue());
  setInterval(()=>{if(!paused)sync();},30000);
  const logout=document.createElement('button');logout.textContent='退出登录';
  logout.onclick=async()=>{
    if(S.current()?.dirty&&!confirm('有尚未上传的本机记录，确认退出登录？记录仍保留在此浏览器。'))return;
    try{await api('/api/logout',{method:'POST',headers:{'X-CSRF-Token':csrf}});location.href='/login';}catch(error){show(error.message);}
  };
  panel.before(logout);
  const historyButton=document.createElement('button');historyButton.textContent='云端保存历史';historyButton.style.marginLeft='8px';
  historyButton.onclick=async()=>{
    try{
      const response=await api('/api/history');
      if(!response.ok)throw Error('此入口暂不支持云端历史，请使用本机保存历史');
      const {history}=await response.json();
      const list=document.getElementById('historyList');list.replaceChildren();
      if(!history.length)list.textContent='云端尚无历史版本。每次上传前都会保留旧版本。';
      for(const item of history){
        const row=document.createElement('p');row.textContent=`云端版本 ${item.revision} · ${new Date(item.updated_at).toLocaleString()} `;
        const download=document.createElement('button');download.textContent='下载备份';
        const get=async()=>{const r=await api('/api/history?revision='+item.revision);if(!r.ok)throw Error('读取历史失败');return D.fromBackup(await r.json());};
        download.onclick=async()=>{try{exportState(await get(),'云端历史-'+item.revision);}catch(error){alert(error.message);}};
        const restore=document.createElement('button');restore.textContent='恢复此版本';restore.style.marginLeft='8px';
        restore.onclick=async()=>{
          try{
            const state=await get();
            if(!confirm(`恢复云端版本 ${item.revision} 的完整数据？当前本机版本会先保存在本机历史中，再按同步规则上传。`))return;
            if(await editState(s=>Object.assign(s,state),'恢复云端历史前'))document.getElementById('historyDialog').close();
          }catch(error){alert(error.message);}
        };
        row.append(download,restore);list.append(row);
      }
      document.getElementById('historyDialog').showModal();
    }catch(error){alert(error.message);}
  };
  panel.before(historyButton);
  S.ready.then(()=>sync()).catch(error=>show(`本机数据读取失败，已暂停同步：${error.message}`));
})();
