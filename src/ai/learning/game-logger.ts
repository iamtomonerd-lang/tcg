/**
 * ゲーム結果ロギングシステム
 * Battle Spiritsのゲーム結果を記録して、機械学習の訓練データとして使用
 */

export interface CardUsage {
  cardId: string;
  count: number;
  timesPlayed: number;
  timesInWinningDeck: number;
  timesInLosingDeck: number;
}

export interface GameResult {
  timestamp: number;
  player0Rating: number;
  player1Rating: number;
  winnerId: number; // 0 or 1
  winnerRating: number;
  loserRating: number;
  turnCount: number;
  player0Deck: { cardId: string; count: number }[];
  player1Deck: { cardId: string; count: number }[];
  player0CardsPlayed: string[];
  player1CardsPlayed: string[];
  damageDealt: number[]; // [player0ToPlayer1, player1ToPlayer0]
  spiritsDestroyed: number; // total
}

export interface LearningDatabase {
  gameResults: GameResult[];
  cardStatistics: { [cardId: string]: CardUsage };
  deckWinRates: { [deckSignature: string]: { wins: number; losses: number } };
  lastUpdated: number;
}

/**
 * ゲームロガー：ゲーム結果を記録・管理
 */
export class GameLogger {
  private db: LearningDatabase;
  private dbKey = 'battle-spirits-learning-db';

  constructor() {
    this.db = this.loadDatabase();
  }

  /**
   * ローカルストレージからデータベースをロード
   */
  private loadDatabase(): LearningDatabase {
    if (typeof localStorage === 'undefined') {
      return this.createEmptyDatabase();
    }

    try {
      const stored = localStorage.getItem(this.dbKey);
      return stored ? JSON.parse(stored) : this.createEmptyDatabase();
    } catch (e) {
      console.warn('Failed to load learning database:', e);
      return this.createEmptyDatabase();
    }
  }

  /**
   * 空のデータベースを作成
   */
  private createEmptyDatabase(): LearningDatabase {
    return {
      gameResults: [],
      cardStatistics: {},
      deckWinRates: {},
      lastUpdated: Date.now(),
    };
  }

  /**
   * ゲーム結果をログに記録
   */
  recordGameResult(result: GameResult): void {
    this.db.gameResults.push(result);
    this.updateCardStatistics(result);
    this.updateDeckWinRates(result);
    this.db.lastUpdated = Date.now();
    this.saveDatabase();
  }

  /**
   * カード統計を更新
   */
  private updateCardStatistics(result: GameResult): void {
    const winnerDeck = result.winnerId === 0 ? result.player0Deck : result.player1Deck;
    const loserDeck = result.winnerId === 0 ? result.player1Deck : result.player0Deck;
    const winnerPlayed = result.winnerId === 0 ? result.player0CardsPlayed : result.player1CardsPlayed;
    const loserPlayed = result.winnerId === 0 ? result.player1CardsPlayed : result.player0CardsPlayed;

    // 勝者のデッキ内のカードを更新
    for (const { cardId, count } of winnerDeck) {
      if (!this.db.cardStatistics[cardId]) {
        this.db.cardStatistics[cardId] = {
          cardId,
          count,
          timesPlayed: 0,
          timesInWinningDeck: 0,
          timesInLosingDeck: 0,
        };
      }
      const stats = this.db.cardStatistics[cardId];
      stats.timesInWinningDeck += count;
      if (winnerPlayed.includes(cardId)) {
        stats.timesPlayed += count;
      }
    }

    // 敗者のデッキ内のカードを更新
    for (const { cardId, count } of loserDeck) {
      if (!this.db.cardStatistics[cardId]) {
        this.db.cardStatistics[cardId] = {
          cardId,
          count,
          timesPlayed: 0,
          timesInWinningDeck: 0,
          timesInLosingDeck: 0,
        };
      }
      const stats = this.db.cardStatistics[cardId];
      stats.timesInLosingDeck += count;
      if (loserPlayed.includes(cardId)) {
        stats.timesPlayed += count;
      }
    }
  }

  /**
   * デッキの勝率を更新
   */
  private updateDeckWinRates(result: GameResult): void {
    const winnerSignature = this.getDeckSignature(
      result.winnerId === 0 ? result.player0Deck : result.player1Deck
    );

    if (!this.db.deckWinRates[winnerSignature]) {
      this.db.deckWinRates[winnerSignature] = { wins: 0, losses: 0 };
    }
    this.db.deckWinRates[winnerSignature].wins++;

    const loserSignature = this.getDeckSignature(
      result.winnerId === 0 ? result.player1Deck : result.player0Deck
    );
    if (!this.db.deckWinRates[loserSignature]) {
      this.db.deckWinRates[loserSignature] = { wins: 0, losses: 0 };
    }
    this.db.deckWinRates[loserSignature].losses++;
  }

  /**
   * デッキのシグネチャを生成（重複排除用）
   */
  private getDeckSignature(deck: { cardId: string; count: number }[]): string {
    return deck
      .sort((a, b) => a.cardId.localeCompare(b.cardId))
      .map((c) => `${c.cardId}:${c.count}`)
      .join('|');
  }

  /**
   * カードの勝率を取得
   */
  getCardWinRate(cardId: string): number {
    const stats = this.db.cardStatistics[cardId];
    if (!stats || stats.timesInWinningDeck + stats.timesInLosingDeck === 0) {
      return 0.5; // デフォルト値
    }
    return stats.timesInWinningDeck / (stats.timesInWinningDeck + stats.timesInLosingDeck);
  }

  /**
   * デッキの勝率を取得
   */
  getDeckWinRate(deck: { cardId: string; count: number }[]): number {
    const signature = this.getDeckSignature(deck);
    const stats = this.db.deckWinRates[signature];
    if (!stats || stats.wins + stats.losses === 0) {
      return 0.5;
    }
    return stats.wins / (stats.wins + stats.losses);
  }

  /**
   * 統計データベースを取得
   */
  getDatabase(): LearningDatabase {
    return this.db;
  }

  /**
   * ゲーム結果を取得
   */
  getGameResults(limit?: number): GameResult[] {
    if (!limit) return this.db.gameResults;
    return this.db.gameResults.slice(-limit);
  }

  /**
   * カード統計を取得
   */
  getCardStatistics(): { [cardId: string]: CardUsage } {
    return this.db.cardStatistics;
  }

  /**
   * データベースをセーブ
   */
  private saveDatabase(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.dbKey, JSON.stringify(this.db));
    } catch (e) {
      console.warn('Failed to save learning database:', e);
    }
  }

  /**
   * データベースをクリア（テスト用）
   */
  clearDatabase(): void {
    this.db = this.createEmptyDatabase();
    this.saveDatabase();
  }

  /**
   * データベースをエクスポート（バックアップ用）
   */
  exportDatabase(): string {
    return JSON.stringify(this.db, null, 2);
  }

  /**
   * データベースをインポート（復元用）
   */
  importDatabase(json: string): void {
    try {
      this.db = JSON.parse(json);
      this.saveDatabase();
    } catch (e) {
      console.error('Failed to import database:', e);
    }
  }
}

/**
 * グローバルロガーインスタンス
 */
export const gameLogger = new GameLogger();
