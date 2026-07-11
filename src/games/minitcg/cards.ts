/**
 * Card definitions for MiniTCG, a small self-contained sample TCG.
 *
 * Cards are pure data. The rules engine (`game.ts`) reads these fields; adding
 * a card is just adding an entry here, which is the whole point of a
 * data-driven design.
 */

export type CardType = 'creature' | 'spell';

export type SpellEffect =
  | { kind: 'damage'; amount: number } // deal N damage to a target
  | { kind: 'heal'; amount: number } // restore N life to own hero
  | { kind: 'draw'; amount: number }; // draw N cards

export interface CardDef {
  readonly id: string;
  readonly name: string;
  readonly type: CardType;
  readonly cost: number;
  /** Creatures only: */
  readonly attack?: number;
  readonly health?: number;
  /** Spells only: */
  readonly effect?: SpellEffect;
}

/** Master card list, keyed by id. */
export const CARD_DB: Record<string, CardDef> = {
  // --- creatures (a simple mana curve) ---
  wisp: { id: 'wisp', name: 'Wisp', type: 'creature', cost: 1, attack: 1, health: 2 },
  recruit: { id: 'recruit', name: 'Recruit', type: 'creature', cost: 1, attack: 2, health: 1 },
  soldier: { id: 'soldier', name: 'Soldier', type: 'creature', cost: 2, attack: 3, health: 2 },
  guard: { id: 'guard', name: 'Guard', type: 'creature', cost: 2, attack: 2, health: 3 },
  knight: { id: 'knight', name: 'Knight', type: 'creature', cost: 3, attack: 3, health: 4 },
  ogre: { id: 'ogre', name: 'Ogre', type: 'creature', cost: 4, attack: 5, health: 4 },
  giant: { id: 'giant', name: 'Giant', type: 'creature', cost: 5, attack: 6, health: 6 },

  // --- spells ---
  spark: {
    id: 'spark',
    name: 'Spark',
    type: 'spell',
    cost: 1,
    effect: { kind: 'damage', amount: 1 },
  },
  bolt: {
    id: 'bolt',
    name: 'Bolt',
    type: 'spell',
    cost: 3,
    effect: { kind: 'damage', amount: 4 },
  },
  mend: {
    id: 'mend',
    name: 'Mend',
    type: 'spell',
    cost: 2,
    effect: { kind: 'heal', amount: 5 },
  },
  insight: {
    id: 'insight',
    name: 'Insight',
    type: 'spell',
    cost: 2,
    effect: { kind: 'draw', amount: 2 },
  },
};

/** A reasonable 20-card starter deck used by both players. */
export const STARTER_DECK: string[] = [
  'recruit', 'recruit',
  'wisp', 'wisp',
  'soldier', 'soldier',
  'guard', 'guard',
  'knight', 'knight',
  'ogre', 'ogre',
  'giant',
  'spark', 'spark',
  'bolt', 'bolt',
  'mend',
  'insight', 'insight',
];
