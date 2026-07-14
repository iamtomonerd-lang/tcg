/**
 * Battle Spirits effect engine. Processes all card effects from data.
 */

import type { CardDef, CardEffect, GameState, PendingAttack, PlayerState, Spirit } from './types.js';

/**
 * Recompute a spirit's level from the cores placed on it.
 * lv2.cost is the total number of cores required to be at Lv2.
 * If lv2.coreType is 'ソウルコア', uses soul cores for leveling.
 * If the spirit has 真界放 skill, it can reach Lv2 with soul cores only.
 */
export function updateSpiritLevel(spirit: Spirit): void {
  if (!spirit.def.lv2) {
    spirit.level = 1;
    return;
  }

  // Check if spirit has 真界放 skill
  const hasShinkaihouSkill = spirit.def.effects?.some(e => e.skill === '真界放');

  if (hasShinkaihouSkill) {
    // 真界放: reach Lv2 with soul cores only (lv2.cost) OR with normal cores (lv2.cost)
    if (spirit.soulCoreCount >= spirit.def.lv2.cost || spirit.coreCount >= spirit.def.lv2.cost) {
      spirit.level = 2;
    } else {
      spirit.level = 1;
    }
  } else if (spirit.def.lv2.coreType === 'ソウルコア') {
    // Lv2 requires soul cores
    if (spirit.soulCoreCount >= spirit.def.lv2.cost) {
      spirit.level = 2;
    } else {
      spirit.level = 1;
    }
  } else {
    // Lv2 requires regular cores
    if (spirit.coreCount >= spirit.def.lv2.cost) {
      spirit.level = 2;
    } else {
      spirit.level = 1;
    }
  }
}

/**
 * Destroy a spirit: its card goes to the owner's trash and the cores on it
 * go to the trash (returned to reserve on refresh phase per official rules).
 */
export function destroySpirit(owner: PlayerState, spiritIndex: number): Spirit | undefined {
  const spirit = owner.spirits[spiritIndex];
  if (!spirit) return undefined;
  owner.spirits.splice(spiritIndex, 1);
  owner.trash.push(spirit.def);
  // Send cores to trash (will return to reserve at refresh)
  owner.trashCores += spirit.coreCount;
  owner.trashSoulCores += spirit.soulCoreCount;
  return spirit;
}

/**
 * Remove a spirit when its cores reach 0 (not destruction, no effects triggered).
 * The spirit card goes to trash, but cores are already gone (they were paid/removed).
 */
export function removeDeadSpirit(owner: PlayerState, spiritIndex: number): Spirit | undefined {
  const spirit = owner.spirits[spiritIndex];
  if (!spirit) return undefined;
  owner.spirits.splice(spiritIndex, 1);
  owner.trash.push(spirit.def);
  // No cores go to trash (they're already at 0 or were already removed)
  return spirit;
}

/**
 * BP threshold for a destroy_creature effect ("BP◯◯以下").
 * Soul Magic red raises the limit to 10000 if the player took damage this turn.
 */
export function destroyCreatureBpLimit(effect: CardEffect, me: PlayerState): number | undefined {
  if (effect.skill === 'ソウルマジック：赤' && (me.damageThisTurn ?? 0) > 0) {
    return 10000;
  }
  return effect.value;
}

/**
 * After a spirit is removed from `player`'s spirits array at `removedIndex`
 * (via destroySpirit/removeDeadSpirit), any index-based reference to a spirit
 * later in that same array is now stale — indices after the removed slot have
 * shifted down by one. Fix up pendingAttack (and a stashed attack waiting
 * behind an open flash window) so they keep pointing at the right spirit.
 * If the removed spirit was itself the pending attacker, the attack has
 * nothing left to resolve and is cancelled.
 */
export function fixupSpiritIndicesAfterRemoval(state: GameState, player: number, removedIndex: number): void {
  const fixOne = (pa: PendingAttack | null | undefined): PendingAttack | null | undefined => {
    if (!pa || pa.attackerPlayer !== player) return pa;
    if (pa.attackerSpiritIndex === removedIndex) return null; // the attacker itself was destroyed
    if (pa.attackerSpiritIndex > removedIndex) return { ...pa, attackerSpiritIndex: pa.attackerSpiritIndex - 1 };
    return pa;
  };

  if (state.pendingAttack) {
    state.pendingAttack = fixOne(state.pendingAttack) ?? null;
  }
  if (state.pendingFlash?.stashedAttack) {
    state.pendingFlash.stashedAttack = fixOne(state.pendingFlash.stashedAttack) ?? undefined;
  }
}

