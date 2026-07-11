import type { MiniState, PlayerState } from './state.js';

/** Render one player's public board line. */
function renderPlayer(p: PlayerState, idx: number, active: boolean): string {
  const marker = active ? '*' : ' ';
  const board = p.board.length
    ? p.board.map((c) => `${c.def.name}[${c.attack}/${c.health}]${c.canAttack ? '' : 'z'}`).join(' ')
    : '(empty)';
  return (
    `${marker}P${idx}  life:${String(p.life).padStart(3)}  ` +
    `mana:${p.mana}/${p.maxMana}  hand:${p.hand.length}  deck:${p.deck.length}\n` +
    `     board: ${board}`
  );
}

/** Full two-line-per-player snapshot of a state. `z` marks summoning sickness. */
export function renderState(state: MiniState): string {
  return [
    renderPlayer(state.players[0]!, 0, state.active === 0),
    renderPlayer(state.players[1]!, 1, state.active === 1),
  ].join('\n');
}
