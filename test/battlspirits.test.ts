import { describe, it, expect } from 'vitest';
import { Mulberry32 } from '../src/core/rng.js';
import { BattlSpiritsGame } from '../src/games/battlspirits/game.js';
import { CARD_DB } from '../src/games/battlspirits/cards.js';
import { destroySpirit, fixupSpiritIndicesAfterRemoval } from '../src/games/battlspirits/effects.js';
import type { GameState, PlayerState, Spirit } from '../src/games/battlspirits/types.js';

const game = new BattlSpiritsGame();

function makeSpirit(): Spirit {
  return { def: CARD_DB.spirit_moon_shacco!, level: 1, coreCount: 1, soulCoreCount: 0, canAttack: true };
}

function makePlayer(spirits: Spirit[]): PlayerState {
  return { life: 20, cores: 3, soulCores: 1, trashCores: 0, trashSoulCores: 0, hand: [], deck: [], spirits, nexuses: [], trash: [] };
}

/** Resolve both players' opening-hand mulligan by keeping their hand, reaching the first Main phase. */
function skipMulligan(state: GameState, rng: Mulberry32): GameState {
  let s = state;
  while (s.pendingMulligan) {
    s = game.applyAction(s, { type: 'mulligan', redraw: false }, rng);
  }
  return s;
}

describe('Battle Spirits Mulligan', () => {
  it('opening hand starts in a pendingMulligan state for player 0', () => {
    const s = game.createInitialState(new Mulberry32(1));
    expect(s.phase).toBe('start');
    expect(s.pendingMulligan).toEqual({ player: 0 });
    expect(s.players[0].hand.length).toBe(4);
    const actions = game.legalActions(s);
    expect(actions).toEqual([
      { type: 'mulligan', redraw: false },
      { type: 'mulligan', redraw: true },
    ]);
  });

  it('keeping the hand for both players does not change hand contents, then starts turn 0', () => {
    const s0 = game.createInitialState(new Mulberry32(1));
    const originalHand0 = s0.players[0].hand.map((c) => c.id);
    const originalHand1 = s0.players[1].hand.map((c) => c.id);

    const s = skipMulligan(s0, new Mulberry32(1));

    expect(s.pendingMulligan).toBeFalsy();
    expect(s.phase).toBe('main');
    expect(s.currentPlayer).toBe(0);
    expect(s.players[0].hand.map((c) => c.id)).toEqual(originalHand0);
    expect(s.players[1].hand.map((c) => c.id)).toEqual(originalHand1);
  });

  it('redrawing shuffles the whole hand back into the deck and deals a fresh 4-card hand', () => {
    const s0 = game.createInitialState(new Mulberry32(1));
    const originalHand0 = s0.players[0].hand.map((c) => c.id);
    const originalDeckSize0 = s0.players[0].deck.length;

    let s = game.applyAction(s0, { type: 'mulligan', redraw: true }, new Mulberry32(1));
    // Player 0's redraw happened; still awaiting player 1's decision
    expect(s.pendingMulligan).toEqual({ player: 1 });
    expect(s.players[0].hand.length).toBe(4);
    expect(s.players[0].deck.length).toBe(originalDeckSize0);
    // No card selection: the new hand is not guaranteed to differ, but the deck was reshuffled
    // and reconstituted from the old hand + old deck, so total card count is conserved.
    const allCardIdsAfter = [...s.players[0].hand, ...s.players[0].deck].map((c) => c.id).sort();
    const allCardIdsBefore = [...originalHand0, ...s0.players[0].deck.map((c) => c.id)].sort();
    expect(allCardIdsAfter).toEqual(allCardIdsBefore);

    s = game.applyAction(s, { type: 'mulligan', redraw: false }, new Mulberry32(1));
    expect(s.pendingMulligan).toBeFalsy();
    expect(s.phase).toBe('main');
  });
});

