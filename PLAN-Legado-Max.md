# 把 Legado Max 的书架 / 书源 / 阅读 / 找书搬到「小说阅读器」——源码级分析与实施方案

> 依据：`/root/share/DSHBox/SillyTavern/Legado_Max-main`（Kotlin 源码，约 41 MB，版本号 `3.<releaseTime>`）。
> 对照：本插件当前实现（`js/*`，数据库 v8，书架功能已按「阅读」重做）。
> 结论先说：**能搬，而且比只看 APK 时判断的更乐观**——浏览器自带 DOMParser、CSS 选择器、XPath，
> 原来最难的「HTML/XPath 解析」不用自己写；真正要重写的是**规则语法层、网络层、JS 沙箱和数据模型**。

---

## 0. 进度（滚动更新）

| 阶段 | 状态 | 交付 |
|---|---|---|
| **P0 书源内核** | ✅ 2026-10-31 | `js/rule/`（dom/jsonpath/compile/execute）、`js/net/`（url/client）、`js/source/model.js`、`js/book/`（text/pipeline）、`server/http.mjs` + `/fetch` `/cookie` 路由；23 项单测 |
| **P1 搜索/发现/详情/目录/正文 + 校验** | ✅ 2026-10-31 | 新书源管理（全字段/导入导出/四段校验）、找书接规则引擎、发现页、详情/目录/正文接在线阅读与下载；29 项单测 |
| **P2 书架联动** | ✅ 2026-10-31 | 书源书直接进书架、按章抓取、更新章节/未读、缓存管理、换源、编辑信息；章节缓存数据层测试 |
| **P3 阅读器补齐** | ✅ 2026-10-31 | 目录分卷/正倒序、书签、朗读、替换净化规则、阅读记录、图片章节（图片不落盘） |
| **P4 JS 沙箱** | ✅ 2026-10-31 | Worker 沙箱、`java.ajax/get/post` 同步取数、jsLib/importScript、登录 JS、书源调试器、JS 源标记 |
| **P5 打磨** | ✅ 2026-10-31 | 搜索历史、剪贴板导入/复制、渲染上限、书源规范化缓存、README 全量校对、版本 1.35.0 |

---

### 真机联调记录（2026-10-31）

- 新增 `dev/harness-browser.html`：用桩替 SillyTavern 上下文，直接加载真实 `js/ui.js`，可在普通浏览器 / Playwright 里点完整界面。
- 无头 Chromium 需要 CJK 字体（Noto CJK / ChillRound）才能渲染面板，否则渲染进程会崩；这是测试环境问题，不是插件问题。
- 真实酒馆页面（`http://127.0.0.1:8000`）验证通过：面板、导入、阅读、书源管理、调试、书签、JS 沙箱（配合网络 mock）。
- 联调中发现并修复：
  1. 弹窗 z-index（5）低于阅读设置（20），替换规则等弹窗被盖住 → 提到 60；
  2. `replaceRules` 存在顶层设置，运行时只拿到 online 子集 → 规则不生效 → 运行时改为合并顶层字段；
  3. `[hidden]` 被 `display:flex` 覆盖，批量条/搜索历史会拦截点击 → 加全局 `#nr-panel [hidden]{display:none!important}`；
  4. 开发 API 仍用旧书源字段（`name/url`）→ 改成新模型；
  5. 调试弹窗增加桥接状态（`/ping`），新装/更新后能直接看出插件是否加载。
- 「从链接导入书源」报 403：根因是前端调用 `/source-fetch` 时没带 `X-CSRF-Token`，被酒馆 CSRF 中间件拒绝（带 token 200，不带 403，已实测）。1.36.1 修好并加了友好提示。
- 桥接 `/ping` 在重启后已返回 200；`/fetch`、`/cookie` 用 Express 挂载实测通过（含 GBK 解码）。
- 仍需注意：8000 端口静态快照可能落后于工作区，真实页面测试前要同步并刷新。

### 第二轮反馈修复（1.36.2）

