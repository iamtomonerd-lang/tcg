/**
 * 強化学習エンジン（ISMCTS活用）
 * ISMCTS エージェント同士の自己対戦からカード価値を学習
 */

import { BattlSpiritsGame } from '../../games/battlspirits/game.js';
import { IsmctsAgent } from '../ismcts.js';
import { Mulberry32 } from '../../core/rng.js';
import { gameLogger, type GameResult } from './game-logger.js';

export interface CardValue {
  cardId: string;
  qValue: number; // Q値（価値推定）
  visitCount: number; // 訪問回数
  winCount: number; // 勝利回数
}

export interface ReinforcementModel {
  cardValues: { [cardId: string]: CardValue };
  totalPlayouts: number;
  lastUpdated: number;
}

/**
 * 強化学習エンジン
 */
export class ReinforcementLearning {
  private model: ReinforcementModel;

  constructor() {
    this.model = {
      cardValues: {},
      totalPlayouts: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * 自己対戦ゲームを実行（未実装 - ゲームロガーから学習を使用）
   */
  runSelfPlayGame(iterations: number = 1): GameResult[] {
    const results: GameResult[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = this.playSingleGame();
      if (result) {
        results.push(result);
        gameLogger.recordGameResult(result);
        this.updateCardValues(result);
      }
    }

    this.model.lastUpdated = Date.now();
    return results;
  }

  /**
   * 1ゲームを実行（未実装 - null を返す）
   */
  private playSingleGame(): GameResult | null {
    return null;
  }

  /**
   * ゲーム結果からカード価値を更新（Q学習）
   */
  updateCardValues(result: GameResult): void {
    const winnerDeck = result.winnerId === 0 ? result.player0Deck : result.player1Deck;
    const loserDeck = result.winnerId === 0 ? result.player1Deck : result.player0Deck;
    const winnerPlayed = result.winnerId === 0 ? result.player0CardsPlayed : result.player1CardsPlayed;

    // 勝者のカードはQ値を上げる
    for (const { cardId } of winnerDeck) {
      if (!this.model.cardValues[cardId]) {
        this.model.cardValues[cardId] = {
          cardId,
          qValue: 0.5,
          visitCount: 0,
          winCount: 0,
        };
      }

      const value = this.model.cardValues[cardId];
      const wasPlayed = winnerPlayed.includes(cardId);
      const reward = wasPlayed ? 1.0 : 0.5; // 実際に使われたら高い報酬

      // Q値更新（移動平均）
      value.qValue = (value.qValue * value.visitCount + reward) / (value.visitCount + 1);
      value.visitCount++;
      if (wasPlayed) value.winCount++;
    }

    // 敗者のカードはQ値を下げる
    for (const { cardId } of loserDeck) {
      if (!this.model.cardValues[cardId]) {
        this.model.cardValues[cardId] = {
          cardId,
          qValue: 0.5,
          visitCount: 0,
          winCount: 0,
        };
      }

      const value = this.model.cardValues[cardId];
      const wasPlayed = (result.winnerId === 0 ? result.player1CardsPlayed : result.player0CardsPlayed).includes(cardId);
      const reward = wasPlayed ? 0.0 : 0.3; // 使われたら負の報酬

      value.qValue = (value.qValue * value.visitCount + reward) / (value.visitCount + 1);
      value.visitCount++;
    }

    this.model.totalPlayouts++;
  }

  /**
   * Q値に基づくデッキ推奨
   */
  recommendDeckByQValue(cardCount: number = 40): { cardId: string; count: number }[] {
    const sorted = Object.values(this.model.cardValues)
      .sort((a, b) => b.qValue - a.qValue);

    const deck: { [cardId: string]: number } = {};
    let deckSize = 0;

    for (const value of sorted) {
      for (let i = 0; i < 3 && deckSize < cardCount; i++) {
        if (!deck[value.cardId]) {
          deck[value.cardId] = 0;
        }
        deck[value.cardId]!++;
        deckSize++;
      }
    }

    return Object.entries(deck).map(([cardId, count]) => ({ cardId, count }));
  }

  /**
   * カードのQ値を取得
   */
  getCardValue(cardId: string): CardValue | undefined {
    return this.model.cardValues[cardId];
  }

  /**
   * トップNのカードを取得
   */
  getTopCards(n: number = 10): CardValue[] {
    return Object.values(this.model.cardValues)
      .sort((a, b) => b.qValue - a.qValue)
      .slice(0, n);
  }

  /**
   * モデルを取得
   */
  getModel(): ReinforcementModel {
    return this.model;
  }
}

/**
 * グローバル強化学習インスタンス
 */
export const reinforcementLearning = new ReinforcementLearning();
