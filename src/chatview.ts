import {
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	setIcon,
} from "obsidian";
import type PensievePlugin from "./main";
import type { ChatMessage } from "./chathistory";

export const VIEW_TYPE_PENSIEVE_CHAT = "pensieve-chat-view";

export class PensieveChatView extends ItemView {
	plugin: PensievePlugin;

	// DOM elements
	private headerEl!: HTMLElement;
	private statusDot!: HTMLElement;
	private statusText!: HTMLElement;
	private chatContainer!: HTMLElement;
	private inputArea!: HTMLElement;
	private textInput!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private sessionListEl!: HTMLElement;
	private showingSessions = false;

	// State
	private isGenerating = false;
	private abortSignal = { aborted: false };

	constructor(leaf: WorkspaceLeaf, plugin: PensievePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PENSIEVE_CHAT;
	}

	getDisplayText(): string {
		return "Pensieve";
	}

	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pensieve-root");

		// ── Header ──────────────────────────────────────────────
		this.headerEl = root.createDiv({ cls: "pensieve-header" });

		const titleRow = this.headerEl.createDiv({
			cls: "pensieve-header-title-row",
		});
		const titleEl = titleRow.createEl("span", {
			cls: "pensieve-title",
			text: "Pensieve",
		});

		const brainIcon = titleEl.createSpan({ cls: "pensieve-title-icon" });
		setIcon(brainIcon, "brain");

		// Status
		const statusEl = titleRow.createDiv({ cls: "pensieve-status" });
		this.statusDot = statusEl.createSpan({ cls: "pensieve-status-dot" });
		this.statusText = statusEl.createSpan({
			cls: "pensieve-status-text",
			text: "Checking...",
		});

		// Action buttons row
		const actionsRow = this.headerEl.createDiv({
			cls: "pensieve-header-actions",
		});

		const newChatBtn = actionsRow.createEl("button", {
			cls: "pensieve-action-btn",
			attr: { "aria-label": "New Chat", title: "New Chat" },
		});
		setIcon(newChatBtn, "plus");
		newChatBtn.addEventListener("click", () => this.onNewChat());

		const sessionsBtn = actionsRow.createEl("button", {
			cls: "pensieve-action-btn",
			attr: { "aria-label": "Chat History", title: "Chat History" },
		});
		setIcon(sessionsBtn, "history");
		sessionsBtn.addEventListener("click", () => this.toggleSessionList());

		const reindexBtn = actionsRow.createEl("button", {
			cls: "pensieve-action-btn",
			attr: { "aria-label": "Reindex Vault", title: "Reindex Vault" },
		});
		setIcon(reindexBtn, "refresh-cw");
		reindexBtn.addEventListener("click", () => this.onReindex());

		// ── Session list (hidden by default) ────────────────────
		this.sessionListEl = root.createDiv({
			cls: "pensieve-session-list hidden",
		});

		// ── Chat container ──────────────────────────────────────
		this.chatContainer = root.createDiv({ cls: "pensieve-chat" });

		// ── Input area ──────────────────────────────────────────
		this.inputArea = root.createDiv({ cls: "pensieve-input-area" });

		this.textInput = this.inputArea.createEl("textarea", {
			cls: "pensieve-input",
			attr: {
				placeholder: "Ask about your vault...",
				rows: "1",
			},
		});

		this.sendBtn = this.inputArea.createEl("button", {
			cls: "pensieve-send-btn",
			attr: { "aria-label": "Send" },
		});
		setIcon(this.sendBtn, "send");

		// Auto-resize textarea
		this.textInput.addEventListener("input", () => {
			this.textInput.style.height = "auto";
			this.textInput.style.height =
				Math.min(this.textInput.scrollHeight, 150) + "px";
		});

