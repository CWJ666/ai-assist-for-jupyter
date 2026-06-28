import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';

// ── Constants ────────────────────────────────────────────────────────────────

const MODELS = ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5-mini', 'gpt-5.4-thinking', 'gpt-5.2-codex'];

const PROMPT_CODE = `You are a Python data analysis assistant in a Jupyter notebook.
Generate clean, runnable Python code for the user's request.
- Use pandas, numpy, matplotlib, seaborn as needed
- Assume relevant variables (e.g. df) are already defined in the kernel
- Return ONLY the Python code — no explanation, no markdown fences
- Use plt.show() at the end if creating a chart
- Keep the SAME language as the user (Chinese → Chinese comments, English → English)`;

const PROMPT_POLISH = `You are a professional note organizer for data analysis sessions.
Rewrite the user's raw notes as concise, well-organized bullet points.
Rules:
- Keep the SAME language as the input (Chinese in → Chinese out, English in → English out)
- Use clear hierarchy: main points with sub-points where helpful (• and  –)
- Remove redundancy but preserve every key insight
- Do not add information not present in the original notes
- Return only the organized bullet points, no preamble`;

const PROMPT_CHAT = `You are a helpful data analysis assistant embedded in a Jupyter notebook.
Help the user understand their data, answer questions, suggest next steps, and explain methods.
Keep the SAME language as the user (Chinese → Chinese, English → English).
Be concise and practical.`;

// ── State ────────────────────────────────────────────────────────────────────

let tracker: INotebookTracker;
let chatHistory: { role: string; content: string }[] = [];
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let isRecording = false;
let currentTab = 'code';

// ── API Key ──────────────────────────────────────────────────────────────────

async function getApiKey(): Promise<string> {
  const inputEl = document.getElementById('rb-key-input') as HTMLInputElement | null;
  if (inputEl?.value.trim()) return inputEl.value.trim();

  const cached = localStorage.getItem('rb_openai_key');
  if (cached) return cached;

  // Read from kernel: env var + .env files
  const kernel = tracker.currentWidget?.sessionContext.session?.kernel;
  if (!kernel) throw new Error('No active kernel');

  return new Promise((resolve, reject) => {
    let done = false;
    const code = [
      "import os; from pathlib import Path",
      "_k = os.environ.get('OPENAI_API_KEY', '')",
      "if not _k:",
      "    for _p in [Path.home()/'.env', Path('.env')]:",
      "        try:",
      "            for _l in _p.read_text().splitlines():",
      "                if _l.startswith('OPENAI_API_KEY='):",
      "                    _k = _l.split('=',1)[1].strip().strip('\"').strip(\"'\")",
      "                    break",
      "        except: pass",
      "        if _k: break",
      "print(_k, end='')",
    ].join('\n');

    const future = kernel.requestExecute({ code });
    future.onIOPub = (msg: any) => {
      if (done) return;
      const text = (msg.content?.text || '').trim();
      if (text) {
        done = true;
        localStorage.setItem('rb_openai_key', text);
        resolve(text);
      }
    };
    setTimeout(() => { if (!done) reject(new Error('未找到 API Key，请在面板中填入')); }, 5000);
  });
}

function saveApiKey(): void {
  const inp = document.getElementById('rb-key-input') as HTMLInputElement | null;
  if (!inp?.value.trim()) { setStatus('请先填入 API Key', true); return; }
  const key = inp.value.trim();
  localStorage.setItem('rb_openai_key', key);

  const kernel = tracker.currentWidget?.sessionContext.session?.kernel;
  if (!kernel) { setStatus('✓ 已保存到浏览器（无活跃 kernel）'); return; }

  const code = [
    "from pathlib import Path",
    "_p = Path.home() / '.env'",
    "_lines = [l for l in (_p.read_text().splitlines() if _p.exists() else []) if not l.startswith('OPENAI_API_KEY=')]",
    `_lines.append('OPENAI_API_KEY=${key}')`,
    "_p.write_text('\\n'.join(_lines) + '\\n')",
    "print('saved', end='')",
  ].join('\n');

  const future = kernel.requestExecute({ code });
  future.onIOPub = (msg: any) => {
    if ((msg.content?.text || '').trim() === 'saved') setStatus('✓ API Key 已保存到 ~/.env');
  };
}

// ── OpenAI calls ─────────────────────────────────────────────────────────────

async function transcribe(blob: Blob, ext: string, apiKey: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob, `rec.${ext}`);
  fd.append('model', 'whisper-1');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: fd,
  });
  if (!r.ok) throw new Error('Whisper: ' + await r.text());
  return ((await r.json()) as any).text || '';
}

