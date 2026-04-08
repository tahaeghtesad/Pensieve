import { requestUrl, Notice } from "obsidian";

/** A single message in the Ollama chat format. */
export interface OllamaMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

/** Response shape from /api/tags */
interface OllamaTagsResponse {
	models: { name: string }[];
}

/** Streaming chat chunk */
interface OllamaChatChunk {
	model: string;
	message: OllamaMessage;
	done: boolean;
}

/** Embeddings response from /api/embed */
interface OllamaEmbedResponse {
	embeddings: number[][];
}

export class OllamaService {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	setBaseUrl(url: string): void {
		this.baseUrl = url.replace(/\/+$/, "");
	}

	/**
	 * Check that Ollama is reachable and return the list of available models.
	 */
	async checkConnection(): Promise<string[]> {
		try {
			const resp = await requestUrl({
				url: `${this.baseUrl}/api/tags`,
				method: "GET",
			});
			const body = resp.json as OllamaTagsResponse;
			return body.models.map((m) => m.name);
		} catch (e) {
			throw new Error(
				`Cannot reach Ollama at ${this.baseUrl}. Ensure Ollama is running.`
			);
		}
	}

	/**
	 * Send a chat completion request with streaming.
	 * Calls `onToken` for every token received, and returns the full response
	 * text once the stream ends.
	 */
	async chat(
		model: string,
		messages: OllamaMessage[],
		onToken: (token: string) => void,
		abortSignal?: { aborted: boolean }
	): Promise<string> {
		// We use fetch() directly for streaming — Obsidian's requestUrl
		// doesn't support ReadableStream.
		const resp = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				stream: true,
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			throw new Error(`Ollama chat error (${resp.status}): ${errText}`);
		}

		const reader = resp.body?.getReader();
		if (!reader) throw new Error("No response body from Ollama");

		const decoder = new TextDecoder();
		let fullContent = "";
		let buffer = "";

		while (true) {
			if (abortSignal?.aborted) {
				reader.cancel();
				break;
			}

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			// Each line is a JSON object
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				try {
					const chunk = JSON.parse(trimmed) as OllamaChatChunk;
					const token = chunk.message.content;
					if (token) {
						fullContent += token;
						onToken(token);
					}
				} catch (e) {
					console.error("[Pensieve] Malformed JSON in Ollama stream:", e);
					new Notice("Pensieve Error: Malformed JSON in Ollama stream — " + (e instanceof Error ? e.message : String(e)), 5000);
				}
			}
		}

		return fullContent;
	}

	/**
	 * Generate embeddings for one or more texts.
	 * Uses `/api/embed` (the modern batch endpoint).
	 */
	async embed(model: string, inputs: string[]): Promise<number[][]> {
		const resp = await requestUrl({
			url: `${this.baseUrl}/api/embed`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				input: inputs,
			}),
		});

		const body = resp.json as OllamaEmbedResponse;
		return body.embeddings;
	}
}
