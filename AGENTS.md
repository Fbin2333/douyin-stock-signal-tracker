# Douyin Stock Signal Tracker Agent Guide

## 项目定位

本项目是通用的抖音评论区 A 股提及追踪器。它采集用户自定义的抖音主页作品评论，识别股票提及，按评论者稳定 ID 做后续表现统计和高胜率提醒。

## 开工顺序

进入本仓库后先读：

1. `README.md`
2. `CLAUDE.md`
3. `.ai/project-memory.md`、`.ai/current-focus.md`、`.ai/change-log.md`（如果本地存在）

## 数据边界

- 抖音：复用用户自己的 Playwright 登录态，不绕过登录、验证码或平台限制。
- 账号：真实监控账号写在本地 `config/accounts.json`，不提交；公开仓库只保留 `config/accounts.example.json`。
- 行情：历史回测读取用户提供的 TDX 日线目录。
- 绝不提交 `.env`、cookie、webhook、数据库、报告、日志、登录态或真实评论数据。

## 验证

- 基础检查：`npm test`
- 代码检查：`npm run lint`
- 小范围 smoke：限制 `--max-videos 1 --max-comment-scrolls 3` 后跑 `crawl -> evaluate -> report`

## 更新规则

- 每次完成有实际产出的任务后追加本地 `.ai/change-log.md`。
- 改命令、表结构、数据契约、评估口径时更新本地 `.ai/project-memory.md`。
- 当前重点或下一步变了，更新本地 `.ai/current-focus.md`。
