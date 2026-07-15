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
  source?: 'trash' | 'void'; // source for place_core: trash or void (default)
  count?: number; // for search_deck: how many cards to add to hand (default 1)
  mode?: 'main' | 'flash'; // for immediate triggers: 'main' (Main phase) or 'flash' (Flash timing)
  multiTarget?: boolean; // effect applies to multiple creatures/spirits
  targetType?: 'inheritance' | 'fatigued' | 'attacking'; // specific target selection criteria
  costAction?: EffectAction; // cost to activate this effect (e.g., discard_hand for ▶ effects)
  costValue?: number; // value for cost action
  costSymbol?: string; // symbol requirement for cost action
  costExhaustSelf?: boolean; // cost to activate this effect: exhaust the source card itself (e.g., nexus "疲労させる")
  duration?: 'battle' | 'turn'; // for boost_bp: 'battle' (このバトル中, expires when the battle ends) or 'turn' (このターン中, default)
  condition?: {
    minHandSize?: number;
    maxHandSize?: number; // maximum hand size for effect to activate
    requiresSymbol?: string; // requires this symbol color on field
    requiresFatiguedRed?: boolean; // requires fatigued red spirit on field
    requiresAdjacentSymbol?: string; // requires adjacent spirit with this symbol
    excludeEXSymbol?: boolean; // exclude cards with EX symbol
    excludeSoulCore?: boolean; // exclude soul cores (for place_core effects)
    onlySoulCore?: boolean; // only use soul cores (for place_core effects)
    requiresNexus?: boolean; // requires at least one nexus on field
    requiresSpirit?: { lineage?: string; count?: number }; // requires specific spirit(s)
    opponentHasNexus?: boolean; // opponent must have nexus
    requiresSkill?: string; // requires card with specific skill (e.g., "継召")
    excludeTargetSkill?: string; // for destroy_nexus: exclude targets with this skill (e.g., "真界放")
    maxCost?: number; // for trash_to_hand: only cards with cost <= this value are eligible
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
  cardSet?: string; // card set information (e.g., "26RSD01 バトスピエントリーデッキ 赫焔ノ風牙")
  skill?: string; // card skill (e.g., "真界放", "継召", "ソウルマジック：赤")
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
  /** temporary BP boost from effects (このターン中; reset at end of turn) */
  bpBoost?: number;
  /** temporary BP boost lasting only the current battle (このバトル中; reset when the battle resolves) */
  bpBoostBattle?: number;
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
  /** soul cores placed on this nexus */
  soulCoreCount: number;
  /** cores placed on this nexus */
  placedCores?: number;
  /** exhausted (疲労) — e.g. paid as an activation cost; recovers at refresh */
  exhausted?: boolean;
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
  damageThisTurn?: number; // tracks damage taken this turn (for Soul Magic red conditions)
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
  stashedAttack?: PendingAttack; // attack waiting to become pendingAttack once this flash window closes
}

export interface PendingAttack {
  attackerPlayer: number; // who is attacking
  attackerSpiritIndex: number; // which spirit is attacking
  damage: number; // base damage (symbol count if no defense)
}

export type GamePhase = 'start' | 'core' | 'draw' | 'refresh' | 'main' | 'attack' | 'main2' | 'end';

export interface PendingDraw {
  openedCards: CardDef[]; // all cards opened from deck
  toHandIndices: number[]; // indices of cards that go to hand (player selects from selectableIndices)
  toRearrangeIndices: number[]; // indices of cards to be rearranged and put back to deck bottom
  selectableIndices?: number[]; // indices of cards that can be selected for hand (風牙系統かつオファーリングドロー以外)
  castCard?: CardDef; // the card that triggered this draw (to trigger effects after selection)
  targetSpiritIndex?: number; // from original use_magic action
  effectValue?: number; // from original use_magic action
}

export interface PendingRockPaperScissors {
  rocksChoices?: (0 | 1 | 2)[]; // 0=rock, 1=paper, 2=scissors; undefined = awaiting choice
  p0Choice?: 0 | 1 | 2; // temporary storage for player 0's choice while waiting for player 1
  decidingPlayer: number; // player who must choose order (0 or 1) after winning RPS
}

export interface PendingMulligan {
  player: number; // player who must decide keep/redraw next (0 or 1)
  firstPlayer: number; // player who goes first (determined in order choice)
}

export interface EffectResult {
  description: string; // 日本語での効果結果の説明
  type: 'draw' | 'boost_bp' | 'damage' | 'heal' | 'destroy' | 'place_core' | 'other';
}

export interface GameState {
  players: [PlayerState, PlayerState];
  currentPlayer: number;
  turnCount: number;
  phase: GamePhase;
  battle: BattleState | null;
  result: { winner: number | null } | null;
  pendingRockPaperScissors?: PendingRockPaperScissors | null; // if set, in initial RPS or order-choosing phase
  pendingFlash?: PendingFlash | null; // if set, opponent has a flash opportunity
  pendingAttack?: PendingAttack | null; // if set, defending player can choose to block
  pendingDraw?: PendingDraw | null; // if set, player must select card(s) from opened deck
  pendingMulligan?: PendingMulligan | null; // if set, a player must decide to keep or redraw their opening hand
}

export type Action =
  | { type: 'rock_paper_scissors'; choice: 0 | 1 | 2 } // 0=rock, 1=paper, 2=scissors
  | { type: 'choose_order'; goFirst: boolean } // winner chooses to go first or second
  | { type: 'summon'; handIndex: number; targetNexusIndex?: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean }
  | { type: 'add_core'; spiritIndex?: number; nexusIndex?: number; coreType?: 'regular' | 'soul' } // move 1 core from reserve onto a spirit or nexus (level-up)
  | {
      type: 'move_core'; // freely move 1 core between reserve/spirit/nexus (main steps only, via drag & drop)
      fromZone: 'reserve' | 'spirit' | 'nexus';
      fromIndex?: number;
      toZone: 'reserve' | 'spirit' | 'nexus';
      toIndex?: number;
      coreType: 'regular' | 'soul';
    }
  | { type: 'place_nexus'; handIndex: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean }
  | { type: 'use_magic'; handIndex: number; targetNexusIndex?: number; targetSpiritIndex?: number; effectValue?: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean }
  | { type: 'attack'; spiritIndex: number; defendingSpiritIndex?: number; discardCardIndex?: number; effectTargetIndex?: number } // discardCardIndex for effects requiring card selection; effectTargetIndex for effects requiring an own-spirit target (e.g. place_core)
  | { type: 'block'; spiritIndex: number } // ブロック：相手の攻撃に対してスピリットで迎撃
  | { type: 'take_damage' } // ダメージ受け入れ：防御せずにダメージを受ける
  | { type: 'pass' } // end current action phase
  | { type: 'flash'; handIndex: number; targetCard?: string; targetSpiritIndex?: number; targetNexusIndex?: number; effectValue?: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number } // activate a flash magic card
  | { type: 'skip_flash' } // pass on flash opportunity
  | { type: 'select_draw_arrange'; selectedCardIndices?: number[]; arrangedCardIndices?: number[]; cardIndices?: number[] } // arrange and select cards for offering draw
  | { type: 'mulligan'; redraw: boolean }; // opening hand: keep as-is, or shuffle it back and redraw (no selection)
