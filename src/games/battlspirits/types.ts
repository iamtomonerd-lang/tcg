/**
 * Battle Spirits card and game types. Effects are 100% data-driven.
 */

export type CardType = 'spirit' | 'nexus' | 'magic';
export type EffectAction = 'damage' | 'heal' | 'draw' | 'boost_bp' | 'search_deck' | 'destroy_creature' | 'trash_to_hand' | 'place_core' | 'discard_hand' | 'destroy_nexus';
export type EffectTrigger = 'summon' | 'attack' | 'block' | 'destroy' | 'immediate' | 'battle_end' | 'end_step';

export interface CardEffect {
  trigger: EffectTrigger; // when it activates
  action: EffectAction; // what it does
  value?: number; // amount of damage/heal/draw or BP boost or deck cards to open or cores to place
  target?: string; // "opponent_hero" | "opponent_creature" | "any" | "self" | "trash"
  level?: (1 | 2)[]; // which levels this effect activates on (e.g. [1,2] for Lv1-2, [2] for Lv2 only)
  condition?: {
    minHandSize?: number;
    maxHandSize?: number; // maximum hand size for effect to activate
    requiresSymbol?: string; // requires this symbol color on field
    requiresFatiguedRed?: boolean; // requires fatigued red spirit on field
    requiresAdjacentSymbol?: string; // requires adjacent spirit with this symbol
    excludeEXSymbol?: boolean; // exclude cards with EX symbol
  };
  symbol?: string; // for search_deck/trash_to_hand: symbol to search for
  excludeId?: string; // for trash_to_hand: exclude this card ID
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
  exSymbol?: boolean; // has decoration on symbol (EX symbol)
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
  /** cores placed on this spirit */
  placedCores?: number;
}

export interface Nexus {
  def: CardDef;
  level: 1 | 2;
  coreCount: number;
  /** cores placed on this nexus */
  placedCores?: number;
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
