/**
 * Battle Spirits card and game types. Effects are 100% data-driven.
 */

export type CardType = 'spirit' | 'nexus' | 'magic';
export type EffectAction = 'damage' | 'heal' | 'draw' | 'boost_bp' | 'search_deck' | 'destroy_creature' | 'trash_to_hand' | 'place_core' | 'discard_hand' | 'destroy_nexus';
export type EffectTrigger = 'summon' | 'attack' | 'block' | 'destroy' | 'immediate' | 'battle_end' | 'end_step' | 'opponent_summon' | 'opponent_attack' | 'opponent_magic';
export type FlashTrigger = 'opponent_summon' | 'opponent_attack' | 'opponent_magic' | 'opponent_destroy' | 'opponent_block';

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
  oncePerTurn?: boolean; // 〔ターン1回〕: this activated effect can only be used once per turn
  targetLineage?: string; // required lineage of the target spirit (e.g. 風牙岩: "アタックしている系統：「風牙」を持つ自分のスピリット")
  duration?: 'battle' | 'turn'; // for boost_bp: 'battle' (このバトル中, expires when the battle ends) or 'turn' (このターン中, default)
  condition?: {
    minHandSize?: number;
    maxHandSize?: number; // maximum hand size for effect to activate
    requiresSymbol?: string; // requires this symbol color on field
    requiresFatiguedRed?: boolean; // requires fatigued red spirit on field
    requiresFatiguedLineage?: string; // requires fatigued spirit with this lineage on field
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
  /** 〔ターン1回〕【起動：フラッシュ】 already used this turn (reset at refresh) */
  flashActivatedThisTurn?: boolean;
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
  bottomDeckCards: CardDef[]; // cards placed at bottom of deck (from magic_offering_draw), in order (first = closest to bottom)
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
  stashedDefenderSpiritIndex?: number; // defender spirit index for after-block flash window
  stashedAttackData?: { attackBP: number; defendBP: number }; // BP values for battle resolution after block flash
  passCount?: number; // consecutive skip_flash count (2-pass rule: window closes after both players pass)
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
  targetNexusIndex?: number; // from original use_magic action
  effectValue?: number; // from original use_magic action
  maxSelectable?: number; // maximum number of cards that can be selected (default 2 for magic_offering_draw, 1 for attack search_deck)
  returnDestination?: 'deck' | 'trash'; // where to put remaining cards (default 'deck' for magic_offering_draw, 'trash' for attack search_deck)
  originAttackSpiritIndex?: number; // if set, this search_deck came from an attack and should continue attack flow after selection
  originAttackPlayer?: number; // which player is attacking (for search_deck from attack)
}

export interface PendingDiceRoll {
  p0Roll?: number; // Player 0's dice roll (1-6); undefined = awaiting roll
  p1Roll?: number; // Player 1's dice roll (1-6); undefined = awaiting roll
  winner?: number; // Player who won the dice roll (0 or 1); determines order choice
}

export interface PendingMulligan {
  player: number; // player who must decide keep/redraw next (0 or 1)
  firstPlayer: number; // player who goes first (determined in order choice)
}

export interface PendingSpellChain {
  summonedSpiritIndex: number; // index of the newly summoned spirit
  summonedCard: CardDef; // card definition of the newly summoned spirit
  destructedSpiritIndices: number[]; // indices of spirits that will be destroyed by the summon effect(s)
  destructedNexusIndices: number[]; // indices of nexuses that will be destroyed
}

export interface PendingSpiritDepletion {
  spiritIndex: number; // index of the spirit that will be depleted
  spiritCard: CardDef; // card definition of the spirit
  requiredCores: number; // required Lv1 cost
  currentCores: number; // current cores (regular + soul)
}

export interface PendingNexusDepletion {
  nexusIndex: number; // index of the nexus that will be depleted
  nexusCard: CardDef; // card definition of the nexus
  requiredCores: number; // required Lv1 cost
  currentCores: number; // current cores (regular + soul)
}

