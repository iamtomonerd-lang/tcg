import type { Game, Rng } from '../../core/game.js';
import { CARD_DB, getStarterDeck } from './cards.js';
import type { Action, GameState, Nexus, Spirit } from './types.js';
import { applyEffect, triggerEffects } from './effects.js';

/**
 * Battle Spirits Phase 1: simplified rules.
 * Tur: Start (draw) → Main (summon/place/use) → Attack → End
 * (First turn skips core step; simplified for now)
 */
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
    // Draw 1 card
    if (p.deck.length > 0) {
      const card = p.deck.shift()!;
      p.hand.push(card);
    }
    return next;
  }

  currentPlayer(state: GameState): number {
    return state.currentPlayer;
  }

  legalActions(state: GameState): Action[] {
    if (state.result) return [];
    // In phase 1, keep it simple: can summon, place nexus, use magic, attack, or pass.
    // For now: return all possible actions; actual validation in applyAction.
    const actions: Action[] = [];
    const me = state.players[state.currentPlayer]!;

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

    switch (action.type) {
      case 'summon': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'spirit') return next;
        if (card.cost > me.cores) return next;
        me.hand.splice(action.handIndex, 1);
        me.cores -= card.cost;
        const spirit: any = {
          def: card,
          level: 1,
          coreCount: card.lv1.cost,
          canAttack: true,
          bpBoost: 0,
        };
        me.spirits.push(spirit);
        next = triggerEffects(next, 'summon', card, next.currentPlayer, spirit);
        break;
      }
      case 'place_nexus': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'nexus') return next;
        if (card.cost > me.cores) return next;
        me.hand.splice(action.handIndex, 1);
        me.cores -= card.cost;
        const nexus: Nexus = {
          def: card,
          level: 1,
          coreCount: card.lv1.cost,
        };
        me.nexuses.push(nexus);
        next = triggerEffects(next, 'summon', card, next.currentPlayer);
        break;
      }
      case 'use_magic': {
        const card = me.hand[action.handIndex];
        if (!card || card.cardType !== 'magic') return next;
        if (card.cost > me.cores) return next;
        me.hand.splice(action.handIndex, 1);
        me.cores -= card.cost;
        next = triggerEffects(next, 'immediate', card, next.currentPlayer);
        break;
      }
      case 'attack': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || !spirit.canAttack) return next;
        spirit.canAttack = false;
        // Trigger attack effects first (may boost BP)
        next = triggerEffects(next, 'attack', spirit.def, next.currentPlayer, spirit);
        // Phase 1 simplified: direct damage equal to spirit's BP + any boost
        const stats = spirit.level === 1 ? spirit.def.lv1 : spirit.def.lv2 || spirit.def.lv1;
        const totalBP = stats.bp + (spirit.bpBoost ?? 0);
        next.players[1 - next.currentPlayer]!.life -= totalBP;
        break;
      }
      case 'block': {
        const spirit = me.spirits[action.spiritIndex];
        if (!spirit || !spirit.canAttack) return next;
        // Block triggers effects on the blocking spirit
        next = triggerEffects(next, 'block', spirit.def, next.currentPlayer, spirit);
        break;
      }
      case 'pass': {
        next.currentPlayer = 1 - next.currentPlayer;
        next.turnCount++;
        next = this.startTurn(next);
        return next;
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
      case 'pass': return 'P';
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
      case 'pass': return 'End turn';
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
  };
}

function clonePlayer(p: any) {
  return {
    life: p.life,
    cores: p.cores,
    hand: p.hand.slice(),
    deck: p.deck.slice(),
    spirits: p.spirits.map((s: any) => ({ ...s, bpBoost: s.bpBoost ?? 0 })),
    nexuses: p.nexuses.map((n: any) => ({ ...n })),
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
