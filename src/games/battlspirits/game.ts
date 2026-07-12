import type { Game, Rng } from '../../core/game.js';
import { CARD_DB, getStarterDeck } from './cards.js';
import type { Action, GameState, Nexus, Spirit, PlayerState } from './types.js';
import { applyEffect, triggerEffects } from './effects.js';

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
    const next = cloneState(state);
    const p = next.players[next.currentPlayer]!;
    // Recover cores: 1 per nexus on field (minimum 1)
    const coreRecover = Math.max(1, p.nexuses.length);
    p.cores = Math.min(p.cores + coreRecover, 20); // Cap at 20
    // Draw 1 card
    if (p.deck.length > 0) {
      const card = p.deck.shift()!;
      p.hand.push(card);
    }
    // Refresh all ready spirits (can attack next turn)
    for (const spirit of p.spirits) {
      spirit.canAttack = true;
    }
    return next;
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

  legalActions(state: GameState): Action[] {
    if (state.result) return [];
    const actions: Action[] = [];
    const me = state.players[state.currentPlayer]!;

    // If there's a pending attack, defend or take damage
    if (state.pendingAttack) {
      // Can defend with ready spirits
      for (let i = 0; i < me.spirits.length; i++) {
        if (me.spirits[i]!.canAttack) {
          actions.push({ type: 'defend', spiritIndex: i });
        }
      }
      // Always can take damage
      actions.push({ type: 'take_damage' });
      return actions;
    }

    // If there's a pending flash opportunity, only flash or skip_flash actions are legal
    if (state.pendingFlash) {
      // Can activate flash magic cards
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i]!;
        if (card.cardType === 'magic') {
          const flashEffects = card.effects?.filter(e => e.isFlash) ?? [];
          if (flashEffects.length > 0) {
            actions.push({ type: 'flash', handIndex: i });
          }
        }
      }
      // Always can skip flash
      actions.push({ type: 'skip_flash' });
      return actions;
    }

    // Normal turn actions
    // Summon spirits (any card in hand that is spirit)
    for (let i = 0; i < me.hand.length; i++) {
      if (me.hand[i]!.cardType === 'spirit') {
        actions.push({ type: 'summon', handIndex: i });
      }
    }

    // Place nexuses
    for (let i = 0; i < me.hand.length; i++) {
      if (me.hand[i]!.cardType === 'nexus') {
        actions.push({ type: 'place_nexus', handIndex: i });
      }
    }

    // Use magic
    for (let i = 0; i < me.hand.length; i++) {
      if (me.hand[i]!.cardType === 'magic') {
        actions.push({ type: 'use_magic', handIndex: i });
      }
    }

    // Attack with spirits
    for (let i = 0; i < me.spirits.length; i++) {
      actions.push({ type: 'attack', spiritIndex: i });
    }

    // Block with spirits (if any ready)
    for (let i = 0; i < me.spirits.length; i++) {
      if (me.spirits[i]!.canAttack) {
        actions.push({ type: 'block', spiritIndex: i });
      }
    }

    // Always can pass
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
      next = triggerEffects(next, 'immediate', card, next.currentPlayer);
      next.pendingFlash = null; // Clear flash opportunity after resolving
      return next;
    }

    if (action.type === 'skip_flash') {
      // Just clear the pending flash and continue
      next.pendingFlash = null;
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

      // Resolve battle
      if (attackBP > defendBP) {
        // Attacker wins: destroy defender
        me.spirits.splice(action.spiritIndex, 1);
        next = triggerEffects(next, 'destroy', defender.def, next.currentPlayer);
      } else if (attackBP < defendBP) {
        // Defender wins: destroy attacker
        const attackerPlayer = next.players[next.pendingAttack.attackerPlayer]!;
        attackerPlayer.spirits.splice(next.pendingAttack.attackerSpiritIndex, 1);
        next = triggerEffects(next, 'destroy', attacker.def, 1 - next.currentPlayer);
      } else {
        // Equal BP: both destroyed
        me.spirits.splice(action.spiritIndex, 1);
        next.players[next.pendingAttack.attackerPlayer]!.spirits.splice(next.pendingAttack.attackerSpiritIndex, 1);
        next = triggerEffects(next, 'destroy', defender.def, next.currentPlayer);
        next = triggerEffects(next, 'destroy', attacker.def, 1 - next.currentPlayer);
      }

      // Trigger battle_end effects
      next = triggerEffects(next, 'battle_end', attacker.def, 1 - next.currentPlayer);
      next = triggerEffects(next, 'battle_end', defender.def, next.currentPlayer);

      next.pendingAttack = null;
      next.currentPlayer = 1 - next.currentPlayer; // Return turn to original player
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

        // Check if player has enough cores
        if (actualCost > me.cores) return next;

        // Pay cost
        me.hand.splice(action.handIndex, 1);
        me.cores -= actualCost;

        // Place spirit with required Lv1 cores
        const spirit: any = {
          def: card,
          level: 1,
          coreCount: card.lv1.cost,
          canAttack: false, // Newly summoned spirits can't attack this turn
          bpBoost: 0,
        };
        me.spirits.push(spirit);

        // Trigger summon effects
        next = triggerEffects(next, 'summon', card, next.currentPlayer, spirit);
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

        // Trigger magic effects
        next = triggerEffects(next, 'immediate', card, next.currentPlayer);
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
        // Trigger end-of-turn effects for current player
        const currentPlayer = next.players[next.currentPlayer]!;
        for (const spirit of currentPlayer.spirits) {
          next = triggerEffects(next, 'end_step', spirit.def, next.currentPlayer, spirit);
        }
        for (const nexus of currentPlayer.nexuses) {
          next = triggerEffects(next, 'end_step', nexus.def, next.currentPlayer);
        }

        // Move to next turn
        next.currentPlayer = 1 - next.currentPlayer;
        next.turnCount++;
        next = this.startTurn(next);
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
        // Check if opponent has any flash cards
        const opponentHasFlash = opponent.hand.some(
          (c) => c.cardType === 'magic' && c.effects?.some((e) => e.isFlash)
        );

        if (opponentHasFlash) {
          // Give opponent flash opportunity
          next.pendingFlash = {
            trigger: trigger as any,
            cardId: '', // Not tracking specific card here
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
      case 'place_nexus': return `N${action.handIndex}`;
      case 'use_magic': return `M${action.handIndex}`;
      case 'attack': return `A${action.spiritIndex}`;
      case 'block': return `B${action.spiritIndex}`;
      case 'defend': return `D${action.spiritIndex}`;
      case 'take_damage': return 'TD';
      case 'pass': return 'P';
      case 'flash': return `F${action.handIndex}`;
      case 'skip_flash': return 'SF';
      default: return '?';
    }
  }

  describeAction(state: GameState, action: Action): string {
    const me = state.players[state.currentPlayer]!;
    switch (action.type) {
      case 'summon': {
        const card = me.hand[action.handIndex];
        return `Summon ${card?.name ?? '?'}`;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        return `Place ${card?.name ?? '?'}`;
      }
      case 'use_magic': {
        const card = me.hand[action.handIndex];
        return `Use ${card?.name ?? '?'}`;
      }
      case 'attack': {
        const spirit = me.spirits[action.spiritIndex];
        return `${spirit?.def.name ?? '?'} attacks`;
      }
      case 'block': {
        const spirit = me.spirits[action.spiritIndex];
        return `${spirit?.def.name ?? '?'} blocks`;
      }
      case 'defend': {
        const spirit = me.spirits[action.spiritIndex];
        return `${spirit?.def.name ?? '?'} defends`;
      }
      case 'take_damage': return 'Take damage';
      case 'pass': return 'End turn';
      case 'flash': {
        const card = me.hand[action.handIndex];
        return `Flash: ${card?.name ?? '?'}`;
      }
      case 'skip_flash': return 'Skip flash';
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
    spirits: p.spirits.map((s: any) => ({ ...s, bpBoost: s.bpBoost ?? 0, placedCores: s.placedCores ?? 0 })),
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
