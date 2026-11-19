import path from 'node:path';
import { AccountStore, MaxAvatarChars, newAccountID, withAccountLock, type Account } from './accounts';
import { connectBridge, openBrowser, validateBridge, type BrowserBridge } from './browser';
import { delay, Page, UploadPath, type BrowserConnection } from './cdp';
import * as scripts from './page-scripts';
import { readDraft } from './draft';
import { writeProjectJSON } from './files';
import { canResume, preparePage, type Progress } from './prepare';

export interface Request {
  /** 空字符串：没打开项目时从片场设置里点的账号操作，不往项目里写任何东西。 */
  project_root: string; data_dir: string; browser?: BrowserBridge;
  params: Record<string, unknown>; settings: Record<string, unknown>;
}
export interface Result { status: string; message: string; account?: Account; warnings?: string[]; video_sha256?: string; items?: unknown[]; accounts?: unknown[] }
const operations = ['accounts', 'login', 'open_account', 'remove_account', 'prepare'];
/** 抖音 CDN 上的头像：插件进程取回来存成 data URL，片场与插件页面都只认这种图片。 */
async function fetchAvatar(raw: string): Promise<string> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !/(^|\.)(douyinpic\.com|douyin\.com|douyinstatic\.com|byteimg\.com)$/.test(url.hostname)) return '';
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
  if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return '';
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > Math.floor((MaxAvatarChars - 32) * 3 / 4)) return '';
      chunks.push(value);
    }
    return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
  } finally { await reader.cancel().catch(() => {}); }
}
const defaults = { open: openBrowser, page: Page.create, draft: readDraft, prepare: preparePage, avatar: fetchAvatar, sleep: delay, bridge: connectBridge, loginTimeout: 10 * 60_000 };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('插件输入必须是 JSON 对象');
  return value as Record<string, unknown>;
}
function parameter(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) throw Error(`${label}无效`);
  return value;
}
export function validateRequest(raw: unknown): Request {
  const r = object(raw);
  if (typeof r.data_dir !== 'string' || !path.isAbsolute(r.data_dir)) throw Error('data_dir 需要绝对路径');
  if (typeof r.project_root !== 'string' || (r.project_root !== '' && !path.isAbsolute(r.project_root))) throw Error('project_root 需要绝对路径');
  const params = object(r.params ?? {}), settings = object(r.settings ?? {});
  for (const key of Object.keys(params)) if (!['account'].includes(key)) throw Error(`不支持参数 ${key}；插件不会自动发布`);
  for (const value of Object.values(params)) if (typeof value !== 'string' || value.length > 500) throw Error('参数需要字符串');
  const browser = r.browser === undefined ? undefined : validateBridge(r.browser);
  return { project_root: r.project_root, data_dir: r.data_dir, params, settings, browser };
}

/** 设置里的账号卡片：头像、昵称、「打开」「移除」。 */
function accountItems(accounts: Account[]): unknown[] {
  return accounts.map(a => ({
    title: a.name,
    detail: `登录于 ${a.created_at.slice(0, 10)}`,
    ...(a.avatar ? { image: a.avatar } : {}),
    actions: [
      { label: '打开', op: 'open_account', params: { account: a.id } },
      { label: '移除', op: 'remove_account', params: { account: a.id }, confirm: `移除「${a.name}」后要重新登录，确定吗？` },
    ],
  }));
}
/** 给插件页面（onset.list）的账号：编号、名字与头像，不含登录状态。账号只在插件自己的数据目录里，不写进项目。 */
function pageAccounts(accounts: Account[]) {
  return accounts.map(a => ({ id: a.id, name: a.name, created_at: a.created_at, ...(a.avatar ? { avatar: a.avatar } : {}) }));
}

