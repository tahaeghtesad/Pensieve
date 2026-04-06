import {
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	setIcon,
	TFile,
} from "obsidian";
import type { default as PensievePlugin } from "./main";
import type { ChatMessage } from "./chathistory";
import type { AgentContext, TraceStep } from "./agents/types";

export const VIEW_TYPE_PENSIEVE_CHAT = "pensieve-chat-view";

export class PensieveChatView extends ItemView {
	plugin: PensievePlugin;
	private statusDot!: HTMLElement;
	private statusText!: HTMLElement;
	private chatContainer!: HTMLElement;
	private inputArea!: HTMLElement;
	private textInput!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private sessionListEl!: HTMLElement;
	private showingSessions = false;
	private isGenerating = false;
	private abortSignal = { aborted: false };

	constructor(leaf: WorkspaceLeaf, plugin: PensievePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE_PENSIEVE_CHAT; }
	getDisplayText(): string { return "Pensieve"; }
	getIcon(): string { return "brain"; }

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("pensieve-root");

		// Header
		const header = root.createDiv({ cls: "pensieve-header" });
		const titleRow = header.createDiv({ cls: "pensieve-header-title-row" });
		const titleEl = titleRow.createEl("span", { cls: "pensieve-title", text: "Pensieve" });
		setIcon(titleEl.createSpan({ cls: "pensieve-title-icon" }), "brain");

		const statusEl = titleRow.createDiv({ cls: "pensieve-status" });
		this.statusDot = statusEl.createSpan({ cls: "pensieve-status-dot" });
		this.statusText = statusEl.createSpan({ cls: "pensieve-status-text", text: "Checking..." });

		const actions = header.createDiv({ cls: "pensieve-header-actions" });
		const mkBtn = (icon: string, label: string, fn: () => void) => {
			const b = actions.createEl("button", { cls: "pensieve-action-btn", attr: { title: label } });
			setIcon(b, icon); b.addEventListener("click", fn); return b;
		};
		mkBtn("plus", "New Chat", () => this.onNewChat());
		mkBtn("history", "Chat History", () => this.toggleSessionList());
		mkBtn("refresh-cw", "Reindex Vault", () => this.onReindex());

		this.sessionListEl = root.createDiv({ cls: "pensieve-session-list hidden" });
		this.chatContainer = root.createDiv({ cls: "pensieve-chat" });
		this.inputArea = root.createDiv({ cls: "pensieve-input-area" });

