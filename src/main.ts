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

	async onload(): Promise<void> {
		console.log("[Pensieve] Loading plugin...");

		// Load persisted data
		await this.loadSettings();

		// Initialize services
		this.ollama = new OllamaService(this.settings.ollamaUrl);
		this.indexer = new VaultIndexer(
			this.app.vault,
			this.ollama,
			this.settings
		);
		this.retriever = new Retriever(
			this.ollama,
			this.indexer.vectorStore,
			this.settings
		);

		// Load saved vector index
		await this.indexer.loadIndex();
		this.retriever.setVectorStore(this.indexer.vectorStore);

		// Register the chat view
		this.registerView(
			VIEW_TYPE_PENSIEVE_CHAT,
			(leaf) => new PensieveChatView(leaf, this)
		);

		// Ribbon icon
		this.addRibbonIcon("brain", "Open Pensieve", () => {
			this.activateView();
		});

		// Commands
		this.addCommand({
			id: "open-chat",
			name: "Open chat panel",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "reindex-vault",
			name: "Reindex vault",
			callback: async () => {
				await this.indexer.indexVault();
				this.retriever.setVectorStore(this.indexer.vectorStore);
			},
		});

		// Settings tab
		this.addSettingTab(new PensieveSettingTab(this.app, this));

		// File change listeners for incremental indexing
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					// Debounce — wait 2s after last modify
					this.debouncedIndex(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile && file.extension === "md") {
					this.indexer.onFileDelete(file.path);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile && file.extension === "md") {
					this.indexer.onFileDelete(oldPath);
					this.debouncedIndex(file);
				}
			})
		);

		console.log("[Pensieve] Plugin loaded.");
	}

	onunload(): void {
		console.log("[Pensieve] Unloading plugin.");
	}

	// ── Debounced file indexing ─────────────────────────────────
	private indexTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	private debouncedIndex(file: TFile): void {
		const existing = this.indexTimers.get(file.path);
		if (existing) clearTimeout(existing);

		this.indexTimers.set(
			file.path,
			setTimeout(async () => {
				this.indexTimers.delete(file.path);
				await this.indexer.indexFile(file);
				this.retriever.setVectorStore(this.indexer.vectorStore);
			}, 2000)
		);
	}

	// ── View activation ─────────────────────────────────────────
	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PENSIEVE_CHAT);

		if (leaves.length > 0) {
			leaf = leaves[0] ?? null;
		} else {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: VIEW_TYPE_PENSIEVE_CHAT,
					active: true,
				});
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	// ── Settings persistence ────────────────────────────────────
	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as PensieveData | null;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data?.settings ?? {}
		);
		this.chatHistory.load(data?.chatHistory ?? null);
	}

	async saveSettings(): Promise<void> {
		// Update Ollama URL if it changed
		this.ollama?.setBaseUrl(this.settings.ollamaUrl);

		await this.saveData({
			settings: this.settings,
			chatHistory: this.chatHistory.serialize(),
		});
	}

	async saveChatHistory(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			chatHistory: this.chatHistory.serialize(),
		});
	}
}
