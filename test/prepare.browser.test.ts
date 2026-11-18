import { afterAll, beforeAll, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { preparePage } from '../src/prepare';
import * as scripts from '../src/page-scripts';

let root: string, origin: string, server: http.Server;
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-douyin-browser-'));
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fixture);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
});
afterAll(async () => {
  const ownedProcesses = new Set<number>();
  for (const browser of browsers) {
    try {
      const info = await browser.send('SystemInfo.getProcessInfo');
      for (const processInfo of info.processInfo) ownedProcesses.add(processInfo.id);
      await browser.send('Browser.close');
    } catch {} finally { browser.disconnect(); }
  }
  await new Promise<void>(r => server.close(() => r()));
  // Browser.close acknowledges the request before Chromium and its children have
  // exited. Only these test-owned PIDs may be stopped; never touch normal Chrome.
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while ([...ownedProcesses].some(alive) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  for (const pid of ownedProcesses) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
async function pageFor(name: string) {
  const profile = path.join(root, name); fs.mkdirSync(profile, { recursive: true });
  const browser = await openBrowser(profile, { headless: true }); browsers.push(browser);
  const page = await Page.create(browser, origin); await page.navigate(origin + '/creator-micro/content/upload');
  await page.waitFor(() => document.querySelector('.upload-input') !== null, 5000, '测试上传页未加载');
  return { page, browser, profile };
}
function media() {
  const video = path.join(root, 'video.mp4'), portrait = path.join(root, 'portrait.png'), landscape = path.join(root, 'landscape.jpg');
  for (const file of [video, portrait, landscape]) fs.writeFileSync(file, 'test');
  return { title: '我的标题', content: '视频简介', tags: ['科技', '开源'], video, videoHash: 'hash',
    covers: { '3:4': portrait, '4:3': landscape } };
}
it('上传视频、填写标题简介和话题、设置两张封面，发布仍由用户操作', async () => {
  const { page } = await pageFor('upload-both');
  await expect(preparePage(page, media(), () => {}, { timeout: 5000 })).resolves.toEqual([]);
  expect(await page.evaluate(() => ({
    title: document.querySelector<HTMLInputElement>('input[placeholder]')?.value,
    body: document.querySelector<HTMLElement>('.zone-container')?.innerText,
    video: document.querySelector<HTMLInputElement>('.upload-input')?.files?.[0]?.name,
    covers: (window as any).covers,
    referenceUploads: (window as any).referenceUploads,
    submits: (window as any).submits,
  }))).toMatchObject({ title: '我的标题', body: expect.stringMatching(/视频简介\s+#科技\s+#开源/), video: 'video.mp4',
    covers: { '3:4': 'portrait.png', '4:3': 'landscape.jpg' }, referenceUploads: 0, submits: 0 });
  await expect(page.click('#publish')).rejects.toThrow('不允许点击发布');
});
it('上传控件消失时停止；离开创作者站点后无法填表或上传', async () => {
  const { page } = await pageFor('outside');
  await page.evaluate(() => document.querySelector('.upload-input')?.remove());
  await expect(preparePage(page, media(), () => {}, { timeout: 30 })).rejects.toThrow('上传');
  await page.raw('Page.navigate', { url: 'about:blank' });
  await expect(page.upload('.upload-input', media().video)).rejects.toThrow();
});
it('已登录时从创作者页面取账号，登录提示出现时继续等待', async () => {
  const { page } = await pageFor('login');
  expect(await page.evaluate(scripts.loginInfo, scripts.videoInput)).toEqual({ name: '测试创作者', avatar: '', user_id: 'dy-test' });
  await page.evaluate(() => { document.body.insertAdjacentHTML('afterbegin', '<button>扫码登录</button>'); });
  expect(await page.evaluate(scripts.loginInfo, scripts.videoInput)).toBeNull();
});
it('抖音上传页更新导致封面入口缺失时，保留已填表单并提示用户检查', async () => {
  const { page } = await pageFor('missing-cover');
  await page.evaluate(() => document.querySelectorAll('.coverControl-test').forEach(e => e.remove()));
  const warnings = await preparePage(page, media(), () => {}, { timeout: 500 });
  expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('竖封面'), expect.stringContaining('横封面')]));
  expect(await page.evaluate(() => (window as any).submits)).toBe(0);
});

it('检测到上传失败后不填写，也不尝试提交', async () => {
  const { page } = await pageFor('failed-upload');
  await page.evaluate(() => {
    const video = document.querySelector<HTMLInputElement>('.upload-input')!;
    video.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#upload-status')!.textContent = '上传失败';
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 500 })).rejects.toThrow('上传或处理失败');
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')?.value)).toBe('');
});
