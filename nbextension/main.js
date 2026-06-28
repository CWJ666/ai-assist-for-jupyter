define(['base/js/namespace', 'base/js/events'], function (Jupyter, events) {

  const MODELS = ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5-mini', 'gpt-5.4-thinking', 'gpt-5.2-codex'];

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

  // ── State ────────────────────────────────────────────────────────────────────

  let chatHistory = [];
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let currentTab = 'code';

  // ── API Key ──────────────────────────────────────────────────────────────────

  function getApiKey() {
    const inputEl = document.getElementById('rb-key-input');
    if (inputEl && inputEl.value.trim()) return Promise.resolve(inputEl.value.trim());

    const cached = localStorage.getItem('rb_openai_key');
    if (cached) return Promise.resolve(cached);

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
      Jupyter.notebook.kernel.execute(code, {
        iopub: { output: function(msg) {
          if (done) return;
          const text = (msg.content.text || '').trim();
          if (text) { done = true; localStorage.setItem('rb_openai_key', text); resolve(text); }
        }}
      }, { silent: false });
      setTimeout(() => { if (!done) reject(new Error('API Key not found. Please enter it in the panel.')); }, 5000);
    });
  }

  function saveApiKey() {
    const inp = document.getElementById('rb-key-input');
    if (!inp || !inp.value.trim()) { setStatus('Please enter your API Key first.', true); return; }
    const key = inp.value.trim();
    localStorage.setItem('rb_openai_key', key);
    const code = [
      "from pathlib import Path",
      "_p = Path.home() / '.env'",
      "_lines = [l for l in (_p.read_text().splitlines() if _p.exists() else []) if not l.startswith('OPENAI_API_KEY=')]",
      `_lines.append('OPENAI_API_KEY=${key}')`,
      "_p.write_text('\\n'.join(_lines) + '\\n')",
      "print('saved')",
    ].join('\n');
    Jupyter.notebook.kernel.execute(code, {
      iopub: { output: function(msg) {
        if ((msg.content.text || '').trim() === 'saved') setStatus('✓ API Key saved to ~/.env');
      }}
    }, { silent: false });
  }

  // ── OpenAI calls ─────────────────────────────────────────────────────────────

  async function transcribe(blob, ext, apiKey) {
    const fd = new FormData();
    fd.append('file', blob, `rec.${ext}`);
    fd.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      body: fd,
    });
    if (!r.ok) throw new Error('Whisper: ' + await r.text());
    return (await r.json()).text || '';
  }

  async function chatComplete(systemPrompt, messages, model, apiKey) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    });
    if (!r.ok) throw new Error('OpenAI: ' + await r.text());
    return (await r.json()).choices[0].message.content.trim();
  }

  // ── Jupyter cell insertion ───────────────────────────────────────────────────

  function insertCodeCell(code) {
    const idx = Jupyter.notebook.get_selected_index();
    const cell = Jupyter.notebook.insert_cell_below('code', idx);
    cell.set_text(code);
    cell.focus_cell();
  }

  function insertMarkdownCell(bullets) {
    const html = `<div style="columns:2;column-gap:24px;font-size:14px;line-height:1.7;">\n\n${bullets}\n\n</div>`;
    const idx = Jupyter.notebook.get_selected_index();
    const cell = Jupyter.notebook.insert_cell_below('markdown', idx);
    cell.set_text(html);
    cell.render();
    Jupyter.notebook.select(idx + 1);
  }

  // ── Recording ────────────────────────────────────────────────────────────────

  async function startRecording(onStop) {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch(e) { throw new Error('Microphone access denied'); }
    const mime = ['audio/webm','audio/mp4','audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: mime || 'audio/webm' });
      const ext  = (mime.split('/')[1] || 'webm').split(';')[0];
      await onStop(blob, ext);
    };
    mediaRecorder.start();
    isRecording = true;
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      isRecording = false;
    }
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────

  function setStatus(text, isError) {
    const el = document.getElementById('rb-status');
    if (!el) return;
    el.textContent = text;
    el.className = isError ? 'error' : '';
  }

  function modelKey(tab) { return 'rb_model_' + tab; }

  function getModel() {
    const el = document.getElementById('rb-model-sel');
    return el ? el.value : MODELS[0];
  }

  // ── Tab: Code / Polish ───────────────────────────────────────────────────────

  async function handleVoiceRecord() {
    if (isRecording) { stopRecording(); return; }

    const btn = document.getElementById('rb-voice-btn');
    let apiKey;
    try { apiKey = await getApiKey(); }
    catch(e) { setStatus('❌ ' + e.message, true); return; }

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
          const voiceBox = document.getElementById('rb-voice-text');
          if (voiceBox) voiceBox.value = text;
          setStatus('✓ Done. Edit if needed, then click the button below.');
        } catch(e) {
          setStatus('❌ ' + e.message, true);
        }
        btn.disabled = false;
      });
    } catch(e) {
      btn.textContent = '🎤 Record';
      btn.classList.remove('recording');
      setStatus('❌ ' + e.message, true);
    }
  }

  async function handleAction() {
    const voiceBox = document.getElementById('rb-voice-text');
    const text = voiceBox ? voiceBox.value.trim() : '';
    if (!text) { setStatus('Please record or type something first.', true); return; }

    const actionBtn = document.getElementById('rb-action-btn');
    if (actionBtn) actionBtn.disabled = true;

    let apiKey;
    try { apiKey = await getApiKey(); }
    catch(e) { setStatus('❌ ' + e.message, true); if (actionBtn) actionBtn.disabled = false; return; }

    try {
      setStatus('Generating…');
      const model = getModel();
      if (currentTab === 'code') {
        let code = await chatComplete(PROMPT_CODE, [{role:'user', content:text}], model, apiKey);
        code = code.replace(/^```(?:python)?\s*/m,'').replace(/\s*```$/m,'').trim();
        insertCodeCell(code);
        setStatus('✓ Code inserted below active cell');
      } else {
        const bullets = await chatComplete(PROMPT_POLISH, [{role:'user', content:text}], model, apiKey);
        insertMarkdownCell(bullets);
        setStatus('✓ Notes inserted (two-column layout)');
      }
    } catch(e) {
      setStatus('❌ ' + e.message, true);
    }
    if (actionBtn) actionBtn.disabled = false;
  }

  // ── Tab: Chat ────────────────────────────────────────────────────────────────

  function appendChatBubble(role, text) {
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

  async function sendChat(text) {
    if (!text.trim()) return;
    appendChatBubble('user', text);
    chatHistory.push({ role: 'user', content: text });

    const input = document.getElementById('rb-chat-input');
    if (input) input.value = '';
    setStatus('Thinking…');

    let apiKey;
    try { apiKey = await getApiKey(); }
    catch(e) { setStatus('❌ ' + e.message, true); return; }

    try {
      const reply = await chatComplete(PROMPT_CHAT, chatHistory, getModel(), apiKey);
      chatHistory.push({ role: 'assistant', content: reply });
      appendChatBubble('assistant', reply);
      setStatus('');
    } catch(e) {
      setStatus('❌ ' + e.message, true);
    }
  }

  let chatVoiceRecording = false;

  async function handleChatVoice() {
    const btn = document.getElementById('rb-chat-voice');
    if (chatVoiceRecording) { stopRecording(); return; }

    let apiKey;
    try { apiKey = await getApiKey(); }
    catch(e) { setStatus('❌ ' + e.message, true); return; }

    btn.classList.add('recording');
    chatVoiceRecording = true;
    setStatus('Recording…');

    try {
      await startRecording(async (blob, ext) => {
        chatVoiceRecording = false;
        btn.classList.remove('recording');
        try {
          setStatus('Transcribing…');
          const text = await transcribe(blob, ext, apiKey);
          if (text) await sendChat(text);
        } catch(e) {
          setStatus('❌ ' + e.message, true);
        }
      });
    } catch(e) {
      chatVoiceRecording = false;
      btn.classList.remove('recording');
      setStatus('❌ ' + e.message, true);
    }
  }

  // ── Panel rendering ──────────────────────────────────────────────────────────

  function renderTabContent(tab) {
    const body = document.getElementById('rb-body');
    if (!body) return;

    const statusEl = document.getElementById('rb-status');
    ['rb-action-area', 'rb-chat-area'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    if (tab === 'code' || tab === 'polish') {
      const area = document.createElement('div');
      area.id = 'rb-action-area';
      const actionLabel = tab === 'code' ? 'Generate Code' : 'Polish Notes';
      area.innerHTML = `
        <button id="rb-voice-btn" onclick="rbVoiceRecord()">🎤 Record</button>
        <textarea id="rb-voice-text" placeholder="Transcription result, or type directly…"></textarea>
        <button id="rb-action-btn" onclick="rbAction()">${actionLabel}</button>`;
      body.insertBefore(area, statusEl);
    } else {
      const area = document.createElement('div');
      area.id = 'rb-chat-area';
      area.innerHTML = `
        <div id="rb-chat-messages"></div>
        <div id="rb-chat-row">
          <textarea id="rb-chat-input" placeholder="Type a message…" rows="1"></textarea>
          <button id="rb-chat-voice" title="Voice input" onclick="rbChatVoice()">🎤</button>
          <button id="rb-chat-send" onclick="rbChatSend()">↑</button>
        </div>`;
      body.insertBefore(area, statusEl);

      chatHistory.forEach(m => appendChatBubble(m.role, m.content));

      const input = document.getElementById('rb-chat-input');
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value); }
      });
    }
  }

  function switchTab(tab) {
    const sel = document.getElementById('rb-model-sel');
    if (sel) localStorage.setItem(modelKey(currentTab), sel.value);

    currentTab = tab;
    ['code','polish','chat'].forEach(t => {
      const btn = document.getElementById('rb-tab-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    renderTabContent(tab);
    setStatus('');

    if (sel) sel.value = localStorage.getItem(modelKey(tab)) || MODELS[0];
  }

  // ── Build panel DOM ──────────────────────────────────────────────────────────

  function buildPanel() {
    if (document.getElementById('rb-panel')) return;

    const toggle = document.createElement('button');
    toggle.id = 'rb-toggle';
    toggle.title = 'AI Assistant';
    toggle.innerHTML = '🤖';
    toggle.onclick = () => {
      document.getElementById('rb-panel').classList.remove('rb-hidden');
      toggle.style.display = 'none';
    };
    document.body.appendChild(toggle);

    const panel = document.createElement('div');
    panel.id = 'rb-panel';
    panel.innerHTML = `
      <div id="rb-header">
        <span>🤖 AI Assistant</span>
        <button id="rb-close" title="Close">✕</button>
      </div>
      <div id="rb-body">
        <div id="rb-tabs">
          <button id="rb-tab-code"   class="rb-tab active" onclick="rbTab('code')">Code</button>
          <button id="rb-tab-polish" class="rb-tab"        onclick="rbTab('polish')">Polish</button>
          <button id="rb-tab-chat"   class="rb-tab"        onclick="rbTab('chat')">Chat</button>
        </div>
        <div class="rb-row" id="rb-model-row">
          <select id="rb-model-sel" class="rb-select">
            ${MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div class="rb-row" id="rb-key-row">
          <input id="rb-key-input" class="rb-input" type="password" placeholder="API Key (leave blank to use .env or env var)" />
          <button class="rb-key-toggle" onclick="rbToggleKey()" title="Show/hide">👁</button>
          <button class="rb-key-toggle" onclick="rbSaveKey()" title="Save to ~/.env">💾</button>
        </div>
        <div id="rb-status"></div>
      </div>`;
    document.body.appendChild(panel);

    const sel = document.getElementById('rb-model-sel');
    sel.value = localStorage.getItem(modelKey('code')) || MODELS[0];
    sel.onchange = () => localStorage.setItem(modelKey(currentTab), sel.value);

    document.getElementById('rb-close').onclick = () => {
      panel.classList.add('rb-hidden');
      toggle.style.display = 'flex';
    };

    let dragging = false, ox = 0, oy = 0;
    document.getElementById('rb-header').addEventListener('mousedown', e => {
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left   = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + 'px';
      panel.style.top    = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    renderTabContent('code');
  }

  // ── Global functions called from HTML onclick ─────────────────────────────────

  window.rbTab         = switchTab;
  window.rbVoiceRecord = handleVoiceRecord;
  window.rbAction      = handleAction;
  window.rbChatVoice   = handleChatVoice;
  window.rbChatSend    = () => sendChat(document.getElementById('rb-chat-input')?.value || '');
  window.rbSaveKey     = saveApiKey;
  window.rbToggleKey   = () => {
    const inp = document.getElementById('rb-key-input');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  // ── Extension entry point ────────────────────────────────────────────────────

  function load_ipython_extension() {
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = require.toUrl('./main.css');
    document.head.appendChild(link);

    if (Jupyter.notebook) {
      buildPanel();
    } else {
      events.on('notebook_loaded.Notebook', buildPanel);
    }
  }

  return { load_ipython_extension };
});
