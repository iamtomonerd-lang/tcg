# ゲン＝ガタ限定ルール実装 - 設計仕様書 Phase 1

**作成日**: 2026-07-20  
**ステータス**: 設計確定（実装前）

---

## 🎯 目的

Battle Spirits の本質的なゲームエンジンをスクラッチから実装する。  
ゲン＝ガタを中心にシンプルなルール定義から始め、将来的に複雑な機能（継召、フラッシュ、スキル）を追加可能な設計。

---

## 📐 層構成

### 層0: マッチ設定（ルール選択）

ゲームの「どんなマッチか」を定義。複数ゲーム、異なるルール形式に対応。

```typescript
type MatchConfig = {
  format: 'standard' | 'limited';
  winCondition: 'best-of-1' | 'best-of-3' | 'best-of-5';
  timeLimit?: number;
  restrictedCards?: string[];
};

type MatchState = {
  config: MatchConfig;
  games: GameState[];
  currentGameIndex: number;
  wins: [number, number];
  matchOver: boolean;
  winner?: 0 | 1;
};
```

**責務:**
- マッチ形式を指定
- 複数ゲーム管理
- n本先取の勝者判定

**拡張性:**
- 構築限定戦のブロック制限
- 新しいマッチ形式の追加

---

### 層1: ゲーム状態の型定義

ゲームに必要な全データの「形」を定義。ルール上意味のある情報と構築上意味を持つ情報を分離。

#### PlayerState: プレイヤー情報

```typescript
type PlayerState = {
  // 基本情報
  life: number;

  // ゾーン
  hand: Card[];
  deck: Card[];
  reserves: number;        // リザーブ（コア数）
  trashCores: number;      // トラッシュ内のコア数
  field: Spirit[];         // 場（スピリット・ネクサス）
  trash: Card[];           // トラッシュ（カード）
  excluded: Card[];        // 除外ゾーン（継召で使われたカード）
};
```

**ゾーン解説:**
- **reserves**: 毎ターン +1、召喚時に -n、ダメージ受時に +n
- **trashCores**: リフレッシュフェーズで reserves に戻る
- **trash**: 破壊されたカード、継召で選ぶ
- **field**: スピリット・ネクサス
- **excluded**: 継召で使われたカード（ゲーム中復帰不可）

---

#### Card: カード定義

```typescript
type Card = {
  // ─── ルール上意味のある情報 ───
  id: string;
  name: string;
  cardType: 'spirit' | 'nexus' | 'magic';
  cost: number;
  reduction: {
    symbolCount: number;
    symbolColors: string[];
  };
  lineage: string[];
  text: string;
  levels: CardLevel[];
  attribute?: string;
  effects: Effect[];

  // ─── 構築上意味を持つ情報 ───
  cardNumber?: string;
  rarity?: string;
  blockIcon?: string;
  artworkIcon?: string;
};

type CardLevel = {
  level: 1 | 2 | 3;
  bp: number;
};

type Effect = {
  trigger: 'summon' | 'attack' | 'destroy' | 'flash';
  action: string;
  minLevel?: number;    // Lv依存の発動条件
};
```

**設計のポイント:**
- **levels**: 複数のレベルを配列で管理（Lv1とLv2で BP が異なる）
- **effects**: minLevel でレベル依存性を表現
- **reduction**: 軽減シンボル（将来の継召対応）
- **構築情報**: ゲームロジックでは使わない（UI/デッキ構築のみ）

---

#### Spirit: 場のスピリット

```typescript
type Spirit = {
  def: Card;
  level: 1 | 2 | 3;
  cores: number;        // 乗ってるコア
};
```

---

#### ゲーム全体の状態

```typescript
type Phase = 'start' | 'draw' | 'main1' | 'attack' | 'main2' | 'end';

type GameState = {
  players: [PlayerState, PlayerState];
  currentPlayerIndex: 0 | 1;
  currentPhase: Phase;
  gameOver: boolean;
  winner?: 0 | 1;
};
```

---

### 層2: 基本ルール（ゲームの本質）

「何ができるのか」「何をするとどうなるのか」を実装。一度決めたら変わらない基本ルール。

**責務:**

1. **フェーズシステム**
   - フェーズの定義（start, draw, main1, attack, main2, end）
   - 各フェーズでの許可アクション
   - フェーズ遷移ルール（拡張可能：カード効果で変更可能）

2. **基本アクション**
   - 召喚（コスト4消費）
   - 攻撃（ダメージ1与える）
   - コア管理（毎ターン +1、ダメージ受時に +n）

3. **ゲーム終了判定**
   - `checkWinCondition()`: 生命0以下で敗北

4. **フラッシュタイミング定義**
   - 「アタックフェーズでのみフラッシュタイミング発動」などを定義
   - 実際のフラッシュ効果は後で（層3.2）

**ゲン＝ガタ段階での実装:**
- ✅ フェーズシステムの骨組み
- ✅ 召喚・攻撃・コア管理
- ✅ 勝利条件判定
- ✅ フラッシュタイミング定義（効果なし）

**将来の拡張:**
- フェーズ遷移の複雑化（カード効果でフェーズ追加など）

---

### 層3: ゲーム進行（状態管理）

