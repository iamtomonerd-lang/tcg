import type { Game, Rng } from '../../core/game.js';
import { Mulberry32 } from '../../core/rng.js';
import { CARD_DB } from './cards.js';
import { DeckFactory } from './deckFactory.js';
import type { Action, GameState, Nexus, Spirit, PlayerState, PendingAttack, CardDef, CardEffect, GameConfig, PlayerConfig, GameRuleConfig } from './types.js';
import { applyEffect, triggerEffects, destroySpirit, removeDeadSpirit, updateSpiritLevel, fixupSpiritIndicesAfterRemoval, destroyCreatureBpLimit, checkEffectConditions } from './effects.js';
import { dbg, DEBUG_FLASH, DEBUG_CORE, DEBUG_VERBOSE } from './debug.js';
import { CostResolver, type PaymentPlan } from './costResolver.js';

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

/**
 * ヘルパー関数：コア変化をログする
 */
function logCoreChange(
  player: PlayerState,
  playerId: number,
  newCores: number,
  reason: string,
): void {
  const oldCores = player.cores;
  const diff = newCores - oldCores;
  if (diff !== 0) {
    dbg(DEBUG_CORE, '[CORE_CHANGE]', {
      reason,
      player: playerId,
      before: oldCores,
      after: newCores,
      diff: diff > 0 ? `+${diff}` : `${diff}`,
    });
  }
  player.cores = newCores;
}

/**
 * ヘルパー関数：ソウルコア変化をログする
 */
