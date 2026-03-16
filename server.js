import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth helpers ──────────────────────────────────────────────────────────────

function isCliMode(req) {
  return req.headers['x-auth-mode'] === 'claude-cli';
}

function getClient(req) {
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('未设置 API Key');
  return new Anthropic({ apiKey });
}

// Run claude CLI, return full text output (blocking)
function claudeText(systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', 'text', '--tools', ''];
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    args.push('-p', userMessage);

    const env = { ...process.env, CLAUDECODE: '' };
    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      if (code !== 0) reject(new Error(err.trim() || `claude exited ${code}`));
      else resolve(out.trim());
    });
  });
}

// Run claude CLI, stream text as SSE (via stream-json + partial messages)
function claudeStream(systemPrompt, userMessage, res) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  args.push('-p', userMessage);

  const env = { ...process.env, CLAUDECODE: '' };
  const child = spawn('claude', args, { env });

  let buf = '';
  let lastLen = 0;   // track accumulated text length to compute delta

  child.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'assistant') {
          const text = ev.message?.content?.[0]?.text || '';
          const delta = text.slice(lastLen);
          if (delta) {
            res.write(`data: ${JSON.stringify({ text: delta })}\n\n`);
            lastLen = text.length;
          }
        }
        if (ev.type === 'result' && ev.subtype === 'error') {
          res.write(`data: ${JSON.stringify({ error: ev.error || 'CLI error' })}\n\n`);
        }
      } catch {}
    }
  });

  child.stderr.on('data', d => console.error('[claude]', d.toString().trim()));
  child.on('close', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

// ── Repo scanning ─────────────────────────────────────────────────────────────

const repoCache = new Map();
const pageCache = new Map();

const IGNORE = new Set([
  '.git', 'node_modules', 'dist', '.next', '__pycache__',
  '.venv', 'venv', 'target', '.build', 'build', 'vendor',
  '.artifacts', 'coverage', '.cache', 'out',
]);

async function readTree(dir, root, depth = 0) {
  if (depth > 3) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (IGNORE.has(e.name)) continue;
    const rel = path.relative(root, path.join(dir, e.name));
    if (e.isDirectory()) {
      items.push({ type: 'dir', path: rel, name: e.name, depth });
      items.push(...await readTree(path.join(dir, e.name), root, depth + 1));
    } else {
      items.push({ type: 'file', path: rel, name: e.name, depth });
    }
  }
  return items;
}

const KEY_FILES = [
  'README.md', 'readme.md', 'README',
  'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'CLAUDE.md', 'AGENTS.md',
  'src/index.ts', 'src/main.ts', 'src/index.js', 'src/main.js',
  'src/index.py', 'main.py', 'app.py', 'main.go', 'src/main.rs',
];

async function scanRepo(repoPath) {
  const tree = await readTree(repoPath, repoPath);
  const keyFiles = {};
  for (const f of KEY_FILES) {
    try {
      const content = await fs.readFile(path.join(repoPath, f), 'utf-8');
      keyFiles[f] = content.slice(0, 4000);
    } catch {}
  }
  return { tree, keyFiles };
}

