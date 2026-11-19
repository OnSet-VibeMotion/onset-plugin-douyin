/** Functions in this file are serialized into Chromium and must be closure-free. */
export const videoInput = 'input.upload-input[type="file"], input[type="file"][accept*="video"], [class^="container"] input[type="file"]:not([accept*="image"])';
export const coverDialog = '.dy-creator-content-modal';
export const coverInput = [
  '.upload-ZOJTUA input.semi-upload-hidden-input[type="file"]',
  '.semi-upload:has(.semi-upload-drag-area-main-text) input.semi-upload-hidden-input[type="file"]',
].map(selector => `${coverDialog} ${selector}`).join(', ');

export function query(selector: string): Element | null {
  const inputs = [...document.querySelectorAll(selector)].filter(input => {
    return input instanceof HTMLInputElement && !input.disabled && (input.parentElement?.getClientRects().length ?? 0) > 0;
  });
  return inputs.length === 1 ? inputs[0] : null;
}

export function hasUpload(selector: string): boolean {
  return [...document.querySelectorAll<HTMLInputElement>(selector)].filter(input => !input.disabled && input.parentElement?.getClientRects().length).length === 1;
}

/**
 * 抖音接收文件后会清空输入框。以本次上传区的预览变化为准，避免把旧封面当作新图。
 * 在页内对图片地址做指纹，避免把整张 data URL 传回插件。
 */
export function coverPreview({ selector, previous }: { selector: string; previous?: string }): string {
  for (const input of document.querySelectorAll<HTMLInputElement>(selector)) {
    if (!input.parentElement?.getClientRects().length) continue;
    const zone = input.closest('.upload-ZOJTUA') ?? input.closest('.semi-upload');
    for (const preview of zone?.querySelectorAll<HTMLElement>('img, [style*="background"]') ?? []) {
      if (!preview.getClientRects().length) continue;
      const source = preview instanceof HTMLImageElement
        ? (preview.complete && preview.naturalWidth ? preview.currentSrc : '')
        : preview.style.backgroundImage;
      if (!source.includes('blob:') && !source.includes('data:image/')) continue;
      let hash = 0;
      for (let i = 0; i < source.length; i++) hash = (Math.imul(hash, 31) + source.charCodeAt(i)) | 0;
      const fingerprint = `${source.length}:${hash}`;
      return fingerprint === previous ? '' : fingerprint;
    }
  }
  return '';
}

/**
 * 视频卡片上的上传状态。percent 取文字里的百分比，没有再看进度条的 aria-valuenow，读不到为 null。
 * none 表示页面上没有视频卡片（还在上传入口页）。
 */
export interface VideoStatus { state: 'none' | 'uploading' | 'ready' | 'failed'; text: string; percent: number | null }
export function videoStatus(): VideoStatus {
  const nodes = [...document.querySelectorAll<HTMLElement>('[class*="long-card"], [class*="progress"], [role="alert"], [role="progressbar"]')]
    .filter(node => node.getClientRects().length);
  const text = nodes.map(node => node.innerText.trim()).filter(Boolean).join('\n').slice(0, 500);
  const bars = nodes.flatMap(node => [node, ...node.querySelectorAll<HTMLElement>('[role="progressbar"]')]);
  const match = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const bar = bars.find(node => node.hasAttribute('aria-valuenow'));
  const value = Number(bar?.getAttribute('aria-valuenow')), max = Number(bar?.getAttribute('aria-valuemax') || 100);
  const percent = match ? Math.min(100, Number(match[1]))
    : bar && Number.isFinite(value) && max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : null;
  if (/上传失败|转码失败/.test(text)) return { state: 'failed', text, percent };
  if (/重新上传|上传成功/.test(text) && !/正在上传|上传中|转码中/.test(text)) return { state: 'ready', text, percent };
  return { state: nodes.length ? 'uploading' : 'none', text, percent };
}

/**
 * 抖音弹出了要用户自己做的验证：滑块、点选验证码、短信或身份确认。字节的验证组件挂在 captcha / verify 容器或 iframe 里；
 * 身份确认是普通弹窗，按标题文字认。只认看得见的。
 */
