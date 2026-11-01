# tools/ —— 番茄下载器

「找书 → 番茄小说」需要一个本地的 `TomatoNovelDownloader` 可执行文件（番茄的签名协议只在它里面）。
把可执行文件放进这个目录，**服务端插件 `plugins/fanqie-bridge` 会自动发现并托管它**，不用再手动启动，
也不用去找原来的 fanqie 文件夹。

- 默认放的是 **Android arm64** 版（`TomatoNovelDownloader-Android_arm64`）。
- 换平台就把对应平台的二进制同名放进来（或改 `plugins/fanqie-bridge/config.json` 的 `downloader` 绝对路径）。
- 文件名只要包含 `TomatoNovelDownloader` 就会被认出来。
- 插件只认这三处：`plugins/fanqie-bridge/bin` → 本目录 → `data/default-user/extensions/novel-reader/tools`（按用户装扩展时）。
  不再去 `~/fanqie` 之类的老文件夹找，所以原 fanqie 文件夹可以删。

运行数据（下载的书、config.yml、日志）默认在 `<酒馆>/data/fanqie-bridge/`，不在这个目录里。