export interface PendingEffectAction {
  effect: CardEffect; // the effect that requires target selection
  sourceCard: CardDef; // the card that owns this effect
  sourcePlayer: number; // player who owns the card
  spiritIndex?: number; // index of spirit that triggered the effect (if any)
  sourceNexusIndex?: number; // index of nexus that triggered the effect (if any)
  validTargets: { spiritIndices: number[]; nexusIndices: number[] }; // valid target indices
  trigger: string; // the trigger type ('end_step', etc.)
  remainingEffects: Array<{ card: CardDef; spiritIndex?: number; nexusIndex?: number; level?: 1 | 2 }>; // remaining effects to process after this one
}

export interface PendingInheritanceSelection {
  cardHandIndex: number; // 手札のカード位置
  cardName: string; // UI表示用
  maxInheritanceCount: number; // 最大継召可能枚数
  selectedInheritanceCount: number; // プレイヤーが選択した使用枚数（0 = 未選択）
  inheritanceCandidates: {
    id: string;
    name: string;
    imagePath?: string; // カード画像パス（UI表示用）
    cardType?: CardType; // カードタイプ（表示用：不要ならUI側で無視してよい）
    symbolColors: string[];
  }[]; // トラッシュの対応EXカード候補
  selectedCardIds: string[]; // プレイヤーが選択したカードID（空配列 = 未選択）
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
  pendingDiceRoll?: PendingDiceRoll | null; // if set, in initial dice roll phase or order-choosing phase
  pendingFlash?: PendingFlash | null; // if set, opponent has a flash opportunity
  pendingAttack?: PendingAttack | null; // if set, defending player can choose to block
  pendingDraw?: PendingDraw | null; // if set, player must select card(s) from opened deck
  pendingMulligan?: PendingMulligan | null; // if set, a player must decide to keep or redraw their opening hand
  pendingSpellChain?: PendingSpellChain | null; // if set, confirm if summon effects should destroy opponent's spirits/nexuses
  pendingSpiritDepletion?: PendingSpiritDepletion | null; // if set, confirm if spirit should be depleted or player adds core
  pendingNexusDepletion?: PendingNexusDepletion | null; // if set, confirm if nexus should be depleted or player adds core
  pendingEffectAction?: PendingEffectAction | null; // if set, player must select target for an effect (e.g., end_step place_core)
  pendingInheritanceSelection?: PendingInheritanceSelection | null; // if set, player must select EX cards from trash for inheritance
}

export type Action =
  | { type: 'dice_roll'; roll: 1 | 2 | 3 | 4 | 5 | 6 } // Player rolls 1-6 dice
  | { type: 'choose_order'; goFirst: boolean } // Winner chooses to go first or second
  | { type: 'summon'; handIndex: number; targetNexusIndex?: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean; paymentPlan?: any }
  | { type: 'add_core'; spiritIndex?: number; nexusIndex?: number; coreType?: 'regular' | 'soul' } // move 1 core from reserve onto a spirit or nexus (level-up)
  | {
      type: 'move_core'; // freely move 1 core between reserve/spirit/nexus (main steps only, via drag & drop)
      fromZone: 'reserve' | 'spirit' | 'nexus';
      fromIndex?: number;
      toZone: 'reserve' | 'spirit' | 'nexus';
      toIndex?: number;
      coreType: 'regular' | 'soul';
    }
  | { type: 'place_nexus'; handIndex: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean; paymentPlan?: any }
  | { type: 'use_magic'; handIndex: number; targetNexusIndex?: number; targetSpiritIndex?: number; effectValue?: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean; paymentPlan?: any }
  | { type: 'attack'; spiritIndex: number; defendingSpiritIndex?: number; discardCardIndex?: number; effectTargetIndex?: number } // discardCardIndex for effects requiring card selection; effectTargetIndex for effects requiring an own-spirit target (e.g. place_core)
  | { type: 'block'; spiritIndex: number } // ブロック：相手の攻撃に対してスピリットで迎撃
  | { type: 'take_damage' } // ダメージ受け入れ：防御せずにダメージを受ける
  | { type: 'pass' } // end current action phase
  | { type: 'flash'; handIndex: number; targetCard?: string; targetSpiritIndex?: number; targetNexusIndex?: number; effectValue?: number; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean; paymentPlan?: any } // activate a flash magic card
  | { type: 'activate_flash'; sourceType: 'spirit' | 'nexus'; sourceIndex: number; discardCardIndex?: number; targetSpiritIndex?: number } // 【起動：フラッシュ】: pay activation cost (discard/exhaust) ▶ resolve effect
  | { type: 'skip_flash' } // pass on flash opportunity
  | { type: 'select_draw_arrange'; selectedCardIndices?: number[]; arrangedCardIndices?: number[]; cardIndices?: number[] } // arrange and select cards for offering draw
  | { type: 'mulligan'; redraw: boolean } // opening hand: keep as-is, or shuffle it back and redraw (no selection)
  | { type: 'confirm_spell_chain'; proceed: boolean } // confirm if summon effects should destroy opponent's spirits/nexuses (true=proceed, false=cancel)
  | { type: 'confirm_spirit_depletion'; proceed: boolean } // confirm if spirit should be depleted (true=deplete, false=cancel)
  | { type: 'confirm_nexus_depletion'; proceed: boolean } // confirm if nexus should be depleted (true=deplete, false=cancel)
  | { type: 'select_effect_target'; targetSpiritIndex?: number; targetNexusIndex?: number } // select target for effect requiring target selection
  | { type: 'select_inheritance'; selectedCardIds: string[]; inheritanceCount?: number }; // select inheritance count and EX cards from trash

