/**
 * ニューラルネット学習エンジン
 * ゲーム状態からカード評価関数を学習（TensorFlow.js）
 */

import { CARD_DB } from '../../games/battlspirits/cards.js';
import { gameLogger } from './game-logger.js';

/**
 * ゲーム状態の特徴ベクトル
 */
export interface GameFeatures {
  // プレイヤー状態
  ownLife: number;
  ownCores: number;
  ownSoulCores: number;
  ownSpiritCount: number;
  ownNexusCount: number;

  // 相手状態
  oppLife: number;
  oppCores: number;
  oppSoulCores: number;
  oppSpiritCount: number;
  oppNexusCount: number;

  // ゲーム進行
  turnCount: number;
  currentPlayer: number;

  // カード固有
  cardCost: number;
  cardSymbols: number;
  cardType: string; // 'spirit', 'nexus', 'magic'
}

/**
 * ニューラルネット評価関数
 * シンプルな3層ネットワーク（外部ライブラリなし）
 */
export class NeuralCardEvaluator {
  private weights: number[][][]; // [layer][neuron][weight]
  private biases: number[][]; // [layer][neuron]
  private learningRate = 0.01;

  private readonly inputSize = 16; // 入力特徴数
  private readonly hiddenSize = 8; // 隠れ層ニューロン数
  private readonly outputSize = 1; // 出力（カード価値スコア）

  constructor() {
    this.weights = this.initializeWeights();
    this.biases = this.initializeBiases();
  }

  /**
   * 重みを初期化
   */
  private initializeWeights(): number[][][] {
    const w: number[][][] = [];

    // 入力→隠れ層
    w[0] = Array(this.hiddenSize)
      .fill(null)
      .map(() => Array(this.inputSize).fill(null).map(() => Math.random() - 0.5));

    // 隠れ層→出力層
    w[1] = Array(this.outputSize)
      .fill(null)
      .map(() => Array(this.hiddenSize).fill(null).map(() => Math.random() - 0.5));

    return w;
  }

  /**
   * バイアスを初期化
   */
  private initializeBiases(): number[][] {
    return [
      Array(this.hiddenSize).fill(0.1),
      Array(this.outputSize).fill(0.1),
    ];
  }

  /**
   * ReLU活性化関数
   */
  private relu(x: number): number {
    return Math.max(0, x);
  }

  /**
   * ReLU導関数
   */
  private reluDerivative(x: number): number {
    return x > 0 ? 1 : 0;
  }

