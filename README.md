# AI Assistant for JupyterLab

A JupyterLab 4.x extension that adds a floating AI assistant panel with voice input, code generation, note polishing, and chat capabilities.

## Features

- **Generate Code** — speak or type a request; the assistant inserts runnable Python code into a new cell
- **Polish Notes** — convert raw notes into organized bullet points inserted as a Markdown cell
- **Chat** — ask data analysis questions in a persistent conversation
- **Multi-provider** — switch between OpenAI, Anthropic, and Google Gemini via the Agent selector
- Voice input via OpenAI Whisper
- Resizable & draggable panel with remembered position/size
- Per-agent, per-tab model selection (each combination remembers its own model)
- Customizable model lists per provider (click ⚙ to edit)

## Requirements

- JupyterLab 4.x (or Notebook 7.x)
- Node.js 18+
- Python 3.8+
- API key for at least one provider

## Installation

```bash
bash install.sh lab
```

After installation, refresh the browser. A 🤖 button appears in the bottom-right corner.

## API Keys

Enter your API key in the panel, or set it as an environment variable / in `~/.env`:

| Agent | Environment Variable |
|-------|---------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | `GOOGLE_API_KEY` |

Click 💾 to save the current key to `~/.env` for the selected agent.

## Default Models

### OpenAI
- gpt-5.5-pro / gpt-5.5 / gpt-5-mini / gpt-5.4-thinking / gpt-5.2-codex

### Anthropic
- claude-opus-4-8 / claude-sonnet-4-6 / claude-haiku-4-5-20251001

### Google Gemini
- gemini-2.0-flash / gemini-2.0-flash-lite / gemini-1.5-pro

Click ⚙ to add or remove models for the currently selected agent.

## Voice input

Voice transcription always uses OpenAI Whisper. Even when using Anthropic or Google for text generation, you need an `OPENAI_API_KEY` for voice recording.

## Development

```bash
cd labextension
jlpm install
jlpm build:prod
pip install -e .
jupyter labextension develop . --overwrite
```
