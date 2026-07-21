/**
 * 統合デッキオプティマイザー
 * 3つの学習方式をすべて統合してデッキを生成
 */

import { statisticalLearning } from './statistical-learning.js';
import { reinforcementLearning } from './reinforcement-learning.js';
import { neuralEvaluator, type GameFeatures } from './neural-learning.js';
import { CARD_DB } from '../../games/battlspirits/cards.js';

export interface DeckRecommendation {
  deck: { cardId: string; count: number }[];
  method: 'statistical' | 'reinforcement' | 'neural' | 'ensemble';
  confidence: number; // 0.0-1.0
  score: number; // デッキの総スコア
}

/**
 * デッキオプティマイザー
 */
export class DeckOptimizer {
  /**
   * 統計学習ベースのデッキを取得
   */
  getDeckByStatistics(rating: number, cardCount: number = 40): DeckRecommendation {
    const deck = statisticalLearning.deckForRating(rating, cardCount);
    const stats = statisticalLearning.getModel();

    // 信頼度：ゲーム数に基づく
    const confidence = Math.min(1.0, stats.totalGames / 100);

    // スコア：デッキ内のカードの平均勝率
    const score = deck.length > 0
      ? deck.reduce((sum, { cardId }) => {
          const stat = statisticalLearning.getCardStats(cardId);
          return sum + (stat?.winRate ?? 0.5);
        }, 0) / deck.length
      : 0.5;

    return { deck, method: 'statistical', confidence, score };
  }

  /**
   * 強化学習ベースのデッキを取得
   */
  getDeckByReinforcement(cardCount: number = 40): DeckRecommendation {
    const deck = reinforcementLearning.recommendDeckByQValue(cardCount);
    const model = reinforcementLearning.getModel();

    // 信頼度：プレイアウト数に基づく
    const confidence = Math.min(1.0, model.totalPlayouts / 1000);

    // スコア：デッキ内のカードの平均Q値
    const score = deck.length > 0
      ? deck.reduce((sum, { cardId }) => {
          const value = reinforcementLearning.getCardValue(cardId);
          return sum + (value?.qValue ?? 0.5);
        }, 0) / deck.length
      : 0.5;

    return { deck, method: 'reinforcement', confidence, score };
  }

  /**
   * ニューラルネットベースのデッキを取得
   */
  getDeckByNeural(rating: number, cardCount: number = 40): DeckRecommendation {
    // ニューラルネットで各カードを評価
    const features: GameFeatures = {
      ownLife: 20,
      ownCores: 3,
      ownSoulCores: 1,
      ownSpiritCount: 2,
      ownNexusCount: 1,
      oppLife: 20,
      oppCores: 3,
      oppSoulCores: 1,
      oppSpiritCount: 2,
      oppNexusCount: 1,
      turnCount: 5,
      currentPlayer: 0,
      cardCost: 0,
      cardSymbols: 0,
      cardType: 'spirit',
    };

    const cardScores: { cardId: string; score: number }[] = [];

    Object.entries(CARD_DB).forEach(([cardId, cardDef]) => {
      const cardFeatures = { ...features, cardCost: cardDef.cost, cardType: cardDef.cardType };
      const score = neuralEvaluator.predict(cardFeatures);
      cardScores.push({ cardId, score });
    });

    // スコアでソート
    cardScores.sort((a, b) => b.score - a.score);

    // トップのカードから3枚ずつ選択
    const deck: { [cardId: string]: number } = {};
    let deckSize = 0;

    for (const { cardId } of cardScores) {
      for (let i = 0; i < 3 && deckSize < cardCount; i++) {
        if (!deck[cardId]) {
          deck[cardId] = 0;
        }
        deck[cardId]++;
        deckSize++;
      }
    }

    const deckArray = Object.entries(deck).map(([cardId, count]) => ({ cardId, count }));
    const score = deckArray.length > 0
      ? deckArray.reduce((sum, { cardId }) => {
          const stat = cardScores.find(s => s.cardId === cardId);
          return sum + (stat?.score ?? 0.5);
        }, 0) / deckArray.length
      : 0.5;

    const confidence = 0.5; // 訓練データ不足の場合は中程度

    return { deck: deckArray, method: 'neural', confidence, score };
  }

