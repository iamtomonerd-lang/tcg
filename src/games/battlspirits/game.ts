import type { Game, Rng } from '../../core/game.js';
import { CARD_DB, getStarterDeck } from './cards.js';
import type { Action, GameState, Nexus, Spirit, PlayerState, PendingAttack, CardDef } from './types.js';
import { applyEffect, triggerEffects, destroySpirit, removeDeadSpirit, updateSpiritLevel, fixupSpiritIndicesAfterRemoval, destroyCreatureBpLimit } from './effects.js';

/**
 * Battle Spirits Phase 1: simplified rules.
 * Turn: Start (draw) → Main (summon/place/use) → Attack → End
 * (First turn skips core step and attack step)
 */

function calculateCostAfterReduction(
  card: any,
  fieldSymbols: { color: string; count: number }[],
  hasEXSymbolsInTrash: boolean,
  hasInheritance: boolean,
): number {
  let cost = card.cost;
  // reductionRemaining tracks the shared reduction limit (e.g., 2)
  // Both field symbols and inheritance (EX symbols) draw from this same pool
  let reductionRemaining = card.reductionCost;

  // Reduce cost from field symbols (consumes shared reduction limit)
  for (const sym of fieldSymbols) {
    if (reductionRemaining <= 0) break;
    const canReduce = card.reductionCost > 0 && card.symbolColors?.includes(sym.color);
    if (canReduce) {
      const reduce = Math.min(sym.count, reductionRemaining);
      cost = Math.max(0, cost - reduce);
      reductionRemaining -= reduce;
    }
  }

  // If card has inheritance, can use EX symbols from trash for remaining reduction limit
  // (shared with field symbols, not added on top)
  if (hasInheritance && reductionRemaining > 0 && hasEXSymbolsInTrash) {
    cost = Math.max(0, cost - reductionRemaining);
  }

  return Math.max(0, cost);
}

export class BattlSpiritsGame implements Game<GameState, Action> {
  readonly playerCount = 2;

  createInitialState(rng: Rng): GameState {
    const players: [any, any] = [this.newPlayer(rng), this.newPlayer(rng)];

    // Randomly give one player the right to decide who goes first
    const decideFirstPlayerPlayer = rng.int(2); // 0 or 1

    const state: GameState = {
      players: players as [any, any],
      currentPlayer: decideFirstPlayerPlayer,
      turnCount: 0,
      phase: 'start',
      battle: null,
      result: null,
      decideFirstPlayerPlayer,
    };
    // Draw opening hand of 4 cards each
    for (const p of players) {
      this.drawOpeningHand(p);
    }
    return state;
  }

  /** Draw a fresh opening hand of 4 cards (used both for the initial deal and for mulligan redraws). */
  private drawOpeningHand(p: PlayerState): void {
    for (let i = 0; i < 4; i++) {
      const card = p.deck.shift();
      if (card) p.hand.push(card);
    }
  }

  private newPlayer(rng: Rng) {
    const deck = getStarterDeck();
    rng.shuffle(deck);
    return {
      life: 5,
      cores: 3, // starting regular cores
      soulCores: 1, // starting soul core
      trashCores: 0, // cores in trash
      trashSoulCores: 0, // soul cores in trash
      hand: [],
      deck,
      spirits: [],
      nexuses: [],
      trash: [],
      bottomDeckCards: [],
    };
  }

  private payCost(
    player: PlayerState,
    amount: number,
    paidRegularCores?: number,
    paidSoulCores?: number,
    legacyCoreType?: 'regular' | 'soul',
  ): boolean {
    // Calculate total available cores (reserve + spirits)
    let totalAvailable = player.cores + player.soulCores;
    for (const spirit of player.spirits) {
      totalAvailable += spirit.coreCount + spirit.soulCoreCount;
    }
    if (totalAvailable < amount) return false;

    let regularRemaining = paidRegularCores ?? 0;
    let soulRemaining = paidSoulCores ?? 0;

    // If no specific core distribution provided, use legacy behavior
    if (paidRegularCores === undefined && paidSoulCores === undefined) {
      return this.payCostLegacy(player, amount, legacyCoreType);
    }

    // Take exactly the specified number of regular cores
    // From reserve first, then from spirits
    if (regularRemaining > 0) {
      const fromReserve = Math.min(player.cores, regularRemaining);
      player.cores -= fromReserve;
      player.trashCores += fromReserve;
      regularRemaining -= fromReserve;

      // Take remaining from spirits
      if (regularRemaining > 0) {
        for (const spirit of player.spirits) {
          if (regularRemaining <= 0) break;
          const take = Math.min(spirit.coreCount, regularRemaining);
          spirit.coreCount -= take;
          player.trashCores += take;
          regularRemaining -= take;
          updateSpiritLevel(spirit);
        }
      }
    }

    // Take exactly the specified number of soul cores
    // From reserve first, then from spirits
    if (soulRemaining > 0) {
      const fromReserve = Math.min(player.soulCores, soulRemaining);
      player.soulCores -= fromReserve;
      player.trashSoulCores += fromReserve;
      soulRemaining -= fromReserve;

      // Take remaining from spirits
      if (soulRemaining > 0) {
        for (const spirit of player.spirits) {
          if (soulRemaining <= 0) break;
          const take = Math.min(spirit.soulCoreCount, soulRemaining);
          spirit.soulCoreCount -= take;
          player.trashSoulCores += take;
          soulRemaining -= take;
          updateSpiritLevel(spirit);
        }
      }
    }

    return true;
  }

  /** Legacy payCost behavior when core distribution is not specified */
  private payCostLegacy(player: PlayerState, amount: number, coreType?: 'regular' | 'soul'): boolean {
    let remaining = amount;

    if (coreType === 'soul') {
      // Use soul cores first (from reserve, then spirits), then regular cores
      if (player.soulCores >= remaining) {
        player.soulCores -= remaining;
        player.trashSoulCores += remaining;
        remaining = 0;
      } else {
        player.trashSoulCores += player.soulCores;
        remaining -= player.soulCores;
        player.soulCores = 0;

        // Take regular cores from reserve
        if (player.cores >= remaining) {
          player.cores -= remaining;
          player.trashCores += remaining;
          remaining = 0;
        } else {
          player.trashCores += player.cores;
          remaining -= player.cores;
          player.cores = 0;

          // Take cores from spirits (regular first, then soul)
          for (const spirit of player.spirits) {
            if (remaining <= 0) break;
            const spiritRegularCores = spirit.coreCount;
            const take = Math.min(spiritRegularCores, remaining);
            spirit.coreCount -= take;
            player.trashCores += take;
            remaining -= take;
            updateSpiritLevel(spirit);
          }
          for (const spirit of player.spirits) {
            if (remaining <= 0) break;
            const spiritSoulCores = spirit.soulCoreCount;
            const take = Math.min(spiritSoulCores, remaining);
            spirit.soulCoreCount -= take;
            player.trashSoulCores += take;
            remaining -= take;
            updateSpiritLevel(spirit);
          }
        }
      }
    } else {
      // Default: use regular cores first (from reserve, then spirits), then soul cores
      if (player.cores >= remaining) {
        player.cores -= remaining;
        player.trashCores += remaining;
        remaining = 0;
      } else {
        player.trashCores += player.cores;
        remaining -= player.cores;
        player.cores = 0;

        // Take regular cores from spirits
        for (const spirit of player.spirits) {
          if (remaining <= 0) break;
          const spiritRegularCores = spirit.coreCount;
          const take = Math.min(spiritRegularCores, remaining);
          spirit.coreCount -= take;
          player.trashCores += take;
          remaining -= take;
          updateSpiritLevel(spirit);
        }

        // Take soul cores from reserve
        if (remaining > 0 && player.soulCores >= remaining) {
          player.soulCores -= remaining;
          player.trashSoulCores += remaining;
          remaining = 0;
        } else if (remaining > 0) {
          player.trashSoulCores += player.soulCores;
          remaining -= player.soulCores;
          player.soulCores = 0;

          // Take soul cores from spirits
          for (const spirit of player.spirits) {
            if (remaining <= 0) break;
            const spiritSoulCores = spirit.soulCoreCount;
            const take = Math.min(spiritSoulCores, remaining);
            spirit.soulCoreCount -= take;
            player.trashSoulCores += take;
            remaining -= take;
            updateSpiritLevel(spirit);
          }
        }
      }
    }
    return true;
  }

  private startTurn(state: GameState): GameState {
    let next = cloneState(state);
    next.phase = 'start';
    // Auto-transition through automatic phases until we reach Main
    return this.transitionPhases(next);
  }

  private transitionPhases(state: GameState): GameState {
    let next = state;

    while (true) {
      switch (next.phase) {
        case 'start': {
          // Transition to Core phase
          // Reset damage tracking at start of turn
          next.players[next.currentPlayer]!.damageThisTurn = 0;
          next.phase = 'core';
          break;
        }
        case 'core': {
          // Official rule: ターンプレイヤーはボイドからコア1個をそのプレイヤーのリザーブに置きます
          // Always add 1 core from the void (no limit)
          const isFirstTurn = next.turnCount === 0;
          if (!isFirstTurn) {
            const p = next.players[next.currentPlayer]!;
            p.cores += 1; // Always 1 core from void
          }
          next.phase = 'draw';
          break;
        }
        case 'draw': {
          // Standard draw phase: draw 1 card (first player's very first turn skips this, per official rules)
          const isFirstTurn = next.turnCount === 0;
          if (!isFirstTurn) {
            const p = next.players[next.currentPlayer]!;
            if (p.deck.length === 0) {
              next.result = { winner: 1 - next.currentPlayer };
              return next;
            }
            const card = p.deck.shift()!;
            p.hand.push(card);
          }
          next.phase = 'refresh';
          break; // continue the loop so refresh runs and phase reaches main
        }
        case 'refresh': {
          // Refresh all spirits (can attack this turn)
          const p = next.players[next.currentPlayer]!;
          // Keep cores on spirits; only refresh attack status
          for (const spirit of p.spirits) {
            // Cores placed on spirits stay there (not returned to reserve)
            spirit.canAttack = true;
            // Clear persistent status effects
            spirit.cannotAttackUntilNextTurn = false;
            spirit.cannotDefendUntilNextTurn = false;
          }
          // Refresh exhausted nexuses (paid as activation costs)
          for (const nexus of p.nexuses) {
            nexus.exhausted = false;
          }
          // Return cores from trash to reserve
          p.cores += p.trashCores;
          p.soulCores += p.trashSoulCores;
          p.trashCores = 0;
          p.trashSoulCores = 0;
          next.phase = 'main';
          return next; // Stop here, player can now take actions
        }
        case 'main':
        case 'attack':
        case 'main2':
        case 'end':
          return next; // Phase requires player action or has its own handling
      }
    }
  }

