import { App, PluginSettingTab, Setting } from "obsidian";
import type PensievePlugin from "./main";

export interface PensieveSettings {
	ollamaUrl: string;
	chatModel: string;
	embeddingModel: string;
	chunkSize: number;
	chunkOverlap: number;
	topK: number;
	systemPrompt: string;
	maxChatHistory: number;
	// Agent settings
	agentEnabled: boolean;
	maxAgentIterations: number;
	dailyNoteFolder: string;
	weeklyNoteFolder: string;
}

export const DEFAULT_SETTINGS: PensieveSettings = {
	ollamaUrl: "http://localhost:11434",
	chatModel: "gemma4:e2b",
	embeddingModel: "nomic-embed-text",
	chunkSize: 500,
	chunkOverlap: 50,
	topK: 5,
	agentEnabled: true,
	maxAgentIterations: 10,
	dailyNoteFolder: "Daily",
	weeklyNoteFolder: "Weekly",
	systemPrompt:
		"You are Pensieve, a helpful AI assistant embedded in Obsidian. " +
		"You help the user understand and navigate their notes. " +
		"When context from the vault is provided, use it to give accurate, specific answers. " +
		"Always cite which notes you are referencing. " +
		"If the context does not contain enough information, say so honestly. " +
		"Use markdown formatting in your responses.",
	maxChatHistory: 50,
};

export class PensieveSettingTab extends PluginSettingTab {
	plugin: PensievePlugin;

	constructor(app: App, plugin: PensievePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Pensieve Settings" });

		// ── Connection ──────────────────────────────────────────
		containerEl.createEl("h3", { text: "Ollama Connection" });

		new Setting(containerEl)
			.setName("Ollama URL")
			.setDesc("Base URL where Ollama is running")
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.ollamaUrl)
					.onChange(async (value) => {
						this.plugin.settings.ollamaUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Chat model")
			.setDesc("Ollama model tag for chat completions (e.g. gemma4:e2b)")
			.addText((text) =>
				text
					.setPlaceholder("gemma4:e2b")
					.setValue(this.plugin.settings.chatModel)
					.onChange(async (value) => {
						this.plugin.settings.chatModel = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc("Ollama model tag for embeddings (e.g. nomic-embed-text)")
			.addText((text) =>
				text
					.setPlaceholder("nomic-embed-text")
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel = value;
						await this.plugin.saveSettings();
					})
			);

		// ── RAG Parameters ──────────────────────────────────────
		containerEl.createEl("h3", { text: "RAG Parameters" });

		new Setting(containerEl)
			.setName("Chunk size")
			.setDesc("Maximum number of characters per text chunk")
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(String(this.plugin.settings.chunkSize))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.chunkSize = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Chunk overlap")
			.setDesc("Character overlap between adjacent chunks")
			.addText((text) =>
				text
					.setPlaceholder("50")
					.setValue(String(this.plugin.settings.chunkOverlap))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.chunkOverlap = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Top K results")
			.setDesc("Number of context chunks to retrieve per query")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.topK))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.topK = n;
							await this.plugin.saveSettings();
						}
					})
			);

		// ── System Prompt ───────────────────────────────────────
		containerEl.createEl("h3", { text: "System Prompt" });

		new Setting(containerEl)
			.setName("System prompt")
			.setDesc("Instructions given to the model at the start of every conversation")
			.addTextArea((text) =>
				text
					.setPlaceholder("You are a helpful assistant...")
					.setValue(this.plugin.settings.systemPrompt)
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Agent Settings ─────────────────────────────────────
		containerEl.createEl("h3", { text: "Agentic Mode" });

		new Setting(containerEl)
			.setName("Enable agentic mode")
			.setDesc("Automatically route write/plan/review/factcheck tasks to specialist agents")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.agentEnabled)
					.onChange(async (value) => {
						this.plugin.settings.agentEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max agent iterations")
			.setDesc("Maximum tool-call cycles per agent run (default 10)")
			.addText((text) =>
				text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.maxAgentIterations))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.maxAgentIterations = n;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Daily note folder")
			.setDesc("Folder for daily notes (e.g. Daily)")
			.addText((text) =>
				text
					.setPlaceholder("Daily")
					.setValue(this.plugin.settings.dailyNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.dailyNoteFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Weekly note folder")
			.setDesc("Folder for weekly notes (e.g. Weekly)")
			.addText((text) =>
				text
					.setPlaceholder("Weekly")
					.setValue(this.plugin.settings.weeklyNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.weeklyNoteFolder = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Chat ────────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Chat" });

		new Setting(containerEl)
			.setName("Max chat history")
			.setDesc("Maximum number of messages to keep in context window")
			.addText((text) =>
				text
					.setPlaceholder("50")
					.setValue(String(this.plugin.settings.maxChatHistory))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n > 0) {
							this.plugin.settings.maxChatHistory = n;
							await this.plugin.saveSettings();
						}
					})
			);
	}
}