| 反馈 | 根因 | 修复 |
| --- | --- | --- |
| 搜索没结束，点结果打不开 | `openOnlineBookUrl` 在 `state.online.searching` 时直接 return | 改成先中断搜索（独立的 `bookAbort`）再打开这本书 |
| 发现点分类报「酒馆网页通道返回 500」 | 桥接 `/fetch` 失败后被吞掉，回退到网页通道，真实原因被 500 盖住 | 桥接错误（`BRIDGE_UPSTREAM` / `BRIDGE_HTTP`）不再回退，直接抛出并带 URL；403 单独提示 CSRF；发现 `exploreUrl` 支持 `@js` |
| 导入书源后正文末尾有 CSS | `@text` 取了 `textContent`，把 `<style>` 里的内容也算进去 | `nodeText` 跳过 script/style/noscript/template/svg 等 |
| 翻页动画不像「阅读」 | slide 只做了新页淡入；cover 带旋转；flip 淡出过快 | slide 改为旧页滑出 + 新页滑入；cover 去掉旋转只做覆盖滑走；flip 降低淡出、拉长时长 |
| 非 auto / dark 主题看不清 | 阅读区只覆盖了 `--nr-read-*`，章节字数、底部按钮仍用面板的 `--nr-muted`（酒馆深色值） | 每个主题同时定义 `--nr-muted/--nr-line/--nr-soft/--nr-hover`；侧栏与底栏改成「往正文色掺一点」而不是掺黑；对比度实测 ≥ 4.5:1 |

浏览器回归脚本：`dev/harness-fixes.cjs`（7 项）、`dev/harness-turns.cjs`（7 项）、`dev/harness-parallel.cjs`（5 项）、`dev/harness-ui-rows.cjs`（5 项），配合 `dev/harness-browser.html` 使用。

### 第三轮反馈修复（1.36.3）

| 反馈 | 根因 | 修复 |
| --- | --- | --- |
| 搜索没结束点结果，应该「解析完继续搜索」而不是中断搜索 | 上一版直接 abort 了搜索 | 打开书与搜索完全并行：各自一个 AbortController，搜索继续把剩余书源跑完；搜索期间的成功提示先挂起，等搜索结束再显示；期间不解锁搜索按钮防重复提交 |
| 每条书源末尾都有 CSS/HTML 代码 | `createElement(tag, cls, text)` 的第三参是 `textContent`，图标字符串被当文字渲染（`<i class="fa-solid …"></i>`） | 新增 `createIconButton()` 用 `innerHTML` 放图标，替换 6 处；书源行、分组行、书签行都验证过没有裸露代码 |
| （回归测试顺带发现）书源管理点「关闭」无反应 | 关闭按钮在 footer，代码却用 `ctx.body.querySelector` 查 | 改用 `ctx.foot.querySelector` |

### 第四轮反馈修复（1.36.4）

| 反馈 | 根因 | 修复 |
| --- | --- | --- |
| 下载慢，并发抓取改了没用 | 书源 `concurrentRate`（常见 `1/1000`）被无条件遵守，全局并发被压成 1 章/秒 | 新增 `respectRateLimit`（默认 **false**）：默认忽略书源并发率，按「并发抓取」发请求；抓取设置里可重新开启 |
| 卡在最后一章 | 单章请求无超时；整本一次写库卡主线程 | 单章看门狗 `chapterTimeoutMs`（默认 20s，可配）；`saveNovel` 改成分批事务（每 120 章）；进度条显示并发数与失败数 |
| 在线阅读「转码失败」 | 站点把错误 JSON 当正文返回（番茄系 API 需要登录） | 新增 `describeApiError()`：识别 `{code,message}` 错误体，提示「站点返回错误：转码失败（可能需要登录 / Cookie，或已失效）」 |
| 阅读里不能换源 | 只有书架「更多」里有入口 | 阅读工具栏新增「换源」按钮；换源弹窗支持自定义关键词重搜；本地书置灰 |

性能/健壮性验证：`dev/harness-perf.cjs`（8 项，含「源写 1/1000 时峰值并发 6、40 章 683ms、最后一章落库」）、`dev/harness-watchdog.cjs`（3 项，含「一章卡住时整本 5s 内结束且其余章节照存」）。

### 第五轮反馈修复（1.36.5）