export function verificationOpen(): boolean {
  const visible = (node: Element) => node.getClientRects().length > 0 && (node as HTMLElement).offsetWidth > 20 && (node as HTMLElement).offsetHeight > 20;
  const widgets = '#captcha_container, #captcha-verify-image, .captcha_verify_container, .captcha-verify-container, [class*="captcha_verify"], [class*="secsdk-captcha"], iframe[src*="captcha"], iframe[src*="verifycenter"], iframe[src*="verify.snssdk"]';
  if ([...document.querySelectorAll(widgets)].some(visible)) return true;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], .semi-modal, [class*="modal"]')]
    .some(dialog => visible(dialog) && /安全验证|身份验证|身份校验|请完成.{0,6}验证|验证码|滑块|拖动.{0,4}完成/.test(dialog.innerText.slice(0, 300)));
}

/** 页面停在作品编辑页（选好视频后才有标题框）。 */
export function editorOpen(): boolean {
  return [...document.querySelectorAll<HTMLInputElement>('input[placeholder*="作品标题"]')].some(input => input.getClientRects().length && !input.disabled);
}

export function publishReady(): boolean {
  if ([...document.querySelectorAll('[role="dialog"], .dy-creator-content-modal')].some(dialog => dialog.getClientRects().length)) return false;
  return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].some(element =>
    /^(发布|立即发布|定时发布)$/.test(element.textContent?.trim() ?? '') && element.getClientRects().length > 0
    && !element.matches(':disabled, [disabled], [aria-disabled="true"], [class*="disabled"], [class*="loading"]'));
}

export function dialogOpen(): boolean {
  return [...document.querySelectorAll('.dy-creator-content-modal')].some(dialog => dialog.getClientRects().length);
}

export function coverStepActive(label: string): boolean {
  return [...document.querySelectorAll('.dy-creator-content-modal :is([class*="step-active"], [role="tab"][aria-selected="true"])')]
    .some(node => node.getClientRects().length && node.textContent?.trim() === label);
}

