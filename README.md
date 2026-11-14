# Telldo

**你说一句话，事情办到清单上。 / Say it. Get it on your list.**

Telldo 是 MIT 许可、免费、开源的个人待办桌面应用。Electron + React + TypeScript + SQLite，本地优先、单用户，中英双语默认跟随系统。首次使用有「工作」「生活」「随时再说」三个空清单，可改名或删除。

## 当前功能（0.2.0）

- 清单与任务 CRUD、一层子任务、标签、优先级、标题/备注/标签搜索。
- 今天（过期未完成、今天截止、今天安排）、计划（选定月份的列表/月历）、随时（无日期且未安排）。可显示已完成任务。
- 计划列表/月历共享月份和清单筛选；安排日优先显示主卡片，另在截止日显示同一任务的截止标记。日期格新增和拖入待安排任务仅设置安排日；重复改期只作用于本次。日期改动有版本检查、提醒预览及撤销，详见 [日历规则](docs/design/calendar-design.md)。
- 中文自然语言日期：`明天下午 3 点`、`下周五`、`本月底`；新建时输入 `明天下午交周报` 会提取标题和明天15:00。模糊时段约定上午09:00、下午15:00、晚上20:00。日期解析使用设置时区或操作系统时区。
- 日期任务仅保存本地日历日；带时间任务保存 UTC 瞬时和 IANA 时区。计划页的日期格和时刻使用当前设置时区；任务详情保留原任务时区。智能视图以当前设置时区划分今天。
- 每天、每周多个星期几、工作日、每月几号、每月第几个星期几重复，支持次数或截止日。每月31日落到短月最后一天。实例保留原计划标识，可独立完成、跳过和改期。规则变更需先取消原重复再创建；不会隐式重写既有实例。详见 [日期与提醒规则](docs/scheduling.md)。
- 每任务/实例一个提醒；运行、最小化、托盘后台时触发系统通知。关闭窗口默认留在托盘，选择「退出」后不保证提醒；下次启动仅汇总未处理的过期提醒一次。系统通知权限、休眠和操作系统策略仍影响显示。
- 一致性 SQLite 备份与 JSON 导入导出；AI 提案、确认、事务应用、乐观锁、审计和撤销。

不包含周时间轴、时段/时长、日历订阅、习惯打卡、番茄钟、云同步、移动端、协作或对外 MCP 服务。

## AI、隐私与费用

Telldo 不收取软件费用，也没有自己的 AI 订阅层。AI 支持本机 Codex，或经 SSH 调用公司电脑上已登录的 Codex CLI；Codex 订阅、额度和 API 费用由用户承担。

**云端推理会把用户输入、选定任务标题、日期以及少量必要上下文发送给模型提供方，AI 并非全本地。** 应用最多提供30个任务摘要和30个清单，不发送全库、数据库路径或凭证。复用 CLI 登录态，不读取、复制或导出 token、密钥、凭证文件。

没有 Codex、未登录、网络失败或额度不足时，AI 入口不可用，全部手动功能仍可使用。本机模式在本机、SSH 模式在远端终端安装并运行 `codex login`；设置里可手动填写可执行文件的绝对路径，然后点击「检测 Codex」。优先查 PATH。GUI 启动时 PATH 可能与终端不同。

AI 不是聊天记录本：一句话 → 可校验提案 → 确认或直写 → Task Service 事务落库。低风险仅限单条顶层创建，默认可直写并撤销；其余更改先显示摘要与实际动作确认。设置可改为一律确认。版本冲突整批回滚；同一个成功应用的幂等键不能重复执行。撤销若遇到后续修改会拒绝覆盖。

Codex 使用 argv 数组和 stdin，在临时空工作目录运行，不使用 shell 命令拼接。JSONL 只作进度与工具检测；最终业务 JSON 从输出文件或严格降级的最终 agent message 解析。只读沙箱**不等于强制无 shell/MCP/网络**；不宣称无工具隔离。检测到任何工具调用时整次失败，不采用其结果、不写业务库。已验证的参数与未验证能力见 [Codex 能力说明](docs/codex-capabilities.md)。

## 数据与备份

唯一业务真相源是应用用户数据目录里的 `telldo.sqlite`：

- macOS：`~/Library/Application Support/Telldo/`
- Linux：通常 `~/.config/Telldo/`
- Windows：通常 `%APPDATA%/Telldo/`

