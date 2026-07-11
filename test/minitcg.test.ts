import { describe, it, expect } from 'vitest';
import { Mulberry32 } from '../src/core/rng.js';
import { MiniTcg } from '../src/games/minitcg/game.js';
import { STARTING_HAND, STARTING_LIFE, type MiniState } from '../src/games/minitcg/state.js';
import { playMatch } from '../src/core/match.js';
import { RandomAgent } from '../src/ai/randomAgent.js';
import { IsmctsAgent } from '../src/ai/ismcts.js';

const game = new MiniTcg();

describe('MiniTCG rules', () => {
  it('sets up a legal initial state', () => {
    const s = game.createInitialState(new Mulberry32(1));
    // Player 0 has taken their begin-turn (mana up + draw).
    expect(s.players[0].life).toBe(STARTING_LIFE);
    expect(s.players[0].maxMana).toBe(1);
    expect(s.players[0].hand.length).toBe(STARTING_HAND + 1);
    expect(s.players[1].hand.length).toBe(STARTING_HAND);
    expect(s.active).toBe(0);
    expect(game.isTerminal(s)).toBe(false);
    expect(game.legalActions(s).length).toBeGreaterThan(0);
  });

  it('always offers ending the turn as a legal action', () => {
    const s = game.createInitialState(new Mulberry32(2));
    expect(game.legalActions(s).some((a) => a.type === 'end')).toBe(true);
  });

  it('applyAction does not mutate the input state (immutability)', () => {
    const s = game.createInitialState(new Mulberry32(3));
    const handBefore = s.players[0].hand.length;
    const actions = game.legalActions(s);
    game.applyAction(s, actions[0]!, new Mulberry32(3));
    expect(s.players[0].hand.length).toBe(handBefore);
  });

  it('ending the turn passes control and runs the opponent begin-turn', () => {
    const s = game.createInitialState(new Mulberry32(4));
    const end = game.legalActions(s).find((a) => a.type === 'end')!;
    const s2 = game.applyAction(s, end, new Mulberry32(4));
    expect(s2.active).toBe(1);
    expect(s2.players[1].maxMana).toBe(1);
    expect(s2.players[1].hand.length).toBe(STARTING_HAND + 1);
  });

  it('legalActions is empty exactly when terminal', () => {
    const s = game.createInitialState(new Mulberry32(5));
    const dead: MiniState = {
      ...s,
      players: [
        { ...s.players[0], life: 0 },
        s.players[1],
      ],
      result: { winner: 1 },
    };
    expect(game.isTerminal(dead)).toBe(true);
    expect(game.legalActions(dead).length).toBe(0);
  });

  it('reward is 1 for winner and 0 for loser', () => {
    const s = game.createInitialState(new Mulberry32(6));
    const terminal: MiniState = { ...s, result: { winner: 0 } };
    expect(game.reward(terminal, 0)).toBe(1);
    expect(game.reward(terminal, 1)).toBe(0);
  });
});

describe('determinize (imperfect information)', () => {
  it('preserves what the observer can see and hand sizes', () => {
    const s = game.createInitialState(new Mulberry32(7));
    const observer = 0;
    const d = game.determinize(s, observer, new Mulberry32(999));
    // Observer's own hand is unchanged.
    expect(d.players[observer].hand).toEqual(s.players[observer].hand);
    // Opponent hand size is preserved even though contents may be reshuffled.
    expect(d.players[1].hand.length).toBe(s.players[1].hand.length);
    // Total cards conserved for the opponent.
    const before = s.players[1].hand.length + s.players[1].deck.length;
    const after = d.players[1].hand.length + d.players[1].deck.length;
    expect(after).toBe(before);
  });
});

describe('games always terminate', () => {
  it('random vs random reaches a result', () => {
    const rng = new Mulberry32(42);
    const initial = game.createInitialState(rng);
    const agents = [new RandomAgent<MiniState, any>(), new RandomAgent<MiniState, any>()];
    const result = playMatch(game, initial, agents, rng, { maxActions: 20_000 });
    expect(game.isTerminal(result.finalState)).toBe(true);
    expect([0, 1, null]).toContain(result.winner);
  });
});

describe('ISMCTS is stronger than random', () => {
  it('beats a random agent over several games', () => {
    let mctsWins = 0;
    const games = 12;
    for (let g = 0; g < games; g++) {
      const rng = new Mulberry32(100 + g * 31);
      const initial = game.createInitialState(rng);
      const agents = [
        new IsmctsAgent<MiniState, any>({ iterations: 400 }),
        new RandomAgent<MiniState, any>(),
      ];
      const result = playMatch(game, initial, agents, rng, { maxActions: 20_000 });
      if (result.winner === 0) mctsWins++;
    }
    // Should win a clear majority; allow slack for variance.
    expect(mctsWins).toBeGreaterThanOrEqual(8);
  });
});
