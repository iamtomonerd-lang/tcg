import type { Game, Rng } from '../../core/game.js';
import { Mulberry32 } from '../../core/rng.js';
import { CARD_DB, getStarterDeck } from './cards.js';
import type { Action, GameState, Nexus, Spirit, PlayerState, PendingAttack, CardDef, CardEffect, GameConfig, PlayerConfig, GameRuleConfig } from './types.js';
import { applyEffect, triggerEffects, destroySpirit, removeDeadSpirit, updateSpiritLevel, fixupSpiritIndicesAfterRemoval, destroyCreatureBpLimit } from './effects.js';

/**
 * Battle Spirits Phase 1: simplified rules.
 * Turn: Start (draw) → Main (summon/place/use) → Attack → End
 * (First turn skips core step and attack step)
 */

/**
 * 継召 (inheritance): count EX-symbol cards in the trash whose color can reduce
 * THIS card's cost. Per official rule, an EX symbol of a color different from the
 * card's reduction symbols cannot be removed, and each removed EX card satisfies
 * exactly one reduction symbol.
 */
function countInheritableEX(trash: CardDef[], card: CardDef): number {
  return trash.filter(
    (c) => c.exSymbol && c.symbolColors?.some((col) => card.symbolColors?.includes(col)),
  ).length;
}

/**
 * How much reduction remains available after applying field symbols. Shared by the
 * cost calculation and the 継召 removal so both agree on how many EX cards are used.
 */
function reductionAfterFieldSymbols(
  card: CardDef,
  fieldSymbols: { color: string; count: number }[],
): number {
  let reductionRemaining = card.reductionCost;
  for (const sym of fieldSymbols) {
    if (reductionRemaining <= 0) break;
    const canReduce = card.reductionCost > 0 && card.symbolColors?.includes(sym.color);
    if (canReduce) {
      reductionRemaining -= Math.min(sym.count, reductionRemaining);
    }
  }
  return Math.max(0, reductionRemaining);
}

/**
 * 継召: how many EX cards would actually be removed from the trash for this summon.
 * Each removed EX card reduces cost by 1, capped by the reduction limit that
 * remains after field symbols. The card-removal count MUST match the cost cut.
 */
function inheritanceEXConsumed(
  card: CardDef,
  fieldSymbols: { color: string; count: number }[],
  availableEXSymbols: number,
): number {
  return Math.min(availableEXSymbols, reductionAfterFieldSymbols(card, fieldSymbols));
}

function calculateCostAfterReduction(
  card: any,
  fieldSymbols: { color: string; count: number }[],
  availableEXSymbols: number,
  useInheritance: boolean,
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

  // 継召: each removed matching-color EX card in the trash satisfies one reduction
  // symbol. Reduce by the number of EX cards actually available, not the whole
  // remaining limit — 1 EX card = 1 reduction, not "reduce to the cap".
  if (useInheritance && reductionRemaining > 0 && availableEXSymbols > 0) {
    const exUsed = Math.min(availableEXSymbols, reductionRemaining);
    cost = Math.max(0, cost - exUsed);
  }

  return Math.max(0, cost);
}

export class BattlSpiritsGame implements Game<GameState, Action> {
  readonly playerCount = 2;

  // Overload signatures
  createInitialState(rng: Rng): GameState;
  createInitialState(config: GameConfig): GameState;

