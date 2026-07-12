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
  targetSpiritIndex?: number,
  effectValue?: number,
): GameState {
  const next = cloneGameState(state);
  const me = next.players[sourcePlayer]!;
  const opponent = next.players[1 - sourcePlayer]!;

  // Check effect level applicability
  if (effect.level && spirit && !effect.level.includes(spirit.level)) {
    return next;
  }

  // Check effect conditions
  if (effect.condition) {
    if (effect.condition.minHandSize && me.hand.length < effect.condition.minHandSize) {
      return next;
    }
    if (effect.condition.maxHandSize && me.hand.length > effect.condition.maxHandSize) {
      return next;
    }
    if (effect.condition.requiresFatiguedRed) {
      // Check if there's a fatigued (canAttack: false) red spirit
      const hasFatiguedRed = me.spirits.some((s: any) => !s.canAttack && s.def.symbolColors?.includes('red'));
      if (!hasFatiguedRed) {
        return next;
      }
    }
    if (effect.condition.requiresAdjacentSymbol) {
      // Check if there's an adjacent spirit with matching lineage
      const lineage = effect.condition.requiresAdjacentSymbol;
      const hasAdjacent = me.spirits.some((s: any) => s.def.lineage?.includes(lineage));
      if (!hasAdjacent) {
        return next;
      }
    }
    if (effect.condition.requiresNexus && me.nexuses.length === 0) {
      return next;
    }
    if (effect.condition.opponentHasNexus && opponent.nexuses.length === 0) {
      return next;
    }
    if (effect.condition.requiresSpirit) {
      const { lineage, count } = effect.condition.requiresSpirit;
      let matchCount = 0;
      if (lineage) {
        matchCount = me.spirits.filter((s: any) => s.def.lineage?.includes(lineage)).length;
      } else {
        matchCount = me.spirits.length;
      }
      if (count && matchCount < count) {
        return next;
      }
      if (!count && matchCount === 0) {
        return next;
      }
    }
  }

  switch (effect.action) {
    case 'damage': {
      const target = effect.target || 'opponent_hero';
      const damageValue = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 1);
      if (target === 'opponent_hero') {
        opponent.life -= damageValue;
      } else if (target === 'opponent_creature' && targetNexusIndex !== undefined) {
        // TODO: damage creature (not in phase 1)
      }
      break;
    }
    case 'heal': {
      const healValue = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 1);
      me.life += healValue;
      if (me.life > 20) me.life = 20; // Cap at starting life
      break;
    }
    case 'draw': {
      const drawValue = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 1);
      for (let i = 0; i < drawValue; i++) {
        const card = me.deck.shift();
        if (card) me.hand.push(card);
      }
      break;
    }
    case 'boost_bp': {
      // Boost the spirit's BP temporarily (stored as a modifier in spirit state)
      const boostValue = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 1);
      if (spirit) {
        spirit.bpBoost = (spirit.bpBoost ?? 0) + boostValue;
      }
      break;
    }
    case 'search_deck': {
      // Open top X cards, find 1 with matching lineage, add to hand, discard rest
      const openCount = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 2);
      const targetLineage = effect.symbol; // Symbol field contains lineage for search_deck
      const opened = me.deck.splice(0, Math.min(openCount, me.deck.length));

      let found = false;
      for (let i = 0; i < opened.length; i++) {
        const card = opened[i]!;
        if (!found && (!targetLineage || card.lineage?.includes(targetLineage))) {
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
      // Destroy opponent's spirit at targetSpiritIndex, or weakest one with BP <= 3
      let targetIndex = targetSpiritIndex ?? -1;
      if (targetIndex === -1) {
        for (let i = 0; i < opponent.spirits.length; i++) {
          const spiritDef = opponent.spirits[i]!;
          const stats = spiritDef.level === 1 ? spiritDef.def.lv1 : spiritDef.def.lv2 || spiritDef.def.lv1;
          if (stats.bp <= 3) {
            targetIndex = i;
            break;
          }
        }
      }
      if (targetIndex >= 0 && targetIndex < opponent.spirits.length) {
        opponent.spirits.splice(targetIndex, 1);
      }
      break;
    }
    case 'trash_to_hand': {
      // Move card from trash to hand
      const targetLineage = effect.symbol;
      const excludeId = effect.excludeId;
      const excludeEXSymbol = effect.condition?.excludeEXSymbol ?? false;
      for (let i = 0; i < me.trash.length; i++) {
        const card = me.trash[i]!;
        if ((!targetLineage || card.lineage?.includes(targetLineage)) &&
            (!excludeId || card.id !== excludeId) &&
            (!excludeEXSymbol || !card.exSymbol) &&
            card.cardType === 'spirit') {
          me.hand.push(card);
          me.trash.splice(i, 1);
          break;
        }
      }
      break;
    }
    case 'place_core': {
      // Place core on this spirit and check for level-up
      const coreValue = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 1);
      if (spirit) {
        spirit.placedCores = (spirit.placedCores ?? 0) + coreValue;
        // Check if spirit can level up to Lv2
        if (spirit.level === 1 && spirit.def.lv2 && spirit.placedCores >= spirit.def.lv2.cost) {
          spirit.level = 2;
          spirit.placedCores -= spirit.def.lv2.cost;
        }
      }
      break;
    }
    case 'discard_hand': {
      // Discard card from hand with specific symbol, or up to effectValue cards
      const targetSymbol = effect.symbol;
      const discardCount = effect.variableValue && effectValue !== undefined ? effectValue : 1;
      let discarded = 0;
      for (let i = me.hand.length - 1; i >= 0 && discarded < discardCount; i--) {
        const card = me.hand[i]!;
        if (!targetSymbol || card.symbolColors.includes(targetSymbol)) {
          me.trash.push(card);
          me.hand.splice(i, 1);
          discarded++;
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
  targetSpiritIndex?: number,
  effectValue?: number,
): GameState {
  let next = state;
  const effects = card.effects?.filter((e) => e.trigger === trigger) ?? [];
  for (const effect of effects) {
    next = applyEffect(next, effect, sourcePlayer, undefined, spirit, targetSpiritIndex, effectValue);
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