async function chatComplete(
  systemPrompt: string,
  messages: { role: string; content: string }[],
  model: string,
  apiKey: string
): Promise<string> {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!r.ok) throw new Error('OpenAI: ' + await r.text());
  return ((await r.json()) as any).choices[0].message.content.trim();
}

// ── Cell insertion ───────────────────────────────────────────────────────────

function insertCodeCell(code: string): void {
  const nb = tracker.currentWidget?.content;
  if (!nb) return;
  NotebookActions.insertBelow(nb);
  const cell = nb.activeCell;
  if (cell) cell.model.sharedModel.setSource(code);
}

function insertMarkdownCell(bullets: string): void {
  const nb = tracker.currentWidget?.content;
  if (!nb) return;
  const html = `<div style="columns:2;column-gap:24px;font-size:14px;line-height:1.7;">\n\n${bullets}\n\n</div>`;
  NotebookActions.insertBelow(nb);
  // Change cell type to Markdown
  NotebookActions.changeCellType(nb, 'markdown');
  const cell = nb.activeCell;
  if (cell) {
    cell.model.sharedModel.setSource(html);
    NotebookActions.run(nb, tracker.currentWidget!.sessionContext);
  }
}

// ── Recording ────────────────────────────────────────────────────────────────

async function startRecording(onStop: (blob: Blob, ext: string) => Promise<void>): Promise<void> {
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { throw new Error('麦克风权限被拒绝'); }

  const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  mediaRecorder.ondataavailable = (e: BlobEvent) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(audioChunks, { type: mime || 'audio/webm' });
    const ext  = (mime.split('/')[1] || 'webm').split(';')[0];
    await onStop(blob, ext);
  };
  mediaRecorder.start();
  isRecording = true;
}

function stopRecording(): void {
  if (mediaRecorder?.state === 'recording') { mediaRecorder.stop(); isRecording = false; }
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function setStatus(text: string, isError = false): void {
  const el = document.getElementById('rb-status');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'error' : '';
}

function getModel(): string {
  return (document.getElementById('rb-model-sel') as HTMLSelectElement | null)?.value || 'gpt-5.5';
}

function modelKey(tab: string): string {
  return 'rb_model_' + tab;
}

// ── Voice handlers ───────────────────────────────────────────────────────────

async function handleVoiceRecord(): Promise<void> {
  if (isRecording) { stopRecording(); return; }

  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); return; }

  const btn = document.getElementById('rb-voice-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = '⏹ 停止录音';
  btn.classList.add('recording');
  setStatus('录音中… 说完后点停止');

  try {
    await startRecording(async (blob, ext) => {
      btn.textContent = '🎤 录音';
      btn.classList.remove('recording');
      btn.disabled = true;
      try {
        setStatus('语音识别中…');
        const text = await transcribe(blob, ext, apiKey);
        if (!text) throw new Error('未识别到语音');
        const voiceBox = document.getElementById('rb-voice-text') as HTMLTextAreaElement | null;
        if (voiceBox) voiceBox.value = text;
        setStatus('✓ 识别完成，可编辑后点下方按钮执行');
      } catch (e: any) {
        setStatus('❌ ' + e.message, true);
      }
      btn.disabled = false;
    });
  } catch (e: any) {
    btn.textContent = '🎤 录音';
    btn.classList.remove('recording');
    setStatus('❌ ' + e.message, true);
  }
}

async function handleAction(): Promise<void> {
  const voiceBox = document.getElementById('rb-voice-text') as HTMLTextAreaElement | null;
  const text = voiceBox?.value.trim() || '';
  if (!text) { setStatus('请先录音或在文本框中输入内容', true); return; }

  const actionBtn = document.getElementById('rb-action-btn') as HTMLButtonElement | null;
  if (actionBtn) actionBtn.disabled = true;

  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); if (actionBtn) actionBtn.disabled = false; return; }

  try {
    setStatus('生成中…');
    const model = getModel();
    if (currentTab === 'code') {
      let code = await chatComplete(PROMPT_CODE, [{ role: 'user', content: text }], model, apiKey);
      code = code.replace(/^```(?:python)?\s*/m, '').replace(/\s*```$/m, '').trim();
      insertCodeCell(code);
      setStatus('✓ 代码已插入到选中 cell 下方');
    } else {
      const bullets = await chatComplete(PROMPT_POLISH, [{ role: 'user', content: text }], model, apiKey);
      insertMarkdownCell(bullets);
      setStatus('✓ 笔记已插入（双列）');
    }
  } catch (e: any) {
    setStatus('❌ ' + e.message, true);
  }
  if (actionBtn) actionBtn.disabled = false;
}

