import { Page, delay } from './cdp';
import { coverRatios, type CoverRatio, type Draft } from './draft';
import * as scripts from './page-scripts';

const coverSteps = `${scripts.coverDialog} :is([role="tab"], [class^="step-"])`;

export type Progress = (fraction: number, message: string) => void;
export async function preparePage(page: Page, draft: Draft, progress: Progress, options: { timeout?: number } = {}): Promise<string[]> {
  const timeout = options.timeout ?? 10 * 60_000;
  progress(0.1, '正在打开抖音视频上传页，请确认已登录');
  await page.waitFor(scripts.hasUpload, Math.min(timeout, 90_000), '找不到抖音视频上传入口，请检查登录状态和页面后重试', scripts.videoInput);
  progress(0.2, '正在上传视频，请保留抖音窗口');
  await page.upload(scripts.videoInput, draft.video);
  const deadline = Date.now() + timeout;
  for (;;) {
    const status = await page.evaluate(scripts.videoStatus);
    if (status === 'ready') break;
    if (status === 'failed') throw Error('抖音显示视频上传或处理失败，请在窗口检查');
    if (Date.now() >= deadline) throw Error('等待抖音上传完成超时，请在窗口检查');
    await delay(Math.min(timeout, 500));
  }

  progress(0.55, '正在填写标题、简介和话题');
  await page.fillTitle(draft.title);
  await page.fillContent(draft.content + (draft.tags.length ? '\n\n' : ''));
  for (const tag of draft.tags) {
    await page.type(`#${tag} `, 20);
  }
  const filled = await page.evaluate(scripts.filledContent);
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
  if (filled.title !== draft.title || !normalize(filled.content).includes(normalize(draft.content))) {
    throw Error('抖音页面上的标题或简介与发布信息不符，请在窗口检查');
  }
  const warnings = draft.tags.filter(tag => !filled.content.includes('#' + tag))
    .map(tag => `请在抖音页面检查话题「${tag}」是否已加入。`);

  let coverDialogContinued = false;
  for (const [index, ratio] of coverRatios.entries()) {
    const label = ratio === '3:4' ? '3:4 竖封面' : '4:3 横封面';
    const file = draft.covers[ratio];
    if (!file) {
      warnings.push(`发布信息里没有登记 ${label}，请在抖音页面确认封面。`);
      continue;
    }
    progress(0.7 + index * 0.1, `正在设置${label}`);
    try {
      coverDialogContinued = await setCover(page, ratio, file, Math.min(timeout, 20_000), {
        continued: coverDialogContinued,
        next: ratio === '3:4' && Boolean(draft.covers['4:3']),
      });
    } catch (error) {
      warnings.push(`${label}需要手动检查：${error instanceof Error ? error.message : '封面操作失败'}`);
      if (await page.evaluate(scripts.dialogOpen)) {
        if (ratio === '3:4' && draft.covers['4:3']) warnings.push('封面弹窗仍打开，请在抖音页面继续设置横封面。');
        break;
      }
    }
  }

  const readinessError = warnings.length ? warnings.join(' ') : '内容已填好，但抖音发布按钮尚未可用，请在窗口检查';
  await page.waitFor(scripts.publishReady, Math.min(timeout, warnings.length ? 3000 : 30_000), readinessError);
  progress(1, '视频和文案已准备，请在抖音页面检查后发布');
  return warnings;
}

async function setCover(
  page: Page, ratio: CoverRatio, file: string, timeout: number, { continued, next }: { continued: boolean; next: boolean },
): Promise<boolean> {
  if (!continued) {
    const mode = await page.evaluate(scripts.openCover, ratio);
    if (!mode) throw Error('找不到对应的封面入口');
    await page.waitFor(scripts.dialogOpen, timeout, '封面弹窗未打开');
    const label = ratio === '3:4' ? '设置竖封面' : '设置横封面';
    const controls = `${scripts.coverDialog} :is(button, [class*="title"], [class*="tab"])`;
    const selected = await page.click(coverSteps, label) || await page.click(controls, label);
    if (!selected && mode === 'shared') throw Error('找不到对应的封面选项');
  }
  await page.waitFor(scripts.hasUpload, timeout, '找不到唯一的封面上传控件', scripts.coverInput);
  const selector = scripts.coverInput;
  const previous = await page.evaluate(scripts.coverPreview, { selector });
  await page.upload(selector, file);
  await page.waitFor(scripts.coverPreview, timeout, '封面上传后未出现新预览', { selector, previous });
  // 共用弹窗里完成竖封面会弹出横封面推荐。两张都已登记时，先切到横封面，最后一起应用。
  if (next && await page.click(coverSteps, '设置横封面')) {
    await page.waitFor(scripts.coverStepActive, timeout, '未切换到横封面', '设置横封面');
    return true;
  }
  const done = `${scripts.coverDialog} :is(button, [role="button"])`;
  const deadline = Date.now() + timeout;
  while (!await page.click(done, '完成')) {
    if (Date.now() >= deadline) throw Error('封面处理未完成');
    await delay(Math.min(timeout, 250));
  }
  const finishDeadline = Date.now() + timeout;
  while (await page.evaluate(scripts.dialogOpen)) {
    await page.evaluate(scripts.confirmCover);
    if (Date.now() >= finishDeadline) throw Error('封面弹窗尚未关闭');
    await delay(Math.min(timeout, 250));
  }
  return false;
}