  private getFieldSymbols(player: PlayerState): { color: string; count: number }[] {
    const symbolMap = new Map<string, number>();

    // Count symbols from spirits on field
    for (const spirit of player.spirits) {
      for (const color of spirit.def.symbolColors) {
        symbolMap.set(color, (symbolMap.get(color) ?? 0) + spirit.def.symbolCount);
      }
    }

    // Nexuses provide symbols too (official rule)
    for (const nexus of player.nexuses) {
      for (const color of nexus.def.symbolColors) {
        symbolMap.set(color, (symbolMap.get(color) ?? 0) + nexus.def.symbolCount);
      }
    }

    // Convert to array format
    return Array.from(symbolMap.entries()).map(([color, count]) => ({ color, count }));
  }

  private getTotalAvailableCores(player: PlayerState): number {
    let total = player.cores + player.soulCores;
    for (const spirit of player.spirits) {
      total += spirit.coreCount + spirit.soulCoreCount;
    }
    return total;
  }

  /** Expire all このバトル中 (battle-duration) BP boosts on both players' spirits */
  private clearBattleBoosts(state: GameState): void {
    for (const p of state.players) {
      for (const s of p.spirits) {
        s.bpBoostBattle = 0;
      }
    }
  }

  /** Remove all spirits that have 0 cores (not destruction, no effects triggered) */
  private removeDeadSpirits(state: GameState, playerIndex: number): void {
    const player = state.players[playerIndex]!;
    for (let i = player.spirits.length - 1; i >= 0; i--) {
      const spirit = player.spirits[i]!;
      if (spirit.coreCount === 0 && spirit.soulCoreCount === 0) {
        removeDeadSpirit(player, i);
        fixupSpiritIndicesAfterRemoval(state, playerIndex, i);
      }
    }
  }

  /** Remove all nexuses that have 0 cores (depleted — 消滅, no effects triggered) */
  private removeDeadNexuses(state: GameState, playerIndex: number): void {
    const player = state.players[playerIndex]!;
    const removedIndices: number[] = [];
    for (let i = player.nexuses.length - 1; i >= 0; i--) {
      const nexus = player.nexuses[i]!;
      if (nexus.coreCount === 0 && nexus.soulCoreCount === 0) {
        player.nexuses.splice(i, 1);
        player.trash.push(nexus.def);
        removedIndices.push(i);
      }
    }
    // Fix up any pending draw that references removed nexus indices
    if (state.pendingDraw && state.pendingDraw.targetNexusIndex !== undefined) {
      for (const removedIdx of removedIndices.sort((a, b) => a - b)) {
        if (state.pendingDraw.targetNexusIndex === removedIdx) {
          // Target nexus was removed; invalidate the pending draw
          state.pendingDraw = null;
          break;
        } else if (state.pendingDraw.targetNexusIndex > removedIdx) {
          // Adjust index for removed nexus
          state.pendingDraw.targetNexusIndex -= 1;
        }
      }
    }
  }

  currentPlayer(state: GameState): number {
    return state.currentPlayer;
  }

