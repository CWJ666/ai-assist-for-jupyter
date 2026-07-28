// AI Assistant nbextension for classic Jupyter Notebook
define(['base/js/namespace'], function (Jupyter) {
  'use strict';

  // ── Agent config ─────────────────────────────────────────────────────────────

  var AGENTS = {
    openai: {
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      format: 'openai',
      envKey: 'OPENAI_API_KEY',
      storageKey: 'rb_key_openai',
      defaultModels: ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5-mini', 'gpt-5.4-thinking', 'gpt-5.2-codex'],
    },
    anthropic: {
      label: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      format: 'anthropic',
      envKey: 'ANTHROPIC_API_KEY',
      storageKey: 'rb_key_anthropic',
      defaultModels: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    },
    google: {
      label: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      format: 'openai',
      envKey: 'GOOGLE_API_KEY',
      storageKey: 'rb_key_google',
      defaultModels: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
    },
  };

  // ── Prompts ──────────────────────────────────────────────────────────────────

  var PROMPT_CODE = [
    'You are a Python data analysis assistant in a Jupyter notebook.',
    'Generate clean, runnable Python code for the user\'s request.',
    '- Use pandas, numpy, matplotlib, seaborn as needed',
    '- Assume relevant variables (e.g. df) are already defined in the kernel',
    '- Return ONLY the Python code — no explanation, no markdown fences',
    '- Use plt.show() at the end if creating a chart',
  ].join('\n');

  var PROMPT_POLISH = [
    'You are a professional note organizer for data analysis sessions.',
    'Rewrite the user\'s raw notes as concise, well-organized bullet points.',
    'Rules:',
    '- Use clear hierarchy: main points with sub-points where helpful (• and  –)',
    '- Remove redundancy but preserve every key insight',
    '- Do not add information not present in the original notes',
    '- Return only the organized bullet points, no preamble',
  ].join('\n');

  var PROMPT_CHAT = [
    'You are a helpful data analysis assistant embedded in a Jupyter notebook.',
    'Help the user understand their data, answer questions, suggest next steps, and explain methods.',
    'Be concise and practical.',
  ].join('\n');

  // ── State ────────────────────────────────────────────────────────────────────

  var chatHistory = [];
  var mediaRecorder = null;
  var audioChunks = [];
  var isRecording = false;
  var currentTab = 'input';
  var currentAgent = localStorage.getItem('rb_agent') || 'openai';

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function agentCfg() { return AGENTS[currentAgent]; }

  function modelListKey(agentId) { return 'rb_models_' + agentId; }
  function modelSelKey(agentId, tab) { return 'rb_model_' + agentId + '_' + tab; }

  function getModelList(agentId) {
    var id = agentId || currentAgent;
    var saved = localStorage.getItem(modelListKey(id));
    if (saved) {
      var list = saved.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (list.length) return list;
    }
    return AGENTS[id].defaultModels.slice();
  }

  function rebuildModelSelect(keepValue) {
    var sel = document.getElementById('rb-model-sel');
    if (!sel) return;
    var models = getModelList();
    sel.innerHTML = models.map(function (m) { return '<option value="' + m + '">' + m + '</option>'; }).join('');
    var saved = keepValue || localStorage.getItem(modelSelKey(currentAgent, currentTab)) || models[0];
    sel.value = models.indexOf(saved) >= 0 ? saved : models[0];
  }

  function getModel() {
    var sel = document.getElementById('rb-model-sel');
    return sel ? sel.value : agentCfg().defaultModels[0];
  }

  function setStatus(text, isError) {
    var el = document.getElementById('rb-status');
    if (!el) return;
    el.textContent = text;
    el.className = isError ? 'error' : '';
  }

  // ── Agent switching ──────────────────────────────────────────────────────────

  window.rbSwitchAgent = function (agentId) {
    var sel = document.getElementById('rb-model-sel');
    if (sel) localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);

    currentAgent = agentId;
    localStorage.setItem('rb_agent', agentId);

    rebuildModelSelect();

    var agentSel = document.getElementById('rb-agent-sel');
    if (agentSel) agentSel.value = agentId;

    var prefsEl = document.getElementById('rb-prefs');
    if (prefsEl && !prefsEl.classList.contains('rb-hidden')) {
      var ta = document.getElementById('rb-models-input');
      if (ta) ta.value = getModelList().join('\n');
    }

    setStatus('');
  };

  // ── Preferences ──────────────────────────────────────────────────────────────

  window.rbTogglePrefs = function () {
    var prefs = document.getElementById('rb-prefs');
    if (!prefs) return;
    var nowHidden = prefs.classList.toggle('rb-hidden');
    if (!nowHidden) {
      var ta = document.getElementById('rb-models-input');
      if (ta) ta.value = getModelList().join('\n');
    }
  };

  window.rbSavePrefs = function () {
    var ta = document.getElementById('rb-models-input');
    if (!ta) return;
    var models = ta.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!models.length) return;
    localStorage.setItem(modelListKey(currentAgent), models.join('\n'));
    var current = (document.getElementById('rb-model-sel') || {}).value;
    rebuildModelSelect(current);
    var prefs = document.getElementById('rb-prefs');
    if (prefs) prefs.classList.add('rb-hidden');
  };

  window.rbResetPrefs = function () {
    localStorage.removeItem(modelListKey(currentAgent));
    var ta = document.getElementById('rb-models-input');
    if (ta) ta.value = getModelList().join('\n');
  };

  // ── API Key ──────────────────────────────────────────────────────────────────

  function getApiKey() {
    return new Promise(function (resolve, reject) {
      var inp = document.getElementById('rb-key-input');
      if (inp && inp.value.trim()) { resolve(inp.value.trim()); return; }

      var cfg = agentCfg();
      var cached = localStorage.getItem(cfg.storageKey)
        || (currentAgent === 'openai' ? localStorage.getItem('rb_openai_key') : null);
      if (cached) { resolve(cached); return; }

      var kernel = Jupyter.notebook && Jupyter.notebook.kernel;
      if (!kernel) { reject(new Error('No active kernel')); return; }

      var envVar = cfg.envKey;
      var code = [
        "import os; from pathlib import Path",
        "_k = os.environ.get('" + envVar + "', '')",
        "if not _k:",
        "    for _p in [Path.home()/'.env', Path('.env')]:",
        "        try:",
        "            for _l in _p.read_text().splitlines():",
        "                if _l.startswith('" + envVar + "='):",
        "                    _k = _l.split('=',1)[1].strip().strip('\"').strip(\"'\")",
        "                    break",
        "        except: pass",
        "        if _k: break",
        "print(_k, end='')",
      ].join('\n');

      var done = false;
      kernel.execute(code, {
        iopub: {
          output: function (msg) {
            if (done) return;
            var text = ((msg.content || {}).text || '').trim();
            if (text) {
              done = true;
              localStorage.setItem(cfg.storageKey, text);
              resolve(text);
            }
          },
        },
        reply: function () {
          if (!done) reject(new Error(cfg.label + ' API Key not found. Please enter it in the panel.'));
        },
      }, { silent: false, store_history: false });

      setTimeout(function () {
        if (!done) reject(new Error(cfg.label + ' API Key not found. Please enter it in the panel.'));
      }, 5000);
    });
  }

  window.rbSaveKey = function () {
    var inp = document.getElementById('rb-key-input');
    if (!inp || !inp.value.trim()) { setStatus('Please enter your API Key first.', true); return; }
    var key = inp.value.trim();
    var cfg = agentCfg();
    localStorage.setItem(cfg.storageKey, key);

    var kernel = Jupyter.notebook && Jupyter.notebook.kernel;
    if (!kernel) { setStatus('✓ Saved to browser (no active kernel)'); return; }

    var envVar = cfg.envKey;
    var code = [
      "from pathlib import Path",
      "_p = Path.home() / '.env'",
      "_lines = [l for l in (_p.read_text().splitlines() if _p.exists() else []) if not l.startswith('" + envVar + "=')]",
      "_lines.append('" + envVar + "=" + key + "')",
      "_p.write_text('\\n'.join(_lines) + '\\n')",
      "print('saved', end='')",
    ].join('\n');

    kernel.execute(code, {
      iopub: {
        output: function (msg) {
          if (((msg.content || {}).text || '').trim() === 'saved') setStatus('✓ ' + envVar + ' saved to ~/.env');
        },
      },
    }, { silent: false, store_history: false });
  };

  window.rbToggleKey = function () {
    var inp = document.getElementById('rb-key-input');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  };

  // ── API calls ────────────────────────────────────────────────────────────────

  function transcribe(blob, ext, apiKey) {
    var fd = new FormData();
    fd.append('file', blob, 'rec.' + ext);
    fd.append('model', 'whisper-1');
    return fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      body: fd,
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Whisper: ' + t); });
      return r.json().then(function (d) { return d.text || ''; });
    });
  }

  function chatComplete(systemPrompt, messages, model, apiKey) {
    var cfg = agentCfg();

    if (cfg.format === 'anthropic') {
      return fetch(cfg.baseUrl + '/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: model, max_tokens: 4096, system: systemPrompt, messages: messages }),
      }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error('Anthropic: ' + t); });
        return r.json().then(function (d) { return d.content[0].text.trim(); });
      });
    }

    // Codex models use /v1/responses endpoint
    if (currentAgent === 'openai' && model.indexOf('codex') !== -1) {
      return fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, instructions: systemPrompt, input: messages }),
      }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(cfg.label + ': ' + t); });
        return r.json().then(function (d) {
          var msg = (d.output || []).find(function (o) { return o.type === 'message'; });
          return ((msg && msg.content || []).find(function (c) { return c.type === 'output_text'; }) || {}).text || '';
        });
      });
    }

    // OpenAI-compatible (OpenAI + Google Gemini)
    return fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'system', content: systemPrompt }].concat(messages),
      }),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(cfg.label + ': ' + t); });
      return r.json().then(function (d) { return d.choices[0].message.content.trim(); });
    });
  }

  // ── Cell insertion ───────────────────────────────────────────────────────────

  function insertCodeCell(code) {
    Jupyter.notebook.insert_cell_below('code').set_text(code);
  }

  function insertMarkdownCell(bullets) {
    var html = '<div style="columns:2;column-gap:24px;font-size:14px;line-height:1.7;">\n\n' + bullets + '\n\n</div>';
    var cell = Jupyter.notebook.insert_cell_below('markdown');
    cell.set_text(html);
    cell.render();
  }

  // ── Recording ────────────────────────────────────────────────────────────────

  function startRecording(onStop) {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(function (t) {
        return MediaRecorder.isTypeSupported(t);
      }) || '';
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      mediaRecorder.ondataavailable = function (e) { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(audioChunks, { type: mime || 'audio/webm' });
        var ext  = (mime.split('/')[1] || 'webm').split(';')[0];
        onStop(blob, ext);
      };
      mediaRecorder.start();
      isRecording = true;
    });
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      isRecording = false;
    }
  }

  // ── Voice handlers ───────────────────────────────────────────────────────────

  window.rbVoiceRecord = function () {
    if (isRecording) { stopRecording(); return; }

    var whisperKey = localStorage.getItem('rb_key_openai') || localStorage.getItem('rb_openai_key') || '';
    var getKey = whisperKey ? Promise.resolve(whisperKey) : getApiKey();

    var btn = document.getElementById('rb-voice-btn');
    if (!btn) return;
    btn.textContent = '⏹ Stop';
    btn.classList.add('recording');
    setStatus('Recording… click Stop when done');

    getKey.then(function (apiKey) {
      return startRecording(function (blob, ext) {
        if (btn) { btn.textContent = '🎤 Record'; btn.classList.remove('recording'); btn.disabled = true; }
        setStatus('Transcribing…');
        transcribe(blob, ext, apiKey).then(function (text) {
          if (!text) throw new Error('No speech detected');
          var voiceBox = document.getElementById('rb-voice-text');
          if (voiceBox) voiceBox.value = voiceBox.value ? voiceBox.value + '\n' + text : text;
          setStatus('✓ Done. Edit if needed, then click the button below.');
        }).catch(function (e) {
          setStatus('❌ ' + e.message, true);
        }).then(function () {
          if (btn) btn.disabled = false;
        });
      });
    }).catch(function (e) {
      if (btn) { btn.textContent = '🎤 Record'; btn.classList.remove('recording'); }
      setStatus('❌ ' + e.message, true);
    });
  };

  window.rbAction = function (mode) {
    var voiceBox = document.getElementById('rb-voice-text');
    var text = voiceBox ? voiceBox.value.trim() : '';
    if (!text) { setStatus('Please record or type something first.', true); return; }

    var btnId = mode === 'code' ? 'rb-code-btn' : 'rb-polish-btn';
    var actionBtn = document.getElementById(btnId);
    if (actionBtn) actionBtn.disabled = true;

    getApiKey().then(function (apiKey) {
      setStatus('Generating…');
      var model = getModel();
      if (mode === 'code') {
        return chatComplete(PROMPT_CODE, [{ role: 'user', content: text }], model, apiKey).then(function (code) {
          code = code.replace(/^```(?:python)?\s*/m, '').replace(/\s*```$/m, '').trim();
          insertCodeCell(code);
          if (voiceBox) voiceBox.value = '';
          setStatus('✓ Code inserted below active cell');
        });
      } else {
        return chatComplete(PROMPT_POLISH, [{ role: 'user', content: text }], model, apiKey).then(function (bullets) {
          insertMarkdownCell(bullets);
          if (voiceBox) voiceBox.value = '';
          setStatus('✓ Notes inserted (two-column layout)');
        });
      }
    }).catch(function (e) {
      setStatus('❌ ' + e.message, true);
    }).then(function () {
      if (actionBtn) actionBtn.disabled = false;
    });
  };

  // ── Chat ─────────────────────────────────────────────────────────────────────

  function appendBubble(role, text) {
    var el = document.getElementById('rb-chat-messages');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'rb-msg';
    var bubble = document.createElement('div');
    bubble.className = 'rb-bubble ' + (role === 'user' ? 'user' : 'ai');
    bubble.textContent = text;
    div.appendChild(bubble);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function sendChat(text) {
    if (!text.trim()) return;
    appendBubble('user', text);
    chatHistory.push({ role: 'user', content: text });
    var input = document.getElementById('rb-chat-input');
    if (input) input.value = '';
    setStatus('Thinking…');

    getApiKey().then(function (apiKey) {
      return chatComplete(PROMPT_CHAT, chatHistory, getModel(), apiKey).then(function (reply) {
        chatHistory.push({ role: 'assistant', content: reply });
        appendBubble('assistant', reply);
        setStatus('');
      });
    }).catch(function (e) {
      setStatus('❌ ' + e.message, true);
    });
  }

  window.rbChatSend = function () {
    var input = document.getElementById('rb-chat-input');
    sendChat(input ? input.value : '');
  };

  window.rbChatVoice = function () {
    var btn = document.getElementById('rb-chat-voice');
    if (!btn) return;
    if (isRecording) { stopRecording(); return; }

    var whisperKey = localStorage.getItem('rb_key_openai') || localStorage.getItem('rb_openai_key') || '';
    var getKey = whisperKey ? Promise.resolve(whisperKey) : getApiKey();

    btn.classList.add('recording');
    setStatus('Recording…');

    getKey.then(function (apiKey) {
      return startRecording(function (blob, ext) {
        if (btn) btn.classList.remove('recording');
        setStatus('Transcribing…');
        transcribe(blob, ext, apiKey).then(function (text) {
          if (text) sendChat(text);
        }).catch(function (e) {
          setStatus('❌ ' + e.message, true);
        });
      });
    }).catch(function (e) {
      if (btn) btn.classList.remove('recording');
      setStatus('❌ ' + e.message, true);
    });
  };

  // ── Tab ──────────────────────────────────────────────────────────────────────

  function renderTabContent(tab) {
    ['rb-action-area', 'rb-chat-area'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.remove();
    });
    var statusEl = document.getElementById('rb-status');
    var body = document.getElementById('rb-body');
    if (!statusEl || !body) return;

    if (tab === 'input') {
      var area = document.createElement('div');
      area.id = 'rb-action-area';
      area.innerHTML = [
        '<button id="rb-voice-btn" onclick="rbVoiceRecord()">🎤 Record</button>',
        '<textarea id="rb-voice-text" placeholder="Transcription result, or type directly…"></textarea>',
        '<div class="rb-btn-row">',
        '  <button id="rb-code-btn"   onclick="rbAction(\'code\')">Generate Code</button>',
        '  <button id="rb-polish-btn" onclick="rbAction(\'polish\')">Polish Notes</button>',
        '</div>',
      ].join('');
      body.insertBefore(area, statusEl);
    } else {
      var chatArea = document.createElement('div');
      chatArea.id = 'rb-chat-area';
      chatArea.innerHTML = [
        '<div id="rb-chat-messages"></div>',
        '<div id="rb-chat-row">',
        '  <textarea id="rb-chat-input" placeholder="Type a message…" rows="1"></textarea>',
        '  <button id="rb-chat-voice" title="Voice input" onclick="rbChatVoice()">🎤</button>',
        '  <button id="rb-chat-send" onclick="rbChatSend()">↑</button>',
        '</div>',
      ].join('');
      body.insertBefore(chatArea, statusEl);
      chatHistory.forEach(function (m) { appendBubble(m.role, m.content); });
      var chatInput = document.getElementById('rb-chat-input');
      if (chatInput) {
        chatInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(chatInput.value); }
        });
      }
    }
  }

  window.rbTab = function (tab) {
    var sel = document.getElementById('rb-model-sel');
    if (sel) localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value);

    currentTab = tab;
    ['input', 'chat'].forEach(function (t) {
      var btn = document.getElementById('rb-tab-' + t);
      if (btn) btn.classList.toggle('active', t === tab);
    });
    renderTabContent(tab);
    setStatus('');

    if (sel) {
      var saved = localStorage.getItem(modelSelKey(currentAgent, tab));
      var models = getModelList();
      sel.value = (saved && models.indexOf(saved) >= 0) ? saved : models[0];
    }
  };

  // ── Panel ────────────────────────────────────────────────────────────────────

  function buildPanel() {
    if (document.getElementById('rb-panel')) return;

    var style = document.createElement('style');
    style.textContent = [
      '#rb-toggle{position:fixed;bottom:24px;right:24px;width:44px;height:44px;border-radius:50%;border:none;background:#7c3aed;color:#fff;font-size:20px;cursor:pointer;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}',
      '#rb-toggle:hover{background:#6d28d9}',
      '#rb-panel{position:fixed;bottom:78px;right:24px;width:300px;height:420px;background:#1e1e2e;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.45);display:flex;flex-direction:column;z-index:9998;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#cdd6f4;font-size:13px;overflow:hidden;min-width:240px;min-height:220px}',
      '#rb-resize-handle{position:absolute;top:0;left:0;width:16px;height:16px;cursor:nw-resize;z-index:10;background:linear-gradient(135deg,#45475a 25%,transparent 25%) no-repeat 3px 3px/10px 10px;border-radius:12px 0 0 0}',
      '#rb-panel.rb-hidden{display:none!important}',
      '#rb-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#181825;cursor:move;user-select:none;border-bottom:1px solid #313244}',
      '#rb-header span{font-weight:600;font-size:13px}',
      '#rb-close{background:none;border:none;color:#6c7086;cursor:pointer;font-size:14px;padding:0 2px}',
      '#rb-close:hover{color:#cdd6f4}',
      '#rb-body{padding:12px;display:flex;flex-direction:column;gap:10px;flex:1;overflow-y:auto;min-height:0}',
      '#rb-tabs{display:flex;gap:4px;background:#181825;border-radius:7px;padding:3px}',
      '.rb-tab{flex:1;padding:5px 0;border:none;border-radius:5px;background:none;color:#6c7086;cursor:pointer;font-size:12px;font-family:inherit;transition:background .12s,color .12s}',
      '.rb-tab.active{background:#313244;color:#cdd6f4}',
      '.rb-row{display:flex;gap:6px;align-items:center}',
      '.rb-label{font-size:11px;color:#6c7086;flex-shrink:0;white-space:nowrap}',
      '.rb-select,.rb-input{flex:1;padding:5px 8px;border-radius:6px;border:1px solid #45475a;background:#313244;color:#cdd6f4;font-size:12px;font-family:inherit;outline:none;min-width:0}',
      '.rb-select:focus,.rb-input:focus{border-color:#7c3aed}',
      '.rb-input::placeholder{color:#585b70}',
      '.rb-key-toggle{background:none;border:none;color:#6c7086;cursor:pointer;font-size:15px;padding:0 2px;flex-shrink:0}',
      '.rb-key-toggle:hover{color:#cdd6f4}',
      '#rb-voice-btn{width:100%;padding:8px;border:none;border-radius:7px;color:#fff;font-size:13px;font-family:inherit;cursor:pointer;transition:background .15s;background:#45475a}',
      '#rb-voice-btn:hover{background:#585b70}#rb-voice-btn.recording{background:#dc2626}#rb-voice-btn:disabled{opacity:.5;cursor:default}',
      '.rb-btn-row{display:flex;gap:6px}',
      '.rb-btn-row button{flex:1;padding:8px 4px;border:none;border-radius:7px;background:#7c3aed;color:#fff;font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s}',
      '.rb-btn-row button:hover{background:#6d28d9}.rb-btn-row button:disabled{opacity:.5;cursor:default}',
      '.rb-select-agent{flex:0 0 auto;max-width:110px}',
      '#rb-status{font-size:11px;color:#a6adc8;min-height:16px;text-align:center}',
      '#rb-status.error{color:#f38ba8}',
      '#rb-chat-messages{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px 0;min-height:0}',
      '.rb-msg{display:flex;flex-direction:column;gap:2px}',
      '.rb-bubble{padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.5;max-width:90%;word-break:break-word;white-space:pre-wrap}',
      '.rb-bubble.user{background:#7c3aed;color:#fff;align-self:flex-end;border-radius:8px 8px 2px 8px}',
      '.rb-bubble.ai{background:#313244;color:#cdd6f4;align-self:flex-start;border-radius:8px 8px 8px 2px}',
      '#rb-chat-row{display:flex;gap:6px;align-items:flex-end}',
      '#rb-chat-input{flex:1;padding:6px 9px;border-radius:6px;border:1px solid #45475a;background:#313244;color:#cdd6f4;font-size:12px;font-family:inherit;outline:none;resize:none;min-height:32px;max-height:80px}',
      '#rb-chat-input:focus{border-color:#7c3aed}',
      '#rb-chat-send,#rb-chat-voice{padding:6px 10px;border:none;border-radius:6px;background:#7c3aed;color:#fff;cursor:pointer;font-size:13px;flex-shrink:0;transition:background .15s}',
      '#rb-chat-send:hover,#rb-chat-voice:hover{background:#6d28d9}',
      '#rb-chat-voice.recording{background:#dc2626}',
      '#rb-prefs{display:flex;flex-direction:column;gap:6px}',
      '#rb-prefs.rb-hidden{display:none}',
      '#rb-models-input{width:100%;box-sizing:border-box;min-height:80px;max-height:160px;padding:6px 9px;border-radius:6px;border:1px solid #45475a;background:#313244;color:#cdd6f4;font-size:12px;font-family:inherit;outline:none;resize:vertical;line-height:1.6}',
      '#rb-models-input:focus{border-color:#7c3aed}',
      '#rb-models-input::placeholder{color:#585b70}',
      '#rb-prefs-save,#rb-prefs-reset{padding:5px 0;border:none;border-radius:6px;background:#313244;color:#a6adc8;font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s}',
      '#rb-prefs-save:hover,#rb-prefs-reset:hover{background:#45475a;color:#cdd6f4}',
      '#rb-action-area,#rb-chat-area{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0}',
      '#rb-voice-text{width:100%;box-sizing:border-box;min-height:60px;max-height:200px;padding:6px 9px;border-radius:6px;border:1px solid #45475a;background:#313244;color:#cdd6f4;font-size:12px;font-family:inherit;outline:none;resize:vertical;line-height:1.5}',
      '#rb-voice-text:focus{border-color:#7c3aed}',
      '#rb-voice-text::placeholder{color:#585b70}',
    ].join('\n');
    document.head.appendChild(style);

    var toggle = document.createElement('button');
    toggle.id = 'rb-toggle';
    toggle.title = 'AI Assistant';
    toggle.innerHTML = '🤖';
    toggle.onclick = function () {
      document.getElementById('rb-panel').classList.remove('rb-hidden');
      toggle.style.display = 'none';
    };
    document.body.appendChild(toggle);

    var agentOptions = Object.keys(AGENTS).map(function (id) {
      return '<option value="' + id + '">' + AGENTS[id].label + '</option>';
    }).join('');

    var panel = document.createElement('div');
    panel.id = 'rb-panel';
    panel.classList.add('rb-hidden');
    panel.innerHTML = [
      '<div id="rb-resize-handle" title="Resize"></div>',
      '<div id="rb-header"><span>🤖 AI Assistant</span><button id="rb-close" title="Close">✕</button></div>',
      '<div id="rb-body">',
      '  <div id="rb-tabs">',
      '    <button id="rb-tab-input" class="rb-tab active" onclick="rbTab(\'input\')">Input</button>',
      '    <button id="rb-tab-chat"  class="rb-tab"        onclick="rbTab(\'chat\')">Chat</button>',
      '  </div>',
      '  <div class="rb-row" id="rb-agent-model-row">',
      '    <select id="rb-agent-sel" class="rb-select rb-select-agent" onchange="rbSwitchAgent(this.value)">' + agentOptions + '</select>',
      '    <select id="rb-model-sel" class="rb-select"></select>',
      '    <button class="rb-key-toggle" onclick="rbTogglePrefs()" title="Edit model list">⚙</button>',
      '  </div>',
      '  <div id="rb-prefs" class="rb-hidden">',
      '    <textarea id="rb-models-input" placeholder="One model name per line…"></textarea>',
      '    <div class="rb-row" style="gap:6px">',
      '      <button id="rb-prefs-reset" onclick="rbResetPrefs()" style="flex:1">Reset</button>',
      '      <button id="rb-prefs-save"  onclick="rbSavePrefs()"  style="flex:2">Save</button>',
      '    </div>',
      '  </div>',
      '  <div class="rb-row" id="rb-key-row">',
      '    <input id="rb-key-input" class="rb-input" type="password" placeholder="API Key (leave blank to use .env)" />',
      '    <button class="rb-key-toggle" onclick="rbToggleKey()" title="Show/hide">👁</button>',
      '    <button class="rb-key-toggle" onclick="rbSaveKey()" title="Save to ~/.env">💾</button>',
      '  </div>',
      '  <div id="rb-status"></div>',
      '</div>',
    ].join('');
    document.body.appendChild(panel);

    // Restore size and position
    var savedW = localStorage.getItem('rb_panel_w');
    var savedH = localStorage.getItem('rb_panel_h');
    var savedL = localStorage.getItem('rb_panel_l');
    var savedT = localStorage.getItem('rb_panel_t');
    if (savedW) panel.style.width  = savedW;
    if (savedH) panel.style.height = savedH;
    if (savedL && savedT) {
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = savedL; panel.style.top = savedT;
    }

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () {
        if (panel.style.width)  localStorage.setItem('rb_panel_w', panel.style.width);
        if (panel.style.height) localStorage.setItem('rb_panel_h', panel.style.height);
      }).observe(panel);
    }

    // Init agent selector
    var agentSel = document.getElementById('rb-agent-sel');
    if (agentSel) agentSel.value = currentAgent;

    // Init model selector
    rebuildModelSelect();
    var sel = document.getElementById('rb-model-sel');
    if (sel) sel.onchange = function () { localStorage.setItem(modelSelKey(currentAgent, currentTab), sel.value); };

    document.getElementById('rb-close').onclick = function () {
      panel.classList.add('rb-hidden');
      toggle.style.display = 'flex';
    };

    // Drag
    var dragging = false, ox = 0, oy = 0;
    document.getElementById('rb-header').addEventListener('mousedown', function (e) {
      dragging = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
    });

    // Resize from top-left
    var resizing = false, startX = 0, startY = 0, startW = 0, startH = 0, startR = 0, startB = 0;
    document.getElementById('rb-resize-handle').addEventListener('mousedown', function (e) {
      e.stopPropagation();
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = panel.offsetWidth; startH = panel.offsetHeight;
      var rect = panel.getBoundingClientRect();
      startR = window.innerWidth  - rect.right;
      startB = window.innerHeight - rect.bottom;
      panel.style.right  = startR + 'px'; panel.style.bottom = startB + 'px';
      panel.style.left   = 'auto';        panel.style.top    = 'auto';
    });

    document.addEventListener('mousemove', function (e) {
      if (dragging) {
        panel.style.right  = 'auto'; panel.style.bottom = 'auto';
        panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox)) + 'px';
        panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy)) + 'px';
        localStorage.setItem('rb_panel_l', panel.style.left);
        localStorage.setItem('rb_panel_t', panel.style.top);
      }
      if (resizing) {
        var newW = Math.max(240, startW - (e.clientX - startX));
        var newH = Math.max(220, startH - (e.clientY - startY));
        panel.style.width  = newW + 'px';
        panel.style.height = newH + 'px';
        localStorage.setItem('rb_panel_w', panel.style.width);
        localStorage.setItem('rb_panel_h', panel.style.height);
      }
    });
    document.addEventListener('mouseup', function () { dragging = false; resizing = false; });

    renderTabContent('input');
  }

  // ── Extension entry point ────────────────────────────────────────────────────

  function load_ipython_extension() {
    if (document.readyState === 'complete') { buildPanel(); }
    else { window.addEventListener('load', buildPanel); }
  }

  return { load_ipython_extension: load_ipython_extension };
});
