import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';
import { LabIcon } from '@jupyterlab/ui-components';

// ── Sidebar icon ──────────────────────────────────────────────────────────────

const robotIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="5" y="9" width="14" height="11" rx="2" fill="currentColor"/>
  <rect x="8.5" y="6" width="7" height="3" rx="1" fill="currentColor"/>
  <circle cx="3" cy="14" r="1.5" fill="currentColor"/>
  <circle cx="21" cy="14" r="1.5" fill="currentColor"/>
  <circle cx="9.5" cy="15" r="1.5" fill="white"/>
  <circle cx="14.5" cy="15" r="1.5" fill="white"/>
  <rect x="8.5" y="18" width="7" height="1" rx=".5" fill="white"/>
</svg>`;

const robotIcon = new LabIcon({ name: 'rb-assistant:icon', svgstr: robotIconSvg });

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

const PROMPT_FIX = `You are a Python debugging assistant in a Jupyter notebook.
The user will provide code that raised an error, along with the error message.
Fix the code so it runs without errors.
- Return ONLY the corrected Python code — no explanation, no markdown fences
- Preserve the original intent of the code`;

const PROMPT_CHAT = `You are a helpful data analysis assistant embedded in a Jupyter notebook.
Help the user understand their data, answer questions, suggest next steps, and explain methods.
Be concise and practical.`;

// ── State ─────────────────────────────────────────────────────────────────────

let tracker: INotebookTracker;
let chatHistory: { role: string; content: string }[] = [];
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let isRecording = false;
let currentTab = 'input';
let currentAgent: AgentId = (localStorage.getItem('rb_agent') as AgentId) || 'openai';

function loadInputHistory(): string[] {
  try { return JSON.parse(localStorage.getItem('rb_input_history') || '[]'); } catch { return []; }
}
function saveInputHistory(text: string): void {
  const hist = loadInputHistory().filter((s: string) => s !== text);
  hist.unshift(text);
  localStorage.setItem('rb_input_history', JSON.stringify(hist.slice(0, 30)));
  rebuildHistorySelect();
}
function rebuildHistorySelect(): void {
  const sel = document.getElementById('rb-history-sel') as HTMLSelectElement | null;
  if (!sel) return;
  const hist = loadInputHistory();
  sel.innerHTML = `<option value="">History…</option>` +
    hist.map((s: string) => `<option value="${s.replace(/"/g, '&quot;')}">${s.length > 40 ? s.slice(0, 40) + '…' : s}</option>`).join('');
}

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
  const sel = document.getElementById('rb-model-sel') as HTMLSelectElement | null;
  if (sel) localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);
  currentAgent = agentId;
  localStorage.setItem('rb_agent', agentId);
  rebuildModelSelect();
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
      if (text) { done = true; localStorage.setItem(agent().storageKey, text); resolve(text); }
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
  if (cfg.format === 'openai' && currentAgent === 'openai' && model.includes('codex')) {
    const input = messages.map(m => ({ role: m.role, content: m.content }));
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, instructions: systemPrompt, input }),
    });
    if (!r.ok) throw new Error(`${cfg.label}: ` + await r.text());
    const data = (await r.json()) as any;
    const msg = data.output?.find((o: any) => o.type === 'message');
    return (msg?.content?.find((c: any) => c.type === 'output_text')?.text || '').trim();
  }
  const r = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
  });
  if (!r.ok) throw new Error(`${cfg.label}: ` + await r.text());
  return ((await r.json()) as any).choices[0].message.content.trim();
}

// ── Cell insertion ────────────────────────────────────────────────────────────

function insertCodeCell(code: string): any {
  const nb = tracker.currentWidget?.content;
  if (!nb) return null;
  NotebookActions.insertBelow(nb);
  const cell = nb.activeCell;
  if (cell) cell.model.sharedModel.setSource(code);
  return cell;
}

