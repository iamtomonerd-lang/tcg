import { describe, it, expect } from 'vitest';
import { Mulberry32 } from '../src/core/rng.js';
import { BattlSpiritsGame } from '../src/games/battlspirits/game.js';
import { updateNexusLevel } from '../src/games/battlspirits/effects.js';
import type { GameState, PlayerState, CardEffect } from '../src/games/battlspirits/types.js';

// Test nexus: Lv1 cost=2, Lv2 cost=4
const testNexusCard = {
  id: 'test-nexus-lv2',
  name: 'Test Nexus Lv2',
  cardType: 'nexus',
  imagePath: '',
  symbolColors: [],
  lv1: { cost: 2 },
  lv2: { cost: 4 },
  effects: [],
} as any;

function makePlayer(playerId: 0 | 1 = 0): PlayerState {
  return {
    id: playerId,
    lifeZone: { cores: 5 },
    cores: 10,
    soulCores: 0,
    trashCores: 0,
    trashSoulCores: 0,
    hand: [],
    deck: [],
    spirits: [],
    nexuses: [],
    trash: [],
    bottomDeckCards: [],
  };
}

describe('Nexus Placement Integration Tests', () => {
  it('move_core: 2 cores → Lv1 nexus placed', () => {
    const nexus = {
      def: testNexusCard,
      level: 1,
      coreCount: 2, // Lv1 minimum
      soulCoreCount: 0,
      state: 'recovered' as const,
    };

    updateNexusLevel(nexus);
    expect(nexus.level).toBe(1);
    expect(nexus.coreCount + nexus.soulCoreCount).toBe(2);
  });

  it('move_core: 4 cores → Lv2 nexus (via updateNexusLevel)', () => {
    const nexus = {
      def: testNexusCard,
      level: 1,
      coreCount: 4, // Enough for Lv2
      soulCoreCount: 0,
      state: 'recovered' as const,
    };

    updateNexusLevel(nexus);
    expect(nexus.level).toBe(2);
    expect(nexus.coreCount + nexus.soulCoreCount).toBe(4);
  });

  it('move_core: 1 core → Lv1 nexus depleted', () => {
    const player = makePlayer(0);
    const nexus = {
      def: testNexusCard,
      level: 1,
      coreCount: 1, // Below Lv1 cost
      soulCoreCount: 0,
      state: 'recovered' as const,
    };
    player.nexuses.push(nexus);

    expect(player.nexuses.length).toBe(1);

    // Manually call removeDeadNexuses through game instance
    const game = new BattlSpiritsGame();
    const state: GameState = {
      players: [player, makePlayer(1)] as [PlayerState, PlayerState],
      currentPlayer: 0,
      phase: 'main',
      battle: null,
      result: null,
      pendingDraw: null,
      pendingAttack: null,
      pendingFlash: null,
      pendingMulligan: null,
      pendingSpiritDepletion: null,
      pendingNexusDepletion: null,
      pendingSpellChain: null,
      pendingEffectAction: null,
      pendingInheritanceSelection: null,
      pendingDiceRoll: null,
    };

    (game as any).removeDeadNexuses(state, 0);

    expect(player.nexuses.length).toBe(0);
    expect(player.trash.length).toBe(1);
    expect(player.trash[0]!.id).toBe(testNexusCard.id);
  });

  it('updateNexusLevel: Lv1 cost minimum (2 cores)', () => {
    const nexus = {
      def: testNexusCard,
      level: 1,
      coreCount: 2,
      soulCoreCount: 0,
      state: 'recovered' as const,
    };

    updateNexusLevel(nexus);
    // With exactly Lv1 cost, should remain Lv1
    expect(nexus.level).toBe(1);
  });

  it('updateNexusLevel: Lv2 cost (4 cores) triggers Lv2', () => {
    const nexus = {
      def: testNexusCard,
      level: 1,
      coreCount: 4,
      soulCoreCount: 0,
      state: 'recovered' as const,
    };

    updateNexusLevel(nexus);
    // With 4 cores, should upgrade to Lv2
    expect(nexus.level).toBe(2);
  });

  it('updateNexusLevel: Below Lv1 cost (1 core) stays Lv1', () => {
    const nexus = {
      def: testNexusCard,
      level: 1,
      coreCount: 1,
      soulCoreCount: 0,
      state: 'recovered' as const,
    };

    updateNexusLevel(nexus);
    // With only 1 core, stays Lv1 (will be removed by removeDeadNexuses)
    expect(nexus.level).toBe(1);
  });
});
