import type { Game, Rng } from '../../core/game.js';
import { CARD_DB, getStarterDeck } from './cards.js';
import type { Action, GameState, Nexus, Spirit, PlayerState } from './types.js';
import { applyEffect, triggerEffects, destroySpirit, removeDeadSpirit, updateSpiritLevel } from './effects.js';

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
  let reductionRemaining = card.reductionCost;

  // Reduce cost from field symbols
  for (const sym of fieldSymbols) {
    if (reductionRemaining <= 0) break;
    const canReduce = card.reductionCost > 0 && card.symbolColors?.includes(sym.color);
    if (canReduce) {
      const reduce = Math.min(sym.count, reductionRemaining);
      cost = Math.max(0, cost - reduce);
      reductionRemaining -= reduce;
    }
  }

  // If card has inheritance, can use EX symbols from trash
  if (hasInheritance && reductionRemaining > 0 && hasEXSymbolsInTrash) {
    cost = Math.max(0, cost - reductionRemaining);
  }

  return Math.max(0, cost);
}

export class BattlSpiritsGame implements Game<GameState, Action> {
  readonly playerCount = 2;

  createInitialState(rng: Rng): GameState {
    const players: [any, any] = [this.newPlayer(rng), this.newPlayer(rng)];
    const state: GameState = {
      players: players as [any, any],
      currentPlayer: 0,
      turnCount: 0,
      phase: 'start',
      battle: null,
      result: null,
    };
    // Draw 4 cards each
    for (const p of players) {
      for (let i = 0; i < 4; i++) {
        const card = p.deck.shift();
        if (card) p.hand.push(card);
      }
    }
    // Start first turn
    return this.startTurn(state);
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
          // Standard draw phase: draw 1 card
          const p = next.players[next.currentPlayer]!;
          if (p.deck.length === 0) {
            next.result = { winner: 1 - next.currentPlayer };
            return next;
          }
          const card = p.deck.shift()!;
          p.hand.push(card);
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

  /** Remove all spirits that have 0 cores (not destruction, no effects triggered) */
  private removeDeadSpirits(player: PlayerState): void {
    for (let i = player.spirits.length - 1; i >= 0; i--) {
      const spirit = player.spirits[i]!;
      if (spirit.coreCount === 0 && spirit.soulCoreCount === 0) {
        removeDeadSpirit(player, i);
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

  /** Does the player have a flash magic card they can actually afford? */
  private hasAffordableFlash(player: PlayerState): boolean {
    const totalCores = this.getTotalAvailableCores(player);
    return player.hand.some(
      (c) =>
        c.cardType === 'magic' &&
        c.effects?.some((e) => e.isFlash) &&
        this.effectiveCost(player, c) <= totalCores,
    );
  }

  legalActions(state: GameState): Action[] {
    if (state.result) return [];

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
          actions.push({ type: 'defend', spiritIndex: i });
        }
      }
      // Always can take damage
      actions.push({ type: 'take_damage' });
      return actions;
    }

    // If there's a pending flash opportunity, only flash or skip_flash actions are legal
    if (state.pendingFlash) {
      const me = state.players[state.currentPlayer]!;
      const totalCores = this.getTotalAvailableCores(me);
      const actions: Action[] = [];
      // Can activate flash magic cards (only if affordable)
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i]!;
        if (card.cardType === 'magic') {
          const flashEffects = card.effects?.filter(e => e.isFlash) ?? [];
          if (flashEffects.length > 0 && this.effectiveCost(me, card) <= totalCores) {
            actions.push({ type: 'flash', handIndex: i });
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
        // Summon only needs the card's cost (Lv1 placement is a separate action)
        actions.push({ type: 'summon', handIndex: i });
      } else if (card.cardType === 'nexus') {
        actions.push({ type: 'place_nexus', handIndex: i });
      } else if (card.cardType === 'magic') {
        // Check if card has effects with requiresTarget
        const hasTargetEffect = card.effects?.some((e) => e.requiresTarget) ?? false;
        // Check if card has effects with variableValue
        const hasVariableEffect = card.effects?.some((e) => e.variableValue) ?? false;

        if (hasTargetEffect) {
          // Generate targeting actions for opponent spirits
          const opponent = state.players[1 - state.currentPlayer]!;
          for (let t = 0; t < opponent.spirits.length; t++) {
            actions.push({ type: 'use_magic', handIndex: i, targetSpiritIndex: t });
          }
        } else if (hasVariableEffect) {
          // Generate variable value actions (0 to max, typically hand size or some reasonable max)
          const maxValue = Math.min(me.hand.length, 5); // Reasonable max for discards
          for (let v = 0; v <= maxValue; v++) {
            actions.push({ type: 'use_magic', handIndex: i, effectValue: v });
          }
        } else {
          // No targeting or variable values needed
          actions.push({ type: 'use_magic', handIndex: i });
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

    // Attack with ready (non-fatigued) spirits only
    for (let i = 0; i < me.spirits.length; i++) {
      const s = me.spirits[i]!;
      if (s.canAttack && !s.cannotAttackUntilNextTurn) {
        // Check if this spirit has a discard_hand effect that requires card selection
        const discardEffect = s.def.effects?.find(
          (e) => e.trigger === 'attack' && e.action === 'discard_hand' && e.level?.includes(s.level)
        );

        if (discardEffect) {
          // Find cards in hand that match the discard effect symbol
          const targetSymbol = discardEffect.symbol;
          const validCardIndices: number[] = [];
          for (let j = 0; j < me.hand.length; j++) {
            const card = me.hand[j]!;
            if (!targetSymbol || card.symbolColors.includes(targetSymbol)) {
              validCardIndices.push(j);
            }
          }

          if (validCardIndices.length > 0) {
            // Generate one attack action for each valid card choice
            for (const cardIndex of validCardIndices) {
              actions.push({ type: 'attack', spiritIndex: i, discardCardIndex: cardIndex });
            }
          } else {
            // No valid cards to discard - can still attack but effect won't trigger
            actions.push({ type: 'attack', spiritIndex: i });
          }
        } else {
          // No discard requirement - normal attack
          actions.push({ type: 'attack', spiritIndex: i });
        }
      }
    }

    // Always can pass to Main2
    actions.push({ type: 'pass' });

    return actions;
  }

  applyAction(state: GameState, action: Action, _rng: Rng): GameState {
    let next = cloneState(state);
    const me = next.players[next.currentPlayer]!;
    const opponent = next.players[1 - next.currentPlayer]!;

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
      this.removeDeadSpirits(me); // Remove spirits that reached 0 cores
      me.trash.push(card);
      next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue);
      checkResult(next);
      if (next.result) return next;

      // Give opponent counter-timing (stack flash opportunity)
      const opponentHasFlash = this.hasAffordableFlash(opponent);

      if (opponentHasFlash) {
        // Keep same flash trigger, but update for counter timing
        next.pendingFlash = {
          trigger: next.pendingFlash!.trigger,
          cardId: '',
          initiatingPlayer: next.pendingFlash!.initiatingPlayer,
          lastFlashPlayer: next.currentPlayer,
        };
        // Switch to opponent for counter-timing
        next.currentPlayer = 1 - next.currentPlayer;
        return next;
      }

      // No counter-timing available: resolve the original action
      next.pendingFlash = null;
      // Return to original player to complete the action
      if (next.pendingFlash === null) {
        next.currentPlayer = 1 - next.currentPlayer;
      }
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

      // No more flash opportunity: clear and return to original player
      next.pendingFlash = null;
      next.currentPlayer = 1 - next.currentPlayer;
      checkResult(next);
      return next;
    }

    // Handle attack defense
    if (action.type === 'defend') {
      const defender = me.spirits[action.spiritIndex];
      if (!defender || !next.pendingAttack) return next;

      const attacker = next.players[next.pendingAttack.attackerPlayer]!.spirits[next.pendingAttack.attackerSpiritIndex]!;
      const attackerStats = attacker.level === 1 ? attacker.def.lv1 : attacker.def.lv2 || attacker.def.lv1;
      const attackBP = attackerStats.bp + (attacker.bpBoost ?? 0);

      const defenderStats = defender.level === 1 ? defender.def.lv1 : defender.def.lv2 || defender.def.lv1;
      const defendBP = defenderStats.bp + (defender.bpBoost ?? 0);

      // Both spirits become fatigued
      defender.canAttack = false;
      attacker.canAttack = false;

      // Resolve battle (destroyed spirits go to trash; their cores return to reserve)
      if (attackBP > defendBP) {
        // Attacker wins: destroy defender
        destroySpirit(me, action.spiritIndex);
        next = triggerEffects(next, 'destroy', defender.def, next.currentPlayer);
      } else if (attackBP < defendBP) {
        // Defender wins: destroy attacker
        const attackerPlayer = next.players[next.pendingAttack.attackerPlayer]!;
        destroySpirit(attackerPlayer, next.pendingAttack.attackerSpiritIndex);
        next = triggerEffects(next, 'destroy', attacker.def, 1 - next.currentPlayer);
      } else {
        // Equal BP: both destroyed
        destroySpirit(me, action.spiritIndex);
        destroySpirit(next.players[next.pendingAttack.attackerPlayer]!, next.pendingAttack.attackerSpiritIndex);
        next = triggerEffects(next, 'destroy', defender.def, next.currentPlayer);
        next = triggerEffects(next, 'destroy', attacker.def, 1 - next.currentPlayer);
      }

      // Trigger battle_end effects
      next = triggerEffects(next, 'battle_end', attacker.def, 1 - next.currentPlayer);
      next = triggerEffects(next, 'battle_end', defender.def, next.currentPlayer);

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
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);
        const totalCost = actualCost + card.lv1.cost;

        // Check if player has enough cores (including from spirits)
        const totalAvailable = this.getTotalAvailableCores(me);
        if (totalAvailable < totalCost) return next;

        // Pay cost (to trash) using specified regular/soul core distribution
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, totalCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        this.removeDeadSpirits(me); // Remove spirits that reached 0 cores

        // Place Lv1 cores on the spirit (always from regular cores)
        const spirit: any = {
          def: card,
          level: 1,
          coreCount: card.lv1.cost,
          soulCoreCount: 0,
          canAttack: true,
          bpBoost: 0,
        };
        updateSpiritLevel(spirit);
        me.spirits.push(spirit);

        // Trigger summon effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer, spirit);
        break;
      }
      case 'add_core': {
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

          // Place 1 core on nexus
          if (action.coreType === 'soul') {
            if (me.soulCores > 0) {
              me.soulCores -= 1;
              nexus.coreCount += 1;
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
              nexus.coreCount += 1;
            }
          }
          updateSpiritLevel(nexus); // Update nexus level if applicable
        }
        break;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return next;

        // Calculate cost after reductions
        const fieldSymbols = this.getFieldSymbols(me);
        const hasEXInTrash = me.trash.some((c) => c.exSymbol);
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);

        // Check if player has enough cores (including from spirits)
        const totalAvailable = this.getTotalAvailableCores(me);
        if (actualCost > totalAvailable) return next;

        // Pay cost using specified regular/soul core distribution
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        this.removeDeadSpirits(me); // Remove spirits that reached 0 cores

        // Place nexus
        const nexus: Nexus = {
          def: card,
          level: 1,
          coreCount: Math.max(0, card.lv1.cost),
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
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);

        // Check if player has enough cores (including from spirits)
        const totalAvailable = this.getTotalAvailableCores(me);
        if (actualCost > totalAvailable) return next;

        // Pay cost using specified regular/soul core distribution
        me.hand.splice(action.handIndex, 1);
        this.payCost(me, actualCost, action.paidRegularCores, action.paidSoulCores, action.coreType);
        this.removeDeadSpirits(me); // Remove spirits that reached 0 cores
        me.trash.push(card);

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

          // Identify 風牙 lineage cards (excluding オファーリングドロー) as selectable (max 2)
          const selectableIndices: number[] = [];
          for (let i = 0; i < openedCards.length; i++) {
            const c = openedCards[i];
            const hasWindFangLineage = c.lineage && c.lineage.includes('風牙');
            const isNotOfferingDraw = c.id !== 'magic_offering_draw';
            if (hasWindFangLineage && isNotOfferingDraw) {
              selectableIndices.push(i);
            }
          }

          // Set pending draw for player to select and arrange cards
          // Player can select up to 2 from selectableIndices
          next.pendingDraw = {
            openedCards,
            toHandIndices: [], // Will be filled by player selection
            toRearrangeIndices: [], // Will be filled by player selection
            selectableIndices, // Cards that can be selected for hand (風牙 lineage)
          };
          return next; // Stop here, player must select cards
        }

