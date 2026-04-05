/** A chunk of text with metadata about where it came from. */
export interface Chunk {
	text: string;
	startOffset: number;
	endOffset: number;
}

/**
 * Split text into fixed-size character chunks with overlap.
 */
export function chunkText(
	text: string,
	chunkSize: number,
	chunkOverlap: number
): Chunk[] {
	const chunks: Chunk[] = [];
	if (!text || text.length === 0) return chunks;

	const step = Math.max(1, chunkSize - chunkOverlap);
	let i = 0;

	while (i < text.length) {
		const end = Math.min(i + chunkSize, text.length);
		chunks.push({
			text: text.slice(i, end),
			startOffset: i,
			endOffset: end,
		});
		if (end >= text.length) break;
		i += step;
	}

	return chunks;
}

/**
 * Split markdown text at heading boundaries, then sub-chunk each section
 * if it exceeds `chunkSize`.
 *
 * This preserves semantic boundaries (headings) so that retrieved chunks
 * are more coherent than naive fixed-size chunking.
 */
export function chunkMarkdown(
	text: string,
	chunkSize: number,
	chunkOverlap: number
): Chunk[] {
	if (!text || text.length === 0) return [];

	// Split on markdown headings (##, ###, ####, etc.)
	const headingRegex = /^(#{1,6}\s+.*)$/gm;
	const sections: { text: string; startOffset: number }[] = [];

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = headingRegex.exec(text)) !== null) {
		// Save everything before this heading as a section
		if (match.index > lastIndex) {
			const sectionText = text.slice(lastIndex, match.index);
			if (sectionText.trim().length > 0) {
				sections.push({
					text: sectionText,
					startOffset: lastIndex,
				});
			}
		}
		lastIndex = match.index;
	}

	// Capture the remaining text after the last heading
	if (lastIndex < text.length) {
		const sectionText = text.slice(lastIndex);
		if (sectionText.trim().length > 0) {
			sections.push({
				text: sectionText,
				startOffset: lastIndex,
			});
		}
	}

	// If no headings found, fall back to fixed-size chunking
	if (sections.length === 0) {
		return chunkText(text, chunkSize, chunkOverlap);
	}

	// Sub-chunk each section if it exceeds chunkSize
	const allChunks: Chunk[] = [];
	for (const section of sections) {
		if (section.text.length <= chunkSize) {
			allChunks.push({
				text: section.text,
				startOffset: section.startOffset,
				endOffset: section.startOffset + section.text.length,
			});
		} else {
			const subChunks = chunkText(
				section.text,
				chunkSize,
				chunkOverlap
			);
			for (const sub of subChunks) {
				allChunks.push({
					text: sub.text,
					startOffset: section.startOffset + sub.startOffset,
					endOffset: section.startOffset + sub.endOffset,
				});
			}
		}
	}

	return allChunks;
}
