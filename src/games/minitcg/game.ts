import type { Game, Rng } from '../../core/game.js';
import { CARD_DB, STARTER_DECK, type CardDef } from './cards.js';
import {
  BOARD_LIMIT,
  HAND_LIMIT,
  MAX_MANA,
  STARTING_HAND,
  STARTING_LIFE,
  TURN_CAP,
  type Creature,
  type MiniAction,
  type MiniState,
  type PlayerState,
  type Target,
} from './state.js';

/**
 * MiniTCG rules engine. Implements the game-agnostic `Game` interface so any
 * agent in `src/ai` can play it.
 *
 * Rules in brief:
 *  - Two players, 20 life each. Reduce the opponent to 0 to win.
 *  - Each turn: max mana +1 (cap 10), refill mana, draw a card, then take as
 *    many actions as you can afford (play cards / attack) before ending.
 *  - Creatures have summoning sickness (can't attack the turn they are played).
 *  - Drawing from an empty deck deals escalating fatigue damage.
 */
export class MiniTcg implements Game<MiniState, MiniAction> {
  readonly playerCount = 2;

  createInitialState(rng: Rng): MiniState {
    const players: [PlayerState, PlayerState] = [
      this.newPlayer(rng),
      this.newPlayer(rng),
    ];
    for (const p of players) {
      for (let i = 0; i < STARTING_HAND; i++) draw(p);
    }
    // Player 0 starts their first turn (mana up + draw).
    const state: MiniState = { players, active: 0, turnCount: 0, result: null };
    beginTurn(state.players[0]);
    return state;
  }

  private newPlayer(rng: Rng): PlayerState {
    const deck = STARTER_DECK.map((id) => CARD_DB[id]!);
    rng.shuffle(deck);
    return {
      life: STARTING_LIFE,
      mana: 0,
      maxMana: 0,
      hand: [],
      deck,
      board: [],
      fatigue: 0,
    };
  }

  currentPlayer(state: MiniState): number {
    return state.active;
  }

  isTerminal(state: MiniState): boolean {
    return state.result !== null;
  }

  reward(state: MiniState, player: number): number {
    const winner = state.result?.winner ?? null;
    if (winner === null) return 0.5; // draw or not-yet-terminal
    return winner === player ? 1 : 0;
  }

  legalActions(state: MiniState): MiniAction[] {
    if (state.result) return [];
    const me = state.active;
    const p = state.players[me]!;
    const opp = state.players[1 - me]!;
    const actions: MiniAction[] = [];

    // Play cards from hand.
    for (let i = 0; i < p.hand.length; i++) {
      const card = p.hand[i]!;
      if (card.cost > p.mana) continue;
      if (card.type === 'creature') {
        if (p.board.length < BOARD_LIMIT) actions.push({ type: 'play', handIndex: i });
      } else {
        const effect = card.effect!;
        if (effect.kind === 'damage') {
          // Damage may target either hero or any creature.
          actions.push({ type: 'play', handIndex: i, target: { zone: 'hero', player: 1 - me } });
          actions.push({ type: 'play', handIndex: i, target: { zone: 'hero', player: me } });
          for (let side = 0; side < 2; side++) {
            const board = state.players[side]!.board;
            for (let j = 0; j < board.length; j++) {
              actions.push({ type: 'play', handIndex: i, target: { zone: 'creature', player: side, index: j } });
            }
          }
        } else {
          // heal / draw: no target choice.
          actions.push({ type: 'play', handIndex: i });
        }
      }
    }

    // Attack with ready creatures.
    for (let i = 0; i < p.board.length; i++) {
      const c = p.board[i]!;
      if (!c.canAttack || c.attack <= 0) continue;
      actions.push({ type: 'attack', attackerIndex: i, target: { zone: 'hero', player: 1 - me } });
      for (let j = 0; j < opp.board.length; j++) {
        actions.push({ type: 'attack', attackerIndex: i, target: { zone: 'creature', player: 1 - me, index: j } });
      }
    }

    actions.push({ type: 'end' });
    return actions;
  }

  applyAction(state: MiniState, action: MiniAction, _rng: Rng): MiniState {
    const next = cloneState(state);
    const me = next.active;
    const p = next.players[me]!;

    switch (action.type) {
      case 'play': {
        const card = p.hand[action.handIndex];
        if (!card || card.cost > p.mana) return next; // ignore illegal (shouldn't happen)
        p.hand.splice(action.handIndex, 1);
        p.mana -= card.cost;
        if (card.type === 'creature') {
          if (p.board.length < BOARD_LIMIT) {
            p.board.push({ def: card, attack: card.attack!, health: card.health!, canAttack: false });
          }
        } else {
          applySpell(next, me, card, action.target);
        }
        break;
      }
      case 'attack': {
        const attacker = p.board[action.attackerIndex];
        if (!attacker || !attacker.canAttack || attacker.attack <= 0) return next;
        resolveAttack(next, me, attacker, action.target);
        attacker.canAttack = false;
        break;
      }
      case 'end': {
        endTurn(next);
        break;
      }
    }

    cleanupDead(next);
    checkResult(next);
    return next;
  }