「ゲームがどう進むのか」を制御。状態遷移、アクション実行、進行管理。

**責務:**

1. **フェーズ進行管理**
   - 現在のフェーズを管理
   - フェーズ遷移を実行
   - 各フェーズの自動処理（ドロー、コア +1 など）

2. **アクション実行**
   - プレイヤーのアクションを受け取る
   - 層2のルールに従って実行
   - 状態を更新

3. **フラッシュウィンドウ制御**
   - アタックフェーズ中、フラッシュタイミング発動
   - プレイヤーに「フラッシュするか？」を選択させる

4. **ゲーム終了判定の実行**
   - 層2 の checkWinCondition() を呼び出し
   - gameOver = true なら終了

**ゲン＝ガタ段階での実装:**
- ✅ ターン順序管理
- ✅ ドロー・コア +1 の自動実行
- ✅ フェーズ遷移
- ✅ フラッシュタイミング発動処理（効果なし）

---

### 層3.2: 効果エンジン（カード効果実行）

**将来の機能**。ゲン＝ガタ段階では実装しない。

カード効果を統一的に実行するエンジン。

```typescript
// 将来
type EffectAction = {
  trigger: 'summon' | 'attack' | 'destroy' | 'flash';
  action: string;
  execute: (state: GameState, context: ExecutionContext) => GameState;
};
```

**責務:**
- trigger（いつ発火するか）で分類
- action（何をするか）を実行
- minLevel などの条件判定

**将来の拡張:**
- 継召効果
- フラッシュ効果
- スキル効果
- etc.

---

### 層3.5: カード定義

カードデータベース。ゲーム中に参照される。

```typescript
const CARDS = [
  {
    id: 'spirit_gun_gata',
    name: 'ゲン＝ガタ',
    cardType: 'spirit',
    cost: 4,
    reduction: { symbolCount: 3, symbolColors: ['red'] },
    lineage: ['風牙'],
    text: '効果なし',
    levels: [
      { level: 1, bp: 5000 },
      { level: 2, bp: 7000 }
    ],
    attribute: '赤',
    effects: [],
    cardNumber: '26RSD01-002',
    rarity: 'C',
    blockIcon: 'entry-deck',
    artworkIcon: 'rd01'
  },
  // ... more cards
];
```

**ゲン＝ガタ段階:**
- ✅ ゲン＝ガタのみ（効果なし）

**将来の拡張:**
- 継召持ちカード
- フラッシュ効果カード
- etc.

---

### 層4: API・UI連携

Express API、React コンポーネント。

**責務:**
- GameState → JSON 変換
- UI コンポーネントに送信
- プレイヤーのアクション受け取り

**ゲン＝ガタ段階:**
- ✅ GameBoard, PlayerPanel の表示
- ✅ アクション送信

---

## 🔄 データフロー（ゲン＝ガタ）

```
層0: MatchState
  └─ ゲーム1開始
      ↓
層1: GameState（初期化）
  ├─ players[0].life = 5
  ├─ players[0].hand = 4枚
  ├─ players[0].reserves = 0
  └─ currentPhase = 'start'
      ↓
層3: ゲーム進行
  ├─ フェーズ遷移（start → draw → main1 → attack → main2 → end）
  ├─ 各フェーズで自動処理
  ├─ プレイヤーのアクション実行
  └─ 層2 のルールに従って状態更新
      ↓
層2: 基本ルール
  ├─ 「召喚できるか」判定
  ├─ 「攻撃ダメージ計算」実行
  ├─ 「生命0で敗北」判定
  └─ 状態を返す
      ↓
層4: API・UI
  └─ GameState を JSON 化して送信
```

---

## 🎯 「ここまでは確定」宣言

**以下の設計は実装前に確定しました：**

- ✅ 層0: MatchConfig, MatchState
- ✅ 層1: PlayerState, Card, CardLevel, Effect, GameState
- ✅ 層2: フェーズシステム、基本ルール、勝利条件
- ✅ 層3: ゲーム進行管理
- ✅ 層3.2～4: 役割定義（詳細は後）

**ルール確認中に発見があれば、この設計を修正します。**

---

## 📋 ルール確認チェックリスト

ルールブック確認で以下を検証：

```
[ ] 初期生命：5 で正しいか
[ ] 初期手札：4 枚で正しいか
[ ] ゲン＝ガタ BP：5000 で正しいか
[ ] ゲン＝ガタ ダメージ：1 で正しいか
[ ] ゲン＝ガタ コスト：4 で正しいか
[ ] 毎ターン +1 コアで正しいか
[ ] ダメージ受時の +コアで正しいか
[ ] フェーズ順序：start → draw → main1 → attack → main2 → end で正しいか
[ ] フラッシュタイミング：attack のみで正しいか
[ ] その他確認事項
```

---

## 🚀 次のステップ

1. **ルールブック確認を続ける**（項目ごと）
2. **発見があれば、この設計を修正**
3. **設計確定後、層2～4 の詳細設計**
4. **実装開始**

---

## 参考

- **GEN_GATA_RULES.md**: ゲーム仕様書（ルール定義）
- **DEPENDENCY_MAP.md**: 依存関係分析（旧版、参考用）
