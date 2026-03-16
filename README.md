# repo-wiki

AI 驱动的代码仓库 Wiki 生成器。扫描本地代码仓库，自动生成结构化的 Wiki 文档，并支持 AI 问答。

## 功能

- **仓库扫描**：递归分析项目结构，提取关键文件内容
- **Wiki 生成**：调用 Claude 自动生成 Wiki 目录与各页面内容（流式输出）
- **AI 问答**：基于仓库内容进行智能问答
- **双认证模式**：支持本地 Claude CLI 或 Anthropic API Key

## 快速开始

```bash
npm install
npm start
```

浏览器访问 http://localhost:3456

自定义端口：

```bash
PORT=8080 npm start
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API Key（API 模式需要） |
| `PORT` | 服务端口，默认 3456 |

## 认证模式

通过请求头选择认证方式：

- **Claude CLI 模式**：`x-auth-mode: claude-cli`，调用本地已安装的 `claude` 命令
- **API Key 模式**：`x-auth-mode: api-key` + `x-api-key: <key>`，调用 Anthropic SDK

## 技术栈

- **后端**：Node.js + Express.js
- **前端**：原生 HTML/JS（单页应用）
- **AI**：Anthropic Claude（Sonnet 4.6 生成 Wiki，Haiku 4.5 问答）
- **通信**：SSE（Server-Sent Events）流式响应
