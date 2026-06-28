import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';

// ── Agent config ──────────────────────────────────────────────────────────────

const AGENTS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai' as const,
    envKey: 'OPENAI_API_KEY',
    storageKey: 'rb_key_openai',
    defaultModels: ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5-mini', 'gpt-5.4-thinking', 'gpt-5.2-codex'],
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    format: 'anthropic' as const,
    envKey: 'ANTHROPIC_API_KEY',
    storageKey: 'rb_key_anthropic',
    defaultModels: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  },
  google: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    format: 'openai' as const,
    envKey: 'GOOGLE_API_KEY',
    storageKey: 'rb_key_google',
    defaultModels: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
  },
} as const;

type AgentId = keyof typeof AGENTS;

const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

// ── Prompts ───────────────────────────────────────────────────────────────────

const PROMPT_CODE = `You are a Python data analysis assistant in a Jupyter notebook.
Generate clean, runnable Python code for the user's request.
- Use pandas, numpy, matplotlib, seaborn as needed
- Assume relevant variables (e.g. df) are already defined in the kernel
- Return ONLY the Python code — no explanation, no markdown fences
- Use plt.show() at the end if creating a chart`;

const PROMPT_POLISH = `You are a professional note organizer for data analysis sessions.
Rewrite the user's raw notes as concise, well-organized bullet points.
Rules:
- Use clear hierarchy: main points with sub-points where helpful (• and  –)
- Remove redundancy but preserve every key insight
- Do not add information not present in the original notes
- Return only the organized bullet points, no preamble`;

const PROMPT_CHAT = `You are a helpful data analysis assistant embedded in a Jupyter notebook.
Help the user understand their data, answer questions, suggest next steps, and explain methods.
Be concise and practical.`;

// ── State ─────────────────────────────────────────────────────────────────────

let tracker: INotebookTracker;
let chatHistory: { role: string; content: string }[] = [];
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let isRecording = false;
let currentTab = 'code';
let currentAgent: AgentId = (localStorage.getItem('rb_agent') as AgentId) || 'openai';

// ── Helpers ───────────────────────────────────────────────────────────────────

function agent() { return AGENTS[currentAgent]; }

function modelListKey(agentId: AgentId) { return 'rb_models_' + agentId; }
function modelSelKey(agentId: AgentId, tab: string) { return `rb_model_${agentId}_${tab}`; }

function getModelList(agentId: AgentId = currentAgent): string[] {
  const saved = localStorage.getItem(modelListKey(agentId));
  if (saved) {
    const list = saved.split('\n').map((s: string) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [...AGENTS[agentId].defaultModels];
}

function rebuildModelSelect(keepValue?: string): void {
  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement | null;
  if (!sel) return;
  const models = getModelList();
  sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
  const saved = keepValue || localStorage.getItem(modelSelKey(currentAgent, currentTab)) || models[0];
  sel.value = models.includes(saved) ? saved : models[0];
}

function getModel(): string {
  return (document.getElementById('rb-model-sel') as HTMLSelectElement | null)?.value || agent().defaultModels[0];
}

function setStatus(text: string, isError = false): void {
  const el = document.getElementById('rb-status');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'error' : '';
}

// ── Agent switching ───────────────────────────────────────────────────────────

function switchAgent(agentId: AgentId): void {
  // Save current model selection before switching
  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement | null;
  if (sel) localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);

  currentAgent = agentId;
  localStorage.setItem('rb_agent', agentId);

  // Rebuild model list for new agent
  rebuildModelSelect();

  // Sync agent selector UI
  const agentSel = document.getElementById('rb-agent-sel') as HTMLSelectElement | null;
  if (agentSel) agentSel.value = agentId;

  // Update prefs textarea if open
  const prefsEl = document.getElementById('rb-prefs');
  if (prefsEl && !prefsEl.classList.contains('rb-hidden')) {
    const ta = document.getElementById('rb-models-input') as HTMLTextAreaElement | null;
    if (ta) ta.value = getModelList().join('\n');
  }

  setStatus('');
}

// ── Preferences ───────────────────────────────────────────────────────────────

function togglePrefs(): void {
  const prefs = document.getElementById('rb-prefs');
  if (!prefs) return;
  const nowHidden = prefs.classList.toggle('rb-hidden');
  if (!nowHidden) {
    const ta = document.getElementById('rb-models-input') as HTMLTextAreaElement | null;
    if (ta) ta.value = getModelList().join('\n');
  }
}

function savePrefs(): void {
  const ta = document.getElementById('rb-models-input') as HTMLTextAreaElement | null;
  if (!ta) return;
  const models = ta.value.split('\n').map((s: string) => s.trim()).filter(Boolean);
  if (!models.length) return;
  localStorage.setItem(modelListKey(currentAgent), models.join('\n'));
  const current = (document.getElementById('rb-model-sel') as HTMLSelectElement | null)?.value;
  rebuildModelSelect(current);
  document.getElementById('rb-prefs')?.classList.add('rb-hidden');
}

function resetPrefs(): void {
  localStorage.removeItem(modelListKey(currentAgent));
  const ta = document.getElementById('rb-models-input') as HTMLTextAreaElement | null;
  if (ta) ta.value = getModelList().join('\n');
}

// ── API Key ───────────────────────────────────────────────────────────────────

async function getApiKey(): Promise<string> {
  const inputEl = document.getElementById('rb-key-input') as HTMLInputElement | null;
  if (inputEl?.value.trim()) return inputEl.value.trim();

  const cached = localStorage.getItem(agent().storageKey)
    || (currentAgent === 'openai' ? localStorage.getItem('rb_openai_key') : null);
  if (cached) return cached;

  const kernel = tracker.currentWidget?.sessionContext.session?.kernel;
  if (!kernel) throw new Error('No active kernel');

  const envVar = agent().envKey;
  return new Promise((resolve, reject) => {
    let done = false;
    const code = [
      "import os; from pathlib import Path",
      `_k = os.environ.get('${envVar}', '')`,
      "if not _k:",
      "    for _p in [Path.home()/'.env', Path('.env')]:",
      "        try:",
      "            for _l in _p.read_text().splitlines():",
      `                if _l.startswith('${envVar}='):`,
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
        localStorage.setItem(agent().storageKey, text);
        resolve(text);
      }
    };
    setTimeout(() => { if (!done) reject(new Error(`${agent().label} API Key not found. Please enter it in the panel.`)); }, 5000);
  });
}

