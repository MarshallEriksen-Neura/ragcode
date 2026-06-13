import type { ContextPack, ContextSnippet } from "../core/types.js";

export function formatContextAsMarkdown(pack: ContextPack): string {
  const sections: string[] = [];

  // Header
  sections.push(`# ${pack.query}`);
  sections.push('');
  sections.push(`**Confidence**: ${pack.confidence} | **Mode**: ${pack.mode}`);
  sections.push('');
  sections.push(pack.brief);
  sections.push('');

  // Primary Files
  if (pack.ownerChain.length > 0) {
    sections.push(`## 📁 Primary Files (${pack.ownerChain.length})`);
    sections.push('');

    pack.ownerChain.slice(0, 5).forEach((owner, i) => {
      sections.push(`${i + 1}. **${owner.filePath}** (score: ${owner.score.toFixed(1)})`);
      sections.push(`   ${owner.reason}`);

      if (owner.symbols.length > 0) {
        const symbolNames = owner.symbols.slice(0, 3).map(s => s.name).join(', ');
        const more = owner.symbols.length > 3 ? ` +${owner.symbols.length - 3} more` : '';
        sections.push(`   *Symbols*: ${symbolNames}${more}`);
      }

      // Display reasoning if available
      if ((owner as any).reasoning) {
        const reasoning = (owner as any).reasoning;
        const reasonParts: string[] = [];

        if (reasoning.matchedTerms?.length > 0) {
          reasonParts.push(`🎯 Matched: ${reasoning.matchedTerms.join(', ')}`);
        }

        if (reasoning.symbolMatches?.length > 0) {
          const match = reasoning.symbolMatches[0];
          reasonParts.push(`🔍 ${match.matchType} match on ${match.symbol}`);
        }

        if (reasoning.graphPosition) {
          reasonParts.push(`🔗 ${reasoning.graphPosition.hops} hops via ${reasoning.graphPosition.relationship}`);
        }

        if (reasonParts.length > 0) {
          sections.push(`   *Why relevant*: ${reasonParts.join(' • ')}`);
        }
      }

      sections.push('');
    });
  }

  // Code Snippets grouped by file
  if (pack.snippets.length > 0) {
    sections.push(`## 💻 Code Snippets (${pack.snippets.length})`);
    sections.push('');

    const byFile = groupSnippetsByFile(pack.snippets);

    for (const [filePath, snippets] of byFile.entries()) {
      sections.push(`### ${filePath}`);
      sections.push('');

      snippets.forEach((snippet) => {
        const lang = detectLanguage(filePath);
        sections.push(`**${snippet.role}** • Lines ${snippet.startLine}-${snippet.endLine} • Score: ${snippet.score.toFixed(1)}`);

        // Display reasoning if available
        if ((snippet as any).reasoning) {
          const reasoning = (snippet as any).reasoning;
          const reasonParts: string[] = [];

          if (reasoning.matchedTerms?.length > 0) {
            reasonParts.push(`Matched: ${reasoning.matchedTerms.slice(0, 3).join(', ')}`);
          }

          if (reasoning.symbolMatches?.length > 0) {
            const match = reasoning.symbolMatches[0];
            reasonParts.push(`${match.matchType} symbol match`);
          }

          if (reasonParts.length > 0) {
            sections.push(`*${reasonParts.join(' • ')}*`);
          }
        }

        sections.push(`\`\`\`${lang}`);
        sections.push(snippet.content);
        sections.push('```');
        sections.push('');
      });
    }
  }

  // Call Graph
  if (pack.topology && pack.topology.length > 0) {
    sections.push('## 🔗 Call Graph');
    sections.push('');
    sections.push('```');
    pack.topology.slice(0, 12).forEach(edge => {
      sections.push(`${edge.from} --${edge.edge}--> ${edge.to}`);
    });
    if (pack.topology.length > 12) {
      sections.push(`... +${pack.topology.length - 12} more edges`);
    }
    sections.push('```');
    sections.push('');
  }

  // Warnings & Limitations
  if (pack.missingEvidence.length > 0) {
    sections.push('## ⚠️ Limitations');
    sections.push('');
    pack.missingEvidence.forEach(msg => {
      sections.push(`- ${msg}`);
    });
    sections.push('');
  }

  // Footer
  sections.push('---');
  sections.push(`*Used ${pack.usedChars.toLocaleString()} / ${pack.budgetChars.toLocaleString()} chars*`);

  return sections.join('\n');
}

function groupSnippetsByFile(snippets: ContextSnippet[]): Map<string, ContextSnippet[]> {
  const grouped = new Map<string, ContextSnippet[]>();

  for (const snippet of snippets) {
    const existing = grouped.get(snippet.filePath) ?? [];
    existing.push(snippet);
    grouped.set(snippet.filePath, existing);
  }

  return grouped;
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'tsx',
    'js': 'javascript',
    'jsx': 'jsx',
    'py': 'python',
    'rs': 'rust',
    'go': 'go',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'md': 'markdown',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
  };

  return langMap[ext ?? ''] ?? '';
}
