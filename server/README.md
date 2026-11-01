# fanqie-bridge（SillyTavern 服务端插件）

给「小说阅读器」扩展做同源桥接：番茄下载器转发 + **书源抓取**（`/fetch`）+ Cookie（`/cookie`）。

## 为什么需要它

浏览器直接请求本地番茄下载器（默认 `http://127.0.0.1:18423`）会被跨域拦下：
下载器不返回 CORS 头，`OPTIONS` 预检直接 `405 Method Not Allowed`，响应读不到。
这个插件把同样的请求在**酒馆自己的域名下**转发一遍，前端只和酒馆同源打交道。

## 安装

本目录是「小说阅读器」仓库里的服务端那一半。**仓库根目录同时是扩展和插件**，两处装同一个仓库：

```bash
# ① 前端扩展
git clone <repo> public/scripts/extensions/third-party/novel-reader
# ② 服务端插件
git clone <repo> plugins/novel-reader
```

或者一条命令，让脚本把两半装好：

```bash
bash public/scripts/extensions/third-party/novel-reader/install-server.sh /path/to/SillyTavern
# 安卓 / sdcard 上没有可执行位，用 bash 或 node 调用，别用 ./
node public/scripts/extensions/third-party/novel-reader/setup.mjs install-server /path/to/SillyTavern
```

`config.yaml` 里确认（默认已开启）：

```yaml
enableServerPlugins: true
```

然后**重启酒馆进程**。日志出现下面这行即生效（插件 id 是 `fanqie-bridge`，目录名随便）：

```
Initializing plugin from .../plugins/novel-reader/index.mjs
```

**卸载**：`bash <扩展目录>/uninstall.sh /path/to/SillyTavern` —— 删扩展、删服务端插件、删 `/tmp/fanqie-bridge-*` 临时副本，
**保留** `<酒馆>/data/fanqie-bridge/` 里的用户数据。

插件无第三方依赖，只用 ST 自带的 Node 运行时（Node 18+ 的全局 `fetch`）与 `node:fs`。

## 书源抓取路由

| 路由 | 作用 |
| --- | --- |
| `GET /ping` | 存活探测，返回插件版本与支持的路由（不依赖番茄下载器） |
| `POST /fetch` | 代抓书源地址：`{ url, method, headers, body, charset, timeout, sourceKey, useCookie }`，返回解码后的 `{ text, status, finalUrl, headers }` |
| `GET /cookie?sourceKey=` | 读某个书源的 Cookie / 登录头 |
| `POST /cookie` | 写 Cookie / 登录头，`{ sourceKey, cookie }` 或 `{ sourceKey, loginHeader }`，`action: "clear"` 清空 |
| `POST /source-fetch` | 抓书源集合 JSON（Yiove 等订阅站） |

安全约束：

- `/fetch` 只允许公网 http(s)，默认拦截 localhost / 内网段；确需访问局域网时设 `NOVEL_BRIDGE_ALLOW_PRIVATE=1`；
- 响应上限 8 MB、POST 上限 512 KB、超时 3–120 秒；
- Cookie 按 `sourceKey` + 域名隔离，保存在服务端内存里（重启即清空）。

**改完服务端代码必须重启酒馆进程**，刷新页面不会重新加载插件。装好后先访问
`/api/plugins/fanqie-bridge/ping`，返回 `{"ok":true,...}` 才算生效；书源调试弹窗也会显示桥接状态。

## 自动托管下载器（默认开）

**只用启动酒馆**：插件会自己把本机的 `TomatoNovelDownloader` 拉起来，酒馆退出时一并关掉。

- 需要时（阅读器切到「番茄小说」或第一次搜索）调用 `GET /health?ensure=1`；
- 插件只在这几处找可执行文件（不再去 `~/fanqie` 之类的老文件夹翻）：`server/config.json` 的 `downloader` →
  仓库里的 `tools/`、`bin/`（相对本目录或它的上一级）→ 扩展目录下的 `tools/` → `data/<用户>/extensions/novel-reader/tools/`；
- 找到后**复制到系统临时目录**再执行（sdcard 之类挂载点常常 noexec），带上 `--server --data-dir <数据目录>`，
  并把 `cwd` 设成数据目录（下载器 `save_path` 为空时就用 cwd 存书，别让它往酒馆根目录吐书）；
- 数据目录默认 `<酒馆>/data/fanqie-bridge/`，首次启动会写一份 `config.yml`，并把
  `novel_format` 固定成 `txt`、`bulk_files` 固定成 `false`（`/book-text` 是按 txt 找书的）；
- 已经有一个下载器在跑（`/api/status` 能通）时不会再拉第二个。

