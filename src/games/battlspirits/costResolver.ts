/**
 * CostResolver: Battle Spirits のコスト計算・支払いを統一管理
 * 継召、ソウルコア支払い、特殊軽減などを1つの仕組みで扱う
 */

import type { CardDef, PlayerState, GameState, CardType } from './types';

export type PaymentType = 'normal' | 'inheritance' | 'soulMagic' | 'free';

export interface PaymentPlan {
  paymentType: PaymentType;
  finalCost: number; // 実際に支払うコア数（最小枚数の場合）
  maxInheritanceCount: number; // 最大継召可能枚数（0 = 継召不可）
  inheritanceCardIds: string[]; // 除外するカード ID（順序付き、未確定時は空配列）
  inheritanceCandidates?: Array<{ id: string; name: string; symbolColors: string[] }>; // 継召の候補カード
  useSoulCore: boolean; // ソウルコア支払いを使うか

  reductions: {
    field: number; // フィールドシンボル軽減
    inheritance: number; // 継召可能な最大軽減（maxInheritanceCount枚使用時）
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
 * 継召の候補カードを取得
 * 対応色の EX シンボルを持つトラッシュカードのリストを返す
 */
function getInheritanceCandidates(
  trash: CardDef[],
  card: CardDef
): Array<{ id: string; name: string; imagePath?: string; cardType?: CardType; symbolColors: string[] }> {
  if (!card.inheritance || !card.symbolColors) return [];

  // 継召可能なカード（対応色の EX シンボル）を抽出
  return trash
    .filter(
      (c) => c.exSymbol && c.symbolColors?.some((col) => card.symbolColors?.includes(col))
    )
    .map((c) => ({
      id: c.id,
      name: c.name,
      imagePath: c.imagePath,
      cardType: c.cardType,
      symbolColors: c.symbolColors ?? [],
    }));
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
    // ① getPaymentPlans() 診断ログ
    console.log('[INHERITANCE①] getPaymentPlans called:', {
      cardName: card.name,
      cardType: card.cardType,
      hasInheritance: card.inheritance,
    });

    // Debug log for 飛剛アクライ
    if (card.name === '飛剛アクライ' || card.id === 'spirit_hibutsu_akurai') {
      console.log('[INHERITANCE_CARD_DEBUG_RESOLVER]', {
        cardId: card.id,
        cardName: card.name,
        cardObject: JSON.stringify(card),
        inheritanceField: card.inheritance,
        inheritanceBoolean: !!card.inheritance,
      });
    }

    const plans: PaymentPlan[] = [];
    const totalCores = getTotalAvailableCores(player);

    // 1. 通常支払い（継召なし）
    const fieldReduction = calculateFieldReduction(player, card);
    const normalCost = Math.max(0, card.cost - fieldReduction);

    if (normalCost + (card.cardType === 'spirit' ? card.lv1.cost : card.lv1.cost) <= totalCores) {
      plans.push({
        paymentType: 'normal',
        finalCost: normalCost,
        maxInheritanceCount: 0,
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
    if (card.inheritance) {
      const availableEX = countInheritableEX(player.trash, card);
      const reductionRemaining = Math.max(0, card.reductionCost - fieldReduction);

      // 継召で使える EX の上限
      const maxInheritanceUse = Math.min(availableEX, reductionRemaining);

      // Debug log for inheritance investigation
      if (card.name === 'セルタリウス' || card.name === 'Seltalius') {
        const candidates = getInheritanceCandidates(player.trash, card);
        console.log('[INHERITANCE_DEBUG]', {
          cardName: card.name,
          hasInheritance: card.inheritance,
          trashCards: player.trash.map(c => ({
            id: c.id,
            name: c.name,
            exSymbol: c.exSymbol,
            symbolColors: c.symbolColors,
          })),
          inheritanceCandidates: candidates,
          availableEX,
          fieldReduction,
          reductionRemaining,
          maxInheritanceUse,
          plansBeforeInheritance: plans.length,
        });
      }

      if (maxInheritanceUse > 0) {
        // 候補カードを一度だけ取得
        const candidates = getInheritanceCandidates(player.trash, card);

        // ① CostResolver plan generation debug
        console.log('[INHERITANCE_PLAN_DEBUG]', {
          cardName: card.name,
          maxInheritanceCount: maxInheritanceUse,
          availableEX,
          reductionRemaining,
          fieldReduction,
          card_reductionCost: card.reductionCost,
          candidates: candidates.map(c => ({ id: c.id, name: c.name })),
          candidateCount: candidates.length,
          canUseInheritance: maxInheritanceUse > 0,
        });

        // 単一プランで最大枚数のみ記録（枚数選択はUI/pendingInheritanceSelectionで決定）
        const inheritanceCost = Math.max(0, normalCost - maxInheritanceUse);
        const totalNeeded = inheritanceCost + (card.cardType === 'spirit' ? card.lv1.cost : card.lv1.cost);

        if (totalNeeded <= totalCores) {
          plans.push({
            paymentType: 'inheritance',
            finalCost: inheritanceCost,
            maxInheritanceCount: maxInheritanceUse,
            inheritanceCardIds: [], // 未確定：空配列
            inheritanceCandidates: candidates, // 候補のみ保持
            useSoulCore: false,
            reductions: {
              field: fieldReduction,
              inheritance: maxInheritanceUse,
              effect: 0,
            },
          });
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
        finalCost: card.cost,
        maxInheritanceCount: 0,
        inheritanceCardIds: [],
        useSoulCore: true,
        reductions: {
          field: 0,
          inheritance: 0,
          effect: 0,
        },
      });
    }

    // ③ inheritance candidates が生成されたかログ
    const inheritancePlans = plans.filter(p => p.maxInheritanceCount > 0);
    if (inheritancePlans.length > 0) {
      console.log('[INHERITANCE③] inheritanceCandidates in PaymentPlans:', {
        cardName: card.name,
        inheritancePlansCount: inheritancePlans.length,
        plans: inheritancePlans.map(p => ({
          paymentType: p.paymentType,
          maxInheritanceCount: p.maxInheritanceCount,
          inheritanceCandidateCount: p.inheritanceCandidates?.length ?? 0,
        })),
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
    // 1. 継召カード除外（選択されたカードがある場合のみ）
    if (plan.inheritanceCardIds.length > 0) {
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

    // Reserve から優先的に支払い（通常コア）
    const fromReserve = Math.min(player.cores, remaining);
    player.cores -= fromReserve;
    remaining -= fromReserve;

    // 不足分をスピリットから支払い（通常コア）
    if (remaining > 0) {
      for (const spirit of player.spirits) {
        if (remaining <= 0) break;

        const fromSpirit = Math.min(spirit.coreCount, remaining);
        spirit.coreCount -= fromSpirit;
        remaining -= fromSpirit;
      }
    }

    // 不足分をスピリットのソウルコアから支払い
    if (remaining > 0) {
      for (const spirit of player.spirits) {
        if (remaining <= 0) break;

        const fromSoulSpirit = Math.min(spirit.soulCoreCount, remaining);
        spirit.soulCoreCount -= fromSoulSpirit;
        remaining -= fromSoulSpirit;
      }
    }

    // 最後にリザーブのソウルコアから支払い
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
   * プレイヤー選択から最終PaymentPlanを生成（Phase 4: UI統合用）
   * 継召カード選択後、確定したコストプランを返す
   *
   * セキュリティ: サーバー側 GameState.player.trash を常に参照し、
   * クライアント送信データの検証を厳密に行う
   */
  static finalizePaymentPlanFromSelection(
    state: GameState,
    player: PlayerState,
    card: CardDef,
    inheritanceCount: number,
    inheritanceCardIds: string[]
  ): PaymentPlan | null {
    // 基本プランを取得
    const basePlan = this.getPaymentPlans(state, player, card).find(
      p => p.paymentType === 'inheritance' && p.maxInheritanceCount > 0
    );

    if (!basePlan) {
      console.error('[ERROR] No inheritance plan available for finalization');
      return null;
    }

    // プレイヤーの選択が有効か確認
    if (inheritanceCount < 0 || inheritanceCount > basePlan.maxInheritanceCount) {
      console.error('[ERROR] Invalid inheritance count in finalization:', {
        chosen: inheritanceCount,
        max: basePlan.maxInheritanceCount,
      });
      return null;
    }

    if (inheritanceCardIds.length !== inheritanceCount) {
      console.error('[ERROR] Selected card count mismatch:', {
        expected: inheritanceCount,
        received: inheritanceCardIds.length,
      });
      return null;
    }

    // 【セキュリティ】選択されたカードIDの厳密な検証
    // すべてのカードがサーバー側 player.trash に存在し、
    // 継召条件（EX シンボル + 色一致）を満たしているか確認
    const validSelectedIds: string[] = [];
    const trashCardMap = new Map(player.trash.map(c => [c.id, c]));

    for (const selectedId of inheritanceCardIds) {
      const trashCard = trashCardMap.get(selectedId);

      // ① trash に存在しないカードID
      if (!trashCard) {
        console.error('[SECURITY] Selected card not found in trash:', {
          selectedId,
          cardBeingSummoned: card.name,
          playerTrashCount: player.trash.length,
        });
        return null;
      }

      // ② EX シンボルを持たないカード
      if (!trashCard.exSymbol) {
        console.error('[SECURITY] Selected card does not have EX symbol:', {
          selectedId,
          cardName: trashCard.name,
          exSymbol: trashCard.exSymbol,
        });
        return null;
      }

      // ③ 色が一致しないカード（継召対応色ではない）
      if (!card.symbolColors || !trashCard.symbolColors) {
        console.error('[SECURITY] Missing symbol colors data:', {
          selectedId,
          cardSymbols: trashCard.symbolColors,
          targetColors: card.symbolColors,
        });
        return null;
      }

      const hasMatchingColor = trashCard.symbolColors.some(
        col => card.symbolColors?.includes(col)
      );
      if (!hasMatchingColor) {
        console.error('[SECURITY] Selected card color does not match inheritance requirement:', {
          selectedId,
          cardName: trashCard.name,
          cardColors: trashCard.symbolColors,
          targetColors: card.symbolColors,
        });
        return null;
      }

      validSelectedIds.push(selectedId);
    }

    // すべての検証が成功したことを確認
    if (validSelectedIds.length !== inheritanceCardIds.length) {
      console.error('[SECURITY] Some selected cards failed validation');
      return null;
    }

    // コスト再計算
    const fieldReduction = basePlan.reductions.field;
    const inheritanceReduction = inheritanceCount;
    const finalCost = Math.max(0, card.cost - fieldReduction - inheritanceReduction);

    // 最終プランを生成
    const finalPlan: PaymentPlan = {
      ...basePlan,
      finalCost,
      inheritanceCardIds: validSelectedIds, // 検証済みのIDのみ
      inheritanceCandidates: undefined, // 【重要】選択完了を示すため、候補リストを削除
      reductions: {
        ...basePlan.reductions,
        inheritance: inheritanceReduction,
      },
    };

    return finalPlan;
  }

  /**
   * 支払い方法を人間向け文字列で説明
   */
  static explainPayment(card: CardDef, plan: PaymentPlan): string {
    const parts: string[] = [];

    if (plan.maxInheritanceCount > 0) {
      parts.push(`継召対応（最大${plan.maxInheritanceCount}枚）`);
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
