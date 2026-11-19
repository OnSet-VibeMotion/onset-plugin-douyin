import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { canResume, preparePage } from '../src/prepare';
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
it('竖横封面共用弹窗时，填完两张再点完成', async () => {
  const { page } = await pageFor('shared-cover');
  await page.evaluate(() => {
    const root = document.querySelector('#modal-root')!;
    const covers: Record<string, string> = {};
    const selected: string[] = [];
    (window as any).selectedCovers = selected;
    const render = (portrait: boolean) => {
      const ratio = portrait ? '3:4' : '4:3';
      root.innerHTML = '<div role="dialog" class="dy-creator-content-modal">'
        + '<div class="step-test">设置竖封面</div><div class="step-test">设置横封面</div>'
        + '<div class="upload-ZOJTUA"><input class="semi-upload-hidden-input" type="file"><div class="preview">预览</div></div>'
        + '<button class="next-cover">设置横封面</button><button class="finish" disabled>完成</button></div>';
      const [vertical, horizontal] = root.querySelectorAll<HTMLElement>('.step-test');
      const [current, inactive] = portrait ? [vertical, horizontal] : [horizontal, vertical];
      current.classList.add('step-active-test');
      inactive.onclick = () => render(!portrait);
      const input = root.querySelector<HTMLInputElement>('input')!;
      const finish = root.querySelector<HTMLButtonElement>('.finish')!;
      input.onchange = () => {
        covers[ratio] = input.files![0].name;
        input.value = '';
        selected.push(ratio);
        root.querySelector<HTMLElement>('.preview')!.style.backgroundImage = 'url("data:image/png;base64,cHJldmlldw==")';
        finish.disabled = false;
      };
      finish.onclick = () => {
        if (!covers['4:3']) {
          root.insertAdjacentHTML('beforeend', '<div role="dialog"><p>设置横封面获更多流量</p><button>设置横封面</button></div>');
          return;
        }
        (window as any).covers = covers;
        root.replaceChildren();
      };
    };
    document.querySelector<HTMLButtonElement>('.coverControl-test button')!.onclick = () => render(true);
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 2000 })).resolves.toEqual([]);
  expect(await page.evaluate(() => ({ covers: (window as any).covers, selected: (window as any).selectedCovers, submits: (window as any).submits })))
    .toEqual({ covers: { '3:4': 'portrait.png', '4:3': 'landscape.jpg' }, selected: ['3:4', '4:3'], submits: 0 });
});
it('上传控件消失时停止；离开创作者站点后无法填表或上传', async () => {
  const { page } = await pageFor('outside');
  await page.evaluate(() => document.querySelector('.upload-input')?.remove());
  await expect(preparePage(page, media(), () => {}, { timeout: 30 })).rejects.toThrow('上传');
  await page.raw('Page.navigate', { url: 'about:blank' });
  await expect(page.upload('.upload-input', media().video)).rejects.toThrow();
});
it('仅显示上传框和页头账号时，不把页面占位数据当成登录资料', async () => {
  const { page } = await pageFor('login');
  expect(await page.evaluate(scripts.loginInfo)).toBeNull();
});
it('快速接口只有 UID、详情省略 UID 时，从媒体接口取同一个账号的完整资料', async () => {
  const { page } = await pageFor('login-profile');
  await page.evaluate(() => {
    window.fetch = async (input, options) => {
      if (options?.credentials !== 'same-origin') throw Error('请求缺少同源会话');
      if (input === '/aweme/v1/creator/pc/user/info/') return new Response('{"status_code":0,"uid":12345678901234567890}');
      if (input === '/aweme/v1/creator/user/info/') {
        return Response.json({ status_code: 0, user_profile: { nick_name: '页面详情', avatar_url: '//p11.douyinpic.com/avatar.webp' } });
      }
      if (input === '/web/api/media/user/info/?device_platform=web') {
        return Response.json({
          status_code: 0,
          user: { uid: '12345678901234567890', nickname: '已登录创作者', avatar_thumb: { url_list: ['//p3.douyinpic.com/avatar.webp'] } },
        });
      }
      throw Error('未知请求');
    };
  });
  expect(await page.evaluate(scripts.loginInfo)).toEqual({
    name: '已登录创作者', avatar: 'https://p3.douyinpic.com/avatar.webp', user_id: '12345678901234567890',
  });
});
it('媒体接口账号不同时，等待当前账号的资料', async () => {
  const { page } = await pageFor('login-switch');
  await page.evaluate(() => {
    window.fetch = async input => {
      if (input === '/aweme/v1/creator/pc/user/info/') return Response.json({ status_code: 0, uid: '123' });
      if (input === '/web/api/media/user/info/?device_platform=web') return Response.json({
        status_code: 0,
        user: { uid: '456', nickname: '另一个账号', avatar_thumb: { url_list: ['https://p3.douyinpic.com/other.jpg'] } },
      });
      return Response.json({ status_code: 0, user_profile: { nick_name: '无法确认归属' } });
    };
  });
  expect(await page.evaluate(scripts.loginInfo)).toEqual({ name: '', avatar: '', user_id: '123' });
});

