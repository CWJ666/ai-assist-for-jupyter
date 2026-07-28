# ai-assist-for-jupyter

A JupyterLab 4.x extension that adds an AI assistant panel to the left sidebar with voice input, code generation, note polishing, error fixing, and chat capabilities. Supports OpenAI, Anthropic, and Google Gemini.

![JupyterLab AI Assistant](https://img.shields.io/badge/JupyterLab-4.x-orange) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Generate Code** — speak or type a request; the assistant inserts runnable Python code into a new cell
- **Polish Notes** — convert raw notes into organized bullet points inserted as a Markdown cell
- **Fix Error** — automatically reads the active cell's error and generates a corrected version
- **Chat** — persistent conversation with the AI directly in the sidebar
- **Voice input** — record audio transcribed via OpenAI Whisper (in both Input and Chat modes)
- **Input history** — quickly recall previous inputs from a dropdown
- **Multi-provider** — switch between OpenAI, Anthropic, and Google Gemini
- **Per-provider model selection** — each provider remembers its own model choice
- **Customizable model lists** — click ⚙ to add or remove models per provider
- **API key management** — enter keys in the panel or load from environment / `~/.env`

## Requirements

- JupyterLab 4.x
- Python 3.8+
- API key for at least one provider (OpenAI, Anthropic, or Google Gemini)

## Installation

### From wheel (recommended, no Node.js required)

Download the latest `.whl` from [Releases](../../releases) and run:

```bash
pip install ai_assist_for_jupyter-*.whl
```

Then refresh JupyterLab in your browser. The AI Assistant icon appears in the left sidebar.

### From source (requires Node.js 18+)

```bash
git clone https://github.com/<your-username>/ai-assist-for-jupyter.git
cd ai-assist-for-jupyter
bash install.sh lab
```

## API Keys

Enter your key directly in the panel (click ⚙), or set it as an environment variable / in `~/.env`:

| Provider | Environment Variable |
|----------|---------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GOOGLE_API_KEY` |

Click 💾 to save the current key to `~/.env` for future sessions.

> **Note:** Voice transcription always uses OpenAI Whisper regardless of the selected chat provider. An `OPENAI_API_KEY` is required for voice input.

## Usage

### Input tab

| Action | Description |
|--------|-------------|
| 🎤 Record | Record voice, transcribed to text via Whisper |
| History… | Recall a previous input |
| Generate Code | Send the text to the AI; insert result as a code cell |
| Polish Notes | Reformat raw notes into bullet points as a Markdown cell |
| 🔧 Fix Error | Read active cell error and insert a corrected cell below |

### Chat tab

Type or speak to have a persistent conversation. The history is kept for the session.

### Switching providers

Use the **Agent** dropdown to switch between OpenAI, Anthropic, and Google Gemini. The **Model** dropdown updates to that provider's model list.

## Default Models

### OpenAI
`gpt-5.5-pro` · `gpt-5.5` · `gpt-5-mini` · `gpt-5.4-thinking` · `gpt-5.2-codex`

> `gpt-5.2-codex` and other Codex models are routed to OpenAI's `/v1/responses` endpoint automatically.

### Anthropic
`claude-opus-4-8` · `claude-sonnet-4-6` · `claude-haiku-4-5-20251001`

### Google Gemini
`gemini-2.0-flash` · `gemini-2.0-flash-lite` · `gemini-1.5-pro`

Click ⚙ to customize the model list for each provider.

## Development

```bash
cd labextension
jlpm install
jlpm build:prod
pip install -e .
jupyter labextension develop . --overwrite
```

To build a distributable wheel:

```bash
cd labextension
pip install build
python -m build --wheel
# output: dist/ai_assist_for_jupyter-*.whl
```

## License

MIT
