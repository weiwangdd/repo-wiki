// ── marked.js config ──
marked.setOptions({
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

// ── State ──
const state = {
  repoPath: '',
  currentPageId: null,
  currentPageTitle: '',
  chatHistory: [],
  wikiStructure: null,
};

// ── DOM refs ──
const $ = (id) => document.getElementById(id);
const apiKeyInput  = $('api-key');
const repoInput    = $('repo-path');
let authMode = localStorage.getItem('repo-wiki-authmode') || 'claude-cli';

// Auth mode toggle
document.querySelectorAll('.auth-opt').forEach(btn => {
  if (btn.dataset.mode === authMode) btn.classList.add('active');
  else btn.classList.remove('active');
  btn.addEventListener('click', () => {
    authMode = btn.dataset.mode;
    localStorage.setItem('repo-wiki-authmode', authMode);
    document.querySelectorAll('.auth-opt').forEach(b => b.classList.toggle('active', b === btn));
    apiKeyInput.style.display = authMode === 'api-key' ? '' : 'none';
  });
});
apiKeyInput.style.display = authMode === 'api-key' ? '' : 'none';
const scanBtn     = $('scan-btn');
const spinner     = $('spinner');
const saveBtn       = $('save-btn');
const saveTip       = $('save-tip');
const thinkingPanel = $('thinking-panel');
const thinkingArrow = $('thinking-arrow');
const thinkingBody  = $('thinking-body');
const chatToggle    = $('chat-toggle');
const layout      = $('layout');
const navHeader   = $('nav-header');
const navTree     = $('nav-tree');
const projectName = $('project-name');
const projectDesc = $('project-desc');
const welcome     = $('welcome');
const pageContent = $('page-content');
const pageTitle   = $('page-title');
const pageBody    = $('page-body');
const chatPanel   = $('chat-panel');
const chatMsgs    = $('chat-messages');
const chatInput   = $('chat-input');
const chatSend    = $('chat-send');
const clearChat   = $('clear-chat');

// ── SSE streaming via fetch ──
function apiHeaders() {
  const h = { 'Content-Type': 'application/json', 'x-auth-mode': authMode };
  if (authMode === 'api-key') {
    const key = apiKeyInput.value.trim();
    if (key) h['x-api-key'] = key;
  }
  return h;
}

async function streamPost(url, body, onChunk) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || resp.statusText);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) throw new Error(parsed.error);
        if (parsed.text !== undefined) onChunk(parsed);
      } catch (e) {
        if (e.message !== 'Unexpected end of JSON input') throw e;
      }
    }
  }
}

// ── Scan repo ──
scanBtn.addEventListener('click', scanRepo);
repoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') scanRepo(); });

async function scanRepo() {
  const rp = repoInput.value.trim();
  if (!rp) return;
  state.repoPath = rp;

  scanBtn.disabled = true;
  spinner.style.display = 'block';
  navTree.innerHTML = '<div class="nav-empty">正在分析...</div>';

  try {
    const resp = await fetch('/api/scan', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ repoPath: rp }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    state.wikiStructure = data.structure;
    state.chatHistory = [];
    state.currentPageId = null;

    projectName.textContent = data.structure.projectName;
    projectDesc.textContent = data.structure.description;
    navHeader.style.display = '';

    renderNavTree(data.structure.pages);
    showWelcome();
  } catch (err) {
    navTree.innerHTML = `<div class="nav-empty" style="color:#cf222e">${err.message}</div>`;
  } finally {
    scanBtn.disabled = false;
    spinner.style.display = 'none';
  }
}

// ── Render nav tree ──
function renderNavTree(pages) {
  navTree.innerHTML = '';
  for (const page of pages) {
    navTree.appendChild(buildNavItem(page, 0));
  }
}

