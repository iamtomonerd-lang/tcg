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
  spirit?: any, // the spirit triggering the effect
): GameState {
  const next = cloneGameState(state);
  const me = next.players[sourcePlayer]!;
  const opponent = next.players[1 - sourcePlayer]!;

  // Check effect conditions
  if (effect.condition) {
    if (effect.condition.level && spirit && spirit.level !== effect.condition.level) {
      return next;
    }
    if (effect.condition.minHandSize && me.hand.length < effect.condition.minHandSize) {
      return next;
    }
  }

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
    case 'boost_bp': {
      // Boost the spirit's BP temporarily (stored as a modifier in spirit state)
      if (spirit) {
        spirit.bpBoost = (spirit.bpBoost ?? 0) + (effect.value ?? 1);
      }
      break;
    }
    case 'search_deck': {
      // Search deck for cards with matching symbol
      const searchCount = effect.value ?? 1;
      const targetSymbol = effect.symbol;
      let found = 0;
      for (let i = 0; i < me.deck.length && found < searchCount; i++) {
        const card = me.deck[i]!;
        if (!targetSymbol || card.symbols.includes(targetSymbol)) {
          me.hand.push(card);
          me.deck.splice(i, 1);
          i--;
          found++;
        }
      }
      break;
    }
    case 'destroy_creature': {
      // Destroy opponent's spirit
      if (opponent.spirits.length > 0) {
        opponent.spirits.pop();
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
  spirit?: any,
): GameState {
  let next = state;
  const effects = card.effects?.filter((e) => e.trigger === trigger) ?? [];
  for (const effect of effects) {
    next = applyEffect(next, effect, sourcePlayer, undefined, spirit);
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