export function clickControl({ selector, exactText }: { selector: string; exactText?: string }): boolean {
  const matches = [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(element => element.getClientRects().length && (!exactText || element.textContent?.trim() === exactText));
  const candidates = matches.filter(element => !matches.some(other => element !== other && element.contains(other)));
  if (candidates.length !== 1) return false;
  const element = candidates[0];
  const control = element.closest('button, [role="button"], input[type="submit"]') ?? element;
  if (/^(发布|立即发布|定时发布|确认发布)$/.test(control.textContent?.trim() ?? '') || control.matches('input[type="submit"]')) {
    throw Error('插件不允许点击发布按钮');
  }
  if (control.matches(':disabled, [disabled], [aria-disabled="true"], [class*="disabled"], [class*="loading"]')) return false;
  element.click();
  return true;
}

export function openCover(ratio: '3:4' | '4:3'): false | 'card' | 'shared' {
  const marker = ratio === '3:4' ? /竖(?:版)?封面\s*[（(]?\s*3\s*[:：]\s*4/ : /横(?:版)?封面\s*[（(]?\s*4\s*[:：]\s*3/;
  const controls = [...document.querySelectorAll<HTMLElement>('[class*="coverControl"]')].filter(node => node.getClientRects().length);
  const cards = controls.filter(node => marker.test(node.innerText));
  const card = cards.find(node => !cards.some(other => node !== other && node.contains(other)));
  const buttons = [...(card ?? document).querySelectorAll<HTMLElement>('button, [role="button"], [class*="title"], [class*="cover-"]')]
    .filter(node => node.getClientRects().length && /^(选择封面|编辑封面|设置封面)$/.test(node.innerText.trim()));
  const leaf = buttons.filter(node => !buttons.some(other => node !== other && node.contains(other)));
  if (leaf.length === 1) {
    leaf[0].click();
  } else if (card) {
    const preview = card.querySelector<HTMLElement>('[class*="cover-"], [class*="filter"]');
    if (!preview?.getClientRects().length || preview.closest('button, [role="button"]')?.textContent?.includes('发布')) return false;
    preview.click();
  } else {
    return false;
  }
  return card ? 'card' : 'shared';
}

export function confirmCover(): boolean {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], .semi-modal-content')]
    .filter(dialog => dialog.getClientRects().length && [...dialog.querySelectorAll('*')].some(node =>
      node.childElementCount === 0 && /^(是否确认应用此封面[？?]|确定完成[？?])$/.test(node.textContent?.trim() ?? '')));
  const dialog = dialogs.find(node => !dialogs.some(other => node !== other && node.contains(other)));
  const button = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(node =>
    /^(确定|确认)$/.test(node.innerText.trim()) && !node.disabled && node.getClientRects().length);
  if (!button) return false;
  button.click();
  return true;
}

export function fillTitle(title: string): void {
  const inputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder*="作品标题"]')].filter(input => input.getClientRects().length && !input.disabled);
  if (inputs.length !== 1) throw Error('找不到唯一的作品标题输入框');
  const input = inputs[0];
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, title);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function selectContent(): void {
  const fields = [...document.querySelectorAll<HTMLElement>('.zone-container[contenteditable="true"], [contenteditable="true"][data-placeholder*="简介"], [contenteditable="true"][aria-label*="简介"]')]
    .filter(node => node.getClientRects().length);
  if (fields.length !== 1) throw Error('找不到唯一的作品简介输入框');
  const field = fields[0];
  field.focus();
  const range = document.createRange();
  range.selectNodeContents(field);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function filledContent(): { title: string; content: string } {
  const title = [...document.querySelectorAll<HTMLInputElement>('input[placeholder*="作品标题"]')].find(node => node.getClientRects().length)?.value ?? '';
  const content = [...document.querySelectorAll<HTMLElement>('.zone-container[contenteditable="true"], [contenteditable="true"][data-placeholder*="简介"], [contenteditable="true"][aria-label*="简介"]')]
    .find(node => node.getClientRects().length)?.innerText ?? '';
  return { title, content };
}

export interface LoginInfo { name: string; avatar: string; user_id: string }

export async function loginInfo(): Promise<LoginInfo | null> {
  if (/(?:login|passport)/i.test(location.pathname)) return null;

  async function read(source: 'fast' | 'media'): Promise<LoginInfo | null> {
    const endpoint = source === 'fast' ? '/aweme/v1/creator/pc/user/info/' : '/web/api/media/user/info/?device_platform=web';
    try {
      const response = await fetch(endpoint, {
        credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      // UID 可能以 JSON 数字返回。取原始字符，避免超过安全整数时丢失精度。
      const data = JSON.parse(await response.text(), (key, value: unknown, context?: { source: string }) => {
        if (key === 'uid' && typeof value === 'number') {
          return context?.source ?? (Number.isSafeInteger(value) ? String(value) : '');
        }
        return value;
      }) as {
        status_code?: unknown;
        uid?: unknown;
        user_profile?: { nick_name?: unknown; avatar_url?: unknown };
        user?: { uid?: unknown; nickname?: unknown; avatar_thumb?: { url_list?: unknown } };
      } | null;
      if (data?.status_code !== 0) return null;
      const media = source === 'media' ? data.user : undefined;
      const rawUID = source === 'media' ? media?.uid : data.uid;
      const uid = typeof rawUID === 'string' ? rawUID.trim() : '';
      if (!/^[1-9][0-9]{0,79}$/.test(uid)) return null;
      const nickname = media ? media.nickname : data.user_profile?.nick_name;
      const thumbs = media?.avatar_thumb?.url_list;
      const avatarURL = media
        ? (Array.isArray(thumbs) ? thumbs.find(url => typeof url === 'string' && /^(https:)?\/\//i.test(url.trim())) : undefined)
        : data.user_profile?.avatar_url;
      const avatar = typeof avatarURL === 'string' ? avatarURL.trim() : '';
      return { name: typeof nickname === 'string' ? nickname.trim() : '', avatar: avatar.startsWith('//') ? 'https:' + avatar : avatar, user_id: uid };
    } catch { return null; }
  }

  // 详细资料接口可能不返回 UID。创作者中心的媒体接口把昵称、头像与 UID 放在同一个 user 里。
  const fast = await read('fast');
  if (fast?.name && fast.avatar) return fast;
  const media = await read('media');
  if (!fast || !media || fast.user_id !== media.user_id) return fast ?? media;
  return { name: fast.name || media.name, avatar: fast.avatar || media.avatar, user_id: fast.user_id };
}

/**
 * 上传页顶上的「你还有上次未发布的视频，是否继续编辑？」（2026-11-19 在真实页面上核对过：
 * span.hint-text-* 提示，后面是 span.continue-*「继续编辑」与 span.give-up-*「放弃」）。
 */
export function draftPromptOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('span, div, p')].some(node =>
    node.childElementCount === 0 && node.getClientRects().length > 0 && /上次未发布的视频/.test(node.textContent ?? ''));
}

/**
 * 那个没发完的视频：抖音存在网页本地存储 publish_form_cache:<用户编号> 的 cache.longFileInfo 里，
 * 带着本地文件的名字、大小与修改时间（毫秒，与文件的 mtime 一致）。没有就是 null。
 */
export function savedDraftFile(): { name: string; size: number; lastModified: number; duration: number | null } | null {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('publish_form_cache:')) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null');
      const file = value?.cache?.longFileInfo ?? value?.cache?.longFileMetaInfo;
      if (file && typeof file.size === 'number' && typeof file.lastModified === 'number') {
        return { name: String(file.name ?? ''), size: file.size, lastModified: file.lastModified, duration: typeof file.duration === 'number' ? file.duration : null };
      }
    } catch { /* 读不懂的不算 */ }
  }
  return null;
}

/** 点草稿提示里的「继续编辑」。只点这一个，不碰「放弃」。 */
export function continueDraft(): boolean {
  const nearPrompt = (node: HTMLElement) => {
    let parent = node.parentElement;
    for (let level = 0; parent && level < 4; level++, parent = parent.parentElement) {
      if (/上次未发布的视频/.test(parent.innerText.slice(0, 200))) return true;
    }
    return false;
  };
  const buttons = [...document.querySelectorAll<HTMLElement>('span, button, [role="button"]')].filter(node =>
    node.getClientRects().length > 0 && node.textContent?.trim() === '继续编辑' && nearPrompt(node));
  const candidates = buttons.filter(node => !buttons.some(other => other !== node && node.contains(other)));
  if (candidates.length !== 1) return false;
  candidates[0].click();
  return true;
}

export interface PublishedWork { title: string; duration: number; create_time: number; reviewing: boolean; is_private: boolean }
/**
 * 这个账号最近的作品（创作者中心作品管理用的接口，2026-11-19 核对过字段：item_title、duration 毫秒、create_time 秒、status）。
 * 读不到返回 null。
 */
export async function recentWorks({ pages, count = 12 }: { pages: number; count?: number }): Promise<PublishedWork[] | null> {
  const works: PublishedWork[] = [];
  let cursor = '0';
  for (let page = 0; page < pages; page++) {
    let data: any;
    try {
      const response = await fetch(`/janus/douyin/creator/pc/work_list?status=0&count=${count}&max_cursor=${cursor}&scene=star_atlas&device_platform=android&aid=1128`, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return page ? works : null;
      data = await response.json();
    } catch { return page ? works : null; }
    if (data?.status_code !== 0 || !Array.isArray(data.aweme_list)) return page ? works : null;
    for (const item of data.aweme_list) {
      works.push({
        title: String(item.item_title || item.desc || ''), duration: Number(item.duration ?? item.video?.duration ?? 0),
        create_time: Number(item.create_time ?? 0), reviewing: item.status?.in_reviewing === true, is_private: item.status?.is_private === true,
      });
    }
    if (!data.has_more) break;
    cursor = String(data.max_cursor);
  }
  return works;
}

/** 编辑页里预览视频的时长（秒）：抖音从服务器载入已经传上去的视频。没有为 null。 */
export function editorVideoDuration(): number | null {
  const durations = [...document.querySelectorAll('video')].map(video => video.duration).filter(value => Number.isFinite(value) && value > 0);
  return durations.length ? Math.max(...durations) : null;
}

/** 取 Page.launch 存在页面上的结果；页面跳转过、没启动过就返回 undefined，调用方自己再查一次。 */
export async function takeLaunched(key: string): Promise<unknown> {
  const store = (window as any).__onsetLaunched ?? {};
  const pending = store[key];
  delete store[key];
  return pending === undefined ? undefined : await pending;
}