function buildNavItem(page, depth) {
  const wrapper = document.createElement('div');
  const hasChildren = page.children && page.children.length > 0;

  const item = document.createElement('div');
  item.className = 'nav-item';
  item.dataset.id = page.id;
  item.dataset.title = page.title;

  const toggle = document.createElement('span');
  toggle.className = 'toggle';
  toggle.textContent = hasChildren ? '▶' : '';

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = hasChildren ? '📂' : '📄';

  const label = document.createElement('span');
  label.textContent = page.title;

  item.appendChild(toggle);
  item.appendChild(icon);
  item.appendChild(label);
  wrapper.appendChild(item);

  let childrenEl = null;
  if (hasChildren) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'nav-children';
    for (const child of page.children) {
      childrenEl.appendChild(buildNavItem(child, depth + 1));
    }
    wrapper.appendChild(childrenEl);

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = childrenEl.classList.toggle('open');
      toggle.textContent = open ? '▼' : '▶';
      icon.textContent = open ? '📂' : '📂';
    });
  }

  item.addEventListener('click', () => {
    // Deactivate previous
    document.querySelectorAll('.nav-item.active').forEach(el => el.classList.remove('active'));
    item.classList.add('active');

    // Expand children if any
    if (hasChildren && childrenEl) {
      childrenEl.classList.add('open');
      toggle.textContent = '▼';
    }

    loadWikiPage(page.id, page.title);
  });

  return wrapper;
}

// ── Load wiki page ──
async function loadWikiPage(id, title) {
  state.currentPageId = id;
  state.currentPageTitle = title;

  welcome.style.display = 'none';
  pageContent.style.display = 'block';
  pageTitle.textContent = title;
  pageBody.innerHTML = '<div class="thinking-ticker"><div class="thinking-ticker-header"><div class="thinking-spinner"></div>思考中...</div><div id="thinking-lines-container"><div id="thinking-lines-inner"></div></div></div>';

  // Hide save button while generating
  saveBtn.style.display = 'none';
  saveTip.style.display = 'none';

  // Reset thinking panel
  thinkingPanel.style.display = 'none';
  thinkingArrow.classList.remove('open');
  thinkingBody.classList.remove('open');
  thinkingBody.textContent = '';

  let accumulated = '';
  let thinkAccumulated = '';
  let renderTimer = null;

  const renderNow = () => {
    pageBody.innerHTML = marked.parse(accumulated);
    pageBody.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
  };

  try {
    await streamPost(
      '/api/wiki-page',
      { repoPath: state.repoPath, pageId: id, pageTitle: title },
      ({ text, thinking, cached }) => {
        if (cached) {
          accumulated = text;
          renderNow();
          return;
        }
        if (thinking) {
          thinkAccumulated += text;
          const inner = document.getElementById('thinking-lines-inner');
          if (inner) {
            inner.textContent = thinkAccumulated;
            const container = document.getElementById('thinking-lines-container');
            container.scrollTop = container.scrollHeight;
          }
          return;
        }
        if (!accumulated) pageBody.innerHTML = '';
        accumulated += text;
        if (!renderTimer) {
          renderTimer = setTimeout(() => {
            renderNow();
            renderTimer = null;
          }, 150);
        }
      },
    );
    // Final render
    clearTimeout(renderTimer);
    if (accumulated) renderNow();
    // 保持展开，用户可手动点击折叠
    // 生成完成后显示保存按钮
    if (accumulated) saveBtn.style.display = '';
  } catch (err) {
    pageBody.innerHTML = `<div style="color:#cf222e;font-size:13px">错误：${err.message}</div>`;
  }
}

// ── Chat ──
chatToggle.addEventListener('click', () => {
  layout.classList.toggle('chat-open');
  chatToggle.textContent = layout.classList.contains('chat-open') ? '关闭问答' : 'AI 问答';
});

clearChat.addEventListener('click', () => {
  state.chatHistory = [];
  chatMsgs.innerHTML = '<div class="chat-empty">问任何关于当前代码库的问题</div>';
});

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !state.repoPath) return;

  if (!state.wikiStructure) {
    alert('请先分析一个代码仓库');
    return;
  }

  // Remove empty state
  const emptyEl = chatMsgs.querySelector('.chat-empty');
  if (emptyEl) emptyEl.remove();

  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatSend.disabled = true;

  // Add user message
  state.chatHistory.push({ role: 'user', content: text });
  appendChatMsg('user', text);

  // Add AI placeholder
  const aiEl = appendChatMsg('assistant', '');
  let aiText = '';

  try {
    await streamPost(
      '/api/chat',
      {
        repoPath: state.repoPath,
        messages: state.chatHistory,
        currentPage: state.currentPageTitle || null,
      },
      ({ text: chunk }) => {
        aiText += chunk;
        aiEl.innerHTML = marked.parse(aiText);
        aiEl.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
      },
    );
    state.chatHistory.push({ role: 'assistant', content: aiText });
  } catch (err) {
    aiEl.innerHTML = `<span style="color:#cf222e">错误：${err.message}</span>`;
  } finally {
    chatSend.disabled = false;
  }
}

