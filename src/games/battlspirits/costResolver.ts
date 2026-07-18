/**
 * CostResolver: Battle Spirits のコスト計算・支払いを統一管理
 * 継召、ソウルコア支払い、特殊軽減などを1つの仕組みで扱う
 */

import type { CardDef, PlayerState, GameState } from './types';

export type PaymentType = 'normal' | 'inheritance' | 'soulMagic' | 'free';

export interface PaymentPlan {
  paymentType: PaymentType;
  finalCost: number; // 実際に支払うコア数
  inheritanceCount: number; // 除外する EX カード枚数
  inheritanceCardIds: string[]; // 除外するカード ID（順序付き）
  useSoulCore: boolean; // ソウルコア支払いを使うか

  reductions: {
    field: number; // フィールドシンボル軽減
    inheritance: number; // 継召軽減
    effect: number; // 効果による軽減
  };
}

/**
 * フィールドシンボル計算（軽減上限までカウント）
 */
function calculateFieldReduction(player: PlayerState, card: CardDef): number {
  if (!card.symbolColors || card.reductionCost <= 0) return 0;

  const fieldSymbols = getFieldSymbols(player);
  let reduction = 0;
  let reductionRemaining = card.reductionCost;

  for (const sym of fieldSymbols) {
    if (reductionRemaining <= 0) break;
    if (card.symbolColors.includes(sym.color)) {
      const reduce = Math.min(sym.count, reductionRemaining);
      reduction += reduce;
      reductionRemaining -= reduce;
    }
  }

  return reduction;
}

/**
 * フィールドシンボル情報を取得（色ごとの数）
 */
function getFieldSymbols(
  player: PlayerState
): { color: string; count: number }[] {
  const symbolMap = new Map<string, number>();

  // スピリットシンボル
  for (const spirit of player.spirits) {
    if (spirit.def.symbolColors) {
      for (const color of spirit.def.symbolColors) {
        symbolMap.set(color, (symbolMap.get(color) ?? 0) + 1);
      }
    }
  }

  // ネクサスシンボル
  for (const nexus of player.nexuses) {
    if (nexus.def.symbolColors) {
      for (const color of nexus.def.symbolColors) {
        symbolMap.set(color, (symbolMap.get(color) ?? 0) + 1);
      }
    }
  }

  return Array.from(symbolMap.entries()).map(([color, count]) => ({
    color,
    count,
  }));
}

/**
 * トラッシュから継召可能なカードをカウント
 */
function countInheritableEX(trash: CardDef[], card: CardDef): number {
  if (!card.inheritance || !card.symbolColors) return 0;

  return trash.filter(
    (c) => c.exSymbol && c.symbolColors?.some((col) => card.symbolColors?.includes(col))
  ).length;
}

/**
 * 継召で除外するカード ID を取得
 * 公式ルール：軽減上限内で、トラッシュから対応色の EX カード を選ぶ
 */
function selectInheritanceCards(
  trash: CardDef[],
  card: CardDef,
  exCount: number
): string[] {
  if (!card.inheritance || !card.symbolColors || exCount <= 0) return [];

  // 継召可能なカード（対応色の EX シンボル）を抽出
  const inheritableCards = trash.filter(
    (c) => c.exSymbol && c.symbolColors?.some((col) => card.symbolColors?.includes(col))
  );

  // 枚数分を取得
  return inheritableCards.slice(0, exCount).map((c) => c.id);
}

/**
 * 総利用可能コアを計算
 */
function getTotalAvailableCores(player: PlayerState): number {
  let total = player.cores + player.soulCores;

  for (const spirit of player.spirits) {
    total += spirit.coreCount + spirit.soulCoreCount;
  }

  for (const nexus of player.nexuses) {
    total += nexus.coreCount + nexus.soulCoreCount;
  }

  return total;
}

