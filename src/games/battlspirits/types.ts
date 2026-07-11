/**
 * Battle Spirits card and game types. Effects are 100% data-driven.
 */

export type CardType = 'spirit' | 'nexus' | 'magic';
export type EffectAction = 'damage' | 'heal' | 'draw' | 'boost_bp' | 'search_deck' | 'destroy_creature';
export type EffectTrigger = 'summon' | 'attack' | 'block' | 'destroy' | 'immediate';

export interface CardEffect {
  trigger: EffectTrigger; // when it activates
  action: EffectAction; // what it does
  value?: number; // amount of damage/heal/draw or BP boost or deck cards to open
  target?: string; // "opponent_hero" | "opponent_creature" | "any" | "self"
  condition?: {
    level?: 1 | 2;
    minHandSize?: number;
    requiresSymbol?: string; // requires this symbol color on field
    requiresFatiguedRed?: boolean; // requires fatigued red spirit on field
  };
  symbol?: string; // for search_deck: symbol to search for
  description?: string;
}

export interface LvStats {
  /** Core cost to reach this Lv */
  cost: number;
  /** Battle Power at this Lv */
  bp: number;
}

export interface CardDef {
  id: string;
  name: string;
  cardType: CardType;
  cost: number;
  symbols: string[]; // symbol colors for cost reduction
  // For spirits and nexuses: Lv1 and Lv2
  lv1: LvStats;
  lv2?: LvStats;
  // Data-driven effects
  effects?: CardEffect[];
}

export interface Spirit {
  def: CardDef;
  level: 1 | 2;
  coreCount: number;
  /** true = ready to attack, false = fatigued */
  canAttack: boolean;
  /** temporary BP boost from effects */
  bpBoost?: number;
}

export interface Nexus {
  def: CardDef;
  level: 1 | 2;
  coreCount: number;
}

export interface PlayerState {
  life: number;
  cores: number; // cores in reserve
  hand: CardDef[];
  deck: CardDef[];
  spirits: Spirit[];
  nexuses: Nexus[];
  trash: CardDef[];
}

export interface BattleState {
  attacker: Spirit;
  defender?: Spirit; // null if attacking hero directly
  attackerFatigue: boolean;
  defenderFatigue: boolean;
}

export interface GameState {
  players: [PlayerState, PlayerState];
  currentPlayer: number;
  turnCount: number;
  battle: BattleState | null;
  result: { winner: number | null } | null;
}

export type Action =
  | { type: 'summon'; handIndex: number; targetNexusIndex?: number }
  | { type: 'place_nexus'; handIndex: number }
  | { type: 'use_magic'; handIndex: number; targetNexusIndex?: number }
  | { type: 'attack'; spiritIndex: number; defendingSpiritIndex?: number }
  | { type: 'block'; spiritIndex: number }
  | { type: 'pass' }; // end current action phase