function appendChatMsg(role, text) {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}`;
  if (text) el.innerHTML = role === 'user' ? escapeHtml(text) : marked.parse(text);
  chatMsgs.appendChild(el);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return el;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showWelcome() {
  welcome.style.display = 'flex';
  pageContent.style.display = 'none';
}

// ── Directory browser ──
const fsOverlay  = $('fs-overlay');
const fsCurrent  = $('fs-current');
const fsList     = $('fs-list');
const fsUpBtn    = $('fs-up');
const fsSelect   = $('fs-select');
const browseBtn  = $('browse-btn');
let fsParent     = null;

async function fsBrowse(dir) {
  fsList.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">加载中...</div>';
  try {
    const resp = await fetch(`/api/browse?path=${encodeURIComponent(dir)}`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    fsParent = data.parent;
    fsCurrent.textContent = data.current;
    fsUpBtn.disabled = !data.parent;

    fsList.innerHTML = '';
    if (data.dirs.length === 0) {
      fsList.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">（无子目录）</div>';
      return;
    }
    for (const name of data.dirs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 16px;cursor:pointer;font-size:13px;';
      row.innerHTML = `<span style="font-size:15px">📁</span><span>${name}</span>`;
      row.addEventListener('mouseover', () => row.style.background = '#f6f8fa');
      row.addEventListener('mouseout',  () => row.style.background = '');
      row.addEventListener('click', () => fsBrowse(data.current + '/' + name));
      fsList.appendChild(row);
    }
  } catch (err) {
    fsList.innerHTML = `<div style="padding:16px;color:#cf222e;font-size:13px">${err.message}</div>`;
  }
}

browseBtn.addEventListener('click', () => {
  const start = repoInput.value.trim() || (localStorage.getItem('repo-wiki-path') || '~').replace(/\/[^/]+$/, '') || '/';
  fsOverlay.style.display = 'flex';
  fsBrowse(start);
});

fsUpBtn.addEventListener('click', () => { if (fsParent) fsBrowse(fsParent); });

fsSelect.addEventListener('click', () => {
  repoInput.value = fsCurrent.textContent;
  localStorage.setItem('repo-wiki-path', repoInput.value);
  fsOverlay.style.display = 'none';
});

$('fs-close').addEventListener('click',  () => { fsOverlay.style.display = 'none'; });
$('fs-cancel').addEventListener('click', () => { fsOverlay.style.display = 'none'; });
fsOverlay.addEventListener('click', (e) => { if (e.target === fsOverlay) fsOverlay.style.display = 'none'; });

// ── Save page ──
saveBtn.addEventListener('click', async () => {
  if (!state.currentPageId) return;
  saveBtn.disabled = true;
  saveBtn.textContent = '保存中...';
  saveTip.style.display = 'none';
  try {
    const resp = await fetch('/api/save-page', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        repoPath: state.repoPath,
        pageId: state.currentPageId,
        pageTitle: state.currentPageTitle,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    saveTip.textContent = `已保存: wiki/${data.filePath.split('/').pop()}`;
    saveTip.style.display = '';
    saveTip.style.color = 'var(--accent)';
  } catch (err) {
    saveTip.textContent = `保存失败: ${err.message}`;
    saveTip.style.display = '';
    saveTip.style.color = '#cf222e';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '保存';
  }
});

// ── Init: restore from localStorage ──
const savedPath = localStorage.getItem('repo-wiki-path');
if (savedPath) repoInput.value = savedPath;
repoInput.addEventListener('change', () => localStorage.setItem('repo-wiki-path', repoInput.value));

const savedKey = localStorage.getItem('repo-wiki-apikey');
if (savedKey) apiKeyInput.value = savedKey;
apiKeyInput.addEventListener('change', () => localStorage.setItem('repo-wiki-apikey', apiKeyInput.value));