function logSoulCoreChange(
  player: PlayerState,
  playerId: number,
  newCores: number,
  reason: string,
): void {
  const oldCores = player.soulCores;
  const diff = newCores - oldCores;
  if (diff !== 0) {
    dbg(DEBUG_CORE, '[SOUL_CORE_CHANGE]', {
      reason,
      player: playerId,
      before: oldCores,
      after: newCores,
      diff: diff > 0 ? `+${diff}` : `${diff}`,
    });
  }
  player.soulCores = newCores;
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

    dbg(DEBUG_VERBOSE, '[INIT] After player creation:', {
      p0Cores: players[0].cores,
      p1Cores: players[1].cores,
    });

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

    dbg(DEBUG_VERBOSE, '[INIT] After drawing opening hand:', {
      p0Cores: state.players[0].cores,
      p1Cores: state.players[1].cores,
      p0HandSize: state.players[0].hand.length,
      p1HandSize: state.players[1].hand.length,
    });

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
    const deck = DeckFactory.getStarterDeck();
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
      excludedCards: [],
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
      excludedCards: [],
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
    playerId?: number,
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
      return this.payCostLegacy(player, amount, legacyCoreType, playerId);
    }

    // Take exactly the specified number of regular cores
    // From reserve first, then from spirits
    if (regularRemaining > 0) {
      const fromReserve = Math.min(player.cores, regularRemaining);
      if (fromReserve > 0) {
        const pid = playerId ?? 0;
        logCoreChange(player, pid, player.cores - fromReserve, 'payCost');
      } else {
        player.cores -= fromReserve;
      }
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
  private payCostLegacy(player: PlayerState, amount: number, coreType?: 'regular' | 'soul', playerId?: number): boolean {
    let remaining = amount;
    const pid = playerId ?? 0;

    if (coreType === 'soul') {
      // Use soul cores first (from reserve, then spirits), then regular cores
      if (player.soulCores >= remaining) {
        if (remaining > 0) logSoulCoreChange(player, pid, player.soulCores - remaining, 'payCostLegacy');
        player.trashSoulCores += remaining;
        remaining = 0;
      } else {
        player.trashSoulCores += player.soulCores;
        remaining -= player.soulCores;
        if (player.soulCores > 0) logSoulCoreChange(player, pid, 0, 'payCostLegacy');
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
    dbg(DEBUG_VERBOSE, '[START_TURN] Starting new turn:', {
      currentPlayer: state.currentPlayer,
      turnCount: state.turnCount,
      currentPhase: state.phase,
    });
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
          // The first turn of the game (turnCount === 0) skips core step
          const isFirstTurnOfFirstPlayer = next.turnCount === 0;
          const p = next.players[next.currentPlayer]!;
          const coresBeforeCore = p.cores;

          dbg(DEBUG_VERBOSE, '[CORE] Core phase - start:', {
            turnCount: next.turnCount,
            currentPlayer: next.currentPlayer,
            isFirstTurnOfFirstPlayer,
            playerCoresBeforeCore: coresBeforeCore,
          });

          if (!isFirstTurnOfFirstPlayer) {
            logCoreChange(p, next.currentPlayer, p.cores + 1, 'coreStep');
          } else {
            dbg(DEBUG_VERBOSE, '[CORE] Core phase - skipped for first turn of game');
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
          // 〔ターン1回〕【起動：フラッシュ】 usage resets at the turn boundary (both players)
          for (const pl of next.players) {
            for (const spirit of pl.spirits) {
              spirit.flashActivatedThisTurn = false;
            }
          }
          // Return cores from trash to reserve
          if (p.trashCores > 0) {
            logCoreChange(p, next.currentPlayer, p.cores + p.trashCores, 'refreshTrashCores');
          }
          if (p.trashSoulCores > 0) {
            logSoulCoreChange(p, next.currentPlayer, p.soulCores + p.trashSoulCores, 'refreshTrashSoulCores');
          }
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
        if (action.paymentPlan) return action.paymentPlan.finalCost;
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'spirit') return 0;
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
      }
      case 'place_nexus': {
        if (action.paymentPlan) return action.paymentPlan.finalCost;
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return 0;
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
      }
      case 'use_magic': {
        if (action.paymentPlan) return action.paymentPlan.finalCost;
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return 0;
        if (action.coreType === 'soul' && isSoulMagicRedCard(card)) return 1;
        return this.effectiveCostWithFlag(player, card, action.useInheritance !== false);
      }
      case 'flash': {
        if (action.paymentPlan) return action.paymentPlan.finalCost;
        const card = player.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return 0;
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

  /**
   * 【起動：フラッシュ】 effect type: a flash-timing ability with an activation
   * cost (the text before ▶) and a resolution effect (the text after ▶).
   * Card-type agnostic — spirits, nexuses, and any future field card types are
   * recognized purely by their effect data:
   *   - cost part: costAction (+costSymbol) / costExhaustSelf / future cost fields
   *   - effect part: action/value/duration etc. (resolved via triggerEffects)
   */
  private isActivatedFlashEffect(e: CardEffect): boolean {
    return (e.isFlash === true || e.mode === 'flash') && (e.costAction !== undefined || e.costExhaustSelf === true);
  }

  private hasAffordableFlash(player: PlayerState): boolean {
    const totalCores = this.getTotalAvailableCores(player);
    const canPaySoulCore = player.soulCores >= 1 || player.spirits.some((s) => s.soulCoreCount > 0);
    return player.hand.some(
      (c) =>
        c.cardType === 'magic' &&
        // Any magic with flash-mode effects can be used in flash timing
        // (trigger can be 'immediate', 'attack', 'summon', etc.; mode='flash' or isFlash=true indicates flash timing)
        c.effects?.some((e) => (e.isFlash || e.mode === 'flash')) &&
        (this.effectiveCost(player, c) <= totalCores ||
          // Soul Magic alternative cost: 1 soul core
          (isSoulMagicRedCard(c) && canPaySoulCore)),
    );
  }

  legalActions(state: GameState): Action[] {
    if (state.result) return [];

    // Inheritance selection: player must select EX cards from trash
    if (state.pendingInheritanceSelection) {
      const pending = state.pendingInheritanceSelection;

      // Generate actions for each inheritance count option (0 to maxInheritanceCount)
      // This allows AI to choose how many EX cards to use
      const actions: Action[] = [];

      // Option 0: Don't use inheritance
      actions.push({
        type: 'select_inheritance',
        inheritanceCount: 0,
        selectedCardIds: [],
      });

      // Options 1 to maxInheritanceCount: Use inheritance
      for (let count = 1; count <= pending.maxInheritanceCount; count++) {
        actions.push({
          type: 'select_inheritance',
          inheritanceCount: count,
          selectedCardIds: [], // Default selection will use first N candidates
        });
      }

      return actions;
    }

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
      const spirit = me.spirits[state.pendingSpiritDepletion.spiritIndex];

      if (me.cores > 0 || me.soulCores > 0) {
        // Offer both regular and soul core options if any cores in reserve are available
        if (me.cores > 0) {
          actions.push({ type: 'add_core', spiritIndex: state.pendingSpiritDepletion.spiritIndex, coreType: 'regular' });
        }
        if (me.soulCores > 0) {
          actions.push({ type: 'add_core', spiritIndex: state.pendingSpiritDepletion.spiritIndex, coreType: 'soul' });
        }
      }

      // Allow moving cores from spirit back to reserve
      if (spirit && spirit.coreCount > 0) {
        actions.push({ type: 'move_core', fromZone: 'spirit', fromIndex: state.pendingSpiritDepletion.spiritIndex, toZone: 'reserve', coreType: 'regular' });
      }
      if (spirit && spirit.soulCoreCount > 0) {
        actions.push({ type: 'move_core', fromZone: 'spirit', fromIndex: state.pendingSpiritDepletion.spiritIndex, toZone: 'reserve', coreType: 'soul' });
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
      const nexus = me.nexuses[state.pendingNexusDepletion.nexusIndex];

      if (me.cores > 0 || me.soulCores > 0) {
        // Offer both regular and soul core options if any cores in reserve are available
        if (me.cores > 0) {
          actions.push({ type: 'add_core', nexusIndex: state.pendingNexusDepletion.nexusIndex, coreType: 'regular' });
        }
        if (me.soulCores > 0) {
          actions.push({ type: 'add_core', nexusIndex: state.pendingNexusDepletion.nexusIndex, coreType: 'soul' });
        }
      }

      // Allow moving cores from nexus back to reserve
      if (nexus && nexus.coreCount > 0) {
        actions.push({ type: 'move_core', fromZone: 'nexus', fromIndex: state.pendingNexusDepletion.nexusIndex, toZone: 'reserve', coreType: 'regular' });
      }
      if (nexus && nexus.soulCoreCount > 0) {
        actions.push({ type: 'move_core', fromZone: 'nexus', fromIndex: state.pendingNexusDepletion.nexusIndex, toZone: 'reserve', coreType: 'soul' });
      }

      return actions;
    }

    // Effect target selection: user must select a target for the effect
    if (state.pendingEffectAction) {
      const actions: Action[] = [];
      const pending = state.pendingEffectAction;

      // Check if this is a trash_to_hand effect (marked by spiritIndices: [-1])
      if (pending.validTargets.spiritIndices.includes(-1)) {
        // Generate actions for each valid trash card
        const me = state.players[pending.sourcePlayer]!;
        const effect = pending.effect;
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
            actions.push({ type: 'select_effect_target', trashCardId: card.id });
          }
        }
        return actions;
      }

      // Generate actions for each valid spirit target
      for (const spiritIdx of pending.validTargets.spiritIndices) {
        if (spiritIdx >= 0) { // Skip the -1 marker if present
          actions.push({ type: 'select_effect_target', targetSpiritIndex: spiritIdx });
        }
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
      const actions: Action[] = [];
      // Can activate flash magic cards (only if affordable)
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i]!;
        if (card.cardType !== 'magic') continue;
        // Filter effects by mode: either mode 'flash' or no mode specified (for backward compatibility)
        const flashEffects = card.effects?.filter(e => (e.isFlash || !e.mode || e.mode === 'flash')) ?? [];
        if (flashEffects.length === 0) continue;

        // Get all possible payment plans using CostResolver
        const flashPlans = CostResolver.getPaymentPlans(state, me, card);
        if (flashPlans.length === 0) continue; // Can't afford this magic card

        const destroyEffect = flashEffects.find((e) => e.action === 'destroy_creature');
        const boostEffect = flashEffects.find((e) => e.action === 'boost_bp' && e.requiresTarget);

        const hasSymbolOnField = (color: string) =>
          me.spirits.some((s) => s.def.symbolColors?.includes(color)) ||
          me.nexuses.some((n) => n.def.symbolColors?.includes(color));

        // For each payment plan, generate targeting actions
        for (const plan of flashPlans) {
          const isSoulPayment = plan.paymentType === 'soulMagic';
          // Symbol condition gates the soul-core casting only
          const symbolGateApplies = isSoulPayment;

          if (destroyEffect && destroyEffect.requiresTarget) {
            if (symbolGateApplies && destroyEffect.condition?.requiresSymbol && !hasSymbolOnField(destroyEffect.condition.requiresSymbol)) {
              continue;
            }
            for (let t = 0; t < opponent.spirits.length; t++) {
              actions.push({ type: 'flash', handIndex: i, targetSpiritIndex: t, paymentPlan: plan });
            }
          } else if (destroyEffect) {
            if (symbolGateApplies && destroyEffect.condition?.requiresSymbol && !hasSymbolOnField(destroyEffect.condition.requiresSymbol)) {
              continue;
            }
            actions.push({ type: 'flash', handIndex: i, paymentPlan: plan });
          } else if (boostEffect) {
            if (me.spirits.length === 0) continue;
            for (let t = 0; t < me.spirits.length; t++) {
              actions.push({ type: 'flash', handIndex: i, targetSpiritIndex: t, paymentPlan: plan });
            }
          } else {
            actions.push({ type: 'flash', handIndex: i, paymentPlan: plan });
          }
        }
      }
      // 【起動：フラッシュ】 activated effects on own field (pay cost ▶ effect)
      const stashedAtk = state.pendingFlash.stashedAttack;
      const iAmAttacker = stashedAtk?.attackerPlayer === state.currentPlayer;

      for (let si = 0; si < me.spirits.length; si++) {
        const spirit = me.spirits[si]!;
        for (const e of spirit.def.effects ?? []) {
          if (!this.isActivatedFlashEffect(e)) continue; // 【起動：フラッシュ】 only
          if (e.level && !e.level.includes(spirit.level)) continue;
          if (e.oncePerTurn && spirit.flashActivatedThisTurn) continue; // 〔ターン1回〕
          // 『アタック中』: this spirit itself must be the current attacker
          if (e.trigger === 'attack' && !(iAmAttacker && stashedAtk!.attackerSpiritIndex === si)) continue;
          if (e.costAction === 'discard_hand') {
            // One action per discardable hand card (player chooses which card to pay)
            for (let h = 0; h < me.hand.length; h++) {
              const c = me.hand[h]!;
              if (e.costSymbol && !c.lineage?.includes(e.costSymbol)) continue;
              actions.push({ type: 'activate_flash', sourceType: 'spirit', sourceIndex: si, discardCardIndex: h });
            }
          } else {
            actions.push({ type: 'activate_flash', sourceType: 'spirit', sourceIndex: si });
          }
        }
      }

      for (let ni = 0; ni < me.nexuses.length; ni++) {
        const nexus = me.nexuses[ni]!;
        for (const e of nexus.def.effects ?? []) {
          if (!this.isActivatedFlashEffect(e)) continue; // 【起動：フラッシュ】 only
          if (e.level && !e.level.includes(nexus.level)) continue;
          if (e.costExhaustSelf && nexus.exhausted) continue; // already paid this turn
          // 『自分のアタックステップ』: my spirit must be attacking
          if (e.trigger === 'attack' && !iAmAttacker) continue;
          if (e.requiresTarget && e.targetType === 'attacking') {
            const ti = stashedAtk!.attackerSpiritIndex;
            const target = me.spirits[ti];
            if (!target) continue;
            if (e.targetLineage && !target.def.lineage?.includes(e.targetLineage)) continue;
            actions.push({ type: 'activate_flash', sourceType: 'nexus', sourceIndex: ni, targetSpiritIndex: ti });
          } else {
            actions.push({ type: 'activate_flash', sourceType: 'nexus', sourceIndex: ni });
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
    // Normal turn actions using CostResolver
    for (let i = 0; i < me.hand.length; i++) {
      const card = me.hand[i]!;

      // Debug: Log card definition when checking for inheritance
      if (card.name === '飛剛アクライ' || card.id === 'spirit_hibutsu_akurai') {
        console.log('[INHERITANCE_CARD_DEBUG]', {
          cardId: card.id,
          cardName: card.name,
          rawCardDefinition: JSON.stringify(card),
          inheritanceField: card.inheritance,
          hasInheritanceResult: !!card.inheritance,
        });
      }

      if (card.cardType === 'spirit' || card.cardType === 'nexus') {
        // Get all possible payment plans
        const plans = CostResolver.getPaymentPlans(state, me, card);

        if (plans.length === 0) continue;

        // Generate action for each plan
        for (const plan of plans) {
          if (card.cardType === 'spirit') {
            const action: any = {
              type: 'summon',
              handIndex: i,
              paymentPlan: plan,
            };
            actions.push(action);

            // ③ Inheritance plan in action check
            if (plan.maxInheritanceCount > 0) {
              console.log('[INHERITANCE③] Action with inheritance generated (summon):', {
                cardName: card.name,
                handIndex: i,
                actionIndex: actions.length - 1,
                maxInheritanceCount: plan.maxInheritanceCount,
                inheritanceCardIds: plan.inheritanceCardIds,
              });
            }
          } else if (card.cardType === 'nexus') {
            const action: any = {
              type: 'place_nexus',
              handIndex: i,
              paymentPlan: plan,
            };
            actions.push(action);

            // ③ Inheritance plan in action check
            if (plan.maxInheritanceCount > 0) {
              console.log('[INHERITANCE③] Action with inheritance generated (place_nexus):', {
                cardName: card.name,
                handIndex: i,
                actionIndex: actions.length - 1,
                maxInheritanceCount: plan.maxInheritanceCount,
                inheritanceCardIds: plan.inheritanceCardIds,
              });
            }
          }
        }
      } else if (card.cardType === 'magic') {
        // Get all possible payment plans using CostResolver
        const magicPlans = CostResolver.getPaymentPlans(state, me, card);
        if (magicPlans.length === 0) continue; // Can't afford this magic card

        // Filter effects by mode (main phase effects: mode 'main', no mode, or Soul Magic can use flash as main too)
        const mainEffects = card.effects?.filter(e => {
          if (!e.mode || e.mode === 'main') return true;
          if (isSoulMagicRedCard(card) && e.mode === 'flash') return true;
          return false;
        }) ?? [];

        if (mainEffects.length === 0) continue; // No main-phase effects for this card

        // Check if card has effects with requiresTarget (for spirits or nexuses)
        const hasDestroyNexusEffect = mainEffects.some((e) => e.action === 'destroy_nexus') ?? false;
        const hasOtherTargetEffect = mainEffects.some((e) => e.requiresTarget && e.action !== 'destroy_nexus') ?? false;
        const hasVariableEffect = mainEffects.some((e) => e.variableValue) ?? false;

        // For each payment plan, generate targeting actions
        for (const plan of magicPlans) {
          const isSoulPayment = plan.paymentType === 'soulMagic';

          // Symbol condition gates the soul-core casting only
          if (isSoulPayment) {
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
            // For destroy_nexus with requiresTarget, don't embed target in legalActions
            // Instead, the use_magic handler will set up pendingEffectAction for target selection
            actions.push({ type: 'use_magic', handIndex: i, paymentPlan: plan });
          } else if (hasOtherTargetEffect) {
            const opponent = state.players[1 - state.currentPlayer]!;
            const destroyCEffect = mainEffects.find((e) => e.action === 'destroy_creature' && e.requiresTarget);
            const bpLimit = destroyCEffect ? destroyCreatureBpLimit(destroyCEffect, me) : undefined;
            const spiritBp = (sp: Spirit) => {
              const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
              return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
            };

            for (let t = 0; t < opponent.spirits.length; t++) {
              if (!destroyCEffect || bpLimit === undefined || spiritBp(opponent.spirits[t]!) <= bpLimit) {
                actions.push({ type: 'use_magic', handIndex: i, targetSpiritIndex: t, paymentPlan: plan });
              }
            }
          } else if (hasVariableEffect) {
            const maxValue = Math.min(me.hand.length, 5);
            for (let v = 0; v <= maxValue; v++) {
              actions.push({ type: 'use_magic', handIndex: i, effectValue: v, paymentPlan: plan });
            }
          } else {
            actions.push({ type: 'use_magic', handIndex: i, paymentPlan: plan });
          }
        }
      }
    }

    // Place a core from reserve onto a spirit or nexus
    // Note: add_core only uses cores from reserve, not from spirits, so check reserve specifically
    const reserveCores = me.cores + me.soulCores;
    if (reserveCores > 0) {
      // Add cores to any spirit on field (no limit on core count)
      for (let i = 0; i < me.spirits.length; i++) {
        actions.push({ type: 'add_core', spiritIndex: i });
      }
      // Add cores to any nexus on field (no limit on core count)
      for (let i = 0; i < me.nexuses.length; i++) {
        actions.push({ type: 'add_core', nexusIndex: i });
      }
    }

    // Generate move_core actions (move one core at a time from field cards to reserve)
    for (let i = 0; i < me.spirits.length; i++) {
      const s = me.spirits[i]!;
      const totalCores = s.coreCount + s.soulCoreCount;
      if (totalCores > 0) {
        const coreType = s.coreCount > 0 ? 'regular' : 'soul';
        actions.push({ type: 'move_core', coreType, fromZone: 'spirit', fromIndex: i, toZone: 'reserve' });
      }
    }

    // Generate move_core actions for nexuses
    for (let i = 0; i < me.nexuses.length; i++) {
      const n = me.nexuses[i]!;
      const totalCores = n.coreCount + n.soulCoreCount;
      if (totalCores > 0) {
        const coreType = n.coreCount > 0 ? 'regular' : 'soul';
        actions.push({ type: 'move_core', coreType, fromZone: 'nexus', fromIndex: i, toZone: 'reserve' });
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
    const coreBefore = { p0: state.players[0].cores, p1: state.players[1].cores };
    dbg(DEBUG_VERBOSE, '[ACTION] Start:', {
      actionType: action.type,
      phase: state.phase,
      turnCount: state.turnCount,
      currentPlayer: state.currentPlayer,
      p0Cores: coreBefore.p0,
      p1Cores: coreBefore.p1,
    });

    let next = cloneState(state);
    const me = next.players[next.currentPlayer]!;
    const opponent = next.players[1 - next.currentPlayer]!;

    console.log('[ACTION_EXECUTED]', {
      type: action.type,
      coreType: (action as any).coreType,
      phase: state.phase,
    });

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
      dbg(DEBUG_VERBOSE, '[CHOOSE_ORDER] Before:', {
        winner,
        goFirst: action.goFirst,
        resultingFirstPlayer: firstPlayer,
        p0Cores: next.players[0].cores,
        p1Cores: next.players[1].cores,
      });
      next.pendingDiceRoll = null;

      next.pendingMulligan = { player: firstPlayer, firstPlayer };
      next.currentPlayer = firstPlayer;

      dbg(DEBUG_VERBOSE, '[CHOOSE_ORDER] After:', {
        p0Cores: next.players[0].cores,
        p1Cores: next.players[1].cores,
        currentPlayer: next.currentPlayer,
        firstPlayer: next.pendingMulligan.firstPlayer,
      });

      return next;
    }

    // Opening hand mulligan: keep as-is, or shuffle the whole hand back into the deck and redraw
    if (action.type === 'mulligan') {
      if (!next.pendingMulligan) return next;
      const decidingPlayer = next.pendingMulligan.player;
      const firstPlayer = next.pendingMulligan.firstPlayer;
      const p = next.players[decidingPlayer]!;

      dbg(DEBUG_VERBOSE, '[MULLIGAN] Before:', {
        decidingPlayer,
        firstPlayer,
        p0Cores: next.players[0].cores,
        p1Cores: next.players[1].cores,
        action: action.redraw ? 'redraw' : 'keep',
      });

      if (action.redraw) {
        p.deck.push(...p.hand);
        p.hand = [];
        rng.shuffle(p.deck);
        this.drawOpeningHand(p);
      }

      dbg(DEBUG_VERBOSE, '[MULLIGAN] After redraw processing:', {
        decidingPlayer,
        p0Cores: next.players[0].cores,
        p1Cores: next.players[1].cores,
      });

      const otherPlayer = 1 - decidingPlayer;
      if (decidingPlayer === firstPlayer) {
        // First player completed mulligan; move to second player
        next.pendingMulligan = { player: otherPlayer, firstPlayer };
        next.currentPlayer = otherPlayer;
        dbg(DEBUG_VERBOSE, '[MULLIGAN] First player done, switching to second player');
        return next;
      }

      // Second player completed mulligan; start the first turn
      dbg(DEBUG_VERBOSE, '[MULLIGAN] Second player done, calling startTurn:', {
        p0Cores: next.players[0].cores,
        p1Cores: next.players[1].cores,
        currentPlayer: firstPlayer,
      });
      next.pendingMulligan = null;
      next.currentPlayer = firstPlayer;
      return this.startTurn(next);
    }

    // Handle flash actions and flash skipping
    if (action.type === 'flash') {
      const card = me.hand[action.handIndex];
      if (!card || card.cardType !== 'magic') return next;
      if (!action.paymentPlan) return next; // paymentPlan is required

      // Remove card from hand
      me.hand.splice(action.handIndex, 1);

      // Apply inheritance (remove EX cards from trash)
      console.log('[INHERITANCE_REMOVAL_DEBUG] flash payment plan:', {
        hasPaymentPlan: !!action.paymentPlan,
        hasInheritanceCardIds: !!action.paymentPlan?.inheritanceCardIds,
        inheritanceCardIds: action.paymentPlan?.inheritanceCardIds,
        inheritanceCardIdsLength: action.paymentPlan?.inheritanceCardIds?.length || 0,
        trashLength: me.trash.length,
      });

      if (action.paymentPlan?.inheritanceCardIds && action.paymentPlan.inheritanceCardIds.length > 0) {
        const inheritedCards = me.trash.filter((c) => action.paymentPlan!.inheritanceCardIds.includes(c.id));
        me.excludedCards.push(...inheritedCards);
        me.trash = me.trash.filter((c) => !action.paymentPlan!.inheritanceCardIds.includes(c.id));
        console.log('[INHERITANCE_REMOVAL_DEBUG] flash: cards removed from trash');
      }

      // Pay cost using game's payCost method
      if (action.paymentPlan.finalCost > 0 && !action.paymentPlan.useSoulCore) {
        this.payCost(me, action.paymentPlan.finalCost);
      }

      // Pay soul core if needed
      if (action.paymentPlan.useSoulCore) {
        if (me.soulCores >= 1) {
          me.soulCores -= 1;
          me.trashSoulCores += 1;
        } else {
          // Spirit soul core
          for (const spirit of me.spirits) {
            if (spirit.soulCoreCount > 0) {
              spirit.soulCoreCount -= 1;
              me.trashSoulCores += 1;
              updateSpiritLevel(spirit);
              break;
            }
          }
        }
      }

      const hasSoulMagicRedEffect = isSoulMagicRedCard(card);
      this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores
      me.trash.push(card);
      // For Soul Magic Red: skip symbol check when cast with the normal cost (not the soul-core cost)
      const skipSymbolCheck = hasSoulMagicRedEffect && action.paymentPlan.paymentType !== 'soulMagic';
      next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue, undefined, 'flash', action.targetNexusIndex, undefined, undefined, undefined, skipSymbolCheck);
      checkResult(next);
      if (next.result) return next;

      // Re-read after the above effects: a destroy_creature (etc.) effect may have
      // removed the stashed attacker, in which case fixupSpiritIndicesAfterRemoval
      // already cancelled it (set to undefined) or shifted its index.
      const stashedAttack = next.pendingFlash?.stashedAttack;

      // Always give opponent counter-timing opportunity (stack flash)
      // Even if they don't have any flash cards, they must explicitly skip flash
      // Preserve after-block stash (defender index + BP data) so the window still
      // resolves the battle when it closes; a flash resets the consecutive-pass count
      next.pendingFlash = {
        trigger: next.pendingFlash!.trigger,
        cardId: '',
        initiatingPlayer: next.pendingFlash!.initiatingPlayer,
        lastFlashPlayer: next.currentPlayer,
        stashedAttack,
        stashedDefenderSpiritIndex: next.pendingFlash!.stashedDefenderSpiritIndex,
        stashedAttackData: next.pendingFlash!.stashedAttackData,
        passCount: 0,
      };
      // Switch to opponent for counter-timing
      next.currentPlayer = 1 - next.currentPlayer;
      dbg(DEBUG_FLASH, '[FLASH_USE]', {
        player: 1 - next.currentPlayer,
        card: card.name,
      });
      return next;
    }

    if (action.type === 'activate_flash') {
      // 【起動：フラッシュ】: pay activation cost (discard/exhaust) ▶ resolve effect.
      // Only legal inside an open flash window; the window stays open afterwards.
      if (!next.pendingFlash) return next;
      const player = next.currentPlayer;
      const stashedAtk = next.pendingFlash.stashedAttack;

      if (action.sourceType === 'spirit') {
        const spirit = me.spirits[action.sourceIndex];
        if (!spirit) return next;
        const effect = (spirit.def.effects ?? []).find(
          (e) => this.isActivatedFlashEffect(e) && (!e.level || e.level.includes(spirit.level)),
        );
        if (!effect) return next;
        if (effect.oncePerTurn && spirit.flashActivatedThisTurn) return next; // 〔ターン1回〕
        // 『アタック中』: this spirit itself must be the current attacker
        if (effect.trigger === 'attack' && !(stashedAtk && stashedAtk.attackerPlayer === player && stashedAtk.attackerSpiritIndex === action.sourceIndex)) return next;
        // Validate the discard cost up-front so 〔ターン1回〕 is only consumed on success
        if (effect.costAction === 'discard_hand') {
          const costCard = action.discardCardIndex !== undefined ? me.hand[action.discardCardIndex] : undefined;
          if (!costCard || (effect.costSymbol && !costCard.lineage?.includes(effect.costSymbol))) return next;
        }
        // triggerEffects pays the cost and applies the ▶ effect (onlyActivated: other
        // attack-trigger effects of this card do NOT fire here)
        next = triggerEffects(next, effect.trigger, spirit.def, player, action.sourceIndex, undefined, undefined, action.discardCardIndex, 'flash', undefined, spirit.level, undefined, undefined, undefined, undefined, true);
        // Re-fetch across the clone boundary before marking 〔ターン1回〕 usage
        const spiritNow = next.players[player]!.spirits[action.sourceIndex];
        if (spiritNow && effect.oncePerTurn) spiritNow.flashActivatedThisTurn = true;
        dbg(DEBUG_FLASH, '[FLASH_USE]', { player, card: spirit.def.name });
      } else {
        const nexus = me.nexuses[action.sourceIndex];
        if (!nexus) return next;
        const effect = (nexus.def.effects ?? []).find(
          (e) => this.isActivatedFlashEffect(e) && (!e.level || e.level.includes(nexus.level)),
        );
        if (!effect) return next;
        if (effect.costExhaustSelf && nexus.exhausted) return next;
        // 『自分のアタックステップ』 + targetType 'attacking': target must be my attacking spirit
        if (effect.requiresTarget) {
          const target = action.targetSpiritIndex !== undefined ? me.spirits[action.targetSpiritIndex] : undefined;
          if (!target) return next;
          if (effect.targetType === 'attacking' && !(stashedAtk && stashedAtk.attackerPlayer === player && stashedAtk.attackerSpiritIndex === action.targetSpiritIndex)) return next;
          if (effect.targetLineage && !target.def.lineage?.includes(effect.targetLineage)) return next;
        }
        next = triggerEffects(next, effect.trigger, nexus.def, player, undefined, action.targetSpiritIndex, undefined, undefined, 'flash', undefined, nexus.level, action.sourceIndex, undefined, undefined, undefined, true);
        dbg(DEBUG_FLASH, '[FLASH_USE]', { player, card: nexus.def.name });
      }

      checkResult(next);
      if (next.result) return next;

      // Keep the flash window open: opponent gets counter-timing, pass count resets
      next.pendingFlash = {
        ...next.pendingFlash!,
        lastFlashPlayer: player,
        passCount: 0,
      };
      next.currentPlayer = 1 - player;
      return next;
    }

    if (action.type === 'skip_flash') {
      if (!next.pendingFlash) return next;

      // If there was a flash used before, return to initiator to continue
      if (next.pendingFlash.lastFlashPlayer !== undefined && next.pendingFlash.lastFlashPlayer !== next.pendingFlash.initiatingPlayer) {
        dbg(DEBUG_FLASH, '[FLASH_PASS]', { player: next.currentPlayer, passCount: next.pendingFlash.passCount ?? 0 });
        // Return to initiating player for potential counter-flash
        next.currentPlayer = next.pendingFlash.initiatingPlayer;
        next.pendingFlash.lastFlashPlayer = undefined; // Clear last flash player to allow re-stacking
        checkResult(next);
        return next;
      }

      // Check if this is after-block flash (stashedDefenderSpiritIndex present)
      if (next.pendingFlash.stashedDefenderSpiritIndex !== undefined && next.pendingFlash.stashedAttackData) {
        // 2-pass rule: the window only closes after BOTH players pass consecutively.
        // First pass hands flash priority to the other player; second pass resolves.
        const passCount = (next.pendingFlash.passCount ?? 0) + 1;
        dbg(DEBUG_FLASH, '[FLASH_PASS]', { player: next.currentPlayer, passCount });
        if (passCount < 2) {
          next.pendingFlash.passCount = passCount;
          next.currentPlayer = 1 - next.currentPlayer;
          return next;
        }
        dbg(DEBUG_FLASH, '[FLASH_END]', { reason: 'battle_resolve' });

        // After-block flash window closed (2 consecutive passes): resolve battle now
        const defenderSpiritIndex = next.pendingFlash.stashedDefenderSpiritIndex;
        const stashedAttack = next.pendingFlash.stashedAttack;

        next.pendingFlash = null;

        if (!stashedAttack) {
          // Should not happen, but defensive
          checkResult(next);
          return next;
        }

        const attacker = next.players[stashedAttack.attackerPlayer]!.spirits[stashedAttack.attackerSpiritIndex];
        const defender = next.players[1 - stashedAttack.attackerPlayer]!.spirits[defenderSpiritIndex];

        if (!attacker || !defender) {
          // One of the spirits was destroyed during flash phase
          dbg(DEBUG_FLASH, '[BATTLE_RESOLVE]', { result: 'cancelled_spirit_gone', attackerAlive: !!attacker, defenderAlive: !!defender });
          next.pendingAttack = null;
          checkResult(next);
          return next;
        }

        // Recompute BP at resolution time so flash boosts used during the
        // after-block window (e.g. BP+3000 magic) are reflected in the battle
        const atkStats = attacker.level === 1 ? attacker.def.lv1 : attacker.def.lv2 || attacker.def.lv1;
        const attackBP = atkStats.bp + (attacker.bpBoost ?? 0) + (attacker.bpBoostBattle ?? 0);
        const defStats = defender.level === 1 ? defender.def.lv1 : defender.def.lv2 || defender.def.lv1;
        const defendBP = defStats.bp + (defender.bpBoost ?? 0) + (defender.bpBoostBattle ?? 0);

        return this.resolveBattle(next, attacker, defender, stashedAttack, attackBP, defendBP, defenderSpiritIndex);
      }

      // Before-block flash: same 2-pass rule — the first pass hands flash
      // priority to the other player; the second consecutive pass closes the
      // window and control returns to the defender to choose block/take_damage.
      const beforePassCount = (next.pendingFlash.passCount ?? 0) + 1;
      dbg(DEBUG_FLASH, '[FLASH_PASS]', { player: next.currentPlayer, passCount: beforePassCount });
      if (beforePassCount < 2) {
        next.pendingFlash.passCount = beforePassCount;
        next.currentPlayer = 1 - next.currentPlayer;
        return next;
      }
      dbg(DEBUG_FLASH, '[FLASH_END]', { reason: 'double_pass' });
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

      // Both spirits become fatigued immediately
      defender.canAttack = false;
      attacker.canAttack = false;

      // Trigger block effects (trigger: 'block') for defender
      next = triggerEffects(next, 'block', defender.def, next.currentPlayer, action.spiritIndex);

      // Calculate BP values for battle resolution (needed for after-block flash)
      const attackerStats = attacker.level === 1 ? attacker.def.lv1 : attacker.def.lv2 || attacker.def.lv1;
      const attackBP = attackerStats.bp + (attacker.bpBoost ?? 0) + (attacker.bpBoostBattle ?? 0);
      const defenderStats = defender.level === 1 ? defender.def.lv1 : defender.def.lv2 || defender.def.lv1;
      const defendBP = defenderStats.bp + (defender.bpBoost ?? 0) + (defender.bpBoostBattle ?? 0);

      // After-block flash timing ALWAYS occurs (regardless of flash card availability)
      // The attacker gets an opportunity to respond after the block declaration
      next.pendingFlash = {
        trigger: 'opponent_block',
        cardId: '',
        initiatingPlayer: next.currentPlayer, // Defender triggered this window
        stashedAttack: pendingAttack, // Store attack info for skip_flash to use in resolveBattle
        stashedDefenderSpiritIndex: action.spiritIndex,
        stashedAttackData: { attackBP, defendBP },
        passCount: 0,
      };
      // Clear pendingAttack: it's now stashed in pendingFlash
      next.pendingAttack = null;
      // Switch to attacker for after-block flash opportunity
      next.currentPlayer = pendingAttack.attackerPlayer;
      dbg(DEBUG_FLASH, '[FLASH_START]', {
        trigger: 'block_after',
        currentPlayer: next.currentPlayer,
        passCount: 0,
      });
      return next; // Wait for flash/skip_flash decision
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
      logCoreChange(me, next.currentPlayer, me.cores + damage, 'damageToCore');
      me.damageThisTurn = (me.damageThisTurn ?? 0) + damage; // Soul Magic red condition (ライフが減った)

      // Trigger battle_end effects
      // Important: only trigger battle_end if the attacker still exists on the field
      const attackerStillExists = next.players[next.pendingAttack.attackerPlayer]!.spirits[next.pendingAttack.attackerSpiritIndex] === attacker;
      if (attackerStillExists) {
        next = triggerEffects(next, 'battle_end', attacker.def, 1 - next.currentPlayer, next.pendingAttack.attackerSpiritIndex, undefined, undefined, undefined, undefined, undefined, attacker.level);
      }

      // このバトル中 boosts expire now that the battle has resolved
      this.clearBattleBoosts(next);

      next.pendingAttack = null;
      next.currentPlayer = 1 - next.currentPlayer; // Return turn to original player
      checkResult(next);
      return next;
    }

    switch (action.type) {
      case 'summon': {
        // ① applyAction開始
        const summmonCallId = Math.random().toString(36).slice(-6);
        console.log(`[SUMMON_APPLYACTION_DEBUG_${summmonCallId}]`, {
          hasPaymentPlan: !!action.paymentPlan,
          inheritanceCardIds: (action.paymentPlan as any)?.inheritanceCardIds,
          inheritanceCandidates: (action.paymentPlan as any)?.inheritanceCandidates ? 'exists' : 'none',
          maxInheritanceCount: (action.paymentPlan as any)?.maxInheritanceCount,
          cardName: me.hand[action.handIndex]?.name,
        });

        if ((action as any).paymentPlan?.maxInheritanceCount > 0) {
          console.log('[CP①] applyAction開始', { card: me.hand[action.handIndex]?.name });
        }

        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'spirit') return next;
        if (!action.paymentPlan) return next; // paymentPlan is required

        // Check if inheritance selection is needed (Phase 3 refactoring)
        // Selection is pending if inheritanceCandidates exists (not removed by finalizePaymentPlanFromSelection)
        if (
          action.paymentPlan.maxInheritanceCount > 0 &&
          action.paymentPlan.inheritanceCandidates &&
          action.paymentPlan.inheritanceCandidates.length > 0
        ) {
          // Not yet selected: transition to pending state with two-phase flow
          const candidates = action.paymentPlan.inheritanceCandidates;

          // ② Debug: Log pending inheritance selection
          console.log('[INHERITANCE_PENDING_DEBUG]', {
            cardName: card.name,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            candidates: candidates.map((c: any) => ({ id: c.id, name: c.name })),
            candidateCount: candidates.length,
            maxInheritanceCapability: action.paymentPlan.maxInheritanceCount,
            selectedCardIds: [],
          });

          next.pendingInheritanceSelection = {
            player: next.currentPlayer,
            cardHandIndex: action.handIndex,
            cardName: card.name,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            selectedInheritanceCount: 0,
            inheritanceCandidates: candidates,
            selectedCardIds: [],
            actionType: 'summon',
          };
          return next;
        }

        // ② applyPaymentPlan開始（継承処理開始）
        if (action.paymentPlan.maxInheritanceCount > 0) {
          console.log('[CP②] applyPaymentPlan開始', { maxInheritanceCount: action.paymentPlan.maxInheritanceCount });
        }

        // Remove card from hand
        me.hand.splice(action.handIndex, 1);

        // ③ removeInheritance開始
        console.log('[INHERITANCE_REMOVAL_DEBUG] summon action payment plan:', {
          hasPaymentPlan: !!action.paymentPlan,
          hasInheritanceCardIds: !!action.paymentPlan?.inheritanceCardIds,
          inheritanceCardIds: action.paymentPlan?.inheritanceCardIds,
          inheritanceCardIdsLength: action.paymentPlan?.inheritanceCardIds?.length || 0,
          trashLength: me.trash.length,
          trashCards: me.trash.map(c => c.name),
        });

        if (action.paymentPlan?.inheritanceCardIds && action.paymentPlan.inheritanceCardIds.length > 0) {
          const trashBefore = me.trash.map(c => c.name);
          console.log('[CP③] removeInheritance開始', {
            trash_before: trashBefore,
            remove_ids: action.paymentPlan.inheritanceCardIds,
          });
          // Apply inheritance (remove EX cards from trash and record them in excludedCards)
          const inheritedCards = me.trash.filter((c) => action.paymentPlan!.inheritanceCardIds.includes(c.id));
          me.excludedCards.push(...inheritedCards);
          me.trash = me.trash.filter((c) => !action.paymentPlan!.inheritanceCardIds.includes(c.id));
          const trashAfter = me.trash.map(c => c.name);
          console.log('[CP③] removeInheritance完了', {
            trash_before: trashBefore,
            trash_after: trashAfter,
            removed_count: trashBefore.length - trashAfter.length,
          });
        } else {
          console.log('[CP③] removeInheritance スキップ: inheritanceCardIds が空または存在しない');
        }

        // Pay cost using game's payCost method
        console.log('[SUMMON_PAYMENT_DEBUG]', {
          actionCoreType: action.coreType,
          paidRegularCores: (action as any).paidRegularCores,
          paidSoulCores: (action as any).paidSoulCores,
          paymentPlanFinalCost: action.paymentPlan.finalCost,
          useSoulCore: action.paymentPlan.useSoulCore,
          playerSoulCores: me.soulCores,
          playerRegularCores: me.cores,
        });

        // Priority 1: Use explicit UI-specified payment (from buttons)
        if ((action as any).paidRegularCores !== undefined || (action as any).paidSoulCores !== undefined) {
          const regularToPay = (action as any).paidRegularCores || 0;
          const soulToPay = (action as any).paidSoulCores || 0;
          console.log('[SUMMON_PAYMENT] Using explicit payment counts', { regularToPay, soulToPay });

          // Use payCost to handle both regular and soul core payment properly
          this.payCost(me, regularToPay + soulToPay, regularToPay, soulToPay);
        }
        // Priority 2: coreType-based payment
        else if (action.coreType === 'soul') {
          console.log('[SUMMON_PAYMENT] Using SOUL cores (coreType)');
          const soulCostToPay = action.paymentPlan.finalCost;
          let remaining = soulCostToPay;
          const fromReserve = Math.min(remaining, me.soulCores);
          me.soulCores -= fromReserve;
          me.trashSoulCores += fromReserve;
          remaining -= fromReserve;
          for (const spirit of me.spirits) {
            if (remaining <= 0) break;
            if (spirit.soulCoreCount > 0) {
              const take = Math.min(remaining, spirit.soulCoreCount);
              spirit.soulCoreCount -= take;
              me.trashSoulCores += take;
              updateSpiritLevel(spirit);
              remaining -= take;
            }
          }
        } else if (action.paymentPlan.finalCost > 0 && !action.paymentPlan.useSoulCore) {
          console.log('[SUMMON_PAYMENT] Using REGULAR cores');
          this.payCost(me, action.paymentPlan.finalCost);
        } else if (action.paymentPlan.useSoulCore) {
          console.log('[SUMMON_PAYMENT] Using SOUL MAGIC RED (1 soul core)');
          if (me.soulCores >= 1) {
            me.soulCores -= 1;
            me.trashSoulCores += 1;
          } else {
            for (const spirit of me.spirits) {
              if (spirit.soulCoreCount > 0) {
                spirit.soulCoreCount -= 1;
                me.trashSoulCores += 1;
                updateSpiritLevel(spirit);
                break;
              }
            }
          }
        }

        // ④ payCost終了
        if ((action as any).paymentPlan?.maxInheritanceCount > 0) {
          console.log('[CP④] payCost終了', { finalCost: action.paymentPlan.finalCost });
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

        // ⑤ summon完了
        if ((action as any).paymentPlan?.maxInheritanceCount > 0) {
          console.log('[CP⑤] summon完了', {
            field_spirits: me.spirits.map((s, i) => `[${i}]${s.def.name}`),
            trash: me.trash.map(c => c.name),
            reserve_cores: me.cores,
            hand: me.hand.map(c => c.name),
          });
        }

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

        // Paying from field spirits may drain one to 0 cores: in main phase ask
        // for confirmation (消滅前の処理) instead of silently removing it. This check
        // comes AFTER the new spirit's core placement so that pendingSpiritDepletion
        // for the new spirit (if needed) is checked first.
        const needsPaymentDepletionConfirm = this.checkSpiritDepletionInMainPhase(next, next.currentPlayer);
        if (!needsPaymentDepletionConfirm) {
          this.removeDeadSpirits(next, next.currentPlayer); // Remove spirits that reached 0 cores
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
          (!e.level || e.level.includes(spirit.level)) &&
          checkEffectConditions(e, next, next.currentPlayer)
        );

        // If there's a target-requiring effect, wait for selection
        if (targetRequiringEffect) {
          dbg(DEBUG_VERBOSE, '[SUMMON] Found target-requiring effect:', {
            cardName: card.name,
            effect: targetRequiringEffect.description,
            conditionsMet: true,
          });
          let validTargets: { spiritIndices: number[]; nexusIndices: number[] } = { spiritIndices: [], nexusIndices: [] };

          if (targetRequiringEffect.action === 'destroy_creature') {
            // Find opponent spirits/nexuses that meet the condition
            const opponent = next.players[1 - next.currentPlayer]!;
            const bpLimit = destroyCreatureBpLimit(targetRequiringEffect, me);
            const spiritBp = (sp: Spirit) => {
              const stats = sp.level === 1 ? sp.def.lv1 : sp.def.lv2 || sp.def.lv1;
              return stats.bp + (sp.bpBoost ?? 0) + (sp.bpBoostBattle ?? 0);
            };
            // Always check opponent spirits
            for (let i = 0; i < opponent.spirits.length; i++) {
              if (bpLimit === undefined || spiritBp(opponent.spirits[i]!) <= bpLimit) {
                validTargets.spiritIndices.push(i);
              }
            }
            // Include nexuses only for 'any' target type (not 'opponent_creature')
            // 'opponent_creature' means spirits only per Battle Spirits rules
            const allowNexusTarget = !targetRequiringEffect.target || targetRequiringEffect.target === 'any';
            if (allowNexusTarget) {
              for (let i = 0; i < opponent.nexuses.length; i++) {
                validTargets.nexusIndices.push(i);
              }
            }
          } else if (targetRequiringEffect.action === 'trash_to_hand') {
            // For trash_to_hand, check if there are actually cards in trash matching the condition
            const targetLineage = targetRequiringEffect.symbol;
            const maxCost = targetRequiringEffect.condition?.maxCost;
            const excludeId = targetRequiringEffect.excludeId;

            let hasValidTrashCards = false;
            for (const card of me.trash) {
              const lineageMatch = !targetLineage || (card.lineage && card.lineage.includes(targetLineage));
              const costMatch = maxCost === undefined || card.cost <= maxCost;
              const excludeMatch = !excludeId || card.id !== excludeId;
              const typeMatch = card.cardType === 'spirit';

              if (lineageMatch && costMatch && excludeMatch && typeMatch) {
                hasValidTrashCards = true;
                break;
              }
            }

            if (hasValidTrashCards) {
              validTargets.spiritIndices = [-1]; // Special marker: selecting from trash
              console.log('[SUMMON_TRASH_TO_HAND] Set validTargets for trash selection:', {
                cardName: card.name,
                hasTrash: me.trash.length > 0,
                trashCardCount: me.trash.length,
                validTargets,
              });
            } else {
              // No valid trash cards: skip target selection and trigger effects normally
              console.log('[SUMMON_TRASH_TO_HAND] No valid trash cards found, skipping target selection:', {
                cardName: card.name,
                trashCount: me.trash.length,
                targetLineage,
                maxCost,
              });
            }
          } else if (targetRequiringEffect.action === 'place_core') {
            // Find own spirits/nexuses matching condition
            validTargets = this.findValidTargetsForEffect(next, next.currentPlayer, targetRequiringEffect);
          }

          // If there are valid targets, wait for selection
          dbg(DEBUG_VERBOSE, '[SUMMON] Valid targets calculation:', {
            cardName: card.name,
            action: targetRequiringEffect.action,
            validSpiritIndices: validTargets.spiritIndices,
            validNexusIndices: validTargets.nexusIndices,
            totalValid: validTargets.spiritIndices.length + validTargets.nexusIndices.length,
          });

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
            console.log('[SUMMON_EFFECT_ACTION_SET] pendingEffectAction created:', {
              cardName: card.name,
              effectAction: targetRequiringEffect.action,
              validSpiritIndices: validTargets.spiritIndices,
              validTargetCount: validTargets.spiritIndices.length + validTargets.nexusIndices.length,
            });
            dbg(DEBUG_VERBOSE, '[SUMMON] Set pendingEffectAction:', {
              cardName: card.name,
              validTargetCount: validTargets.spiritIndices.length + validTargets.nexusIndices.length,
            });
            return next; // Wait for target selection
          } else {
            dbg(DEBUG_VERBOSE, '[SUMMON] No valid targets found for effect:', {
              cardName: card.name,
              action: targetRequiringEffect.action,
              opponentSpiritCount: next.players[1 - next.currentPlayer]!.spirits.length,
              opponentNexusCount: next.players[1 - next.currentPlayer]!.nexuses.length,
            });
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
      case 'select_inheritance': {
        if (!next.pendingInheritanceSelection) {
          console.error('[ERROR] No pendingInheritanceSelection to process');
          return next;
        }

        const pending = next.pendingInheritanceSelection;

        // Phase 3: Two-phase selection flow
        // action.inheritanceCount = player's choice of how many to use (1 to maxInheritanceCount)
        // action.selectedCardIds = which cards to use
        const inheritanceCount = action.inheritanceCount ?? 0;

        // Validate player's count choice against capability
        if (inheritanceCount < 0 || inheritanceCount > pending.maxInheritanceCount) {
          console.error('[ERROR] Invalid inheritance count choice', {
            chosen: inheritanceCount,
            max: pending.maxInheritanceCount,
          });
          return next;
        }

        // If selectedCardIds is empty or undefined, use default selection (first N candidates)
        // This happens when AI/headless mode makes the action without explicit selection
        let selectedIds = action.selectedCardIds || [];
        if (selectedIds.length === 0 && inheritanceCount > 0) {
          selectedIds = pending.inheritanceCandidates
            .slice(0, inheritanceCount)
            .map(c => c.id);
        }


        // Validate selected card count matches player's choice
        let validationFailed = false;
        if (selectedIds.length !== inheritanceCount) {
          console.error('[ACTION] VALIDATION_FAILED: expected', inheritanceCount, 'cards, got', selectedIds.length, '→ Proceeding with 0 inheritance');
          validationFailed = true;
        } else {
          // Validate that all selected IDs are in candidates only if count matched
          const candidateIds = new Set(pending.inheritanceCandidates.map(c => c.id));
          for (const id of selectedIds) {
            if (!candidateIds.has(id)) {
              console.error('[ERROR] Selected card not in candidates:', id, '→ Proceeding with 0 inheritance');
              validationFailed = true;
              break;
            }
          }
        }

        // On validation failure, reset to inheritance count 0
        let finalInheritanceCount = inheritanceCount;
        if (validationFailed) {
          selectedIds = [];
          finalInheritanceCount = 0; // Fallback to no inheritance
          // Do NOT return early; proceed below with empty selection as fallback
        }

        // Update the pending state with selection
        pending.selectedInheritanceCount = finalInheritanceCount;
        pending.selectedCardIds = selectedIds;

        // Now that selection is complete, re-apply summon with the confirmed inheritanceCardIds
        const summoning = next.players[next.currentPlayer]!;
        const summonCard = summoning.hand[pending.cardHandIndex];
        if (!summonCard) {
          console.error('[ERROR] Summon card not found at hand index');
          return next;
        }

        // Delegate cost finalization to CostResolver
        // (Encapsulates all cost-calculation rules in one place)
        const finalPlan = CostResolver.finalizePaymentPlanFromSelection(
          next,
          summoning,
          summonCard,
          finalInheritanceCount,
          selectedIds
        );

        if (!finalPlan) {
          console.error('[ERROR] Failed to finalize payment plan from selection');
          return next;
        }

        // Clear pending state
        next.pendingInheritanceSelection = null;

        // Reconstruct the original action based on actionType
        const actionType = (pending as any).actionType || 'summon'; // default to summon for backward compatibility
        let finalAction: any;

        if (actionType === 'use_magic') {
          // Reconstruct use_magic action with optional targeting fields
          finalAction = {
            type: 'use_magic',
            handIndex: pending.cardHandIndex,
            paymentPlan: finalPlan,
            targetSpiritIndex: (pending as any).targetSpiritIndex,
            targetNexusIndex: (pending as any).targetNexusIndex,
            effectValue: (pending as any).effectValue,
          };
        } else {
          // Reconstruct summon action (default)
          finalAction = {
            type: 'summon',
            handIndex: pending.cardHandIndex,
            paymentPlan: finalPlan,
          };
        }

        // Debug: Log finalPlan with inheritanceCardIds before re-applying action
        console.log('[SELECT_INHERITANCE_COMPLETE] finalPlan details:', {
          actionType,
          inheritanceCardIds: finalPlan.inheritanceCardIds,
          inheritanceCardIdsLength: finalPlan.inheritanceCardIds?.length || 0,
          maxInheritanceCount: finalPlan.maxInheritanceCount,
          finalCost: finalPlan.finalCost,
        });

        const callId = Math.random().toString(36).slice(-6);
        console.log(`[SELECT_INHERITANCE_COMPLETE_${callId}] finalAction being passed to applyAction:`, {
          type: finalAction.type,
          handIndex: finalAction.handIndex,
          hasPaymentPlan: !!finalAction.paymentPlan,
          paymentPlanInheritanceCardIds: finalAction.paymentPlan?.inheritanceCardIds,
          fullPaymentPlan: JSON.stringify({
            finalCost: finalAction.paymentPlan?.finalCost,
            inheritanceCardIds: finalAction.paymentPlan?.inheritanceCardIds,
            maxInheritanceCount: finalAction.paymentPlan?.maxInheritanceCount,
            paymentType: finalAction.paymentPlan?.paymentType,
          }),
        });

        // Recursively call applyAction to complete the action
        // Note: rng can be undefined for deterministic actions
        console.log(`[SELECT_INHERITANCE_BEFORE_RECURSIVE_CALL_${callId}] About to call applyAction recursively`);
        const result = this.applyAction(next, finalAction, undefined as any);
        console.log(`[SELECT_INHERITANCE_AFTER_APPLYACTION_${callId}] Result state updated`);
        return result;
      }
      case 'select_effect_target': {
        dbg(DEBUG_VERBOSE, '[GAME] Processing select_effect_target:', {
          hasPending: !!next.pendingEffectAction,
          targetSpiritIndex: action.targetSpiritIndex,
          targetNexusIndex: action.targetNexusIndex,
          trashCardId: (action as any).trashCardId,
        });

        if (!next.pendingEffectAction) {
          console.error('[ERROR] No pendingEffectAction to process');
          return next;
        }

        const pending = next.pendingEffectAction;
        const effect = pending.effect;

        dbg(DEBUG_VERBOSE, '[GAME] Effect details:', {
          action: effect.action,
          trigger: pending.trigger,
          sourcePlayer: pending.sourcePlayer,
          sourceCard: pending.sourceCard.name,
        });

        // Apply the effect with the selected target
        const sourceLevel = pending.sourceCard.effects?.find((e) => e === effect) ? (effect.level?.[0] ?? 1) : undefined;

        dbg(DEBUG_VERBOSE, '[GAME] Before triggerEffects, pendingEffectAction:', !!next.pendingEffectAction);

        // Pass targetTrashCardId via effectValue (use as context for trash_to_hand)
        const effectValue = (action as any).trashCardId ? undefined : undefined;
        const targetTrashCardId = (action as any).trashCardId;

        if (pending.spiritIndex !== undefined) {
          // Effect triggered from a spirit
          dbg(DEBUG_VERBOSE, '[GAME] Triggering from spirit');
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
            pending.sourceNexusIndex,
            targetTrashCardId
          );
        } else if (pending.sourceNexusIndex !== undefined) {
          // Effect triggered from a nexus
          dbg(DEBUG_VERBOSE, '[GAME] Triggering from nexus');
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
            pending.sourceNexusIndex,
            targetTrashCardId
          );
        } else {
          // Effect triggered from a magic card
          dbg(DEBUG_VERBOSE, '[GAME] Triggering from magic card');
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
            undefined,
            targetTrashCardId
          );
        }

        dbg(DEBUG_VERBOSE, '[GAME] After triggerEffects, before clearing');

        // Clear the pending effect action
        next.pendingEffectAction = null;
        dbg(DEBUG_VERBOSE, '[GAME] Cleared pendingEffectAction');

        // Process remaining effects based on trigger type
        if (pending.trigger === 'end_step' && pending.remainingEffects.length > 0) {
          // For end_step effects, continue with remaining effects queue
          next = this.processEndStepEffectsQueue(next, pending.remainingEffects, 0);
        } else if (pending.trigger === 'summon') {
          // For summon effects, continue with remaining summon effects for this card
          // Trigger all summon effects (now that target has been selected)
          // Pass targetTrashCardId for trash_to_hand effects
          const targetTrashCardId = (action as any).trashCardId;
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
            action.targetNexusIndex,
            pending.sourceCard.effects?.find((e) => e.level?.includes(1 || 2))?.level?.[0] ?? 1,
            pending.sourceNexusIndex,
            targetTrashCardId
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
            dbg(DEBUG_FLASH, '[FLASH_START]', {
              trigger: 'attack',
              currentPlayer: next.currentPlayer,
              passCount: 0,
            });
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
        if (!action.paymentPlan) return next; // paymentPlan is required

        // ③ inheritanceCardIds チェック
        if (action.paymentPlan && action.paymentPlan.maxInheritanceCount > 0) {
          console.log('[INHERITANCE③] inheritanceCardIds in action (place_nexus):', {
            handIndex: action.handIndex,
            cardName: card.name,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            inheritanceCardIds: action.paymentPlan.inheritanceCardIds,
            inheritanceCardIds_length: action.paymentPlan.inheritanceCardIds?.length,
          });
        }

        // Stage ③ diagnostic: Log action at applyAction entry
        if (action.paymentPlan && action.paymentPlan.maxInheritanceCount > 0) {
          dbg(DEBUG_VERBOSE, '[STAGE③] place_nexus entry:', {
            type: action.type,
            handIndex: action.handIndex,
            cardName: card.name,
            paymentType: action.paymentPlan.paymentType,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            inheritanceCardIds: action.paymentPlan.inheritanceCardIds,
            finalCost: action.paymentPlan.finalCost,
            trashLength: me.trash.length,
          });
        }

        // Remove card from hand
        me.hand.splice(action.handIndex, 1);

        // ④ removeInheritance 処理開始
        console.log('[INHERITANCE_REMOVAL_DEBUG] place_nexus payment plan:', {
          hasPaymentPlan: !!action.paymentPlan,
          hasInheritanceCardIds: !!action.paymentPlan?.inheritanceCardIds,
          inheritanceCardIds: action.paymentPlan?.inheritanceCardIds,
          inheritanceCardIdsLength: action.paymentPlan?.inheritanceCardIds?.length || 0,
          trashLength: me.trash.length,
        });

        // ⑤ removeInheritance 実行
        if (action.paymentPlan?.inheritanceCardIds && action.paymentPlan.inheritanceCardIds.length > 0) {
          const trashBefore = me.trash.map(c => c.name).join(', ');
          const inheritedCards = me.trash.filter(c => action.paymentPlan!.inheritanceCardIds.includes(c.id));
          const toRemove = inheritedCards.map(c => c.name).join(', ');

          // Apply inheritance (remove EX cards from trash and record them in excludedCards)
          me.excludedCards.push(...inheritedCards);
          me.trash = me.trash.filter((c) => !action.paymentPlan!.inheritanceCardIds.includes(c.id));

          console.log('[INHERITANCE⑤] removeInheritance executed (place_nexus):', {
            cardName: card.name,
            inheritanceCardsCount: action.paymentPlan.inheritanceCardIds.length,
            removedCards: toRemove,
            trashLengthAfter: me.trash.length,
          });

          dbg(DEBUG_VERBOSE, '[STAGE④] Inheritance removal (place_nexus):', {
            inheritanceCardsCount: action.paymentPlan.inheritanceCardIds.length,
            inheritanceCardIds: action.paymentPlan.inheritanceCardIds,
            trashBefore: trashBefore,
            removed: toRemove,
            trashAfter: me.trash.map(c => c.name).join(', '),
            trashLengthBefore: (trashBefore ? trashBefore.split(',').length : 0),
            trashLengthAfter: me.trash.length,
          });
        }

        // Pay cost using game's payCost method
        // Priority 1: Use explicit UI-specified payment (from buttons)
        if ((action as any).paidRegularCores !== undefined || (action as any).paidSoulCores !== undefined) {
          const regularToPay = (action as any).paidRegularCores || 0;
          const soulToPay = (action as any).paidSoulCores || 0;
          this.payCost(me, regularToPay + soulToPay, regularToPay, soulToPay);
        }
        // Priority 2: Check action.coreType first: if explicitly set to 'soul', pay finalCost in soul cores
        else if (action.coreType === 'soul') {
          const soulCostToPay = action.paymentPlan.finalCost;
          let remaining = soulCostToPay;
          // Pay from reserve soul cores first
          const fromReserve = Math.min(remaining, me.soulCores);
          me.soulCores -= fromReserve;
          me.trashSoulCores += fromReserve;
          remaining -= fromReserve;
          // Pay from spirit soul cores if needed
          for (const spirit of me.spirits) {
            if (remaining <= 0) break;
            if (spirit.soulCoreCount > 0) {
              const take = Math.min(remaining, spirit.soulCoreCount);
              spirit.soulCoreCount -= take;
              me.trashSoulCores += take;
              updateSpiritLevel(spirit);
              remaining -= take;
            }
          }
        } else if (action.paymentPlan.finalCost > 0 && !action.paymentPlan.useSoulCore) {
          this.payCost(me, action.paymentPlan.finalCost);
        } else if (action.paymentPlan.useSoulCore) {
          if (me.soulCores >= 1) {
            me.soulCores -= 1;
            me.trashSoulCores += 1;
          } else {
            // Spirit soul core
            for (const spirit of me.spirits) {
              if (spirit.soulCoreCount > 0) {
                spirit.soulCoreCount -= 1;
                me.trashSoulCores += 1;
                updateSpiritLevel(spirit);
                break;
              }
            }
          }
        }
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
        const nexusIndex = me.nexuses.length;
        me.nexuses.push(nexus);

        // Stage ⑤ diagnostic: Log post-place_nexus state
        if (action.paymentPlan.maxInheritanceCount > 0) {
          dbg(DEBUG_VERBOSE, '[STAGE⑤] Post-place_nexus state:', {
            nexusIndex,
            nexusName: card.name,
            trashAfterRemoval: me.trash.map(c => c.name).join(', '),
            trashLength: me.trash.length,
            coresOnNexus: nexusRegular,
            soulCoresOnNexus: nexusSoul,
            playerCores: me.cores,
            playerSoulCores: me.soulCores,
          });
        }

        // ⑥ place_nexus 完了
        if (action.paymentPlan.inheritanceCardIds.length > 0) {
          console.log('[INHERITANCE⑥] place_nexus completed:', {
            cardName: card.name,
            nexusIndex,
            inheritanceCardsUsed: action.paymentPlan.inheritanceCardIds.length,
            nexusOnFieldName: me.nexuses[nexusIndex]?.def?.name,
          });
        }

        // Check for summon effects that require target selection (e.g., trash_to_hand)
        const targetRequiringEffects = card.effects?.filter(e => e.requiresTarget && e.trigger === 'summon') || [];
        for (const targetRequiringEffect of targetRequiringEffects) {
          // Check if the effect's condition is met
          if (!checkEffectConditions(targetRequiringEffect, next, next.currentPlayer)) {
            continue;
          }

          dbg(DEBUG_VERBOSE, '[PLACE_NEXUS] Found target-requiring effect:', {
            cardName: card.name,
            effect: targetRequiringEffect.description,
            conditionsMet: true,
          });
          let validTargets: { spiritIndices: number[]; nexusIndices: number[] } = { spiritIndices: [], nexusIndices: [] };

          if (targetRequiringEffect.action === 'trash_to_hand') {
            // For trash_to_hand, check if there are actually cards in trash matching the condition
            const targetLineage = targetRequiringEffect.symbol;
            const maxCost = targetRequiringEffect.condition?.maxCost;
            const excludeId = targetRequiringEffect.excludeId;

            let hasValidTrashCards = false;
            for (const card of me.trash) {
              const lineageMatch = !targetLineage || (card.lineage && card.lineage.includes(targetLineage));
              const costMatch = maxCost === undefined || card.cost <= maxCost;
              const excludeMatch = !excludeId || card.id !== excludeId;
              const typeMatch = card.cardType === 'spirit';

              if (lineageMatch && costMatch && excludeMatch && typeMatch) {
                hasValidTrashCards = true;
                break;
              }
            }

            if (hasValidTrashCards) {
              validTargets.spiritIndices = [-1]; // Special marker: selecting from trash
              console.log('[PLACE_NEXUS_TRASH_TO_HAND] Set validTargets for trash selection:', {
                cardName: card.name,
                hasTrash: me.trash.length > 0,
                trashCardCount: me.trash.length,
                validTargets,
              });
            } else {
              // No valid trash cards: skip target selection and trigger effects normally
              console.log('[PLACE_NEXUS_TRASH_TO_HAND] No valid trash cards found, skipping target selection:', {
                cardName: card.name,
                trashCount: me.trash.length,
                targetLineage,
                maxCost,
              });
            }
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
              spiritIndex: undefined,
              sourceNexusIndex: nexusIndex,
              validTargets,
              trigger: 'summon',
              remainingEffects: [],
            };
            console.log('[NEXUS_EFFECT_ACTION_SET] pendingEffectAction created:', {
              cardName: card.name,
              effectAction: targetRequiringEffect.action,
              validSpiritIndices: validTargets.spiritIndices,
              validTargetCount: validTargets.spiritIndices.length + validTargets.nexusIndices.length,
            });
            dbg(DEBUG_VERBOSE, '[PLACE_NEXUS] Set pendingEffectAction:', {
              cardName: card.name,
              validTargetCount: validTargets.spiritIndices.length + validTargets.nexusIndices.length,
            });
            return next; // Wait for target selection
          }
        }

        // Trigger deployment effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer, undefined, nexusIndex);
        break;
      }
      case 'use_magic': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return next;
        if (!action.paymentPlan) return next; // paymentPlan is required

        // Check if inheritance selection is needed (for magic cards with inheritance)
        if (
          action.paymentPlan.maxInheritanceCount > 0 &&
          action.paymentPlan.inheritanceCandidates &&
          action.paymentPlan.inheritanceCandidates.length > 0
        ) {
          // Not yet selected: transition to pending state
          const candidates = action.paymentPlan.inheritanceCandidates;

          console.log('[INHERITANCE_PENDING_DEBUG] use_magic', {
            cardName: card.name,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            candidates: candidates.map((c: any) => ({ id: c.id, name: c.name })),
            candidateCount: candidates.length,
          });

          next.pendingInheritanceSelection = {
            player: next.currentPlayer,
            cardHandIndex: action.handIndex,
            cardName: card.name,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            selectedInheritanceCount: 0,
            inheritanceCandidates: candidates,
            selectedCardIds: [],
            actionType: 'use_magic',
            targetSpiritIndex: (action as any).targetSpiritIndex,
            targetNexusIndex: (action as any).targetNexusIndex,
            effectValue: (action as any).effectValue,
          };
          return next;
        }

        // ③ inheritanceCardIds チェック
        if (action.paymentPlan && action.paymentPlan.maxInheritanceCount > 0) {
          console.log('[INHERITANCE③] inheritanceCardIds in action (use_magic):', {
            handIndex: action.handIndex,
            cardName: card.name,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            inheritanceCardIds: action.paymentPlan.inheritanceCardIds,
            inheritanceCardIds_length: action.paymentPlan.inheritanceCardIds?.length,
          });
        }

        // Stage ③ diagnostic: Log action at applyAction entry
        if (action.paymentPlan && action.paymentPlan.maxInheritanceCount > 0) {
          dbg(DEBUG_VERBOSE, '[STAGE③] use_magic entry:', {
            type: action.type,
            handIndex: action.handIndex,
            cardName: card.name,
            paymentType: action.paymentPlan.paymentType,
            maxInheritanceCount: action.paymentPlan.maxInheritanceCount,
            inheritanceCardIds: action.paymentPlan.inheritanceCardIds,
            finalCost: action.paymentPlan.finalCost,
            trashLength: me.trash.length,
          });
        }

        // Remove card from hand
        me.hand.splice(action.handIndex, 1);

        // ④ removeInheritance 処理開始
        console.log('[INHERITANCE_REMOVAL_DEBUG] use_magic payment plan:', {
          hasPaymentPlan: !!action.paymentPlan,
          hasInheritanceCardIds: !!action.paymentPlan?.inheritanceCardIds,
          inheritanceCardIds: action.paymentPlan?.inheritanceCardIds,
          inheritanceCardIdsLength: action.paymentPlan?.inheritanceCardIds?.length || 0,
          trashLength: me.trash.length,
        });

        // ⑤ removeInheritance 実行
        if (action.paymentPlan?.inheritanceCardIds && action.paymentPlan.inheritanceCardIds.length > 0) {
          const trashBefore = me.trash.map(c => c.name).join(', ');
          const inheritedCards = me.trash.filter(c => action.paymentPlan!.inheritanceCardIds.includes(c.id));
          const toRemove = inheritedCards.map(c => c.name).join(', ');

          // Apply inheritance (remove EX cards from trash and record them in excludedCards)
          me.excludedCards.push(...inheritedCards);
          me.trash = me.trash.filter((c) => !action.paymentPlan!.inheritanceCardIds.includes(c.id));

          console.log('[INHERITANCE⑤] removeInheritance executed (use_magic):', {
            cardName: card.name,
            inheritanceCardsCount: action.paymentPlan.inheritanceCardIds.length,
            removedCards: toRemove,
            trashLengthAfter: me.trash.length,
          });

          dbg(DEBUG_VERBOSE, '[STAGE④] Inheritance removal (use_magic):', {
            inheritanceCardsCount: action.paymentPlan.inheritanceCardIds.length,
            inheritanceCardIds: action.paymentPlan.inheritanceCardIds,
            trashBefore: trashBefore,
            removed: toRemove,
            trashAfter: me.trash.map(c => c.name).join(', '),
            trashLengthBefore: (trashBefore ? trashBefore.split(',').length : 0),
            trashLengthAfter: me.trash.length,
          });
        }

        // Pay cost using game's payCost method
        // Priority 1: Use explicit UI-specified payment (from buttons)
        if ((action as any).paidRegularCores !== undefined || (action as any).paidSoulCores !== undefined) {
          const regularToPay = (action as any).paidRegularCores || 0;
          const soulToPay = (action as any).paidSoulCores || 0;
          this.payCost(me, regularToPay + soulToPay, regularToPay, soulToPay);
        }
        // Priority 2: Check action.coreType first: if explicitly set to 'soul', pay finalCost in soul cores
        else if (action.coreType === 'soul') {
          const soulCostToPay = action.paymentPlan.finalCost;
          let remaining = soulCostToPay;
          // Pay from reserve soul cores first
          const fromReserve = Math.min(remaining, me.soulCores);
          me.soulCores -= fromReserve;
          me.trashSoulCores += fromReserve;
          remaining -= fromReserve;
          // Pay from spirit soul cores if needed
          for (const spirit of me.spirits) {
            if (remaining <= 0) break;
            if (spirit.soulCoreCount > 0) {
              const take = Math.min(remaining, spirit.soulCoreCount);
              spirit.soulCoreCount -= take;
              me.trashSoulCores += take;
              updateSpiritLevel(spirit);
              remaining -= take;
            }
          }
        } else if (action.paymentPlan.finalCost > 0 && !action.paymentPlan.useSoulCore) {
          this.payCost(me, action.paymentPlan.finalCost);
        } else if (action.paymentPlan.useSoulCore) {
          if (me.soulCores >= 1) {
            me.soulCores -= 1;
            me.trashSoulCores += 1;
          } else {
            // Spirit soul core
            for (const spirit of me.spirits) {
              if (spirit.soulCoreCount > 0) {
                spirit.soulCoreCount -= 1;
                me.trashSoulCores += 1;
                updateSpiritLevel(spirit);
                break;
              }
            }
          }
        }

        // Paying from field spirits may drain one to 0 cores: in main phase ask
        // for confirmation (消滅前の処理) instead of silently removing it
        if (!this.checkSpiritDepletionInMainPhase(next, next.currentPlayer)) {
          this.removeDeadSpirits(next, next.currentPlayer);
        }

        me.trash.push(card);

        // Stage ⑤ diagnostic: Log post-use_magic state
        if (action.paymentPlan.maxInheritanceCount > 0) {
          dbg(DEBUG_VERBOSE, '[STAGE⑤] Post-use_magic state:', {
            cardName: card.name,
            trashAfterRemoval: me.trash.map(c => c.name).join(', '),
            trashLength: me.trash.length,
            playerCores: me.cores,
            playerSoulCores: me.soulCores,
          });
        }

        // ⑥ use_magic 完了
        if (action.paymentPlan.inheritanceCardIds.length > 0) {
          console.log('[INHERITANCE⑥] use_magic completed:', {
            cardName: card.name,
            inheritanceCardsUsed: action.paymentPlan.inheritanceCardIds.length,
            trashAfter: me.trash.map(c => c.name).join(', '),
          });
        }

        // For Soul Magic Red: skip symbol check when cast with the normal cost (not the soul-core cost)
        const hasSoulMagicRedEffect = isSoulMagicRedCard(card);
        const skipSymbolCheck = hasSoulMagicRedEffect && action.paymentPlan.paymentType !== 'soulMagic';

        // Check for destroy_nexus effects that require target selection
        const destroyNexusEffect = card.effects?.find(e =>
          e.trigger === 'immediate' &&
          e.action === 'destroy_nexus' &&
          e.requiresTarget &&
          (!e.mode || e.mode === 'main' || (hasSoulMagicRedEffect && e.mode === 'flash'))
        );

        // If destroy_nexus requires target and no targetNexusIndex provided, check if we need pending effect
        if (destroyNexusEffect && action.targetNexusIndex === undefined) {
          const opponent = next.players[1 - next.currentPlayer]!;
          const excludeSkill = destroyNexusEffect.condition?.excludeTargetSkill;
          const validNexusIndices: number[] = [];

          for (let t = 0; t < opponent.nexuses.length; t++) {
            const nexus = opponent.nexuses[t]!;
            if (nexus.level !== 2 && (!excludeSkill || nexus.def.skill !== excludeSkill)) {
              validNexusIndices.push(t);
            }
          }

          // If there are multiple valid targets, set up pending effect for user selection
          // If exactly one valid target, auto-select it; if none, skip the effect
          if (validNexusIndices.length > 1) {
            next.pendingEffectAction = {
              effect: destroyNexusEffect,
              sourceCard: card,
              sourcePlayer: next.currentPlayer,
              spiritIndex: undefined,
              sourceNexusIndex: undefined,
              validTargets: { spiritIndices: [], nexusIndices: validNexusIndices },
              trigger: 'immediate',
              remainingEffects: [],
            };
            return next; // Wait for target selection
          } else if (validNexusIndices.length === 1) {
            // Auto-select the only valid target
            action.targetNexusIndex = validNexusIndices[0];
          }
          // If validNexusIndices.length === 0, proceed without targeting (effect will be skipped)
        }

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
        next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue, undefined, 'main', action.targetNexusIndex, undefined, undefined, undefined, skipSymbolCheck);
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
            // Include nexuses only for 'any' target type (not 'opponent_creature')
            const allowNexusTarget = !targetRequiringEffect.target || targetRequiringEffect.target === 'any';
            if (allowNexusTarget) {
              for (let i = 0; i < opponent.nexuses.length; i++) {
                validTargets.nexusIndices.push(i);
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
        next = triggerEffects(next, 'attack', spirit.def, next.currentPlayer, action.spiritIndex, action.effectTargetIndex, undefined, action.discardCardIndex, 'main', undefined, spirit.level, undefined, undefined, undefined, ['search_deck']);

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
        // Flash timing ALWAYS occurs, regardless of whether they have flash cards
        // (they can still pass, even with no cards)
        next.pendingFlash = {
          trigger: 'opponent_attack',
          cardId: '',
          initiatingPlayer: next.currentPlayer,
          stashedAttack: pendingAttack,
        };
        next.currentPlayer = defenderIndex;
        dbg(DEBUG_FLASH, '[FLASH_START]', {
          trigger: 'attack',
          currentPlayer: next.currentPlayer,
          passCount: 0,
        });
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
          dbg(DEBUG_FLASH, '[FLASH_START]', {
            trigger: 'attack',
            currentPlayer: next.currentPlayer,
            passCount: 0,
          });
          return next;
        }

        // Clear pending draw and remain in current phase (main for magic card usage)
        next.pendingDraw = null;
        return next;
      }
      case 'pass': {
        // Handle phase transitions based on current phase
        if (next.phase === 'main') {
          // Only sente (player 0) turn 1: skip attack + main2, go directly to end
          // Gote (player 1) can attack starting from turn 1
          const isSenteTurn1 = next.turnCount === 0 && next.currentPlayer === 0;
          if (isSenteTurn1) {
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
        } else if (next.phase === 'end') {
          // Transition from End to next turn (Start phase)
          // Reset BP boosts if not already done
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

    const coreAfter = { p0: next.players[0].cores, p1: next.players[1].cores };
    const p0Diff = coreAfter.p0 - coreBefore.p0;
    const p1Diff = coreAfter.p1 - coreBefore.p1;
    if (p0Diff !== 0 || p1Diff !== 0) {
      dbg(DEBUG_VERBOSE, '[ACTION] Core change:', {
        actionType: action.type,
        p0: `${coreBefore.p0} → ${coreAfter.p0} (${p0Diff > 0 ? '+' : ''}${p0Diff})`,
        p1: `${coreBefore.p1} → ${coreAfter.p1} (${p1Diff > 0 ? '+' : ''}${p1Diff})`,
      });
    }

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

  /**
   * Resolve a battle after block flash window (if any) has closed.
   * Called from: block action (if no flash), or skip_flash (after block flash)
   */
  private resolveBattle(
    state: GameState,
    attacker: Spirit,
    defender: Spirit,
    pendingAttack: PendingAttack,
    attackBP: number,
    defendBP: number,
    defenderSpiritIndex: number,
  ): GameState {
    let next = state;
    const defender_player = next.players[1 - pendingAttack.attackerPlayer]!;
    const attacker_player = next.players[pendingAttack.attackerPlayer]!;

    dbg(DEBUG_FLASH, '[BATTLE_RESOLVE]', {
      attacker: attacker.def.name,
      defender: defender.def.name,
      attackerBP: attackBP,
      defenderBP: defendBP,
      result: attackBP > defendBP ? 'attacker_win' : attackBP < defendBP ? 'defender_win' : 'both_destroy',
    });

    // Resolve battle (destroyed spirits go to trash; their cores return to reserve)
    if (attackBP > defendBP) {
      // Attacker wins: destroy defender
      destroySpirit(defender_player, defenderSpiritIndex);
      next = triggerEffects(next, 'destroy', defender.def, 1 - pendingAttack.attackerPlayer);
      // Trigger nexus destroy effects for defender's player
      for (let ni = 0; ni < defender_player.nexuses.length; ni++) {
        const nexus = defender_player.nexuses[ni]!;
        next = triggerEffects(next, 'destroy', nexus.def, 1 - pendingAttack.attackerPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
      }
    } else if (attackBP < defendBP) {
      // Defender wins: destroy attacker
      destroySpirit(attacker_player, pendingAttack.attackerSpiritIndex);
      next = triggerEffects(next, 'destroy', attacker.def, pendingAttack.attackerPlayer);
      // Trigger nexus destroy effects for attacker's player
      for (let ni = 0; ni < attacker_player.nexuses.length; ni++) {
        const nexus = attacker_player.nexuses[ni]!;
        next = triggerEffects(next, 'destroy', nexus.def, pendingAttack.attackerPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
      }
    } else {
      // Equal BP: both destroyed
      destroySpirit(defender_player, defenderSpiritIndex);
      destroySpirit(attacker_player, pendingAttack.attackerSpiritIndex);
      next = triggerEffects(next, 'destroy', defender.def, 1 - pendingAttack.attackerPlayer);
      next = triggerEffects(next, 'destroy', attacker.def, pendingAttack.attackerPlayer);
      // Trigger nexus destroy effects for both players
      for (let ni = 0; ni < defender_player.nexuses.length; ni++) {
        const nexus = defender_player.nexuses[ni]!;
        next = triggerEffects(next, 'destroy', nexus.def, 1 - pendingAttack.attackerPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
      }
      for (let ni = 0; ni < attacker_player.nexuses.length; ni++) {
        const nexus = attacker_player.nexuses[ni]!;
        next = triggerEffects(next, 'destroy', nexus.def, pendingAttack.attackerPlayer, undefined, undefined, undefined, undefined, undefined, undefined, nexus.level);
      }
    }

    // Trigger battle_end effects
    // Important: only trigger battle_end if the spirit still exists on the field
    const attackerStillExists = next.players[pendingAttack.attackerPlayer]!.spirits[pendingAttack.attackerSpiritIndex] === attacker;
    if (attackerStillExists) {
      next = triggerEffects(next, 'battle_end', attacker.def, pendingAttack.attackerPlayer, pendingAttack.attackerSpiritIndex, undefined, undefined, undefined, undefined, undefined, attacker.level);
    }
    const defenderStillExists = next.players[1 - pendingAttack.attackerPlayer]!.spirits[defenderSpiritIndex] === defender;
    if (defenderStillExists) {
      next = triggerEffects(next, 'battle_end', defender.def, 1 - pendingAttack.attackerPlayer, defenderSpiritIndex, undefined, undefined, undefined, undefined, undefined, defender.level);
    }

    // このバトル中 boosts expire now that the battle has resolved
    this.clearBattleBoosts(next);

    next.pendingAttack = null;
    next.currentPlayer = 1 - next.currentPlayer; // Return turn to original player
    checkResult(next);
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
      case 'activate_flash': {
        let key = `AF${action.sourceType === 'spirit' ? 'S' : 'N'}${action.sourceIndex}`;
        if (action.discardCardIndex !== undefined) key += `D${action.discardCardIndex}`;
        if (action.targetSpiritIndex !== undefined) key += `T${action.targetSpiritIndex}`;
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
      case 'select_inheritance': {
        return `SI${action.selectedCardIds.join('-')}`;
      }
      default: return '?';
    }
  }

  /**
   * Generate all combinations of selecting k items from an array
   * Used to generate all possible inheritance selections
   */
  private generateCardCombinations(cardIds: string[], k: number): string[][] {
    if (k === 0) return [[]];
    if (k > cardIds.length) return [];
    if (k === 1) return cardIds.map(id => [id]);

    const result: string[][] = [];
    for (let i = 0; i <= cardIds.length - k; i++) {
      const head = cardIds[i]!;
      const tail = cardIds.slice(i + 1);
      for (const combination of this.generateCardCombinations(tail, k - 1)) {
        result.push([head, ...combination]);
      }
    }
    return result;
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
        const useInh = action.paymentPlan
          ? action.paymentPlan.inheritanceCardIds.length > 0 || action.paymentPlan.maxInheritanceCount > 0
          : action.useInheritance !== false;
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
        const useInh = action.paymentPlan
          ? action.paymentPlan.inheritanceCardIds.length > 0 || action.paymentPlan.maxInheritanceCount > 0
          : action.useInheritance !== false;
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
          const useInh = action.paymentPlan
            ? action.paymentPlan.inheritanceCardIds.length > 0 || action.paymentPlan.maxInheritanceCount > 0
            : action.useInheritance !== false;
          desc += useInh ? `（継召あり）` : `（継召なし）`;
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
      case 'activate_flash': {
        const source = action.sourceType === 'spirit' ? me.spirits[action.sourceIndex] : me.nexuses[action.sourceIndex];
        const eff = source?.def.effects?.find((e) => this.isActivatedFlashEffect(e));
        let desc = `【起動：フラッシュ】${source?.def.name ?? '?'}`;
        const costLabel = action.discardCardIndex !== undefined
          ? `${me.hand[action.discardCardIndex]?.name ?? '?'}を破棄`
          : eff?.costExhaustSelf ? '疲労させる' : 'コスト支払い';
        if (eff?.action === 'boost_bp') {
          const targetName = action.targetSpiritIndex !== undefined
            ? me.spirits[action.targetSpiritIndex]?.def.name
            : source?.def.name;
          desc += `（${costLabel} ▶ ${targetName ?? '?'}をBP+${eff.value ?? 0}）`;
        } else {
          desc += `（${costLabel} ▶ 効果発動）`;
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
      case 'select_inheritance': {
        if (!state.pendingInheritanceSelection) return '?';
        const selectedNames = state.pendingInheritanceSelection.inheritanceCandidates
          .filter(c => action.selectedCardIds.includes(c.id))
          .map(c => c.name);
        return `${state.pendingInheritanceSelection.cardName}: EXカード${selectedNames.length}枚を除外（${selectedNames.join('、')}）`;
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
    pendingInheritanceSelection: state.pendingInheritanceSelection
      ? {
          player: state.pendingInheritanceSelection.player,
          cardHandIndex: state.pendingInheritanceSelection.cardHandIndex,
          cardName: state.pendingInheritanceSelection.cardName,
          maxInheritanceCount: state.pendingInheritanceSelection.maxInheritanceCount,
          selectedInheritanceCount: state.pendingInheritanceSelection.selectedInheritanceCount,
          inheritanceCandidates: state.pendingInheritanceSelection.inheritanceCandidates.slice(),
          selectedCardIds: state.pendingInheritanceSelection.selectedCardIds.slice(),
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
    excludedCards: (p.excludedCards || []).slice(),
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
