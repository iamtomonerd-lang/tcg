/**
 * Battle Spirits card and game types. Effects are 100% data-driven.
 */

export type CardType = 'spirit' | 'nexus' | 'magic';
export type EffectAction = 'damage' | 'heal' | 'draw' | 'boost_bp' | 'search_deck' | 'destroy_creature' | 'trash_to_hand' | 'place_core' | 'discard_hand' | 'destroy_nexus';
export type EffectTrigger = 'summon' | 'attack' | 'block' | 'destroy' | 'immediate' | 'battle_end' | 'end_step' | 'opponent_summon' | 'opponent_attack' | 'opponent_magic';
export type FlashTrigger = 'opponent_summon' | 'opponent_attack' | 'opponent_magic' | 'opponent_destroy';

export interface CardEffect {
  trigger: EffectTrigger; // when it activates
  action: EffectAction; // what it does
  value?: number; // amount of damage/heal/draw or BP boost or deck cards to open or cores to place
  target?: string; // "opponent_hero" | "opponent_creature" | "any" | "self" | "trash"
  level?: (1 | 2)[]; // which levels this effect activates on (e.g. [1,2] for Lv1-2, [2] for Lv2 only)
  skill?: string; // skill keyword (e.g., "真界放", "継召", "ソウルマジック：赤")
  isFlash?: boolean; // can be activated as flash timing (during opponent's actions)
  requiresTarget?: boolean; // effect requires target selection (e.g., destroy_creature)
  variableValue?: boolean; // effect value is player-selected (e.g., discard count)
  condition?: {
    minHandSize?: number;
    maxHandSize?: number; // maximum hand size for effect to activate
    requiresSymbol?: string; // requires this symbol color on field
    requiresFatiguedRed?: boolean; // requires fatigued red spirit on field
    requiresAdjacentSymbol?: string; // requires adjacent spirit with this symbol
    excludeEXSymbol?: boolean; // exclude cards with EX symbol
    excludeSoulCore?: boolean; // exclude soul cores (for place_core effects)
    requiresNexus?: boolean; // requires at least one nexus on field
    requiresSpirit?: { lineage?: string; count?: number }; // requires specific spirit(s)
    opponentHasNexus?: boolean; // opponent must have nexus
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
  /** Core type at this level (e.g., "ソウルコア") */
  coreType?: string;
}

export interface CardDef {
  id: string;
  name: string;
  cardType: CardType;
  cost: number;
  reductionCost: number; // max reduction from symbols on field
  symbolCount: number; // number of symbols (damage dealt)
  symbolColors: string[]; // colors of symbols
  lineage?: string[]; // card lineage/tribe
  exSymbol?: boolean; // has decoration on symbol (EX symbol)
  inheritance?: boolean; // can use EX symbols from trash for cost reduction
  imagePath?: string; // path to card image file
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
  /** soul cores (persist across refresh, used for permanent leveling) */
  soulCoreCount: number;
  /** true = ready to attack, false = fatigued */
  canAttack: boolean;
  /** temporary BP boost from effects */
  bpBoost?: number;
  /** cores placed on this spirit */
  placedCores?: number;
  /** cannot attack until next turn */
  cannotAttackUntilNextTurn?: boolean;
  /** cannot defend until next turn */
  cannotDefendUntilNextTurn?: boolean;
  /** status effects like paralysis, weakness */
  statusEffects?: string[];
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
  cores: number; // regular cores in reserve
  soulCores: number; // soul cores in reserve
  trashCores: number; // regular cores in trash
  trashSoulCores: number; // soul cores in trash
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

export interface PendingFlash {
  trigger: FlashTrigger; // what triggered the flash opportunity
  cardId: string; // which card triggered it
  actionIndex?: number; // the action that triggered this flash window
  initiatingPlayer: number; // player who triggered the flash window (0 or 1)
  lastFlashPlayer?: number; // player who last used a flash (for stacking)
}

export interface PendingAttack {
  attackerPlayer: number; // who is attacking
  attackerSpiritIndex: number; // which spirit is attacking
  damage: number; // base damage (symbol count if no defense)
}

export type GamePhase = 'start' | 'core' | 'draw' | 'refresh' | 'main' | 'attack' | 'main2' | 'end';

export interface PendingDraw {
  openedCards: CardDef[]; // cards opened from deck for selection
  selectableCount: number; // how many cards can be selected (usually 1)
}

export interface GameState {
  players: [PlayerState, PlayerState];
  currentPlayer: number;
  turnCount: number;
  phase: GamePhase;
  battle: BattleState | null;
  result: { winner: number | null } | null;
  pendingFlash?: PendingFlash | null; // if set, opponent has a flash opportunity
  pendingAttack?: PendingAttack | null; // if set, defending player can choose to block
  pendingDraw?: PendingDraw | null; // if set, player must select card(s) from opened deck
}

export type Action =
  | { type: 'summon'; handIndex: number; targetNexusIndex?: number; coreType?: 'regular' | 'soul' }
  | { type: 'add_core'; spiritIndex: number; coreType?: 'regular' | 'soul' } // move 1 core from reserve onto a spirit (level-up)
  | { type: 'place_nexus'; handIndex: number; coreType?: 'regular' | 'soul' }
  | { type: 'use_magic'; handIndex: number; targetNexusIndex?: number; targetSpiritIndex?: number; effectValue?: number; coreType?: 'regular' | 'soul' }
  | { type: 'attack'; spiritIndex: number; defendingSpiritIndex?: number }
  | { type: 'block'; spiritIndex: number }
  | { type: 'defend'; spiritIndex: number } // respond to pending attack with defense
  | { type: 'take_damage' } // accept attack damage without defending
  | { type: 'pass' } // end current action phase
  | { type: 'flash'; handIndex: number; targetCard?: string; targetSpiritIndex?: number; effectValue?: number; coreType?: 'regular' | 'soul' } // activate a flash magic card
  | { type: 'skip_flash' } // pass on flash opportunity
  | { type: 'select_draw'; cardIndex: number }; // select card from opened deck (offering draw)
