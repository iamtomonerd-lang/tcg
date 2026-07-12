import type { CardDef, CardEffect } from './types.js';
import { getCardImageDataUrl } from './cardImages.js';

/**
 * Render a single card as markdown with embedded image.
 */
export function renderCardMarkdown(card: CardDef): string {
  const lines: string[] = [];

  // Card title and type
  lines.push(`## ${card.name} (${card.cardType.toUpperCase()})`);
  lines.push('');

  // Card image (if available)
  const imageDataUrl = getCardImageDataUrl(card);
  if (imageDataUrl) {
    lines.push(`![${card.name}](${imageDataUrl})`);
    lines.push('');
  } else if (card.imagePath) {
    // Show image path as fallback
    lines.push(`*Image: \`${card.imagePath}\`*`);
    lines.push('');
  }

  // Card stats
  lines.push('### Stats');
  lines.push(`- **Type:** ${card.cardType}`);
  lines.push(`- **Cost:** ${card.cost}`);
  lines.push(`- **Symbols:** ${card.symbols.join(', ')}`);
  if (card.exSymbol) {
    lines.push('- **EX Symbol:** Yes');
  }
  lines.push('');

  // Level stats
  lines.push('### Levels');
  lines.push(`- **Lv1:** Cost ${card.lv1.cost}, BP ${card.lv1.bp}`);
  if (card.lv2) {
    lines.push(`- **Lv2:** Cost ${card.lv2.cost}, BP ${card.lv2.bp}`);
  }
  lines.push('');

  // Effects
  if (card.effects && card.effects.length > 0) {
    lines.push('### Effects');
    for (const effect of card.effects) {
      lines.push(`- **[${effect.trigger}]** ${effect.action}`);
      if (effect.description) {
        lines.push(`  - ${effect.description}`);
      }
      if (effect.level) {
        lines.push(`  - Levels: ${effect.level.join(', ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render all cards as a markdown document.
 */
export function renderAllCardsMarkdown(cards: Record<string, CardDef>): string {
  const lines: string[] = [];

  lines.push('# Battle Spirits Card Database');
  lines.push('');
  lines.push('*Auto-generated from card definitions with images*');
  lines.push('');

  // Group by type
  const spirits = Object.values(cards).filter((c) => c.cardType === 'spirit');
  const nexuses = Object.values(cards).filter((c) => c.cardType === 'nexus');
  const magics = Object.values(cards).filter((c) => c.cardType === 'magic');

  if (spirits.length > 0) {
    lines.push('## Spirits');
    lines.push('');
    for (const card of spirits) {
      lines.push(renderCardMarkdown(card));
      lines.push('---');
      lines.push('');
    }
  }

  if (nexuses.length > 0) {
    lines.push('## Nexuses');
    lines.push('');
    for (const card of nexuses) {
      lines.push(renderCardMarkdown(card));
      lines.push('---');
      lines.push('');
    }
  }

  if (magics.length > 0) {
    lines.push('## Magic');
    lines.push('');
    for (const card of magics) {
      lines.push(renderCardMarkdown(card));
      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}
