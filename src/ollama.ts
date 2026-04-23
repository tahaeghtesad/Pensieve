import { requestUrl, Notice } from "obsidian";

/** A single message in the Ollama chat format. */
export interface OllamaMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: OllamaToolCall[];
}

/** A tool call returned by the model when using native tool calling. */
export interface OllamaToolCall {
	function: {
		name: string;
		arguments: Record<string, unknown>;
	};
}

/** Schema for a single tool definition sent in the Ollama API payload. */
export interface OllamaToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			required: string[];
			properties: Record<string, { type: string; description: string }>;
		};
	};
}

/** Full response from a non-streaming /api/chat call. */
export interface OllamaChatResponse {
	model: string;
	message: OllamaMessage;
	done: boolean;
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
	 * Send a non-streaming chat request with native tool definitions.
	 * Returns the full response including any `tool_calls` the model wants to make.
	 * Used for intermediate ReAct steps where we need structured tool invocations.
	 */
	async chatWithTools(
		model: string,
		messages: OllamaMessage[],
		tools: OllamaToolDef[],
		abortSignal?: { aborted: boolean }
	): Promise<OllamaChatResponse> {
		if (abortSignal?.aborted) {
			return { model, message: { role: "assistant", content: "Generation aborted." }, done: true };
		}

		const resp = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				tools: tools.length > 0 ? tools : undefined,
				stream: false,
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			throw new Error(`Ollama chat error (${resp.status}): ${errText}`);
		}

		const body = await resp.json() as OllamaChatResponse;
		return body;
	}

	/**
	 * Send a non-streaming chat request with JSON format mode.
	 * Forces the model to output valid JSON.
	 */
	async chatJSON(
		model: string,
		messages: OllamaMessage[],
		abortSignal?: { aborted: boolean }
	): Promise<string> {
		if (abortSignal?.aborted) return "{}";

		const resp = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages,
				format: "json",
				stream: false,
			}),
		});

		if (!resp.ok) {
			const errText = await resp.text();
			throw new Error(`Ollama chat error (${resp.status}): ${errText}`);
		}

		const body = await resp.json() as OllamaChatResponse;
		return body.message.content;
	}

	/**
	 * Generate embeddings for one or more texts.
	 * Uses `/api/embed` (the modern batch endpoint).
	 */
	async embed(model: string, inputs: string[]): Promise<number[][]> {
		try {
			const resp = await requestUrl({
				url: `${this.baseUrl}/api/embed`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					input: inputs,
				}),
				throw: false, // We'll handle the status ourselves
			});

			// If the server doesn't support the modern /api/embed endpoint, fallback to older API
			if (resp.status === 501 || resp.status === 404) {
				console.warn(`[Pensieve] /api/embed returned ${resp.status}, falling back to /api/embeddings...`);
				return await this.embedFallback(model, inputs);
			}

			if (resp.status >= 400) {
				throw new Error(`Ollama embed error (${resp.status}): ${resp.text}`);
			}

			const body = resp.json as OllamaEmbedResponse;
			return body.embeddings;
		} catch (e: any) {
			console.error("[Pensieve] Embed error:", e);
			const msg = e.message || String(e);
			if (msg.includes("501")) {
				throw new Error("501 Not Implemented: Your proxy or Ollama server doesn't support the modern embedding endpoint, and fallback failed.");
			}
			throw new Error(`Embedding request failed: ${msg}`);
		}
	}

	/** Fallback using the older, single-prompt /api/embeddings endpoint. */
	private async embedFallback(model: string, inputs: string[]): Promise<number[][]> {
		const embeddings: number[][] = [];
		for (const input of inputs) {
			const resp = await requestUrl({
				url: `${this.baseUrl}/api/embeddings`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					prompt: input,
				}),
				throw: false,
			});
			
			if (resp.status >= 400) {
				throw new Error(`Fallback embed error (${resp.status}): ${resp.text}`);
			}
			
			embeddings.push(resp.json.embedding);
		}
		return embeddings;
	}
}
