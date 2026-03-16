# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 启动与运行

```bash
npm install       # 安装依赖
npm start         # 启动服务器，监听 http://localhost:3456
PORT=8080 npm start  # 自定义端口
```

无测试框架，无 lint 配置。

## 环境变量

- `ANTHROPIC_API_KEY`：Anthropic API Key（API 模式需要）
- `PORT`：服务端口，默认 3456

## 架构概览

单文件后端 + 单页前端的轻量应用（共约 900 行代码）。

**后端 `server.js`（Express.js）：**
- `GET /api/browse`：目录浏览器
- `POST /api/scan`：扫描仓库，调用 Claude 生成 Wiki 目录结构（JSON）
- `POST /api/wiki-page`：生成 Wiki 页面，SSE 流式返回
- `POST /api/save-page`：保存 Wiki 页面为 `wiki/*.md`
- `POST /api/chat`：AI 问答，SSE 流式返回

**前端 `public/app.js`（原生 JS）：**
- `streamPost()`：SSE 流式通信核心函数
- `scanRepo()`：触发仓库扫描
- `loadWikiPage()`：加载并实时渲染 Wiki 页面
- `sendChat()`：发送 AI 问答

## 双认证模式

通过请求头传递认证信息：
- `x-auth-mode: claude-cli`：调用本地 `claude` CLI（`spawn('claude', ...)`）
- `x-auth-mode: api-key` + `x-api-key: <key>`：调用 Anthropic SDK

两种模式共用相同的 API 路由，认证逻辑在各路由内分支处理。

## Claude 模型使用

- Wiki 页面生成：`claude-sonnet-4-6`（高质量分析）
- AI 问答：`claude-haiku-4-5-20251001`（快速响应）

## 关键设计

- **仓库扫描**：递归最大深度 3 层，忽略 `.git`、`node_modules`、`dist` 等目录，提取关键文件前 4000 字符
- **缓存**：`repoCache` 缓存扫描结果，`pageCache` 缓存已生成页面
- **SSE 流式**：Wiki 内容分两部分返回——`<thinking>`（分析过程）和 `<content>`（正文）
