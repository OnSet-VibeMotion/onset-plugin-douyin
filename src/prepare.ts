import { Page, delay } from './cdp';
import { coverRatios, type CoverRatio, type Draft } from './draft';
import * as scripts from './page-scripts';

const coverSteps = `${scripts.coverDialog} :is([role="tab"], [class^="step-"])`;

export type Progress = (fraction: number, message: string) => void;
export interface PrepareOptions {
  /** 单步等待（上传入口、封面弹窗、发布按钮）的上限。 */
  timeout?: number;
  /** 窗口里已经是这个成片的编辑页（上次的等待中断了），接着它继续，不重新上传。 */
  resume?: boolean;
  /** 视频已交给抖音页面，调用方记下来，下次可以据此续接。 */
  onUpload?: () => void;
  /** 抖音弹出验证：调用方揭开遮罩交给用户（onPause）；验证没了、接着自动操作前再盖上（onResume）。 */
  onPause?: () => void;
  onResume?: () => void;
  /** 这个成片已经发过也照样上传（用户在插件页面点了「仍然上传」）。 */
  again?: boolean;
}

/** 查重时看最近多少条作品（接口约 60 毫秒一条）。 */
export const RecentWorksCount = 20;

/**
 * 抖音话题只认文字、字母、数字和下划线：带连字符、空格、点之类的（例如「U-Net」）输不成话题，直接跳过，
 * 不输进简介、也不提醒（2026-11-19 真实页面上「#U-Net」没变成话题）。
 */
export function douyinTopics(tags: string[]): string[] {
  return tags.filter(tag => /^[\p{L}\p{N}_]+$/u.test(tag));
}

/** 这个成片已经在这个账号发过（或在审核）：不上传，交给用户决定。 */
export class AlreadyPublished extends Error {
  constructor(readonly work: scripts.PublishedWork) {
    const day = new Date(work.create_time * 1000);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    super(`这个成片 ${date} 已经发到这个抖音账号了（「${work.title}」${work.reviewing ? '，正在审核' : ''}${work.is_private ? '，仅自己可见' : ''}），这次没有上传。确实要再发一次，请点「仍然上传」`);
  }
}

/** 已发布作品里有没有这个成片：标题相同、时长相差不到 1.5 秒（读不出成片时长时只看标题）。 */
export function findPublished(works: scripts.PublishedWork[], draft: Draft): scripts.PublishedWork | undefined {
  const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  return works.find(work => same(work.title, draft.title)
    && (draft.videoDuration == null || Math.abs(work.duration - draft.videoDuration) <= 1500));
}

/**
 * 页面上读回来的文字与发布信息是否一致。抖音的简介编辑器在每段末尾插零宽空格（U+200B），段落间的空行变成单个换行
 * （2026-11-19 在真实页面上核对过），所以先去掉零宽字符、把空白合并成一个空格再比；简介后面还跟着话题，只要求包含。
 */
export function sameText(onPage: string, expected: string, prefix = false): boolean {
  const normalize = (value: string) => value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const page = normalize(onPage), want = normalize(expected);
  return prefix ? page.includes(want) : page === want;
}

/** 抖音草稿里的视频是不是这个成片：大小一样、修改时间（毫秒）一样。 */
export function sameFilm(saved: { size: number; lastModified: number }, draft: Draft): boolean {
  return draft.videoSize !== undefined && draft.videoModified !== undefined
    && saved.size === draft.videoSize && Math.abs(saved.lastModified - draft.videoModified) <= 1;
}

/**
 * 上传页上有「上次未发布的视频」时：是这个成片就点「继续编辑」接着用（返回 true）；是别的视频就停下，
 * 不替用户放弃它，也不上传把它顶掉。没有草稿返回 false。
 */
async function restoreDraft(page: Page, draft: Draft, timeout: number): Promise<boolean> {
  // 草稿记在本地存储里：没有记录就不会有提示，不用干等。有记录时提示比上传框晚一点出来，稍等一下再判断。
  const saved = await page.evaluate(scripts.savedDraftFile);
  if (!saved) return false;
  try { await page.waitFor(scripts.draftPromptOpen, Math.min(timeout, 3000), ''); }
  catch { return false; }
  if (!sameFilm(saved, draft)) {
    const mb = (saved.size / 1024 / 1024).toFixed(1);
    throw Error(`这个抖音账号还有一个没发完的视频（${saved.name || '未命名'}，${mb} MB），继续上传会把它替换掉。请先在抖音窗口里处理它：继续编辑并发布，或点「放弃」，再点「上传并填写」`);
  }
  if (!await page.evaluate(scripts.continueDraft)) throw Error('抖音草稿里就是这个成片，但没点到「继续编辑」，请在抖音窗口里点一下后再试');
  await page.waitFor(scripts.editorOpen, Math.min(timeout, 60_000), '点了「继续编辑」，但抖音编辑页没有打开，请在窗口检查');
  return true;
}

