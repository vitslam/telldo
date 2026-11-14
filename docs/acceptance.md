# Telldo 0.1.0 验收记录

日期：2026-11-14（Asia/Shanghai）。所有开发、测试、构建和 Git 提交在公司 Linux 主机完成，目录 `/opt/telldo`。用户没有要求新增 Web 服务；产物为桌面应用。

## 已执行通过

| 验收 | 结果 |
| --- | --- |
| TypeScript 全量检查、Electron/React 生产构建 | 通过 |
| Task Service、设置、事务、备份导入、提案与撤销 | 22/22 通过 |
| 日期、时区、智能视图、重复与提醒 | 13/13 通过 |
| Codex 能力探测、流式协议、错误与取消 | 23/23 通过 |
| SSH Mac 端适配器 | 31/31 通过 |
| SSH Python 助手进程生命周期 | 10/10 通过 |
| 合计自动测试 | **99/99 通过（89 TypeScript + 10 Python）** |
| 真实 Electron、无 Codex 手动操作 | 通过，无 renderer error |
| 打包后的 Linux 可执行文件重复同一界面验收 | 通过 |
| 真实远端 Codex 合成数据调用 | 13.819秒成功，无工具调用、未写业务库 |
| Apple Silicon Mac 手动桌面流程 | 实机通过，无 renderer error |
| Mac → SSH → 公司 Codex → Mac Task Service | 实机通过，14.055秒完成创建及撤销，手动任务保留 |

手动界面自动流程包含：中文自然日期新建、日期/时刻字段检查、备注、标签、子任务、搜索父任务备注和子任务标题、完成/重新打开、已完成显示、新建清单、中英语言切换。验收数据库位于临时目录，退出后清理；`artifacts/telldo-preview.png` 为临时合成任务的中文三栏截图，不是用户真实任务。

日期测试包括每月31日落月末、DST同一墙上时间、春季不存在时刻的原实例键、远期实例可见性、排除日期、次数和截止限制。JSON 导出/备份拒绝活库及 WAL/SHM 的路径和软硬链接别名；导入往返验证包含 DST 实例。提案测试包含已确认父任务的子任务版本变化、范围限制、全部回滚、幂等和撤销冲突。

## 复现

在公司主机运行：

```bash
cd /opt/telldo
source scripts/env.sh
npm run build
npm test
npm run test:ssh-runner
npm run test:headless
TELLDO_EXECUTABLE="$PWD/release/linux-unpacked/telldo" npm run test:headless
```

`test:headless` 会启动项目内 Xvfb（无 TCP 监听）并在退出时清理进程。当前主机已将 Ubuntu 的 xvfb、xserver-common、libxfont2、x11-xkb-utils、xkb-data 解包到 `.tools/xvfb/`；因系统缺少 xkbcomp，项目内 Xvfb 的编译器路径改为 `.tools/b/xkbcomp`，未修改系统文件。这只是验收环境，桌面应用本身不依赖 Xvfb。

普通图形桌面环境用 `npm run test:smoke`。`TELLDO_TEST_DATA` 是验收用隔离目录环境变量，正常使用无需设置。

## 产物与限制

- Linux x64：`release/linux-unpacked/telldo`，已实际启动并完成验收。正常运行需要图形桌面会话；无图形环境的 SSH 终端不能直接显示桌面窗口。
- macOS Apple Silicon、Intel：交叉打包过程和最终文件见 [macOS 打包说明](macos-packaging.md)。运行时 ZIP 按官方 SHA256 核验，检查目标 Mach-O 架构、必要资源和归档完整性。
- 远端 ZIP 未进行开发者签名和公证。Apple Silicon 包在本机 ad-hoc 签名后，已通过真实 Mac 手动与 SSH AI 整链路验收，并安装到 `/Users/developer/Applications/Telldo.app`。Intel 包仅通过架构/归档检查，未在 Intel Mac 实机验证。Windows 未打包或运行验证。
- 通知业务调度与补漏去重已自动测试；Linux 虚拟显示环境没有真实桌面通知中心，系统通知权限/点击跳转与系统托盘行为仍需在目标桌面验证。退出后提醒不保证送达。
- 更新依赖后 npm audit 无 high/critical 条目；仍有5个 moderate 构建工具依赖条目（electron-builder 的 minimatch 链），未通过强制降级构建器处理。
- Mac 客户端经 SSH 调用公司电脑的 Codex 已实机验证；数据库留在 Mac，远端不保存任务数据库。SSH 使用已有主机信任与密钥，不转发本地代理或复制 Codex 凭证。

## 实现范围

没有加入月历、习惯、番茄钟、云同步、移动端、多人协作或对外 MCP。业务库只由受控主进程任务服务及其调度组件写入。模型无数据库路径，提案验证和事务落库在本机主进程完成。

正式 Mac 客户端安装配置检查：`aiTransport=ssh`、连接探测可用、任务数0。只保存连接配置，未导入或保留合成测试任务。通过 LaunchServices 正常打开后，原生窗口显示三份空清单与可用 AI 输入栏。