function saveApiKey(): void {
  const inp = document.getElementById('rb-key-input') as HTMLInputElement | null;
  if (!inp?.value.trim()) { setStatus('Please enter your API Key first.', true); return; }
  const key = inp.value.trim();
  localStorage.setItem(agent().storageKey, key);

  const kernel = tracker.currentWidget?.sessionContext.session?.kernel;
  if (!kernel) { setStatus('✓ Saved to browser (no active kernel)'); return; }

  const envVar = agent().envKey;
  const code = [
    "from pathlib import Path",
    "_p = Path.home() / '.env'",
    `_lines = [l for l in (_p.read_text().splitlines() if _p.exists() else []) if not l.startswith('${envVar}=')]`,
    `_lines.append('${envVar}=${key}')`,
    "_p.write_text('\\n'.join(_lines) + '\\n')",
    "print('saved', end='')",
  ].join('\n');

  const future = kernel.requestExecute({ code });
  future.onIOPub = (msg: any) => {
    if ((msg.content?.text || '').trim() === 'saved') setStatus(`✓ ${envVar} saved to ~/.env`);
  };
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function transcribe(blob: Blob, ext: string, apiKey: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', blob, `rec.${ext}`);
  fd.append('model', 'whisper-1');
  // Whisper is OpenAI-only; always use OpenAI endpoint for transcription
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
  const cfg = agent();

  if (cfg.format === 'anthropic') {
    const r = await fetch(cfg.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt, messages }),
    });
    if (!r.ok) throw new Error('Anthropic: ' + await r.text());
    return ((await r.json()) as any).content[0].text.trim();
  }

  // OpenAI-compatible (OpenAI + Google Gemini)
  const r = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!r.ok) throw new Error(`${cfg.label}: ` + await r.text());
  return ((await r.json()) as any).choices[0].message.content.trim();
}

// ── Cell insertion ────────────────────────────────────────────────────────────

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
  NotebookActions.changeCellType(nb, 'markdown');
  const cell = nb.activeCell;
  if (cell) {
    cell.model.sharedModel.setSource(html);
    NotebookActions.run(nb, tracker.currentWidget!.sessionContext);
  }
}

// ── Recording ─────────────────────────────────────────────────────────────────

