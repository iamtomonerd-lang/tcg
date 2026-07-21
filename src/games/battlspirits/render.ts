import type { GameState } from './types.js';

export function renderState(state: GameState): string {
  const lines: string[] = [];
  lines.push('=== Battle Spirits ===');
  lines.push('');

  // Player 0 (top)
  const p0 = state.players[0]!;
  const mark0 = state.currentPlayer === 0 ? '*' : ' ';
  lines.push(`${mark0} P0  Life: ${String(p0.lifeZone.cores).padStart(2)} | Spirits: ${p0.spirits.length} | Nexuses: ${p0.nexuses.length} | Hand: ${p0.hand.length}`);
  lines.push(`     Cores: ${p0.cores} | Deck: ${p0.deck.length}`);
  if (p0.spirits.length > 0) {
    const spiritStrs = p0.spirits.map((s, i) => {
      const ready = s.canAttack ? '✓' : '✗';
      const stats = s.level === 1 ? s.def.lv1 : s.def.lv2 || s.def.lv1;
      return `[${i}] ${s.def.name} Lv${s.level} BP${stats.bp} ${ready}`;
    });
    lines.push(`     ${spiritStrs.join(' | ')}`);
  }
  lines.push('');

  // Player 1 (bottom)
  const p1 = state.players[1]!;
  const mark1 = state.currentPlayer === 1 ? '*' : ' ';
  lines.push(`${mark1} P1  Life: ${String(p1.lifeZone.cores).padStart(2)} | Spirits: ${p1.spirits.length} | Nexuses: ${p1.nexuses.length} | Hand: ${p1.hand.length}`);
  lines.push(`     Cores: ${p1.cores} | Deck: ${p1.deck.length}`);
  if (p1.spirits.length > 0) {
    const spiritStrs = p1.spirits.map((s, i) => {
      const ready = s.canAttack ? '✓' : '✗';
      const stats = s.level === 1 ? s.def.lv1 : s.def.lv2 || s.def.lv1;
      return `[${i}] ${s.def.name} Lv${s.level} BP${stats.bp} ${ready}`;
    });
    lines.push(`     ${spiritStrs.join(' | ')}`);
  }
  lines.push('');

  if (state.result) {
    if (state.result.winner === null) {
      lines.push('Result: Draw');
    } else {
      lines.push(`Result: P${state.result.winner} wins`);
    }
  }

  return lines.join('\n');
}
