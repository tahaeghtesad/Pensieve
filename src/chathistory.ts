import type { OllamaMessage } from "./ollama";

/** A chat message with UI metadata. */
export interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	ragContext?: string;
	sources?: string[];
	affectedFiles?: string[];
	timestamp: number;
	sequenceId?: number;
}

/** A named chat session. */
export interface ChatSession {
	id: string;
	title: string;
	messages: ChatMessage[];
	createdAt: number;
	updatedAt: number;
	summary?: string;
	summaryIteration?: number;
	temporalSequence?: number;
}

/** Persistent data shape saved via plugin.saveData(). */
export interface ChatHistoryData {
	sessions: ChatSession[];
	activeSessionId: string | null;
}

/**
 * Manages multiple chat sessions with persistence.
 */
export class ChatHistoryManager {
	private sessions: ChatSession[] = [];
	private activeSessionId: string | null = null;

	/** Load from persisted data. */
	load(data: ChatHistoryData | null): void {
		if (data) {
			this.sessions = data.sessions ?? [];
			this.activeSessionId = data.activeSessionId ?? null;
		}
	}

	/** Serialize for persistence. */
	serialize(): ChatHistoryData {
		return {
			sessions: this.sessions,
			activeSessionId: this.activeSessionId,
		};
	}

	/** Get or create the active session. */
	getActiveSession(): ChatSession {
		let session = this.sessions.find(
			(s) => s.id === this.activeSessionId
		);
		if (!session) {
			session = this.createSession();
		}
		return session;
	}

	/** Create a new session and make it active. */
	createSession(): ChatSession {
		const now = Date.now();
		const session: ChatSession = {
			id: `session-${now}-${Math.random().toString(36).slice(2, 8)}`,
			title: "New Chat",
			messages: [],
			createdAt: now,
			updatedAt: now,
			temporalSequence: 0,
		};
		this.sessions.unshift(session);
		this.activeSessionId = session.id;
		return session;
	}

	/** Switch to an existing session. */
	setActiveSession(id: string): ChatSession | null {
		const session = this.sessions.find((s) => s.id === id);
		if (session) {
			this.activeSessionId = session.id;
		}
		return session ?? null;
	}

	/** Add a message to the active session. */
	addMessage(msg: ChatMessage): void {
		const session = this.getActiveSession();
		if (typeof msg.sequenceId !== "number") {
			session.temporalSequence = (session.temporalSequence ?? 0) + 1;
			msg.sequenceId = session.temporalSequence;
		}
		session.messages.push(msg);
		session.updatedAt = Date.now();

		// Auto-title from first user message
		if (
			session.title === "New Chat" &&
			msg.role === "user" &&
			session.messages.filter((m) => m.role === "user").length === 1
		) {
			session.title =
				msg.content.length > 60
					? msg.content.slice(0, 57) + "..."
					: msg.content;
		}
	}

	/** Monotonic temporal sequence for ordering events in the active session. */
	nextTemporalSequence(): number {
		const session = this.getActiveSession();
		session.temporalSequence = (session.temporalSequence ?? 0) + 1;
		session.updatedAt = Date.now();
		return session.temporalSequence;
	}

	/** Update the last assistant message content (for streaming). */
	updateLastAssistantMessage(content: string, sources?: string[]): void {
		const session = this.getActiveSession();
		const lastMsg = session.messages[session.messages.length - 1];
		if (lastMsg && lastMsg.role === "assistant") {
			lastMsg.content = content;
			if (sources) lastMsg.sources = sources;
		}
	}

	/** Get all sessions (for session list UI). */
	getSessions(): ChatSession[] {
		return this.sessions;
	}

	/** Delete a session. */
	deleteSession(id: string): void {
		this.sessions = this.sessions.filter((s) => s.id !== id);
		if (this.activeSessionId === id) {
			this.activeSessionId =
				this.sessions.length > 0
					? (this.sessions[0]?.id ?? null)
					: null;
		}
	}

	/**
	 * Convert the active session's messages to OllamaMessage format
	 * (for context window construction).
	 */
	getOllamaHistory(): OllamaMessage[] {
		const session = this.getActiveSession();
		
		// If we have a summary, we only keep the last few raw messages to save context limit.
		// Otherwise we keep all (up to usual chat boundaries which is handled in React)
		const sliceStartIndex = session.summaryIteration && session.summaryIteration > 5 ? session.summaryIteration - 2 : 0;
		
		const rawMessages = session.messages
			.slice(sliceStartIndex)
			.filter((m) => m.role !== "system")
			.map((m) => ({
				role: m.role,
				content: m.ragContext ? `${m.ragContext}\n\n**User Question:**\n${m.content}` : m.content,
			}));

		if (session.summary) {
			rawMessages.unshift({
				role: "system",
				content: `[System Memory Tracker] Here is a rolling summary of the conversation prior to these recent messages:\n\n${session.summary}`
			});
		}
		
		return rawMessages;
	}
}