| 反馈 | 根因 | 修复 |
| --- | --- | --- |
| 下载 5 分钟才一百多章 | 每章一次「浏览器 → 酒馆 → 站点」往返；往返开销远大于站点响应 | 桥接 1.3.0 新增 `POST /fetch-batch`（一次最多 40 个 URL、服务端用自身连接池并发抓）；客户端按 `并发×3` 一批预取，再在本地解析。实测 60 章：2.9s → **1.17s**，往返 62 → **4** |
| 下载停不下来 | 停止按钮只在搜索栏；下载卡片上没有入口 | 进度条旁新增「停止下载」按钮（`data-act="stop"`）；点后立即 abort，实测 **156ms** 结束，已抓 54/200 章正常入库 |
| （顺带）批量接口 404 会把桥接判死 | `/fetch-batch` 404 时错误地设置了 `bridgeAvailable=false` | 改为只标记 `batchUnavailable`，单章 /fetch 不受影响；老桥接自动退化成逐章（`dev/harness-legacy-bridge.cjs` 验证） |

回归脚本：`dev/harness-batch.cjs`（6 项）、`dev/harness-stop.cjs`（5 项）、`dev/harness-legacy-bridge.cjs`（4 项）。

### 第六轮反馈修复（1.36.6）

| 反馈 | 处理 |
| --- | --- |
| 搜索停止和下载停止应该分开 | `stopOnlineTask()` 拆成 `stopOnlineSearch()` / `stopOnlineDownload()`；搜索栏的停止只在搜索 / 打开书时出现（`syncOnlineStopButton` 不再把下载算进去），下载的停止只在进度条上；另外停止搜索后不再用「没搜到结果」覆盖「已停止搜索」 |
| 从别处触发搜索看不到进度 | `runOnlineSearch()` 开头自动切到「找书」页 |
| 吞吐再提升 | 批次从「并发×3 一串」改成「每组 6 个 URL × 并发组并行」→ 在途 = 并发×6（并发 8 → 48）；并发上限从 8 提到 16；实测 1.2s 延迟 / 300 章：**8.9 秒、33.5 章/秒** |
| 桥接旧时用户不知道 | 进度条追加「桥接旧，逐章抓（更新桥接能快很多）」 |

验证：`dev/harness-stop-split.cjs`（7 项：下载中不显示搜索停止、下载不被误停、下载未开始无停止按钮、搜索自行完成、停止只提示停止搜索）、`dev/harness-throughput.cjs`（3 项：300 章 / 1.2s 延迟下 ≥10 章/秒）。

回归脚本断言：`dev/harness-parallel.cjs` 校验「搜索中打开书 + 两个源都返回 + 慢源确实被请求」；`dev/harness-ui-rows.cjs` 校验书源 / 分组 / 书签三处行文本不含 `<i`、`fa-solid`、`class="`。

---

## 1. 源码事实（这次看到的）

### 1.1 关键文件与规模

| 模块 | 文件 | 行数 | 作用 |
|---|---|---|---|
| 规则引擎 | `model/analyzeRule/AnalyzeRule.kt` | 1299 | 规则拆分、`getString/getStringList/getElement`、JS 执行、变量 |
| 规则引擎 | `model/analyzeRule/AnalyzeUrl.kt` | 1167 | URL 拼装、URL 选项 JSON、POST/Header/Cookie/编码/重试 |
| 规则引擎 | `model/analyzeRule/RuleAnalyzer.kt` | 377 | `&&`/`||`/`%%` 切分、`{{}}` 内嵌规则、引号感知 |
| 解析器 | `AnalyzeByJSoup.kt` | 524 | 阅读自有选择器语法（`class.`/`tag.`/索引/`@` 链/属性） |
| 解析器 | `AnalyzeByXPath.kt` | 155 | XPath |
| 解析器 | `AnalyzeByJSonPath.kt` | 172 | JSONPath |
| 解析器 | `AnalyzeByRegex.kt` | 59 | 正则 |
| 书源流水线 | `model/webBook/BookList.kt` | 619 | 搜索 / 发现，映射成 `SearchBook` |
| 书源流水线 | `BookInfo.kt` | 504 | 详情页 |
| 书源流水线 | `BookChapterList.kt` | 764 | 目录、分卷、`nextTocUrl` 翻页 |
| 书源流水线 | `BookContent.kt` | 491 | 正文、`nextContentUrl`、替换、图片 |
| 书源流水线 | `SearchModel.kt` | 361 | 多源并发、边搜边合并、精确搜索 |
| 书源流水线 | `WebBook.kt` | 886 | 以上流水线的编排、换源、更新 |
| 校验 | `model/CheckSource.kt` + `service/CheckSourceService.kt` | 345 | 六项校验：域名/搜索/发现/详情/分类/正文 |
| JS 能力 | `help/JsExtensions.kt` | 1265 | `java.*` 全部可调用方法 |
| 实体 | `data/entities/BookSource.kt` 等 | 334 | 书源字段全集 |
| 实体 | `Book.kt` / `BookChapter.kt` / `SearchBook.kt` / `BookGroup.kt` | 约 500 | 书 / 章节 / 搜索结果 / 分组 |
| JS 引擎 | `modules/rhino/lib/rhino-1.7.14.jar` | — | Rhino（服务端规则 JS） |

