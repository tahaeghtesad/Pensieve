import { Vault, normalizePath } from "obsidian";
import type { OllamaService, OllamaMessage } from "./ollama";
import type { ChatHistoryManager, ChatSession } from "./chathistory";
import type { PensieveSettings } from "./settings";
import { ensureFolder } from "./tools/notetools";

export class MemoryCompactor {
	private isCompacting = false;

	constructor(
		private vault: Vault,
		private ollama: OllamaService,
		private settings: PensieveSettings,
		private chatHistory: ChatHistoryManager
	) {}

	/**
	 * Checks if the active session requires summary compaction.
	 * If so, fires an asynchronous background LLM process.
	 */
	public async checkAndCompact(): Promise<void> {
		const session = this.chatHistory.getActiveSession();
		
		// Run every time a message resolves to keep the summary perpetually rolling
		if (this.isCompacting) return;
		this.isCompacting = true;
		try {
			await this.compactSession(session);
		} catch (e) {
			console.error("Pensieve Memory Compactor failed: ", e);
		} finally {
			this.isCompacting = false;
		}
	}

	private async compactSession(session: ChatSession): Promise<void> {
		const rawText = session.messages.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join("\n\n");
		
		const prompt = `You are a cognitive memory compression engine.
Your task is to summarize the following chat log into a SINGLE dense paragraph that captures the core topics, user requests, and assistant conclusions.
If there is an existing summary, update it with the new information. Keep it highly dense.
Do not add conversational fluff. Respond ONLY with the finalized summary paragraph.

Existing Summary: ${session.summary || "None"}

Chat Log:
${rawText}`;

		let newSummary = "";
		await this.ollama.chat(this.settings.chatModel, [{ role: "system", content: prompt }], (token) => {
			newSummary += token;
		});

		session.summary = newSummary.trim();
		session.summaryIteration = session.messages.length;
		
		// Write the summary to the physical vault for cross-session Semantic Vector integration!
		await this.persistToVault(session);
	}

	private async persistToVault(session: ChatSession): Promise<void> {
		const memDir = ".pensieve/chat_memories";
		await ensureFolder({ vault: this.vault } as any, memDir);
		
		const safeTitle = session.title.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "chat";
		const filePath = normalizePath(`${memDir}/session_${session.id}_${safeTitle}.md`);
		const summarizedAt = new Date().toISOString();
		const sequenceId = session.temporalSequence ?? session.messages.length;
		
		const content = `---
type: chat_memory
session_id: ${session.id}
created_at: ${new Date(session.createdAt).toISOString()}
updated_at: ${new Date(session.updatedAt).toISOString()}
event_time: ${summarizedAt}
sequence_id: ${sequenceId}
source_intent: archive_task
source_agent: compactor
source_tools:
  - memory_compactor
format_version: md-wiki-temporal-v1
migration_version: 1
tags:
  - pensieve/managed
  - pensieve/chat-memory
---
# Chat Session: ${session.title}

## Summary
${session.summary}

## Chronology
- ${summarizedAt} | seq:${sequenceId} | event:compaction | agent:compactor | tool:memory_compactor

## Related Notes
- [[Timeline]]

## Change Log
- ${summarizedAt} | compacted session memory (seq:${sequenceId})
`;
		
		const file = this.vault.getAbstractFileByPath(filePath);
		if (file) {
			// Update existing memory
			await this.vault.adapter.write(filePath, content);
		} else {
			// Write new memory
			await this.vault.create(filePath, content);
		}
	}
}
