# Douyin Stock Signal Tracker

本地工具：采集你配置的抖音主页作品评论，识别 A 股提及，按评论者稳定 ID 统计后续 4 个交易日的表现，并监控高胜率评论者的新提及。

这个仓库是通用版本，不包含真实监控账号、评论数据、报告、数据库、cookie、webhook 或登录态。

## Quick Start

```bash
npm install
cp .env.example .env
cp config/accounts.example.json config/accounts.json
```

编辑 `.env`：

```bash
ACCOUNTS_PATH=config/accounts.json
DOUYIN_PROFILE_DIR=.playwright/douyin-profile
TDX_KLINE_DIR=data/tdx/kline
DB_PATH=data/douyin-stock-signals.db
REPORT_DIR=reports
FEISHU_WEBHOOK_URL=
WECHAT_WEBHOOK_URL=
SIGNAL_AGENT_ENDPOINT=
SIGNAL_AGENT_API_KEY=
SIGNAL_AGENT_MODEL=
SIGNAL_AGENT_TIMEOUT_MS=30000
THS_FUYAO_AUTH_TOKEN=
THS_FUYAO_PROJECT_ID=hxkline-F10_StockInfoF10_page
DOUYIN_BROWSER_PROXY_SERVER=
```

编辑 `config/accounts.json`，填入你自己的抖音主页：

```json
[
  {
    "account_id": "account_a",
    "display_name": "Example Creator A",
    "profile_url": "https://www.douyin.com/user/REPLACE_WITH_SEC_USER_ID",
    "sec_user_id": "REPLACE_WITH_SEC_USER_ID",
    "since_date": "2026-01-01",
    "enabled": true
  }
]
```

运行：

```bash
npm run dictionary:build
npm run crawl -- --account account_a --since 2026-01-01 --max-videos 1 --max-comment-pages 2
npm run evaluate
npm run report
```

## Commands

- `npm run crawl -- --account all`：采集所有启用账号。
- `npm run crawl -- --account account_a --since 2026-01-01`：采集指定账号。
- `npm run crawl -- --account account_a --skip-comments`：只分页发现主页作品，不抓评论。
- `npm run crawl -- --account account_a --no-replies`：只抓顶层评论；楼中楼接口不稳定时可先完成顶层评论。
- `npm run dictionary:build`：刷新股票字典；未配置 `THS_FUYAO_AUTH_TOKEN` 时不会调用 Fuyao 快照接口补股票名；调试时可加 `-- --skip-names` 只扫本地 TDX 代码。
- `npm run classify:comments -- --mode rules`：用本地规则给含股票评论打语义标签。
- `npm run classify:comments -- --mode hybrid --only ambiguous --limit 200`：对规则不确定样本调用语义 agent。
- `npm run resolve:abbreviations`：用股票字典候选召回和可选语义 agent 处理简称/拼音缩写。
- `npm run evaluate`：抽取股票提及并计算 4 日结果。
- `npm run report`：生成 `reports/latest.html` / `.csv` / `.md` 和跨账号汇总 CSV。
- `npm run monitor`：增量采集、评估、报告、通知。
- `npm run monitor:install`：安装 macOS launchd 低频后台任务；脚本会按 `config/accounts.json` 的启用账号分配时段。
- `MONITOR_ACCOUNT=account_a npm run monitor:probe`：只抓取不告警，用于验证单次运行是否还会限流。
- `npm run alerts:dry-run`：只打印通知，不发送 webhook。

## Alert Rule

- 单账号或跨账号汇总满足完成回测次数 `>= 4` 且胜率 `>= 75%`，进入高胜率提醒候选。
- 完成回测次数 `>= 6` 且胜率 `< 50%` 的评论者会被标记为 `ignored`。
- 飞书通知使用 `FEISHU_WEBHOOK_URL`；未配置 webhook 时只写本地 `alerts` 和报告。

## Evaluation Rule

一条评论出现股票名、别名或 6 位 A 股代码时，会生成股票提及。评论后的第一个交易日开盘价为基准价，之后 4 个交易日内最高收盘涨幅 `> 0` 算命中。未满 4 个交易日的信号标记为 `pending`，不进入胜率分母。

## Semantic Filter

- 咨询句不入账，例如“这只怎么看？”。
- 事后复盘句不入账，例如“我之前推荐过你没买吗？”。
- 原始评论仍保留在 `comments` 表；过滤只影响 `stock_mentions`、胜率和提醒。
- 可选语义 agent 只写入 `comment_signal_labels`，不会直接改原始评论。

## Background Monitor

`scripts/install-launchd.sh` 会读取 `config/accounts.json` 中启用的账号，最多安装三段 macOS LaunchAgent：中午、傍晚、凌晨。脚本带本地锁、总超时、旧锁回收、子进程清理和失败状态写入。

监控入口会区分两类暂停：

- 明确出现验证码、安全验证、滑块等文案：写入 `monitor_paused_for_douyin_verification`。
- 目标视频存在但评论读数为 0：写入 `monitor_paused_for_douyin_rate_limit`，按短期请求过多或评论接口临时限流处理。

限流后会更新 `data/monitor-adaptive.json`，把下一次运行降到更保守的档位。`monitor:probe` 只抓取评论并写状态，不跑评估、报告或股票提醒。

## Privacy Boundary

- 不绕过抖音登录、验证码或平台限制。
- 不提交真实账号配置、cookie、webhook、数据库、报告、日志或登录态。
- `config/accounts.json`、`.env`、`data/`、`reports/`、`.playwright/` 默认被 `.gitignore` 排除。
- 公开仓库只保留 `config/accounts.example.json` 和 `.env.example` 作为模板。
- 配置 `SIGNAL_AGENT_*` 后，语义/缩写 agent 会把评论原文、视频描述、日期和候选股票发送到该 endpoint；不配置则不会发送。
- 配置飞书或企业微信 webhook 后，高胜率提醒会把账号名、用户昵称、视频描述和评论原文发送到对应机器人；不配置则只落本地数据库和报告。