export async function runOperation(operation: string, raw: unknown, progress: Progress = () => {}, deps = defaults): Promise<Result> {
  const request = validateRequest(raw);
  if (!operations.includes(operation)) throw Error('不支持这个操作；插件只上传填表，不提交发布');
  const { project_root: root, params } = request;
  const store = new AccountStore(request.data_dir);
  let account: Account | undefined;
  if (!root && operation === 'prepare') throw Error('要在项目里进行：先在片场打开这个项目');
  const update = (result: Result) => {
    if (!root || operation === 'accounts') return;
    writeProjectJSON(root, 'production/douyin/latest.json', { status: result.status, message: result.message, ...(result.account ? { account: { id: result.account.id, name: result.account.name } } : {}), ...(result.warnings ? { warnings: result.warnings } : {}), operation, updated_at: new Date().toISOString() });
    if (operation === 'prepare') {
      const { account, ...state } = result;
      writeProjectJSON(root, 'production/douyin/state.json', {
        ...state, ...(account ? { account: { id: account.id, name: account.name } } : {}), updated_at: new Date().toISOString(),
      });
    }
  };
  try {
    if (operation === 'accounts') {
      const accounts = store.list();
      return { status: 'accounts_loaded', message: accounts.length ? `${accounts.length} 个账号` : '还没有账号', items: accountItems(accounts), accounts: pageAccounts(accounts) };
    }
    const opening = operation === 'login' || operation === 'open_account';
    update({ status: 'running', message: opening ? '正在打开抖音窗口…' : '正在准备…' });
    if (operation === 'login') { const result = await login(request, store, progress, deps); update(result); return result; }
    account = store.get(parameter(params.account, '账号'));
    if (operation === 'remove_account') {
      const selected = account;
      await withAccountLock(store.profile(selected.id), async () => {
        await forgetSession(request, selected.id, deps);
        store.remove(selected.id);
      });
      const result = { status: 'removed', message: `已移除「${selected.name}」` };
      update(result);
      return result;
    }
    const result = await withAccountLock(store.profile(account.id), async (): Promise<Result> => {
      const draft = operation === 'prepare' ? await deps.draft(root) : null;
      progress(0.05, `正在打开「${account!.name}」的抖音窗口`);
      const browser = await deps.open(store.profile(account!.id), { bridge: request.browser, account: account!.id, label: account!.name, hint: draft ? '请检查账号与内容，发布由你确认' : '如需重新登录，请在这里登录原抖音账号，片场会自动更新账号资料' });
      try {
        const page = await deps.page(browser);
        // 窗口还停在这个成片的编辑页（上次等上传时中断了）：接着用，不跳回上传页重传。换了成片或页面已离开编辑页才重新上传。
        let resume = false;
        if (draft && browser.reused) {
          resume = store.lastUpload(account!.id) === draft.videoHash && await canResume(page);
          if (!resume) await page.navigate(page.origin + UploadPath);
        }
        if (!draft) {
          const result = await refreshOpenAccount(browser, page, store, account!, deps, message => {
            progress(0.1, message);
            update({ status: 'running', message, account });
          });
          account = result.account;
          return result;
        }
        // 视频交给抖音之后（或接着上次的上传）到填完：页面上盖遮罩显示进度，免得用户点乱。登录、找上传入口时不盖，用户可能要在页面上登录。
        // 旧版片场不认遮罩命令，照常进行。
        // 抖音弹出验证时揭开遮罩交给用户（paused），验证没了再按最近的进度盖上。
        let masked = false, paused = false, lastMessage = '', lastFraction = 0;
        const mask = (message: string, fraction: number) => {
          masked = true;
          lastMessage = message; lastFraction = Math.max(0, Math.min(1, fraction));
          if (!paused) void browser.busy?.(lastMessage, lastFraction).catch(() => {});
        };
        if (resume) mask('接着上次的上传', 0.2);
        let warnings: string[];
        try {
          warnings = await deps.prepare(page, draft, (fraction, message) => {
            progress(fraction, message); update({ status: 'running', message, account });
            if (masked && !paused) mask(message, fraction);
          }, {
            resume,
            onUpload: () => { store.recordUpload(account!.id, draft.videoHash); mask('正在上传视频', 0.2); },
            onPause: () => { paused = true; if (masked) void browser.idle?.().catch(() => {}); },
            onResume: () => { paused = false; if (masked) mask(lastMessage, lastFraction); },
          });
        } finally {
          if (masked) await browser.idle?.().catch(() => {});
        }
        await page.raw('Page.bringToFront');
        return { status: 'ready_to_publish', message: '内容已填好，请在抖音页面核对账号、封面和文案，再手动发布', account, warnings, video_sha256: draft.videoHash };
      } finally { browser.disconnect(); }
    });
    update(result); return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : '操作失败';
    update({ status: 'error', message, account });
    throw err;
  }
}

/**
 * 登录：给新账号开一个独立的网页存储，打开抖音，等用户在片场里的页面登录好，读出昵称与头像记下来，再把页面关掉回到片场。
 * 用户点「返回片场」收起页面、或十分钟没登录，就当不登了，新开的存储一起删掉。
 */