设置中「打开数据目录」可查看实际位置。**禁止把正在使用的数据库放进 iCloud Drive、Syncthing 或其他文件同步文件夹**；多端同时打开活库可能损坏数据。第一版不提供同步。可在设置中使用在线一致性备份，或 JSON 导出后同步导出文件。

JSON 导入默认生成所有清单、任务、标签、系列的新 ID，保留内部父子和重复关系，避免覆盖现有数据。导入全事务执行，错误时全部回滚。备份/导入导出不会把 Codex 登录态包含进去。审计、通知去重与导入细节见 [数据模型](docs/data-model.md)。

## 开发与测试

需要 Node.js22.12+、npm，以及桌面图形环境。依赖固定在 package-lock.json。

```bash
npm ci
npm run dev
npm test
npm run build
npm run test:smoke
npm run test:calendar
```

SQLite 使用 Electron 自带的 `node:sqlite` 同步接口（Electron45.3.2 内含 SQLite3.53.4），不依赖第三方原生绑定或本机编译器。测试使用 `ELECTRON_RUN_AS_NODE=1`，确保与桌面应用运行于同一 Node/SQLite 版本。

`npm test` 覆盖手动 CRUD、三视图、时区、日期/时刻、月末/DST、实例幂等、提醒补漏、备份导入、提案版本/范围/事务/幂等/撤销及适配器取消/超时/登录/工具调用等。`npm run test:smoke` 使用 Playwright 启动真实 Electron，在临时数据库中执行无 Codex 的完整手动流程并生成 `artifacts/` 截图。`npm run test:calendar` 验证真实客户端的月历、改期、提醒选择和撤销。两套验收均不会使用用户活库。

可选真实 Codex 合成数据测试（会使用自己的额度；不写业务库）：

```bash
TELLDO_CODEX_PATH=/absolute/path/to/codex node scripts/codex-live-check.mjs
```

## Linux 开发与远端 Codex

公开仓库：https://github.com/vitslam/telldo 。以下地址和路径均为示例，请替换为自己的环境。可用现有 Node.js22.12+；开发环境也可使用项目内 `.tools/` 的独立 Node，以免修改系统环境。

```bash
ssh -p 2222 developer@198.51.100.10
cd /opt/telldo
source scripts/env.sh
# 仅需要公司代理时设置；不把代理作为全局系统配置
export https_proxy=http://192.0.2.10:3128
export http_proxy=http://192.0.2.10:3128
npm run dev
```

远端是 Linux。Electron 是桌面应用，需要真实桌面会话；不是部署后可通过网页访问的服务。无桌面环境时使用项目内 Xvfb 执行验收，详见 [验收记录](docs/acceptance.md)。没有添加 Web 服务或云同步。Mac 客户端的 SQLite 数据留在 Mac，SSH 仅传输最小 AI 请求和提案；连接设置及远端助手安装见 [SSH Codex](docs/ssh-codex.md)。

## 打包

```bash
npm run package:mac   # 在 macOS 上构建 .app
npm run dist:mac      # 在 macOS 上构建 zip
npm run package:linux
```

构建结果放在 `release/`。远端 ZIP 未做开发者签名和公证；正式分发需开发者签名和公证。0.2.0 Apple Silicon 安装副本已做本机 ad-hoc 签名，本次 Mac 实机验证交由使用者完成；远端自动与界面测试结果见 [日历验收](docs/calendar-acceptance.md)。Linux 上可用 `npm run package:mac:linux` 交叉组装两种架构的 macOS 应用；下载的 Electron 运行时按官方 SHA256 校验，SQLite 随目标运行时提供。构建脚本见 [跨平台打包](docs/macos-packaging.md)。跨平台架构已分层，但 Windows 未进行运行验收；不承诺跨系统后台唤醒。当前已实际验证的环境和产物见 [验收记录](docs/acceptance.md)。

## 代码结构

`src/main/` 持有 Task Service、SQLite、受控调度器、通知与 Codex 适配器；`src/preload/` 仅暴露白名单 IPC 桥；`src/renderer/` 为无 Node 权限的 React 界面；`src/shared/` 提供类型、日期规则与提案验证；`resources/` 提供提示词和结构化输出 JSON Schema。

MIT License，见 [LICENSE](LICENSE)。