it('创作者中心已确认登录时，不依赖上传框或头像节点', async () => {
  const { page } = await pageFor('login-api');
  await page.evaluate(() => {
    document.querySelector('.upload-input')?.remove();
    document.querySelector('header')?.remove();
    document.body.insertAdjacentHTML('afterbegin', '<button>扫码登录</button>');
    window.fetch = async (input, options) => {
      if (input !== '/aweme/v1/creator/pc/user/info/' || options?.credentials !== 'same-origin') throw Error('请求不符合约定');
      return Response.json({
        status_code: 0, uid: '12345678901234567890',
        user_profile: { nick_name: '已登录创作者', avatar_url: 'https://example.test/avatar.png' },
      });
    };
  });
  expect(await page.evaluate(scripts.loginInfo)).toEqual({
    name: '已登录创作者', avatar: 'https://example.test/avatar.png', user_id: '12345678901234567890',
  });
});

it('接口显示未登录时，不把残留的上传框当作登录成功', async () => {
  const { page } = await pageFor('login-required');
  await page.evaluate(() => {
    window.fetch = async () => Response.json({ status_code: 8, uid: '123' });
  });
  expect(await page.evaluate(scripts.loginInfo)).toBeNull();
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

it('大视频上传超过单步时限也一直等，进度在走就传完接着填写', async () => {
  const { page } = await pageFor('slow-upload');
  await page.evaluate(() => {
    const video = document.querySelector<HTMLInputElement>('.upload-input')!;
    video.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      let percent = 0;
      const status = document.querySelector<HTMLElement>('#upload-status')!;
      status.innerText = '上传中 0%';
      const timer = setInterval(() => {
        percent += 10;
        if (percent < 100) { status.innerText = `上传中 ${percent}%`; return; }
        clearInterval(timer);
        status.innerText = '重新上传';
        document.querySelector<HTMLButtonElement>('#publish')!.disabled = false;
      }, 150);
    };
  });
  const messages: string[] = [];
  const uploads: number[] = [];
  const started = Date.now();
  await expect(preparePage(page, media(), (_f, message) => messages.push(message),
    { timeout: 600, onUpload: () => uploads.push(Date.now()) })).resolves.toEqual([]);
  expect(Date.now() - started).toBeGreaterThan(1000);
  expect(uploads).toHaveLength(1);
  expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/^正在上传视频 \d+%/), '正在填写标题、简介和话题']));
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')?.value)).toBe('我的标题');
});

it('窗口开着时上传卡住也不设时限，等抖音传完照样接着填写', async () => {
  const { page } = await pageFor('stalled-upload');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#upload-status')!.textContent = '上传中 40%';
      setTimeout(() => {
        document.querySelector('#upload-status')!.textContent = '重新上传';
        document.querySelector<HTMLButtonElement>('#publish')!.disabled = false;
      }, 2500);
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 500 })).resolves.toEqual([]);
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')?.value)).toBe('我的标题');
});

it('窗口关掉时停止等待', async () => {
  const { page } = await pageFor('closed-window');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#upload-status')!.textContent = '上传中 40%';
      setTimeout(() => { location.href = 'about:blank'; }, 300);
    };
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 500 })).rejects.toThrow();
});

