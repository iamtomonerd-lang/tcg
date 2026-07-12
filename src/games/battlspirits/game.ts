import type { Game, Rng } from '../../core/game.js';
import { CARD_DB, getStarterDeck } from './cards.js';
import type { Action, GameState, Nexus, Spirit, PlayerState } from './types.js';
import { applyEffect, triggerEffects, destroySpirit, updateSpiritLevel } from './effects.js';

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
      life: 20,
      cores: 3, // starting reserve cores
      hand: [],
      deck,
      spirits: [],
      nexuses: [],
      trash: [],
    };
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
          // Recover cores: 1 per nexus on field (minimum 1)
          const p = next.players[next.currentPlayer]!;
          const coreRecover = Math.max(1, p.nexuses.length);
          p.cores = Math.min(p.cores + coreRecover, 20); // Cap at 20
          next.phase = 'draw';
          break;
        }
        case 'draw': {
          // Draw 1 card; if the deck is empty, the player loses (deck-out)
          const p = next.players[next.currentPlayer]!;
          if (p.deck.length > 0) {
            const card = p.deck.shift()!;
            p.hand.push(card);
          } else {
            next.result = { winner: 1 - next.currentPlayer };
            return next;
          }
          next.phase = 'refresh';
          break;
        }
        case 'refresh': {
          // Refresh all spirits (can attack this turn)
          const p = next.players[next.currentPlayer]!;
          // Return placed cores to reserve; reset spirits to Lv1
          for (const spirit of p.spirits) {
            p.cores += spirit.coreCount; // Return all cores to reserve
            spirit.coreCount = 0;
            spirit.level = 1; // Reset to Lv1
            spirit.canAttack = true;
            // Clear persistent status effects
            spirit.cannotAttackUntilNextTurn = false;
            spirit.cannotDefendUntilNextTurn = false;
          }
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

  currentPlayer(state: GameState): number {
    return state.currentPlayer;
  }

  /** Cost the player would actually pay for this card right now. */
  private effectiveCost(player: PlayerState, card: any): number {
    const fieldSymbols = this.getFieldSymbols(player);
    const hasEXInTrash = player.trash.some((c) => c.exSymbol);
    return calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);
  }

  /** Does the player have a flash magic card they can actually afford? */
  private hasAffordableFlash(player: PlayerState): boolean {
    return player.hand.some(
      (c) =>
        c.cardType === 'magic' &&
        c.effects?.some((e) => e.isFlash) &&
        this.effectiveCost(player, c) <= player.cores,
    );
  }

  legalActions(state: GameState): Action[] {
    if (state.result) return [];

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
      const actions: Action[] = [];
      // Can activate flash magic cards (only if affordable)
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i]!;
        if (card.cardType === 'magic') {
          const flashEffects = card.effects?.filter(e => e.isFlash) ?? [];
          if (flashEffects.length > 0 && this.effectiveCost(me, card) <= me.cores) {
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

    // Normal turn actions: only offer cards the player can actually pay for
    for (let i = 0; i < me.hand.length; i++) {
      const card = me.hand[i]!;
      if (this.effectiveCost(me, card) > me.cores) continue;

      if (card.cardType === 'spirit') {
        // Summoning also requires placing the Lv1 maintenance cores from reserve
        if (this.effectiveCost(me, card) + card.lv1.cost > me.cores) continue;
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

    // Place a core from reserve onto a spirit (level-up); only useful below Lv2
    if (me.cores > 0) {
      for (let i = 0; i < me.spirits.length; i++) {
        const s = me.spirits[i]!;
        if (s.def.lv2 && s.coreCount < s.def.lv2.cost) {
          actions.push({ type: 'add_core', spiritIndex: i });
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
        actions.push({ type: 'attack', spiritIndex: i });
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

      if (actualCost > me.cores) return next;

      // Use the magic card as flash
      me.hand.splice(action.handIndex, 1);
      me.cores -= actualCost;
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

      // Take damage
      me.life -= next.pendingAttack.damage;

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

        // Player must pay the summon cost AND place Lv1 cores from reserve
        if (actualCost + card.lv1.cost > me.cores) return next;

        // Pay cost (to void) and move Lv1 cores from reserve onto the spirit
        me.hand.splice(action.handIndex, 1);
        me.cores -= actualCost + card.lv1.cost;

        const spirit: any = {
          def: card,
          level: 1,
          coreCount: card.lv1.cost,
          canAttack: true, // Newly summoned spirits are in refresh state
          bpBoost: 0,
        };
        updateSpiritLevel(spirit);
        me.spirits.push(spirit);

        // Trigger summon effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer, spirit);
        break;
      }
      case 'add_core': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || me.cores <= 0) return next;
        me.cores -= 1;
        spirit.coreCount += 1;
        updateSpiritLevel(spirit);
        break;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return next;

        // Calculate cost after reductions
        const fieldSymbols = this.getFieldSymbols(me);
        const hasEXInTrash = me.trash.some((c) => c.exSymbol);
        const actualCost = calculateCostAfterReduction(card, fieldSymbols, hasEXInTrash, !!card.inheritance);

        // Check if player has enough cores
        if (actualCost > me.cores) return next;

        // Pay cost
        me.hand.splice(action.handIndex, 1);
        me.cores -= actualCost;

        // Place nexus
        const nexus: Nexus = {
          def: card,
          level: card.lv1.cost === 0 ? 1 : 1, // Normally Lv1, but needs cores if cost > 0
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

        // Check if player has enough cores
        if (actualCost > me.cores) return next;

        // Pay cost
        me.hand.splice(action.handIndex, 1);
        me.cores -= actualCost;
        me.trash.push(card);

        // Trigger magic effects with optional target and value
        next = triggerEffects(next, 'immediate', card, next.currentPlayer, undefined, action.targetSpiritIndex, action.effectValue);
        break;
      }
      case 'attack': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || !spirit.canAttack) return next;

        // Trigger attack effects (may boost BP)
        next = triggerEffects(next, 'attack', spirit.def, next.currentPlayer, spirit);

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
      case 'pass': {
        // Handle phase transitions based on current phase
        if (next.phase === 'main') {
          // Transition from Main to Attack
          next.phase = 'attack';
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

    // Create flash opportunity for opponent (unless pass or already have pending flash)
    const actionTypeStr = (action as any).type;
    if (!next.pendingFlash && actionTypeStr !== 'pass' && actionTypeStr !== 'flash' && actionTypeStr !== 'skip_flash') {
      const flashTriggerMap: { [key: string]: any } = {
        'summon': 'opponent_summon',
        'place_nexus': 'opponent_summon',
        'use_magic': 'opponent_magic',
        'attack': 'opponent_attack',
        'block': undefined, // block doesn't trigger flash
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
      case 'add_core': return `C${action.spiritIndex}`;
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
        const total = card ? this.effectiveCost(me, card) + card.lv1.cost : 0;
        return `${card?.name ?? '?'}を召喚（コア${total}個）`;
      }
      case 'add_core': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit) return '?にコア配置';
        const need = spirit.def.lv2 ? spirit.def.lv2.cost - spirit.coreCount : 0;
        return `${spirit.def.name}にコア配置（Lv2まであと${need}個）`;
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
  };
}

function clonePlayer(p: any) {
  return {
    life: p.life,
    cores: p.cores,
    hand: p.hand.slice(),
    deck: p.deck.slice(),
    spirits: p.spirits.map((s: any) => ({ ...s, bpBoost: s.bpBoost ?? 0 })),
    nexuses: p.nexuses.map((n: any) => ({ ...n, placedCores: n.placedCores ?? 0 })),
    trash: p.trash.slice(),
  };
}

function checkResult(state: GameState): void {
  if (state.result) return;
  const l0 = state.players[0]!.life;
  const l1 = state.players[1]!.life;
  if (l0 <= 0 && l1 <= 0) state.result = { winner: null };
  else if (l1 <= 0) state.result = { winner: 0 };
  else if (l0 <= 0) state.result = { winner: 1 };
}