async function handleChatVoice(): Promise<void> {
  const btn = document.getElementById('rb-chat-voice') as HTMLButtonElement | null;
  if (!btn) return;
  if (isRecording) { stopRecording(); return; }

  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); return; }

  btn.classList.add('recording');
  setStatus('录音中…');

  try {
    await startRecording(async (blob, ext) => {
      btn.classList.remove('recording');
      try {
        setStatus('语音识别中…');
        const text = await transcribe(blob, ext, apiKey);
        if (text) await sendChat(text);
      } catch (e: any) {
        setStatus('❌ ' + e.message, true);
      }
    });
  } catch (e: any) {
    btn.classList.remove('recording');
    setStatus('❌ ' + e.message, true);
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function appendBubble(role: string, text: string): void {
  const el = document.getElementById('rb-chat-messages');
  if (!el) return;
  const div = document.createElement('div');
  div.className = 'rb-msg';
  const bubble = document.createElement('div');
  bubble.className = 'rb-bubble ' + (role === 'user' ? 'user' : 'ai');
  bubble.textContent = text;
  div.appendChild(bubble);
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

async function sendChat(text: string): Promise<void> {
  if (!text.trim()) return;
  appendBubble('user', text);
  chatHistory.push({ role: 'user', content: text });
  const input = document.getElementById('rb-chat-input') as HTMLTextAreaElement | null;
  if (input) input.value = '';
  setStatus('AI 回复中…');

  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); return; }

  try {
    const reply = await chatComplete(PROMPT_CHAT, chatHistory, getModel(), apiKey);
    chatHistory.push({ role: 'assistant', content: reply });
    appendBubble('assistant', reply);
    setStatus('');
  } catch (e: any) {
    setStatus('❌ ' + e.message, true);
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

function renderTabContent(tab: string): void {
  ['rb-action-area', 'rb-chat-area'].forEach(id => document.getElementById(id)?.remove());
  const statusEl = document.getElementById('rb-status')!;
  const body = document.getElementById('rb-body')!;

  if (tab === 'code' || tab === 'polish') {
    const area = document.createElement('div');
    area.id = 'rb-action-area';
    const actionLabel = tab === 'code' ? '生成代码' : '整理笔记';
    area.innerHTML = `
      <button id="rb-voice-btn" onclick="rbLabVoiceRecord()">🎤 录音</button>
      <textarea id="rb-voice-text" placeholder="语音识别结果，也可直接输入…"></textarea>
      <button id="rb-action-btn" onclick="rbLabAction()">${actionLabel}</button>`;
    body.insertBefore(area, statusEl);
  } else {
    const area = document.createElement('div');
    area.id = 'rb-chat-area';
    area.innerHTML = `
      <div id="rb-chat-messages"></div>
      <div id="rb-chat-row">
        <textarea id="rb-chat-input" placeholder="输入消息…" rows="1"></textarea>
        <button id="rb-chat-voice" title="语音输入" onclick="rbLabChatVoice()">🎤</button>
        <button id="rb-chat-send" onclick="rbLabChatSend()">↑</button>
      </div>`;
    body.insertBefore(area, statusEl);
    chatHistory.forEach(m => appendBubble(m.role, m.content));
    const input = document.getElementById('rb-chat-input') as HTMLTextAreaElement;
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value); }
    });
  }
}

function switchTab(tab: string): void {
  // Save current tab's model before switching
  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement | null;
  if (sel) localStorage.setItem(modelKey(currentTab), sel.value);

  currentTab = tab;
  ['code', 'polish', 'chat'].forEach(t => {
    document.getElementById('rb-tab-' + t)?.classList.toggle('active', t === tab);
  });
  renderTabContent(tab);
  setStatus('');

  // Restore new tab's model
  if (sel) sel.value = localStorage.getItem(modelKey(tab)) || MODELS[0];
}

