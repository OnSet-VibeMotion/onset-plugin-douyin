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

export function coverPreviewReady(selector: string): boolean {
  return [...document.querySelectorAll<HTMLInputElement>(selector)].some(input => {
    const zone = input.closest('.upload-ZOJTUA') ?? input.closest('.semi-upload');
    return Boolean(input.files?.length && zone?.querySelector('.bg-UvmtRj, img[src^="blob:"], img[src^="data:"], [style*="blob:"], [style*="data:"]'));
  });
}

export function videoStatus(): 'ready' | 'failed' | 'waiting' {
  const status = [...document.querySelectorAll<HTMLElement>('[class*="long-card"], [class*="progress"], [role="alert"]')]
    .filter(node => node.getClientRects().length).map(node => node.innerText).join('\n');
  if (/上传失败|转码失败/.test(status)) return 'failed';
  return /重新上传|上传成功/.test(status) && !/正在上传|上传中|转码中/.test(status) ? 'ready' : 'waiting';
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