        // Trigger magic effects with optional target and value
        next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue);
        // Fall through to flash checking below
        break;
      }
      case 'attack': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || !spirit.canAttack) return next;

        // Trigger attack effects (may boost BP), passing discardCardIndex if provided
        next = triggerEffects(next, 'attack', spirit.def, next.currentPlayer, spirit, undefined, undefined, action.discardCardIndex);

        // Create pending attack opportunity for opponent to defend
        const damage = spirit.def.symbolCount;
        next.pendingAttack = {
          attackerPlayer: next.currentPlayer,
          attackerSpiritIndex: action.spiritIndex,
          damage: damage,
        };

        // Switch to opponent to handle defense
        next.currentPlayer = 1 - next.currentPlayer;
        return next;
      }
      case 'block': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || !spirit.canAttack) return next;
        // Block triggers effects on the blocking spirit
        next = triggerEffects(next, 'block', spirit.def, next.currentPlayer, spirit);
        break;
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

        // Put rearranged cards back to deck bottom in specified order
        for (const idx of arrangedIndices) {
          me.deck.push(pd.openedCards[idx]!);
        }

        // Remaining cards go to trash
        const usedIndices = new Set([...selectedIndices, ...arrangedIndices]);
        for (let i = 0; i < pd.openedCards.length; i++) {
          if (!usedIndices.has(i)) {
            me.trash.push(pd.openedCards[i]!);
          }
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
            for (const spirit of currentPlayer.spirits) {
              next = triggerEffects(next, 'end_step', spirit.def, next.currentPlayer, spirit);
            }
            for (const nexus of currentPlayer.nexuses) {
              next = triggerEffects(next, 'end_step', nexus.def, next.currentPlayer);
            }
            checkResult(next);
            if (next.result) return next;

            // Reset BP boosts
            for (const p of next.players) {
              for (const s of p.spirits) {
                s.bpBoost = 0;
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
          for (const spirit of currentPlayer.spirits) {
            next = triggerEffects(next, 'end_step', spirit.def, next.currentPlayer, spirit);
          }
          for (const nexus of currentPlayer.nexuses) {
            next = triggerEffects(next, 'end_step', nexus.def, next.currentPlayer);
          }
          checkResult(next);
          if (next.result) return next;

          // Temporary BP boosts ("this turn only") expire at end of turn
          for (const p of next.players) {
            for (const s of p.spirits) {
              s.bpBoost = 0;
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
      case 'place_nexus': return `N${action.handIndex}`;
      case 'use_magic': {
        let key = `M${action.handIndex}`;
        if (action.targetSpiritIndex !== undefined) key += `T${action.targetSpiritIndex}`;
        if (action.effectValue !== undefined) key += `V${action.effectValue}`;
        return key;
      }
      case 'attack': return `A${action.spiritIndex}`;
      case 'block': return `B${action.spiritIndex}`;
      case 'defend': return `D${action.spiritIndex}`;
      case 'take_damage': return 'TD';
      case 'pass': return 'P';
      case 'flash': {
        let key = `F${action.handIndex}`;
        if (action.targetSpiritIndex !== undefined) key += `T${action.targetSpiritIndex}`;
        if (action.effectValue !== undefined) key += `V${action.effectValue}`;
        return key;
      }
      case 'skip_flash': return 'SF';
      default: return '?';
    }
  }

  describeAction(state: GameState, action: Action): string {
    const me = state.players[state.currentPlayer]!;
    switch (action.type) {
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
        return `${spirit?.def.name ?? '?'}でアタック`;
      }
      case 'block': {
        const spirit = me.spirits[action.spiritIndex];
        return `${spirit?.def.name ?? '?'}でブロック`;
      }
      case 'defend': {
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
          const opponent = state.players[1 - state.currentPlayer]!;
          const target = opponent.spirits[action.targetSpiritIndex];
          desc += `（対象: ${target?.def.name ?? '?'}）`;
        }
        if (action.effectValue !== undefined) {
          desc += `（値: ${action.effectValue}）`;
        }
        return desc;
      }
      case 'skip_flash': return 'フラッシュを使わない';
      case 'select_draw_arrange': {
        if (!state.pendingDraw) return 'オファーリングドロー';
        const selectedIndices = action.selectedCardIndices || [];
        const selectedCards = selectedIndices.map(idx => state.pendingDraw!.openedCards[idx]!.name).join(', ');
        return `オファーリングドロー: ${selectedCards || 'なし'}を手札に加える`;
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
    pendingFlash: state.pendingFlash ? { ...state.pendingFlash } : null,
    pendingAttack: state.pendingAttack ? { ...state.pendingAttack } : null,
    pendingDraw: state.pendingDraw
      ? {
          openedCards: state.pendingDraw.openedCards.slice(),
          toHandIndices: state.pendingDraw.toHandIndices.slice(),
          toRearrangeIndices: state.pendingDraw.toRearrangeIndices.slice(),
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
    nexuses: p.nexuses.map((n: any) => ({ ...n, placedCores: n.placedCores ?? 0 })),
    trash: p.trash.slice(),
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
