define(['base/js/namespace', 'base/js/events'], function (Jupyter, events) {

  const MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini', 'o4-mini', 'o3'];

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

  let chatHistory = [];
  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;
  let currentTab = 'code'; // 'code' | 'polish' | 'chat'

  // ── API Key ──────────────────────────────────────────────────────────────────

  function getApiKey() {
    // 1. Input field in panel
    const inputEl = document.getElementById('rb-key-input');
    if (inputEl && inputEl.value.trim()) return Promise.resolve(inputEl.value.trim());

    // 2. localStorage cache
    const cached = localStorage.getItem('rb_openai_key');
    if (cached) return Promise.resolve(cached);

    // 3. Kernel: env var + ~/.env + notebook-dir .env
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
      setTimeout(() => { if (!done) reject(new Error('未找到 API Key，请在面板中填入')); }, 5000);
    });
  }

  function saveApiKey() {
    const inp = document.getElementById('rb-key-input');
    if (!inp || !inp.value.trim()) { setStatus('请先填入 API Key', true); return; }
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
        if ((msg.content.text || '').trim() === 'saved') setStatus('✓ API Key 已保存到 ~/.env');
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
        temperature: 0.2,
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
    // Wrap in 2-column HTML layout to reduce vertical space
    const escaped = bullets
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    catch(e) { throw new Error('麦克风权限被拒绝'); }
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

  function getModel() {
    const el = document.getElementById('rb-model-sel');
    return el ? el.value : 'gpt-4.1-mini';
  }

  // ── Tab: Code / Polish ───────────────────────────────────────────────────────

  async function handleVoiceAction() {
    if (isRecording) { stopRecording(); return; }

    const btn = document.getElementById('rb-voice-btn');
    let apiKey;
    try { apiKey = await getApiKey(); }
    catch(e) { setStatus('❌ ' + e.message, true); return; }

    const model = getModel();
    btn.textContent = '⏹ 停止';
    btn.classList.add('recording');
    setStatus('录音中… 说完后点停止');

    try {
      await startRecording(async (blob, ext) => {
        btn.textContent = currentTab === 'code' ? '🎤 生成代码' : '🎤 整理笔记';
        btn.classList.remove('recording');
        btn.disabled = true;

        try {
          setStatus('语音识别中…');
          const text = await transcribe(blob, ext, apiKey);
          if (!text) throw new Error('未识别到语音');
          setStatus(`"${text.slice(0,36)}${text.length>36?'…':''}" → 生成中…`);

          if (currentTab === 'code') {
            let code = await chatComplete(PROMPT_CODE, [{role:'user', content:text}], model, apiKey);
            code = code.replace(/^```(?:python)?\s*/m,'').replace(/\s*```$/m,'').trim();
            insertCodeCell(code);
            setStatus('✓ 代码已插入到选中 cell 下方');
          } else {
            const bullets = await chatComplete(PROMPT_POLISH, [{role:'user', content:text}], model, apiKey);
            insertMarkdownCell(bullets);
            setStatus('✓ 笔记已插入到选中 cell 下方（双列）');
          }
        } catch(e) {
          setStatus('❌ ' + e.message, true);
        }
        btn.disabled = false;
      });
    } catch(e) {
      btn.textContent = currentTab === 'code' ? '🎤 生成代码' : '🎤 整理笔记';
      btn.classList.remove('recording');
      setStatus('❌ ' + e.message, true);
    }
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
    setStatus('AI 回复中…');

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
    setStatus('录音中…');

    try {
      await startRecording(async (blob, ext) => {
        chatVoiceRecording = false;
        btn.classList.remove('recording');
        try {
          setStatus('语音识别中…');
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

    // Keep model row and key row, rebuild the rest
    const modelRow = document.getElementById('rb-model-row');
    const keyRow   = document.getElementById('rb-key-row');
    const statusEl = document.getElementById('rb-status');
    const existing = { modelRow, keyRow, statusEl };

    // Remove dynamic content
    ['rb-action-area', 'rb-chat-area'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });

    if (tab === 'code' || tab === 'polish') {
      const area = document.createElement('div');
      area.id = 'rb-action-area';
      const label = tab === 'code' ? '🎤 生成代码' : '🎤 整理笔记';
      area.innerHTML = `<button id="rb-voice-btn" onclick="rbVoiceAction()">${label}</button>`;
      body.insertBefore(area, statusEl);
    } else {
      const area = document.createElement('div');
      area.id = 'rb-chat-area';
      area.innerHTML = `
        <div id="rb-chat-messages"></div>
        <div id="rb-chat-row">
          <textarea id="rb-chat-input" placeholder="输入消息…" rows="1"></textarea>
          <button id="rb-chat-voice" title="语音输入" onclick="rbChatVoice()">🎤</button>
          <button id="rb-chat-send" onclick="rbChatSend()">↑</button>
        </div>`;
      body.insertBefore(area, statusEl);

      // Restore history
      chatHistory.forEach(m => appendChatBubble(m.role, m.content));

      const input = document.getElementById('rb-chat-input');
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(input.value); }
      });
    }
  }

  function switchTab(tab) {
    currentTab = tab;
    ['code','polish','chat'].forEach(t => {
      const btn = document.getElementById('rb-tab-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    renderTabContent(tab);
    setStatus('');
  }

  // ── Build panel DOM ──────────────────────────────────────────────────────────

  function buildPanel() {
    if (document.getElementById('rb-panel')) return;

    // Toggle button
    const toggle = document.createElement('button');
    toggle.id = 'rb-toggle';
    toggle.title = 'AI Assistant';
    toggle.innerHTML = '🤖';
    toggle.onclick = () => {
      document.getElementById('rb-panel').classList.remove('rb-hidden');
      toggle.style.display = 'none';
    };
    document.body.appendChild(toggle);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'rb-panel';
    panel.innerHTML = `
      <div id="rb-header">
        <span>🤖 AI Assistant</span>
        <button id="rb-close" title="关闭">✕</button>
      </div>
      <div id="rb-body">
        <div id="rb-tabs">
          <button id="rb-tab-code"   class="rb-tab active" onclick="rbTab('code')">生成代码</button>
          <button id="rb-tab-polish" class="rb-tab"        onclick="rbTab('polish')">整理笔记</button>
          <button id="rb-tab-chat"   class="rb-tab"        onclick="rbTab('chat')">讨论</button>
        </div>
        <div class="rb-row" id="rb-model-row">
          <select id="rb-model-sel" class="rb-select">
            ${MODELS.map(m => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div class="rb-row" id="rb-key-row">
          <input id="rb-key-input" class="rb-input" type="password" placeholder="API Key（留空则读 .env / 环境变量）" />
          <button class="rb-key-toggle" onclick="rbToggleKey()" title="显示/隐藏">👁</button>
          <button class="rb-key-toggle" onclick="rbSaveKey()" title="保存到 ~/.env">💾</button>
        </div>
        <div id="rb-status"></div>
      </div>`;
    document.body.appendChild(panel);

    // Restore saved model
    const sel = document.getElementById('rb-model-sel');
    sel.value = localStorage.getItem('rb_model') || 'gpt-4.1-mini';
    sel.onchange = () => localStorage.setItem('rb_model', sel.value);

    // Close button
    document.getElementById('rb-close').onclick = () => {
      panel.classList.add('rb-hidden');
      toggle.style.display = 'flex';
    };

    // Drag
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

    // Initial tab content
    renderTabContent('code');
  }

  // ── Global functions called from HTML onclick ─────────────────────────────────

  window.rbTab         = switchTab;
  window.rbVoiceAction = handleVoiceAction;
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
