# Douyin Stock Signal Tracker Collaboration Guide

本仓库用于采集用户自定义抖音主页评论中的 A 股提及，并统计评论者的历史胜率。

## 工作方式

- 示例账号配置在 `config/accounts.example.json`。
- 真实账号配置放在本地 `config/accounts.json`，默认不提交。
- 数据库默认在 `data/douyin-stock-signals.db`。
- 报告默认在 `reports/latest.*`。
- 抖音采集必须通过正常登录态和页面加载，不实现验证码、风控或签名绕过。

## 核心口径

- 评论只要出现股票名、别名或 6 位 A 股代码，就计为股票提及。
- 一条评论提到多只股票就生成多条提及。
- 评论后的第一个交易日开盘价为基准，之后 4 个交易日内最高收盘涨幅大于 0 算命中。
- 高胜率监控默认口径：完成回测次数 `>= 4` 且胜率 `>= 75%`。

## 常用命令

```bash
npm run dictionary:build
npm run crawl -- --account all
npm run evaluate
npm run report
npm run monitor
npm run alerts:dry-run
```