async function login(request: Request, store: AccountStore, progress: Progress, deps: typeof defaults): Promise<Result> {
  const id = newAccountID();
  progress(0.05, '正在打开抖音登录页');
  const browser = await deps.open('', { bridge: request.browser, account: id, label: '登录', hint: '请在下方登录抖音，登录后会自动回到片场' });
  let saved = false;
  try {
    const page = await deps.page(browser);
    progress(0.1, '等你在抖音页面登录…');
    const deadline = Date.now() + deps.loginTimeout;
    let info: scripts.LoginInfo | null = null;
    let profilePolls = 0;
    let avatar = '';
    for (;;) {
      if (Date.now() > deadline) throw Error('等了十分钟还没登录，这次没有添加账号');
      const state = await browser.state?.();
      if (state && (!state.open || !state.visible)) throw Error('登录页面关掉了，这次没有添加账号');
      const current = await readProfile(page);
      if (current && current.user_id === info?.user_id) {
        info = { ...current, name: current.name || info.name, avatar: current.avatar || info.avatar };
        profilePolls++;
      } else {
        info = current;
        profilePolls = current ? 1 : 0;
      }
      if (info?.name && info.avatar && (avatar = await loadAvatar(info.avatar, deps))) break;
      if (info && profilePolls >= 4) {
        if (!info.name) throw Error('已登录抖音，但读取不到昵称。请在抖音创作者中心确认账号后重试');
        break;
      }
      await deps.sleep(3000);
    }
    progress(0.9, `已登录「${info.name}」，正在保存账号`);
    const { account, replaced } = store.saveLoggedIn({ id, name: info.name, user_id: info.user_id, avatar });
    saved = true;
    await browser.close?.().catch(() => {});
    if (replaced) await forgetSession(request, replaced.id, deps).catch(() => {});
    return { status: 'logged_in', message: replaced ? `「${account.name}」重新登录好了` : `已登录：${account.name}`, account };
  } finally {
    // 没登录成：关掉页面，删掉为它开的存储，账号列表里不留半截的账号。
    if (!saved) await browser.close?.().catch(() => {});
    browser.disconnect();
    if (!saved) {
      await forgetSession(request, id, deps).catch(() => {});
      store.removeFiles(id);
    }
  }
}

/** 跳转中或离开创作者站点时，等下一次检查。 */
async function readProfile(page: Page): Promise<scripts.LoginInfo | null> {
  return page.evaluate(scripts.loginInfo).catch(() => null);
}

async function loadAvatar(url: string, deps: typeof defaults): Promise<string> {
  return url ? deps.avatar(url).catch(() => '') : '';
}

async function refreshOpenAccount(
  browser: BrowserConnection, page: Page, store: AccountStore, account: Account,
  deps: typeof defaults, waiting: (message: string) => void,
): Promise<Result> {
  const deadline = Date.now() + deps.loginTimeout;
  let info = await readProfile(page);
  if (!info) waiting(`如需重新登录，请在抖音窗口登录「${account.name}」，片场会自动更新账号资料`);
  while (!info && browser.state && Date.now() < deadline) {
    const state = await browser.state();
    if (!state.open) break;
    // 收起页面后最后读一次，用户可能刚登录就点了「返回片场」。
    if (state.visible) await deps.sleep(3000);
    info = await readProfile(page);
    if (!state.visible) break;
  }
  if (!info) return { status: 'login_pending', message: `暂未确认「${account.name}」的登录状态，可以再次打开抖音检查`, account };
  const checkAccount = (profile: scripts.LoginInfo) => {
    if (account.user_id && profile.user_id !== account.user_id) throw Error(`当前登录的抖音账号与「${account.name}」不同，请在这个窗口登录原账号后重新打开检查`);
  };
  checkAccount(info);
  if (!info.name || !info.avatar) {
    await deps.sleep(1000);
    const next = await readProfile(page);
    if (next) {
      checkAccount(next);
      if (next.user_id !== info.user_id) throw Error('抖音登录账号发生了变化，请重新打开检查');
      info = { ...next, name: next.name || info.name, avatar: next.avatar || info.avatar };
    }
  }
  const updated = info.name || account.user_id
    ? store.refreshProfile(account.id, { ...info, name: info.name || account.name, avatar: await loadAvatar(info.avatar, deps) })
    : account;
  if (!info.name) return { status: 'profile_pending', message: '抖音已登录，暂未读到昵称，账号资料未完整更新', account: updated };
  const message = updated.avatar ? `已刷新「${updated.name}」的账号资料` : `已刷新「${updated.name}」的昵称，暂未获取头像`;
  return { status: 'login_refreshed', message, account: updated };
}

async function forgetSession(request: Request, id: string, deps: typeof defaults): Promise<void> {
  const bridge = deps.bridge(request.browser);
  try { await bridge.forget(id); } finally { bridge.disconnect(); }
}
