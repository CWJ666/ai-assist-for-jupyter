# AI Assistant for JupyterLab

A JupyterLab 4.x extension that adds a floating AI assistant panel with voice input, code generation, note polishing, and chat capabilities.

## Features

- **Generate Code** — speak or type a request, the assistant inserts runnable Python code into a new cell
- **Polish Notes** — convert raw notes into organized bullet points inserted as a Markdown cell
- **Chat** — ask data analysis questions in a persistent conversation
- Voice input via Whisper (OpenAI)
- Resizable & draggable panel with remembered position/size
- Per-tab model selection (each tab remembers its own model)

## Requirements

- JupyterLab 4.x (or Notebook 7.x)
- Node.js 18+
- Python 3.8+
- An OpenAI API key

## Installation

```bash
bash install.sh lab
```

After installation, refresh the browser. A 🤖 button appears in the bottom-right corner.

## API Key

Enter your OpenAI API key in the panel, or set it as an environment variable / in `~/.env`:

```
OPENAI_API_KEY=sk-...
```

## Supported Models

- gpt-5.5-pro / gpt-5.5
- gpt-5-mini
- gpt-5.4-thinking
- gpt-5.2-codex

## Development

```bash
cd labextension
jlpm install
jlpm build:prod
pip install -e .
jupyter labextension develop . --overwrite
```
