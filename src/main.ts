import { Plugin, WorkspaceLeaf, TFile, TAbstractFile } from "obsidian";
import {
	PensieveSettings,
	DEFAULT_SETTINGS,
	PensieveSettingTab,
} from "./settings";
import { OllamaService } from "./ollama";
import { VaultIndexer } from "./indexer";
import { Retriever } from "./retriever";
import { ChatHistoryManager, ChatHistoryData } from "./chathistory";
import { PensieveChatView, VIEW_TYPE_PENSIEVE_CHAT } from "./chatview";
import { ToolRegistry } from "./tools/registry";
import { registerAllTools } from "./tools/notetools";
import { registerWebTools } from "./tools/webtools";
import { Orchestrator } from "./agents/orchestrator";
import type { ToolContext } from "./tools/types";

interface PensieveData {
	settings: PensieveSettings;
	chatHistory: ChatHistoryData;
}

export default class PensievePlugin extends Plugin {
	settings: PensieveSettings = DEFAULT_SETTINGS;
	ollama!: OllamaService;
	indexer!: VaultIndexer;
	retriever!: Retriever;
	chatHistory: ChatHistoryManager = new ChatHistoryManager();
	toolRegistry!: ToolRegistry;
	toolCtx!: ToolContext;
	orchestrator!: Orchestrator;

	async onload(): Promise<void> {
		console.log("[Pensieve] Loading plugin...");

		await this.loadSettings();

		// Core services
		this.ollama = new OllamaService(this.settings.ollamaUrl);
		this.indexer = new VaultIndexer(this.app.vault, this.ollama, this.settings);
		this.retriever = new Retriever(this.ollama, this.indexer.vectorStore, this.settings);

		await this.indexer.loadIndex();
		this.retriever.setVectorStore(this.indexer.vectorStore);

		// Tool system
		this.toolRegistry = new ToolRegistry();
		this.toolCtx = {
			vault: this.app.vault,
			app: this.app,
			retriever: this.retriever,
			settings: this.settings,
		};
		registerAllTools(this.toolRegistry);
		registerWebTools(this.toolRegistry);

		// Orchestrator
		this.orchestrator = new Orchestrator(this.ollama, this.settings);

		// UI
		this.registerView(VIEW_TYPE_PENSIEVE_CHAT, (leaf) => new PensieveChatView(leaf, this));
		this.addRibbonIcon("brain", "Open Pensieve", () => this.activateView());

		// Commands
		this.addCommand({ id: "open-chat", name: "Open chat panel", callback: () => this.activateView() });
		this.addCommand({
			id: "reindex-vault",
			name: "Reindex vault",
			callback: async () => {
				await this.indexer.indexVault();
				this.retriever.setVectorStore(this.indexer.vectorStore);
			},
		});

		this.addSettingTab(new PensieveSettingTab(this.app, this));

		// Incremental indexing
		this.registerEvent(this.app.vault.on("modify", (f: TAbstractFile) => {
			if (f instanceof TFile && f.extension === "md") this.debouncedIndex(f);
		}));
		this.registerEvent(this.app.vault.on("delete", (f: TAbstractFile) => {
			if (f instanceof TFile && f.extension === "md") this.indexer.onFileDelete(f.path);
		}));
		this.registerEvent(this.app.vault.on("rename", (f: TAbstractFile, old: string) => {
			if (f instanceof TFile && f.extension === "md") {
				this.indexer.onFileDelete(old);
				this.debouncedIndex(f);
			}
		}));

		console.log("[Pensieve] Plugin loaded.");
	}

	onunload(): void {
		console.log("[Pensieve] Unloading plugin.");
	}

	private indexTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private debouncedIndex(file: TFile): void {
		const t = this.indexTimers.get(file.path);
		if (t) clearTimeout(t);
		this.indexTimers.set(file.path, setTimeout(async () => {
			this.indexTimers.delete(file.path);
			await this.indexer.indexFile(file);
			this.retriever.setVectorStore(this.indexer.vectorStore);
		}, 2000));
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PENSIEVE_CHAT);
		let leaf: WorkspaceLeaf | null = leaves.length > 0 ? (leaves[0] ?? null) : null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_PENSIEVE_CHAT, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as PensieveData | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
		this.chatHistory.load(data?.chatHistory ?? null);
	}

	async saveSettings(): Promise<void> {
		this.ollama?.setBaseUrl(this.settings.ollamaUrl);
		this.orchestrator?.updateSettings(this.settings);
		// Keep toolCtx settings reference in sync
		if (this.toolCtx) this.toolCtx.settings = this.settings;
		await this.saveData({ settings: this.settings, chatHistory: this.chatHistory.serialize() });
	}

	async saveChatHistory(): Promise<void> {
		await this.saveData({ settings: this.settings, chatHistory: this.chatHistory.serialize() });
	}
}