/**
 * 抖音弹出验证（滑块、短信、身份确认）时：揭开遮罩、把窗口拿到前面，自动操作全部停下，等验证没了再接着做。
 * 等多久都行（用户可能要去拿手机）；想停可以在片场取消任务。返回停了多少毫秒。
 */
function verificationGuard(page: Page, progress: Progress, last: () => number, options: PrepareOptions): () => Promise<number> {
  const open = async (navigating: boolean) => {
    try { return await page.evaluate(scripts.verificationOpen); }
    catch (err) { if (/context/i.test(String(err))) return navigating; throw err; }
  };
  return async () => {
    if (!await open(false)) return 0;
    const started = Date.now();
    options.onPause?.();
    progress(last(), '抖音要求验证：请在抖音窗口完成验证，完成后自动继续');
    await page.raw('Page.bringToFront').catch(() => {});
    while (await open(true)) await delay(1000);
    // 验证刚关掉，页面可能还在刷新：稍等再接着做。
    await delay(1000);
    options.onResume?.();
    return Date.now() - started;
  };
}
export async function preparePage(page: Page, draft: Draft, report: Progress, options: PrepareOptions = {}): Promise<string[]> {
  const timeout = options.timeout ?? 10 * 60_000;
  let fraction = 0;
  const progress: Progress = (value, message) => { fraction = value; report(value, message); };
  // 视频交给抖音之后才检查验证：之前用户本来就在页面上操作（登录），不用停。
  const guard = () => { page.guard = verificationGuard(page, report, () => fraction, options); };
  try {
    return await fillPage(page, draft, progress, options, timeout, guard);
  } finally {
    page.guard = undefined;
  }
}