/**
 * プレイヤーの開始設定（Configuration Injection）
 *
 * 責務:
 * - ゲーム開始時の初期条件をすべて指定
 * - ゲーム中に変化しない（Immutable）
 * - プレイヤーのアイデンティティ情報は含まない（メタデータは別で管理）
 *
 * 非責務:
 * - ゲーム中の状態（PlayerState で管理）
 * - プレイヤーの名前、ID、レート（メタデータは別で管理）
 * - AIエージェント情報（API層で管理）
 */
export interface PlayerConfig {
  /** ゲーム開始時のデッキ（順序済み、シャッフル前）40枚 */
  deck: CardDef[];

  /** 初期ライフ（デフォルト: 5） */
  initialLife?: number;

  /** 初期リザーブコア（デフォルト: 3） */
  initialCores?: number;

  /** 初期ソウルコア（デフォルト: 1） */
  initialSoulCores?: number;

  /** 将来のルール拡張用に予約 */
  customRules?: Record<string, any>;
}

/**
 * ゲームルール設定
 *
 * Battle Spirits のルールは基本的に固定だが、
 * 将来的なルール変更やバリエーション対応のため予約
 */
export interface GameRuleConfig {
  /** 初期ライフ（デフォルト: 5） */
  startingLife?: number;

  /** 初期リザーブコア（デフォルト: 3） */
  startingCores?: number;

  /** 初期ソウルコア（デフォルト: 1） */
  startingSoulCores?: number;

  /** 初期手札サイズ（デフォルト: 4） */
  startingHandSize?: number;
}

/**
 * ゲーム開始時の完全な設定（Configuration Injection）
 *
 * 責務:
 * - ゲーム初期化に必要な情報をすべて保持
 * - ゲーム中に変化しない（Immutable）
 * - 完全にシリアライズ可能（JSON化可能）
 * - 決定論を確保（同じconfig + 同じrngSeed = 同じゲーム展開）
 *
 * 非責務:
 * - ゲーム中の状態管理（GameState の責務）
 * - ランタイム情報（sessionId, websocket, DB接続など）
 * - RNG インスタンスの管理（createInitialState 内で生成）
 * - メタデータ（プレイヤー名、レート、マッチID など）
 */
export interface GameConfig {
  /** プレイヤーの開始設定 */
  players: [PlayerConfig, PlayerConfig];

  /**
   * 乱数シード（32bit 整数）
   *
   * 理由:
   * - GameConfig を完全にシリアライズ可能にする
   * - RNG インスタンスは createInitialState 内で生成
   * - 同じシードを使えば必ず同じゲーム展開が再現される（決定論）
   * - テストやリプレイシステムに対応可能
   */
  rngSeed: number;

  /**
   * ゲームモード
   * - 'free-battle': 自由対戦（初期設定）
   * - 'ranked': レート戦
   * - 'training': AI トレーニング
   *
   * 用途: ログ、統計、将来のルール差異対応
   */
  gameMode?: 'free-battle' | 'ranked' | 'training' | string;

  /** ゲームルール設定 */
  ruleConfig?: GameRuleConfig;

  /** タイムスタンプ（ログ、統計用）*/
  timestamp?: number;
}
