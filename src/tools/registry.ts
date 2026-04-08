import type { Tool, ToolContext, ToolResult } from "./types";

export interface ParsedToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** Thrown when <tool_call> tags are present but contain invalid JSON. */
export class MalformedToolCallError extends Error {
	constructor(rawContent: string) {
		super("Malformed JSON in tool call: " + rawContent.slice(0, 200));
		this.name = "MalformedToolCallError";
	}
}

export class ToolRegistry {
	private tools: Map<string, Tool> = new Map();

	register(tool: Tool): void {
		this.tools.set(tool.name, tool);
	}

	get(name: string): Tool | undefined {
		return this.tools.get(name);
	}

	getAll(): Tool[] {
		return Array.from(this.tools.values());
	}

	async execute(
		toolName: string,
		args: Record<string, unknown>,
		ctx: ToolContext,
		onTrace?: (step: any) => void
	): Promise<ToolResult> {
		const tool = this.tools.get(toolName);
		if (!tool) {
			return { success: false, output: `Unknown tool: "${toolName}". Available: ${Array.from(this.tools.keys()).join(", ")}` };
		}
		const startedAt = Date.now();
		const prevToolName = ctx.currentToolName;
		ctx.currentToolName = toolName;
		try {
			const result = await tool.execute(args, ctx, onTrace);
			return {
				...result,
				executedAt: Date.now(),
				durationMs: Date.now() - startedAt,
			};
		} catch (e) {
			return {
				success: false,
				output: `Tool error: ${e}`,
				executedAt: Date.now(),
				durationMs: Date.now() - startedAt,
			};
		} finally {
			ctx.currentToolName = prevToolName;
		}
	}

	/** Generate the tool schema block injected into each agent's system prompt. */
	generateSchemaPrompt(): string {
		const tools = this.getAll();
		if (tools.length === 0) return "";
		const defs = tools.map((t) => {
			const params = t.parameters
				.map((p) => `    - ${p.name} (${p.type}${p.required ? ", required" : ", optional"}): ${p.description}`)
				.join("\n");
			return `### ${t.name}\n${t.description}\nParameters:\n${params}`;
		}).join("\n\n");
		return `\n\n## Available Tools\n\n${defs}`;
	}

	parseToolCall(text: string): ParsedToolCall | null {
		const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
		if (!match?.[1]) return null;
		try {
			const parsed = JSON.parse(match[1].trim()) as Record<string, unknown>;
			return {
				name: String(parsed["name"] ?? ""),
				arguments: (parsed["arguments"] ?? parsed["args"] ?? {}) as Record<string, unknown>,
			};
		} catch {
			throw new MalformedToolCallError(match[1].trim());
		}
	}

	parseThought(text: string): string | null {
		return text.match(/<thought>([\s\S]*?)<\/thought>/)?.[1]?.trim() ?? null;
	}

	parseFinalAnswer(text: string): string | null {
		return text.match(/<final_answer>([\s\S]*?)<\/final_answer>/)?.[1]?.trim() ?? null;
	}

	hasFinalAnswer(text: string): boolean {
		return /<final_answer>/.test(text);
	}
}
