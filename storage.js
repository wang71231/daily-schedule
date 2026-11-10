// A whole edit (records + extra courses + sync metadata) commits in one transaction.
// Transactions also serialize read/modify/write across browser tabs.
(() => {
  const D=ScheduleData;
  const keys={logs:'trainingLogs',extraCourses:'extraTrainingCourses',historyHours:'historyHours',trainingRate:'trainingRate'};
  const channel=typeof BroadcastChannel==='function' ? new BroadcastChannel('daily-schedule-data-v1') : null;
  let db, current, active=0;
  function legacy() {
    const state=D.empty();
    for (const [field,key] of Object.entries(keys)) {
      const raw=localStorage.getItem(key);
      if (raw !== null) state[field]=field==='logs'||field==='extraCourses' ? JSON.parse(raw) : raw;
    }
    return D.validate(state);
  }
  function rawLegacy() {
    return Object.fromEntries([...Object.values(keys),'trainingLogsLastGood','scheduleDirty','scheduleServerRevision'].map(k=>[k,localStorage.getItem(k)]));
  }
  const legacyFingerprint=()=>JSON.stringify(Object.values(keys).map(k=>localStorage.getItem(k)));
  function publish(doc) {
    if (!current || doc.version >= current.version) {
      current=doc;
      window.dispatchEvent(new CustomEvent('schedule-data',{detail:structuredClone(doc)}));
    }
  }
  function transaction(edit, reason, extraSnapshot) {
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['current','history'],'readwrite');
      active++;
      let next, error;
      tx.objectStore('current').get('main').onsuccess=e=>{
        try {
          const previous=e.target.result;
          next=edit(structuredClone(previous));
          if (!next) {next=previous;return;}
          D.validate(next.state);
          if (previous && !D.equal(previous.state,next.state)) {
            tx.objectStore('history').add({at:new Date().toISOString(),reason:reason||'修改前',state:previous.state});
          }
          if(extraSnapshot)tx.objectStore('history').add({at:new Date().toISOString(),...extraSnapshot});
          next.version=(previous?.version||0)+1;
          next.updatedAt=new Date().toISOString();
          tx.objectStore('current').put(next,'main');
          tx.objectStore('history').getAllKeys().onsuccess=event=>{
            for (const id of event.target.result.slice(0,-100)) tx.objectStore('history').delete(id);
          };
        } catch(err) {error=err;tx.abort();}
      };
      tx.oncomplete=()=>{active--;publish(next);channel?.postMessage('changed');resolve(structuredClone(next));};
      tx.onabort=()=>{active--;reject(error||tx.error||Error('保存失败，原数据未改变'));};
      tx.onerror=()=>{}; // onabort reports the error once, without a partial commit.
    });
  }
  async function refresh() {
    await ready;
    return new Promise((resolve,reject)=>{
      const request=db.transaction('current').objectStore('current').get('main');
      request.onsuccess=()=>{publish(request.result);resolve(structuredClone(request.result));};
      request.onerror=()=>reject(request.error);
    });
  }
  const ready=new Promise((resolve,reject)=>{
    const request=indexedDB.open('daily-schedule-v1',1);
    request.onupgradeneeded=()=>{
      request.result.createObjectStore('current');
      request.result.createObjectStore('history',{keyPath:'id',autoIncrement:true});
    };
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(Error('请关闭其他旧版课表页面后重试'));
    request.onsuccess=async()=>{
      db=request.result;
      db.onversionchange=()=>db.close();
      try {
        await transaction(previous=>{
          if (previous) return null;
          return {state:legacy(),version:0,dirty:true,base:null,serverRevision:null,serverId:null,legacyFingerprint:legacyFingerprint()};
        },'首次迁移');
        // Retain the old keys untouched. Import the old one-step recovery copy too.
        const tx=db.transaction(['current','history'],'readwrite');
        tx.objectStore('current').get('legacy-imported').onsuccess=e=>{
          if (e.target.result) return;
          try {
            const last=localStorage.getItem('trainingLogsLastGood');
            if (last) {
              const old=D.validate({...legacy(),logs:JSON.parse(last)});
              tx.objectStore('history').add({at:new Date().toISOString(),reason:'升级前的上次记录',state:old});
            }
          } catch { /* Invalid legacy recovery data remains available in raw export. */ }
          tx.objectStore('current').put(true,'legacy-imported');
        };
        tx.oncomplete=()=>resolve(structuredClone(current));
        tx.onabort=()=>reject(tx.error);
      } catch(error) {reject(error);}
    };
  });
  async function change(edit,reason='编辑前') {
    await ready;
    return transaction(doc=>{edit(doc.state);doc.dirty=true;return doc;},reason);
  }
  async function setRemote(remote, expectedVersion, mergedState) {
    await ready;
    return transaction(doc=>{
      if (doc.version !== expectedVersion) throw Error('记录刚刚发生变化，请重试同步');
      doc.state=structuredClone(mergedState||remote.state);
      doc.base=structuredClone(remote.state);
      doc.serverRevision=remote.revision;
      doc.serverId=remote.serverId||'legacy-server';
      doc.dirty=!D.equal(doc.state,remote.state);
      return doc;
    },'同步/合并前');
  }
  async function acknowledge(sent,remote) {
    await ready;
    return transaction(doc=>{
      if (doc.serverId !== sent.serverId || doc.serverRevision !== sent.serverRevision) return null;
      doc.base=structuredClone(sent.state);
      doc.serverRevision=remote.revision;
      doc.dirty=!D.equal(doc.state,sent.state);
      return doc;
    });
  }
  async function history() {
    await ready;
    return new Promise((resolve,reject)=>{
      const request=db.transaction('history').objectStore('history').getAll();
      request.onsuccess=()=>resolve(request.result.reverse());
      request.onerror=()=>reject(request.error);
    });
  }
  async function checkLegacy() {
    await ready;
    if(current.legacyFingerprint!==legacyFingerprint())window.dispatchEvent(new Event('schedule-legacy-changed'));
  }
  async function importLegacy() {
    await ready;
    const old=legacy(),fingerprint=legacyFingerprint();
    return transaction(doc=>{
      doc.state.logs={...old.logs,...doc.state.logs};
      doc.state.extraCourses=[...new Map([...old.extraCourses,...doc.state.extraCourses].map(c=>[c.code,c])).values()];
      if(Number(doc.state.historyHours)===0)doc.state.historyHours=old.historyHours;
      // Preserve even conflicting old records as a downloadable historical snapshot.
      doc.legacyFingerprint=fingerprint;doc.dirty=true;return doc;
    },'合并旧版页面前',{reason:'旧版页面原始快照',state:old});
  }
  channel?.addEventListener('message',()=>refresh().catch(()=>{}));
  window.addEventListener('focus',()=>{refresh().catch(()=>{});checkLegacy().catch(()=>{});});
  window.addEventListener('storage',e=>{if(Object.values(keys).includes(e.key))checkLegacy().catch(()=>{});});
  ready.then(()=>checkLegacy()).catch(()=>{});
  window.addEventListener('beforeunload',e=>{if(active){e.preventDefault();e.returnValue='保存尚未完成';}});
  globalThis.ScheduleStore={ready,refresh,change,setRemote,acknowledge,history,rawLegacy,importLegacy,
    current:()=>structuredClone(current),busy:()=>active>0};
})();