### 1.2 和 3.2.3 APK 相比，Max 多出来的东西（之前清单要更新）

书源字段新增：`jsLib`（书源级 JS 库）、`enabledCookieJar`、`coverDecodeJs`、`variableComment`、
`exploreScreen`（发现筛选）、`ruleReview`（段评）、`eventListener`/`customButton`（事件回调）、
`nextPageLazyLoad`、`homepageModules`（首页模块）、`downloadUrls`（文件源下载地址）、
`bookSourceType = 4`（视频）。

规则字段新增：`TocRule.preUpdateJs / formatJs`、`ContentRule.subContent / title / imageDecode / payAction / callBackJs`、
`BookInfoRule.downloadUrls`、`SearchRule.updateTime`。

这些**大部分不在「书架 / 找书 / 阅读」主链路**上。本方案只搬主链路，视频/漫画/段评/首页模块/事件回调
列为「不搬」（见 §7）。

---

## 2. 能力对照：Android 实现 → 浏览器实现

| 能力 | Legado Max 实现 | 插件目标实现 | 结论 |
|---|---|---|---|
| HTML 解析 | Jsoup | **浏览器 DOMParser** | 直接换，更准 |
| 阅读自有选择器 | `AnalyzeByJSoup` 自写语法 | 自己实现语法层（`class.`/索引/`@` 链），底层用 `querySelectorAll` | 要写，约 700 行 |
| XPath | Jsoup XPath | `document.evaluate` | 直接换 |
| JSONPath | JsonPath 库 | 自写子集（`$..`、`[*]`、`[n]`、`[?()]` 简版） | 要写，约 300 行 |
| 正则规则 | Kotlin Regex | JS RegExp + 超时保护 | 直接换 |
| `@js:` / `{{}}` | Rhino（同步） | Worker + eval（同步 XHR 取数） | 要写，最难点 |
| 网络请求 | OkHttp（Method/Header/Body/Cookie/代理/重试） | 服务端 `/fetch` 路由 + 浏览器 fetch | 要写路由，约 300 行 |
| Cookie | `CookieStore`（按源隔离） | 服务端 CookieJar（按 sourceKey） | 要写 |
| 搜索并发 | 协程池 + 每源并发率 | `mapLimit`（已有）+ 并发率解析 | 复用 |
| 详情/目录/正文 | `BookInfo/BookChapterList/BookContent` | 同名 JS 模块 | 重写约 1500 行 |
| 缓存 | `CacheBookService` + 文件 | IndexedDB 分章缓存 + 任务队列 | 重写约 500 行 |
| 换源 | `ChangeBookSource*` | 同名对话 + 章节标题对齐 | 重写约 400 行 |
| 书源校验 | `CheckSourceService` 六项 | 同六项 + 失效筛选 | 重写约 300 行 |
| 书架 | Room + Compose | 已完成（v8 + 分组/排序/管理） | ✅ |
| 阅读器 | Compose 阅读页 | 已有阅读页，补目录/缓存/替换 | 增量 |
| 朗读 | 系统 TTS / HTTP TTS | Web Speech API（可选） | 降级 |

