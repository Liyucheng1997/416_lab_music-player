# 听音

参照 MusicBee 的功能、按 apple-minimal 设计语言做的本地音乐播放器（Electron）。

## 运行

```bash
npm install
npm start          # 正常启动
npm run dev        # 带开发者工具
npm test           # 单元测试（歌词解析、扫描索引、封面匹配）
```

首次启动会在欢迎页列出 MusicBee 扫描过的文件夹（读取 `音乐\MusicBee\MusicBeeLibrarySettings.ini`）和系统「音乐」文件夹，点「添加」即可建立索引。

## 功能

| 模块 | 说明 |
| --- | --- |
| 资料库 | 递归扫描文件夹，读取标签 / 内嵌封面 / 同目录或上级目录的封面图；按修改时间增量更新；监视文件夹自动更新；外接盘未连接时保留索引；跳过 macOS 的 `._` 隐藏文件 |
| CUE 整轨 | 按 `.cue` 把一张 CD 一个文件的整轨拆成单曲（CUE 里写的文件名与实际不符也能匹配），同一整轨里的相邻曲目无缝衔接 |
| 标签整理 | 去掉资源站水印（「【熊猫无损音乐www…】」「&熊猫无损音乐」）、格式前缀（「【Hi-Res】」）和「Unknown Artist」之类占位；没有歌手 / 专辑标签时从文件名、上级目录推断；没有专辑歌手的合辑按目录归成一张 |
| 分类浏览 | 歌曲（虚拟滚动、排序、多选，双击播放）、专辑、歌手（Deezer 歌手照片）、流派、年代、文件夹；我喜欢、最近播放、最常播放、最近添加 |
| 歌单 | 新建 / 重命名 / 删除，拖歌曲到侧栏歌单添加，导入导出 M3U8 |
| 播放 | 播放队列（拖动排序）、随机、单曲 / 列表循环、淡入淡出、10 段均衡器与预设、播放统计、Windows 媒体键与系统媒体浮窗、托盘菜单、恢复上次播放进度 |
| 格式 | MP3 / FLAC / M4A / OGG / OPUS / WAV 直接播放；APE / WMA / DSD / ALAC / WavPack 等用 ffmpeg 转码为 FLAC 缓存后播放 |
| 歌词 | 手动选择 → 同名 `.lrc`（自动识别 GBK）→ 内嵌歌词 → 在线歌词（网易云音乐 / QQ 音乐 / 酷狗 / LRCLIB 一起查，取最匹配的；繁体自动转简体）；支持翻译行、时间偏移、手动搜索或粘贴 |
| 桌面歌词 | 透明置顶窗口，逐字填色，双行（翻译 / 下一句），字号与颜色可调，锁定后鼠标穿透，悬停出现解锁按钮 |
| 封面 | iTunes（多地区）+ Deezer 搜索，按相关度排序；播放到没有封面的专辑时自动补全，专辑页可一键批量补全；只存在本应用数据目录，不改动音乐文件 |
| AI 赏析 | 用 Claude 生成随播放进度推进的逐段解读、流式整体赏析、追问对话、外文歌词翻译；结果按歌曲缓存 |
| AI 分类 | Claude 按风格 / 语言 / 情绪 / 场景给每首歌打标签，侧栏「AI 分类」按类浏览；搜索也能搜到分类（如「治愈」「睡前」）。标签存在 `ai-tags.json`，不改动音乐文件 |
| Bot 接入 | 内置 MCP 服务（设置 → Bot 接入），Bot 可以搜歌、点歌、切歌、调音量、看歌词、按心情放歌 |
| 软件内更新 | 启动时检查 GitHub Releases，有新版本时标题栏出现更新按钮，一键下载、静默安装、自动重启 |
| 外观 | 浅色 / 深色 / 跟随系统；沉浸式播放页（大封面、大字歌词、频谱、当前段落解读） |

## AI 赏析

在 设置 → AI 赏析 填写 Anthropic API Key（用 Windows 凭据加密保存）。默认模型 `claude-opus-5-5`，思考深度默认「快」；使用代理或中转服务可填接口地址。官方地址下会开启服务端兜底（主模型拒答时由推荐的备用模型接手）。

## Bot 接入（MCP）

在 设置 → Bot 接入 打开 MCP 服务，复制里面的配置给你的 Bot：

- **HTTP**（推荐）：`http://127.0.0.1:17890/mcp`，请求头 `Authorization: Bearer <令牌>`（或地址后加 `?token=<令牌>`）。无会话模式，直接返回 JSON。
- **stdio**：只支持命令行方式的客户端，用设置页给出的命令（借听音自带的 Electron 运行 `src/mcp-stdio.mjs`，不需要另装 Node.js）。听音没开时桥接脚本会自动启动它。
- 默认只监听本机；打开「允许局域网访问」后，同一局域网的设备凭令牌也能连。

工具：`now_playing` `player_control` `search_tracks` `play` `add_to_queue` `get_queue` `set_volume` `seek` `set_play_mode` `set_loved` `list_playlists` `list_categories` `get_lyrics` `classify_library`。例：`play {"scene":"睡前","lang":"粤语"}`。

## 发布新版本

1. 改 `package.json` 里的 `version`
2. 设置环境变量 `GH_TOKEN`（有 repo 权限的 GitHub 令牌），运行 `npm run release`，会构建并上传安装包和 `latest.yml` 到 GitHub Releases

已安装 1.1.0 及以后版本的用户会在启动时收到更新提示。便携版不能原地更新，会引导到下载页。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| 空格 | 播放 / 暂停 |
| ← / → | 后退 / 快进 5 秒 |
| Ctrl + ← / → | 上一首 / 下一首 |
| Ctrl + ↑ / ↓ | 音量 |
| Ctrl + F | 搜索 |
| Ctrl + L | 定位到正在播放 |
| Ctrl + I | 沉浸式播放页 |

## 目录

```
src/main/       主进程：窗口与协议(main.js)、资料库(library.js)、CUE 解析(cue.js)、在线歌词封面(online.js)、AI(ai.js)、AI 分类(classify.js)、
                MCP 服务(mcp.js、mcp-tools.js)、软件内更新(updater.js)、转码(transcode.js)
src/mcp-stdio.mjs  MCP stdio → HTTP 桥接
src/preload/    IPC 白名单
src/renderer/   界面：tokens.css 设计变量、app.css、js/ 各模块、desktop-lyrics.html 桌面歌词
build/          图标与图标生成脚本
test/           node:test 单元测试
```

数据（索引、封面缓存、歌词缓存、AI 缓存、AI 分类标签、转码缓存、设置）保存在 `%APPDATA%\听音`。
