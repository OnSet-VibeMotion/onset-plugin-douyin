import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
const { test, expect, openProject, api } = await import(pathToFileURL(path.join(process.env.ONSET_DOUYIN_HOST, 'apps/desktop/e2e/fixtures.mjs')).href);
const plugin = path.resolve(import.meta.dirname, '..');
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
const account = '00000000-0000-4000-8000-000000000001';
const uid = '12345678901234567890';

test('真实插件在片场内上传填写，重新打开后可登录原账号并保留用户修改', async ({ electronApp, page, project, sandbox }) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'onset-station.json'), 'utf8'));
  await page.locator('#settings-trigger').click();
  const stations = page.locator('#settings-dialog section.stations[aria-label="我的插件"]');
  await stations.getByLabel('插件来源').fill('link:' + plugin);
  await stations.getByRole('button', { name: '添加' }).click();
  const preview = stations.getByRole('alertdialog', { name: '确认添加插件' });
  await expect(preview).toContainText('抖音上传助手');
  await preview.getByRole('button', { name: '装上' }).click();
  await expect(stations.locator('li[data-station="douyin-upload"]')).toBeVisible();
  await page.locator('#settings-dialog').getByRole('button', { name: '关闭' }).click();
  const data = path.join(sandbox.stations, manifest.id, 'data');
  fs.mkdirSync(path.join(data, 'accounts', account), { recursive: true });
  fs.writeFileSync(path.join(data, 'accounts', account, 'account.json'), JSON.stringify({ id: account, name: '测试工作号', user_id: uid, created_at: new Date().toISOString() }));
  fs.writeFileSync(path.join(project.path, 'final.mp4'), 'fixture-video');
  fs.writeFileSync(path.join(project.path, 'cover.png'), 'fixture-cover');
  fs.writeFileSync(path.join(project.path, 'horizontal.png'), 'fixture-horizontal-cover');
  fs.writeFileSync(path.join(project.path, 'publish.md'), `---\n${stringify({ platform: 'douyin', publish_status: 'ready', video: { path: 'final.mp4' }, copy: { primary_title: '片场内自动填写', introduction: '在客户端里检查并发布', hashtags: [] }, cover: { images: [{ platform: 'douyin', ratio: '3:4', path: 'cover.png' }, { platform: 'douyin', ratio: '4:3', path: 'horizontal.png' }] } })}---\n`);
  await electronApp.evaluate(({ session }, { dir, html, uid }) => {
    let loggedIn = false;
    session.fromPath(dir).protocol.handle('https', request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/fixture-login') {
        loggedIn = true;
        return Response.json({});
      }
      if (pathname === '/aweme/v1/creator/pc/user/info/') return Response.json(loggedIn ? { status_code: 0, uid } : { status_code: 8 });
      if (pathname === '/aweme/v1/creator/user/info/') {
        return Response.json(loggedIn ? { status_code: 0, user_profile: { nick_name: '更新后的工作号' } } : { status_code: 8 });
      }
      if (pathname === '/web/api/media/user/info/') {
        return Response.json(loggedIn ? { status_code: 0, user: { uid, nickname: '更新后的工作号' } } : { status_code: 8 });
      }
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    });
  }, { dir: path.join(sandbox.userData, 'station-sessions', manifest.id, account), html: fixture, uid });
  await openProject(page, project);
  await page.locator('[data-tab="publish"]').click();
  const card = page.frameLocator('.station-slots[data-slot="publish"] .station-frame');
  await expect(card.getByLabel('发布到哪个账号')).toHaveValue(account);
  await expect(card.getByRole('button', { name: '上传并填写' })).toBeEnabled();
  const run = async (op, afterStart) => {
    const started = await api(page, `/api/stations/${manifest.id}/ops/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { account } }) });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await afterStart();
    let result;
    await expect.poll(async () => {
      const station = (await api(page, '/api/stations')).body.stations.find(s => s.id === manifest.id);
      result = station.ops.find(o => o.name === op).last_run;
      return result?.task_id === started.body.task_id;
    }, { timeout: 25_000 }).toBe(true);
    expect(result.ok, result.text).toBe(true);
    return result.data;
  };
  const prepareButton = card.getByRole('button', { name: '上传并填写' });
  const confirmation = page.locator('.station-confirm');
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerdown')));
    await prepareButton.click();
    await expect(confirmation).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await confirmation.getByRole('button', { name: '执行', exact: true }).click();
  await expect.poll(() => {
    try { return JSON.parse(fs.readFileSync(path.join(project.path, 'production/douyin/state.json'), 'utf8')).status; }
    catch { return ''; }
  }, { timeout: 25_000 }).toBe('ready_to_publish');
  const content = await electronApp.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.douyin.com/'));
    const result = await wc.executeJavaScript(`({ title: document.querySelector('input[placeholder]').value, body: document.querySelector('[contenteditable]').innerText, video: document.querySelector('input[accept="video/*"]').files[0].name, covers: window.covers, submits: window.submits })`);
    await wc.executeJavaScript(`document.querySelector('input[placeholder]').value='用户改过的标题'`);
    const bar = webContents.getAllWebContents().find(w => w.getURL().startsWith('data:text/html'));
    await bar.executeJavaScript(`document.querySelector('a').click()`);
    return result;
  });
  expect(content).toEqual({ title: '片场内自动填写', body: '在客户端里检查并发布', video: 'final.mp4', covers: { '3:4': 'cover.png', '4:3': 'horizontal.png' }, submits: 0 });
  const reopened = await run('open_account', async () => {
    await expect.poll(() => {
      try { return JSON.parse(fs.readFileSync(path.join(project.path, 'production/douyin/latest.json'), 'utf8')).message; }
      catch { return ''; }
    }).toContain('如需重新登录');
    await electronApp.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.douyin.com/'));
      await wc.executeJavaScript("fetch('/fixture-login', { method: 'POST' }).then(response => response.ok)");
    });
  });
  expect(reopened).toMatchObject({ status: 'login_refreshed', account: { id: account, name: '更新后的工作号' } });
  expect(await electronApp.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith('https://creator.douyin.com/'));
    const title = await wc.executeJavaScript(`document.querySelector('input[placeholder]').value`);
    await wc.executeJavaScript(`document.querySelector('#publish').click()`);
    if (await wc.executeJavaScript('window.submits') !== 1) throw Error('不能由用户发布');
    return title;
  })).toBe('用户改过的标题');
});