  /** Calculate the core cost required for an action. Used by UI for cost estimation. */
  actionCost(state: GameState, action: Action): number {
    const player = state.players[state.currentPlayer]!;

    switch (action.type) {
      case 'summon': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'spirit') return 0;
        // Only return the card's cost, NOT the Lv1 placement cost
        // Lv1 placement is a separate action (add_core) that happens after summon
        return this.effectiveCost(player, card);
      }
      case 'place_nexus': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return 0;
        return this.effectiveCost(player, card);
      }
      case 'use_magic': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return 0;
        return this.effectiveCost(player, card);
      }
      case 'flash': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return 0;
        return this.effectiveCost(player, card);
      }
      case 'add_core': {
        return 1; // add_core costs 1 core
      }
      default:
        return 0;
    }
  }

  /** Cost the player would actually pay for this card right now. */
  private effectiveCost(player: PlayerState, card: any): number {
    const fieldSymbols = this.getFieldSymbols(player);
    const hasEXInTrash = player.trash.some((c) => c.exSymbol);
    return calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);
  }

  /** Calculate cost with or without inheritance */
  private effectiveCostWithFlag(player: PlayerState, card: any, useInheritance: boolean): number {
    const fieldSymbols = this.getFieldSymbols(player);
    const hasEXInTrash = player.trash.some((c) => c.exSymbol);
    return calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, useInheritance && !!card.inheritance);
  }

  /** Does the player have a flash magic card they can actually afford? */
  private hasAffordableFlash(player: PlayerState): boolean {
    const totalCores = this.getTotalAvailableCores(player);
    return player.hand.some(
      (c) =>
        c.cardType === 'magic' &&
        c.effects?.some((e) => e.trigger === 'immediate' && (e.isFlash || !e.mode || e.mode === 'flash')) &&
        this.effectiveCost(player, c) <= totalCores,
    );
  }

  legalActions(state: GameState): Action[] {
    if (state.result) return [];

    // First player decision phase: player with right decides who goes first
    if (state.decideFirstPlayerPlayer !== undefined && state.decideFirstPlayerPlayer !== null) {
      return [
        { type: 'choose_order', goFirst: true },
        { type: 'choose_order', goFirst: false },
      ];
    }

    // Rock-paper-scissors phase: both players choose their hand
    if (state.pendingRockPaperScissors && state.pendingRockPaperScissors.rocksChoices === undefined) {
      return [
        { type: 'rock_paper_scissors', choice: 0 }, // rock
        { type: 'rock_paper_scissors', choice: 1 }, // paper
        { type: 'rock_paper_scissors', choice: 2 }, // scissors
      ];
    }

    // Order choice phase: winner chooses to go first or second
    if (state.pendingRockPaperScissors && state.pendingRockPaperScissors.decidingPlayer >= 0) {
      return [
        { type: 'choose_order', goFirst: true },
        { type: 'choose_order', goFirst: false },
      ];
    }

    // Opening hand mulligan: keep as-is, or shuffle the whole hand back and redraw (no card selection)
    if (state.pendingMulligan) {
      return [
        { type: 'mulligan', redraw: false },
        { type: 'mulligan', redraw: true },
      ];
    }

    // Spell chain confirmation: user can add cores to cancel, or confirm to proceed with destruction
    if (state.pendingSpellChain) {
      const actions: Action[] = [
        { type: 'confirm_spell_chain', proceed: true }, // Proceed with destruction
      ];

      // Allow adding cores to cancel destruction
      const me = state.players[state.currentPlayer]!;
      const totalCores = this.getTotalAvailableCores(me);
      if (totalCores > 0) {
        // Add core to newly summoned spirit
        const newSpirit = me.spirits[state.pendingSpellChain.summonedSpiritIndex];
        if (newSpirit) {
          actions.push({ type: 'add_core', spiritIndex: state.pendingSpellChain.summonedSpiritIndex });
        }
        // Add core to any nexus
        for (let i = 0; i < me.nexuses.length; i++) {
          actions.push({ type: 'add_core', nexusIndex: i });
        }
      }

      return actions;
    }

    // If there are opened cards from draw phase, must select one
    if (state.pendingDraw) {
      // Return arrangement action marker
      // UI will determine actual arrangement and send with filled cardIndices
      return [{ type: 'select_draw_arrange', cardIndices: state.pendingDraw.toRearrangeIndices }];
    }

    // If there's a pending attack, defend or take damage
    if (state.pendingAttack) {
      const me = state.players[state.currentPlayer]!;
      const actions: Action[] = [];
      // Can defend with ready spirits
      for (let i = 0; i < me.spirits.length; i++) {
        const s = me.spirits[i]!;
        if (s.canAttack && !s.cannotDefendUntilNextTurn) {
          actions.push({ type: 'block', spiritIndex: i });
        }
      }
      // Always can take damage
      actions.push({ type: 'take_damage' });
      return actions;
    }

    // If there's a pending flash opportunity, only flash or skip_flash actions are legal
    if (state.pendingFlash) {
      const me = state.players[state.currentPlayer]!;
      const opponent = state.players[1 - state.currentPlayer]!;
      const totalCores = this.getTotalAvailableCores(me);
      const actions: Action[] = [];
      // Can activate flash magic cards (only if affordable)
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i]!;
        if (card.cardType !== 'magic') continue;
        // Filter effects by mode: either mode 'flash' or no mode specified (for backward compatibility)
        const flashEffects = card.effects?.filter(e => (e.isFlash || !e.mode || e.mode === 'flash')) ?? [];
        if (flashEffects.length === 0) continue;

        // Check if can afford flash cost
        const flashEffect = flashEffects[0];
        if (flashEffect?.skill === 'ソウルマジック：赤') {
          // Soul Magic: Red can be paid with:
          // 1. Soul core: 1 soul core from reserve or spirits
          // 2. Normal cost: regular cores (6 cores after reduction)
          const canPaySoulCore = me.soulCores >= 1 || me.spirits.some(s => s.soulCoreCount > 0);
          const canPayNormalCost = this.effectiveCost(me, card) <= totalCores;
          if (!canPaySoulCore && !canPayNormalCost) continue;
        } else if (this.effectiveCost(me, card) > totalCores) {
          continue;
        }

        const destroyEffect = flashEffects.find((e) => e.action === 'destroy_creature');
        const boostEffect = flashEffects.find((e) => e.action === 'boost_bp' && e.requiresTarget);

        if (destroyEffect && destroyEffect.requiresTarget) {
          // Condition gate (e.g. フレイムハリケーン requires a red symbol on the field)
          if (destroyEffect.condition?.requiresSymbol) {
            const color = destroyEffect.condition.requiresSymbol;
            const hasSymbol =
              me.spirits.some((s) => s.def.symbolColors?.includes(color)) ||
              me.nexuses.some((n) => n.def.symbolColors?.includes(color));
            if (!hasSymbol) continue;
          }
          // Target an opponent spirit (no BP limit check - that's just the effect condition)
          let hasTarget = false;
          for (let t = 0; t < opponent.spirits.length; t++) {
            actions.push({ type: 'flash', handIndex: i, targetSpiritIndex: t });
            hasTarget = true;
          }
          if (!hasTarget) continue; // no legal target: the flash cannot be declared usefully
        } else if (destroyEffect) {
          // destroy_creature without requiresTarget - can use without selection
          if (destroyEffect.condition?.requiresSymbol) {
            const color = destroyEffect.condition.requiresSymbol;
            const hasSymbol =
              me.spirits.some((s) => s.def.symbolColors?.includes(color)) ||
              me.nexuses.some((n) => n.def.symbolColors?.includes(color));
            if (!hasSymbol) continue;
          }
          actions.push({ type: 'flash', handIndex: i });
        } else if (boostEffect) {
          // Target one of the player's own spirits for the BP boost
          if (me.spirits.length === 0) continue; // nothing to boost
          for (let t = 0; t < me.spirits.length; t++) {
            actions.push({ type: 'flash', handIndex: i, targetSpiritIndex: t });
          }
        } else {
          actions.push({ type: 'flash', handIndex: i });
        }
      }
      // Always can skip flash
      actions.push({ type: 'skip_flash' });
      return actions;
    }

    // Check if phase is a player action phase
    if (state.phase === 'main' || state.phase === 'main2') {
      return this.getMainPhaseActions(state);
    } else if (state.phase === 'attack') {
      return this.getAttackPhaseActions(state);
    }

    // Other phases (start, core, draw, refresh, end) have no player actions
    return [];
  }

  private getMainPhaseActions(state: GameState): Action[] {
    const actions: Action[] = [];
    const me = state.players[state.currentPlayer]!;
    const totalCores = this.getTotalAvailableCores(me);

    // Normal turn actions: only offer cards the player can actually pay for
    for (let i = 0; i < me.hand.length; i++) {
      const card = me.hand[i]!;
      if (this.effectiveCost(me, card) > totalCores) continue;

      if (card.cardType === 'spirit') {
        // Payment covers only the card's cost, but the player must also be able to
        // MOVE Lv1 maintenance cores onto the spirit for the summon to be legal
        // Check if inheritance can save cores
        if (card.inheritance) {
          const costWithInheritance = this.effectiveCostWithFlag(me, card, true);
          const costWithoutInheritance = this.effectiveCostWithFlag(me, card, false);
          const canWithInheritance = costWithInheritance + card.lv1.cost <= totalCores;
          const canWithoutInheritance = costWithoutInheritance + card.lv1.cost <= totalCores;

          if (canWithoutInheritance) {
            actions.push({ type: 'summon', handIndex: i, useInheritance: false });
          }
          if (canWithInheritance && costWithInheritance < costWithoutInheritance) {
            // Only add inheritance option if it actually saves cores
            actions.push({ type: 'summon', handIndex: i, useInheritance: true });
          }
        } else {
          // No inheritance possible, just add normal summon
          if (this.effectiveCost(me, card) + card.lv1.cost <= totalCores) {
            actions.push({ type: 'summon', handIndex: i });
          }
        }
      } else if (card.cardType === 'nexus') {
        // Must also be able to move Lv1 maintenance cores onto the nexus
        if (card.inheritance) {
          const costWithInheritance = this.effectiveCostWithFlag(me, card, true);
          const costWithoutInheritance = this.effectiveCostWithFlag(me, card, false);
          const canWithInheritance = costWithInheritance + card.lv1.cost <= totalCores;
          const canWithoutInheritance = costWithoutInheritance + card.lv1.cost <= totalCores;

          if (canWithoutInheritance) {
            actions.push({ type: 'place_nexus', handIndex: i, useInheritance: false });
          }
          if (canWithInheritance && costWithInheritance < costWithoutInheritance) {
            actions.push({ type: 'place_nexus', handIndex: i, useInheritance: true });
          }
        } else {
          if (this.effectiveCost(me, card) + card.lv1.cost <= totalCores) {
            actions.push({ type: 'place_nexus', handIndex: i });
          }
        }
      } else if (card.cardType === 'magic') {
        // Check if the magic card can be afforded (considering inheritance)
        let canAfford = false;
        let useInheritanceIfAvailable = false;

        if (card.inheritance) {
          const costWithInheritance = this.effectiveCostWithFlag(me, card, true);
          const costWithoutInheritance = this.effectiveCostWithFlag(me, card, false);

          if (costWithoutInheritance <= totalCores) {
            canAfford = true;
          }
          if (costWithInheritance <= totalCores && costWithInheritance < costWithoutInheritance) {
            useInheritanceIfAvailable = true;
            canAfford = true;
          }
        } else {
          const effectiveMagicCost = this.effectiveCost(me, card);
          if (effectiveMagicCost <= totalCores) {
            canAfford = true;
          }
        }

        if (!canAfford) continue; // Can't afford this magic card

        // Filter effects by mode (main phase effects: mode 'main', no mode, or Soul Magic can use flash as main too)
        const mainEffects = card.effects?.filter(e => {
          if (!e.mode || e.mode === 'main') return true;
          // Soul Magic: Red can be used in main phase even though it's marked as flash
          if (card.skill === 'ソウルマジック：赤' && e.mode === 'flash') return true;
          return false;
        }) ?? [];
        if (mainEffects.length === 0) continue; // No main-phase effects for this card

        // Check if card has effects with requiresTarget (for spirits or nexuses)
        const hasDestroyNexusEffect = mainEffects.some((e) => e.action === 'destroy_nexus') ?? false;
        const hasOtherTargetEffect = mainEffects.some((e) => e.requiresTarget && e.action !== 'destroy_nexus') ?? false;
        // Check if card has effects with variableValue
        const hasVariableEffect = mainEffects.some((e) => e.variableValue) ?? false;

        if (hasDestroyNexusEffect) {
          // Generate targeting actions for opponent nexuses (Lv1 only, not Lv2)
          const opponent = state.players[1 - state.currentPlayer]!;
          const validNexusIndices: number[] = [];
          for (let t = 0; t < opponent.nexuses.length; t++) {
            if (opponent.nexuses[t]!.level !== 2) {
              validNexusIndices.push(t);
            }
          }
          if (validNexusIndices.length > 0) {
            for (const nexusIndex of validNexusIndices) {
              actions.push({ type: 'use_magic', handIndex: i, targetNexusIndex: nexusIndex, useInheritance: useInheritanceIfAvailable });
            }
          } else {
            // No valid nexus targets, but card can still be used (effect won't trigger)
            actions.push({ type: 'use_magic', handIndex: i, useInheritance: useInheritanceIfAvailable });
          }
        } else if (hasOtherTargetEffect) {
          // Generate targeting actions for opponent spirits
          const opponent = state.players[1 - state.currentPlayer]!;
          for (let t = 0; t < opponent.spirits.length; t++) {
            actions.push({ type: 'use_magic', handIndex: i, targetSpiritIndex: t, useInheritance: useInheritanceIfAvailable });
          }
        } else if (hasVariableEffect) {
          // Generate variable value actions (0 to max, typically hand size or some reasonable max)
          const maxValue = Math.min(me.hand.length, 5); // Reasonable max for discards
          for (let v = 0; v <= maxValue; v++) {
            actions.push({ type: 'use_magic', handIndex: i, effectValue: v, useInheritance: useInheritanceIfAvailable });
          }
        } else {
          // No targeting or variable values needed
          actions.push({ type: 'use_magic', handIndex: i, useInheritance: useInheritanceIfAvailable });
        }
      }
    }

    // Place a core from reserve onto a spirit or nexus
    // Note: add_core only uses cores from reserve, not from spirits, so check reserve specifically
    const reserveCores = me.cores + me.soulCores;
    if (reserveCores > 0) {
      // Add cores to spirits (level-up)
      for (let i = 0; i < me.spirits.length; i++) {
        const s = me.spirits[i]!;
        if (s.def.lv2 && s.coreCount < s.def.lv2.cost) {
          actions.push({ type: 'add_core', spiritIndex: i });
        }
      }
      // Add cores to nexuses (level-up)
      for (let i = 0; i < me.nexuses.length; i++) {
        const n = me.nexuses[i]!;
        if (n.def.lv2 && n.coreCount < n.def.lv2.cost) {
          actions.push({ type: 'add_core', nexusIndex: i });
        }
      }
    }

    // Can pass to next phase (or end turn if Main2)
    actions.push({ type: 'pass' });

    return actions;
  }

  private getAttackPhaseActions(state: GameState): Action[] {
    const actions: Action[] = [];
    const me = state.players[state.currentPlayer]!;
    const opponent = state.players[1 - state.currentPlayer]!;

    // Attack with ready (non-fatigued) spirits only
    for (let i = 0; i < me.spirits.length; i++) {
      const s = me.spirits[i]!;
      if (s.canAttack && !s.cannotAttackUntilNextTurn) {
        // Check if this spirit has effects that require target selection.
        // A discard can be the effect itself (action) or an activation cost (costAction, ▶ compound effects).
        const discardEffect = s.def.effects?.find(
          (e) => e.trigger === 'attack' && (e.action === 'discard_hand' || e.costAction === 'discard_hand') && e.level?.includes(s.level)
        );
        const placeCoreEffect = s.def.effects?.find(
          (e) => e.trigger === 'attack' && e.action === 'place_core' && e.requiresTarget && e.level?.includes(s.level)
        );
        const destroyCreatureEffect = s.def.effects?.find(
          (e) => e.trigger === 'attack' && e.action === 'destroy_creature' && e.requiresTarget && e.level?.includes(s.level)
        );

        if (discardEffect) {
          // Find cards in hand that match the discard lineage (系統, e.g. 風牙)
          const targetLineage = discardEffect.costAction === 'discard_hand' ? discardEffect.costSymbol : discardEffect.symbol;
          const validCardIndices: number[] = [];
          for (let j = 0; j < me.hand.length; j++) {
            const card = me.hand[j]!;
            if (!targetLineage || card.lineage?.includes(targetLineage)) {
              validCardIndices.push(j);
            }
          }

          // Generate one attack action for each valid card choice
          for (const cardIndex of validCardIndices) {
            actions.push({ type: 'attack', spiritIndex: i, discardCardIndex: cardIndex });
          }
          // Activated (起動) abilities are optional: always allow attacking without paying the cost
          actions.push({ type: 'attack', spiritIndex: i });
        } else if (placeCoreEffect) {
          // place_core effect requires target spirit selection
          // Generate one attack action for each own spirit (except the attacker)
          let hasValidTarget = false;
          for (let ti = 0; ti < me.spirits.length; ti++) {
            if (ti !== i) {
              actions.push({ type: 'attack', spiritIndex: i, effectTargetIndex: ti });
              hasValidTarget = true;
            }
          }
          // If no valid targets, still allow attack without target
          if (!hasValidTarget) {
            actions.push({ type: 'attack', spiritIndex: i });
          }
        } else if (destroyCreatureEffect) {
          // destroy_creature effect requires opponent spirit target selection
          // Generate one attack action for each opponent spirit
          let hasValidTarget = false;
          for (let ti = 0; ti < opponent.spirits.length; ti++) {
            actions.push({ type: 'attack', spiritIndex: i, effectTargetIndex: ti });
            hasValidTarget = true;
          }
          // If no valid targets, still allow attack without target
          if (!hasValidTarget) {
            actions.push({ type: 'attack', spiritIndex: i });
          }
        } else {
          // No targeting requirement - normal attack
          actions.push({ type: 'attack', spiritIndex: i });
        }
      }
    }

    // Always can pass to Main2
    actions.push({ type: 'pass' });

    return actions;
  }

  applyAction(state: GameState, action: Action, rng: Rng): GameState {
    let next = cloneState(state);
    const me = next.players[next.currentPlayer]!;
    const opponent = next.players[1 - next.currentPlayer]!;

    // Rock-paper-scissors: collect both players' choices
    if (action.type === 'rock_paper_scissors') {
      if (!next.pendingRockPaperScissors || next.pendingRockPaperScissors.rocksChoices !== undefined) return next;

      if (next.currentPlayer === 0) {
        // Store player 0's choice temporarily in p0Choice
        next.pendingRockPaperScissors.p0Choice = action.choice;
        next.currentPlayer = 1;
        return next;
      } else {
        // Player 1 choosing - now we have both choices
        const p0Choice = next.pendingRockPaperScissors.p0Choice!;
        const p1Choice = action.choice;
        // Determine winner: rock=0, paper=1, scissors=2
        // paper beats rock, scissors beats paper, rock beats scissors
        let winner: number;
        if (p0Choice === p1Choice) {
          // Tie: replay (shouldn't happen with random AI, but handle it)
          winner = rng.int(2);
        } else if ((p0Choice + 1) % 3 === p1Choice) {
          winner = 1;
        } else {
          winner = 0;
        }
        // Store actual choices so test loop exits, but set rocksChoices[1] to an empty array
        // to signal completion while keeping decidingPlayer for order selection
        next.pendingRockPaperScissors = { rocksChoices: [p0Choice, p1Choice], decidingPlayer: winner };
        next.currentPlayer = winner;
        return next;
      }
    }

    // Choose order: winner decides to go first or second
    if (action.type === 'choose_order') {
      let firstPlayer: number;

      // If decideFirstPlayerPlayer is set, that player decides who goes first
      if (next.decideFirstPlayerPlayer !== undefined && next.decideFirstPlayerPlayer !== null) {
        const decider = next.decideFirstPlayerPlayer;
        firstPlayer = action.goFirst ? decider : 1 - decider;
        next.decideFirstPlayerPlayer = null;
      } else if (next.pendingRockPaperScissors && next.pendingRockPaperScissors.decidingPlayer >= 0) {
        // RPS-based order choice (legacy path)
        const winner = next.pendingRockPaperScissors.decidingPlayer;
        firstPlayer = action.goFirst ? winner : 1 - winner;
        next.pendingRockPaperScissors = null;
      } else {
        return next;
      }

      next.pendingMulligan = { player: firstPlayer, firstPlayer };
      next.currentPlayer = firstPlayer;
      return next;
    }

    // Opening hand mulligan: keep as-is, or shuffle the whole hand back into the deck and redraw
    if (action.type === 'mulligan') {
      if (!next.pendingMulligan) return next;
      const decidingPlayer = next.pendingMulligan.player;
      const firstPlayer = next.pendingMulligan.firstPlayer;
      const p = next.players[decidingPlayer]!;

      if (action.redraw) {
        p.deck.push(...p.hand);
        p.hand = [];
        rng.shuffle(p.deck);
        this.drawOpeningHand(p);
      }

      const otherPlayer = 1 - decidingPlayer;
      if (decidingPlayer === firstPlayer) {
        // First player completed mulligan; move to second player
        next.pendingMulligan = { player: otherPlayer, firstPlayer };
        next.currentPlayer = otherPlayer;
        return next;
      }

      // Second player completed mulligan; start the first turn
      next.pendingMulligan = null;
      next.currentPlayer = firstPlayer;
      return this.startTurn(next);
    }

    // Handle flash actions and flash skipping
    if (action.type === 'flash') {
      const card = me.hand[action.handIndex];
      if (!card || card.cardType !== 'magic') return next;

      // Calculate cost
      const fieldSymbols = this.getFieldSymbols(me);
      const hasEXInTrash = me.trash.some((c) => c.exSymbol);
      const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);

      // Check if player has enough cores (including from spirits)
      const totalAvailable = this.getTotalAvailableCores(me);
      if (actualCost > totalAvailable) return next;

      // Use the magic card as flash
      me.hand.splice(action.handIndex, 1);
      this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
      this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores
      me.trash.push(card);
      // For Soul Magic Red: skip symbol check if paid with normal cost (not soul core)
      const hasSoulMagicRedEffect = card.skill === 'ソウルマジック：赤' || card.effects?.some(e => e.skill === 'ソウルマジック：赤');
      const paidWithNormalCore = (action.paidRegularCores ?? 0) > 0;
      const skipSymbolCheck = hasSoulMagicRedEffect && paidWithNormalCore;
      next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue, undefined, 'flash', action.targetNexusIndex, undefined, undefined, skipSymbolCheck);
      checkResult(next);
      if (next.result) return next;

      // Re-read after the above effects: a destroy_creature (etc.) effect may have
      // removed the stashed attacker, in which case fixupSpiritIndicesAfterRemoval
      // already cancelled it (set to undefined) or shifted its index.
      const stashedAttack = next.pendingFlash?.stashedAttack;

      // Always give opponent counter-timing opportunity (stack flash)
      // Even if they don't have any flash cards, they must explicitly skip flash
      next.pendingFlash = {
        trigger: next.pendingFlash!.trigger,
        cardId: '',
        initiatingPlayer: next.pendingFlash!.initiatingPlayer,
        lastFlashPlayer: next.currentPlayer,
        stashedAttack,
      };
      // Switch to opponent for counter-timing
      next.currentPlayer = 1 - next.currentPlayer;
      return next;
    }

    if (action.type === 'skip_flash') {
      if (!next.pendingFlash) return next;

      // If there was a flash used before, return to initiator to continue
      if (next.pendingFlash.lastFlashPlayer !== undefined && next.pendingFlash.lastFlashPlayer !== next.pendingFlash.initiatingPlayer) {
        // Return to initiating player (attacker) for potential counter-flash
        next.currentPlayer = next.pendingFlash.initiatingPlayer;
        next.pendingFlash.lastFlashPlayer = undefined; // Clear last flash player to allow re-stacking
        checkResult(next);
        return next;
      }

      // No more flash opportunity: clear and resolve
      const stashedAttack = next.pendingFlash.stashedAttack;
      next.pendingFlash = null;
      if (stashedAttack) {
        // This flash window opened in response to an attack declaration; now that it's
        // closed, hand control to the defender to choose defend/take_damage.
        next.pendingAttack = stashedAttack;
        next.currentPlayer = 1 - stashedAttack.attackerPlayer;
      } else {
        next.currentPlayer = 1 - next.currentPlayer;
      }
      checkResult(next);
      return next;
    }

    // Handle attack defense
    if (action.type === 'block') {
      const defender = me.spirits[action.spiritIndex];
      if (!defender || !next.pendingAttack) return next;

      const pendingAttack = next.pendingAttack;
      const attacker = next.players[pendingAttack.attackerPlayer]!.spirits[pendingAttack.attackerSpiritIndex]!;
      const attackerStats = attacker.level === 1 ? attacker.def.lv1 : attacker.def.lv2 || attacker.def.lv1;
      const attackBP = attackerStats.bp + (attacker.bpBoost ?? 0) + (attacker.bpBoostBattle ?? 0);

      const defenderStats = defender.level === 1 ? defender.def.lv1 : defender.def.lv2 || defender.def.lv1;
      const defendBP = defenderStats.bp + (defender.bpBoost ?? 0) + (defender.bpBoostBattle ?? 0);

      // Both spirits become fatigued
      defender.canAttack = false;
      attacker.canAttack = false;

      // Resolve battle (destroyed spirits go to trash; their cores return to reserve)
      if (attackBP > defendBP) {
        // Attacker wins: destroy defender
        destroySpirit(me, action.spiritIndex);
        next = triggerEffects(next, 'destroy', defender.def, next.currentPlayer);
        // Trigger nexus destroy effects for defender's player
        for (let ni = 0; ni < me.nexuses.length; ni++) {
          const nexus = me.nexuses[ni]!;
          next = triggerEffects(next, 'destroy', nexus.def, next.currentPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
        }
      } else if (attackBP < defendBP) {
        // Defender wins: destroy attacker
        const attackerPlayer = next.players[pendingAttack.attackerPlayer]!;
        destroySpirit(attackerPlayer, pendingAttack.attackerSpiritIndex);
        next = triggerEffects(next, 'destroy', attacker.def, 1 - next.currentPlayer);
        // Trigger nexus destroy effects for attacker's player
        for (let ni = 0; ni < attackerPlayer.nexuses.length; ni++) {
          const nexus = attackerPlayer.nexuses[ni]!;
          next = triggerEffects(next, 'destroy', nexus.def, 1 - next.currentPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
        }
      } else {
        // Equal BP: both destroyed
        destroySpirit(me, action.spiritIndex);
        destroySpirit(next.players[pendingAttack.attackerPlayer]!, pendingAttack.attackerSpiritIndex);
        next = triggerEffects(next, 'destroy', defender.def, next.currentPlayer);
        next = triggerEffects(next, 'destroy', attacker.def, 1 - next.currentPlayer);
        // Trigger nexus destroy effects for both players
        for (let ni = 0; ni < me.nexuses.length; ni++) {
          const nexus = me.nexuses[ni]!;
          next = triggerEffects(next, 'destroy', nexus.def, next.currentPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
        }
        for (let ni = 0; ni < next.players[pendingAttack.attackerPlayer]!.nexuses.length; ni++) {
          const nexus = next.players[pendingAttack.attackerPlayer]!.nexuses[ni]!;
          next = triggerEffects(next, 'destroy', nexus.def, 1 - next.currentPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
        }
      }

      // Trigger battle_end effects
      next = triggerEffects(next, 'battle_end', attacker.def, 1 - next.currentPlayer);
      next = triggerEffects(next, 'battle_end', defender.def, next.currentPlayer);

      // このバトル中 boosts expire now that the battle has resolved
      this.clearBattleBoosts(next);

      next.pendingAttack = null;
      next.currentPlayer = 1 - next.currentPlayer; // Return turn to original player
      checkResult(next);
      return next;
    }

    if (action.type === 'take_damage') {
      if (!next.pendingAttack) return next;

      const opponent = next.players[next.pendingAttack.attackerPlayer]!;
      const attacker = opponent.spirits[next.pendingAttack.attackerSpiritIndex]!;

      // Attacker becomes fatigued
      attacker.canAttack = false;

      // Take damage and place cores in reserve
      const damage = next.pendingAttack.damage;
      me.life -= damage;
      me.cores += damage; // Add cores to reserve when taking damage

      // Trigger battle_end effects
      next = triggerEffects(next, 'battle_end', attacker.def, 1 - next.currentPlayer);

      // このバトル中 boosts expire now that the battle has resolved
      this.clearBattleBoosts(next);

      next.pendingAttack = null;
      next.currentPlayer = 1 - next.currentPlayer; // Return turn to original player
      checkResult(next);
      return next;
    }

    switch (action.type) {
      case 'summon': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'spirit') return next;

        // Calculate cost after reductions
        const fieldSymbols = this.getFieldSymbols(me);
        const hasEXInTrash = me.trash.some((c) => c.exSymbol);
        const costWithoutInheritance = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, false);
        const useInheritance = action.useInheritance !== false && !!card.inheritance;
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, useInheritance);
        const usedInheritance = useInheritance && costWithoutInheritance > actualCost && hasEXInTrash;

        // Need enough cores to pay the cost AND move Lv1 maintenance cores onto the spirit
        const totalAvailable = this.getTotalAvailableCores(me);
        if (totalAvailable < actualCost + card.lv1.cost) return next;

        // 支払うコア: pay only the summon cost (paid cores go to trash)
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores

        // If inheritance was used, remove one EX symbol card from trash
        if (usedInheritance) {
          const exIndex = me.trash.findIndex((c) => c.exSymbol);
          if (exIndex !== -1) {
            me.trash.splice(exIndex, 1);
          }
        }

        // 乗せるコア: MOVE Lv1 maintenance cores from reserve onto the spirit
        // (moved, not paid — they stay on the spirit as assets)
        let toPlace = card.lv1.cost;
        let placedRegular = 0;
        let placedSoul = 0;
        while (toPlace > 0 && (me.cores > 0 || me.soulCores > 0)) {
          if (me.cores > 0) {
            me.cores -= 1;
            placedRegular += 1;
          } else {
            me.soulCores -= 1;
            placedSoul += 1;
          }
          toPlace -= 1;
        }

        // A spirit that could not receive any maintenance core is immediately depleted (消滅)
        if (placedRegular + placedSoul === 0 && card.lv1.cost > 0) {
          me.trash.push(card);
          break;
        }

        const spirit: any = {
          def: card,
          level: 1,
          coreCount: placedRegular,
          soulCoreCount: placedSoul,
          canAttack: true,
          bpBoost: 0,
        };
        updateSpiritLevel(spirit);
        const newSpiritIndex = me.spirits.length;
        me.spirits.push(spirit);

        // Check if summon effects will destroy opponent's spirits/nexuses
        const hasDestructiveEffect =
          card.effects?.some((e) => e.trigger === 'summon' && (e.action === 'destroy_creature' || e.action === 'destroy_nexus')) ?? false;

        if (hasDestructiveEffect) {
          // Simulate effects to detect destructions
          const simState = cloneState(next);
          triggerEffects(simState, 'summon', card, next.currentPlayer, newSpiritIndex, undefined, undefined, undefined, undefined, undefined, spirit.level);

          // Detect which opponent spirits/nexuses would be destroyed
          const opponent = simState.players[1 - next.currentPlayer]!;
          const originalOpponent = next.players[1 - next.currentPlayer]!;

          const destructedSpiritIndices: number[] = [];
          const destructedNexusIndices: number[] = [];

          // Find destroyed spirits
          for (let i = 0; i < originalOpponent.spirits.length; i++) {
            if (!opponent.spirits[i]) {
              destructedSpiritIndices.push(i);
            }
          }

          // Find destroyed nexuses
          for (let i = 0; i < originalOpponent.nexuses.length; i++) {
            if (!opponent.nexuses[i]) {
              destructedNexusIndices.push(i);
            }
          }

          // If destructions are detected, set pending state and wait for confirmation
          if (destructedSpiritIndices.length > 0 || destructedNexusIndices.length > 0) {
            next.pendingSpellChain = {
              summonedSpiritIndex: newSpiritIndex,
              summonedCard: card,
              destructedSpiritIndices,
              destructedNexusIndices,
            };
            break;
          }
        }

        // Trigger summon effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer, newSpiritIndex, undefined, undefined, undefined, undefined, undefined, spirit.level);
        break;
      }
      case 'confirm_spell_chain': {
        if (!next.pendingSpellChain) return next;

        const { proceed } = action;
        const pending = next.pendingSpellChain;
        const newSpiritIndex = pending.summonedSpiritIndex;
        const card = pending.summonedCard;
        const me = next.players[next.currentPlayer]!;
        const newSpirit = me.spirits[newSpiritIndex]!;

        next.pendingSpellChain = null;

        if (!proceed) {
          // User cancelled: remove the newly summoned spirit and put it back to hand/trash
          // (for now, just keep it placed so user can add cores or take other actions)
          return next;
        }

        // User confirmed: trigger the summon effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer, newSpiritIndex, undefined, undefined, undefined, undefined, undefined, newSpirit.level);
        break;
      }
      case 'add_core': {
        // If spell chain is pending and user adds core, clear it (cancels destruction)
        if (next.pendingSpellChain) {
          next.pendingSpellChain = null;
        }

        const totalCores = this.getTotalAvailableCores(me);
        if (totalCores <= 0) return next;

        // Place 1 core on spirit or nexus
        if (action.spiritIndex !== undefined) {
          const spirit = me.spirits[action.spiritIndex];
          if (!spirit) return next;

          // Place 1 core on spirit (regular or soul based on coreType)
          if (action.coreType === 'soul') {
            if (me.soulCores > 0) {
              me.soulCores -= 1;
              spirit.soulCoreCount = (spirit.soulCoreCount || 0) + 1;
            } else if (me.cores > 0) {
              me.cores -= 1;
              spirit.coreCount += 1;
            }
          } else {
            // Default: use regular cores first
            if (me.cores > 0) {
              me.cores -= 1;
              spirit.coreCount += 1;
            } else if (me.soulCores > 0) {
              me.soulCores -= 1;
              spirit.soulCoreCount = (spirit.soulCoreCount || 0) + 1;
            }
          }
          updateSpiritLevel(spirit);
        } else if (action.nexusIndex !== undefined) {
          const nexus = me.nexuses[action.nexusIndex];
          if (!nexus) return next;

          // Place 1 core on nexus (track soul cores separately)
          if (action.coreType === 'soul') {
            if (me.soulCores > 0) {
              me.soulCores -= 1;
              nexus.soulCoreCount += 1;
            } else if (me.cores > 0) {
              me.cores -= 1;
              nexus.coreCount += 1;
            }
          } else {
            // Default: use regular cores first
            if (me.cores > 0) {
              me.cores -= 1;
              nexus.coreCount += 1;
            } else if (me.soulCores > 0) {
              me.soulCores -= 1;
              nexus.soulCoreCount += 1;
            }
          }
          updateSpiritLevel(nexus as any); // Update nexus level if applicable
        }
        break;
      }
      case 'move_core': {
        // Free core movement via drag & drop (main steps only)
        if (next.phase !== 'main' && next.phase !== 'main2') return next;
        if (next.pendingAttack || next.pendingFlash || next.pendingDraw) return next;

        const coreType = action.coreType;

        // Take 1 core of the given type from the source zone
        const takeCore = (): boolean => {
          if (action.fromZone === 'reserve') {
            if (coreType === 'soul') {
              if (me.soulCores <= 0) return false;
              me.soulCores -= 1;
            } else {
              if (me.cores <= 0) return false;
              me.cores -= 1;
            }
            return true;
          }
          if (action.fromZone === 'spirit') {
            const s = me.spirits[action.fromIndex ?? -1];
            if (!s) return false;
            if (coreType === 'soul') {
              if (s.soulCoreCount <= 0) return false;
              s.soulCoreCount -= 1;
            } else {
              if (s.coreCount <= 0) return false;
              s.coreCount -= 1;
            }
            updateSpiritLevel(s);
            return true;
          }
          if (action.fromZone === 'nexus') {
            const n = me.nexuses[action.fromIndex ?? -1];
            if (!n) return false;
            if (coreType === 'soul') {
              if (n.soulCoreCount <= 0) return false;
              n.soulCoreCount -= 1;
            } else {
              if (n.coreCount <= 0) return false;
              n.coreCount -= 1;
            }
            updateSpiritLevel(n as any);
            return true;
          }
          return false;
        };

        // Put 1 core of the given type into the destination zone
        const putCore = (): boolean => {
          if (action.toZone === 'reserve') {
            if (coreType === 'soul') me.soulCores += 1;
            else me.cores += 1;
            return true;
          }
          if (action.toZone === 'spirit') {
            const s = me.spirits[action.toIndex ?? -1];
            if (!s) return false;
            if (coreType === 'soul') s.soulCoreCount += 1;
            else s.coreCount += 1;
            updateSpiritLevel(s);
            return true;
          }
          if (action.toZone === 'nexus') {
            const n = me.nexuses[action.toIndex ?? -1];
            if (!n) return false;
            if (coreType === 'soul') n.soulCoreCount += 1;
            else n.coreCount += 1;
            updateSpiritLevel(n as any);
            return true;
          }
          return false;
        };

        // Validate destination exists BEFORE taking the core
        const destValid =
          action.toZone === 'reserve' ||
          (action.toZone === 'spirit' && !!me.spirits[action.toIndex ?? -1]) ||
          (action.toZone === 'nexus' && !!me.nexuses[action.toIndex ?? -1]);
        if (!destValid) return next;

        // Same-zone no-op check
        if (
          action.fromZone === action.toZone &&
          (action.fromZone === 'reserve' || action.fromIndex === action.toIndex)
        ) {
          return next;
        }

        if (!takeCore()) return next;
        putCore();

        // Spirits/nexuses that lost their last core are depleted (消滅 — no destroy effects)
        this.removeDeadSpirits(next, next.currentPlayer);
        this.removeDeadNexuses(next, next.currentPlayer);
        break;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return next;

        // Calculate cost after reductions
        const fieldSymbols = this.getFieldSymbols(me);
        const hasEXInTrash = me.trash.some((c) => c.exSymbol);
        const costWithoutInheritance = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, false);
        const useInheritance = action.useInheritance !== false && !!card.inheritance;
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, useInheritance);
        const usedInheritance = useInheritance && costWithoutInheritance > actualCost && hasEXInTrash;

        // Need enough cores to pay the cost AND move Lv1 maintenance cores onto the nexus
        const totalAvailable = this.getTotalAvailableCores(me);
        if (totalAvailable < actualCost + card.lv1.cost) return next;

        // 支払うコア: pay only the placement cost (paid cores go to trash)
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores

        // If inheritance was used, remove one EX symbol card from trash
        if (usedInheritance) {
          const exIndex = me.trash.findIndex((c) => c.exSymbol);
          if (exIndex !== -1) {
            me.trash.splice(exIndex, 1);
          }
        }

        // 乗せるコア: MOVE Lv1 maintenance cores from reserve onto the nexus
        let nexusToPlace = card.lv1.cost;
        let nexusRegular = 0;
        let nexusSoul = 0;
        while (nexusToPlace > 0 && (me.cores > 0 || me.soulCores > 0)) {
          if (me.cores > 0) {
            me.cores -= 1;
            nexusRegular += 1;
          } else {
            me.soulCores -= 1;
            nexusSoul += 1;
          }
          nexusToPlace -= 1;
        }

        // A nexus that could not receive any maintenance core is immediately depleted (消滅)
        if (nexusRegular + nexusSoul === 0 && card.lv1.cost > 0) {
          me.trash.push(card);
          break;
        }

        // Place nexus
        const nexus: Nexus = {
          def: card,
          level: 1,
          coreCount: nexusRegular,
          soulCoreCount: nexusSoul,
        };
        me.nexuses.push(nexus);

        // Trigger deployment effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer);
        break;
      }
      case 'use_magic': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return next;

        // Calculate cost after reductions
        const fieldSymbols = this.getFieldSymbols(me);
        const hasEXInTrash = me.trash.some((c) => c.exSymbol);
        const costWithoutInheritance = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, false);
        const useInheritance = action.useInheritance !== false && !!card.inheritance;
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, useInheritance);
        const usedInheritance = useInheritance && costWithoutInheritance > actualCost && hasEXInTrash;

        // Check if player has enough cores (including from spirits)
        const totalAvailable = this.getTotalAvailableCores(me);
        if (actualCost > totalAvailable) return next;

        // Pay cost using specified regular/soul core distribution
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores

        // If inheritance was used, remove one EX symbol card from trash
        if (usedInheritance) {
          const exIndex = me.trash.findIndex((c) => c.exSymbol);
          if (exIndex !== -1) {
            me.trash.splice(exIndex, 1);
          }
        }

        me.trash.push(card);

        // For Soul Magic Red: skip symbol check if paid with normal cost (not soul core)
        const hasSoulMagicRedEffect = card.skill === 'ソウルマジック：赤' || card.effects?.some(e => e.skill === 'ソウルマジック：赤');
        const paidWithNormalCore = (action.paidRegularCores ?? 0) > 0;
        const skipSymbolCheck = hasSoulMagicRedEffect && paidWithNormalCore;

        // Special handling for オファーリングドロー
        if (card.id === 'magic_offering_draw') {
          if (me.deck.length === 0) {
            // Deck out
            next.result = { winner: 1 - next.currentPlayer };
            return next;
          }

          // Open up to 3 cards from top of deck
          const openCount = Math.min(3, me.deck.length);
          const openedCards: any[] = [];
          for (let i = 0; i < openCount; i++) {
            openedCards.push(me.deck.shift()!);
          }

          // Identify 風牙 lineage cards (only these can be added to hand)
          const windFangIndices: number[] = [];
          for (let i = 0; i < openedCards.length; i++) {
            const c = openedCards[i];
            const hasWindFangLineage = c.lineage && c.lineage.includes('風牙');
            const isNotOfferingDraw = c.id !== 'magic_offering_draw';
            if (hasWindFangLineage && isNotOfferingDraw) {
              windFangIndices.push(i);
            }
          }

          // All opened cards can be arranged back to deck (cards selected for hand will go there)
          const toRearrangeIndices: number[] = [];
          for (let i = 0; i < openedCards.length; i++) {
            toRearrangeIndices.push(i);
          }

          // Set pending draw for player to select and arrange cards
          // Player sees all 3 cards and can select up to 2 (but only 風牙 cards can be added to hand)
          next.pendingDraw = {
            openedCards,
            toHandIndices: toRearrangeIndices.slice(), // Show all cards for player to choose from
            toRearrangeIndices, // All cards can be arranged back to deck
            selectableIndices: windFangIndices, // Only 風牙 lineage cards are eligible for hand
            castCard: card, // Store the card so we can trigger effects after selection
            maxSelectable: 2,
            returnDestination: 'deck', // Unselected cards go back to deck bottom
            targetSpiritIndex: action.targetSpiritIndex, // Store for later effect processing
            effectValue: action.effectValue, // Store for later effect processing
          };
          return next; // Stop here, player must select cards
        }

        // Trigger magic effects with optional target and value (skipSymbolCheck already defined above)
        next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue, undefined, 'main', action.targetNexusIndex, undefined, undefined, skipSymbolCheck);
        // Fall through to flash checking below
        break;
      }
      case 'attack': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || !spirit.canAttack) return next;

        // Check for search_deck effects that require user selection
        const searchDeckEffect = spirit.def.effects?.find(e =>
          e.trigger === 'attack' &&
          e.action === 'search_deck' &&
          (!e.level || e.level.includes(spirit.level))
        );

        // Trigger attack effects (may boost BP, place cores, etc.), passing discardCardIndex/effectTargetIndex if provided
        // This EXCLUDES search_deck, which requires user selection and will be handled after the user selects cards
        next = triggerEffects(next, 'attack', spirit.def, next.currentPlayer, action.spiritIndex, action.effectTargetIndex, undefined, action.discardCardIndex, undefined, undefined, spirit.level, undefined, undefined, ['search_deck']);

        // Nexus "attack"-trigger effects (e.g. buffs during my attack step)
        const attackerNow = next.players[next.currentPlayer]!;
        for (let ni = 0; ni < attackerNow.nexuses.length; ni++) {
          const nexus = attackerNow.nexuses[ni]!;
          next = triggerEffects(next, 'attack', nexus.def, next.currentPlayer, action.spiritIndex, undefined, undefined, undefined, undefined, undefined, nexus.level, ni);
        }

        // If there's a search_deck effect, wait for user to select cards before proceeding to pendingAttack
        if (searchDeckEffect) {
          const me = next.players[next.currentPlayer]!;
          const openCount = Math.min(searchDeckEffect.value ?? 2, me.deck.length);
          const openedCards: CardDef[] = [];
          for (let i = 0; i < openCount; i++) {
            openedCards.push(me.deck.shift()!);
          }

          // Identify selectable cards (by symbol if specified)
          const selectableIndices: number[] = [];
          for (let i = 0; i < openedCards.length; i++) {
            const c = openedCards[i]!;
            const hasSymbol = !searchDeckEffect.symbol || c.lineage?.includes(searchDeckEffect.symbol);
            if (hasSymbol) {
              selectableIndices.push(i);
            }
          }

          // Identify remaining cards (non-selectable)
          const toRearrangeIndices: number[] = [];
          for (let i = 0; i < openedCards.length; i++) {
            if (!selectableIndices.includes(i)) {
              toRearrangeIndices.push(i);
            }
          }

          // Set pending draw for player to select cards
          next.pendingDraw = {
            openedCards,
            toHandIndices: selectableIndices,
            toRearrangeIndices,
            selectableIndices,
            castCard: spirit.def,
            maxSelectable: searchDeckEffect.count ?? 1,
            returnDestination: 'trash', // attack search_deck cards go to trash, not deck bottom
            originAttackSpiritIndex: action.spiritIndex, // track that this came from an attack
          };
          return next; // Stop here, player must select cards
        }

        // No search_deck effect: create pending attack opportunity for opponent to defend
        const damage = spirit.def.symbolCount;
        const pendingAttack: PendingAttack = {
          attackerPlayer: next.currentPlayer,
          attackerSpiritIndex: action.spiritIndex,
          damage,
        };

        const defenderIndex = 1 - next.currentPlayer;

        // Always give the defender a flash opportunity before they must choose defend/take_damage
        // They must explicitly skip flash, even if they don't have any flash cards
        next.pendingFlash = {
          trigger: 'opponent_attack',
          cardId: '',
          initiatingPlayer: next.currentPlayer,
          stashedAttack: pendingAttack,
        };
        next.currentPlayer = defenderIndex;
        return next;
      }
      case 'select_draw_arrange': {
        if (!next.pendingDraw) return next;

        const pd = next.pendingDraw;
        const selectedIndices = action.selectedCardIndices || [];
        const arrangedIndices = action.arrangedCardIndices || action.cardIndices || [];

        // Add selected cards to hand
        for (const idx of selectedIndices) {
          me.hand.push(pd.openedCards[idx]!);
        }

        // Handle remaining cards based on returnDestination
        if (pd.returnDestination === 'trash') {
          // For attack search_deck: remaining cards go to trash (no rearrangement)
          const usedIndices = new Set(selectedIndices);
          for (let i = 0; i < pd.openedCards.length; i++) {
            if (!usedIndices.has(i)) {
              me.trash.push(pd.openedCards[i]!);
            }
          }
        } else if (pd.returnDestination === 'deck') {
          // For magic_offering_draw: unselected cards return to deck bottom (with optional rearrangement)
          const unselectedIndices: number[] = [];
          for (let i = 0; i < pd.openedCards.length; i++) {
            if (!selectedIndices.includes(i)) {
              unselectedIndices.push(i);
            }
          }

          // If user provided arranged order, use that; otherwise use original order
          const indicesToArrange = arrangedIndices.length > 0 ? arrangedIndices : unselectedIndices;
          const rearrangedCards: CardDef[] = [];
          for (const idx of indicesToArrange) {
            const card = pd.openedCards[idx]!;
            me.deck.push(card);
            rearrangedCards.push(card);
          }
          // Record cards placed at bottom of deck (in order, first = closest to bottom)
          me.bottomDeckCards = [...rearrangedCards, ...me.bottomDeckCards];
        }

        // If this search_deck came from an attack, continue with the rest of the attack flow
        if (pd.originAttackSpiritIndex !== undefined) {
          next.pendingDraw = null;

          const spirit = next.players[next.currentPlayer]!.spirits[pd.originAttackSpiritIndex];
          if (!spirit) return next;

          // Effects (including nexus effects) were already triggered when the attack started.
          // Now just create the pending attack opportunity for the opponent to defend.

          const damage = spirit.def.symbolCount;
          const pendingAttack: PendingAttack = {
            attackerPlayer: next.currentPlayer,
            attackerSpiritIndex: pd.originAttackSpiritIndex,
            damage,
          };

          const defenderIndex = 1 - next.currentPlayer;

          // Always give the defender a flash opportunity before they must choose defend/take_damage
          // They must explicitly skip flash, even if they don't have any flash cards
          next.pendingFlash = {
            trigger: 'opponent_attack',
            cardId: '',
            initiatingPlayer: next.currentPlayer,
            stashedAttack: pendingAttack,
          };
          next.currentPlayer = defenderIndex;
          return next;
        }

        // Clear pending draw and remain in current phase (main for magic card usage)
        next.pendingDraw = null;
        return next;
      }
      case 'pass': {
        // Handle phase transitions based on current phase
        if (next.phase === 'main') {
          // First turn of player 0 (sente/first player): skip attack + main2, go directly to end
          const isFirstTurnSente = next.turnCount === 0 && next.currentPlayer === 0;
          if (isFirstTurnSente) {
            // Skip to end phase directly (skip attack and main2)
            next.phase = 'end';

            // Trigger end-of-turn effects for current player
            const currentPlayer = next.players[next.currentPlayer]!;
            for (let si = 0; si < currentPlayer.spirits.length; si++) {
              const spirit = currentPlayer.spirits[si]!;
              next = triggerEffects(next, 'end_step', spirit.def, next.currentPlayer, si, undefined, undefined, undefined, undefined, undefined, spirit.level);
            }
            for (const nexus of currentPlayer.nexuses) {
              next = triggerEffects(next, 'end_step', nexus.def, next.currentPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
            }
            checkResult(next);
            if (next.result) return next;

            // Reset BP boosts
            for (const p of next.players) {
              for (const s of p.spirits) {
                s.bpBoost = 0;
                s.bpBoostBattle = 0;
              }
            }

            // Move to next turn
            next.currentPlayer = 1 - next.currentPlayer;
            next.turnCount++;
            next = this.startTurn(next);
            return next;
          } else {
            // Normal: transition to attack phase
            next.phase = 'attack';
          }
          return next;
        } else if (next.phase === 'attack') {
          // Transition from Attack to Main2
          next.phase = 'main2';
          return next;
        } else if (next.phase === 'main2') {
          // Transition from Main2 to End
          next.phase = 'end';

          // Trigger end-of-turn effects for current player
          const currentPlayer = next.players[next.currentPlayer]!;
          for (let si = 0; si < currentPlayer.spirits.length; si++) {
            const spirit = currentPlayer.spirits[si]!;
            next = triggerEffects(next, 'end_step', spirit.def, next.currentPlayer, si, undefined, undefined, undefined, undefined, undefined, spirit.level);
          }
          for (const nexus of currentPlayer.nexuses) {
            next = triggerEffects(next, 'end_step', nexus.def, next.currentPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
          }
          checkResult(next);
          if (next.result) return next;

          // Temporary BP boosts ("this turn only") expire at end of turn
          for (const p of next.players) {
            for (const s of p.spirits) {
              s.bpBoost = 0;
              s.bpBoostBattle = 0;
            }
          }

          // Move to next turn
          next.currentPlayer = 1 - next.currentPlayer;
          next.turnCount++;
          next = this.startTurn(next);
          return next;
        }
        return next;
      }
    }

    // Create flash opportunity for opponent (only for attack and block, per official rules)
    const actionTypeStr = (action as any).type;
    if (!next.pendingFlash && actionTypeStr !== 'pass' && actionTypeStr !== 'flash' && actionTypeStr !== 'skip_flash') {
      // Official rule: Flash only occurs during attack and block phases
      const flashTriggerMap: { [key: string]: any } = {
        'attack': 'opponent_attack',  // Flash during opponent's attack
        'defend': 'opponent_attack',  // Flash during opponent's block/defense
        'block': 'opponent_attack',   // Flash during opponent's block
        // No flash for summon, place_nexus, use_magic, or other actions
      };

      const trigger = flashTriggerMap[actionTypeStr];
      if (trigger) {
        // Check if opponent has any flash cards they can afford
        const opponentHasFlash = this.hasAffordableFlash(opponent);

        if (opponentHasFlash) {
          // Give opponent flash opportunity
          next.pendingFlash = {
            trigger: trigger as any,
            cardId: '', // Not tracking specific card here
            initiatingPlayer: next.currentPlayer, // Player who triggered the flash window
          };
          // Switch to opponent for flash opportunity
          next.currentPlayer = 1 - next.currentPlayer;
          return next;
        }
      }
    }

    checkResult(next);
    return next;
  }

  isTerminal(state: GameState): boolean {
    return state.result !== null;
  }

  reward(state: GameState, player: number): number {
    const winner = state.result?.winner ?? null;
    if (winner === null) return 0.5;
    return winner === player ? 1 : 0;
  }

  determinize(state: GameState, observer: number, rng: Rng): GameState {
    const next = cloneState(state);
    // Shuffle unobserved opponent's deck
    rng.shuffle(next.players[1 - observer]!.deck);
    return next;
  }

  actionKey(action: Action): string {
    switch (action.type) {
      case 'summon': return `S${action.handIndex}`;
      case 'add_core': {
        if (action.spiritIndex !== undefined) return `CS${action.spiritIndex}`;
        if (action.nexusIndex !== undefined) return `CN${action.nexusIndex}`;
        return 'C';
      }
      case 'move_core':
        return `MV${action.fromZone}${action.fromIndex ?? ''}-${action.toZone}${action.toIndex ?? ''}-${action.coreType}`;
      case 'place_nexus': return `N${action.handIndex}`;
      case 'use_magic': {
        let key = `M${action.handIndex}`;
        if (action.targetSpiritIndex !== undefined) key += `T${action.targetSpiritIndex}`;
        if (action.effectValue !== undefined) key += `V${action.effectValue}`;
        return key;
      }
      case 'attack': {
        let key = `A${action.spiritIndex}`;
        if (action.discardCardIndex !== undefined) key += `D${action.discardCardIndex}`;
        if (action.effectTargetIndex !== undefined) key += `E${action.effectTargetIndex}`;
        return key;
      }
      case 'block': return `D${action.spiritIndex}`;
      case 'take_damage': return 'TD';
      case 'pass': return 'P';
      case 'flash': {
        let key = `F${action.handIndex}`;
        if (action.targetSpiritIndex !== undefined) key += `T${action.targetSpiritIndex}`;
        if (action.effectValue !== undefined) key += `V${action.effectValue}`;
        return key;
      }
      case 'skip_flash': return 'SF';
      case 'mulligan': return action.redraw ? 'MU-redraw' : 'MU-keep';
      default: return '?';
    }
  }

  describeAction(state: GameState, action: Action): string {
    const me = state.players[state.currentPlayer]!;
    switch (action.type) {
      case 'choose_order': {
        return action.goFirst ? '先手を選択' : '後手を選択';
      }
      case 'summon': {
        const card = me.hand[action.handIndex];
        // Only show payment cost, not Lv1 placement cost
        const cost = card ? this.effectiveCost(me, card) : 0;
        return `${card?.name ?? '?'}を召喚（コア${cost}個）`;
      }
      case 'add_core': {
        if (action.spiritIndex !== undefined) {
          const spirit = me.spirits[action.spiritIndex];
          if (!spirit) return '?にコア配置';
          const need = spirit.def.lv2 ? spirit.def.lv2.cost - spirit.coreCount : 0;
          return `${spirit.def.name}にコア配置（Lv2まであと${need}個）`;
        } else if (action.nexusIndex !== undefined) {
          const nexus = me.nexuses[action.nexusIndex];
          if (!nexus) return '?にコア配置';
          const need = nexus.def.lv2 ? nexus.def.lv2.cost - nexus.coreCount : 0;
          return `${nexus.def.name}にコア配置（Lv2まであと${need}個）`;
        }
        return '?にコア配置';
      }
      case 'move_core': {
        const coreLabel = action.coreType === 'soul' ? 'ソウルコア' : 'コア';
        const zoneName = (zone: string, index?: number): string => {
          if (zone === 'reserve') return 'リザーブ';
          if (zone === 'spirit') return me.spirits[index ?? -1]?.def.name ?? 'スピリット';
          if (zone === 'nexus') return me.nexuses[index ?? -1]?.def.name ?? 'ネクサス';
          return '?';
        };
        return `${coreLabel}を移動: ${zoneName(action.fromZone, action.fromIndex)} → ${zoneName(action.toZone, action.toIndex)}`;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        return `${card?.name ?? '?'}を配置`;
      }
      case 'use_magic': {
        const card = me.hand[action.handIndex];
        let desc = `${card?.name ?? '?'}を使用`;
        if (action.targetSpiritIndex !== undefined) {
          const opponent = state.players[1 - state.currentPlayer]!;
          const target = opponent.spirits[action.targetSpiritIndex];
          desc += `（対象: ${target?.def.name ?? '?'}）`;
        }
        if (action.effectValue !== undefined) {
          desc += `（値: ${action.effectValue}）`;
        }
        return desc;
      }
      case 'attack': {
        const spirit = me.spirits[action.spiritIndex];
        let desc = `${spirit?.def.name ?? '?'}でアタック`;
        if (action.discardCardIndex !== undefined) {
          const discardCard = me.hand[action.discardCardIndex];
          desc += `（${discardCard?.name ?? '?'}を破棄して起動）`;
        }
        if (action.effectTargetIndex !== undefined) {
          const target = me.spirits[action.effectTargetIndex];
          desc += `（対象: ${target?.def.name ?? '?'}）`;
        }
        return desc;
      }
      case 'block': {
        const spirit = me.spirits[action.spiritIndex];
        return `${spirit?.def.name ?? '?'}でブロック（防御）`;
      }
      case 'take_damage': return 'ライフでダメージを受ける';
      case 'pass': {
        if (state.phase === 'main') return 'メインフェーズ終了（アタックフェーズへ）';
        if (state.phase === 'attack') return 'アタックフェーズ終了（メイン2フェーズへ）';
        if (state.phase === 'main2') return 'メイン2フェーズ終了（ターン終了）';
        return 'ターン終了';
      }
      case 'flash': {
        const card = me.hand[action.handIndex];
        let desc = `フラッシュ: ${card?.name ?? '?'}`;
        if (action.targetSpiritIndex !== undefined) {
          // Destroy effects target opponent spirits; boost effects target own spirits
          const flashEffects = card?.effects?.filter((e) => e.isFlash || !e.mode || e.mode === 'flash') ?? [];
          const targetsOwn = flashEffects.some((e) => e.action === 'boost_bp' && e.requiresTarget);
          const owner = targetsOwn ? me : state.players[1 - state.currentPlayer]!;
          const target = owner.spirits[action.targetSpiritIndex];
          desc += `（対象: ${target?.def.name ?? '?'}）`;
        }
        if (action.effectValue !== undefined) {
          desc += `（値: ${action.effectValue}）`;
        }
        return desc;
      }
      case 'skip_flash': return 'フラッシュを使わない';
      case 'mulligan': return action.redraw ? '初手をシャッフルして引き直す' : '初手を維持する';
      case 'confirm_spell_chain': {
        if (!state.pendingSpellChain) return '?';
        if (!action.proceed) return '?'; // Should not happen now
        const pending = state.pendingSpellChain;
        const opponent = state.players[1 - state.currentPlayer]!;
        const spiritNames = pending.destructedSpiritIndices.map(i => opponent.spirits[i]?.def.name).filter(n => n);
        const nexusNames = pending.destructedNexusIndices.map(i => opponent.nexuses[i]?.def.name).filter(n => n);
        const targets = [...spiritNames, ...nexusNames].join('、');
        return `${targets}の消滅を実行`;
      }
      case 'select_draw_arrange': {
        if (!state.pendingDraw) return 'カード選択';
        const cardName = state.pendingDraw.castCard?.name || 'オファーリングドロー';
        const selectedIndices = action.selectedCardIndices || [];
        const selectedCards = selectedIndices.map(idx => state.pendingDraw!.openedCards[idx]!.name).join(', ');
        return `${cardName}: ${selectedCards || 'なし'}を手札に加える`;
      }
      default: return '?';
    }
  }
}