function buildPanel(): void {
  if (document.getElementById('rb-panel')) return;

  // Inject CSS
  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.type = 'text/css';
  link.href = (window as any).__rbLabCssUrl || '';
  document.head.appendChild(link);

  // Toggle button
  const toggle = document.createElement('button');
  toggle.id = 'rb-toggle';
  toggle.title = 'AI Assistant';
  toggle.innerHTML = '🤖';
  toggle.onclick = () => {
    document.getElementById('rb-panel')?.classList.remove('rb-hidden');
    toggle.style.display = 'none';
  };
  document.body.appendChild(toggle);

  // Panel
  const panel = document.createElement('div');
  panel.id = 'rb-panel';
  panel.innerHTML = `
    <div id="rb-resize-handle" title="调节大小"></div>
    <div id="rb-header">
      <span>🤖 AI Assistant</span>
      <button id="rb-close" title="关闭">✕</button>
    </div>
    <div id="rb-body">
      <div id="rb-tabs">
        <button id="rb-tab-code"   class="rb-tab active" onclick="rbLabTab('code')">生成代码</button>
        <button id="rb-tab-polish" class="rb-tab"        onclick="rbLabTab('polish')">整理笔记</button>
        <button id="rb-tab-chat"   class="rb-tab"        onclick="rbLabTab('chat')">讨论</button>
      </div>
      <div class="rb-row" id="rb-model-row">
        <select id="rb-model-sel" class="rb-select">
          ${MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
        </select>
      </div>
      <div class="rb-row" id="rb-key-row">
        <input id="rb-key-input" class="rb-input" type="password" placeholder="API Key（留空则读 .env / 环境变量）" />
        <button class="rb-key-toggle" onclick="rbLabToggleKey()" title="显示/隐藏">👁</button>
        <button class="rb-key-toggle" onclick="rbLabSaveKey()" title="保存到 ~/.env">💾</button>
      </div>
      <div id="rb-status"></div>
    </div>`;
  document.body.appendChild(panel);

  // Restore saved size and position
  const savedW = localStorage.getItem('rb_panel_w');
  const savedH = localStorage.getItem('rb_panel_h');
  const savedL = localStorage.getItem('rb_panel_l');
  const savedT = localStorage.getItem('rb_panel_t');
  if (savedW) panel.style.width  = savedW;
  if (savedH) panel.style.height = savedH;
  if (savedL && savedT) {
    panel.style.right  = 'auto'; panel.style.bottom = 'auto';
    panel.style.left = savedL; panel.style.top = savedT;
  }

  // Remember size changes
  const ro = new ResizeObserver(() => {
    if (panel.style.width)  localStorage.setItem('rb_panel_w', panel.style.width);
    if (panel.style.height) localStorage.setItem('rb_panel_h', panel.style.height);
  });
  ro.observe(panel);

  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement;
  sel.value = localStorage.getItem(modelKey('code')) || MODELS[0];
  sel.onchange = () => localStorage.setItem(modelKey(currentTab), sel.value);

  document.getElementById('rb-close')!.onclick = () => {
    panel.classList.add('rb-hidden');
    toggle.style.display = 'flex';
  };

  // Drag (header)
  let dragging = false, ox = 0, oy = 0;
  document.getElementById('rb-header')!.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
  });

  // Resize from top-left handle
  let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0, startR = 0, startB = 0;
  document.getElementById('rb-resize-handle')!.addEventListener('mousedown', (e: MouseEvent) => {
    e.stopPropagation();
    resizing = true;
    startX = e.clientX; startY = e.clientY;
    startW = panel.offsetWidth; startH = panel.offsetHeight;
    const rect = panel.getBoundingClientRect();
    startR = window.innerWidth  - rect.right;
    startB = window.innerHeight - rect.bottom;
    panel.style.right  = startR + 'px'; panel.style.bottom = startB + 'px';
    panel.style.left   = 'auto';        panel.style.top    = 'auto';
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (dragging) {
      panel.style.right  = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + 'px';
      panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
      localStorage.setItem('rb_panel_l', panel.style.left);
      localStorage.setItem('rb_panel_t', panel.style.top);
    }
    if (resizing) {
      const newW = Math.max(240, startW - (e.clientX - startX));
      const newH = Math.max(220, startH - (e.clientY - startY));
      panel.style.width  = newW + 'px';
      panel.style.height = newH + 'px';
      localStorage.setItem('rb_panel_w', panel.style.width);
      localStorage.setItem('rb_panel_h', panel.style.height);
    }
  });
  document.addEventListener('mouseup', () => { dragging = false; resizing = false; });

  renderTabContent('code');
}

// Expose to HTML onclick
(window as any).rbLabTab         = switchTab;
(window as any).rbLabVoiceRecord = handleVoiceRecord;
(window as any).rbLabAction      = handleAction;
(window as any).rbLabChatVoice   = handleChatVoice;
(window as any).rbLabChatSend   = () => sendChat((document.getElementById('rb-chat-input') as HTMLTextAreaElement | null)?.value || '');
(window as any).rbLabSaveKey    = saveApiKey;
(window as any).rbLabToggleKey  = () => {
  const inp = document.getElementById('rb-key-input') as HTMLInputElement | null;
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
};

// ── Plugin ───────────────────────────────────────────────────────────────────

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'rb-assistant-lab:plugin',
  description: 'AI voice assistant panel',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, nbTracker: INotebookTracker) => {
    tracker = nbTracker;
    app.restored.then(() => { buildPanel(); });
  }
};

export default plugin;
