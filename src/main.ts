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
import { migrateManagedMarkdownNotes, registerAllTools } from "./tools/notetools";
import { registerWebTools } from "./tools/webtools";
import { registerMemoryTools } from "./tools/memorytools";
import { registerAgentTools } from "./tools/agent_tools";
import { registerDiscoveryTools } from "./tools/discovery_tools";
import { registerGraphTools } from "./tools/graph_tools";
import { registerMaintenanceTools } from "./tools/maintenancetools";
import { Orchestrator } from "./agents/orchestrator";
import { MemoryCompactor } from "./compactor";
import { GraphStore } from "./graphstore";
import type { ToolContext } from "./tools/types";
import type { IntentType } from "./agents/types";

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
	compactor!: MemoryCompactor;
	graphStore!: GraphStore;
	private view: PensieveChatView | null = null;

	async onload(): Promise<void> {
		console.log("[Pensieve] Loading plugin...");

		await this.loadSettings();

		// Core services
		this.ollama = new OllamaService(this.settings.ollamaUrl);
		this.indexer = new VaultIndexer(this.app.vault, this.ollama, this.settings);
		this.retriever = new Retriever(this.ollama, this.indexer.vectorStore, this.settings);

		await this.indexer.loadIndex();
		this.retriever.setVectorStore(this.indexer.vectorStore);

		// GraphStore initialized natively
		this.graphStore = new GraphStore(this.app.vault.adapter);
		await this.graphStore.load();

		// Tool system
		this.toolRegistry = new ToolRegistry();
		this.toolCtx = {
			vault: this.app.vault,
			app: this.app,
			retriever: this.retriever,
			settings: this.settings,
			ollama: this.ollama,
			graphStore: this.graphStore,
			temporalContext: {
				sessionId: this.chatHistory.getActiveSession().id,
				intent: "direct_chat",
				agentName: "direct_chat",
				eventType: "chat",
			},
			nextTemporalSequence: () => this.chatHistory.nextTemporalSequence(),
			subAgentRunner: {
				runSubAgent: async (intent: string, query: string, onTrace?: (step: any) => void) => {
					if (!this.orchestrator) throw new Error("Orchestrator not initialized");
					const subCtx = {
						userQuery: query,
						chatHistory: [], // Completely blank history!
						ragContext: "", // No parent RAG noise
						toolCtx: this.toolCtx,
						toolRegistry: this.toolRegistry,
						ollama: this.ollama,
						settings: this.settings,
						onTrace: (step: any) => {
							if (onTrace) onTrace(step);
							else {
								// Prefix and bubble to parent UI dynamically
								const childStep = { ...step, type: step.type === "thought" ? "thought" : 
													 step.type === "prompt" ? "prompt" : 
													 step.type === "raw_response" ? "raw_response" : 
													 step.type === "tool_call" ? "tool_call" : 
													 step.type === "observation" ? "observation" : step.type, 
													 content: `[Sub-Agent] ${step.content}` };
								// Wait, the parent UI onTrace is bound in ChatView. 
								// SubAgents don't have access to the parent ChatView's traceList natively unless passed down!
								// We'll leave it simple for now, the user requested the output rather than trace flooding.
							}
						}
					};
					const result = await this.orchestrator.runAgent(intent as IntentType, subCtx);
					return { answer: result.answer, affectedFiles: result.affectedFiles };
				}
			}
		};
		registerAllTools(this.toolRegistry);
		registerWebTools(this.toolRegistry);
		registerMemoryTools(this.toolRegistry);
		registerAgentTools(this.toolRegistry);
		registerDiscoveryTools(this.toolRegistry);
		registerGraphTools(this.toolRegistry);
		registerMaintenanceTools(this.toolRegistry);

		// Orchestrator & Compactor
		this.orchestrator = new Orchestrator(this.ollama, this.settings);
		this.compactor = new MemoryCompactor(this.app.vault, this.ollama, this.settings, this.chatHistory);

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
		this.addCommand({
			id: "migrate-temporal-wiki-notes",
			name: "Migrate notes to temporal wiki format",
			callback: async () => {
				const report = await migrateManagedMarkdownNotes(this.toolCtx);
				console.log(`[Pensieve] Temporal wiki migration complete: scanned=${report.scanned}, migrated=${report.migrated}, skipped=${report.skipped}`);
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
