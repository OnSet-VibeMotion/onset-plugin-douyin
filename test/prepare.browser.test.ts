import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openBrowser, findBrowser } from './support/browser';
import { CDP, Page } from '../src/cdp';
import { AlreadyPublished, canResume, preparePage } from '../src/prepare';
import * as scripts from '../src/page-scripts';

let root: string, origin: string, server: http.Server;
const browsers: Awaited<ReturnType<typeof openBrowser>>[] = [];
const fixture = fs.readFileSync(new URL('./fixtures/creator.html', import.meta.url), 'utf8');
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-douyin-browser-'));
  server = http.createServer((req, res) => {
    // 作品列表接口：默认这个账号还没发过任何作品。
    if (req.url?.startsWith('/janus/')) { res.setHeader('Content-Type', 'application/json'); res.end('{"status_code":0,"aweme_list":[],"has_more":false}'); return; }
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
  const stat = fs.statSync(video);
  return { title: '我的标题', content: '视频简介', tags: ['科技', '开源'], video, videoHash: 'hash',
    covers: { '3:4': portrait, '4:3': landscape }, videoSize: stat.size, videoModified: Math.floor(stat.mtimeMs), videoDuration: 180_000 };
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


/** 上传页顶上的「上次未发布的视频」提示，结构照真实页面（2026-11-19 核对）；草稿记在本地存储里。 */
async function withSavedDraft(page: Page, file: { size: number; lastModified: number }) {
  await page.evaluate((saved) => {
    localStorage.setItem('publish_form_cache:123', JSON.stringify({ cache: { longFileInfo: { name: 'final.mp4', ...saved, duration: 180 } } }));
    (window as any).videoUploads = 0; (window as any).gaveUp = 0;
    document.querySelector<HTMLInputElement>('.upload-input')!.addEventListener('change', () => (window as any).videoUploads++);
    document.body.insertAdjacentHTML('afterbegin', '<div class="draft"><div><span class="hint-text-x">你还有上次未发布的视频，是否继续编辑？</span><span class="hint-text-x continue-x">继续编辑</span><span class="hint-text-x give-up-x">放弃</span></div></div>');
    document.querySelector<HTMLElement>('.continue-x')!.onclick = () => {
      document.querySelector('.draft')!.remove();
      history.pushState(null, '', '/creator-micro/content/post/video?enter_from=draft');
      document.querySelector<HTMLElement>('#editor')!.hidden = false;
      document.querySelector('#upload-status')!.textContent = '添加音乐 重新上传';
      document.querySelector<HTMLButtonElement>('#publish')!.disabled = false;
    };
    document.querySelector<HTMLElement>('.give-up-x')!.onclick = () => (window as any).gaveUp++;
  }, file);
}

it('抖音草稿里就是这个成片：点「继续编辑」接着填写，不重新上传', async () => {
  const { page } = await pageFor('draft-same');
  const draft = media();
  await withSavedDraft(page, { size: draft.videoSize, lastModified: draft.videoModified });
  const uploaded = vi.fn();
  await expect(preparePage(page, draft, () => {}, { timeout: 2000, onUpload: uploaded })).resolves.toEqual([]);
  expect(uploaded).toHaveBeenCalledOnce();
  expect(await page.evaluate(() => ({ uploads: (window as any).videoUploads, gaveUp: (window as any).gaveUp, title: document.querySelector<HTMLInputElement>('input[placeholder]')?.value, submits: (window as any).submits })))
    .toEqual({ uploads: 0, gaveUp: 0, title: '我的标题', submits: 0 });
});

it('抖音草稿里是别的视频：停下请用户处理，不替用户放弃，也不上传顶掉它', async () => {
  const { page } = await pageFor('draft-other');
  const draft = media();
  await withSavedDraft(page, { size: draft.videoSize + 1, lastModified: draft.videoModified });
  await expect(preparePage(page, draft, () => {}, { timeout: 2000 })).rejects.toThrow(/还有一个没发完的视频（final\.mp4.*放弃/);
  expect(await page.evaluate(() => ({ uploads: (window as any).videoUploads, gaveUp: (window as any).gaveUp, prompt: !!document.querySelector('.draft') })))
    .toEqual({ uploads: 0, gaveUp: 0, prompt: true });
});

it('这个成片已经发过：不上传，说明何时发的；点了「仍然上传」才上传', async () => {
  const { page } = await pageFor('published');
  const fakeWorks = () => page.evaluate(() => {
    (window as any).videoUploads = 0;
    document.querySelector<HTMLInputElement>('.upload-input')!.addEventListener('change', () => (window as any).videoUploads++);
    const real = window.fetch;
    window.fetch = async (input, init) => String(input).startsWith('/janus/douyin/creator/pc/work_list')
      ? Response.json({ status_code: 0, has_more: false, aweme_list: [
        { item_title: '别的作品', duration: 180_000, create_time: 1795000000, status: {} },
        { item_title: '我的 标题', duration: 180_600, create_time: 1795007766, status: { in_reviewing: true } },
      ] })
      : real(input, init);
  });
  await fakeWorks();
  const error = await preparePage(page, media(), () => {}, { timeout: 2000 }).catch(err => err);
  expect(error).toBeInstanceOf(AlreadyPublished);
  expect(error.message).toMatch(/已经发到这个抖音账号了（「我的 标题」，正在审核）.*仍然上传/);
  expect(await page.evaluate(() => (window as any).videoUploads)).toBe(0);
  await expect(preparePage(page, media(), () => {}, { timeout: 2000, again: true })).resolves.toEqual([]);
  expect(await page.evaluate(() => (window as any).videoUploads)).toBe(1);
});

it('读不到已发布作品时照常上传，并提醒用户留意', async () => {
  const { page } = await pageFor('works-unreadable');
  await page.evaluate(() => {
    const real = window.fetch;
    window.fetch = async (input, init) => String(input).startsWith('/janus/') ? new Response('', { status: 500 }) : real(input, init);
  });
  await expect(preparePage(page, media(), () => {}, { timeout: 2000 })).resolves.toEqual([expect.stringContaining('没能读到这个账号已发布的作品')]);
  expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')?.value)).toBe('我的标题');
});


it('标题或简介读回来对不上时只提醒，照样设好横竖两张封面', async () => {
  const { page } = await pageFor('mismatch-covers');
  // 网站把标题截短了：插件不该因此放弃后面的封面。
  await page.evaluate(() => document.querySelector<HTMLInputElement>('input[placeholder]')!.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.value.length > 2) input.value = input.value.slice(0, 2);
  }));
  const warnings = await preparePage(page, media(), () => {}, { timeout: 5000 });
  expect(warnings).toEqual([expect.stringContaining('请在抖音页面检查标题')]);
  expect(await page.evaluate(() => ({ covers: (window as any).covers, submits: (window as any).submits })))
    .toEqual({ covers: { '3:4': 'portrait.png', '4:3': 'landscape.jpg' }, submits: 0 });
});

it('抖音不支持的话题（带连字符等）直接跳过，不输入也不提醒；没有草稿时不干等', async () => {
  const { page } = await pageFor('topics-and-speed');
  const draft = { ...media(), tags: ['U-Net', '深度学习', 'AI_Agent', 'v1.0'] };
  const started = Date.now();
  const warnings = await preparePage(page, draft, () => {}, { timeout: 5000 });
  // 以前没有草稿时也要等满 3 秒看提示出不出来。
  expect(Date.now() - started).toBeLessThan(2500);
  expect(warnings).toEqual([]);
  const body = await page.evaluate(() => document.querySelector<HTMLElement>('.zone-container')!.innerText);
  expect(body).toMatch(/#深度学习\s+#AI_Agent/);
  expect(body).not.toContain('U-Net');
  expect(body).not.toContain('v1.0');
});