**关键判断**：浏览器原生 DOM 能力把「解析」这块的成本砍掉一半；剩下的成本集中在
**规则语法兼容**、**同步 JS 沙箱**、**网络与 Cookie**、**数据模型迁移**。

---

## 3. 目标架构

```
┌────────────────────── 浏览器（酒馆页面） ──────────────────────┐
│  书架（已完成）   找书 / 发现   详情页   目录   阅读页           │
│        │              │           │        │       │            │
│        └──────── BookService（统一书籍流水线）──────────────────┤
│                           │                                     │
│   RuleEngine（主线程）     │        RuleWorker（module worker）   │
│   ├ DOM / CSS / XPath     │        ├ eval 沙箱（with + eval）    │
│   ├ JSONPath / 正则        │        ├ java.ajax → 同步 XHR       │
│   ├ @put/@get/{{}}/##     │        └ jsLib / 登录脚本            │
│   └ 规则追踪（调试器）      │                                     │
│                           │                                     │
│   NetClient（异步 fetch）──┼──────────────┐                     │
│   BookStore（IndexedDB v9）│              │                     │
└───────────────────────────┼──────────────┼─────────────────────┘
                            │              │
              /api/plugins/novel-reader-bridge/fetch
                            │              │
┌───────────────────────────▼──────────────▼─────────────────────┐
│ 酒馆服务端桥接：Method/Header/Body/重定向/超时/重试/编码          │
│ CookieJar（按书源隔离）/ 并发闸门 / SSRF 白名单 / 响应大小上限     │
└─────────────────────────────────────────────────────────────────┘
```

为什么 JS 要放 Worker：

1. Legado 规则里的 `java.ajax(...)` 是**同步**的，Rhino 能阻塞；浏览器主线程 `fetch` 是异步的，无法阻塞。
2. Worker 里允许同步 XHR（主线程不允许），用 `XMLHttpRequest(..., false)` 打**同源**的 `/fetch` 路由，
   就能得到「同步取网页」的语义，规则不用改写。
3. Worker 里没有 DOMParser，但 `java.getString` 可以在 Worker 内用插件已有的
   `parseHtml/querySelectorAll`（纯 JS）实现；复杂 XPath 规则可以回退到主线程（见 §5.3）。

---

## 4. 数据模型（IndexedDB v9）

保留现有 `novels/chapters/contents` 表名，**加字段而不是换表**，老书架无损升级：

```js
// novels 追加（原字段保持不变）
{
  origin: 'local' | '<bookSourceUrl>',  // 书源
  originName: '',                        // 书源名
  bookUrl: '',                           // 详情页（本地书 = 文件名）
  tocUrl: '',                            // 目录页
  kind: '', coverUrl: '', intro: '',
  latestChapterTitle: '', latestChapterTime: 0,
  lastCheckTime: 0, lastCheckCount: 0,
  totalChapterNum: 0,
  durChapterIndex: 0, durChapterPos: 0, durChapterTime: 0,
  canUpdate: true,
  groupId: '',        // 已有（书架分组）
  order: 0,           // 已有 manualOrder 的兼容别名
  pinnedAt: 0,        // 已有
  unreadCount: 0,     // 已有
  type: 0,            // 0 文本 / 1 音频 / 2 图片 / 3 文件（先只做 0、2）
  wordCount: '',
  variable: '{}'      // 书源/书籍变量
}

// chapters 追加
{ url: '', isVolume: false, isVip: false, isPay: false, baseUrl: '', tag: '', wordCount: '' }

// 新表
bookSources  { id(=bookSourceUrl), name, group, type, enabled, enabledExplore,
               order, weight, concurrentRate, header, loginUrl, loginUi, loginCheckJs,
               jsLib, exploreUrl, exploreScreen, searchUrl,
               ruleSearch, ruleExplore, ruleBookInfo, ruleToc, ruleContent,
               bookUrlPattern, lastUpdateTime, respondTime, raw }
sourceGroups { id, name, order }
searchHistory { id, keyword, time }
sourceVars   { key: `${sourceId}:${name}`, value }
cookies      { key: `${sourceId}:${domain}`, value }   // 也可放服务端
```

---