function buildContext(repoPath, scan) {
  let ctx = `仓库路径: ${repoPath}\n\n## 文件树\n\`\`\`\n`;
  ctx += scan.tree.slice(0, 250)
    .map(e => '  '.repeat(e.depth) + (e.type === 'dir' ? '[dir] ' : '      ') + e.name)
    .join('\n');
  ctx += '\n```\n\n';
  for (const [f, content] of Object.entries(scan.keyFiles)) {
    ctx += `## 文件: ${f}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  return ctx;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/browse — directory browser
app.get('/api/browse', async (req, res) => {
  const dir = req.query.path || process.env.HOME || '/';
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const dirs = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(dir) !== dir ? path.dirname(dir) : null;
    res.json({ current: dir, parent, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/scan — scan repo and return wiki structure
app.post('/api/scan', async (req, res) => {
  const { repoPath } = req.body;
  if (!repoPath) return res.status(400).json({ error: '请提供仓库路径' });
  try { await fs.access(repoPath); } catch {
    return res.status(400).json({ error: `路径不存在: ${repoPath}` });
  }

  try {
    const scan = await scanRepo(repoPath);
    repoCache.set(repoPath, scan);
    for (const k of pageCache.keys()) {
      if (k.startsWith(repoPath + '::')) pageCache.delete(k);
    }

    const context = buildContext(repoPath, scan);
    const prompt = `分析以下代码仓库，生成Wiki目录结构。只返回JSON，不要任何其他内容。

${context}

返回格式（严格JSON）：
{
  "projectName": "项目名称",
  "description": "一句话说明项目是什么",
  "pages": [
    { "id": "overview", "title": "项目概览", "children": [] },
    { "id": "tech-stack", "title": "技术栈", "children": [] },
    { "id": "architecture", "title": "架构设计", "children": [
      { "id": "module-core", "title": "核心模块", "children": [] }
    ]},
    { "id": "dataflow", "title": "数据流", "children": [] },
    { "id": "dev-guide", "title": "开发指南", "children": [] }
  ]
}`;

    let jsonText;
    if (isCliMode(req)) {
      jsonText = await claudeText(null, prompt);
    } else {
      const resp = await getClient(req).messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      });
      jsonText = resp.content[0].text.trim();
    }

    let structure;
    try {
      const m = jsonText.match(/\{[\s\S]*\}/);
      structure = JSON.parse(m ? m[0] : jsonText);
    } catch {
      structure = {
        projectName: path.basename(repoPath),
        description: '',
        pages: [
          { id: 'overview', title: '项目概览', children: [] },
          { id: 'architecture', title: '架构设计', children: [] },
          { id: 'dev-guide', title: '开发指南', children: [] },
        ],
      };
    }
    res.json({ success: true, structure });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wiki-page — generate wiki page (SSE)
app.post('/api/wiki-page', async (req, res) => {
  const { repoPath, pageId, pageTitle } = req.body;
  if (!repoCache.has(repoPath)) return res.status(400).json({ error: '请先扫描仓库' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cacheKey = `${repoPath}::${pageId}`;
  if (pageCache.has(cacheKey)) {
    res.write(`data: ${JSON.stringify({ text: pageCache.get(cacheKey), cached: true })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  const scan = repoCache.get(repoPath);
  const context = buildContext(repoPath, scan);
  const userPrompt = `基于以下代码仓库，用中文撰写Wiki页面「${pageTitle}」。

${context}

请严格按如下格式输出，不要省略标签：

<thinking>
[写出你阅读代码后的分析过程：理解项目结构、识别关键模式、梳理核心概念、确定页面重点]
</thinking>

<content>
[Wiki页面内容，Markdown格式，标题从##开始，可含ASCII图表、表格、列表，面向开发者，准确具体]
</content>`;

  // 解析 <thinking> 和 <content> 并分块发送（thinking 按行延迟，产生滚动效果）
  const delay = ms => new Promise(r => setTimeout(r, ms));

  async function sendParsed(raw) {
    const thinkMatch = raw.match(/<thinking>([\s\S]*?)<\/thinking>/);
    const contentMatch = raw.match(/<content>([\s\S]*?)<\/content>/);
    const thinking = thinkMatch?.[1]?.trim() ?? '';
    const content = contentMatch?.[1]?.trim() ?? raw.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();

    if (thinking) {
      for (const line of thinking.split('\n')) {
        if (!line.trim()) continue;
        res.write(`data: ${JSON.stringify({ thinking: true, text: line + '\n' })}\n\n`);
        await delay(40);
      }
    }
    const cs = 200;
    for (let i = 0; i < content.length; i += cs)
      res.write(`data: ${JSON.stringify({ thinking: false, text: content.slice(i, i + cs) })}\n\n`);
    return content;
  }

  if (isCliMode(req)) {
    try {
      const raw = await claudeText(null, userPrompt);
      const content = await sendParsed(raw);
      pageCache.set(cacheKey, content);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  } else {
    try {
      // API 模式：先拿完整响应再解析（thinking 结构需完整才能解析标签）
      const resp = await getClient(req).messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const raw = resp.content.map(b => b.text ?? '').join('');
      const content = await sendParsed(raw);
      pageCache.set(cacheKey, content);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// POST /api/save-page — save cached page to file
app.post('/api/save-page', async (req, res) => {
  const { repoPath, pageId, pageTitle } = req.body;
  const cacheKey = `${repoPath}::${pageId}`;
  if (!pageCache.has(cacheKey)) {
    return res.status(400).json({ error: '页面尚未生成，请先加载该页面' });
  }
  const content = pageCache.get(cacheKey);
  const wikiDir = path.join(repoPath, 'wiki');
  await fs.mkdir(wikiDir, { recursive: true });
  const safeName = pageTitle.replace(/[\/\\:*?"<>|]/g, '-');
  const filePath = path.join(wikiDir, `${safeName}.md`);
  await fs.writeFile(filePath, content, 'utf-8');
  res.json({ success: true, filePath: path.relative(repoPath, filePath) });
});

// POST /api/chat — AI Q&A (SSE)
app.post('/api/chat', async (req, res) => {
  const { repoPath, messages, currentPage } = req.body;
  if (!repoCache.has(repoPath)) return res.status(400).json({ error: '请先扫描仓库' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const scan = repoCache.get(repoPath);
  const context = buildContext(repoPath, scan);
  const sysPrompt = `你是代码库专家助手，专门回答关于以下仓库的问题。用中文回答，简洁准确，可用Markdown格式。${currentPage ? `\n用户当前正在查看：${currentPage}` : ''}\n\n${context}`;

  if (isCliMode(req)) {
    // Build conversation history as text for CLI single-turn mode
    let userMsg = '';
    if (messages.length > 1) {
      userMsg += '[对话历史]\n';
      for (const m of messages.slice(0, -1)) {
        userMsg += `${m.role === 'user' ? '用户' : '助手'}: ${m.content}\n`;
      }
      userMsg += '\n[当前问题]\n';
    }
    userMsg += messages.at(-1).content;
    try {
      const answer = await claudeText(sysPrompt, userMsg);
      const chunkSize = 100;
      for (let i = 0; i < answer.length; i += chunkSize) {
        res.write(`data: ${JSON.stringify({ text: answer.slice(i, i + chunkSize) })}\n\n`);
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  } else {
    try {
      const stream = getClient(req).messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: sysPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Repo Wiki: http://localhost:${PORT}`));