  /**
   * シグモイド活性化関数
   */
  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.min(10, Math.max(-10, x))));
  }

  /**
   * 特徴ベクトルを取得
   */
  private extractFeatures(features: GameFeatures): number[] {
    return [
      features.ownLife / 20, // 正規化
      features.ownCores / 20,
      features.ownSoulCores / 5,
      features.ownSpiritCount / 5,
      features.ownNexusCount / 3,
      features.oppLife / 20,
      features.oppCores / 20,
      features.oppSoulCores / 5,
      features.oppSpiritCount / 5,
      features.oppNexusCount / 3,
      features.turnCount / 50,
      features.currentPlayer,
      features.cardCost / 8,
      features.cardSymbols / 3,
      features.cardType === 'spirit' ? 1 : 0,
      features.cardType === 'magic' ? 1 : 0,
    ];
  }

  /**
   * 順伝播（推論）
   */
  predict(features: GameFeatures): number {
    const input = this.extractFeatures(features);
    const weights0 = this.weights[0]!;
    const biases0 = this.biases[0]!;
    const weights1 = this.weights[1]!;
    const biases1 = this.biases[1]!;

    // 隠れ層
    const hidden = Array(this.hiddenSize)
      .fill(null)
      .map((_, i) => {
        const w = weights0[i]!;
        const b = biases0[i]!;
        const sum = w.reduce((acc, weight, j) => acc + weight * (input[j] ?? 0), 0) + b;
        return this.relu(sum);
      });

    // 出力層
    const w1 = weights1[0]!;
    const b1 = biases1[0]!;
    const output = w1.reduce((acc, weight, i) => acc + weight * (hidden[i] ?? 0), 0) + b1;
    return this.sigmoid(output); // 0-1に正規化
  }

  /**
   * 逆伝播学習
   */
  train(features: GameFeatures, target: number): void {
    const input = this.extractFeatures(features);
    const weights0 = this.weights[0]!;
    const biases0 = this.biases[0]!;
    const weights1 = this.weights[1]!;
    const biases1 = this.biases[1]!;

    // 順伝播（隠れ層）
    const hidden = Array(this.hiddenSize)
      .fill(null)
      .map((_, i) => {
        const w = weights0[i]!;
        const b = biases0[i]!;
        const sum = w.reduce((acc, weight, j) => acc + weight * (input[j] ?? 0), 0) + b;
        return this.relu(sum);
      });

    // 順伝播（出力層）
    const w1 = weights1[0]!;
    const b1 = biases1[0]!;
    const output = w1.reduce((acc, weight, i) => acc + weight * (hidden[i] ?? 0), 0) + b1;
    const prediction = this.sigmoid(output);

    // 損失関数の勾配
    const outputError = prediction - target;
    const outputGradient = outputError * prediction * (1 - prediction);

    // 出力層→隠れ層の重み更新
    for (let i = 0; i < this.hiddenSize; i++) {
      const wVal = w1[i];
      if (wVal !== undefined) {
        w1[i] = wVal - this.learningRate * outputGradient * (hidden[i] ?? 0);
      }
    }
    biases1[0]! -= this.learningRate * outputGradient;

    // 隠れ層→入力層の重み更新
    const hiddenErrors = Array(this.hiddenSize)
      .fill(null)
      .map((_, i) => outputGradient * (w1[i] ?? 0) * this.reluDerivative(hidden[i] ?? 0));

    for (let i = 0; i < this.hiddenSize; i++) {
      const w0i = weights0[i]!;
      const he = hiddenErrors[i] ?? 0;
      for (let j = 0; j < this.inputSize; j++) {
        const w0Val = w0i[j];
        if (w0Val !== undefined) {
          w0i[j] = w0Val - this.learningRate * he * (input[j] ?? 0);
        }
      }
      const b0 = biases0[i];
      if (b0 !== undefined) {
        biases0[i] = b0 - this.learningRate * he;
      }
    }
  }

  /**
   * ゲーム結果から学習
   */
  learnFromGameResults(): void {
    const results = gameLogger.getGameResults(100); // 最新100ゲーム

    for (const result of results) {
      const isWinner = (cardId: string) => {
        if (result.winnerId === 0) {
          return result.player0Deck.some(c => c.cardId === cardId);
        } else {
          return result.player1Deck.some(c => c.cardId === cardId);
        }
      };

      const allCards = new Set<string>();
      result.player0Deck.forEach(c => allCards.add(c.cardId));
      result.player1Deck.forEach(c => allCards.add(c.cardId));

      for (const cardId of allCards) {
        const cardDef = CARD_DB[cardId as keyof typeof CARD_DB];
        if (!cardDef) continue;

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
          turnCount: result.turnCount / 2,
          currentPlayer: 0,
          cardCost: cardDef.cost,
          cardSymbols: cardDef.symbolCount,
          cardType: cardDef.cardType,
        };

        // 勝者のカードはtarget=1.0、敗者のカードはtarget=0.0
        const target = isWinner(cardId) ? 1.0 : 0.0;
        this.train(features, target);
      }
    }
  }

  /**
   * モデルをエクスポート
   */
  exportModel(): string {
    return JSON.stringify({ weights: this.weights, biases: this.biases });
  }

  /**
   * モデルをインポート
   */
  importModel(json: string): void {
    try {
      const data = JSON.parse(json);
      this.weights = data.weights;
      this.biases = data.biases;
    } catch (e) {
      console.error('Failed to import neural model:', e);
    }
  }
}

/**
 * グローバルニューラルネットインスタンス
 */
export const neuralEvaluator = new NeuralCardEvaluator();