## 5. 五个关键技术方案

### 5.1 规则引擎：把 `AnalyzeRule` 拆成三层

**第一层：规则编译**（对应 `RuleAnalyzer` + `AnalyzeRule.SourceRule`）

```js
// js/rule/compile.js
compileRule('@css:.book-list@tag.li@text') =>
  [{ mode: 'css', chain: ['.book-list', 'li'], attr: 'text' }]

compileRule('class.list@tag.li@href##^//##https://') =>
  [{ mode: 'css', chain: ['.list','li'], attr: 'href',
     replace: { regex: '^//', replacement: 'https://' } }]

compileRule('{{java.ajax(baseUrl)}}@Json:$.data[*]') =>
  [{ mode: 'js', code: 'java.ajax(baseUrl)' },
   { mode: 'json', path: '$.data[*]' }]
```

要支持（源码依据）：

- 前缀：`@@`（默认）、`@css:`、`@XPath:`、`@Json:`、`/` 开头自动 XPath、`$`/`$[` 自动 JSONPath
- `:正则`：**只用于列表规则**（书籍列表 / 目录列表，走 `getElements`），`getString` 不认
- `##正则##替换` / `##正则##替换###`（只替换第一个）
- `@put:{...}`（解析时先保存变量）、`@get:{...}`（取变量）
- `{{js}}` 内嵌、`@js:` 整段、`<js>...</js>`、`@webjs:`（WebView）
- `&&` / `||` / `%%`（并集 / 取第一个非空 / 逐项交叉拼接）
- 阅读自有链式写法：`class.x`、`tag.x`、`id.x`、`text.x`、`children`、
  `@text/textNodes/ownText/html/all/属性名`、索引 `[-1]`、`[0:3]`、`[0,2]`、`.1`、`!0`
  （源码：`AnalyzeByJSoup.kt` 的 `ElementsSingle`）

**第二层：选择器执行**

- 纯 CSS：`querySelectorAll`（浏览器）
- 阅读链式：先 `translateChainToCss()`，索引/排除在结果数组上做
- 属性取值：`text`（`textContent` 压缩空白）、`ownText`（直接子文本节点）、`textNodes`（每行）、
  `html`（去 script/style 的 innerHTML）、`all`（outerHTML）、其它按属性名
- XPath：`document.evaluate`，返回节点/字符串/数字
- JSONPath：自写（`$`、`.`、`..`、`[*]`、`[n]`、`[start:end]`、`[?(@.x)]` 简版）
- 正则：`String.match` + 超时（用 `performance.now()` 在循环里检查）

**第三层：上下文与变量**

```js
class RuleContext {
  content; baseUrl; result; book; chapter; source;
  vars;              // 对应 @put / @get 与 source.put/get
  redirectUrl;
  trace;             // 调试器用：每步规则、命中数、耗时、首条结果
}
```

验收：拿 3 个真实书源（CSS 站、JSON API 站、链式写法站）跑「搜索→详情→目录→正文」，
结果与 App 内一致（书名/作者/章节数/首章前 200 字）。

### 5.2 网络层：服务端 `/fetch` 路由

现在 `server/index.mjs` 只有番茄和「书源 JSON 抓取」；新增通用路由：

```http
POST /api/plugins/novel-reader-bridge/fetch
Content-Type: application/json
{
  "url": "https://example.com/search?q=xx",
  "method": "GET|POST|HEAD",
  "headers": { "User-Agent": "...", "Referer": "..." },
  "body": "a=1&b=2",              // POST
  "charset": "gbk|utf-8|escape",  // 可选
  "timeout": 15000,
  "retry": 1,
  "sourceKey": "https://example.com",  // CookieJar 隔离键
  "useCookie": true,
  "allowRedirect": true
}
→ { ok, status, finalUrl, headers, text, bytes(base64 可选), elapsed }
```

服务端要点（对应 `AnalyzeUrl.kt`）：

