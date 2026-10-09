(() => {
  const root = document.querySelector('main');
  const worklog = document.querySelector('.worklog');
  const panel = document.createElement('div');
  panel.style.cssText = 'margin:0 0 14px;padding:12px 14px;border:1px solid #d9dfed;border-radius:12px;background:#f5f7fc;color:#35415c;font-size:13px;line-height:1.6';
  worklog.prepend(panel);
  const logout = document.createElement('button');
  logout.textContent = '退出登录';
  logout.style.cssText = 'min-height:32px;margin:0 0 10px;padding:5px 9px;border:1px solid #b6bfd7;font-size:12px';
  logout.onclick = async () => {
    if (localStorage.getItem('scheduleDirty') === '1' && !confirm('还有未同步的更改，确认退出登录？')) return;
    await fetch('/api/logout', {method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':csrf}});
    location.href = '/login';
  };
  worklog.prepend(logout);
  let revision = Number(localStorage.getItem('scheduleServerRevision') || 0);
  let csrf = '';
  let timer = null;
  let sending = false;
  let generation = 0;
  let conflict = false;

  function localState() {
    return {
      logs: readJson('trainingLogs', {}),
      extraCourses: readJson('extraTrainingCourses', []),
      historyHours: localStorage.getItem('historyHours') || '0',
      trainingRate: localStorage.getItem('trainingRate') || '0'
    };
  }

  function applyState(state, serverRevision) {
    for (const [field, key] of Object.entries({logs:'trainingLogs', extraCourses:'extraTrainingCourses', historyHours:'historyHours', trainingRate:'trainingRate'})) {
      localStorage.setItem(key, typeof state[field] === 'string' ? state[field] : JSON.stringify(state[field]));
    }
    revision = serverRevision;
    localStorage.setItem('scheduleServerRevision', String(revision));
    localStorage.removeItem('scheduleDirty');
    logs = readJson('trainingLogs', {});
    extraCourses = readJson('extraTrainingCourses', []);
    render();
  }

  function show(message, actions = []) {
    panel.replaceChildren();
    const label = document.createElement('span');
    label.textContent = message;
    panel.append(label);
    for (const [title, handler] of actions) {
      const button = document.createElement('button');
      button.textContent = title;
      button.style.cssText = 'min-height:32px;margin:5px 0 0 8px;padding:5px 9px;border:1px solid #b6bfd7;font-size:12px';
      button.onclick = handler;
      panel.append(button);
    }
  }

  async function fetchState() {
    const response = await fetch('/api/state', {credentials:'same-origin', cache:'no-store'});
    if (response.status === 401) { location.href = '/login'; throw Error('login_required'); }
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function resolveConflict() {
    conflict = true;
    try {
      const remote = await fetchState();
      csrf = remote.csrf;
      show('服务器和本机都有尚未合并的更改，已暂停自动上传。先备份本机数据，再选择合并。', [
        ['备份本机数据', () => document.getElementById('exportBackup').click()],
        ['合并后上传', () => {
          if (!confirm('按日期和课程合并；同一条记录以本机为准。确认已备份后继续？')) return;
          const local = localState();
          const merged = {
            logs: {...remote.state.logs, ...local.logs},
            extraCourses: [...new Map([...remote.state.extraCourses, ...local.extraCourses].map(item => [item.code, item])).values()],
            historyHours: local.historyHours,
            trainingRate: local.trainingRate
          };
          applyState(merged, remote.revision);
          localStorage.setItem('scheduleDirty', '1');
          conflict = false;
          queue();
        }]
      ]);
    } catch {
      show('无法检查服务器版本，本机更改已保留。恢复连接后再试。');
    }
  }

  async function flush() {
    if (sending || conflict || localStorage.getItem('scheduleDirty') !== '1' || !csrf) return;
    sending = true;
    const sentGeneration = generation;
    show('正在同步到服务器…');
    try {
      const response = await fetch('/api/state', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},
        body:JSON.stringify({revision,state:localState()})
      });
      if (response.status === 409) { sending = false; await resolveConflict(); return; }
      if (response.status === 401) { location.href='/login'; return; }
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      revision = (await response.json()).revision;
      localStorage.setItem('scheduleServerRevision', String(revision));
      if (generation === sentGeneration) {
        localStorage.removeItem('scheduleDirty');
        show(`已同步到服务器 · 版本 ${revision}`);
      } else if (localHasData && JSON.stringify(existing) !== JSON.stringify(remote.state)) {
        resolveConflict();
      } else {
        show('有新更改，继续同步…');
      }
    } catch {
      show('网络中断：修改已保存在本机，尚未同步到服务器。', [['立即重试', flush]]);
    } finally {
      sending = false;
      if (!conflict && localStorage.getItem('scheduleDirty') === '1') {
        clearTimeout(timer);
        timer = setTimeout(flush, 10000);
      }
    }
  }

  function queue() {
    generation++;
    localStorage.setItem('scheduleDirty', '1');
    show('本机已保存，等待同步到服务器…');
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  }

  window.scheduleBackend = {queue};
  fetchState().then(remote => {
    csrf = remote.csrf;
    const pending = localStorage.getItem('scheduleDirty') === '1';
    if (pending) {
      if (revision === remote.revision) {
        show('找到本机待同步的更改，正在上传…');
        queue();
      } else {
        resolveConflict();
      }
    } else {
      const existing = localState();
      const remoteEmpty = !Object.keys(remote.state.logs).length && !remote.state.extraCourses.length && Number(remote.state.historyHours) === 0;
      const localHasData = Object.keys(existing.logs).length || existing.extraCourses.length || Number(existing.historyHours) > 0;
      if (remoteEmpty && localHasData) {
        revision = remote.revision;
        localStorage.setItem('scheduleServerRevision', String(revision));
        show('服务器尚无记录，但本机缓存有数据。请先备份，再决定是否上传。', [
          ['备份本机数据', () => document.getElementById('exportBackup').click()],
          ['上传本机记录', () => {
            if (confirm('确认已备份本机记录，并将它们上传到空服务器？')) queue();
          }]
        ]);
      } else {
        applyState(remote.state, remote.revision);
        const count = Object.keys(remote.state.logs).length;
        show(count ? `已从服务器载入 ${count} 条课时记录 · 版本 ${revision}` : '服务器尚无课时记录。如旧记录在 GitHub Pages，请先在那里“备份数据”，再在此页点“恢复备份”导入 JSON。');
      }
    }
  }).catch(() => {
    show('服务器暂时不可用。可查看本机缓存；修改会待网络恢复后同步。', [['立即重试', () => location.reload()]]);
  }).finally(() => { root.style.visibility = 'visible'; });

  setInterval(() => {
    if (localStorage.getItem('scheduleDirty') === '1' && !conflict) flush();
  }, 15000);
})();
