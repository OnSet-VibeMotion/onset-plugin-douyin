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

export function loginInfo(uploadSelector: string): { name: string; avatar: string; user_id: string } | null {
  const hasLogin = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"], span')]
    .some(node => node.getClientRects().length && /^(扫码登录|手机号登录|验证码登录|登录\/注册|立即登录|登录抖音)$/.test(node.innerText.trim()));
  if (hasLogin || /(?:login|passport)/i.test(location.pathname)) return null;
  const profiles = [...document.querySelectorAll<HTMLElement>('header [class*="user" i], header [class*="account" i], [class*="header" i] [class*="user" i]')];
  const profile = profiles.find(node => node.getClientRects().length && node.querySelector('[class*="nick" i], [class*="name" i], img'));
  const name = profile?.querySelector('[class*="nick" i], [class*="name" i]')?.textContent?.trim() ?? '';
  const avatar = profile?.querySelector('img')?.src ?? '';
  const shortID = profile?.querySelector('[class*="short-id"]')?.textContent?.replace(/^抖音号[：:]\s*/, '').trim();
  const userId = profile?.getAttribute('data-user-id') ?? shortID ?? '';
  const uploadPage = location.pathname.startsWith('/creator-micro/content/')
    && [...document.querySelectorAll(uploadSelector)].some(node => node.parentElement?.getClientRects().length);
  return uploadPage || (name && avatar && userId) ? { name, avatar, user_id: userId } : null;
}