- URL 选项 JSON：`,{"method":"POST","body":"...","headers":{...},"charset":"gbk","retry":1,"js":"..."}`
- `js` 选项：先跑 JS 改 URL（在 Worker 里执行，再把结果交给 fetch）
- 表单编码：`name=value` 逐段 URL 编码，`charset=escape` 走 escape
- 编码：优先响应头 charset，其次 `<meta charset>`，默认 UTF-8；GBK 用 `TextDecoder('gb18030')`
- Cookie：按 `sourceKey` 存，自动回填；`source.putLoginHeader()` 写入的 Cookie 也进同一个罐
- 并发率：`concurrentRate` 支持 `"3/1000"`、`"2/2000"` 这类写法（源码在 `ConcurrentRateLimiter`）
- 安全：只允许 http/https；禁止 localhost/内网段（可配置）；响应上限（比如 8 MB）

### 5.3 JS 沙箱：Worker + 同步 XHR

协议：

```js
// 主线程 → Worker
{ type: 'eval', code, bindings: { baseUrl, result, book, chapter, source, vars },
  content, contentType }           // content 用于 java.getString
// Worker → 主线程
{ ok: true, value, logs: [], trace: [] }
```

Worker 内提供的 `java` 对象（只搬主链路常用项，来源 `JsExtensions.kt` + `AnalyzeRule.kt`）：

| 方法 | 说明 |
|---|---|
| `java.ajax(url)` | 同步 XHR → `/fetch`，返回文本 |
| `java.get(url, headers?)` / `java.post(url, body, headers?)` / `java.connect(...)` | 同上，返回带 `body()/header()` 的对象 |
| `java.getString(rule, content?)` / `getStringList` / `getElement` / `getElements` | Worker 内解析（CSS/JSON/正则） |
| `java.put(k,v)` / `java.get(k)` | 源变量 |
| `java.base64Encode/Decode`、`md5Encode`、`timeFormat`、`htmlFormat`、`encodeURI` | 字符串工具 |
| `java.log/toast` | 回传日志到调试面板 |
| `java.importScript(name)` | 拉取并缓存远程 JS（对应 `jsLib`） |
| `source.getKey/getVariable/putVariable/getLoginHeader/putLoginHeader/login` | 登录与源状态 |
| `cookie.getCookie/putCookie/replaceCookie` | 通过同步 XHR 打 `/cookie` 路由 |
| `book/chapter` | 只读对象（name、author、bookUrl、title、index…） |

限制与降级：

- `java.queryTTF` / `replaceFont`（字体反爬）→ 不搬，遇到就在校验里标「不支持」；
- `java.webView` / `startBrowser` / 视频播放 → 不搬；
- XPath 规则在 Worker 内无 DOM，改为回传「需要 XPath」给主线程解析（规则里 XPath 与 JS 混用较少）；
- 规则执行设超时（10 s）与循环保护。

### 5.4 书籍流水线（`WebBook` 的 JS 版）

```js
// js/book/service.js
async function searchSource(source, keyword, page) → SearchBook[]
async function getBookInfo(source, book) → Book
async function getChapterList(source, book, { fromCache }) → BookChapter[]
async function getContent(source, book, chapter) → { text, nextUrl, images }
async function updateBook(book) → { added, removed, latestChapterTitle }
async function changeSource(book, newSource) → { chapterMap, unmatched }
```

细节对齐源码：

- 搜索：并发 + 每源状态 + `originOrder` + 精确搜索（`name.contains(keyword) || author.contains`，`SearchModel.kt:136`）
- 详情：`ruleBookInfo.init` 预处理；`tocUrl` 缺省回退 `bookUrl`；`canReName`
- 目录：`chapterList` 多页（`nextTocUrl`，最多 5 页防死循环）、`isVolume` 分卷、`formatJs`、倒序修正
- 正文：`content` 多页（`nextContentUrl`）、`subContent`、`replaceRegex`、`sourceRegex`、`imageStyle`
- 缓存：章节级 IndexedDB；缓存任务队列（并发 + 暂停/继续/取消）
- 更新：比对 `chapterUrl` 集合，新增章节写 `unreadCount`、`latestChapterTitle`
- 换源：按 `name+author` 搜索 → 章节标题归一化对齐 → 保留阅读进度（按标题匹配，匹配不到按百分比）

### 5.5 UI 增量