		this.textInput = this.inputArea.createEl("textarea", {
			cls: "pensieve-input",
			attr: { placeholder: "Ask or instruct… (e.g. 'Add a daily note', 'Review my plan')", rows: "1" },
		});
		this.sendBtn = this.inputArea.createEl("button", { cls: "pensieve-send-btn", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "send");

		this.textInput.addEventListener("input", () => {
			this.textInput.style.height = "auto";
			this.textInput.style.height = Math.min(this.textInput.scrollHeight, 150) + "px";
		});
		this.textInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.onSend(); }
		});
		this.sendBtn.addEventListener("click", () => {
			if (this.isGenerating) {
				if (this.abortSignal) this.abortSignal.aborted = true;
				return;
			}
			this.onSend().catch(e => console.error(e));
		});

		this.renderAllMessages();
		this.checkOllamaStatus();
	}

	async onClose(): Promise<void> { if (this.abortSignal) this.abortSignal.aborted = true; }

	// ── Status ────────────────────────────────────────────────
	private async checkOllamaStatus(): Promise<void> {
		try {
			await this.plugin.ollama.checkConnection();
			this.statusDot.className = "pensieve-status-dot connected";
			this.statusText.setText("Connected");
		} catch {
			this.statusDot.className = "pensieve-status-dot disconnected";
			this.statusText.setText("Disconnected");
		}
	}

	// ── Session management ────────────────────────────────────
	private onNewChat(): void {
		this.plugin.chatHistory.createSession();
		this.renderAllMessages();
		this.hideSessionList();
		this.plugin.saveChatHistory();
	}

	private toggleSessionList(): void {
		this.showingSessions ? this.hideSessionList() : this.showSessionList();
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
		
		const headerWrap = this.sessionListEl.createDiv({ cls: "pensieve-session-list-header" });
		const back = headerWrap.createEl("button", { cls: "pensieve-action-btn pensieve-back-btn", text: "← Back to chat" });
		back.addEventListener("click", () => this.hideSessionList());

		const searchInput = headerWrap.createEl("input", { 
			type: "text", 
			cls: "pensieve-session-search", 
			placeholder: "Search past chats..." 
		});

		const listWrap = this.sessionListEl.createDiv({ cls: "pensieve-sessions-container" });

		const renderItems = (query: string) => {
			listWrap.empty();
			const filtered = sessions.filter((s: import("./chathistory").ChatSession) => s.title.toLowerCase().includes(query.toLowerCase()) || (s.summary && s.summary.toLowerCase().includes(query.toLowerCase())));
			
			if (filtered.length === 0) {
				listWrap.createDiv({ cls: "pensieve-empty-sessions", text: sessions.length === 0 ? "No chat history yet." : "No matching sessions." });
				return;
			}
			
			for (const s of filtered) {
				const item = listWrap.createDiv({ cls: "pensieve-session-item" });
				const info = item.createDiv({ cls: "pensieve-session-info" });
				info.createDiv({ cls: "pensieve-session-title", text: s.title });
				info.createDiv({ cls: "pensieve-session-date", text: new Date(s.updatedAt).toLocaleString() });
				info.addEventListener("click", () => {
					this.plugin.chatHistory.setActiveSession(s.id);
					this.renderAllMessages();
					this.hideSessionList();
				});
				const del = item.createEl("button", { cls: "pensieve-session-delete", attr: { "aria-label": "Delete" } });
				setIcon(del, "trash-2");
				del.addEventListener("click", async (e) => {
					e.stopPropagation();
					this.plugin.chatHistory.deleteSession(s.id);
					this.plugin.saveChatHistory();
					
					const fp = `.pensieve/chat_memories/session-${s.id}.md`;
					if (await this.app.vault.adapter.exists(fp)) {
						await this.app.vault.adapter.remove(fp);
					}
					
					if (this.plugin.chatHistory.getActiveSession()?.id !== s.id) {
					    this.renderAllMessages();
					}
					renderItems(searchInput.value);
				});
			}
		};

		searchInput.addEventListener("input", () => renderItems(searchInput.value));
		renderItems("");
	}

	// ── Message rendering ────────────────────────────────────
	private renderAllMessages(): void {
		this.chatContainer.empty();
		const session = this.plugin.chatHistory.getActiveSession();
		if (!session) { this.renderWelcome(); return; }
		if (session.messages.length === 0) { this.renderWelcome(); return; }
		for (const msg of session.messages) {
			if (msg.role === "system") continue;
			this.appendMessageBubble(msg);
		}
		this.scrollToBottom();
	}

	private renderWelcome(): void {
		const w = this.chatContainer.createDiv({ cls: "pensieve-welcome" });
		setIcon(w.createDiv({ cls: "pensieve-welcome-icon" }), "brain");
		w.createEl("h3", { text: "Welcome to Pensieve" });
		w.createEl("p", { text: "Ask questions about your vault or give instructions to modify it." });
		const hint = w.createDiv({ cls: "pensieve-welcome-hint" });
		hint.createEl("p", { text: "💡 Examples:" });
		const examples = [
			"Ask: \"What did I write about machine learning?\"",
			"Write: \"Add a daily note: worked on Pensieve plugin\"",
			"Plan: \"Create a reading plan for my ML papers\"",
			"Review: \"Review my Project Alpha note\"",
			"Fact-check: \"Verify claims in my AI Research note\"",
		];
		for (const ex of examples) hint.createEl("p", { text: ex, cls: "pensieve-welcome-example" });
	}

	private appendMessageBubble(msg: ChatMessage): HTMLElement {
		const bubble = this.chatContainer.createDiv({ cls: `pensieve-bubble pensieve-bubble-${msg.role}` });
		
		const avatar = bubble.createDiv({ cls: "pensieve-bubble-avatar" });
		setIcon(avatar, msg.role === "user" ? "user" : "bot");

		const body = bubble.createDiv({ cls: "pensieve-bubble-body" });
		const header = body.createDiv({ cls: "pensieve-bubble-header" });
		header.createSpan({ cls: "pensieve-bubble-name", text: msg.role === "user" ? "You" : "Pensieve" });
		
		const contentEl = body.createDiv({ cls: "pensieve-bubble-content" });

		if (msg.role === "assistant") {
			MarkdownRenderer.render(this.app, msg.content || "...", contentEl, "", this);
		} else {
			contentEl.createDiv({ cls: "pensieve-bubble-text", text: msg.content });
		}

		// Sources & Affected Files
		const meta = body.createDiv({ cls: "pensieve-bubble-meta" });
		if (msg.sources && msg.sources.length > 0) {
			this.renderFileList(meta, msg.sources, "📎", "sources");
		}
		if (msg.affectedFiles && msg.affectedFiles.length > 0) {
			this.renderFileList(meta, msg.affectedFiles, "✏️", "affected");
		}

		return bubble;
	}

	private renderFileList(parent: HTMLElement, files: string[], icon: string, cls: string): void {
		const el = parent.createDiv({ cls: `pensieve-sources pensieve-${cls}` });
		const toggle = el.createEl("button", {
			cls: "pensieve-sources-toggle",
			text: `${icon} ${files.length} ${cls === "affected" ? "modified" : `source${files.length > 1 ? "s" : ""}`}`,
		});
		const list = el.createDiv({ cls: "pensieve-sources-list hidden" });
		for (const f of files) {
			const item = list.createDiv({ cls: "pensieve-source-item" });
			const a = item.createEl("a", { cls: "pensieve-source-link", text: f, href: f });
			a.addEventListener("click", (e) => {
				e.preventDefault();
				this.app.workspace.openLinkText(f, "", false);
			});
		}
		toggle.addEventListener("click", () => list.classList.toggle("hidden"));
	}

	private createTraceContainer(): { wrap: HTMLDetailsElement; list: HTMLElement; toggle: HTMLElement } {
		const wrap = this.chatContainer.createEl("details", { cls: "pensieve-trace-details pensieve-trace" }) as HTMLDetailsElement;
		wrap.open = true; // Show reasoning automatically
		const toggle = wrap.createEl("summary", { cls: "pensieve-trace-summary", text: "⚙ Pensieve's thought process..." });
		const list = wrap.createDiv({ cls: "pensieve-trace-list" });
		return { wrap, list, toggle };
	}

	private appendTraceStep(step: TraceStep, list: HTMLElement): void {
		const row = list.createDiv({ cls: `pensieve-trace-step pensieve-trace-${step.type}` });
		const icons: Record<string, string> = {
			thought: "💭", tool_call: "🔧", observation: "👁", agent_handoff: "→", error: "⚠️", prompt: "📥"
		};
		row.createSpan({ cls: "pensieve-trace-icon", text: icons[step.type] ?? "•" });
		const body = row.createDiv({ cls: "pensieve-trace-body" });

		if (step.type === "tool_call" && step.toolName) {
			body.createEl("strong", { text: `Used tool: ${step.toolName}` });
			if (step.toolArgs && Object.keys(step.toolArgs).length > 0) {
				const args = body.createEl("pre", { cls: "pensieve-trace-args selectable" });
				args.createEl("code", { text: JSON.stringify(step.toolArgs, null, 2) });
			}
		} else if (step.type === "observation" || step.type === "prompt") {
			const details = body.createEl("details", { cls: "pensieve-trace-details" });
			const titleMap: Record<string, string> = {
				observation: "Tool Output",
				prompt: "System & User Prompt"
			};
			details.createEl("summary", { text: titleMap[step.type] ?? "Output" });
			const contentDiv = details.createDiv({ cls: "pensieve-trace-details-content selectable" });

			if (step.type === "prompt") {
				const pre = contentDiv.createEl("pre", { cls: "pensieve-trace-raw" });
				pre.createEl("code", { text: step.content });
			} else {
				MarkdownRenderer.render(this.app, step.content, contentDiv, "", this);
			}
		} else {
			MarkdownRenderer.render(this.app, step.content, body, "", this);
		}
	}

	// ── Typing indicator ──────────────────────────────────────
	private showTyping(): HTMLElement {
		const el = this.chatContainer.createDiv({ cls: "pensieve-bubble pensieve-typing" });
		const avatar = el.createDiv({ cls: "pensieve-bubble-avatar" });
		setIcon(avatar, "bot");
		
		const body = el.createDiv({ cls: "pensieve-bubble-body" });
		const header = body.createDiv({ cls: "pensieve-bubble-header" });
		header.createSpan({ cls: "pensieve-bubble-name", text: "Pensieve is thinking..." });
		
		this.scrollToBottom();
		return el;
	}

	// ── Send ──────────────────────────────────────────────────
	private async onSend(): Promise<void> {
		const text = this.textInput.value.trim();
		if (!text || this.isGenerating) return;

		this.isGenerating = true;
		this.abortSignal = { aborted: false };
		setIcon(this.sendBtn, "square");
		this.sendBtn.setAttribute("aria-label", "Stop");
		
		this.textInput.value = "";
		this.textInput.style.height = "auto";

		const userMsg: ChatMessage = { role: "user", content: text, timestamp: Date.now() };
		this.plugin.chatHistory.addMessage(userMsg);
		this.appendMessageBubble(userMsg);
		const activeSession = this.plugin.chatHistory.getActiveSession();
		this.plugin.toolCtx.temporalContext = {
			sessionId: activeSession.id,
			intent: "direct_chat",
			agentName: "direct_chat",
			eventType: "chat",
		};

		const typing = this.showTyping();
		
		// Immediately open the reasoning drawer to stream what happened behind the scenes
		const { wrap: traceWrap, list: traceList, toggle: traceToggle } = this.createTraceContainer();
		traceWrap.open = true;
		this.scrollToBottom();

		try {
			// RAG context (used by both paths)
			this.appendTraceStep({ type: "observation", content: "Retrieving relevant context from vault..." }, traceList);
			this.scrollToBottom();
			
			const chunks = await this.plugin.retriever.retrieve(text);
			const context = this.plugin.retriever.buildContext(chunks);
			const sources: string[] = Array.from(new Set(chunks.map((c: { filePath: string }) => c.filePath)));
			
			if (chunks.length > 0) {
				this.appendTraceStep({ type: "observation", content: `Retrieved ${chunks.length} notes as context.` }, traceList);
			}

			const history = this.plugin.chatHistory.getOllamaHistory();
			history.pop(); // will be added by buildMessages / agent

			// Classify intent
			this.appendTraceStep({ type: "observation", content: "Analyzing task intent & routing..." }, traceList);
			this.scrollToBottom();
			const intent = await this.plugin.orchestrator.classify(text, this.abortSignal);
			
			this.appendTraceStep({ type: "agent_handoff", content: `Routed to **${intent}**` }, traceList);
			this.scrollToBottom();

			if (intent === "direct_chat") {
				this.plugin.toolCtx.temporalContext = {
					sessionId: activeSession.id,
					intent,
					agentName: "direct_chat",
					eventType: "chat",
				};
				traceWrap.open = false; // Hide trace container for simple chat
				traceToggle.setText(`⚙ System Trace (${traceList.children.length} steps) — click to expand`);
				
				// ── Streaming Q&A (unchanged) ────────────────────
				const messages = this.plugin.retriever.buildMessages(
					this.plugin.settings.systemPrompt, context, history, text
				);
				const assistantMsg: ChatMessage = {
					role: "assistant", content: "",
					sources: sources.length > 0 ? sources : undefined, timestamp: Date.now(),
				};
				this.plugin.chatHistory.addMessage(assistantMsg);
				typing.remove();

				const bubble = this.appendMessageBubble(assistantMsg);
				const contentEl = bubble.querySelector(".pensieve-bubble-content") as HTMLElement;
				let fullContent = "";

				await this.plugin.ollama.chat(this.plugin.settings.chatModel, messages, (token: string) => {
					fullContent += token;
					contentEl.empty();
					MarkdownRenderer.render(this.app, fullContent, contentEl, "", this);
					this.scrollToBottom();
				}, this.abortSignal);

				this.plugin.chatHistory.updateLastAssistantMessage(fullContent, sources.length > 0 ? sources : undefined);

				// Fire trailing memory integration empty
				this.plugin.compactor.checkAndCompact();

			} else {
				// ── Agentic path ─────────────────────────────────
				this.plugin.toolCtx.temporalContext = {
					sessionId: activeSession.id,
					intent,
					agentName: intent,
					eventType: "agent_run",
				};
				typing.remove();
				// Trace container already created and open; we just keep appending to it!

				const agentCtx: AgentContext = {
					userQuery: text,
					chatHistory: history,
					ragContext: context,
					toolCtx: this.plugin.toolCtx,
					toolRegistry: this.plugin.toolRegistry,
					ollama: this.plugin.ollama,
					settings: this.plugin.settings,
					abortSignal: this.abortSignal,
					onTrace: (step: TraceStep) => {
						this.appendTraceStep(step, traceList);
						this.scrollToBottom();
					},
				};

				const result = await this.plugin.orchestrator.runAgent(intent, agentCtx);

				// Update trace toggle label and collapse it
				traceWrap.open = false;
				traceToggle.setText(`⚙ Reasoning (${result.traceSteps.length} steps) — click to expand`);

				// Render final answer bubble
				const assistantMsg: ChatMessage = {
					role: "assistant",
					content: result.answer,
					sources: sources.length > 0 ? sources : undefined,
					affectedFiles: result.affectedFiles.length > 0 ? result.affectedFiles : undefined,
					timestamp: Date.now(),
				};
				this.plugin.chatHistory.addMessage(assistantMsg);
				this.appendMessageBubble(assistantMsg);

				// Re-index modified files
				for (const fp of result.affectedFiles) {
					const file = this.app.vault.getAbstractFileByPath(fp);
					if (file instanceof TFile) {
						await this.plugin.indexer.indexFile(file);
					}
				}
				if (result.affectedFiles.length > 0) {
					this.plugin.retriever.setVectorStore(this.plugin.indexer.vectorStore);
				}

				// Fire trailing memory integration asynchronous loop
				this.plugin.compactor.checkAndCompact();
			}
		} catch (e) {
			typing.remove();
			const errMsg: ChatMessage = {
				role: "assistant",
				content: `⚠️ **Error:** ${e}\n\nMake sure Ollama is running with \`${this.plugin.settings.chatModel}\`.`,
				timestamp: Date.now(),
			};
			this.plugin.chatHistory.addMessage(errMsg);
			this.appendMessageBubble(errMsg);
		} finally {
			this.isGenerating = false;
			setIcon(this.sendBtn, "send");
			this.sendBtn.setAttribute("aria-label", "Send");
			this.scrollToBottom();
			this.plugin.saveChatHistory();
		}
	}

	// ── Reindex ───────────────────────────────────────────────
	private async onReindex(): Promise<void> {
		const prog = this.chatContainer.createDiv({ cls: "pensieve-progress" });
		const fill = prog.createDiv({ cls: "pensieve-progress-bar" }).createDiv({ cls: "pensieve-progress-fill" });
		const label = prog.createDiv({ cls: "pensieve-progress-text", text: "Starting index..." });
		this.scrollToBottom();

		await this.plugin.indexer.indexVault((status: string, cur: number, total: number) => {
			fill.style.width = `${total > 0 ? (cur / total) * 100 : 0}%`;
			label.setText(status);
		});
		this.plugin.retriever.setVectorStore(this.plugin.indexer.vectorStore);
		setTimeout(() => prog.remove(), 2000);
	}

	private scrollToBottom(): void {
		requestAnimationFrame(() => { this.chatContainer.scrollTop = this.chatContainer.scrollHeight; });
	}
}