// === Helpers ===

function cloneState(state: GameState): GameState {
  return {
    players: [
      clonePlayer(state.players[0]!),
      clonePlayer(state.players[1]!),
    ],
    currentPlayer: state.currentPlayer,
    turnCount: state.turnCount,
    phase: state.phase,
    battle: state.battle ? { ...state.battle } : null,
    result: state.result ? { ...state.result } : null,
    decideFirstPlayerPlayer: state.decideFirstPlayerPlayer,
    pendingRockPaperScissors: state.pendingRockPaperScissors ? { ...state.pendingRockPaperScissors } : null,
    pendingFlash: state.pendingFlash ? { ...state.pendingFlash } : null,
    pendingAttack: state.pendingAttack ? { ...state.pendingAttack } : null,
    pendingDraw: state.pendingDraw
      ? {
          openedCards: state.pendingDraw.openedCards.slice(),
          toHandIndices: state.pendingDraw.toHandIndices.slice(),
          toRearrangeIndices: state.pendingDraw.toRearrangeIndices.slice(),
        }
      : null,
    pendingMulligan: state.pendingMulligan ? { ...state.pendingMulligan } : null,
    pendingSpellChain: state.pendingSpellChain ? { ...state.pendingSpellChain } : null,
  };
}

function clonePlayer(p: any) {
  return {
    life: p.life,
    cores: p.cores,
    soulCores: p.soulCores || 0,
    trashCores: p.trashCores || 0,
    trashSoulCores: p.trashSoulCores || 0,
    hand: p.hand.slice(),
    deck: p.deck.slice(),
    spirits: p.spirits.map((s: any) => ({ ...s, bpBoost: s.bpBoost ?? 0, soulCoreCount: s.soulCoreCount ?? 0 })),
    nexuses: p.nexuses.map((n: any) => ({ ...n, placedCores: n.placedCores ?? 0, soulCoreCount: n.soulCoreCount ?? 0 })),
    trash: p.trash.slice(),
    bottomDeckCards: (p.bottomDeckCards || []).slice(),
  };
}

function checkResult(state: GameState): void {
  if (state.result) return;
  const l0 = state.players[0]!.life;
  const l1 = state.players[1]!.life;
  const d0 = state.players[0]!.deck.length;
  const d1 = state.players[1]!.deck.length;

  // Check life condition
  if (l0 <= 0 && l1 <= 0) {
    state.result = { winner: null };
    return;
  }
  if (l1 <= 0) {
    state.result = { winner: 0 };
    return;
  }
  if (l0 <= 0) {
    state.result = { winner: 1 };
    return;
  }

  // Check deck condition: on start step, if deck is 0, opponent wins
  if (state.phase === 'start') {
    if (d0 === 0) state.result = { winner: 1 };
    else if (d1 === 0) state.result = { winner: 0 };
  }
}