describe('Battle Spirits Summon', () => {
  it('creates initial state correctly', () => {
    const s = skipMulligan(game.createInitialState(new Mulberry32(1)), new Mulberry32(1));
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
    const s = skipMulligan(game.createInitialState(new Mulberry32(1)), new Mulberry32(1));
    const actions = game.legalActions(s);
    const summonActions = actions.filter((a) => a.type === 'summon');
    expect(summonActions.length).toBeGreaterThan(0);
  });

  it('summon reduces cores and creates spirit', () => {
    const s = skipMulligan(game.createInitialState(new Mulberry32(1)), new Mulberry32(1));
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
    const s = skipMulligan(game.createInitialState(new Mulberry32(2)), new Mulberry32(2));
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
    const s = skipMulligan(game.createInitialState(new Mulberry32(1)), new Mulberry32(1));
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
    let s = skipMulligan(game.createInitialState(new Mulberry32(5)), new Mulberry32(5));

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

describe('Spirit index staleness after mid-flash destruction', () => {
  // Regression test for a crash found via random self-play: a flash effect
  // (e.g. destroy_creature) destroying a spirit before the attacker's own
  // index left pendingAttack/stashedAttack pointing at the wrong (or a
  // now out-of-bounds) spirit.

  it('shifts a pending attacker index down when an earlier spirit is destroyed', () => {
    const spiritA = makeSpirit(); // will be destroyed, at index 0
    const spiritB = makeSpirit(); // the attacker, at index 1
    const p0 = makePlayer([spiritA, spiritB]);
    const p1 = makePlayer([]);
    const state: GameState = {
      players: [p0, p1],
      currentPlayer: 1,
      turnCount: 1,
      phase: 'attack',
      battle: null,
      result: null,
      pendingFlash: {
        trigger: 'opponent_attack',
        cardId: '',
        initiatingPlayer: 0,
        stashedAttack: { attackerPlayer: 0, attackerSpiritIndex: 1, damage: 1 },
      },
    };

    destroySpirit(p0, 0);
    fixupSpiritIndicesAfterRemoval(state, 0, 0);

    expect(state.pendingFlash!.stashedAttack).toEqual({ attackerPlayer: 0, attackerSpiritIndex: 0, damage: 1 });
    // The spirit now at index 0 is spiritB, the intended attacker.
    expect(p0.spirits[state.pendingFlash!.stashedAttack!.attackerSpiritIndex]).toBe(spiritB);
  });

  it('cancels the pending attack if the attacking spirit itself is destroyed', () => {
    const spiritA = makeSpirit(); // the attacker, at index 0
    const p0 = makePlayer([spiritA]);
    const p1 = makePlayer([]);
    const state: GameState = {
      players: [p0, p1],
      currentPlayer: 0,
      turnCount: 1,
      phase: 'attack',
      battle: null,
      result: null,
      pendingAttack: { attackerPlayer: 0, attackerSpiritIndex: 0, damage: 1 },
    };

    destroySpirit(p0, 0);
    fixupSpiritIndicesAfterRemoval(state, 0, 0);

    expect(state.pendingAttack).toBeNull();
  });

  it('leaves an unrelated pending attack untouched when the removal is on the other player', () => {
    const attacker = makeSpirit();
    const p0 = makePlayer([attacker]);
    const p1 = makePlayer([makeSpirit(), makeSpirit()]);
    const state: GameState = {
      players: [p0, p1],
      currentPlayer: 1,
      turnCount: 1,
      phase: 'attack',
      battle: null,
      result: null,
      pendingAttack: { attackerPlayer: 0, attackerSpiritIndex: 0, damage: 1 },
    };

    destroySpirit(p1, 0);
    fixupSpiritIndicesAfterRemoval(state, 1, 0);

    expect(state.pendingAttack).toEqual({ attackerPlayer: 0, attackerSpiritIndex: 0, damage: 1 });
  });

  it('end-to-end: flashing destroy_creature on an earlier attacker spirit no longer crashes defend resolution', () => {
    // Reproduces the original crash: player 0 has two spirits and attacks with
    // the second one; player 1 flashes フレイムハリケーン to destroy the first
    // one, shifting the attacker down to index 0. Resolving defend/take_damage
    // must not throw.
    const attacker = makeSpirit();
    const filler = makeSpirit();
    const p0 = makePlayer([filler, attacker]); // attacker at index 1
    const flameHurricane = CARD_DB.magic_flame_hurricane!;
    const p1: PlayerState = {
      ...makePlayer([]),
      soulCores: 10,
      hand: [flameHurricane],
    };
    // Give player 0 a red symbol on the field (required by flame hurricane's condition)
    p0.spirits[0]!.def = { ...p0.spirits[0]!.def, symbolColors: ['red'] };

    let state: GameState = {
      players: [p0, p1],
      currentPlayer: 1,
      turnCount: 1,
      phase: 'attack',
      battle: null,
      result: null,
      pendingFlash: {
        trigger: 'opponent_attack',
        cardId: '',
        initiatingPlayer: 0,
        stashedAttack: { attackerPlayer: 0, attackerSpiritIndex: 1, damage: 1 },
      },
    };

    const flashActions = game.legalActions(state).filter((a) => a.type === 'flash');
    expect(flashActions.length).toBeGreaterThan(0);
    const flashAction = flashActions.find((a) => a.type === 'flash' && a.handIndex === 0)!;

    expect(() => {
      state = game.applyAction(state, { ...flashAction, targetSpiritIndex: 0 }, new Mulberry32(1));
    }).not.toThrow();

    // filler (originally index 0) was destroyed; attacker shifted to index 0.
    expect(state.players[0].spirits.length).toBe(1);
    expect(state.players[0].spirits[0]!.def.id).toBe(attacker.def.id);

    // Close the flash window and resolve the attack; this must not crash.
    expect(() => {
      const skip = game.legalActions(state).find((a) => a.type === 'skip_flash');
      if (skip) state = game.applyAction(state, skip, new Mulberry32(1));
      const takeDamage = game.legalActions(state).find((a) => a.type === 'take_damage');
      if (takeDamage) state = game.applyAction(state, takeDamage, new Mulberry32(1));
    }).not.toThrow();
  });
});

describe('destroy_nexus conservation', () => {
  it('destroyed nexus card goes to trash and its cores (incl. soul) go to trash cores', () => {
    const caster = makePlayer([]);
    caster.hand = [CARD_DB.magic_break_claw!];
    caster.cores = 10;
    const defender = makePlayer([]);
    defender.nexuses = [{ def: CARD_DB.nexus_ukiyo_rock!, level: 1, coreCount: 2, soulCoreCount: 1 }];
    defender.soulCores = 0; // their only soul core sits on the nexus

    let state: GameState = {
      players: [caster, defender],
      currentPlayer: 0,
      turnCount: 2,
      phase: 'main',
      battle: null,
      result: null,
    };

    const useMagic = game.legalActions(state).find((a) => a.type === 'use_magic');
    expect(useMagic).toBeDefined();
    state = game.applyAction(state, useMagic!, new Mulberry32(1));

    const d = state.players[1];
    expect(d.nexuses.length).toBe(0);
    expect(d.trash.map((c) => c.id)).toContain('nexus_ukiyo_rock');
    expect(d.trashCores).toBe(2);
    expect(d.trashSoulCores).toBe(1);
  });
});

describe('Compound activation costs (▶ effects)', () => {
  function setupGraipherAttack(hand: PlayerState['hand']): GameState {
    const graipher: Spirit = { def: CARD_DB.spirit_graipher!, level: 1, coreCount: 1, soulCoreCount: 0, canAttack: true };
    const p0 = makePlayer([graipher]);
    p0.hand = hand;
    const p1 = makePlayer([]);
    p1.hand = []; // no flash response possible
    return {
      players: [p0, p1],
      currentPlayer: 0,
      turnCount: 2,
      phase: 'attack',
      battle: null,
      result: null,
    };
  }

  it('paying the discard cost applies the BP boost and discards the 風牙 card', () => {
    const windFangCard = CARD_DB.spirit_moon_shacco!; // lineage 風牙
    let state = setupGraipherAttack([windFangCard]);

    const attackWithDiscard = game
      .legalActions(state)
      .find((a) => a.type === 'attack' && a.discardCardIndex === 0);
    expect(attackWithDiscard).toBeDefined();

    state = game.applyAction(state, attackWithDiscard!, new Mulberry32(1));
    const p0 = state.players[0];
    expect(p0.hand.length).toBe(0);
    expect(p0.trash.map((c) => c.id)).toContain('spirit_moon_shacco');
    expect(p0.spirits[0]!.bpBoost).toBe(3000);
  });

  it('attacking without paying the cost neither discards nor boosts', () => {
    const windFangCard = CARD_DB.spirit_moon_shacco!;
    let state = setupGraipherAttack([windFangCard]);

    const plainAttack = game
      .legalActions(state)
      .find((a) => a.type === 'attack' && a.discardCardIndex === undefined);
    expect(plainAttack).toBeDefined();

    state = game.applyAction(state, plainAttack!, new Mulberry32(1));
    const p0 = state.players[0];
    expect(p0.hand.length).toBe(1);
    expect(p0.spirits[0]!.bpBoost ?? 0).toBe(0);
  });

  it('a non-風牙 card cannot be chosen as the discard cost', () => {
    const nonWindFang = { ...CARD_DB.spirit_moon_shacco!, lineage: [] };
    const state = setupGraipherAttack([nonWindFang]);

    const discardChoices = game
      .legalActions(state)
      .filter((a) => a.type === 'attack' && a.discardCardIndex !== undefined);
    expect(discardChoices.length).toBe(0);
  });

  it('風牙岩 exhausts itself to boost the attacker, and cannot fire again while exhausted', () => {
    const attacker1: Spirit = { def: CARD_DB.spirit_moon_shacco!, level: 1, coreCount: 1, soulCoreCount: 0, canAttack: true };
    const attacker2: Spirit = { def: CARD_DB.spirit_genie_bow!, level: 1, coreCount: 1, soulCoreCount: 0, canAttack: true };
    const p0 = makePlayer([attacker1, attacker2]);
    p0.nexuses = [{ def: CARD_DB.nexus_wind_fang_rock!, level: 1, coreCount: 1, soulCoreCount: 0 }];
    const p1 = makePlayer([]);
    p1.hand = [];
    let state: GameState = {
      players: [p0, p1],
      currentPlayer: 0,
      turnCount: 2,
      phase: 'attack',
      battle: null,
      result: null,
    };

    // First attack: nexus pays its exhaustion, attacker gets +2000
    const attackA = game.legalActions(state).find((a) => a.type === 'attack' && a.spiritIndex === 0)!;
    state = game.applyAction(state, attackA, new Mulberry32(1));
    expect(state.players[0].spirits[0]!.bpBoost).toBe(2000);
    expect(state.players[0].nexuses[0]!.exhausted).toBe(true);

    // Resolve the attack (opponent takes damage), control returns to player 0
    const takeDamage = game.legalActions(state).find((a) => a.type === 'take_damage')!;
    state = game.applyAction(state, takeDamage, new Mulberry32(1));

    // Second attack in the same turn: exhausted nexus cannot pay again
    const attackB = game.legalActions(state).find((a) => a.type === 'attack' && a.spiritIndex === 1)!;
    state = game.applyAction(state, attackB, new Mulberry32(1));
    expect(state.players[0].spirits[1]!.bpBoost ?? 0).toBe(0);
    expect(state.players[0].nexuses[0]!.exhausted).toBe(true);
  });
});