  /**
   * 3つの方法をすべて統合（アンサンブル）
   */
  getDeckByEnsemble(rating: number, cardCount: number = 40): DeckRecommendation {
    const statsRec = this.getDeckByStatistics(rating, cardCount);
    const rlRec = this.getDeckByReinforcement(cardCount);
    const neuralRec = this.getDeckByNeural(rating, cardCount);

    // 各方法のスコアを重み付け平均
    const avgConfidence = (statsRec.confidence + rlRec.confidence + neuralRec.confidence) / 3;

    // 重み付け：信頼度が高い方法を優先
    const weights = [
      statsRec.confidence,
      rlRec.confidence,
      neuralRec.confidence,
    ];
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map(w => w / totalWeight);

    // カードスコアを統合
    const cardScores: { [cardId: string]: number } = {};

    statsRec.deck.forEach(({ cardId }) => {
      cardScores[cardId] = (cardScores[cardId] ?? 0) + normalizedWeights[0]!;
    });

    rlRec.deck.forEach(({ cardId }) => {
      cardScores[cardId] = (cardScores[cardId] ?? 0) + normalizedWeights[1]!;
    });

    neuralRec.deck.forEach(({ cardId }) => {
      cardScores[cardId] = (cardScores[cardId] ?? 0) + normalizedWeights[2]!;
    });

    // スコアでソート
    const sorted = Object.entries(cardScores)
      .sort((a, b) => b[1] - a[1]);

    // デッキを構築
    const deck: { [cardId: string]: number } = {};
    let deckSize = 0;

    for (const [cardId] of sorted) {
      for (let i = 0; i < 3 && deckSize < cardCount; i++) {
        if (!deck[cardId]) {
          deck[cardId] = 0;
        }
        deck[cardId]++;
        deckSize++;
      }
    }

    const deckArray = Object.entries(deck).map(([cardId, count]) => ({ cardId, count }));
    const avgScore = (statsRec.score * normalizedWeights[0]! + rlRec.score * normalizedWeights[1]! + neuralRec.score * normalizedWeights[2]!);

    return {
      deck: deckArray,
      method: 'ensemble',
      confidence: avgConfidence,
      score: avgScore,
    };
  }

  /**
   * レートと利用可能なデータに応じた最適なデッキを取得
   */
  getBestDeck(rating: number, cardCount: number = 40): DeckRecommendation {
    const statsRec = this.getDeckByStatistics(rating, cardCount);
    const rlModel = reinforcementLearning.getModel();
    const statsModel = statisticalLearning.getModel();

    // 十分なデータがある場合はアンサンブル、なければ統計学習
    if (statsModel.totalGames > 20 && rlModel.totalPlayouts > 100) {
      return this.getDeckByEnsemble(rating, cardCount);
    } else if (statsModel.totalGames > 10) {
      return statsRec;
    } else {
      // フォールバック：基本的な構築
      return {
        deck: this.getFallbackDeck(cardCount),
        method: 'statistical',
        confidence: 0.3,
        score: 0.5,
      };
    }
  }

  /**
   * フォールバックデッキ（学習データなし）
   */
  private getFallbackDeck(cardCount: number = 40): { cardId: string; count: number }[] {
    const allCards = Object.entries(CARD_DB)
      .filter(([_, card]) => card.cardType === 'spirit')
      .map(([cardId]) => cardId);

    const deck: { [cardId: string]: number } = {};
    let deckSize = 0;

    // ランダムに選択（シード固定）
    const rng = { int: (n: number) => Math.floor(Math.random() * n) };

    for (let i = 0; i < cardCount; i++) {
      const cardId = allCards[rng.int(allCards.length)]!;
      if (!deck[cardId]) {
        deck[cardId] = 0;
      }
      if (deck[cardId] < 3) {
        deck[cardId]++;
        deckSize++;
      }
    }

    return Object.entries(deck).map(([cardId, count]) => ({ cardId, count }));
  }
}

/**
 * グローバルデッキオプティマイザーインスタンス
 */
export const deckOptimizer = new DeckOptimizer();
