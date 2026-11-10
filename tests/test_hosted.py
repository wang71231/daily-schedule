"""Smoke test of real Wrangler/workerd + local D1. Refuses public URLs."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

url=os.environ.get('HOSTED_TEST_URL','http://localhost:18788')
assert urlparse(url).hostname in ('127.0.0.1','localhost','::1'), 'Only run on a disposable local database'
out=Path(os.environ.get('QA_OUTPUT','test-results'));out.mkdir(parents=True,exist_ok=True)
password='isolated-local-test-only'

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,channel=os.environ.get('TEST_BROWSER_CHANNEL','chrome'))
    context=browser.new_context(viewport={'width':390,'height':844})
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(url+'/training.html');page.wait_for_url('**/login')
    page.locator('[name=password]').fill(password);page.get_by_role('button',name='登录',exact=True).click()
    page.wait_for_url(url+'/')
    page.goto(url+'/training.html');page.wait_for_function('() => storageReady');page.wait_for_load_state('networkidle')
    page.wait_for_function('() => document.querySelector("#syncStatus").textContent.includes("已同步")')
    # Add an ordinary user-facing manual entry, then verify a second device and re-login.
    page.locator('#manualDate').fill('2026-11-10')
    page.locator('#manualHours').fill('90');page.locator('#manualUnit').select_option('minutes')
    page.locator('#manualNote').fill('HOSTED-INTEGRATION-90-MIN')
    page.locator('#manualSave').click()
    page.wait_for_function('() => Object.values(logs).some(x=>x.name==="HOSTED-INTEGRATION-90-MIN") && !ScheduleStore.current().dirty')
    first=page.evaluate('ScheduleStore.current().state')
    assert any(x['hours']==1.5 for x in first['logs'].values())
    page.reload();page.wait_for_function('() => storageReady')
    page.wait_for_function('() => document.querySelector("#syncStatus").textContent.includes("已同步")')
    assert page.evaluate('ScheduleStore.current().state')==first
    assert page.evaluate('document.documentElement.scrollWidth')<=390
    page.locator('.worklog').screenshot(path=str(out/'hosted-mobile.png'))
    page.set_viewport_size({'width':1280,'height':900})
    page.screenshot(path=str(out/'hosted-desktop.png'),full_page=True)
    other=browser.new_context();second=other.new_page();second.goto(url+'/login')
    second.locator('[name=password]').fill(password);second.get_by_role('button',name='登录',exact=True).click();second.wait_for_url(url+'/')
    second.goto(url+'/training.html');second.wait_for_function('() => storageReady')
    second.wait_for_function('() => document.querySelector("#syncStatus").textContent.includes("已同步")')
    assert second.evaluate('ScheduleStore.current().state')==first
    assert page.evaluate('monthlySalary(40)')==5000
    assert page.evaluate('monthlySalary(41)')==5065
    history=page.request.get(url+'/api/history');assert history.ok and history.json()['history']
    page.goto(url+'/users.html');page.locator('#oldPassword').fill(password)
    page.locator('#newPassword').fill('isolated-next-password');page.locator('#confirmPassword').fill('isolated-next-password')
    page.on('dialog',lambda d:d.accept());page.locator('#save').click();page.wait_for_url('**/login')
    assert second.request.get(url+'/api/state').status==401
    page.locator('[name=password]').fill('isolated-next-password');page.get_by_role('button',name='登录',exact=True).click();page.wait_for_url(url+'/')
    saved=page.request.get(url+'/api/state').json();assert saved['state']==first
    # Restore this local-only password so re-running the test does not require hidden state.
    changed=page.request.post(url+'/api/password',headers={'X-CSRF-Token':saved['csrf']},data=json.dumps({'oldPassword':'isolated-next-password','newPassword':password}))
    assert changed.ok
    assert errors==[],errors
    other.close();context.close();browser.close()
    print('PASS: real workerd login, assets, D1 save/reload, second-device sync, password change, history, salary and mobile width')
