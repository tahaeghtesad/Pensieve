# Pensieve for Obsidian

Pensieve is a local AI chat assistant plugin for Obsidian. It's powered by [Ollama](https://ollama.com) and uses Retrieval-Augmented Generation (RAG) directly on your device. You can chat with an AI (e.g., Gemma) and ask questions about your vault, and it will read your notes to provide contextual answers with source citations.

Everything runs 100% locally and privately on your machine. No data is sent to the cloud.

## Prerequisites

1. Install [Ollama](https://ollama.com/) on your machine.
2. Ensure Ollama is running (it runs on port 11434 by default).
3. Pull the required models. Open your terminal and run:
   ```bash
   # Used for chat completions
   ollama pull gemma3:4b
   
   # Used for vault embeddings (RAG)
   ollama pull nomic-embed-text
   ```

## Installation (Manual)

If you're not compiling from source, you can install the plugin manually:

1. Create a directory named `pensieve` in your vault's plugins folder: `[your-vault]/.obsidian/plugins/pensieve/`.
2. Copy `main.js`, `styles.css`, and `manifest.json` into this folder.
3. Open Obsidian settings, go to **Community plugins** (ensure "Turn on community plugins" is active).
4. Reload the plugins list and enable **Pensieve**.

## Compiling from Source

To compile the plugin yourself, you need Node.js installed.

1. Clone or download this repository.
2. Open a terminal in the folder and run:
   ```bash
   npm install
   ```
3. Build the plugin:
   ```bash
   npm run build
   ```
   *For development with hot-reloading (watch mode), run `npm run dev`.*
4. Copy the freshly built `main.js`, `styles.css`, and `manifest.json` to your `.obsidian/plugins/pensieve/` folder.

## How to Use

1. Click the **brain icon** in the Obsidian left ribbon menu to open the Pensieve chat panel (or run the command `Pensieve: Open chat panel`).
2. **First Time Setup**: Click the **Reindex Vault** button (the refresh icon) in the header. Pensieve will chunk and embed your markdown notes. *Note: Incremental indexing happens automatically when you create/edit notes subsequently.*
3. Ask a question! The AI will search your vault, find relevant notes, and answer your question while citing its sources.

## Settings

You can customize the plugin in the Obsidian settings:
- **Ollama URL**: Default is `http://localhost:11434`
- **Models**: Change the chat or embedding model if you prefer alternatives (e.g., `llama3`).
- **RAG Parameters**: Adjust the chunk size, overlap, and top-K context results retrieved per query.
- **System Prompt**: Customize how the AI behaves.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