  // Implementation
  createInitialState(rngOrConfig: Rng | GameConfig): GameState {
    let rng: Rng;
    let players: [PlayerState, PlayerState];

    if ('players' in rngOrConfig) {
      // GameConfig passed
      const config = rngOrConfig as GameConfig;
      rng = this.createRng(config.rngSeed);
      players = [
        this.newPlayerFromConfig(config.players[0]!, rng, config.ruleConfig),
        this.newPlayerFromConfig(config.players[1]!, rng, config.ruleConfig),
      ];
    } else {
      // Rng passed (backward compatibility)
      rng = rngOrConfig as Rng;
      players = [this.newPlayer(rng), this.newPlayer(rng)];
    }

    const state: GameState = {
      players: players as [any, any],
      currentPlayer: 0, // Player 0 starts the dice roll phase
      turnCount: 0,
      phase: 'start',
      battle: null,
      result: null,
      pendingDiceRoll: {}, // Start dice roll phase
    };
    // Draw opening hand
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

  /** Create an Rng instance from a seed (used by GameConfig initialization). */
  private createRng(seed: number): Rng {
    return new Mulberry32(seed);
  }

  /**
   * Initialize a player from PlayerConfig and optional GameRuleConfig.
   * Used by createInitialState(config: GameConfig) overload.
   */
  private newPlayerFromConfig(config: PlayerConfig, rng: Rng, ruleConfig?: GameRuleConfig): PlayerState {
    const defaults = this.getDefaultRuleConfig();
    const rules = { ...defaults, ...ruleConfig };

    // Clone deck to avoid mutation
    const deck = [...config.deck];
    rng.shuffle(deck);

    return {
      life: config.initialLife ?? rules.startingLife ?? 5,
      cores: config.initialCores ?? rules.startingCores ?? 3,
      soulCores: config.initialSoulCores ?? rules.startingSoulCores ?? 1,
      trashCores: 0,
      trashSoulCores: 0,
      hand: [],
      deck,
      spirits: [],
      nexuses: [],
      trash: [],
      bottomDeckCards: [],
    };
  }

  /** Get default rule configuration (Battle Spirits standard rules). */
  private getDefaultRuleConfig(): GameRuleConfig {
    return {
      startingLife: 5,
      startingCores: 3,
      startingSoulCores: 1,
      startingHandSize: 4,
    };
  }

  /**
   * 継召: remove `count` matching-color EX-symbol cards from the player's trash
   * (removed from the game). The number removed must equal the cost reduction that
   * inheritance granted, so a player can't gain reduction beyond the cards they spend.
   */
  private removeInheritedEX(player: PlayerState, card: CardDef, count: number): void {
    let remaining = count;
    while (remaining > 0) {
      const exIndex = player.trash.findIndex(
        (c) => c.exSymbol && c.symbolColors?.some((col) => card.symbolColors?.includes(col)),
      );
      if (exIndex === -1) break;
      player.trash.splice(exIndex, 1);
      remaining -= 1;
    }
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
          // Reset damage tracking for BOTH players — "このターン" refers to the game
          // turn, and either player may reference their own damage during it
          next.players[0]!.damageThisTurn = 0;
          next.players[1]!.damageThisTurn = 0;
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

  /** Remove all spirits that have fewer cores than required (not destruction, no effects triggered) */
  private removeDeadSpirits(state: GameState, playerIndex: number): void {
    const player = state.players[playerIndex]!;
    for (let i = player.spirits.length - 1; i >= 0; i--) {
      const spirit = player.spirits[i]!;
      const totalCores = spirit.coreCount + spirit.soulCoreCount;
      if (totalCores < spirit.def.lv1.cost) {
        removeDeadSpirit(player, i);
        fixupSpiritIndicesAfterRemoval(state, playerIndex, i);
      }
    }
  }

  /** Check if spirit needs depletion confirmation (main steps only — main and main2) */
  private checkSpiritDepletionInMainPhase(state: GameState, playerIndex: number): boolean {
    if (state.phase !== 'main' && state.phase !== 'main2') return false;

    const player = state.players[playerIndex]!;
    for (let i = 0; i < player.spirits.length; i++) {
      const spirit = player.spirits[i]!;
      const totalCores = spirit.coreCount + spirit.soulCoreCount;
      if (totalCores < spirit.def.lv1.cost) {
        // Set pending depletion for this spirit
        state.pendingSpiritDepletion = {
          spiritIndex: i,
          spiritCard: spirit.def,
          requiredCores: spirit.def.lv1.cost,
          currentCores: totalCores,
        };
        return true;
      }
    }
    return false;
  }

  /** Remove all nexuses that have fewer cores than required (depleted — 消滅, no effects triggered) */
  private removeDeadNexuses(state: GameState, playerIndex: number): void {
    const player = state.players[playerIndex]!;
    const removedIndices: number[] = [];
    for (let i = player.nexuses.length - 1; i >= 0; i--) {
      const nexus = player.nexuses[i]!;
      const totalCores = nexus.coreCount + nexus.soulCoreCount;
      if (totalCores < nexus.def.lv1.cost) {
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

  /**
   * Find valid targets for an effect requiring target selection
   */
  private findValidTargetsForEffect(state: GameState, sourcePlayer: number, effect: CardEffect): { spiritIndices: number[]; nexusIndices: number[] } {
    const me = state.players[sourcePlayer]!;
    const spiritIndices: number[] = [];
    const nexusIndices: number[] = [];

    // Check condition: requiresSpirit with lineage
    if (effect.condition?.requiresSpirit?.lineage) {
      const lineage = effect.condition.requiresSpirit.lineage;
      for (let i = 0; i < me.spirits.length; i++) {
        if (me.spirits[i]!.def.lineage?.includes(lineage)) {
          spiritIndices.push(i);
        }
      }
      for (let i = 0; i < me.nexuses.length; i++) {
        if (me.nexuses[i]!.def.lineage?.includes(lineage)) {
          nexusIndices.push(i);
        }
      }
    } else {
      // No specific condition, target any spirit or nexus
      for (let i = 0; i < me.spirits.length; i++) {
        spiritIndices.push(i);
      }
      for (let i = 0; i < me.nexuses.length; i++) {
        nexusIndices.push(i);
      }
    }

    return { spiritIndices, nexusIndices };
  }

  /**
   * Process end_step effects, handling target selection for effects that require it
   */
  private processEndStepEffects(state: GameState): GameState {
    let next = state;
    const currentPlayer = next.players[next.currentPlayer]!;

    // Collect all end_step effects that need processing
    const effectsQueue: Array<{ card: CardDef; spiritIndex?: number; nexusIndex?: number; level?: 1 | 2 }> = [];

    // From spirits
    for (let si = 0; si < currentPlayer.spirits.length; si++) {
      const spirit = currentPlayer.spirits[si]!;
      effectsQueue.push({ card: spirit.def, spiritIndex: si, level: spirit.level });
    }

    // From nexuses
    for (let ni = 0; ni < currentPlayer.nexuses.length; ni++) {
      const nexus = currentPlayer.nexuses[ni]!;
      effectsQueue.push({ card: nexus.def, nexusIndex: ni, level: nexus.level });
    }

    return this.processEndStepEffectsQueue(next, effectsQueue, 0);
  }

  /**
   * Process a queue of end_step effects starting from a given index
   */
  private processEndStepEffectsQueue(state: GameState, effectsQueue: Array<{ card: CardDef; spiritIndex?: number; nexusIndex?: number; level?: 1 | 2 }>, startIndex: number): GameState {
    let next = state;
    let i = startIndex;

    while (i < effectsQueue.length) {
      const item = effectsQueue[i]!;
      const card = item.card;
      const endStepEffects = (card.effects ?? []).filter((e) => {
        if (e.trigger !== 'end_step') return false;
        if (item.level !== undefined && e.level && !e.level.includes(item.level)) return false;
        return true;
      });

      for (const effect of endStepEffects) {
        if (effect.requiresTarget) {
          // This effect requires target selection
          const validTargets = this.findValidTargetsForEffect(next, next.currentPlayer, effect);

          // Store remaining effects to process
          const remainingEffects = effectsQueue.slice(i + 1);

          next.pendingEffectAction = {
            effect,
            sourceCard: card,
            sourcePlayer: next.currentPlayer,
            spiritIndex: item.spiritIndex,
            sourceNexusIndex: item.nexusIndex,
            validTargets,
            trigger: 'end_step',
            remainingEffects,
          };
          return next; // Wait for player to select target
        } else {
          // No target selection needed, apply the effect directly
          next = triggerEffects(next, 'end_step', card, next.currentPlayer, item.spiritIndex, undefined, undefined, undefined, undefined, item.nexusIndex, item.level);
        }
      }

      i++;
    }

    return next;
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
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
      }
      case 'place_nexus': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return 0;
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
      }
      case 'use_magic': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return 0;
        // Soul Magic alternative cost: exactly 1 soul core
        if (action.coreType === 'soul' && isSoulMagicRedCard(card)) return 1;
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
      }
      case 'flash': {
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return 0;
        // Soul Magic alternative cost: exactly 1 soul core
        if (action.coreType === 'soul' && isSoulMagicRedCard(card)) return 1;
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
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
    const availableEX = countInheritableEX(player.trash, card);
    return calculateCostAfterReduction(card, fieldSymbols, availableEX, !!card.inheritance);
  }

  /** Calculate cost with or without inheritance */
  private effectiveCostWithFlag(player: PlayerState, card: any, useInheritance: boolean): number {
    const fieldSymbols = this.getFieldSymbols(player);
    const availableEX = countInheritableEX(player.trash, card);
    return calculateCostAfterReduction(card, fieldSymbols, availableEX, useInheritance && !!card.inheritance);
  }

  /** Does the player have a flash magic card they can actually afford? */
  private hasAffordableFlash(player: PlayerState): boolean {
    const totalCores = this.getTotalAvailableCores(player);
    const canPaySoulCore = player.soulCores >= 1 || player.spirits.some((s) => s.soulCoreCount > 0);
    return player.hand.some(
      (c) =>
        c.cardType === 'magic' &&
        c.effects?.some((e) => e.trigger === 'immediate' && (e.isFlash || !e.mode || e.mode === 'flash')) &&
        (this.effectiveCost(player, c) <= totalCores ||
          // Soul Magic alternative cost: 1 soul core
          (isSoulMagicRedCard(c) && canPaySoulCore)),
    );
  }

  legalActions(state: GameState): Action[] {
    if (state.result) return [];

    // Dice roll phase: both players roll dice
    if (state.pendingDiceRoll && state.pendingDiceRoll.winner === undefined) {
      // Players roll in sequence: P0 first, then P1, then determine winner
      if (state.pendingDiceRoll.p0Roll === undefined) {
        // Player 0 rolls
        return [
          { type: 'dice_roll', roll: 1 },
          { type: 'dice_roll', roll: 2 },
          { type: 'dice_roll', roll: 3 },
          { type: 'dice_roll', roll: 4 },
          { type: 'dice_roll', roll: 5 },
          { type: 'dice_roll', roll: 6 },
        ];
      } else if (state.pendingDiceRoll.p1Roll === undefined) {
        // Player 1 rolls
        return [
          { type: 'dice_roll', roll: 1 },
          { type: 'dice_roll', roll: 2 },
          { type: 'dice_roll', roll: 3 },
          { type: 'dice_roll', roll: 4 },
          { type: 'dice_roll', roll: 5 },
          { type: 'dice_roll', roll: 6 },
        ];
      }
    }

    // Order choice phase: winner chooses to go first or second
    if (state.pendingDiceRoll && state.pendingDiceRoll.winner !== undefined && state.pendingDiceRoll.winner >= 0) {
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

    // Spirit depletion confirmation: user can add cores to cancel, or confirm to deplete
    if (state.pendingSpiritDepletion) {
      const actions: Action[] = [
        { type: 'confirm_spirit_depletion', proceed: true }, // Proceed with depletion
      ];

      // Allow adding cores to cancel depletion
      const me = state.players[state.currentPlayer]!;
      const totalCores = this.getTotalAvailableCores(me);
      if (totalCores > 0) {
        actions.push({ type: 'add_core', spiritIndex: state.pendingSpiritDepletion.spiritIndex });
      }

      return actions;
    }

    // Nexus depletion confirmation: user can add cores to cancel, or confirm to deplete
    if (state.pendingNexusDepletion) {
      const actions: Action[] = [
        { type: 'confirm_nexus_depletion', proceed: true }, // Proceed with depletion
      ];

      // Allow adding cores to cancel depletion
      const me = state.players[state.currentPlayer]!;
      const totalCores = this.getTotalAvailableCores(me);
      if (totalCores > 0) {
        actions.push({ type: 'add_core', nexusIndex: state.pendingNexusDepletion.nexusIndex });
      }

      return actions;
    }

    // Effect target selection: user must select a target for the effect
    if (state.pendingEffectAction) {
      const actions: Action[] = [];
      const pending = state.pendingEffectAction;

      // Generate actions for each valid spirit target
      for (const spiritIdx of pending.validTargets.spiritIndices) {
        actions.push({ type: 'select_effect_target', targetSpiritIndex: spiritIdx });
      }

      // Generate actions for each valid nexus target
      for (const nexusIdx of pending.validTargets.nexusIndices) {
        actions.push({ type: 'select_effect_target', targetNexusIndex: nexusIdx });
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

        // Check if can afford flash cost; Soul Magic cards have two payment modes
        const isSoulMagicRed = card.skill === 'ソウルマジック：赤' || flashEffects.some((e) => e.skill === 'ソウルマジック：赤');
        const canPaySoulCore = me.soulCores >= 1 || me.spirits.some((s) => s.soulCoreCount > 0);
        const canPayNormalCost = this.effectiveCost(me, card) <= totalCores;
        const paymentModes: Array<'soul' | 'normal'> = [];
        if (isSoulMagicRed) {
          // Soul Magic: Red can be paid with:
          // 1. Soul core: exactly 1 soul core from reserve or spirits
          // 2. Normal cost: regular cores (after reduction) — casts as plain magic
          if (canPaySoulCore) paymentModes.push('soul');
          if (canPayNormalCost) paymentModes.push('normal');
          if (paymentModes.length === 0) continue;
        } else {
          if (!canPayNormalCost) continue;
          paymentModes.push('normal');
        }

        const destroyEffect = flashEffects.find((e) => e.action === 'destroy_creature');
        const boostEffect = flashEffects.find((e) => e.action === 'boost_bp' && e.requiresTarget);

        const hasSymbolOnField = (color: string) =>
          me.spirits.some((s) => s.def.symbolColors?.includes(color)) ||
          me.nexuses.some((n) => n.def.symbolColors?.includes(color));

        for (const mode of paymentModes) {
          const coreType = isSoulMagicRed && mode === 'soul' ? ('soul' as const) : undefined;
          // Symbol condition gates the soul-core casting only; paying the normal
          // cost casts it as a plain magic (skipSymbolCheck applies at resolve time)
          const symbolGateApplies = !isSoulMagicRed || mode === 'soul';

          if (destroyEffect && destroyEffect.requiresTarget) {
            if (symbolGateApplies && destroyEffect.condition?.requiresSymbol && !hasSymbolOnField(destroyEffect.condition.requiresSymbol)) {
              continue;
            }
            // Target an opponent spirit (no BP limit check - that's just the effect condition)
            for (let t = 0; t < opponent.spirits.length; t++) {
              actions.push({ type: 'flash', handIndex: i, targetSpiritIndex: t, coreType });
            }
          } else if (destroyEffect) {
            // destroy_creature without requiresTarget - can use without selection
            if (symbolGateApplies && destroyEffect.condition?.requiresSymbol && !hasSymbolOnField(destroyEffect.condition.requiresSymbol)) {
              continue;
            }
            actions.push({ type: 'flash', handIndex: i, coreType });
          } else if (boostEffect) {
            // Target one of the player's own spirits for the BP boost
            if (me.spirits.length === 0) continue; // nothing to boost
            for (let t = 0; t < me.spirits.length; t++) {
              actions.push({ type: 'flash', handIndex: i, targetSpiritIndex: t, coreType });
            }
          } else {
            actions.push({ type: 'flash', handIndex: i, coreType });
          }
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

    // End phase: allow pass to move to next turn
    if (state.phase === 'end') {
      return [{ type: 'pass' }];
    }

    // Other phases (start, core, draw, refresh) have no player actions
    return [];
  }

  private getMainPhaseActions(state: GameState): Action[] {
    const actions: Action[] = [];
    const me = state.players[state.currentPlayer]!;
    const totalCores = this.getTotalAvailableCores(me);

    // Normal turn actions: only offer cards the player can actually pay for
    for (let i = 0; i < me.hand.length; i++) {
      const card = me.hand[i]!;
      // Soul Magic cards have a 1-soul-core alternative cost, so they stay
      // playable even when the normal cost is unaffordable
      const isSoulMagicRedCard =
        card.cardType === 'magic' &&
        (card.skill === 'ソウルマジック：赤' || card.effects?.some((e) => e.skill === 'ソウルマジック：赤'));
      const canPaySoulCoreAlt = me.soulCores >= 1 || me.spirits.some((s) => s.soulCoreCount > 0);
      if (this.effectiveCost(me, card) > totalCores && !(isSoulMagicRedCard && canPaySoulCoreAlt)) continue;

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
        let canAffordNormal = false;
        let useInheritanceIfAvailable = false;

        if (card.inheritance) {
          const costWithInheritance = this.effectiveCostWithFlag(me, card, true);
          const costWithoutInheritance = this.effectiveCostWithFlag(me, card, false);

          if (costWithoutInheritance <= totalCores) {
            canAffordNormal = true;
          }
          if (costWithInheritance <= totalCores && costWithInheritance < costWithoutInheritance) {
            useInheritanceIfAvailable = true;
            canAffordNormal = true;
          }
        } else {
          const effectiveMagicCost = this.effectiveCost(me, card);
          if (effectiveMagicCost <= totalCores) {
            canAffordNormal = true;
          }
        }

        // Soul Magic: Red offers an alternative cost of exactly 1 soul core
        const paymentModes: Array<'soul' | 'normal'> = [];
        if (isSoulMagicRedCard && canPaySoulCoreAlt) paymentModes.push('soul');
        if (canAffordNormal) paymentModes.push('normal');
        if (paymentModes.length === 0) continue; // Can't afford this magic card

        // Filter effects by mode (main phase effects: mode 'main', no mode, or Soul Magic can use flash as main too)
        const mainEffects = card.effects?.filter(e => {
          if (!e.mode || e.mode === 'main') return true;
          // Soul Magic: Red can be used in main phase even though it's marked as flash
          if (isSoulMagicRedCard && e.mode === 'flash') return true;
          return false;
        }) ?? [];
        if (mainEffects.length === 0) continue; // No main-phase effects for this card

        // Check if card has effects with requiresTarget (for spirits or nexuses)
        const hasDestroyNexusEffect = mainEffects.some((e) => e.action === 'destroy_nexus') ?? false;
        const hasOtherTargetEffect = mainEffects.some((e) => e.requiresTarget && e.action !== 'destroy_nexus') ?? false;
        // Check if card has effects with variableValue
        const hasVariableEffect = mainEffects.some((e) => e.variableValue) ?? false;

        for (const mode of paymentModes) {
          const coreType = mode === 'soul' ? ('soul' as const) : undefined;

          // Symbol condition gates the soul-core casting only; the normal-cost
          // casting skips the Soul Magic condition (skipSymbolCheck at resolve time)
          if (mode === 'soul') {
            const symbolCondEffect = mainEffects.find((e) => e.condition?.requiresSymbol);
            if (symbolCondEffect?.condition?.requiresSymbol) {
              const color = symbolCondEffect.condition.requiresSymbol;
              const hasSymbol =
                me.spirits.some((s) => s.def.symbolColors?.includes(color)) ||
                me.nexuses.some((n) => n.def.symbolColors?.includes(color));
              if (!hasSymbol) continue;
            }
          }

          if (hasDestroyNexusEffect) {
            // Generate targeting actions for opponent nexuses
            const opponent = state.players[1 - state.currentPlayer]!;
            const destroyNexusEffect = mainEffects.find((e) => e.action === 'destroy_nexus' && e.requiresTarget);
            const excludeSkill = destroyNexusEffect?.condition?.excludeTargetSkill;
            const validNexusIndices: number[] = [];

            for (let t = 0; t < opponent.nexuses.length; t++) {
              const nexus = opponent.nexuses[t]!;
              // Exclude Lv2 nexuses and nexuses with excluded skill
              if (nexus.level !== 2 && (!excludeSkill || nexus.def.skill !== excludeSkill)) {
                validNexusIndices.push(t);
              }
            }
            if (validNexusIndices.length > 0) {
              for (const nexusIndex of validNexusIndices) {
                actions.push({ type: 'use_magic', handIndex: i, targetNexusIndex: nexusIndex, useInheritance: useInheritanceIfAvailable, coreType });
              }
            } else {
              // No valid nexus targets, but card can still be used (effect won't trigger)
              actions.push({ type: 'use_magic', handIndex: i, useInheritance: useInheritanceIfAvailable, coreType });
            }
          } else if (hasOtherTargetEffect) {
            // Generate targeting actions for opponent spirits
            const opponent = state.players[1 - state.currentPlayer]!;
            // Check if there's a destroy_creature effect with BP limit
            const destroyCEffect = mainEffects.find((e) => e.action === 'destroy_creature' && e.requiresTarget);
            const bpLimit = destroyCEffect ? destroyCreatureBpLimit(destroyCEffect, me) : undefined;
            const spiritBp = (sp: Spirit) => {
              const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
              return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
            };

            for (let t = 0; t < opponent.spirits.length; t++) {
              // Only offer as target if it meets any BP limits from destroy_creature
              if (!destroyCEffect || bpLimit === undefined || spiritBp(opponent.spirits[t]!) <= bpLimit) {
                actions.push({ type: 'use_magic', handIndex: i, targetSpiritIndex: t, useInheritance: useInheritanceIfAvailable, coreType });
              }
            }
          } else if (hasVariableEffect) {
            // Generate variable value actions (0 to max, typically hand size or some reasonable max)
            const maxValue = Math.min(me.hand.length, 5); // Reasonable max for discards
            for (let v = 0; v <= maxValue; v++) {
              actions.push({ type: 'use_magic', handIndex: i, effectValue: v, useInheritance: useInheritanceIfAvailable, coreType });
            }
          } else {
            // No targeting or variable values needed
            actions.push({ type: 'use_magic', handIndex: i, useInheritance: useInheritanceIfAvailable, coreType });
          }
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
        // Exclude flash-timing effects (isFlash=true, mode='flash') from attack-phase generation
        const discardEffect = s.def.effects?.find(
          (e) => e.trigger === 'attack' && (e.action === 'discard_hand' || e.costAction === 'discard_hand') && e.level?.includes(s.level) && !e.isFlash
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
          // Generate one attack action for each valid opponent spirit (respecting BP limits)
          const bpLimit = destroyCreatureBpLimit(destroyCreatureEffect, me);
          const spiritBp = (sp: Spirit) => {
            const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
            return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
          };
          let hasValidTarget = false;
          for (let ti = 0; ti < opponent.spirits.length; ti++) {
            // Only offer target if it meets the BP limit
            if (bpLimit === undefined || spiritBp(opponent.spirits[ti]!) <= bpLimit) {
              actions.push({ type: 'attack', spiritIndex: i, effectTargetIndex: ti });
              hasValidTarget = true;
            }
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

    // Dice roll: collect both players' rolls
    if (action.type === 'dice_roll') {
      if (!next.pendingDiceRoll) return next;
      if (next.pendingDiceRoll.winner !== undefined) return next; // Already determined winner

      if (next.currentPlayer === 0) {
        // Store player 0's roll
        next.pendingDiceRoll.p0Roll = action.roll;
        next.currentPlayer = 1;
        return next;
      } else {
        // Player 1 rolls - now we have both rolls
        const p0Roll = next.pendingDiceRoll.p0Roll!;
        const p1Roll = action.roll;

        // Determine winner: higher roll wins, ties re-roll
        if (p0Roll === p1Roll) {
          // Tie: re-roll - reset and start from player 0 again
          next.pendingDiceRoll.p0Roll = undefined;
          next.pendingDiceRoll.p1Roll = undefined;
          next.currentPlayer = 0;
        } else {
          // Store Player 1's roll
          next.pendingDiceRoll.p1Roll = p1Roll;
          if (p0Roll > p1Roll) {
            // Player 0 wins
            next.pendingDiceRoll.winner = 0;
            next.currentPlayer = 0;
          } else {
            // Player 1 wins
            next.pendingDiceRoll.winner = 1;
            next.currentPlayer = 1;
          }
        }
        return next;
      }
    }

    // Choose order: winner decides to go first or second
    if (action.type === 'choose_order') {
      if (!next.pendingDiceRoll || next.pendingDiceRoll.winner === undefined) return next;

      const winner = next.pendingDiceRoll.winner;
      const firstPlayer = action.goFirst ? winner : 1 - winner;
      next.pendingDiceRoll = null;

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

      const hasSoulMagicRedEffect = isSoulMagicRedCard(card);
      const soulPayment = hasSoulMagicRedEffect && action.coreType === 'soul';

      if (soulPayment) {
        // Soul Magic alternative cost: exactly 1 soul core (reserve or spirits)
        const canPaySoulCore = me.soulCores >= 1 || me.spirits.some((s) => s.soulCoreCount > 0);
        if (!canPaySoulCore) return next;
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, 1, 0, 1);
      } else {
        // Calculate normal cost
        const fieldSymbols = this.getFieldSymbols(me);
        const availableEX = countInheritableEX(me.trash, card);
        const useInheritance = action.useInheritance !== false && !!card.inheritance;
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, availableEX, useInheritance);
        const exToRemove = useInheritance ? inheritanceEXConsumed(card, fieldSymbols, availableEX) : 0;

        // Check if player has enough cores (including from spirits)
        const totalAvailable = this.getTotalAvailableCores(me);
        if (actualCost > totalAvailable) return next;

        // Use the magic card as flash
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        // 継召: remove the EX cards used for reduction from the game (from trash)
        this.removeInheritedEX(me, card, exToRemove);
      }
      this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores
      me.trash.push(card);
      // For Soul Magic Red: skip symbol check when cast with the normal cost (not the soul-core cost)
      const skipSymbolCheck = hasSoulMagicRedEffect && !soulPayment;
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
      const attacker = next.players[pendingAttack.attackerPlayer]!.spirits[pendingAttack.attackerSpiritIndex];
      if (!attacker) {
        // Defensive: the attacker no longer exists — cancel the attack instead of crashing
        next.pendingAttack = null;
        checkResult(next);
        return next;
      }
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
      const attacker = opponent.spirits[next.pendingAttack.attackerSpiritIndex];
      if (!attacker) {
        // Defensive: the attacker no longer exists (index went stale through an
        // unforeseen path) — cancel the attack instead of crashing
        next.pendingAttack = null;
        checkResult(next);
        return next;
      }

      // Attacker becomes fatigued
      attacker.canAttack = false;

      // Take damage and place cores in reserve
      const damage = next.pendingAttack.damage;
      me.life -= damage;
      me.cores += damage; // Add cores to reserve when taking damage
      me.damageThisTurn = (me.damageThisTurn ?? 0) + damage; // Soul Magic red condition (ライフが減った)

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
        const availableEX = countInheritableEX(me.trash, card);
        const useInheritance = action.useInheritance !== false && !!card.inheritance;
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, availableEX, useInheritance);
        // 継召: remove exactly as many EX cards as the reduction they granted
        const exToRemove = useInheritance ? inheritanceEXConsumed(card, fieldSymbols, availableEX) : 0;

        // Need enough cores to pay the cost AND move Lv1 maintenance cores onto the spirit
        const totalAvailable = this.getTotalAvailableCores(me);
        if (totalAvailable < actualCost + card.lv1.cost) return next;

        // 支払うコア: pay only the summon cost (paid cores go to trash)
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        // 継召: remove the EX cards used for reduction from the game (from trash)
        this.removeInheritedEX(me, card, exToRemove);
        // Paying from field spirits may drain one to 0 cores: in main phase ask
        // for confirmation (消滅前の処理) instead of silently removing it. The
        // confirmation dialog appears after the summon completes; the drained
        // spirit's index stays valid because the new spirit is appended at the end.
        const needsPaymentDepletionConfirm = this.checkSpiritDepletionInMainPhase(next, next.currentPlayer);
        if (!needsPaymentDepletionConfirm) {
          this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores
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

        // Create the spirit object
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

        // A spirit that could not receive all required maintenance cores needs confirmation in main phase
        const totalCoresPlaced = placedRegular + placedSoul;
        if (totalCoresPlaced < card.lv1.cost) {
          // In main phase, ask player before depleting
          if (next.phase === 'main') {
            next.pendingSpiritDepletion = {
              spiritIndex: newSpiritIndex, // spirit is now in the field
              spiritCard: card,
              requiredCores: card.lv1.cost,
              currentCores: totalCoresPlaced,
            };
            return next; // Stop here, player must confirm
          }
          // In other phases, auto-deplete
          removeDeadSpirit(me, newSpiritIndex);
          fixupSpiritIndicesAfterRemoval(next, next.currentPlayer, newSpiritIndex);
          break;
        }

        // Check if summon effects will destroy opponent's spirits/nexuses
        // (but exclude requiresTarget effects - those are handled by pendingEffectAction)
        const hasDestructiveEffect =
          card.effects?.some((e) => e.trigger === 'summon' && (e.action === 'destroy_creature' || e.action === 'destroy_nexus') && !e.requiresTarget) ?? false;

        if (hasDestructiveEffect) {
          // Simulate effects to detect destructions (only for auto-destroy effects)
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

        // Check for summon effects that require target selection
        const targetRequiringEffect = card.effects?.find(e =>
          e.trigger === 'summon' &&
          e.requiresTarget &&
          (!e.level || e.level.includes(spirit.level))
        );

        // If there's a target-requiring effect, wait for selection
        if (targetRequiringEffect) {
          let validTargets: { spiritIndices: number[]; nexusIndices: number[] } = { spiritIndices: [], nexusIndices: [] };

          if (targetRequiringEffect.action === 'destroy_creature') {
            // Find opponent spirits/nexuses that meet the condition
            const opponent = next.players[1 - next.currentPlayer]!;
            const bpLimit = destroyCreatureBpLimit(targetRequiringEffect, me);
            const spiritBp = (sp: Spirit) => {
              const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
              return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
            };
            for (let i = 0; i < opponent.spirits.length; i++) {
              if (bpLimit === undefined || spiritBp(opponent.spirits[i]!) <= bpLimit) {
                validTargets.spiritIndices.push(i);
              }
            }
            for (let i = 0; i < opponent.nexuses.length; i++) {
              validTargets.nexusIndices.push(i);
            }
          } else if (targetRequiringEffect.action === 'trash_to_hand') {
            // For trash_to_hand, we're selecting cards from own trash
            // Store as temporary info; actual card selection happens differently
            validTargets.spiritIndices = [-1]; // Special marker: selecting from trash
          } else if (targetRequiringEffect.action === 'place_core') {
            // Find own spirits/nexuses matching condition
            validTargets = this.findValidTargetsForEffect(next, next.currentPlayer, targetRequiringEffect);
          }

          // If there are valid targets, wait for selection
          if (validTargets.spiritIndices.length > 0 || validTargets.nexusIndices.length > 0) {
            next.pendingEffectAction = {
              effect: targetRequiringEffect,
              sourceCard: card,
              sourcePlayer: next.currentPlayer,
              spiritIndex: newSpiritIndex,
              sourceNexusIndex: undefined,
              validTargets,
              trigger: 'summon',
              remainingEffects: [],
            };
            return next; // Wait for target selection
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
      case 'confirm_spirit_depletion': {
        if (!next.pendingSpiritDepletion) return next;

        const { proceed } = action;
        const pending = next.pendingSpiritDepletion;
        const me = next.players[next.currentPlayer]!;

        next.pendingSpiritDepletion = null;

        if (proceed) {
          // User confirmed: deplete the spirit
          const spirit = me.spirits[pending.spiritIndex];
          if (spirit) {
            removeDeadSpirit(me, pending.spiritIndex);
            fixupSpiritIndicesAfterRemoval(next, next.currentPlayer, pending.spiritIndex);
          }

          // Check if more spirits need depletion
          if (this.checkSpiritDepletionInMainPhase(next, next.currentPlayer)) {
            return next; // More depletion confirmations needed
          }
        }
        // If user cancelled (by adding core), spirit was already placed and core added
        break;
      }

      case 'confirm_nexus_depletion': {
        if (!next.pendingNexusDepletion) return next;

        const { proceed } = action;
        const pending = next.pendingNexusDepletion;
        const me = next.players[next.currentPlayer]!;

        next.pendingNexusDepletion = null;

        if (proceed) {
          // User confirmed: deplete the nexus
          const nexus = me.nexuses[pending.nexusIndex];
          if (nexus) {
            me.nexuses.splice(pending.nexusIndex, 1);
            me.trash.push(nexus.def);
          }
        }
        // If user cancelled (by adding core), nexus was already placed and core added
        break;
      }
      case 'select_effect_target': {
        if (!next.pendingEffectAction) return next;

        const pending = next.pendingEffectAction;
        const effect = pending.effect;

        // Apply the effect with the selected target
        const sourceLevel = pending.sourceCard.effects?.find((e) => e === effect) ? (effect.level?.[0] ?? 1) : undefined;

        if (pending.spiritIndex !== undefined) {
          // Effect triggered from a spirit
          next = triggerEffects(
            next,
            pending.trigger,
            pending.sourceCard,
            pending.sourcePlayer,
            pending.spiritIndex,
            action.targetSpiritIndex,
            undefined,
            undefined,
            undefined,
            action.targetNexusIndex,
            sourceLevel,
            pending.sourceNexusIndex
          );
        } else if (pending.sourceNexusIndex !== undefined) {
          // Effect triggered from a nexus
          next = triggerEffects(
            next,
            pending.trigger,
            pending.sourceCard,
            pending.sourcePlayer,
            undefined,
            action.targetSpiritIndex,
            undefined,
            undefined,
            undefined,
            action.targetNexusIndex,
            sourceLevel,
            pending.sourceNexusIndex
          );
        }

        // Clear the pending effect action
        next.pendingEffectAction = null;

        // Process remaining effects based on trigger type
        if (pending.trigger === 'end_step' && pending.remainingEffects.length > 0) {
          // For end_step effects, continue with remaining effects queue
          next = this.processEndStepEffectsQueue(next, pending.remainingEffects, 0);
        } else if (pending.trigger === 'summon') {
          // For summon effects, continue with remaining summon effects for this card
          // Trigger all summon effects (now that target has been selected)
          next = triggerEffects(
            next,
            'summon',
            pending.sourceCard,
            pending.sourcePlayer,
            pending.spiritIndex,
            action.targetSpiritIndex,
            undefined,
            undefined,
            undefined,
            undefined,
            pending.sourceCard.effects?.find((e) => e.level?.includes(1 || 2))?.level?.[0] ?? 1
          );
        } else if (pending.trigger === 'attack') {
          // For attack effects, continue attack flow: search_deck handling, then create pending attack
          const spirit = next.players[next.currentPlayer]?.spirits[pending.spiritIndex!];
          if (spirit) {
            // Check for search_deck effect
            const searchDeckEffect = spirit.def.effects?.find(e =>
              e.trigger === 'attack' &&
              e.action === 'search_deck' &&
              (!e.level || e.level.includes(spirit.level))
            );

            if (searchDeckEffect) {
              const me = next.players[next.currentPlayer]!;
              const openCount = Math.min(searchDeckEffect.value ?? 2, me.deck.length);
              const openedCards: CardDef[] = [];
              for (let i = 0; i < openCount; i++) {
                openedCards.push(me.deck.shift()!);
              }

              const selectableIndices: number[] = [];
              for (let i = 0; i < openedCards.length; i++) {
                const c = openedCards[i]!;
                const hasSymbol = !searchDeckEffect.symbol || c.lineage?.includes(searchDeckEffect.symbol);
                if (hasSymbol) {
                  selectableIndices.push(i);
                }
              }

              const toRearrangeIndices: number[] = [];
              for (let i = 0; i < openedCards.length; i++) {
                if (!selectableIndices.includes(i)) {
                  toRearrangeIndices.push(i);
                }
              }

              next.pendingDraw = {
                openedCards,
                toHandIndices: selectableIndices,
                toRearrangeIndices,
                selectableIndices,
                castCard: spirit.def,
                maxSelectable: searchDeckEffect.count ?? 1,
                returnDestination: 'trash',
                originAttackSpiritIndex: pending.spiritIndex,
                originAttackPlayer: next.currentPlayer,
              };
              return next;
            }

            // No search_deck: create pending attack
            const damage = spirit.def.symbolCount;
            const pendingAttack: PendingAttack = {
              attackerPlayer: next.currentPlayer,
              attackerSpiritIndex: pending.spiritIndex!,
              damage,
            };

            const defenderIndex = 1 - next.currentPlayer;
            next.pendingFlash = {
              trigger: 'opponent_attack',
              cardId: '',
              initiatingPlayer: next.currentPlayer,
              stashedAttack: pendingAttack,
            };
            next.currentPlayer = defenderIndex;
          }
        }

        break;
      }
      case 'add_core': {
        // If spell chain is pending and user adds core, clear it (cancels destruction)
        if (next.pendingSpellChain) {
          next.pendingSpellChain = null;
        }

        // If spirit depletion is pending and user adds core, clear it (cancels depletion)
        if (next.pendingSpiritDepletion) {
          next.pendingSpiritDepletion = null;
        }

        // If nexus depletion is pending and user adds core, clear it (cancels depletion)
        if (next.pendingNexusDepletion) {
          next.pendingNexusDepletion = null;
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

          // Check if nexus still meets minimum core requirement (after core movement)
          // This only checks existing nexuses; newly placed nexuses are handled in place_nexus
        }

        // Check if any spirits meet depletion condition in main phase
        if (this.checkSpiritDepletionInMainPhase(next, next.currentPlayer)) {
          return next; // Stop here, player must confirm depletion
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

        // Check if any spirits meet depletion condition in main phase BEFORE removing them
        if (this.checkSpiritDepletionInMainPhase(next, next.currentPlayer)) {
          return next; // Stop here, player must confirm depletion
        }

        // If no confirmation needed, remove dead spirits and nexuses
        this.removeDeadSpirits(next, next.currentPlayer);
        this.removeDeadNexuses(next, next.currentPlayer);

        break;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return next;

        // Calculate cost after reductions
        const fieldSymbols = this.getFieldSymbols(me);
        const availableEX = countInheritableEX(me.trash, card);
        const useInheritance = action.useInheritance !== false && !!card.inheritance;
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, availableEX, useInheritance);
        // 継召: remove exactly as many EX cards as the reduction they granted
        const exToRemove = useInheritance ? inheritanceEXConsumed(card, fieldSymbols, availableEX) : 0;

        // Need enough cores to pay the cost AND move Lv1 maintenance cores onto the nexus
        const totalAvailable = this.getTotalAvailableCores(me);
        if (totalAvailable < actualCost + card.lv1.cost) return next;

        // 支払うコア: pay only the placement cost (paid cores go to trash)
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        // 継召: remove the EX cards used for reduction from the game (from trash)
        this.removeInheritedEX(me, card, exToRemove);
        // Paying from field spirits may drain one to 0 cores: in main phase ask
        // for confirmation (消滅前の処理) instead of silently removing it
        if (!this.checkSpiritDepletionInMainPhase(next, next.currentPlayer)) {
          this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores
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

        // A nexus that could not receive all required maintenance cores needs confirmation in main phase
        const totalCoresPlaced = nexusRegular + nexusSoul;
        if (totalCoresPlaced < card.lv1.cost) {
          // In main phase, ask player before depleting
          if (next.phase === 'main') {
            next.pendingNexusDepletion = {
              nexusIndex: me.nexuses.length, // will be added after confirmation
              nexusCard: card,
              requiredCores: card.lv1.cost,
              currentCores: totalCoresPlaced,
            };
            return next; // Stop here, player must confirm
          }
          // In other phases, auto-deplete
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

        const hasSoulMagicRedEffect = isSoulMagicRedCard(card);
        const soulPayment = hasSoulMagicRedEffect && action.coreType === 'soul';

        if (soulPayment) {
          // Soul Magic alternative cost: exactly 1 soul core (reserve or spirits)
          const canPaySoulCore = me.soulCores >= 1 || me.spirits.some((s) => s.soulCoreCount > 0);
          if (!canPaySoulCore) return next;
          me.hand.splice(action.handIndex, 1);
          this.payCost(me, 1, 0, 1);
        } else {
          // Calculate cost after reductions
          const fieldSymbols = this.getFieldSymbols(me);
          const availableEX = countInheritableEX(me.trash, card);
          const useInheritance = action.useInheritance !== false && !!card.inheritance;
          const actualCost = calculateCostAfterReduction(card, fieldSymbols, availableEX, useInheritance);
          // 継召: remove exactly as many EX cards as the reduction they granted
          const exToRemove = useInheritance ? inheritanceEXConsumed(card, fieldSymbols, availableEX) : 0;

          // Check if player has enough cores (including from spirits)
          const totalAvailable = this.getTotalAvailableCores(me);
          if (actualCost > totalAvailable) return next;

          // Pay cost using specified regular/soul core distribution
          me.hand.splice(action.handIndex, 1);
          this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
          // 継召: remove the EX cards used for reduction from the game (from trash)
          this.removeInheritedEX(me, card, exToRemove);
        }

        // Paying from field spirits may drain one to 0 cores: in main phase ask
        // for confirmation (消滅前の処理) instead of silently removing it
        if (!this.checkSpiritDepletionInMainPhase(next, next.currentPlayer)) {
          this.removeDeadSpirits(next, next.currentPlayer);
        }

        me.trash.push(card);

        // For Soul Magic Red: skip symbol check when cast with the normal cost (not the soul-core cost)
        const skipSymbolCheck = hasSoulMagicRedEffect && !soulPayment;

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

        // Official rule: the spirit exhausts (疲労) at attack DECLARATION, not at
        // battle resolution. This also guarantees a spirit can never re-declare
        // an attack while its attack is still being processed (search_deck,
        // target selection, flash windows, ...).
        spirit.canAttack = false;

        // Check for effects that require user selection during attack
        const searchDeckEffect = spirit.def.effects?.find(e =>
          e.trigger === 'attack' &&
          e.action === 'search_deck' &&
          (!e.level || e.level.includes(spirit.level))
        );

        const targetRequiringEffect = spirit.def.effects?.find(e =>
          e.trigger === 'attack' &&
          e.requiresTarget &&
          (!e.level || e.level.includes(spirit.level))
        );

        // If there's a target-requiring effect (destroy_creature, place_core, etc.) and we haven't selected a target yet
        if (targetRequiringEffect && action.effectTargetIndex === undefined) {
          // Find valid targets based on effect type
          let validTargets: { spiritIndices: number[]; nexusIndices: number[] } = { spiritIndices: [], nexusIndices: [] };

          if (targetRequiringEffect.action === 'destroy_creature') {
            // Find opponent spirits that meet the BP threshold
            const opponent = next.players[1 - next.currentPlayer]!;
            const bpLimit = destroyCreatureBpLimit(targetRequiringEffect, me);
            const spiritBp = (sp: Spirit) => {
              const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
              return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
            };
            for (let i = 0; i < opponent.spirits.length; i++) {
              if (bpLimit === undefined || spiritBp(opponent.spirits[i]!) <= bpLimit) {
                validTargets.spiritIndices.push(i);
              }
            }
          } else if (targetRequiringEffect.action === 'place_core') {
            // Find own spirits matching condition
            validTargets = this.findValidTargetsForEffect(next, next.currentPlayer, targetRequiringEffect);
          }

          // If there are valid targets, wait for selection
          if (validTargets.spiritIndices.length > 0 || validTargets.nexusIndices.length > 0) {
            next.pendingEffectAction = {
              effect: targetRequiringEffect,
              sourceCard: spirit.def,
              sourcePlayer: next.currentPlayer,
              spiritIndex: action.spiritIndex,
              sourceNexusIndex: undefined,
              validTargets,
              trigger: 'attack',
              remainingEffects: [],
            };
            return next; // Wait for target selection
          }
        }

        // Trigger attack effects (may boost BP, place cores, etc.), passing discardCardIndex/effectTargetIndex if provided
        // This EXCLUDES search_deck (requires user selection) and flash effects (need user activation)
        next = triggerEffects(next, 'attack', spirit.def, next.currentPlayer, action.spiritIndex, action.effectTargetIndex, undefined, action.discardCardIndex, 'main', undefined, spirit.level, undefined, undefined, ['search_deck']);

        // Remove spirits that lost their cores during attack effects.
        // This can SHIFT the attacker's index, so re-resolve it by object identity
        // afterwards — building pendingAttack from the stale action.spiritIndex
        // pointed battles at the wrong (or a nonexistent) spirit.
        const attackerBeforeRemoval = next.players[next.currentPlayer]!.spirits[action.spiritIndex];
        this.removeDeadSpirits(next, next.currentPlayer);
        const attackerIndexNow = attackerBeforeRemoval
          ? next.players[next.currentPlayer]!.spirits.indexOf(attackerBeforeRemoval)
          : -1;
        if (attackerIndexNow === -1) {
          // The attacker itself was depleted mid-attack: nothing left to resolve
          return next;
        }

        // Nexus "attack"-trigger effects (e.g. buffs during my attack step)
        // Flash effects are excluded and handled in flash window
        const attackerNow = next.players[next.currentPlayer]!;
        for (let ni = 0; ni < attackerNow.nexuses.length; ni++) {
          const nexus = attackerNow.nexuses[ni]!;
          next = triggerEffects(next, 'attack', nexus.def, next.currentPlayer, attackerIndexNow, undefined, undefined, undefined, 'main', undefined, nexus.level, ni);
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
          // toHandIndices includes all selectable cards, but maxSelectable limits how many can be chosen
          next.pendingDraw = {
            openedCards,
            toHandIndices: selectableIndices,
            toRearrangeIndices,
            selectableIndices,
            castCard: spirit.def,
            maxSelectable: searchDeckEffect.count ?? 1,
            returnDestination: 'trash', // attack search_deck cards go to trash, not deck bottom
            originAttackSpiritIndex: attackerIndexNow, // track that this came from an attack (index re-resolved after removals)
            originAttackPlayer: next.currentPlayer, // track which player is attacking
          };
          return next; // Stop here, player must select cards
        }

        // No search_deck effect: create pending attack opportunity for opponent to defend
        const damage = spirit.def.symbolCount;
        const pendingAttack: PendingAttack = {
          attackerPlayer: next.currentPlayer,
          attackerSpiritIndex: attackerIndexNow,
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
        if (pd.originAttackSpiritIndex !== undefined && pd.originAttackPlayer !== undefined) {
          next.pendingDraw = null;

          const spirit = next.players[pd.originAttackPlayer]!.spirits[pd.originAttackSpiritIndex];
          if (!spirit) return next;

          // Effects (including nexus effects) were already triggered when the attack started.
          // Now just create the pending attack opportunity for the opponent to defend.

          const damage = spirit.def.symbolCount;
          const pendingAttack: PendingAttack = {
            attackerPlayer: pd.originAttackPlayer,
            attackerSpiritIndex: pd.originAttackSpiritIndex,
            damage,
          };

          const defenderIndex = 1 - pd.originAttackPlayer;

          // Always give the defender a flash opportunity before they must choose defend/take_damage
          // They must explicitly skip flash, even if they don't have any flash cards
          next.pendingFlash = {
            trigger: 'opponent_attack',
            cardId: '',
            initiatingPlayer: pd.originAttackPlayer,
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
          // Both sente and gote's first turn: skip attack + main2, go directly to end
          const isFirstTurnOfGame = next.turnCount < 2;
          if (isFirstTurnOfGame) {
            // Skip to end phase directly (skip attack and main2)
            next.phase = 'end';

            // Process end-of-turn effects, handling target selection
            next = this.processEndStepEffects(next);

            // If there's a pending effect action, wait for player input
            if (next.pendingEffectAction) {
              return next;
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

          // Process end-of-turn effects, handling target selection
          next = this.processEndStepEffects(next);

          // If there's a pending effect action, wait for player input
          if (next.pendingEffectAction) {
            return next;
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
        if (action.targetNexusIndex !== undefined) key += `N${action.targetNexusIndex}`;
        if (action.effectValue !== undefined) key += `V${action.effectValue}`;
        if (action.coreType === 'soul') key += `SC`; // soul-core payment variant
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
        if (action.coreType === 'soul') key += `SC`; // soul-core payment variant
        return key;
      }
      case 'skip_flash': return 'SF';
      case 'mulligan': return action.redraw ? 'MU-redraw' : 'MU-keep';
      case 'select_effect_target': {
        let key = 'SE';
        if (action.targetSpiritIndex !== undefined) key += `S${action.targetSpiritIndex}`;
        if (action.targetNexusIndex !== undefined) key += `N${action.targetNexusIndex}`;
        return key;
      }
      case 'confirm_spell_chain': return `CSC${action.proceed ? '1' : '0'}`;
      case 'confirm_spirit_depletion': return `CSD${action.proceed ? '1' : '0'}`;
      case 'confirm_nexus_depletion': return `CND${action.proceed ? '1' : '0'}`;
      case 'select_draw_arrange': return 'SDA';
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
        // Only show payment cost, not Lv1 placement cost. Reflect whether this
        // particular action uses 継召 so the choice dialog can distinguish variants.
        const useInh = action.useInheritance !== false;
        const cost = card ? this.effectiveCostWithFlag(me, card, useInh) : 0;
        const inhLabel = card?.inheritance && useInh ? '・継召あり' : card?.inheritance ? '・継召なし' : '';
        return `${card?.name ?? '?'}を召喚（コア${cost}個${inhLabel}）`;
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
        const useInh = action.useInheritance !== false;
        const cost = card ? this.effectiveCostWithFlag(me, card, useInh) : 0;
        const inhLabel = card?.inheritance && useInh ? '・継召あり' : card?.inheritance ? '・継召なし' : '';
        return `${card?.name ?? '?'}を配置（コア${cost}個${inhLabel}）`;
      }
      case 'use_magic': {
        const card = me.hand[action.handIndex];
        let desc = `${card?.name ?? '?'}を使用`;
        if (action.coreType === 'soul' && card && isSoulMagicRedCard(card)) {
          desc += `（ソウルコア払い）`;
        } else if (card?.inheritance) {
          desc += action.useInheritance !== false ? `（継召あり）` : `（継召なし）`;
        }
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
        if (action.coreType === 'soul' && card && isSoulMagicRedCard(card)) {
          desc += `（ソウルコア払い）`;
        }
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
      case 'confirm_spirit_depletion': {
        if (!state.pendingSpiritDepletion) return '?';
        const pending = state.pendingSpiritDepletion;
        if (!action.proceed) return '?'; // Should not happen now
        return `${pending.spiritCard.name}を消滅させる（コア: ${pending.currentCores}/${pending.requiredCores}）`;
      }
      case 'confirm_nexus_depletion': {
        if (!state.pendingNexusDepletion) return '?';
        const pending = state.pendingNexusDepletion;
        if (!action.proceed) return '?'; // Should not happen now
        return `${pending.nexusCard.name}を消滅させる（コア: ${pending.currentCores}/${pending.requiredCores}）`;
      }
      case 'select_draw_arrange': {
        if (!state.pendingDraw) return 'カード選択';
        const cardName = state.pendingDraw.castCard?.name || 'オファーリングドロー';
        const selectedIndices = action.selectedCardIndices || [];
        const selectedCards = selectedIndices.map(idx => state.pendingDraw!.openedCards[idx]!.name).join(', ');
        return `${cardName}: ${selectedCards || 'なし'}を手札に加える`;
      }
      case 'select_effect_target': {
        if (!state.pendingEffectAction) return '効果対象選択';
        const pending = state.pendingEffectAction;
        let targetName = '?';
        if (action.targetSpiritIndex !== undefined) {
          targetName = me.spirits[action.targetSpiritIndex]?.def.name || '?';
        } else if (action.targetNexusIndex !== undefined) {
          targetName = me.nexuses[action.targetNexusIndex]?.def.name || '?';
        }
        return `${pending.sourceCard.name}の効果: ${targetName}を対象に選択`;
      }
      default: return '?';
    }
  }
}

// === Helpers ===

/** Card carries ソウルマジック：赤 (card-level or effect-level skill flag) */
function isSoulMagicRedCard(card: CardDef): boolean {
  return card.skill === 'ソウルマジック：赤' || !!card.effects?.some((e) => e.skill === 'ソウルマジック：赤');
}

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
    pendingDiceRoll: state.pendingDiceRoll ? { ...state.pendingDiceRoll } : null,
    pendingFlash: state.pendingFlash ? { ...state.pendingFlash } : null,
    pendingAttack: state.pendingAttack ? { ...state.pendingAttack } : null,
    pendingDraw: state.pendingDraw
      ? {
          // Spread first so every field survives the clone (returnDestination,
          // originAttackSpiritIndex, maxSelectable, castCard, etc.) — dropping
          // originAttackSpiritIndex here silently broke attack continuation
          ...state.pendingDraw,
          openedCards: state.pendingDraw.openedCards.slice(),
          toHandIndices: state.pendingDraw.toHandIndices.slice(),
          toRearrangeIndices: state.pendingDraw.toRearrangeIndices.slice(),
          selectableIndices: state.pendingDraw.selectableIndices?.slice(),
        }
      : null,
    pendingMulligan: state.pendingMulligan ? { ...state.pendingMulligan } : null,
    pendingSpellChain: state.pendingSpellChain ? { ...state.pendingSpellChain } : null,
    pendingSpiritDepletion: state.pendingSpiritDepletion ? { ...state.pendingSpiritDepletion } : null,
    pendingNexusDepletion: state.pendingNexusDepletion ? { ...state.pendingNexusDepletion } : null,
    pendingEffectAction: state.pendingEffectAction
      ? {
          effect: state.pendingEffectAction.effect,
          sourceCard: state.pendingEffectAction.sourceCard,
          sourcePlayer: state.pendingEffectAction.sourcePlayer,
          spiritIndex: state.pendingEffectAction.spiritIndex,
          sourceNexusIndex: state.pendingEffectAction.sourceNexusIndex,
          validTargets: {
            spiritIndices: state.pendingEffectAction.validTargets.spiritIndices.slice(),
            nexusIndices: state.pendingEffectAction.validTargets.nexusIndices.slice(),
          },
          trigger: state.pendingEffectAction.trigger,
          remainingEffects: state.pendingEffectAction.remainingEffects.slice(),
        }
      : null,
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
    damageThisTurn: p.damageThisTurn, // Soul Magic red condition tracking — must survive cloning
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
