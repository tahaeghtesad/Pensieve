import { DataAdapter } from "obsidian";

export interface GraphEdge {
	source: string;
	target: string;
	predicate: string; // "is a", "requires", "impacts", etc.
	weight?: number;
}

export interface GraphData {
	nodes: Set<string>;
	edges: GraphEdge[];
}

export class GraphStore {
	private nodes: Set<string> = new Set();
	private edges: GraphEdge[] = [];
	private adapter: DataAdapter;
	private storePath: string;

	constructor(adapter: DataAdapter, storePath = ".pensieve/knowledge_graph.json") {
		this.adapter = adapter;
		this.storePath = storePath;
	}

	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.storePath)) {
				const content = await this.adapter.read(this.storePath);
				const parsed = JSON.parse(content);
				this.nodes = new Set(parsed.nodes || []);
				this.edges = parsed.edges || [];
			}
		} catch (e) {
			console.error("Pensieve [GraphStore] Failed to load:", e);
		}
	}

	async save(): Promise<void> {
		try {
			const data = {
				nodes: Array.from(this.nodes),
				edges: this.edges,
			};
			await this.adapter.write(this.storePath, JSON.stringify(data, null, 2));
		} catch (e) {
			console.error("Pensieve [GraphStore] Failed to save:", e);
		}
	}

	addTriplet(subject: string, predicate: string, object: string): void {
		const normSubj = subject.trim().toLowerCase();
		const normObj = object.trim().toLowerCase();
		
		this.nodes.add(normSubj);
		this.nodes.add(normObj);

		// Deduplicate strict exact edge matching
		const exists = this.edges.some(
			e => e.source === normSubj && e.target === normObj && e.predicate === predicate.trim().toLowerCase()
		);
		
		if (!exists) {
			this.edges.push({
				source: normSubj,
				target: normObj,
				predicate: predicate.trim().toLowerCase()
			});
		}
	}

	/** Traverses X depth outward from the entry point */
	traverse(entryEntity: string, maxDepth: number = 2): string[] {
		const root = entryEntity.trim().toLowerCase();
		if (!this.nodes.has(root)) return [];

		const visited = new Set<string>();
		const queue: { node: string; depth: number }[] = [{ node: root, depth: 0 }];
		const resultingChains: string[] = [];

		while (queue.length > 0) {
			const { node, depth } = queue.shift()!;
			
			if (depth >= maxDepth) continue;
			if (visited.has(node)) continue;
			visited.add(node);

			// Find children nodes
			const outEdges = this.edges.filter(e => e.source === node);
			for (const edge of outEdges) {
				resultingChains.push(`[${edge.source}] --(${edge.predicate})--> [${edge.target}]`);
				queue.push({ node: edge.target, depth: depth + 1 });
			}
			
			// Let's also traverse incoming edges to trace antecedents (useful for root causes)
			const inEdges = this.edges.filter(e => e.target === node);
			for (const edge of inEdges) {
				resultingChains.push(`[${edge.source}] --(${edge.predicate})--> [${edge.target}]`);
				queue.push({ node: edge.source, depth: depth + 1 }); // We can bounce backwards occasionally
			}
		}

		// Deduplicate strings visually
		return Array.from(new Set(resultingChains));
	}
}