async function fillPage(page: Page, draft: Draft, progress: Progress, options: PrepareOptions, timeout: number, guard: () => void): Promise<string[]> {
  const warnings: string[] = [];
  if (options.resume) {
    guard();
    progress(0.2, '抖音窗口里已有这个成片，接着上次的上传继续');
  } else {
    progress(0.1, '正在打开抖音视频上传页，请确认已登录');
    // 已发布作品先在页面里开始查，和找上传框、看草稿同时进行，用的时候再取结果。
    if (!options.again) await page.launch('works', scripts.recentWorks, { pages: 1, count: RecentWorksCount }).catch(() => {});
    await page.waitFor(scripts.hasUpload, Math.min(timeout, 90_000), '找不到抖音视频上传入口，请检查登录状态和页面后重试', scripts.videoInput);
    if (await restoreDraft(page, draft, timeout)) {
      progress(0.2, '抖音草稿里就是这个成片，接着上次的上传继续');
    } else {
      if (!options.again) {
        progress(0.15, '正在检查这个成片是否已经发过');
        let works = await page.evaluate(scripts.takeLaunched, 'works').catch(() => undefined) as scripts.PublishedWork[] | null | undefined;
        if (works === undefined) works = await page.evaluate(scripts.recentWorks, { pages: 1, count: RecentWorksCount }).catch(() => null);
        const published = works && findPublished(works, draft);
        if (published) throw new AlreadyPublished(published);
        if (!works) warnings.push('没能读到这个账号已发布的作品，没有检查这个成片是否发过，请在抖音页面留意。');
      }
      progress(0.2, '正在上传视频，请保留抖音窗口');
      await page.upload(scripts.videoInput, draft.video);
    }
    options.onUpload?.();
    guard();
  }
  await waitForVideo(page, progress);

  progress(0.55, '正在填写标题、简介和话题');
  await page.checkpoint();
  await page.fillTitle(draft.title);
  await page.checkpoint();
  const topics = douyinTopics(draft.tags);
  await page.fillContent(draft.content + (topics.length ? '\n\n' : ''));
  for (const tag of topics) {
    await page.checkpoint();
    await page.type(`#${tag} `, 20);
  }
  await page.checkpoint();
  const filled = await page.evaluate(scripts.filledContent);
  // 对不上只提醒、不中断：封面照样要设，发布前用户本来就要在抖音页面核对一遍。
  if (!sameText(filled.title, draft.title)) warnings.push('抖音页面上的标题与发布信息不一致，请在抖音页面检查标题。');
  if (!sameText(filled.content, draft.content, true)) warnings.push('抖音页面上的简介与发布信息不一致，请在抖音页面检查简介。');
  warnings.push(...topics.filter(tag => !filled.content.includes('#' + tag))
    .map(tag => `请在抖音页面检查话题「${tag}」是否已加入。`));

  let coverDialogContinued = false;
  for (const [index, ratio] of coverRatios.entries()) {
    const label = ratio === '3:4' ? '3:4 竖封面' : '4:3 横封面';
    const file = draft.covers[ratio];
    if (!file) {
      warnings.push(`发布信息里没有登记 ${label}，请在抖音页面确认封面。`);
      continue;
    }
    progress(0.7 + index * 0.1, `正在设置${label}`);
    await page.checkpoint();
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

/**
 * 等抖音传完、处理完视频，不设时限：窗口开着、抖音没报失败，就一直等到传完再接着填写（大视频传多久都行）。
 * 想停可以在片场取消任务；页面跳转中读不到就下一轮再看，离开创作者中心或窗口关掉照常报错。
 */
async function waitForVideo(page: Page, progress: Progress): Promise<void> {
  let reported: number | null | undefined;
  for (;;) {
    await page.checkpoint();
    let status: scripts.VideoStatus | undefined;
    try { status = await page.evaluate(scripts.videoStatus); }
    catch (err) { if (!/context/i.test(String(err))) throw err; }
    if (status?.state === 'ready') return;
    if (status?.state === 'failed') throw Error('抖音显示视频上传或处理失败，请在窗口检查');
    const percent = status?.percent == null ? null : Math.floor(status.percent);
    if (status && percent !== reported) {
      reported = percent;
      progress(0.2 + 0.35 * (percent ?? 0) / 100, percent === null ? '正在上传视频，请保留抖音窗口' : `正在上传视频 ${percent}%，请保留抖音窗口`);
    }
    await delay(1000);
  }
}

/**
 * 编辑页里的视频是不是这个成片：时长与成片相差不到 50 毫秒。插件没记下指纹时（例如旧版插件传的、或在抖音草稿里点了「继续编辑」）靠它认。
 */
export async function editorHoldsFilm(page: Page, draft: Draft): Promise<boolean> {
  if (draft.videoDuration == null) return false;
  try {
    const seconds = await page.evaluate(scripts.editorVideoDuration);
    return seconds !== null && Math.abs(seconds * 1000 - draft.videoDuration) <= 50;
  } catch { return false; }
}

/** 上次的操作中断后再点：窗口停在编辑页、视频还在传或已传好，就能接着用（是不是同一个成片由调用方核对）。 */
export async function canResume(page: Page): Promise<boolean> {
  try {
    if (!await page.evaluate(scripts.editorOpen)) return false;
    const status = await page.evaluate(scripts.videoStatus);
    return status?.state === 'uploading' || status?.state === 'ready';
  } catch { return false; }
}

async function setCover(
  page: Page, ratio: CoverRatio, file: string, timeout: number, { continued, next }: { continued: boolean; next: boolean },
): Promise<boolean> {
  if (!continued) {
    await page.checkpoint();
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
  await page.checkpoint();
  await page.upload(selector, file);
  await page.waitFor(scripts.coverPreview, timeout, '封面上传后未出现新预览', { selector, previous });
  // 共用弹窗里完成竖封面会弹出横封面推荐。两张都已登记时，先切到横封面，最后一起应用。
  if (next && await page.click(coverSteps, '设置横封面')) {
    await page.waitFor(scripts.coverStepActive, timeout, '未切换到横封面', '设置横封面');
    return true;
  }
  const done = `${scripts.coverDialog} :is(button, [role="button"])`;
  let deadline = Date.now() + timeout;
  while ((deadline += await page.checkpoint(), !await page.click(done, '完成'))) {
    if (Date.now() >= deadline) throw Error('封面处理未完成');
    await delay(Math.min(timeout, 250));
  }
  let finishDeadline = Date.now() + timeout;
  while ((finishDeadline += await page.checkpoint(), await page.evaluate(scripts.dialogOpen))) {
    await page.evaluate(scripts.confirmCover);
    if (Date.now() >= finishDeadline) throw Error('封面弹窗尚未关闭');
    await delay(Math.min(timeout, 250));
  }
  return false;
}
