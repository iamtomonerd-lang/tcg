/**
 * Sample card database for Battle Spirits (Standard).
 * All effects are data-driven; no hardcoded logic.
 */

import type { CardDef } from './types.js';

const STARTER_DECK_IDS = [
  // Spirits: 14 cards across costs
  'spirit_recruit', 'spirit_recruit',
  'spirit_soldier', 'spirit_soldier',
  'spirit_knight', 'spirit_knight',
  'spirit_warrior',
  'spirit_mage',
  'spirit_moon_shacco',
  'spirit_genie_bow',
  'spirit_ro_meek',
  'spirit_haria',
  'spirit_gun_gata',

  // Nexuses: 4 cards
  'nexus_shrine', 'nexus_shrine',
  'nexus_stone', 'nexus_stone',

  // Magic: 6 cards
  'magic_slash', 'magic_slash', 'magic_slash',
  'magic_heal', 'magic_heal',
  'magic_draw',
];

export const CARD_DB: Record<string, CardDef> = {
  // === SPIRITS ===

  spirit_recruit: {
    id: 'spirit_recruit',
    name: 'Recruit',
    cardType: 'spirit',
    cost: 1,
    symbols: ['red'],
    lv1: { cost: 0, bp: 2 },
    lv2: { cost: 1, bp: 4 },
    effects: [
      { trigger: 'summon', action: 'damage', value: 1, target: 'opponent_hero' },
    ],
  },

  spirit_soldier: {
    id: 'spirit_soldier',
    name: 'Soldier',
    cardType: 'spirit',
    cost: 2,
    symbols: ['red', 'red'],
    lv1: { cost: 0, bp: 3 },
    lv2: { cost: 2, bp: 5 },
    effects: [
      { trigger: 'attack', action: 'damage', value: 2, target: 'opponent_hero' },
    ],
  },

  spirit_knight: {
    id: 'spirit_knight',
    name: 'Knight',
    cardType: 'spirit',
    cost: 3,
    symbols: ['red', 'red', 'red'],
    lv1: { cost: 0, bp: 4 },
    lv2: { cost: 2, bp: 6 },
  },

  spirit_warrior: {
    id: 'spirit_warrior',
    name: 'Warrior',
    cardType: 'spirit',
    cost: 4,
    symbols: ['red', 'red', 'red', 'red'],
    lv1: { cost: 1, bp: 5 },
    lv2: { cost: 3, bp: 8 },
  },

  spirit_mage: {
    id: 'spirit_mage',
    name: 'Mage',
    cardType: 'spirit',
    cost: 3,
    symbols: ['blue', 'blue', 'blue'],
    lv1: { cost: 0, bp: 2 },
    lv2: { cost: 1, bp: 4 },
    effects: [
      { trigger: 'summon', action: 'draw', value: 2 },
    ],
  },

  spirit_moon_shacco: {
    id: 'spirit_moon_shacco',
    name: 'ムーンシャッコ',
    cardType: 'spirit',
    cost: 3,
    symbols: ['blue', 'blue', 'blue'],
    lv1: { cost: 0, bp: 2 },
    lv2: { cost: 1, bp: 3 },
    effects: [
      { trigger: 'attack', action: 'draw', value: 1, condition: { level: 2, minHandSize: 5 }, description: 'バトル終了時、手札5枚以上なら1枚ドロー' },
    ],
  },

  spirit_genie_bow: {
    id: 'spirit_genie_bow',
    name: 'ゲニーボー',
    cardType: 'spirit',
    cost: 3,
    symbols: ['red', 'red', 'red'],
    lv1: { cost: 0, bp: 3 },
    lv2: { cost: 1, bp: 5 },
    effects: [
      { trigger: 'attack', action: 'boost_bp', value: 2, condition: { level: 1 }, description: 'Lv1時、攻撃中にBP+2' },
    ],
  },

  spirit_ro_meek: {
    id: 'spirit_ro_meek',
    name: 'ロウミーク',
    cardType: 'spirit',
    cost: 3,
    symbols: ['red', 'red', 'red'],
    lv1: { cost: 0, bp: 3 },
    lv2: { cost: 1, bp: 5 },
    effects: [
      { trigger: 'summon', action: 'destroy_creature', target: 'opponent_creature', condition: { requiresSymbol: 'red' }, description: '機械族の自分の赤スピリットがいるなら、相手のBP3000以下のスピリット1体を破壊' },
    ],
  },

  spirit_haria: {
    id: 'spirit_haria',
    name: 'ハーリア',
    cardType: 'spirit',
    cost: 4,
    symbols: ['white', 'white', 'white', 'white'],
    lv1: { cost: 1, bp: 4 },
    lv2: { cost: 2, bp: 6 },
    effects: [
      { trigger: 'attack', action: 'search_deck', value: 1, symbol: '風守', condition: { level: 1 }, description: 'Lv1時、攻撃中にデッキの上から2枚をオープン。その中の風守系統を手札に加え、残りは破棄' },
    ],
  },

  spirit_gun_gata: {
    id: 'spirit_gun_gata',
    name: 'グンーガタ',
    cardType: 'spirit',
    cost: 4,
    symbols: ['red', 'red', 'red', 'red'],
    lv1: { cost: 1, bp: 5 },
    lv2: { cost: 2, bp: 8 },
  },

  // === NEXUSES ===

  nexus_shrine: {
    id: 'nexus_shrine',
    name: 'Shrine',
    cardType: 'nexus',
    cost: 2,
    symbols: ['red', 'red'],
    lv1: { cost: 0, bp: 0 },
    lv2: { cost: 1, bp: 0 },
    effects: [
      { trigger: 'summon', action: 'heal', value: 3, target: 'self' },
    ],
  },

  nexus_stone: {
    id: 'nexus_stone',
    name: 'Stone',
    cardType: 'nexus',
    cost: 1,
    symbols: ['blue'],
    lv1: { cost: 0, bp: 0 },
    lv2: { cost: 2, bp: 0 },
  },

  // === MAGIC ===

  magic_slash: {
    id: 'magic_slash',
    name: 'Slash',
    cardType: 'magic',
    cost: 2,
    symbols: ['red', 'red'],
    lv1: { cost: 0, bp: 0 },
    effects: [
      { trigger: 'immediate', action: 'damage', value: 3, target: 'opponent_hero' },
    ],
  },

  magic_heal: {
    id: 'magic_heal',
    name: 'Mend',
    cardType: 'magic',
    cost: 2,
    symbols: ['white', 'white'],
    lv1: { cost: 0, bp: 0 },
    effects: [
      { trigger: 'immediate', action: 'heal', value: 5, target: 'self' },
    ],
  },

  magic_draw: {
    id: 'magic_draw',
    name: 'Insight',
    cardType: 'magic',
    cost: 2,
    symbols: ['blue', 'blue'],
    lv1: { cost: 0, bp: 0 },
    effects: [
      { trigger: 'immediate', action: 'draw', value: 2 },
    ],
  },
};

export function getStarterDeck(): CardDef[] {
  return STARTER_DECK_IDS.map((id) => CARD_DB[id]!);
}
