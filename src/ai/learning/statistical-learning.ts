/**
 * 統計学習エンジン
 * ゲーム結果から各カードの勝率を集計し、統計ベースのデッキ構築を行う
 */

import { CARD_DB } from '../../games/battlspirits/cards.js';
import { gameLogger, type LearningDatabase } from './game-logger.js';

export interface CardStats {
  cardId: string;
  name: string;
  winRate: number; // 0.0-1.0
  playRate: number; // 使用頻度
  confidence: number; // 統計的信頼度（ゲーム数に基づく）
  gamesPlayed: number;
}

export interface StatisticalModel {
  cardStats: CardStats[];
  totalGames: number;
  lastUpdated: number;
}

/**
 * 統計学習エンジン
 */
export class StatisticalLearning {
  private model: StatisticalModel;
  private minGamesForConfidence = 10; // 信頼度のための最小ゲーム数

  constructor() {
    this.model = this.buildModel();
  }

  /**
   * 統計モデルを構築
   */
  private buildModel(): StatisticalModel {
    const db = gameLogger.getDatabase();
    const cardStats = this.calculateCardStats(db);

    return {
      cardStats,
      totalGames: db.gameResults.length,
      lastUpdated: Date.now(),
    };
  }

  /**
   * カード統計を計算
   */
  private calculateCardStats(db: LearningDatabase): CardStats[] {
    const allCards = Object.entries(CARD_DB);
    const stats: CardStats[] = [];

    for (const [cardId, cardDef] of allCards) {
      const cardStat = db.cardStatistics[cardId];
      const gamesPlayed = cardStat?.timesPlayed ?? 0;
      const wins = cardStat?.timesInWinningDeck ?? 0;
      const losses = cardStat?.timesInLosingDeck ?? 0;
      const total = wins + losses;

      // 信頼度：ゲーム数に基づく
      const confidence = Math.min(1.0, total / this.minGamesForConfidence);

      // 勝率：ベイズ推定を使用（少ないデータでも安定）
      const winRate = total > 0
        ? (wins + confidence * 0.5) / (total + confidence)
        : 0.5;

      stats.push({
        cardId,
        name: cardDef.name,
        winRate,
        playRate: total > 0 ? gamesPlayed / total : 0,
        confidence,
        gamesPlayed,
      });
    }

    // 勝率でソート
    return stats.sort((a, b) => b.winRate - a.winRate);
  }

  /**
   * デッキを推奨（勝率に基づく貪欲法）
   */
  recommendDeck(
    cardCount: number = 40,
    minConfidence: number = 0.0
  ): { cardId: string; count: number }[] {
    const filtered = this.model.cardStats.filter(s => s.confidence >= minConfidence);

    // 勝率でソート（降順）
    const sorted = [...filtered].sort((a, b) => b.winRate - a.winRate);

    const deck: { [cardId: string]: number } = {};
    let deckSize = 0;

    // 上位のカードから3枚まで追加
    for (const stat of sorted) {
      for (let i = 0; i < 3 && deckSize < cardCount; i++) {
        if (!deck[stat.cardId]) {
          deck[stat.cardId] = 0;
        }
        deck[stat.cardId]!++;
        deckSize++;
      }
    }

    return Object.entries(deck).map(([cardId, count]) => ({ cardId, count }));
  }

  /**
   * レート別デッキを生成（高レートは高勝率カード、低レートはランダム混成）
   */
  deckForRating(rating: number, cardCount: number = 40): { cardId: string; count: number }[] {
    // レート1700を基準に、±200で信頼度を調整
    const minConfidence = Math.max(0, 1 - Math.abs(rating - 1700) / 200);

    // 高レートは信頼度の高いカードのみ、低レートは多様性を重視
    if (minConfidence > 0.7) {
      // 高レート：勝率が高いカードに絞る
      return this.recommendDeck(cardCount, minConfidence * 0.8);
    } else if (minConfidence > 0.4) {
      // 中レート：ある程度の多様性
      return this.recommendDeck(cardCount, minConfidence * 0.5);
    } else {
      // 低レート：信頼度の制限なし
      return this.recommendDeck(cardCount, 0);
    }
  }

  /**
   * 個別カードの統計を取得
   */
  getCardStats(cardId: string): CardStats | undefined {
    return this.model.cardStats.find(s => s.cardId === cardId);
  }

  /**
   * トップNのカードを取得
   */
  getTopCards(n: number = 10): CardStats[] {
    return this.model.cardStats.slice(0, n);
  }

  /**
   * モデルの統計情報を取得
   */
  getModel(): StatisticalModel {
    return this.model;
  }

  /**
   * モデルを更新
   */
  updateModel(): void {
    this.model = this.buildModel();
  }
}

/**
 * グローバル統計学習インスタンス
 */
export const statisticalLearning = new StatisticalLearning();