async function runAndDebug(cell: any, apiKey: string, model: string): Promise<void> {
  const MAX = 3;
  const nb = tracker.currentWidget?.content;
  if (!nb || !tracker.currentWidget?.sessionContext.session?.kernel) {
    setStatus('✓ Code inserted (no kernel — run manually)');
    return;
  }
  for (let attempt = 1; attempt <= MAX; attempt++) {
    setStatus(`Running… (${attempt}/${MAX})`);
    nb.activeCellIndex = nb.widgets.indexOf(cell);
    await NotebookActions.run(nb, tracker.currentWidget!.sessionContext);
    const outputs: any[] = (cell.model as any).outputs?.toJSON?.() || [];
    const err = outputs.find((o: any) => o.output_type === 'error');
    if (!err) { setStatus('✓ Code ran successfully'); return; }
    if (attempt === MAX) { setStatus(`⚠ Still has errors after ${MAX} attempts`, true); return; }
    setStatus(`Error → fixing… (${attempt}/${MAX})`);
    const code = cell.model.sharedModel.getSource();
    const errText = `${err.ename}: ${err.evalue}\n${(err.traceback || []).join('\n').replace(/\x1b\[[0-9;]*m/g, '')}`;
    let fixed = await chatComplete(PROMPT_FIX, [{ role: 'user', content: `Code:\n\`\`\`python\n${code}\n\`\`\`\n\nError:\n${errText}` }], model, apiKey);
    fixed = fixed.replace(/^```(?:python)?\s*/m, '').replace(/\s*```$/m, '').trim();
    cell.model.sharedModel.setSource(fixed);
  }
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

  const whisperKey = localStorage.getItem('rb_key_openai') || localStorage.getItem('rb_openai_key') || '';
  let apiKey: string;
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
        if (voiceBox) voiceBox.value = voiceBox.value ? voiceBox.value + '\n' + text : text;
        setStatus('✓ Done. Edit if needed, then click a button below.');
      } catch (e: any) { setStatus('❌ ' + e.message, true); }
      btn.disabled = false;
    });
  } catch (e: any) {
    btn.textContent = '🎤 Record';
    btn.classList.remove('recording');
    setStatus('❌ ' + e.message, true);
  }
}

