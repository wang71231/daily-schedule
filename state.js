// Shared by the browser and the hosted API. No user data is bundled here.
(() => {
  const empty = () => ({logs:{}, extraCourses:[], historyHours:'0', trainingRate:'0'});
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const equal = (a,b) => {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b,k) && equal(a[k],b[k]));
  };
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  }
  function validate(state) {
    if (!object(state) || Object.keys(state).sort().join() !== 'extraCourses,historyHours,logs,trainingRate' ||
        !object(state.logs) || !Array.isArray(state.extraCourses)) throw Error('课时数据结构不正确');
    if (Object.keys(state.logs).length > 10000 || state.extraCourses.length > 3000) throw Error('记录数量超出上限');
    for (const [key,item] of Object.entries(state.logs)) {
      if (!object(item) || key.length > 160 || !validDate(item.date) || typeof item.code !== 'string' ||
          key !== `${item.date}|${item.code}` || !['pending','done','leave','cancel'].includes(item.status) ||
          !Number.isFinite(item.hours) || item.hours < 0 || item.hours > 1000000 ||
          typeof item.name !== 'string' || !Number.isInteger(item.day) || item.day < 0 || item.day > 6) {
        throw Error('课时记录格式或日期不正确，未覆盖现有数据');
      }
    }
    const codes = new Set();
    for (const item of state.extraCourses) {
      if (!object(item) || typeof item.code !== 'string' || !item.code || codes.has(item.code) ||
          !validDate(item.date) || typeof item.name !== 'string' ||
          typeof item.time !== 'string' || !/^\d{2}:\d{2}–\d{2}:\d{2}$/.test(item.time) ||
          !Number.isInteger(item.day) || item.day < 0 || item.day > 6) throw Error('临时课程格式不正确');
      codes.add(item.code);
    }
    for (const field of ['historyHours','trainingRate']) {
      if (typeof state[field] !== 'string' || !state[field].trim() || !Number.isFinite(Number(state[field])) ||
          Number(state[field]) < 0 || Number(state[field]) > 1000000) throw Error('课时数值不正确');
    }
    if (new TextEncoder().encode(JSON.stringify(state)).length > 1900000) throw Error('数据过大，请先导出备份');
    return state;
  }
  function fromBackup(data) {
    if (!object(data) || data.format !== 'training-backup' || data.version !== 1) throw Error('不是课时 JSON 备份');
    return validate({logs:data.logs,extraCourses:data.extraCourses,historyHours:String(data.historyHours??0),trainingRate:String(data.trainingRate??0)});
  }
  function backup(state) {
    return {format:'training-backup',version:1,exportedAt:new Date().toISOString(),...state};
  }
  // Three-way merge: only apply actual local changes, including deletions.
  // Unknown baselines never silently choose one of two differing records.
  function merge(base,local,remote,choice) {
    const conflicts=[];
    function pick(b,l,r,path) {
      if (equal(l,r)) return l;
      if (base && equal(l,b)) return r;
      if (base && equal(r,b)) return l;
      if (!base && l === undefined) return r;
      if (!base && r === undefined) return l;
      conflicts.push(path);
      return choice === 'remote' ? r : l;
    }
    function records(b,l,r,prefix) {
      const out={};
      const own=(map,key)=>map&&Object.hasOwn(map,key)?map[key]:undefined;
      for (const key of new Set([...Object.keys(b||{}),...Object.keys(l),...Object.keys(r)])) {
        const value=pick(own(b,key),own(l,key),own(r,key),`${prefix}: ${key}`);
        if (value !== undefined) Object.defineProperty(out,key,{value,enumerable:true,writable:true,configurable:true});
      }
      return out;
    }
    const byCode = items => Object.fromEntries((items||[]).map(item=>[item.code,item]));
    const state = {
      logs:records(base?.logs,local.logs,remote.logs,'课时'),
      extraCourses:Object.values(records(byCode(base?.extraCourses),byCode(local.extraCourses),byCode(remote.extraCourses),'临时课')),
      historyHours:pick(base?.historyHours,local.historyHours,remote.historyHours,'历史课时'),
      trainingRate:pick(base?.trainingRate,local.trainingRate,remote.trainingRate,'单价')
    };
    return {state,conflicts};
  }
  globalThis.ScheduleData={empty,validate,equal,merge,fromBackup,backup};
})();