it('窗口停在编辑页时接着上次的上传填写，不再上传一次视频', async () => {
  const { page } = await pageFor('resume');
  expect(await canResume(page)).toBe(false);
  // 上次的操作在等上传时中断了：编辑页开着，视频还在传。
  await page.evaluate(() => {
    (window as any).videoUploads = 0;
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => { (window as any).videoUploads++; };
    document.querySelector<HTMLElement>('#editor')!.hidden = false;
    document.querySelector('#upload-status')!.textContent = '上传中 40%';
  });
  expect(await canResume(page)).toBe(true);
  await page.evaluate(() => setTimeout(() => {
    document.querySelector('#upload-status')!.textContent = '重新上传';
    document.querySelector<HTMLButtonElement>('#publish')!.disabled = false;
  }, 500));
  const uploaded = vi.fn();
  await expect(preparePage(page, media(), () => {}, { timeout: 2000, resume: true, onUpload: uploaded })).resolves.toEqual([]);
  expect(uploaded).not.toHaveBeenCalled();
  expect(await page.evaluate(() => ({
    uploads: (window as any).videoUploads,
    title: document.querySelector<HTMLInputElement>('input[placeholder]')?.value,
    covers: (window as any).covers,
    submits: (window as any).submits,
  }))).toEqual({ uploads: 0, title: '我的标题', covers: { '3:4': 'portrait.png', '4:3': 'landscape.jpg' }, submits: 0 });
});

it('上传失败的编辑页不续接', async () => {
  const { page } = await pageFor('resume-failed');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#editor')!.hidden = false;
    document.querySelector('#upload-status')!.textContent = '上传失败';
  });
  expect(await canResume(page)).toBe(false);
});

it('只有进度条在走、文字不变时不算卡住，并按进度条报百分比', async () => {
  const { page } = await pageFor('bar-only');
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      const card = document.querySelector<HTMLElement>('.long-card-test')!;
      card.innerHTML = '<span>上传中</span><div class="bar" role="progressbar" aria-valuemax="200" aria-valuenow="0" style="width: 0%; height: 2px"></div>';
      const bar = card.querySelector<HTMLElement>('.bar')!;
      let value = 0;
      const timer = setInterval(() => {
        value += 20;
        if (value < 200) { bar.setAttribute('aria-valuenow', String(value)); bar.style.width = `${value / 2}%`; return; }
        clearInterval(timer);
        card.innerHTML = '<span id="upload-status">重新上传</span>';
        document.querySelector<HTMLButtonElement>('#publish')!.disabled = false;
      }, 120);
    };
  });
  const messages: string[] = [];
  await expect(preparePage(page, media(), (_f, message) => messages.push(message), { timeout: 1000 })).resolves.toEqual([]);
  expect(messages).toEqual(expect.arrayContaining([expect.stringMatching(/^正在上传视频 [1-9]\d*%/)]));
});

it('上传中弹出验证：停下全部自动操作交给用户，验证没了再接着填写', async () => {
  const { page } = await pageFor('verification');
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="captcha_container" style="display:none;width:300px;height:200px"></div>');
    document.querySelector<HTMLInputElement>('.upload-input')!.onchange = () => {
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#upload-status')!.textContent = '上传中 30%';
      // 上传途中抖音弹出安全验证（普通弹窗）；隐藏着的验证容器不算。
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="verify" style="width:320px;height:200px">安全验证 请完成下列验证后继续</div>'), 200);
      setTimeout(() => {
        document.querySelector('#upload-status')!.textContent = '重新上传';
        document.querySelector<HTMLButtonElement>('#publish')!.disabled = false;
      }, 400);
    };
  });
  const events: string[] = [];
  const done = preparePage(page, media(), (_f, message) => { if (message.includes('验证')) events.push('message'); }, {
    timeout: 1000,
    onPause: () => events.push('pause'),
    onResume: () => events.push('resume'),
  });
  await expect.poll(() => events.includes('pause'), { timeout: 5000 }).toBe(true);
  // 等用户验证的时候不填表，也不因为单步时限放弃。
  await new Promise(r => setTimeout(r, 1500));
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')?.value)).toBe('');
  expect(events).toEqual(['pause', 'message']);
  await page.evaluate(() => document.querySelector('#verify')!.remove());
  await expect(done).resolves.toEqual([]);
  expect(events).toEqual(['pause', 'message', 'resume']);
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')?.value)).toBe('我的标题');
});

it('认得出抖音的验证组件与身份确认弹窗，不把封面弹窗当成验证', async () => {
  const { page } = await pageFor('verification-kinds');
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="dy-creator-content-modal" role="dialog" style="width:300px;height:200px">设置竖封面 完成</div>'));
  expect(await page.evaluate(scripts.verificationOpen)).toBe(false);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<iframe src="about:blank#captcha" style="width:300px;height:200px"></iframe>'));
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
  await page.evaluate(() => { document.querySelector('iframe')!.remove(); document.body.insertAdjacentHTML('beforeend', '<div class="semi-modal" style="width:300px;height:200px">身份验证 请输入短信验证码</div>'); });
  expect(await page.evaluate(scripts.verificationOpen)).toBe(true);
});