export class CostResolver {
  /**
   * 指定カードの支払い可能プランを生成（副作用なし）
   */
  static getPaymentPlans(state: GameState, player: PlayerState, card: CardDef): PaymentPlan[] {
    const plans: PaymentPlan[] = [];
    const totalCores = getTotalAvailableCores(player);

    // 1. 通常支払い（継召なし）
    const fieldReduction = calculateFieldReduction(player, card);
    const normalCost = Math.max(0, card.cost - fieldReduction);

    if (normalCost + (card.cardType === 'spirit' ? card.lv1.cost : card.lv1.cost) <= totalCores) {
      plans.push({
        paymentType: 'normal',
        finalCost: normalCost,
        inheritanceCount: 0,
        inheritanceCardIds: [],
        useSoulCore: false,
        reductions: {
          field: fieldReduction,
          inheritance: 0,
          effect: 0,
        },
      });
    }

    // 2. 継召を使う場合（対応色の EX シンボルがある場合のみ）
    if (card.inheritance && card.cardType !== 'magic') {
      const availableEX = countInheritableEX(player.trash, card);
      const reductionRemaining = Math.max(0, card.reductionCost - fieldReduction);

      // 継召で使える EX の上限
      const maxInheritanceUse = Math.min(availableEX, reductionRemaining);

      if (maxInheritanceUse > 0) {
        // 各 EX 使用数でプランを生成
        for (let exUsed = 1; exUsed <= maxInheritanceUse; exUsed++) {
          const inheritanceCost = Math.max(0, normalCost - exUsed);
          const totalNeeded = inheritanceCost + (card.cardType === 'spirit' ? card.lv1.cost : card.lv1.cost);

          if (totalNeeded <= totalCores) {
            const inheritanceCardIds = selectInheritanceCards(player.trash, card, exUsed);

            plans.push({
              paymentType: 'inheritance',
              finalCost: inheritanceCost,
              inheritanceCount: exUsed,
              inheritanceCardIds,
              useSoulCore: false,
              reductions: {
                field: fieldReduction,
                inheritance: exUsed,
                effect: 0,
              },
            });
          }
        }
      }
    }

    // 3. ソウルコア支払い（ソウルマジック：赤など）
    const isSoulMagicRed =
      card.cardType === 'magic' &&
      (card.skill === 'ソウルマジック：赤' || card.effects?.some((e) => e.skill === 'ソウルマジック：赤'));
    const canPaySoulCore = player.soulCores >= 1 || player.spirits.some((s) => s.soulCoreCount > 0);

    if (isSoulMagicRed && canPaySoulCore) {
      plans.push({
        paymentType: 'soulMagic',
        finalCost: 0,
        inheritanceCount: 0,
        inheritanceCardIds: [],
        useSoulCore: true,
        reductions: {
          field: 0,
          inheritance: 0,
          effect: 0,
        },
      });
    }

    return plans;
  }

  /**
   * 選択されたプランで実際に支払いを適用（副作用あり）
   */
  static applyPaymentPlan(
    state: GameState,
    player: PlayerState,
    card: CardDef,
    plan: PaymentPlan
  ): void {
    // 1. 継召カード除外
    if (plan.inheritanceCount > 0 && plan.inheritanceCardIds.length > 0) {
      player.trash = player.trash.filter((c) => !plan.inheritanceCardIds.includes(c.id));
    }

    // 2. コア支払い
    if (plan.finalCost > 0 && !plan.useSoulCore) {
      this.payCost(player, plan.finalCost);
    }

    // 3. ソウルコア支払い
    if (plan.useSoulCore) {
      if (player.soulCores >= 1) {
        player.soulCores -= 1;
      } else {
        // スピリットから取る
        for (const spirit of player.spirits) {
          if (spirit.soulCoreCount > 0) {
            spirit.soulCoreCount -= 1;
            break;
          }
        }
      }
    }
  }

  /**
   * コア支払い（reserve から、足りなければ spirits から）
   */
  private static payCost(player: PlayerState, cost: number): void {
    let remaining = cost;

    // Reserve から優先的に支払い
    const fromReserve = Math.min(player.cores, remaining);
    player.cores -= fromReserve;
    remaining -= fromReserve;

    // 不足分をスピリットから支払い
    if (remaining > 0) {
      for (const spirit of player.spirits) {
        if (remaining <= 0) break;

        const fromSpirit = Math.min(spirit.coreCount, remaining);
        spirit.coreCount -= fromSpirit;
        remaining -= fromSpirit;
      }
    }

    // ソウルコアからも支払い可能（混合支払い）
    if (remaining > 0) {
      const fromSoulReserve = Math.min(player.soulCores, remaining);
      player.soulCores -= fromSoulReserve;
      remaining -= fromSoulReserve;
    }
  }

  /**
   * プランが支払い可能かどうか
   */
  static canPay(player: PlayerState, card: CardDef, plan: PaymentPlan): boolean {
    const totalCores = getTotalAvailableCores(player);
    const needed = plan.finalCost + (card.cardType === 'spirit' ? card.lv1.cost : card.lv1.cost);

    if (plan.useSoulCore) {
      return player.soulCores >= 1 || player.spirits.some((s) => s.soulCoreCount > 0);
    }

    return needed <= totalCores;
  }

  /**
   * 支払い方法を人間向け文字列で説明
   */
  static explainPayment(card: CardDef, plan: PaymentPlan): string {
    const parts: string[] = [];

    if (plan.inheritanceCount > 0) {
      parts.push(`継召${plan.inheritanceCount}：EXカード${plan.inheritanceCount}枚を除外`);
    }

    if (plan.reductions.field > 0) {
      parts.push(`フィールド軽減${plan.reductions.field}`);
    }

    if (plan.reductions.inheritance > 0) {
      parts.push(`継召軽減${plan.reductions.inheritance}`);
    }

    if (plan.useSoulCore) {
      parts.push(`ソウルコア1個で支払い`);
    } else {
      if (plan.finalCost === 0) {
        parts.push(`コア支払いなし`);
      } else {
        parts.push(`最終コスト${plan.finalCost}`);
      }
    }

    return parts.join(' → ');
  }
}
