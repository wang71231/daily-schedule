"""Isolated real Chromium tests. Never opens the user's browser profile or website."""
import copy
import json
import os
from pathlib import Path
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def log(code, hours=1):
    return {"date":"2026-11-10", "day":2, "code":code, "name":code,
            "room":"测试", "time":"09:00–10:00", "status":"done", "hours":hours}


def state(*codes):
    return {"logs":{f"2026-11-10|{c}":log(c) for c in codes}, "extraCourses":[],
            "historyHours":"0", "trainingRate":"0"}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(ROOT)))
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()
        cls.url=f'http://127.0.0.1:{cls.http.server_port}'
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(headless=True,channel=os.environ.get('TEST_BROWSER_CHANNEL','chrome'))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop();cls.http.shutdown();cls.http.server_close()

    def setUp(self):
        self.context=self.browser.new_context(service_workers='block',viewport={'width':390,'height':844})
        self.errors=[]

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors,[])

    def open(self, legacy=None, server=False):
        page=self.context.new_page()
        page.on('pageerror',lambda error:self.errors.append(str(error)))
        if legacy is not None:
            page.add_init_script('localStorage.setItem("trainingLogs",'+json.dumps(json.dumps(legacy['logs']))+');')
        if server:
            page.add_init_script('window.SERVER_MODE=true;')
        page.goto(self.url+'/training.html')
        page.wait_for_load_state('networkidle')
        page.wait_for_function('storageReady')
        return page

    def stored(self,page):
        return page.evaluate('async () => (await ScheduleStore.refresh()).state')

    def add(self,page,code):
        page.evaluate('(item)=>ScheduleStore.change(s=>{s.logs[item.date+"|"+item.code]=item;})',log(code))

    def test_legacy_migration_retains_original_and_hour_totals(self):
        page=self.open(state('A','B'))
        self.assertEqual(len(self.stored(page)['logs']),2)
        self.assertEqual(page.evaluate('JSON.parse(localStorage.trainingLogs)'),state('A','B')['logs'])
        page.reload();page.wait_for_function('storageReady')
        self.assertEqual(len(self.stored(page)['logs']),2)

    def test_concurrent_tabs_keep_both_additions(self):
        a=self.open();b=self.open()
        for i in range(12):
            a.evaluate('(item)=>{window.pending=ScheduleStore.change(s=>{s.logs[item.date+"|"+item.code]=item;});}',log('A'+str(i)))
            self.add(b,'B'+str(i))
            a.evaluate('window.pending')
        self.assertEqual(len(self.stored(a)['logs']),24)
        self.assertEqual(self.stored(a),self.stored(b))

    def test_delete_then_save_still_recoverable(self):
        page=self.open(state('A','B'))
        page.evaluate('()=>ScheduleStore.change(s=>{delete s.logs["2026-11-10|A"];},"删除前")')
        self.add(page,'C')
        snapshots=page.evaluate('()=>ScheduleStore.history()')
        found=next(x for x in snapshots if '2026-11-10|A' in x['state']['logs'])
        page.evaluate('(state)=>ScheduleStore.change(s=>Object.assign(s,state),"恢复前")',found['state'])
        self.assertIn('2026-11-10|A',self.stored(page)['logs'])
        self.assertTrue(any('2026-11-10|C' in x['state']['logs'] for x in page.evaluate('()=>ScheduleStore.history()')))

    def test_older_tab_new_data_is_detected_and_imported_without_replacing_current(self):
        page=self.open(state('A'))
        self.add(page,'B')
        old=self.context.new_page();old.goto(self.url+'/index.html')
        old.evaluate('(logs)=>localStorage.setItem("trainingLogs",JSON.stringify(logs))',state('A','C')['logs'])
        page.wait_for_function('!document.getElementById("importLegacy").hidden')
        page.evaluate('()=>ScheduleStore.importLegacy()')
        self.assertEqual(set(self.stored(page)['logs']),{'2026-11-10|A','2026-11-10|B','2026-11-10|C'})
        self.assertTrue(any(x['reason']=='旧版页面原始快照' for x in page.evaluate('()=>ScheduleStore.history()')))

    def test_offline_reload_retains_records_and_correct_page(self):
        context=self.browser.new_context(service_workers='allow')
        try:
            page=context.new_page();page.goto(self.url+'/training.html');page.wait_for_function('storageReady')
            page.evaluate('()=>navigator.serviceWorker.ready')
            page.wait_for_function('navigator.serviceWorker.controller!==null')
            self.add(page,'offline-record')
            context.set_offline(True)
            page.goto(self.url+'/training.html?offline-test=1');page.wait_for_function('storageReady')
            self.assertIn('2026-11-10|offline-record',self.stored(page)['logs'])
            self.add(page,'offline-new')
            self.assertEqual(len(self.stored(page)['logs']),2)
        finally:context.close()

    def test_failed_transaction_changes_nothing(self):
        page=self.open(state('A'))
        result=page.evaluate('''async()=>{try{await ScheduleStore.change(s=>{s.logs={};throw Error('simulated');});}catch(e){return e.message;}}''')
        self.assertEqual(result,'simulated')
        self.assertIn('2026-11-10|A',self.stored(page)['logs'])

    def test_invalid_import_preserves_current(self):
        page=self.open(state('A'))
        messages=[]
        page.on('dialog',lambda d:(messages.append(d.message),d.accept()))
        bad={"format":"training-backup","version":1,"logs":{"broken":{}},"extraCourses":[]}
        page.locator('#backupFile').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':json.dumps(bad).encode()})
        page.wait_for_function('document.getElementById("backupFile").value===""')
        self.assertIn('2026-11-10|A',self.stored(page)['logs'])
        self.assertTrue(any('恢复失败' in m for m in messages))

    def test_manual_minutes_and_input_persist_without_blur(self):
        page=self.open()
        page.locator('#manualDate').fill('2026-11-10')
        page.locator('#manualUnit').select_option('minutes')
        page.locator('#manualHours').fill('90')
        page.locator('#manualNote').fill('test 90 minutes')
        page.locator('#manualSave').click()
        page.wait_for_function('Object.keys(logs).length===1')
        self.assertEqual(next(iter(self.stored(page)['logs'].values()))['hours'],1.5)
        page.locator('#date').fill('2026-11-10');page.locator('#date').dispatch_event('change')
        page.locator('.log-hours').first.fill('2.5')
        page.wait_for_function('Object.values(logs).some(x=>x.hours===2.5)')
        page.reload();page.wait_for_function('storageReady')
        self.assertTrue(any(x['hours']==2.5 for x in self.stored(page)['logs'].values()))
        self.assertLessEqual(page.evaluate('document.documentElement.scrollWidth'),390)

    def test_quota_failure_has_no_false_success(self):
        page=self.open(state('A'))
        page.evaluate('''()=>{const old=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode){if(mode==='readwrite')throw new DOMException('full','QuotaExceededError');return old.apply(this,arguments);};}''')
        page.on('dialog',lambda d:d.accept())
        page.locator('.data-tools').evaluate('(el)=>el.open=true')
        page.locator('#clearLogs').click()
        page.wait_for_function('document.getElementById("storageNotice").textContent.includes("保存失败")')
        self.assertIn('2026-11-10|A',self.stored(page)['logs'])
        self.assertFalse(page.evaluate('ScheduleStore.busy()'))

    def test_corrupt_legacy_does_not_turn_into_empty_saved_state(self):
        page=self.context.new_page()
        page.add_init_script('localStorage.setItem("trainingLogs","{broken");')
        page.goto(self.url+'/training.html');page.wait_for_load_state('networkidle')
        self.assertIn('暂停写入',page.locator('#storageNotice').inner_text())
        self.assertEqual(page.evaluate('localStorage.trainingLogs'),'{broken')
        self.assertTrue(page.locator('#manualSave').is_disabled())

    def setup_sync(self,page,remote,midflight=None):
        live={"revision":5,"state":copy.deepcopy(remote),"serverId":"test-db","csrf":"test-csrf"}
        posts=[]
        def route(req):
            if req.request.method=='POST':
                sent=req.request.post_data_json;posts.append(sent)
                if sent['revision']!=live['revision']:
                    req.fulfill(status=409,json={'error':'conflict'});return
                live['state']=sent['state'];live['revision']+=1
                if midflight and len(posts)==1:
                    midflight()
                req.fulfill(json={'revision':live['revision']})
            else: req.fulfill(json=live)
        page.route('**/api/state',route)
        page.add_script_tag(url=self.url+'/server/server-mode.js')
        return live,posts

    def test_sync_ack_does_not_drop_edits_made_during_upload(self):
        page=self.open(server=True)
        live,posts=self.setup_sync(page,state())
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("已同步")')
        self.add(page,'A')
        # Force another edit before the first upload acknowledgment arrives.
        page.unroute('**/api/state')
        def route(req):
            if req.request.method=='POST':
                sent=req.request.post_data_json;posts.append(sent)
                live['state']=sent['state'];live['revision']+=1
                if len(posts)==1:self.add(page,'B')
                req.fulfill(json={'revision':live['revision']})
            else:req.fulfill(json=live)
        page.route('**/api/state',route)
        page.evaluate('window.scheduleBackend.queue()')
        page.wait_for_function('!ScheduleStore.current().dirty',timeout=15000)
        self.assertEqual(set(live['state']['logs']),{'2026-11-10|A','2026-11-10|B'})
        self.assertGreaterEqual(len(posts),2)

    def test_sync_two_devices_different_records_merge(self):
        page=self.open(server=True)
        live,posts=self.setup_sync(page,state('A'))
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("已同步")')
        self.add(page,'B')
        live['state']['logs']['2026-11-10|C']=log('C');live['revision']+=1
        page.evaluate('window.scheduleBackend.queue()')
        page.wait_for_function('!ScheduleStore.current().dirty')
        self.assertEqual(set(live['state']['logs']),{'2026-11-10|A','2026-11-10|B','2026-11-10|C'})

    def test_first_login_loads_remote_historical_total_without_false_conflict(self):
        page=self.open(server=True)
        remote=state('A');remote['historyHours']='45.5'
        live,posts=self.setup_sync(page,remote)
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("已同步")')
        self.assertEqual(self.stored(page)['historyHours'],'45.5')
        self.assertEqual(posts,[])

    def test_database_rollback_pauses_without_erasing_local(self):
        page=self.open(server=True)
        live,posts=self.setup_sync(page,state('A'))
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("已同步")')
        live['revision']=0;live['state']=state();live['serverId']='replacement-db'
        page.evaluate('window.scheduleBackend.queue()')
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("来源或版本发生变化")')
        self.assertIn('2026-11-10|A',self.stored(page)['logs']);self.assertEqual(posts,[])

    def test_sync_same_record_conflict_pauses_without_overwrite(self):
        page=self.open(server=True)
        live,posts=self.setup_sync(page,state('A'))
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("已同步")')
        page.evaluate('()=>ScheduleStore.change(s=>{s.logs["2026-11-10|A"].hours=2;})')
        live['state']['logs']['2026-11-10|A']['hours']=3;live['revision']+=1
        page.evaluate('window.scheduleBackend.queue()')
        page.wait_for_function('document.querySelector("#syncStatus").textContent.includes("冲突")')
        self.assertEqual(self.stored(page)['logs']['2026-11-10|A']['hours'],2)
        self.assertEqual(live['state']['logs']['2026-11-10|A']['hours'],3)
        self.assertEqual(posts,[])


if __name__=='__main__':
    unittest.main(verbosity=2)