关掉自动托管：`config.json` 里写 `{"autostart": false}`，或环境变量 `FANQIE_BRIDGE_AUTOSTART=0`。

### 配置文件 `plugins/fanqie-bridge/config.json`（可选）

放在 **`server/config.json`**（和本 README 同级）：

```json
{
  "autostart": true,
  "downloader": "/绝对路径/TomatoNovelDownloader-Android_arm64",
  "port": 18423,
  "dataDir": "data/fanqie-bridge"
}
```

环境变量优先级更高：`FANQIE_BRIDGE_AUTOSTART` / `FANQIE_BRIDGE_DOWNLOADER` / `FANQIE_BRIDGE_PORT` / `FANQIE_BRIDGE_DATA_DIR`。

> 注意：协议签名只在下载器里，桥接负责的是「找文件 + 拉进程 + 转发」。不想要这个进程只能另做协议实现。

## 上游（下载器）地址

- 默认：`http://127.0.0.1:18423`
- 覆盖方式一：环境变量 `FANQIE_BRIDGE_UPSTREAM=http://127.0.0.1:端口`（改完要重启酒馆）
- 覆盖方式二：前端每次请求带 `X-Fanqie-Upstream: http://127.0.0.1:端口`
  （阅读器里对应「找书 → 抓取设置 → 番茄下载器地址」）

两种覆盖都**只接受本机回环地址**（`127.0.0.0/8`、`localhost`、`::1`），否则返回
`400 BAD_UPSTREAM`，避免这个桥变成任意 SSRF 出口。

## 路由

基地址：`/api/plugins/fanqie-bridge`。登录校验沿用酒馆（`requireLoginMiddleware`），不额外开端口。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health[?ensure=1&timeout=12000]` | 桥接版本 + 下载器版本 / 保存目录 / 是否上锁；`ensure=1` 时没跑就自动拉起来 |
| POST | `/start` | 手动拉起下载器（等价于 `/health?ensure=1`） |
| GET | `/search?q=` | 转发下载器 `/api/search` |
| GET | `/preview/:bookId` | 转发 `/api/preview/:bookId` |
| POST | `/jobs` | 建任务，body `{ book_id, range_start?, range_end? }` |
| GET | `/jobs[?id=N]` | 任务详情 / 任务列表 |
| POST | `/jobs/:id/cancel` | 取消任务 |
| GET | `/book-text?book_id=&title=` | 在下载器保存目录里按 `book_id=` 找出整本 txt 并回传（`text/plain; charset=utf-8`） |

错误统一为 JSON：`{ ok:false, error:"…", code:"…" }`
（`BAD_REQUEST` / `BAD_UPSTREAM` / `UPSTREAM_NOT_FOUND` / `UPSTREAM_REJECTED` / `UPSTREAM_ERROR` /
`UPSTREAM_TIMEOUT` / `UPSTREAM_UNREACHABLE` / `UPSTREAM_BAD_BODY` / `NO_SAVE_DIR` / `TEXT_NOT_FOUND` / `TEXT_TOO_LARGE`）。

### /book-text 怎么找文件

1. 先问下载器 `/api/status` 拿 `save_dir`；
2. 在 `save_dir` 根目录和 `<save_dir>/<book_id>/` 里找 `*.txt`（按修改时间倒序）；
3. 读每个文件头 4 KB，匹配 `book_id=<id>`；
4. 都匹配不上时，退回按 `title` 比文件名；
5. 单文件上限 64 MB，超过返回 `413`。

所以下载器要输出**单文件 txt**（`novel_format: txt`、`bulk_files: false`）。epub / pdf / 散装模式取不回来。

## 排错

| 现象 | 看这里 |
| --- | --- |
| 阅读器提示「连不上番茄桥接」 | 酒馆重启了吗？`plugins/fanqie-bridge/index.mjs` 在不在？日志有没有 `Initializing plugin` |
| `/health` 返回 502 | 下载器没在跑，或端口不是 18423（用上面两种方式改上游） |
| `/search` 返回 502 | 下载器在跑但访问不了番茄接口（网络 / 下载器版本） |
| `/book-text` 返回 404 | 任务还没跑完，或下载器输出的是 epub/pdf/散装 |
| `/book-text` 返回 409 `TEXT_NOT_TXT` | 数据目录 `config.yml` 里 `novel_format` 不是 txt（托管实例会自动改成 txt） |
| `/health?ensure=1` 返回 503 | 没找到可执行文件，或起不来（看酒馆日志里的 `[fanqie-bridge]` 行） |
| 一切正常但页面空白 | 酒馆版本太老（`app.use(requireLoginMiddleware)` 之后才加载插件），升级到 1.19+ |