  determinize(state: MiniState, observer: number, rng: Rng): MiniState {
    const next = cloneState(state);
    // The observer knows their own hand and board, but not their deck order.
    rng.shuffle(next.players[observer]!.deck);
    // The opponent's hand contents and deck are hidden: reshuffle the union of
    // their hand+deck and redeal, preserving only the hand size the observer
    // can see. This is a valid sample of the hidden information.
    const opp = next.players[1 - observer]!;
    const pool = [...opp.hand, ...opp.deck];
    rng.shuffle(pool);
    opp.hand = pool.slice(0, opp.hand.length);
    opp.deck = pool.slice(opp.hand.length);
    return next;
  }

  actionKey(action: MiniAction): string {
    switch (action.type) {
      case 'play':
        return `P${action.handIndex}${action.target ? '>' + targetKey(action.target) : ''}`;
      case 'attack':
        return `A${action.attackerIndex}>${targetKey(action.target)}`;
      case 'end':
        return 'E';
    }
  }

  describeAction(state: MiniState, action: MiniAction): string {
    const me = state.active;
    const p = state.players[me]!;
    switch (action.type) {
      case 'play': {
        const card = p.hand[action.handIndex];
        const name = card ? card.name : '?';
        return action.target
          ? `Play ${name} -> ${describeTarget(state, action.target)}`
          : `Play ${name}`;
      }
      case 'attack': {
        const atk = p.board[action.attackerIndex];
        const name = atk ? atk.def.name : '?';
        return `${name} attacks ${describeTarget(state, action.target)}`;
      }
      case 'end':
        return 'End turn';
    }
  }
}

// --- turn structure --------------------------------------------------------

function beginTurn(p: PlayerState): void {
  if (p.maxMana < MAX_MANA) p.maxMana++;
  p.mana = p.maxMana;
  for (const c of p.board) c.canAttack = true;
  draw(p);
}

function endTurn(state: MiniState): void {
  state.turnCount++;
  state.active = 1 - state.active;
  if (state.turnCount >= TURN_CAP) {
    decideByLife(state);
    return;
  }
  beginTurn(state.players[state.active]!);
}

/** Draw one card; empty deck deals escalating fatigue damage instead. */
function draw(p: PlayerState): void {
  const card = p.deck.shift();
  if (!card) {
    p.fatigue++;
    p.life -= p.fatigue;
    return;
  }
  if (p.hand.length < HAND_LIMIT) p.hand.push(card);
  // else: card is burned (over hand limit).
}

// --- effects ---------------------------------------------------------------

function applySpell(state: MiniState, caster: number, card: CardDef, target?: Target): void {
  const effect = card.effect!;
  const p = state.players[caster]!;
  switch (effect.kind) {
    case 'damage':
      if (target) dealDamage(state, target, effect.amount);
      break;
    case 'heal':
      p.life = Math.min(STARTING_LIFE, p.life + effect.amount);
      break;
    case 'draw':
      for (let i = 0; i < effect.amount; i++) draw(p);
      break;
  }
}

function resolveAttack(state: MiniState, attacker_side: number, attacker: Creature, target: Target): void {
  if (target.zone === 'hero') {
    state.players[target.player]!.life -= attacker.attack;
    return;
  }
  const defender = state.players[target.player]!.board[target.index];
  if (!defender) return;
  // Simultaneous combat damage.
  defender.health -= attacker.attack;
  attacker.health -= defender.attack;
}

function dealDamage(state: MiniState, target: Target, amount: number): void {
  if (target.zone === 'hero') {
    state.players[target.player]!.life -= amount;
  } else {
    const c = state.players[target.player]!.board[target.index];
    if (c) c.health -= amount;
  }
}

function cleanupDead(state: MiniState): void {
  for (const player of state.players) {
    player.board = player.board.filter((c) => c.health > 0);
  }
}

// --- result ----------------------------------------------------------------

function checkResult(state: MiniState): void {
  if (state.result) return;
  const dead0 = state.players[0]!.life <= 0;
  const dead1 = state.players[1]!.life <= 0;
  if (dead0 && dead1) state.result = { winner: null };
  else if (dead1) state.result = { winner: 0 };
  else if (dead0) state.result = { winner: 1 };
}

function decideByLife(state: MiniState): void {
  const l0 = state.players[0]!.life;
  const l1 = state.players[1]!.life;
  if (l0 === l1) state.result = { winner: null };
  else state.result = { winner: l0 > l1 ? 0 : 1 };
}

// --- helpers ---------------------------------------------------------------

function cloneState(state: MiniState): MiniState {
  return {
    active: state.active,
    turnCount: state.turnCount,
    result: state.result ? { ...state.result } : null,
    players: [clonePlayer(state.players[0]!), clonePlayer(state.players[1]!)],
  };
}

function clonePlayer(p: PlayerState): PlayerState {
  return {
    life: p.life,
    mana: p.mana,
    maxMana: p.maxMana,
    fatigue: p.fatigue,
    hand: p.hand.slice(), // CardDefs are immutable, shallow copy is fine
    deck: p.deck.slice(),
    board: p.board.map((c) => ({ ...c })),
  };
}

function targetKey(t: Target): string {
  return t.zone === 'hero' ? `h${t.player}` : `c${t.player}.${t.index}`;
}

function describeTarget(state: MiniState, t: Target): string {
  if (t.zone === 'hero') return `hero P${t.player}`;
  const c = state.players[t.player]!.board[t.index];
  return c ? `${c.def.name}(P${t.player})` : `creature P${t.player}#${t.index}`;
}
