import { describe, it, expect } from 'vitest';
import { Mulberry32 } from '../src/core/rng.js';
import { BattlSpiritsGame } from '../src/games/battlspirits/game.js';

const game = new BattlSpiritsGame();

describe('Battle Spirits Summon', () => {
  it('creates initial state correctly', () => {
    const s = game.createInitialState(new Mulberry32(1));
    expect(s.players[0].life).toBe(20);
    expect(s.players[0].cores).toBe(3);
    expect(s.players[0].soulCores).toBe(1);
    expect(s.players[0].trashCores).toBe(0);
    expect(s.players[0].trashSoulCores).toBe(0);
    expect(s.players[0].hand.length).toBe(4); // 4 initial; first player's first draw phase is skipped
    expect(s.players[0].spirits.length).toBe(0);
    expect(s.phase).toBe('main');
    expect(s.currentPlayer).toBe(0);
  });

  it('shows legal summon actions', () => {
    const s = game.createInitialState(new Mulberry32(1));
    const actions = game.legalActions(s);
    const summonActions = actions.filter((a) => a.type === 'summon');
    expect(summonActions.length).toBeGreaterThan(0);
  });

  it('summon reduces cores and creates spirit', () => {
    const s = game.createInitialState(new Mulberry32(1));
    const actions = game.legalActions(s);
    const summonAction = actions.find((a) => a.type === 'summon');

    if (!summonAction) {
      throw new Error('No summon action found in legal actions');
    }

    const initialCores = s.players[0].cores;
    const initialSpirits = s.players[0].spirits.length;

    const s2 = game.applyAction(s, summonAction, new Mulberry32(1));

    expect(s2.players[0].cores).toBeLessThan(initialCores);
    expect(s2.players[0].trashCores).toBeGreaterThan(0);
    expect(s2.players[0].spirits.length).toBe(initialSpirits + 1);
  });

  it('immutability: does not mutate input state', () => {
    const s = game.createInitialState(new Mulberry32(2));
    const initialCores = s.players[0].cores;
    const initialSpirits = s.players[0].spirits.length;
    const actions = game.legalActions(s);
    const summonAction = actions.find((a) => a.type === 'summon');

    if (summonAction) {
      game.applyAction(s, summonAction, new Mulberry32(2));
      expect(s.players[0].cores).toBe(initialCores);
      expect(s.players[0].spirits.length).toBe(initialSpirits);
    }
  });

  it('cores are added to trash when paying cost', () => {
    const s = game.createInitialState(new Mulberry32(1));
    const actions = game.legalActions(s);
    const summonAction = actions.find((a) => a.type === 'summon');

    expect(summonAction).toBeDefined();
    if (!summonAction) return;

    const initialTrashCores = s.players[0].trashCores;
    const s2 = game.applyAction(s, summonAction, new Mulberry32(1));

    // After summon, trashCores should be populated
    expect(s2.players[0].trashCores).toBeGreaterThan(initialTrashCores);
  });

  it('core recovery in refresh: cores return from trash after passing through turn end', () => {
    let s = game.createInitialState(new Mulberry32(5));

    // Summon a spirit to put cores in trash
    let actions = game.legalActions(s);
    let summonAction = actions.find((a) => a.type === 'summon');
    if (!summonAction) return;

    const coresBeforeSummon = s.players[0].cores;
    s = game.applyAction(s, summonAction, new Mulberry32(5));

    const coresAfterSummon = s.players[0].cores;
    const trashAfterSummon = s.players[0].trashCores;

    expect(coresAfterSummon).toBeLessThan(coresBeforeSummon);
    expect(trashAfterSummon).toBeGreaterThan(0);

    // Pass through rest of turn
    // Main → Attack → Main2 → End
    while (true) {
      if (s.phase === 'main' && s.currentPlayer === 0) {
        actions = game.legalActions(s);
        const pass = actions.find((a) => a.type === 'pass');
        if (!pass) break;
        s = game.applyAction(s, pass, new Mulberry32(5));
      } else if (s.phase === 'attack' && s.currentPlayer === 0) {
        actions = game.legalActions(s);
        const pass = actions.find((a) => a.type === 'pass');
        if (!pass) break;
        s = game.applyAction(s, pass, new Mulberry32(5));
      } else if (s.phase === 'main2' && s.currentPlayer === 0) {
        actions = game.legalActions(s);
        const pass = actions.find((a) => a.type === 'pass');
        if (!pass) break;
        s = game.applyAction(s, pass, new Mulberry32(5));
        // Pass triggers end phase and moves to player 1
        break;
      } else {
        break;
      }
    }

    // Now player 1 has control. Let them pass through their phases
    while (s.currentPlayer === 1 && s.phase !== 'start') {
      actions = game.legalActions(s);
      const pass = actions.find((a) => a.type === 'pass');
      if (!pass) break;
      s = game.applyAction(s, pass, new Mulberry32(5));
    }

    // Now we should be back at player 0's turn with refresh having run
    if (s.currentPlayer === 0 && s.phase === 'main') {
      const coresAfterRefresh = s.players[0].cores;
      const trashAfterRefresh = s.players[0].trashCores;

      // Trash cores should definitely be back in reserve
      expect(trashAfterRefresh).toBe(0);

      // Cores should be at least the trash cores recovered
      // (Core phase recovery might also add cores if it ran)
      expect(coresAfterRefresh).toBeGreaterThanOrEqual(coresAfterSummon + trashAfterSummon);
    }
  });
});
