# 抖音上传助手

片场的独立发布插件。选择抖音账号后，插件会在片场内嵌的抖音创作者中心上传成片，填写标题、简介、话题和封面。检查完内容后，在同一个页面点击抖音的「发布」。

## 安装和使用

1. 在片场设置的「我的插件」里点「选择本地文件夹」，选择含 `onset-station.json` 的插件目录。查看详情后点「装上」。
2. 在项目发布页的「抖音」卡片点「登录新账号」，在片场打开的抖音页面完成登录。每个账号的登录状态由片场独立保存，各项目可以共用。
3. 准备成片与 `publish.md`。插件优先用 `copy.platform_titles.douyin`，否则用主标题。话题同理：优先用 `copy.platform_hashtags.douyin`（空列表表示不带话题），没写才用 `copy.hashtags`。封面支持 3:4 竖版和 4:3 横版，每个比例优先用给抖音登记的那张，其次用同一比例的明确候选。
4. 选中账号，点「上传并填写」。确认账号、文案、两张封面及必要的内容声明，再在抖音页面发布。遇到验证码或身份确认时，在抖音页面操作。
5. 想回到已经填写的页面时点「打开抖音」。再次点「上传并填写」会重新打开上传流程，可能替换当前编辑页。先检查已有内容再决定是否重传。

`production/douyin/state.json` 的 `ready_to_publish` 表示已准备到可供用户检查的阶段。作品是否已提交或审核通过，以抖音页面为准。

## 开发验证

`npm ci` 后可运行 `npm run check` 和 `npm run test:coverage`。浏览器测试使用本机 Chrome 与模拟创作者页面。用已构建的片场源码运行 `node scripts/check-host.mjs <片场源码目录>` 和 `node scripts/check-desktop.mjs <片场源码目录>`，验证清单、子进程调用和 Electron 内的交接。修改源码后重建 `dist/plugin.cjs`，它是安装必需文件。

## 流程来源

- [小红书上传助手](../onset-plugin-xiaohongshu) 的片场连接、账号列表和发布页交互。
- [auto-publish 抖音适配器](https://github.com/xiaoliangliang/auto-publish/blob/main/extension/content/adapters/douyin.js) 的页面控件和手动发布交接。
- [social-auto-upload 抖音上传器](https://github.com/dreammis/social-auto-upload/blob/main/uploader/douyin_uploader/main.py) 的上传状态与封面弹窗。

打包依赖 `yaml` 的 MIT 许可在 `licenses/`。
