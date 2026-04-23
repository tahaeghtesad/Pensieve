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
	
	private globalProgressContainer!: HTMLElement;
	private globalProgressFill!: HTMLElement;
	private globalProgressLabel!: HTMLElement;
	
	private boundProgressListener: (s: string, c: number, t: number) => void;

	constructor(leaf: WorkspaceLeaf, plugin: PensievePlugin) {
		super(leaf);
		this.plugin = plugin;
		
		this.boundProgressListener = (status, cur, total) => {
			if (!this.globalProgressContainer) return;
			
			if (status === "Indexing complete" || status.includes("failed")) {
				setTimeout(() => {
					if (this.globalProgressContainer) this.globalProgressContainer.classList.add("hidden");
				}, 2000);
			} else {
				this.globalProgressContainer.classList.remove("hidden");
			}
			
			if (this.globalProgressFill) {
				this.globalProgressFill.style.width = `${total > 0 ? (cur / total) * 100 : 0}%`;
			}
			if (this.globalProgressLabel) {
				this.globalProgressLabel.setText(status);
			}
		};
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

		// Global Progress Bar
		this.globalProgressContainer = root.createDiv({ cls: "pensieve-progress hidden" });
		const barWrap = this.globalProgressContainer.createDiv({ cls: "pensieve-progress-bar" });
		this.globalProgressFill = barWrap.createDiv({ cls: "pensieve-progress-fill" });
		this.globalProgressLabel = this.globalProgressContainer.createDiv({ cls: "pensieve-progress-text", text: "Ready" });

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
		
		this.plugin.indexer.addProgressListener(this.boundProgressListener);
		
		if (this.plugin.indexer.isIndexing) {
			this.boundProgressListener(
				this.plugin.indexer.progressStatus, 
				this.plugin.indexer.progressCurrent, 
				this.plugin.indexer.progressTotal
			);
		}
	}

	async onClose(): Promise<void> { 
		if (this.abortSignal) this.abortSignal.aborted = true; 
		this.plugin.indexer.removeProgressListener(this.boundProgressListener);
	}

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
			// Post-process: find file paths (e.g., "Research/Note.md" or "Folder/Note") and make them clickable
			this.linkifyVaultPaths(contentEl);
		} else {
			contentEl.createDiv({ cls: "pensieve-bubble-text", text: msg.content });
		}

		// Sources & Affected Files
		const meta = body.createDiv({ cls: "pensieve-bubble-meta" });
		if (msg.sources && msg.sources.length > 0) {
			this.renderFileList(meta, msg.sources, "📎", "sources");
		}
		if (msg.affectedFiles && msg.affectedFiles.length > 0) {
			this.renderFileList(meta, msg.affectedFiles, "✏️", "affected", true);
		}

		return bubble;
	}

	/**
	 * Post-process a rendered content element to find vault file paths and make them clickable.
	 * Detects patterns like `path/to/file.md` or backtick-wrapped paths.
	 */
	private linkifyVaultPaths(el: HTMLElement): void {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
		const textNodes: Text[] = [];
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			if (node.parentElement && node.parentElement.tagName === "A") continue;
			textNodes.push(node);
		}

		// Match file paths: word chars, slashes, spaces, hyphens ending in .md
		// The preceding boundary now includes `[` to properly catch [[File Name.md]]
		const pathRegex = /(?:^|[\s`"'(\[])(([\w\s\-./]+\.md))/g;

		for (const textNode of textNodes) {
			const text = textNode.textContent ?? "";
			if (!pathRegex.test(text)) continue;
			pathRegex.lastIndex = 0;

			const frag = document.createDocumentFragment();
			let lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = pathRegex.exec(text)) !== null) {
				const fullMatch = match[1]!;
				const filePath = fullMatch.trim();
				let matchStart = match.index + (match[0].length - match[1]!.length);
				let matchEnd = matchStart + fullMatch.length;

				// Check if wrapped in [[ ]]
				if (matchStart >= 2 && text.slice(matchStart - 2, matchStart) === "[[" &&
				    matchEnd <= text.length - 2 && text.slice(matchEnd, matchEnd + 2) === "]]") {
					matchStart -= 2; // Consume the [[
					matchEnd += 2;   // Consume the ]]
				}

				// Add text before the match
				if (matchStart > lastIndex) {
					frag.appendChild(document.createTextNode(text.slice(lastIndex, matchStart)));
				}

				// Create clickable link
				const link = document.createElement("a");
				link.className = "pensieve-inline-file-link";
				link.textContent = filePath;
				link.href = filePath;
				link.addEventListener("click", (e) => {
					e.preventDefault();
					this.app.workspace.openLinkText(filePath, "", false);
				});
				frag.appendChild(link);

				lastIndex = matchEnd;
			}

			if (lastIndex > 0) {
				if (lastIndex < text.length) {
					frag.appendChild(document.createTextNode(text.slice(lastIndex)));
				}
				textNode.parentNode?.replaceChild(frag, textNode);
			}
		}
	}

	private renderFileList(parent: HTMLElement, files: string[], icon: string, cls: string, expandedByDefault = false): void {
		const el = parent.createDiv({ cls: `pensieve-sources pensieve-${cls}` });
		const toggle = el.createEl("button", {
			cls: "pensieve-sources-toggle",
			text: `${icon} ${files.length} ${cls === "affected" ? "modified" : `source${files.length > 1 ? "s" : ""}`}`,
		});
		const list = el.createDiv({ cls: expandedByDefault ? "pensieve-sources-list" : "pensieve-sources-list hidden" });
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

	private traceStepCounter = 0;

	private createTraceContainer(): { wrap: HTMLDetailsElement; list: HTMLElement; toggle: HTMLElement } {
		const wrap = this.chatContainer.createEl("details", { cls: "pensieve-trace-details pensieve-trace" }) as HTMLDetailsElement;
		wrap.open = false; // Default to closed
		this.traceStepCounter = 0;
		const toggle = wrap.createEl("summary", { cls: "pensieve-trace-summary" });
		toggle.createSpan({ text: "⚙ Agent reasoning" });
		toggle.createSpan({ cls: "pensieve-trace-step-indicator", text: " (Step 0)..." });
		const list = wrap.createDiv({ cls: "pensieve-trace-list" });
		return { wrap, list, toggle };
	}

	private appendTraceStep(step: TraceStep, list: HTMLElement): void {
		let row: HTMLElement | null = null;
		let isUpdate = false;
		
		if (step.id) {
			const existing = list.querySelector(`[data-trace-id="${step.id}"]`);
			if (existing instanceof HTMLElement) {
				row = existing;
				row.empty(); // Clear existing content to rebuild it
				isUpdate = true;
			}
		}

		if (!isUpdate) {
			this.traceStepCounter++;
			// Update the dynamic step indicator in the summary
			const indicator = list.parentElement?.querySelector(".pensieve-trace-step-indicator");
			if (indicator) {
				indicator.textContent = ` (Step ${this.traceStepCounter})...`;
			}
			row = list.createDiv({ cls: `pensieve-trace-step pensieve-trace-${step.type}` });
			if (step.id) row.setAttribute("data-trace-id", step.id);
		}

		const icons: Record<string, string> = {
			thought: "💭", tool_call: "🔧", observation: "👁", agent_handoff: "→", error: "⚠️", prompt: "📥", raw_response: "💬"
		};
		// Show checkmark for completed tool calls
		row!.createSpan({ 
			cls: "pensieve-trace-icon", 
			text: (step.type === "tool_call" && step.isComplete) ? "✅" : (icons[step.type] ?? "•") 
		});
		const body = row!.createDiv({ cls: "pensieve-trace-body" });

		if (step.type === "raw_response") {
			const shell = body.createDiv({ cls: "pensieve-trace-response" });
			shell.createEl("strong", { text: "Model response" });
			const content = shell.createDiv({ cls: "pensieve-trace-response-content pensieve-bubble-content selectable" });
			MarkdownRenderer.render(this.app, step.content, content, "", this);
		} else if (step.type === "tool_call" && step.toolName) {
			body.createEl("strong", { text: `Used tool: ${step.toolName}` });
			
			if (step.toolArgs && Object.keys(step.toolArgs).length > 0) {
				const args = body.createEl("pre", { cls: "pensieve-trace-args selectable" });
				args.createEl("code", { text: JSON.stringify(step.toolArgs, null, 2) });
			}
			
			if (step.content) {
				const details = body.createEl("details", { cls: "pensieve-trace-details" });
				details.open = true;
				details.createEl("summary", { text: step.isComplete ? "Tool Output" : "Status" });
				const contentDiv = details.createDiv({ cls: "pensieve-trace-details-content selectable" });
				MarkdownRenderer.render(this.app, step.content, contentDiv, "", this);
			}
		} else if (step.type === "prompt") {
			// Parse the JSON messages and render as two readable boxes
			try {
				const messages = JSON.parse(step.content) as { role: string; content: string }[];
				const systemMsg = messages.find(m => m.role === "system");
				const userMessages = messages.filter(m => m.role === "user");
				const userMsg = userMessages[userMessages.length - 1];

				if (systemMsg) {
					const sysDetails = body.createEl("details", { cls: "pensieve-trace-details" });
					sysDetails.createEl("summary", { text: "System Prompt" });
					const sysContent = sysDetails.createDiv({ cls: "pensieve-trace-details-content pensieve-trace-prompt-box selectable" });
					MarkdownRenderer.render(this.app, systemMsg.content, sysContent, "", this);
				}

				if (userMsg) {
					const usrDetails = body.createEl("details", { cls: "pensieve-trace-details" });
					usrDetails.createEl("summary", { text: "User Input" });
					const usrContent = usrDetails.createDiv({ cls: "pensieve-trace-details-content pensieve-trace-prompt-box selectable" });
					MarkdownRenderer.render(this.app, userMsg.content, usrContent, "", this);
				}
			} catch {
				// Fallback: render as raw text if JSON parsing fails
				const details = body.createEl("details", { cls: "pensieve-trace-details" });
				details.createEl("summary", { text: "System & User Prompt" });
				const contentDiv = details.createDiv({ cls: "pensieve-trace-details-content selectable" });
				const pre = contentDiv.createEl("pre", { cls: "pensieve-trace-raw" });
				pre.createEl("code", { text: step.content });
			}
		} else {
			const box = body.createDiv({ cls: "pensieve-trace-details-content selectable" });
			box.style.marginTop = "2px"; // slightly less margin since there's no summary above it
			MarkdownRenderer.render(this.app, step.content, box, "", this);
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
		
		// Create reasoning drawer (defaults to closed, with dynamic step counter)
		const { wrap: traceWrap, list: traceList, toggle: traceToggle } = this.createTraceContainer();
		this.scrollToBottom();

		try {
			const isFirstMessage = activeSession.messages.filter(m => m.role === "user").length === 1;
			
			let context = "";
			let sources: string[] = [];
			
			if (isFirstMessage) {
				// RAG context (only done automatically on the first message)
				this.appendTraceStep({ type: "observation", content: "Retrieving initial context from vault..." }, traceList);
				this.scrollToBottom();
				
				const docs = await this.plugin.retriever.retrieve(text);
				context = this.plugin.retriever.buildContext(docs);
				sources = Array.from(new Set(docs.map((c: { filePath: string }) => c.filePath)));
				
				if (docs.length > 0) {
					const sourceList = sources.map(s => `- [[${s}]]`).join("\n");
					this.appendTraceStep({ 
						type: "observation", 
						content: `Retrieved ${docs.length} notes as initial context:\n${sourceList}` 
					}, traceList);
				}
				
				// Persist the context in the history so it's available for follow-up questions
				if (context) {
					userMsg.ragContext = context;
				}
			}

			const history = this.plugin.chatHistory.getOllamaHistory();
			history.pop(); // will be added by buildMessages / agent

			// Classify intent
			this.appendTraceStep({ type: "observation", content: "Analyzing task intent & routing..." }, traceList);
			this.scrollToBottom();
			const intent = await this.plugin.orchestrator.classify(text, this.abortSignal);
			
			this.appendTraceStep({ type: "agent_handoff", content: `Routed to **${intent}**` }, traceList);
			this.scrollToBottom();

			// ── All intents go through the agentic path ─────────────────
			this.plugin.toolCtx.temporalContext = {
				sessionId: activeSession.id,
				intent,
				agentName: intent,
				eventType: intent === "direct_chat" ? "chat" : "agent_run",
			};
			typing.remove();

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

			const result = await this.plugin.orchestrator.runAgentWithReflection(intent, agentCtx);

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

			// Fire trailing memory integration
			this.plugin.compactor.scheduleCompaction();
		} catch (e) {
			typing.remove();
			const errMsg: ChatMessage = {
				role: "assistant",
				content: `⚠️ **Error:** ${e}\n\nMake sure Ollama is running with \`${this.plugin.settings.chatModel}\`.`,
				timestamp: Date.now(),
			};
			this.plugin.chatHistory.addMessage(errMsg);
			const errorBubble = this.appendMessageBubble(errMsg);
			errorBubble.addClass("pensieve-bubble-error");
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
		this.globalProgressContainer.classList.remove("hidden");
		this.globalProgressLabel.setText("Starting index...");
		this.globalProgressFill.style.width = "0%";
		
		await this.plugin.indexer.indexVault();
		this.plugin.retriever.setVectorStore(this.plugin.indexer.vectorStore);
	}

	private scrollToBottom(): void {
		requestAnimationFrame(() => { this.chatContainer.scrollTop = this.chatContainer.scrollHeight; });
	}
}