async function handleAction(mode: 'code' | 'polish'): Promise<void> {
  const voiceBox = document.getElementById('rb-voice-text') as HTMLTextAreaElement | null;
  const text = voiceBox?.value.trim() || '';
  if (!text) { setStatus('Please record or type something first.', true); return; }

  const btnId = mode === 'code' ? 'rb-code-btn' : 'rb-polish-btn';
  const actionBtn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (actionBtn) actionBtn.disabled = true;

  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); if (actionBtn) actionBtn.disabled = false; return; }

  try {
    setStatus('Generating…');
    const model = getModel();
    if (mode === 'code') {
      let code = await chatComplete(PROMPT_CODE, [{ role: 'user', content: text }], model, apiKey);
      code = code.replace(/^```(?:python)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const cell = insertCodeCell(code);
      saveInputHistory(text);
      if (voiceBox) voiceBox.value = '';
      if (cell) await runAndDebug(cell, apiKey, model);
      else setStatus('✓ Code inserted');
    } else {
      const bullets = await chatComplete(PROMPT_POLISH, [{ role: 'user', content: text }], model, apiKey);
      insertMarkdownCell(bullets);
      saveInputHistory(text);
      if (voiceBox) voiceBox.value = '';
      setStatus('✓ Notes inserted (two-column layout)');
    }
  } catch (e: any) { setStatus('❌ ' + e.message, true); }
  if (actionBtn) actionBtn.disabled = false;
}

async function handleFix(): Promise<void> {
  const nb = tracker.currentWidget?.content;
  if (!nb) { setStatus('No active notebook.', true); return; }
  const cell = nb.activeCell;
  if (!cell) { setStatus('No active cell.', true); return; }

  const code = cell.model.sharedModel.getSource();
  const outputs: any[] = (cell.model as any).outputs?.toJSON?.() || [];
  const errorOut = outputs.find((o: any) => o.output_type === 'error');
  if (!errorOut) { setStatus('No error found in active cell.', true); return; }

  const errorText = `${errorOut.ename}: ${errorOut.evalue}\n${(errorOut.traceback || []).join('\n').replace(/\x1b\[[0-9;]*m/g, '')}`;
  const prompt = `Code:\n\`\`\`python\n${code}\n\`\`\`\n\nError:\n${errorText}`;

  const btn = document.getElementById('rb-fix-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  let apiKey: string;
  try { apiKey = await getApiKey(); }
  catch (e: any) { setStatus('❌ ' + e.message, true); if (btn) btn.disabled = false; return; }

  try {
    setStatus('Fixing…');
    let fixed = await chatComplete(PROMPT_FIX, [{ role: 'user', content: prompt }], getModel(), apiKey);
    fixed = fixed.replace(/^```(?:python)?\s*/m, '').replace(/\s*```$/m, '').trim();
    insertCodeCell(fixed);
    setStatus('✓ Fixed code inserted below');
  } catch (e: any) { setStatus('❌ ' + e.message, true); }
  if (btn) btn.disabled = false;
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
      } catch (e: any) { setStatus('❌ ' + e.message, true); }
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
  (div as any).dataset.content = text;
  const bubble = document.createElement('div');
  bubble.className = 'rb-bubble ' + (role === 'user' ? 'user' : 'ai');
  bubble.textContent = text;
  div.appendChild(bubble);
  if (role !== 'user') {
    const actions = document.createElement('div');
    actions.className = 'rb-bubble-actions';
    actions.innerHTML = '<button onclick="rbLabInsertCode(this)">📝 Code</button><button onclick="rbLabInsertMd(this)">📄 Markdown</button>';
    div.appendChild(actions);
  }
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
  } catch (e: any) { setStatus('❌ ' + e.message, true); }
}

// ── Tab content ───────────────────────────────────────────────────────────────

function renderTabContent(tab: string): void {
  ['rb-action-area', 'rb-chat-area'].forEach(id => document.getElementById(id)?.remove());
  const statusEl = document.getElementById('rb-status')!;
  const body = document.getElementById('rb-body')!;

  if (tab === 'input') {
    const area = document.createElement('div');
    area.id = 'rb-action-area';
    area.innerHTML = `
      <div class="rb-row">
        <button id="rb-voice-btn" style="flex:1" onclick="rbLabVoiceRecord()">🎤 Record</button>
        <select id="rb-history-sel" class="rb-select" style="flex:1" onchange="rbLabHistoryPick(this.value)"><option value="">History…</option></select>
      </div>
      <textarea id="rb-voice-text" placeholder="Transcription result, or type directly…"></textarea>
      <div class="rb-btn-row">
        <button id="rb-code-btn"   onclick="rbLabAction('code')">Generate Code</button>
        <button id="rb-polish-btn" onclick="rbLabAction('polish')">Polish Notes</button>
      </div>
      <button id="rb-fix-btn" onclick="rbLabFix()">🔧 Fix Error in Active Cell</button>`;
    rebuildHistorySelect();
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
  ['input', 'chat'].forEach(t => {
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

// ── Sidebar Widget ────────────────────────────────────────────────────────────

class AIAssistantWidget extends Widget {
  constructor() {
    super();
    this.id = 'rb-assistant-panel';
    this.title.label = 'AI';
    this.title.caption = 'AI Assistant';
    this.title.icon = robotIcon;
    this.title.closable = true;
    this.addClass('rb-assistant-widget');

    this.node.innerHTML = `
      <div id="rb-body">
        <div id="rb-tabs">
          <button id="rb-tab-input" class="rb-tab active" onclick="rbLabTab('input')">Input</button>
          <button id="rb-tab-chat"  class="rb-tab"        onclick="rbLabTab('chat')">Chat</button>
        </div>
        <div class="rb-row" id="rb-agent-model-row">
          <select id="rb-agent-sel" class="rb-select rb-select-agent" onchange="rbLabSwitchAgent(this.value)">
            ${AGENT_IDS.map(id => `<option value="${id}">${AGENTS[id].label}</option>`).join('')}
          </select>
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
          <input id="rb-key-input" class="rb-input" type="password" placeholder="API Key (leave blank to use .env)" />
          <button class="rb-key-toggle" onclick="rbLabToggleKey()" title="Show/hide">👁</button>
          <button class="rb-key-toggle" onclick="rbLabSaveKey()" title="Save to ~/.env">💾</button>
        </div>
        <div id="rb-status"></div>
      </div>`;
  }

  protected onAfterAttach(): void {
    const agentSel = this.node.querySelector('#rb-agent-sel') as HTMLSelectElement;
    agentSel.value = currentAgent;

    rebuildModelSelect();
    const sel = this.node.querySelector('#rb-model-sel') as HTMLSelectElement;
    sel.onchange = () => localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);

    renderTabContent('input');
  }
}

// ── Expose to HTML onclick ────────────────────────────────────────────────────

(window as any).rbLabTab          = switchTab;
(window as any).rbLabFix          = handleFix;
(window as any).rbLabHistoryPick  = (val: string) => {
  if (!val) return;
  const ta = document.getElementById('rb-voice-text') as HTMLTextAreaElement | null;
  if (ta) { ta.value = val; ta.focus(); }
  const sel = document.getElementById('rb-history-sel') as HTMLSelectElement | null;
  if (sel) sel.value = '';
};
(window as any).rbLabSwitchAgent  = (id: string) => switchAgent(id as AgentId);
(window as any).rbLabVoiceRecord  = handleVoiceRecord;
(window as any).rbLabAction       = (mode: string) => handleAction(mode as 'code' | 'polish');
(window as any).rbLabChatVoice    = handleChatVoice;
(window as any).rbLabChatSend     = () => sendChat((document.getElementById('rb-chat-input') as HTMLTextAreaElement | null)?.value || '');
(window as any).rbLabInsertCode   = (btn: HTMLElement) => {
  const text = ((btn.closest('.rb-msg') as HTMLElement)?.dataset as any)?.content || '';
  if (text) insertCodeCell(text);
};
(window as any).rbLabInsertMd     = (btn: HTMLElement) => {
  const text = ((btn.closest('.rb-msg') as HTMLElement)?.dataset as any)?.content || '';
  if (text) insertMarkdownCell(text);
};
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
  description: 'AI voice assistant sidebar panel',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, nbTracker: INotebookTracker) => {
    tracker = nbTracker;
    const widget = new AIAssistantWidget();
    app.shell.add(widget, 'left', { rank: 500 });
  }
};

export default plugin;
