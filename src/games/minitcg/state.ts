import type { CardDef } from './cards.js';

/** A creature currently in play. */
export interface Creature {
  def: CardDef;
  /** Current stats (may differ from the card def after damage/buffs). */
  attack: number;
  health: number;
  /** False on the turn it was played (summoning sickness). */
  canAttack: boolean;
}

export interface PlayerState {
  life: number;
  mana: number;
  maxMana: number;
  hand: CardDef[];
  /** deck[0] is the top card (next to be drawn). */
  deck: CardDef[];
  board: Creature[];
  /** Accumulated fatigue damage taken when drawing from an empty deck. */
  fatigue: number;
}

export interface MiniState {
  players: [PlayerState, PlayerState];
  /** Index of the player whose turn it is. */
  active: number;
  /** Total turns taken (both players), for the draw cap. */
  turnCount: number;
  /** null while the game is ongoing; otherwise the result. */
  result: { winner: number | null } | null;
}

/** Targets a spell can point at. */
export type Target =
  | { zone: 'hero'; player: number }
  | { zone: 'creature'; player: number; index: number };

export type MiniAction =
  | { type: 'play'; handIndex: number; target?: Target } // play a card from hand
  | { type: 'attack'; attackerIndex: number; target: Target } // creature attacks
  | { type: 'end' }; // end the turn

export const MAX_MANA = 10;
export const BOARD_LIMIT = 7;
export const HAND_LIMIT = 10;
export const STARTING_LIFE = 20;
export const STARTING_HAND = 3;
/** Per-player turn cap; the game is decided on life if it is reached. */
export const TURN_CAP = 100;