		// Send on Enter (Shift+Enter for newline)
		this.textInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.onSend();
			}
		});

		this.sendBtn.addEventListener("click", () => this.onSend());

		// Render existing messages from active session
		this.renderAllMessages();

		// Check Ollama status
		this.checkOllamaStatus();
	}

	async onClose(): Promise<void> {
		this.abortSignal.aborted = true;
	}

	// ── Ollama Status ─────────────────────────────────────────
	private async checkOllamaStatus(): Promise<void> {
		try {
			await this.plugin.ollama.checkConnection();
			this.statusDot.classList.add("connected");
			this.statusDot.classList.remove("disconnected");
			this.statusText.setText("Connected");
		} catch {
			this.statusDot.classList.add("disconnected");
			this.statusDot.classList.remove("connected");
			this.statusText.setText("Disconnected");
		}
	}

	// ── Session Management ────────────────────────────────────
	private onNewChat(): void {
		this.plugin.chatHistory.createSession();
		this.renderAllMessages();
		this.hideSessionList();
		this.plugin.saveChatHistory();
	}

	private toggleSessionList(): void {
		if (this.showingSessions) {
			this.hideSessionList();
		} else {
			this.showSessionList();
		}
	}

	private showSessionList(): void {
		this.showingSessions = true;
		this.sessionListEl.classList.remove("hidden");
		this.chatContainer.classList.add("hidden");
		this.inputArea.classList.add("hidden");
		this.renderSessionList();
	}

	private hideSessionList(): void {
		this.showingSessions = false;
		this.sessionListEl.classList.add("hidden");
		this.chatContainer.classList.remove("hidden");
		this.inputArea.classList.remove("hidden");
	}

	private renderSessionList(): void {
		this.sessionListEl.empty();

		const sessions = this.plugin.chatHistory.getSessions();
		if (sessions.length === 0) {
			this.sessionListEl.createDiv({
				cls: "pensieve-empty-sessions",
				text: "No chat history yet.",
			});
			return;
		}

		const backBtn = this.sessionListEl.createEl("button", {
			cls: "pensieve-action-btn pensieve-back-btn",
			text: "← Back to chat",
		});
		backBtn.addEventListener("click", () => this.hideSessionList());

		for (const session of sessions) {
			const item = this.sessionListEl.createDiv({
				cls: "pensieve-session-item",
			});

			const info = item.createDiv({ cls: "pensieve-session-info" });
			info.createDiv({
				cls: "pensieve-session-title",
				text: session.title,
			});
			info.createDiv({
				cls: "pensieve-session-date",
				text: new Date(session.updatedAt).toLocaleString(),
			});

			info.addEventListener("click", () => {
				this.plugin.chatHistory.setActiveSession(session.id);
				this.renderAllMessages();
				this.hideSessionList();
			});

			const deleteBtn = item.createEl("button", {
				cls: "pensieve-session-delete",
				attr: { "aria-label": "Delete session" },
			});
			setIcon(deleteBtn, "trash-2");
			deleteBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.plugin.chatHistory.deleteSession(session.id);
				this.plugin.saveChatHistory();
				this.renderSessionList();
			});
		}
	}

	// ── Message Rendering ─────────────────────────────────────
	private renderAllMessages(): void {
		this.chatContainer.empty();
		const session = this.plugin.chatHistory.getActiveSession();

		if (session.messages.length === 0) {
			this.renderWelcome();
			return;
		}

		for (const msg of session.messages) {
			if (msg.role === "system") continue;
			this.appendMessageBubble(msg);
		}

		this.scrollToBottom();
	}

	private renderWelcome(): void {
		const welcome = this.chatContainer.createDiv({
			cls: "pensieve-welcome",
		});
		const iconEl = welcome.createDiv({ cls: "pensieve-welcome-icon" });
		setIcon(iconEl, "brain");
		welcome.createEl("h3", { text: "Welcome to Pensieve" });
		welcome.createEl("p", {
			text: "Ask me anything about your vault. I'll search through your notes and provide contextual answers.",
		});
		const hint = welcome.createDiv({ cls: "pensieve-welcome-hint" });
		hint.createEl("p", {
			text: '💡 Tip: Run "Reindex Vault" first to enable context-aware answers.',
		});
	}

	private appendMessageBubble(msg: ChatMessage): HTMLElement {
		const bubble = this.chatContainer.createDiv({
			cls: `pensieve-bubble pensieve-bubble-${msg.role}`,
		});

		const contentEl = bubble.createDiv({ cls: "pensieve-bubble-content" });

		// Render markdown for assistant messages
		if (msg.role === "assistant") {
			MarkdownRenderer.render(
				this.app,
				msg.content || "...",
				contentEl,
				"",
				this
			);
		} else {
			contentEl.createDiv({
				cls: "pensieve-bubble-text",
				text: msg.content,
			});
		}

		// Source citations
		if (msg.sources && msg.sources.length > 0) {
			const sourcesEl = bubble.createDiv({
				cls: "pensieve-sources",
			});
			const toggle = sourcesEl.createEl("button", {
				cls: "pensieve-sources-toggle",
				text: `📎 ${msg.sources.length} source${msg.sources.length > 1 ? "s" : ""}`,
			});

			const sourceList = sourcesEl.createDiv({
				cls: "pensieve-sources-list hidden",
			});
			for (const src of msg.sources) {
				const srcItem = sourceList.createDiv({
					cls: "pensieve-source-item",
				});
				srcItem.createEl("a", {
					cls: "pensieve-source-link",
					text: src,
					href: src,
				});
				srcItem.addEventListener("click", (e) => {
					e.preventDefault();
					const file = this.app.vault.getAbstractFileByPath(src);
					if (file) {
						this.app.workspace.openLinkText(src, "", false);
					}
				});
			}

			toggle.addEventListener("click", () => {
				sourceList.classList.toggle("hidden");
			});
		}

		// Timestamp
		bubble.createDiv({
			cls: "pensieve-bubble-time",
			text: new Date(msg.timestamp).toLocaleTimeString(),
		});

		return bubble;
	}

	// ── Sending Messages ──────────────────────────────────────
	private async onSend(): Promise<void> {
		const text = this.textInput.value.trim();
		if (!text || this.isGenerating) return;

		this.isGenerating = true;
		this.abortSignal = { aborted: false };
		this.sendBtn.classList.add("disabled");
		this.textInput.value = "";
		this.textInput.style.height = "auto";

		// Add user message
		const userMsg: ChatMessage = {
			role: "user",
			content: text,
			timestamp: Date.now(),
		};
		this.plugin.chatHistory.addMessage(userMsg);
		this.appendMessageBubble(userMsg);
		this.scrollToBottom();

		// Show typing indicator
		const typingEl = this.chatContainer.createDiv({
			cls: "pensieve-typing",
		});
		typingEl.createSpan({ cls: "pensieve-typing-dot" });
		typingEl.createSpan({ cls: "pensieve-typing-dot" });
		typingEl.createSpan({ cls: "pensieve-typing-dot" });
		this.scrollToBottom();

		try {
			// Retrieve context
			const chunks = await this.plugin.retriever.retrieve(text);
			const context = this.plugin.retriever.buildContext(chunks);
			const sources = [
				...new Set(chunks.map((c) => c.filePath)),
			];

			// Build messages
			const history = this.plugin.chatHistory.getOllamaHistory();
			// Remove the last message since we add it in buildMessages
			history.pop();
			const messages = this.plugin.retriever.buildMessages(
				this.plugin.settings.systemPrompt,
				context,
				history,
				text
			);

			// Add placeholder assistant message
			const assistantMsg: ChatMessage = {
				role: "assistant",
				content: "",
				sources: sources.length > 0 ? sources : undefined,
				timestamp: Date.now(),
			};
			this.plugin.chatHistory.addMessage(assistantMsg);

			// Remove typing indicator
			typingEl.remove();

			// Create assistant bubble
			const bubble = this.appendMessageBubble(assistantMsg);
			const contentEl = bubble.querySelector(
				".pensieve-bubble-content"
			) as HTMLElement;

			let fullContent = "";

			// Stream the response
			await this.plugin.ollama.chat(
				this.plugin.settings.chatModel,
				messages,
				(token) => {
					fullContent += token;
					// Re-render markdown on each token
					contentEl.empty();
					MarkdownRenderer.render(
						this.app,
						fullContent,
						contentEl,
						"",
						this
					);
					this.scrollToBottom();
				},
				this.abortSignal
			);

			// Final update
			this.plugin.chatHistory.updateLastAssistantMessage(
				fullContent,
				sources.length > 0 ? sources : undefined
			);
		} catch (e) {
			typingEl.remove();

			const errorMsg: ChatMessage = {
				role: "assistant",
				content: `⚠️ **Error:** ${e}\n\nMake sure Ollama is running and the model \`${this.plugin.settings.chatModel}\` is available.`,
				timestamp: Date.now(),
			};
			this.plugin.chatHistory.addMessage(errorMsg);
			this.appendMessageBubble(errorMsg);
		} finally {
			this.isGenerating = false;
			this.sendBtn.classList.remove("disabled");
			this.scrollToBottom();
			this.plugin.saveChatHistory();
		}
	}

	private async onReindex(): Promise<void> {
		// Show inline progress
		const progressEl = this.chatContainer.createDiv({
			cls: "pensieve-progress",
		});
		const progressBar = progressEl.createDiv({
			cls: "pensieve-progress-bar",
		});
		const progressFill = progressBar.createDiv({
			cls: "pensieve-progress-fill",
		});
		const progressText = progressEl.createDiv({
			cls: "pensieve-progress-text",
			text: "Starting index...",
		});
		this.scrollToBottom();

		await this.plugin.indexer.indexVault((status, current, total) => {
			const pct = total > 0 ? (current / total) * 100 : 0;
			progressFill.style.width = `${pct}%`;
			progressText.setText(status);
		});

		// Update retriever's vector store reference
		this.plugin.retriever.setVectorStore(
			this.plugin.indexer.vectorStore
		);

		// Remove progress bar after a short delay
		setTimeout(() => {
			progressEl.remove();
		}, 2000);
	}

	private scrollToBottom(): void {
		requestAnimationFrame(() => {
			this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
		});
	}
}
