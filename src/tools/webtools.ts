import { requestUrl, htmlToMarkdown } from "obsidian";
import type { Tool, ToolResult } from "./types";

export const searchWebTool: Tool = {
	name: "search_web",
	description: "Perform a web search for a query and return the top results with URLs.",
	parameters: [{ name: "query", type: "string", description: "Search query", required: true }],
	async execute(args, _ctx): Promise<ToolResult> {
		const query = String(args["query"] ?? "");
		try {
			const res = await requestUrl({
				url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
				}
			});
			
			const parser = new DOMParser();
			const doc = parser.parseFromString(res.text, "text/html");
			const results = Array.from(doc.querySelectorAll(".result__body")).slice(0, 5);
			
			if (results.length === 0) return { success: true, output: "No search results found." };
			
			const formatted = results.map((r, i) => {
				const titleEl = r.querySelector(".result__title a.result__url");
				const snippetEl = r.querySelector(".result__snippet");
				
				const title = titleEl ? titleEl.textContent?.trim() : "No title";
				const rawHref = titleEl ? titleEl.getAttribute("href") : "";
				
				let finalUrl = rawHref ?? "";
				const match = rawHref?.match(/uddg=([^&]+)/);
				if (match && match[1]) {
					try {
						finalUrl = decodeURIComponent(match[1]);
					} catch {
						finalUrl = match[1];
					}
				}
				
				const snippet = snippetEl?.textContent?.trim() ?? "";
				return `[${i + 1}] ${title}\nURL: ${finalUrl}\nSnippet: ${snippet}`;
			}).join("\n\n");
			
			return { success: true, output: formatted };
		} catch (e) {
			return { success: false, output: `Search failed: ${e}` };
		}
	}
};

export const readWebpageTool: Tool = {
	name: "read_webpage",
	description: "Fetch and read the content of a webpage. Returns markdown text.",
	parameters: [{ name: "url", type: "string", description: "The URL of the webpage to read", required: true }],
	async execute(args, _ctx): Promise<ToolResult> {
		const url = String(args["url"] ?? "");
		if (!url.startsWith("http")) return { success: false, output: "URL must start with http or https" };
		try {
			const res = await requestUrl({
				url,
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
				}
			});
			const parser = new DOMParser();
			const doc = parser.parseFromString(res.text, "text/html");
			
			// Clean up useless elements that distort text extracting
			const cleanup = doc.querySelectorAll("script, style, nav, footer, iframe, noscript, svg, header, .ad, .advertisement");
			cleanup.forEach(el => el.remove());
			
			// Focus on main content if it exists
			const main = doc.querySelector("main, article, .content, #content") || doc.body;
			const md = htmlToMarkdown(main.innerHTML);
			
			// Truncate to avoid context window explosion (gemma3:4b handles up to 8k native, though e2b can do more, let's cap at 15k chars to be safe)
			const content = md.length > 15000 ? md.slice(0, 15000) + "\n\n...[Content truncated]" : md;
			return { success: true, output: content };
		} catch (e) {
			return { success: false, output: `Failed to fetch webpage: ${e}` };
		}
	}
};

export function registerWebTools(registry: import("./registry").ToolRegistry): void {
	registry.register(searchWebTool);
	registry.register(readWebpageTool);
}
