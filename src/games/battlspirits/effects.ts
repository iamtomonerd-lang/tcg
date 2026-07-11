/**
 * Battle Spirits effect engine. Processes all card effects from data.
 */

import type { CardDef, CardEffect, GameState, PlayerState } from './types.js';

/**
 * Apply a single effect to the game state. Pure function; state is cloned.
 */
export function applyEffect(
  state: GameState,
  effect: CardEffect,
  sourcePlayer: number,
  targetNexusIndex?: number,
): GameState {
  const next = cloneGameState(state);
  const me = next.players[sourcePlayer]!;
  const opponent = next.players[1 - sourcePlayer]!;

  switch (effect.action) {
    case 'damage': {
      const target = effect.target || 'opponent_hero';
      if (target === 'opponent_hero') {
        opponent.life -= effect.value ?? 1;
      } else if (target === 'opponent_creature' && targetNexusIndex !== undefined) {
        // TODO: damage creature (not in phase 1)
      }
      break;
    }
    case 'heal': {
      me.life += effect.value ?? 1;
      if (me.life > 20) me.life = 20; // Cap at starting life
      break;
    }
    case 'draw': {
      for (let i = 0; i < (effect.value ?? 1); i++) {
        const card = me.deck.shift();
        if (card) me.hand.push(card);
      }
      break;
    }
  }

  return next;
}

/**
 * Trigger effects matching a given trigger type (summon, attack, etc).
 */
export function triggerEffects(
  state: GameState,
  trigger: string,
  card: CardDef,
  sourcePlayer: number,
): GameState {
  let next = state;
  const effects = card.effects?.filter((e) => e.trigger === trigger) ?? [];
  for (const effect of effects) {
    next = applyEffect(next, effect, sourcePlayer);
  }
  return next;
}

// --- Helpers ---

function cloneGameState(state: GameState): GameState {
  return {
    players: [clonePlayerState(state.players[0]!), clonePlayerState(state.players[1]!)],
    currentPlayer: state.currentPlayer,
    turnCount: state.turnCount,
    battle: state.battle ? { ...state.battle } : null,
    result: state.result ? { ...state.result } : null,
  };
}

function clonePlayerState(p: PlayerState): PlayerState {
  return {
    life: p.life,
    cores: p.cores,
    hand: p.hand.slice(),
    deck: p.deck.slice(),
    spirits: p.spirits.map((s) => ({ ...s })),
    nexuses: p.nexuses.map((n) => ({ ...n })),
    trash: p.trash.slice(),
  };
}