async function startRecording(onStop: (blob: Blob, ext: string) => Promise<void>): Promise<void> {
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { throw new Error('Microphone access denied'); }

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

// ── Voice handlers ────────────────────────────────────────────────────────────

async function handleVoiceRecord(): Promise<void> {
  if (isRecording) { stopRecording(); return; }

  let apiKey: string;
  // For transcription we always need an OpenAI key (Whisper)
  const whisperKey = localStorage.getItem('rb_key_openai') || localStorage.getItem('rb_openai_key') || '';
  try { apiKey = whisperKey || await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); return; }

  const btn = document.getElementById('rb-voice-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = '⏹ Stop';
  btn.classList.add('recording');
  setStatus('Recording… click Stop when done');

  try {
    await startRecording(async (blob, ext) => {
      btn.textContent = '🎤 Record';
      btn.classList.remove('recording');
      btn.disabled = true;
      try {
        setStatus('Transcribing…');
        const text = await transcribe(blob, ext, apiKey);
        if (!text) throw new Error('No speech detected');
        const voiceBox = document.getElementById('rb-voice-text') as HTMLTextAreaElement | null;
        if (voiceBox) voiceBox.value = text;
        setStatus('✓ Done. Edit if needed, then click the button below.');
      } catch (e: any) {
        setStatus('❌ ' + e.message, true);
      }
      btn.disabled = false;
    });
  } catch (e: any) {
    btn.textContent = '🎤 Record';
    btn.classList.remove('recording');
    setStatus('❌ ' + e.message, true);
  }
}

async function handleAction(): Promise<void> {
  const voiceBox = document.getElementById('rb-voice-text') as HTMLTextAreaElement | null;
  const text = voiceBox?.value.trim() || '';
  if (!text) { setStatus('Please record or type something first.', true); return; }

  const actionBtn = document.getElementById('rb-action-btn') as HTMLButtonElement | null;
  if (actionBtn) actionBtn.disabled = true;

  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); if (actionBtn) actionBtn.disabled = false; return; }

  try {
    setStatus('Generating…');
    const model = getModel();
    if (currentTab === 'code') {
      let code = await chatComplete(PROMPT_CODE, [{ role: 'user', content: text }], model, apiKey);
      code = code.replace(/^```(?:python)?\s*/m, '').replace(/\s*```$/m, '').trim();
      insertCodeCell(code);
      setStatus('✓ Code inserted below active cell');
    } else {
      const bullets = await chatComplete(PROMPT_POLISH, [{ role: 'user', content: text }], model, apiKey);
      insertMarkdownCell(bullets);
      setStatus('✓ Notes inserted (two-column layout)');
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

  const whisperKey = localStorage.getItem('rb_key_openai') || localStorage.getItem('rb_openai_key') || '';
  let apiKey: string;
  try { apiKey = whisperKey || await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); return; }

  btn.classList.add('recording');
  setStatus('Recording…');

  try {
    await startRecording(async (blob, ext) => {
      btn.classList.remove('recording');
      try {
        setStatus('Transcribing…');
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

// ── Chat ──────────────────────────────────────────────────────────────────────

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
  setStatus('Thinking…');

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

// ── Panel ─────────────────────────────────────────────────────────────────────

function renderTabContent(tab: string): void {
  ['rb-action-area', 'rb-chat-area'].forEach(id => document.getElementById(id)?.remove());
  const statusEl = document.getElementById('rb-status')!;
  const body = document.getElementById('rb-body')!;

  if (tab === 'code' || tab === 'polish') {
    const area = document.createElement('div');
    area.id = 'rb-action-area';
    const actionLabel = tab === 'code' ? 'Generate Code' : 'Polish Notes';
    area.innerHTML = `
      <button id="rb-voice-btn" onclick="rbLabVoiceRecord()">🎤 Record</button>
      <textarea id="rb-voice-text" placeholder="Transcription result, or type directly…"></textarea>
      <button id="rb-action-btn" onclick="rbLabAction()">${actionLabel}</button>`;
    body.insertBefore(area, statusEl);
  } else {
    const area = document.createElement('div');
    area.id = 'rb-chat-area';
    area.innerHTML = `
      <div id="rb-chat-messages"></div>
      <div id="rb-chat-row">
        <textarea id="rb-chat-input" placeholder="Type a message…" rows="1"></textarea>
        <button id="rb-chat-voice" title="Voice input" onclick="rbLabChatVoice()">🎤</button>
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
  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement | null;
  if (sel) localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);

  currentTab = tab;
  ['code', 'polish', 'chat'].forEach(t => {
    document.getElementById('rb-tab-' + t)?.classList.toggle('active', t === tab);
  });
  renderTabContent(tab);
  setStatus('');

  if (sel) {
    const saved = localStorage.getItem(modelSelKey(currentAgent, tab));
    const models = getModelList();
    sel.value = (saved && models.includes(saved)) ? saved : models[0];
  }
}

function buildPanel(): void {
  if (document.getElementById('rb-panel')) return;

  const link = document.createElement('link');
  link.rel  = 'stylesheet';
  link.type = 'text/css';
  link.href = (window as any).__rbLabCssUrl || '';
  document.head.appendChild(link);

  const toggle = document.createElement('button');
  toggle.id = 'rb-toggle';
  toggle.title = 'AI Assistant';
  toggle.innerHTML = '🤖';
  toggle.onclick = () => {
    document.getElementById('rb-panel')?.classList.remove('rb-hidden');
    toggle.style.display = 'none';
  };
  document.body.appendChild(toggle);

  const panel = document.createElement('div');
  panel.id = 'rb-panel';
  panel.innerHTML = `
    <div id="rb-resize-handle" title="Resize"></div>
    <div id="rb-header">
      <span>🤖 AI Assistant</span>
      <button id="rb-close" title="Close">✕</button>
    </div>
    <div id="rb-body">
      <div id="rb-tabs">
        <button id="rb-tab-code"   class="rb-tab active" onclick="rbLabTab('code')">Code</button>
        <button id="rb-tab-polish" class="rb-tab"        onclick="rbLabTab('polish')">Polish</button>
        <button id="rb-tab-chat"   class="rb-tab"        onclick="rbLabTab('chat')">Chat</button>
      </div>
      <div class="rb-row" id="rb-agent-row">
        <label class="rb-label">Agent</label>
        <select id="rb-agent-sel" class="rb-select" onchange="rbLabSwitchAgent(this.value)">
          ${AGENT_IDS.map(id => `<option value="${id}">${AGENTS[id].label}</option>`).join('')}
        </select>
      </div>
      <div class="rb-row" id="rb-model-row">
        <label class="rb-label">Model</label>
        <select id="rb-model-sel" class="rb-select"></select>
        <button class="rb-key-toggle" onclick="rbLabTogglePrefs()" title="Edit model list">⚙</button>
      </div>
      <div id="rb-prefs" class="rb-hidden">
        <textarea id="rb-models-input" placeholder="One model name per line…"></textarea>
        <div class="rb-row" style="gap:6px">
          <button id="rb-prefs-reset" onclick="rbLabResetPrefs()" style="flex:1">Reset</button>
          <button id="rb-prefs-save"  onclick="rbLabSavePrefs()"  style="flex:2">Save</button>
        </div>
      </div>
      <div class="rb-row" id="rb-key-row">
        <input id="rb-key-input" class="rb-input" type="password" placeholder="API Key (leave blank to use .env or env var)" />
        <button class="rb-key-toggle" onclick="rbLabToggleKey()" title="Show/hide">👁</button>
        <button class="rb-key-toggle" onclick="rbLabSaveKey()" title="Save to ~/.env">💾</button>
      </div>
      <div id="rb-status"></div>
    </div>`;
  document.body.appendChild(panel);

  // Restore size and position
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

  const ro = new ResizeObserver(() => {
    if (panel.style.width)  localStorage.setItem('rb_panel_w', panel.style.width);
    if (panel.style.height) localStorage.setItem('rb_panel_h', panel.style.height);
  });
  ro.observe(panel);

  // Init agent selector
  const agentSel = document.getElementById('rb-agent-sel') as HTMLSelectElement;
  agentSel.value = currentAgent;

  // Init model selector
  rebuildModelSelect();
  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement;
  sel.onchange = () => localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);

  document.getElementById('rb-close')!.onclick = () => {
    panel.classList.add('rb-hidden');
    toggle.style.display = 'flex';
  };

  // Drag
  let dragging = false, ox = 0, oy = 0;
  document.getElementById('rb-header')!.addEventListener('mousedown', (e: MouseEvent) => {
    dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
  });

  // Resize from top-left
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

// ── Expose to HTML onclick ────────────────────────────────────────────────────

(window as any).rbLabTab          = switchTab;
(window as any).rbLabSwitchAgent  = (id: string) => switchAgent(id as AgentId);
(window as any).rbLabVoiceRecord  = handleVoiceRecord;
(window as any).rbLabAction       = handleAction;
(window as any).rbLabChatVoice    = handleChatVoice;
(window as any).rbLabChatSend     = () => sendChat((document.getElementById('rb-chat-input') as HTMLTextAreaElement | null)?.value || '');
(window as any).rbLabTogglePrefs  = togglePrefs;
(window as any).rbLabSavePrefs    = savePrefs;
(window as any).rbLabResetPrefs   = resetPrefs;
(window as any).rbLabSaveKey      = saveApiKey;
(window as any).rbLabToggleKey    = () => {
  const inp = document.getElementById('rb-key-input') as HTMLInputElement | null;
  if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
};

// ── Plugin ────────────────────────────────────────────────────────────────────

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
