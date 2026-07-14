/**
 * Card Rulebook HTML Generator
 * Converts CardDef to a formatted HTML rulebook display
 */

import type { CardDef } from './types.js';

/**
 * Convert a CardDef to rulebook-format HTML string
 */
export function cardToRulebook(card: CardDef): string {
  const baseStats = card.lv1;
  const lv2Stats = card.lv2;

  const cardType = card.cardType === 'spirit' ? 'スピリット' :
                   card.cardType === 'nexus' ? 'ネクサス' : 'マジック';

  const levelInfo = card.cardType === 'magic'
    ? 'マジック'
    : `${cardType} Lv1-2`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${card.name} - ルールブック</title>
  <style>
    body {
      font-family: 'Yu Gothic', 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
      margin: 0;
      padding: 20px;
      color: #333;
    }

    .container {
      max-width: 600px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }

    .card-header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 20px;
      text-align: center;
    }

    .card-name {
      font-size: 28px;
      font-weight: bold;
      margin-bottom: 8px;
      text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.2);
    }

    .card-type {
      font-size: 14px;
      opacity: 0.9;
      display: inline-block;
      background: rgba(255, 255, 255, 0.2);
      padding: 4px 12px;
      border-radius: 12px;
      margin: 4px 0;
    }

    .card-body {
      padding: 20px;
    }

    .stats-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }

    .stat-box {
      background: #f5f5f5;
      padding: 12px;
      border-radius: 6px;
      border-left: 4px solid #667eea;
    }

    .stat-label {
      font-size: 12px;
      color: #999;
      font-weight: bold;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 20px;
      font-weight: bold;
      color: #333;
    }

    .info-section {
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid #eee;
    }

    .info-section:last-child {
      border-bottom: none;
    }

    .section-title {
      font-size: 14px;
      font-weight: bold;
      color: #667eea;
      text-transform: uppercase;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .section-title::before {
      content: '';
      display: inline-block;
      width: 3px;
      height: 16px;
      background: #667eea;
      border-radius: 2px;
    }

    .info-text {
      font-size: 13px;
      line-height: 1.6;
      color: #555;
      margin: 4px 0;
    }

    .lineage-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }

    .lineage-tag {
      background: #e8f0ff;
      color: #667eea;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid #cfe0ff;
    }

    .effects-section {
      margin-top: 20px;
    }

    .effect-group {
      margin-bottom: 16px;
      background: #fafafa;
      padding: 12px;
      border-radius: 6px;
      border-left: 4px solid #764ba2;
    }

    .effect-trigger {
      font-size: 12px;
      font-weight: bold;
      color: #764ba2;
      text-transform: uppercase;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .effect-trigger::before {
      content: '◆';
      font-size: 14px;
    }

    .effect-item {
      margin-bottom: 8px;
    }

    .effect-item:last-child {
      margin-bottom: 0;
    }

    .effect-mode {
      font-size: 11px;
      color: #666;
      font-weight: bold;
      display: inline-block;
      background: white;
      padding: 2px 6px;
      border-radius: 3px;
      margin-right: 6px;
      border: 1px solid #ddd;
    }

    .effect-level {
      font-size: 11px;
      color: #e74c3c;
      font-weight: bold;
      display: inline-block;
      background: #fff5f5;
      padding: 2px 6px;
      border-radius: 3px;
      margin-right: 6px;
      border: 1px solid #f5cccc;
    }

    .effect-description {
      font-size: 13px;
      color: #444;
      line-height: 1.5;
      margin-top: 4px;
      padding-left: 6px;
      border-left: 2px solid #ddd;
    }

    .effect-condition {
      font-size: 12px;
      color: #999;
      margin-top: 4px;
      font-style: italic;
      padding-left: 6px;
    }

    .no-effects {
      color: #999;
      font-size: 13px;
      text-align: center;
      padding: 12px;
      background: #f9f9f9;
      border-radius: 6px;
    }

    .skill-indicator {
      display: inline-block;
      background: #fff3cd;
      color: #856404;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: bold;
      margin-right: 4px;
      border: 1px solid #ffeeba;
    }

    .ex-symbol {
      display: inline-block;
      background: #fce4ec;
      color: #c2185b;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: bold;
      border: 1px solid #f8bbd0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card-header">
      <div class="card-name">${escapeHtml(card.name)}</div>
      <div class="card-type">${cardType}</div>
    </div>

    <div class="card-body">
      <!-- Stats -->
      <div class="stats-row">
        <div class="stat-box">
          <div class="stat-label">コスト</div>
          <div class="stat-value">${card.cost}</div>
        </div>
        ${card.cardType !== 'magic' ? `
          <div class="stat-box">
            <div class="stat-label">BP</div>
            <div class="stat-value">${baseStats.bp}</div>
          </div>
        ` : ''}
      </div>

      <!-- Reduction Cost -->
      ${card.reductionCost ? `
      <div class="info-section">
        <div class="section-title">軽減コスト</div>
        <div class="info-text">${card.reductionCost}</div>
      </div>
      ` : ''}

      <!-- Lineage and Basic Info -->
      <div class="info-section">
        <div class="section-title">情報</div>
        ${card.lineage && card.lineage.length > 0 ? `
        <div class="info-text">
          <strong>系統：</strong>
          <div class="lineage-list">
            ${card.lineage.map(l => `<span class="lineage-tag">${escapeHtml(l)}</span>`).join('')}
          </div>
        </div>
        ` : ''}

        ${card.symbolCount ? `
        <div class="info-text">
          <strong>シンボル数：</strong> ${card.symbolCount}
          ${card.symbolColors ? ` (${card.symbolColors.join(', ')})` : ''}
        </div>
        ` : ''}

        ${card.inheritance ? `
        <div class="info-text">
          <span class="skill-indicator">継召</span>
        </div>
        ` : ''}

        ${card.exSymbol ? `
        <div class="info-text">
          <span class="ex-symbol">EXシンボル</span>
        </div>
        ` : ''}
      </div>

      <!-- Level Upgrade Info -->
      ${card.cardType !== 'magic' && lv2Stats ? `
      <div class="info-section">
        <div class="section-title">レベルアップ</div>
        <div class="info-text">
          <strong>Lv2 コスト：</strong> ${lv2Stats.cost}
        </div>
        ${lv2Stats.bp ? `
        <div class="info-text">
          <strong>Lv2 BP：</strong> ${lv2Stats.bp}
        </div>
        ` : ''}
      </div>
      ` : ''}

      <!-- Effects -->
      ${card.effects && card.effects.length > 0 ? `
      <div class="effects-section">
        <div class="section-title">効果</div>
        ${groupEffectsByTrigger(card.effects).map(group => `
        <div class="effect-group">
          <div class="effect-trigger">${escapeHtml(getTriggerLabel(group.trigger))}</div>
          ${group.effects.map(effect => `
          <div class="effect-item">
            ${effect.mode ? `<span class="effect-mode">${escapeHtml(effect.mode)}</span>` : ''}
            ${effect.level && effect.level.length > 0 ? `<span class="effect-level">Lv${effect.level.join(', Lv')}</span>` : ''}
            <div class="effect-description">${escapeHtml(effect.description || '')}</div>
            ${effect.skill ? `<div class="effect-condition">スキル: ${escapeHtml(effect.skill)}</div>` : ''}
          </div>
          `).join('')}
        </div>
        `).join('')}
      </div>
      ` : `
      <div class="no-effects">効果なし</div>
      `}
    </div>
  </div>
</body>
</html>`;

  return html;
}

/**
 * Group effects by trigger type
 */
function groupEffectsByTrigger(effects: any[]): { trigger: string; effects: any[] }[] {
  const triggerOrder = ['immediate', 'summon', 'attack', 'block', 'destroy', 'battle_end', 'end_step'];
  const groups = new Map<string, any[]>();

  for (const effect of effects) {
    const trigger = effect.trigger || 'unknown';
    if (!groups.has(trigger)) {
      groups.set(trigger, []);
    }
    groups.get(trigger)!.push(effect);
  }

  return triggerOrder
    .filter(t => groups.has(t))
    .map(trigger => ({ trigger, effects: groups.get(trigger)! }))
    .concat(
      Array.from(groups.entries())
        .filter(([t]) => !triggerOrder.includes(t))
        .map(([trigger, effects]) => ({ trigger, effects }))
    );
}

/**
 * Get human-readable trigger label
 */
function getTriggerLabel(trigger: string): string {
  const labels: Record<string, string> = {
    'immediate': '即座効果',
    'summon': '召喚時効果',
    'attack': '攻撃時効果',
    'block': 'ブロック時効果',
    'destroy': '破壊時効果',
    'battle_end': '戦闘終了時効果',
    'end_step': '終了時効果',
  };
  return labels[trigger] || trigger;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