| 页面 | 现状 | 要补 |
|---|---|---|
| 书架 | ✅ 分组/排序/管理/继续阅读 | 更新按钮、未读数、缓存入口、换源入口 |
| 找书 | 三通道搜索 | 按源/分组搜索、结果字段（分类/字数/最新章节/封面）、搜索历史、发现页 |
| 详情 | 只有书籍卡 | 完整详情页（封面/简介/目录/加入书架/换源/缓存） |
| 书源管理 | 简化导入 | 全字段编辑、校验、调试器、分享/导出、分组/置顶 |
| 阅读 | 已有阅读页 | 目录分卷、章节缓存、替换净化、图片章节、TTS（可选） |

---

## 6. 实施顺序（每一阶段都可独立验收）

| 阶段 | 内容 | 交付 | 预估 |
|---|---|---|---|
| **P0** | 数据模型 v9 + 书源模型 + `/fetch` 路由 + 规则编译/执行（CSS/JSON/正则/`##`/`@put/@get`） | 能在 Node 下用真实 HTML 跑通 20 条规则用例 | 4–6 人日 |
| **P1** | 搜索 / 发现 / 详情 / 目录（`nextTocUrl`）/ 正文（`nextContentUrl`）/ 书源校验 | 3 个真实源端到端跑通；校验能标失效 | 5–7 人日 |
| **P2** | 书架接入书源书：更新章节、未读、缓存、换源、书籍信息编辑 | 书架能更新/缓存/换源 | 4–5 人日 |
| **P3** | 阅读器补齐：目录分卷、章节缓存、替换净化、图片章节 | 长书 500 章流畅阅读 | 4–6 人日 |
| **P4** | JS 沙箱（Worker + `java.*` + `jsLib` + 登录 Cookie + 调试器） | `@js:` 源能跑；调试器显示每步规则 | 6–8 人日 |
| **P5** | 打磨：书源导入导出/分享、搜索历史、阅读记录、TTS、性能 | 发布候选 | 5–8 人日 |

合计 **28–40 人日**（不含视频/漫画/段评）。其中 P0–P2 是「能用」的分水岭，约 13–18 人日。

---

## 7. 不搬 / 降级的部分（明确边界）

**不搬**：视频书源（type 4）、漫画阅读器、段评（`ruleReview`）、首页模块（`homepageModules`）、
事件监听回调（`eventListener`/`callBackJs`）、自定义按钮、WebView 登录、本地文件管理、WebDav 备份（可后补）。

**降级**：

- 字体反爬（`queryTTF/replaceFont`）→ 不支持，校验时提示；
- 图片解密（`imageDecode`）→ 先不执行自定义 JS 解密；
- TTS → Web Speech API，不支持 HTTP TTS 引擎；
- 登录 → 只支持 `header`/`loginUrl` 的 Cookie 方案 + 手动粘贴 Cookie，不模拟 WebView。

**风险**：

1. 站点反爬（Cloudflare/JS 挑战）→ 服务端 fetch 可能被拒；保留「浏览器直连」兜底与手动 Cookie。
2. `@js:` 规则滥用 `java.*` 之外的能力 → Worker 白名单里没有的调用会报错，需在校验里归类为「不支持」。
3. 大型书源（几千章）缓存 → IndexedDB 配额与写入节流，需要分批事务。
4. 数据迁移 → v8→v9 只加字段不换表，回滚安全（旧字段不动）。

---

## 8. 下一步（从「书源」开始，第一批文件）

1. `js/source/model.js`：书源字段全集 + 导入/导出/规范化（兼容 Legado JSON 与 Max 新字段）
2. `js/rule/compile.js` + `js/rule/execute.js`：规则编译与 CSS/JSON/正则执行（先不做 JS）
3. `server/fetch.mjs` + `server/index.mjs` 新路由：`/fetch`、`/cookie`
4. `js/net/client.js`：URL 选项、编码、重试、并发率
5. `js/book/pipeline.js`：搜索 → 详情 → 目录 → 正文最小闭环
6. UI：书源管理全字段编辑 + 搜索结果显示新字段

验收：任选 3 个真实书源，完成「搜索 10 条结果 → 打开详情 → 拉 100 章目录 → 读 3 章正文」，
再跑一次六项校验，把失败源标出来。