/**
 * Apply a single effect to the game state. Pure function; state is cloned.
 */
export function applyEffect(
  state: GameState,
  effect: CardEffect,
  sourcePlayer: number,
  targetNexusIndex?: number,
  spiritIndex?: number, // index (in me.spirits) of the spirit that triggered the effect, e.g. attacker/summoned spirit
  targetSpiritIndex?: number,
  effectValue?: number,
): GameState {
  const next = cloneGameState(state);
  const me = next.players[sourcePlayer]!;
  const opponent = next.players[1 - sourcePlayer]!;

  // Resolve the spirit this effect self-targets: an explicitly player-chosen target takes
  // priority (e.g. "自分のスピリット1体を指定できる"), otherwise the triggering spirit itself.
  const selfSpirit = effect.requiresTarget && targetSpiritIndex !== undefined
    ? me.spirits[targetSpiritIndex]
    : (spiritIndex !== undefined ? me.spirits[spiritIndex] : undefined);

  // Check effect conditions
  if (effect.condition) {
    if (effect.condition.minHandSize && me.hand.length < effect.condition.minHandSize) {
      return next;
    }
    if (effect.condition.maxHandSize && me.hand.length > effect.condition.maxHandSize) {
      return next;
    }
    if (effect.condition.requiresSymbol) {
      // Requires a symbol of this color on the player's field (spirits or nexuses)
      const color = effect.condition.requiresSymbol;
      const hasSymbol =
        me.spirits.some((s) => s.def.symbolColors?.includes(color)) ||
        me.nexuses.some((n) => n.def.symbolColors?.includes(color));
      if (!hasSymbol) {
        return next;
      }
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
        opponent.damageThisTurn = (opponent.damageThisTurn ?? 0) + damageValue;
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
      if (selfSpirit) {
        if (effect.duration === 'battle') {
          // このバトル中: expires when the current battle resolves
          selfSpirit.bpBoostBattle = (selfSpirit.bpBoostBattle ?? 0) + boostValue;
        } else {
          // このターン中 (default): expires at end of turn
          selfSpirit.bpBoost = (selfSpirit.bpBoost ?? 0) + boostValue;
        }
      }
      break;
    }
    case 'search_deck': {
      // Open top X cards, find N with matching lineage, add to hand, discard rest
      const openCount = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 2);
      const targetLineage = effect.symbol; // Symbol field contains lineage for search_deck
      const countToAdd = effect.count ?? 1; // how many cards to add (default 1)
      const opened = me.deck.splice(0, Math.min(openCount, me.deck.length));

      let foundCount = 0;
      for (let i = opened.length - 1; i >= 0 && foundCount < countToAdd; i--) {
        const card = opened[i]!;
        if (!targetLineage || card.lineage?.includes(targetLineage)) {
          me.hand.push(card);
          opened.splice(i, 1);
          foundCount++;
        }
      }

      // Discard remaining opened cards to trash
      me.trash.push(...opened);
      break;
    }
    case 'destroy_creature': {
      // Destroy opponent's spirit at targetSpiritIndex, or weakest destroyable one
      const bpLimit = destroyCreatureBpLimit(effect, me);
      const spiritBp = (sp: Spirit) => {
        const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
        return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
      };
      let targetIndex = targetSpiritIndex ?? -1;
      if (targetIndex === -1) {
        for (let i = 0; i < opponent.spirits.length; i++) {
          if (bpLimit === undefined || spiritBp(opponent.spirits[i]!) <= bpLimit) {
            targetIndex = i;
            break;
          }
        }
      }
      if (targetIndex >= 0 && targetIndex < opponent.spirits.length) {
        // Enforce the BP limit for explicitly chosen targets too ("BP◯◯以下" is a hard restriction)
        if (bpLimit !== undefined && spiritBp(opponent.spirits[targetIndex]!) > bpLimit) break;
        // Card to trash, cores back to reserve (official rule)
        destroySpirit(opponent, targetIndex);
        fixupSpiritIndicesAfterRemoval(next, 1 - sourcePlayer, targetIndex);
      }
      break;
    }
    case 'trash_to_hand': {
      // Move card from trash to hand
      const targetLineage = effect.symbol;
      const excludeId = effect.excludeId;
      const excludeEXSymbol = effect.condition?.excludeEXSymbol ?? false;
      const maxCost = effect.condition?.maxCost;
      for (let i = 0; i < me.trash.length; i++) {
        const card = me.trash[i]!;
        if ((!targetLineage || card.lineage?.includes(targetLineage)) &&
            (!excludeId || card.id !== excludeId) &&
            (!excludeEXSymbol || !card.exSymbol) &&
            (maxCost === undefined || card.cost <= maxCost) &&
            card.cardType === 'spirit') {
          me.hand.push(card);
          me.trash.splice(i, 1);
          break;
        }
      }
      break;
    }
    case 'place_core': {
      // Place cores on this spirit and recompute level
      // Source can be 'trash' or 'void' (default)
      const coreValue = effect.variableValue && effectValue !== undefined ? effectValue : (effect.value ?? 1);
      const source = effect.source ?? 'void';
      const excludeSoulCore = effect.condition?.excludeSoulCore ?? false;
      const onlySoulCore = effect.condition?.onlySoulCore ?? false;

      if (selfSpirit) {
        if (source === 'trash') {
          // Take cores from trash with conditions
          let taken = 0;
          if (onlySoulCore) {
            // Only take soul cores
            if (me.trashSoulCores > 0) {
              const soulTake = Math.min(me.trashSoulCores, coreValue);
              selfSpirit.soulCoreCount = (selfSpirit.soulCoreCount || 0) + soulTake;
              me.trashSoulCores -= soulTake;
              taken += soulTake;
            }
          } else if (excludeSoulCore) {
            // Only take regular cores
            if (me.trashCores > 0) {
              const regularTake = Math.min(me.trashCores, coreValue);
              selfSpirit.coreCount += regularTake;
              me.trashCores -= regularTake;
              taken += regularTake;
            }
          } else {
            // Take soul cores first, then regular cores
            if (me.trashSoulCores > 0) {
              const soulTake = Math.min(me.trashSoulCores, coreValue);
              selfSpirit.soulCoreCount = (selfSpirit.soulCoreCount || 0) + soulTake;
              me.trashSoulCores -= soulTake;
              taken += soulTake;
            }
            if (taken < coreValue && me.trashCores > 0) {
              const regularTake = Math.min(me.trashCores, coreValue - taken);
              selfSpirit.coreCount += regularTake;
              me.trashCores -= regularTake;
            }
          }
        } else {
          // From void (infinite source)
          selfSpirit.coreCount += coreValue;
        }
        updateSpiritLevel(selfSpirit);
      }
      break;
    }
    case 'discard_hand': {
      // Discard card from hand with specific lineage (系統, e.g. 風牙), or up to effectValue cards
      // If targetSpiritIndex is provided, use it as discardCardIndex for the selected card
      const targetLineage = effect.symbol;
      const discardCount = effect.variableValue && effectValue !== undefined ? effectValue : 1;

      if (targetSpiritIndex !== undefined && targetSpiritIndex >= 0) {
        // Discard specific card at index
        const card = me.hand[targetSpiritIndex];
        if (card && (!targetLineage || card.lineage?.includes(targetLineage))) {
          me.trash.push(card);
          me.hand.splice(targetSpiritIndex, 1);
        }
      } else {
        // Auto-discard from end if no specific card selected
        let discarded = 0;
        for (let i = me.hand.length - 1; i >= 0 && discarded < discardCount; i--) {
          const card = me.hand[i]!;
          if (!targetLineage || card.lineage?.includes(targetLineage)) {
            me.trash.push(card);
            me.hand.splice(i, 1);
            discarded++;
          }
        }
      }
      break;
    }
    case 'destroy_nexus': {
      // Destroy opponent's nexus when magic is used (immediate trigger).
      // Excludes nexuses that have reached Lv2 ("真界放していない" nexus only).
      const eligible = opponent.nexuses
        .map((n, idx) => ({ n, idx }))
        .filter(({ n }) => n.level !== 2)
        .map(({ idx }) => idx);
      const chosenIndex = targetNexusIndex !== undefined && eligible.includes(targetNexusIndex)
        ? targetNexusIndex
        : eligible[0];
      if (chosenIndex !== undefined) {
        const nexus = opponent.nexuses[chosenIndex]!;
        opponent.nexuses.splice(chosenIndex, 1);
        // Card to trash, cores to trash (returned to reserve at refresh) — same as destroySpirit
        opponent.trash.push(nexus.def);
        opponent.trashCores += nexus.coreCount;
        opponent.trashSoulCores += nexus.soulCoreCount;
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
  spiritIndex?: number,
  targetSpiritIndex?: number,
  effectValue?: number,
  discardCardIndex?: number,
  modeFilter?: 'main' | 'flash',
  targetNexusIndex?: number,
  sourceLevel?: 1 | 2,
  sourceNexusIndex?: number, // index of the nexus whose effect is firing (for costExhaustSelf)
): GameState {
  let next = state;
  const effects = (card.effects ?? []).filter((e) => {
    if (e.trigger !== trigger) return false;
    if (modeFilter === 'main' && !(!e.mode || e.mode === 'main')) return false;
    if (modeFilter === 'flash' && !(e.isFlash || !e.mode || e.mode === 'flash')) return false;
    if (e.level && sourceLevel !== undefined && !e.level.includes(sourceLevel)) return false;
    return true;
  });

  for (const effect of effects) {
    // Activation cost (▶ compound effects): pay it first, or the effect does not fire.
    if (effect.costAction === 'discard_hand') {
      // Cost: discard a card (matching costSymbol lineage) chosen via discardCardIndex.
      // No/invalid choice = the player declined (起動 abilities are optional) or can't pay.
      const payer = next.players[sourcePlayer]!;
      const costCard = discardCardIndex !== undefined ? payer.hand[discardCardIndex] : undefined;
      if (!costCard || (effect.costSymbol && !costCard.lineage?.includes(effect.costSymbol))) continue;
      payer.trash.push(costCard);
      payer.hand.splice(discardCardIndex!, 1);
    }
    if (effect.costExhaustSelf) {
      // Cost: exhaust the source nexus itself; an already-exhausted nexus can't pay again this turn
      const sourceNexus = sourceNexusIndex !== undefined ? next.players[sourcePlayer]!.nexuses[sourceNexusIndex] : undefined;
      if (!sourceNexus || sourceNexus.exhausted) continue;
      sourceNexus.exhausted = true;
    }

    // For discard_hand effects, use discardCardIndex as targetSpiritIndex if provided
    const targetIdx = effect.action === 'discard_hand' && discardCardIndex !== undefined ? discardCardIndex : targetSpiritIndex;

    // Handle multiTarget effects (apply to multiple spirits)
    if (effect.multiTarget && effect.action === 'boost_bp') {
      // Find all spirits matching the condition (resolved fresh, in case earlier effects mutated the field)
      const me = next.players[sourcePlayer]!;
      const matchingIndices: number[] = [];
      if (effect.condition?.requiresSkill === '継召') {
        for (let i = 0; i < me.spirits.length; i++) {
          if (me.spirits[i]!.def.inheritance) {
            matchingIndices.push(i);
          }
        }
      }
      // Apply effect to all matching spirits
      for (const idx of matchingIndices) {
        next = applyEffect(next, effect, sourcePlayer, targetNexusIndex, idx, targetIdx, effectValue);
      }
    } else {
      next = applyEffect(next, effect, sourcePlayer, targetNexusIndex, spiritIndex, targetIdx, effectValue);
    }
  }
  return next;
}

// --- Helpers ---

function cloneGameState(state: GameState): GameState {
  return {
    players: [clonePlayerState(state.players[0]!), clonePlayerState(state.players[1]!)],
    currentPlayer: state.currentPlayer,
    turnCount: state.turnCount,
    phase: state.phase,
    battle: state.battle ? { ...state.battle } : null,
    result: state.result ? { ...state.result } : null,
    pendingFlash: state.pendingFlash ? { ...state.pendingFlash } : state.pendingFlash,
    pendingAttack: state.pendingAttack ? { ...state.pendingAttack } : state.pendingAttack,
    pendingDraw: state.pendingDraw ? { ...state.pendingDraw } : state.pendingDraw,
  };
}

function clonePlayerState(p: PlayerState): PlayerState {
  return {
    life: p.life,
    cores: p.cores,
    soulCores: p.soulCores,
    trashCores: p.trashCores,
    trashSoulCores: p.trashSoulCores,
    hand: p.hand.slice(),
    deck: p.deck.slice(),
    spirits: p.spirits.map((s) => ({ ...s, soulCoreCount: s.soulCoreCount })),
    nexuses: p.nexuses.map((n) => ({ ...n })),
    trash: p.trash.slice(),
    damageThisTurn: p.damageThisTurn,
  };
}
