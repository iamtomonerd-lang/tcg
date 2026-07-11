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
    if (effect.condition.requiresFatiguedRed) {
      // Check if there's a fatigued (canAttack: false) red spirit
      const hasFatiguedRed = me.spirits.some((s: any) => !s.canAttack && s.def.symbols.includes('red'));
      if (!hasFatiguedRed) {
        return next;
      }
    }
    if (effect.condition.requiresAdjacentSymbol) {
      // Check if there's an adjacent spirit with matching symbol
      const symbol = effect.condition.requiresAdjacentSymbol;
      const hasAdjacent = me.spirits.some((s: any) => s.def.symbols.includes(symbol));
      if (!hasAdjacent) {
        return next;
      }
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
      // Open top X cards, find 1 with matching symbol, add to hand, discard rest
      const openCount = effect.value ?? 2; // Open top X cards
      const targetSymbol = effect.symbol;
      const opened = me.deck.splice(0, Math.min(openCount, me.deck.length));

      let found = false;
      for (let i = 0; i < opened.length; i++) {
        const card = opened[i]!;
        if (!found && (!targetSymbol || card.symbols.includes(targetSymbol))) {
          me.hand.push(card);
          opened.splice(i, 1);
          found = true;
          break;
        }
      }

      // Discard remaining opened cards to trash
      me.trash.push(...opened);
      break;
    }
    case 'destroy_creature': {
      // Destroy opponent's spirit (weakest one with BP <= 3)
      let targetIndex = -1;
      for (let i = 0; i < opponent.spirits.length; i++) {
        const spirit = opponent.spirits[i]!;
        const stats = spirit.level === 1 ? spirit.def.lv1 : spirit.def.lv2 || spirit.def.lv1;
        if (stats.bp <= 3) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex >= 0) {
        opponent.spirits.splice(targetIndex, 1);
      }
      break;
    }
    case 'trash_to_hand': {
      // Move card from trash to hand
      const targetSymbol = effect.symbol;
      const excludeId = effect.excludeId;
      for (let i = 0; i < me.trash.length; i++) {
        const card = me.trash[i]!;
        if ((!targetSymbol || card.symbols.includes(targetSymbol)) &&
            (!excludeId || card.id !== excludeId) &&
            card.cardType === 'spirit') {
          me.hand.push(card);
          me.trash.splice(i, 1);
          break;
        }
      }
      break;
    }
    case 'place_core': {
      // Place core on this spirit
      if (spirit) {
        spirit.placedCores = (spirit.placedCores ?? 0) + (effect.value ?? 1);
      }
      break;
    }
    case 'discard_hand': {
      // Discard card from hand with specific symbol
      const targetSymbol = effect.symbol;
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i]!;
        if (!targetSymbol || card.symbols.includes(targetSymbol)) {
          me.trash.push(card);
          me.hand.splice(i, 1);
          break;
        }
      }
      break;
    }
    case 'destroy_nexus': {
      // Destroy a nexus (this is typically the card itself)
      if (me.nexuses.length > 0) {
        me.nexuses.pop();
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
