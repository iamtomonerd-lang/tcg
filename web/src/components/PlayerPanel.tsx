import '../styles/PlayerPanel.css';

interface PlayerPanelProps {
  playerNumber: number;
  player: any;
  isCurrent: boolean;
  showHand: boolean;
  typeLabel: string;
  position: 'top' | 'bottom';
}

function CardImage({ imagePath, name }: { imagePath?: string; name: string }) {
  if (!imagePath) return null;
  return (
    <img
      className="fcard-image"
      src={`/${imagePath}`}
      alt={name}
      loading="lazy"
      onError={(e) => {
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  );
}

export default function PlayerPanel({ playerNumber, player, isCurrent, showHand, typeLabel, position }: PlayerPanelProps) {
  const statsBar = (
    <div className="player-bar">
      <span className={`pname ${isCurrent ? 'active' : ''}`}>
        P{playerNumber} <span className="ptype">{typeLabel}</span>
        {isCurrent && <span className="turn-badge">▶ ターン中</span>}
      </span>
      <span className={`pstat life ${player.life <= 5 ? 'low' : ''}`} title="ライフ">❤️ {player.life}</span>
      <span className="pstat" title="コア（リザーブ）">🔵 {player.cores}</span>
      <span className="pstat" title="手札">🃏 {player.handSize}</span>
      <span className="pstat" title="デッキ残り">📚 {player.deck.count}</span>
      <span className="pstat" title="トラッシュ">🗑️ {player.trash.count}</span>
    </div>
  );

  const fieldRow = (
    <div className="field-row">
      {player.nexuses.map((nexus: any, i: number) => (
        <div key={`n${i}`} className="fcard nexus" title={`${nexus.name}（ネクサス Lv${nexus.level}）`}>
          <CardImage imagePath={nexus.imagePath} name={nexus.name} />
          <div className="fcard-chips">
            <span className="chip nexus-chip">ネクサス</span>
            <span className="chip">Lv{nexus.level}</span>
          </div>
          <div className="fcard-name">{nexus.name}</div>
        </div>
      ))}
      {player.spirits.map((spirit: any, i: number) => (
        <div
          key={`s${i}`}
          className={`fcard spirit ${spirit.canAttack ? '' : 'tapped'}`}
          title={`${spirit.name}｜Lv${spirit.level}｜BP${spirit.bp}｜コア${spirit.coreCount}${spirit.canAttack ? '' : '｜疲労'}`}
        >
          <CardImage imagePath={spirit.imagePath} name={spirit.name} />
          <div className="fcard-chips">
            <span className="chip">Lv{spirit.level}</span>
            <span className="chip bp">BP{spirit.bp}</span>
            {spirit.coreCount > 0 && <span className="chip core">コア{spirit.coreCount}</span>}
            {spirit.soulCoreCount > 0 && <span className="chip soul">⭐{spirit.soulCoreCount}</span>}
          </div>
          <div className="fcard-name">{spirit.name}</div>
          {!spirit.canAttack && <div className="tap-overlay">疲労</div>}
        </div>
      ))}
      {player.nexuses.length === 0 && player.spirits.length === 0 && (
        <div className="field-empty">場にカードなし</div>
      )}
    </div>
  );

  const handRow = showHand ? (
    <div className="hand-row">
      <span className="hand-label">手札</span>
      {player.handCards.length > 0 ? (
        player.handCards.map((card: any, i: number) => (
          <div key={i} className="fcard hand" title={`${card.name}（コスト${card.cost}）`}>
            <CardImage imagePath={card.imagePath} name={card.name} />
            <span className="cost-badge">{card.cost}</span>
            <div className="fcard-name">{card.name}</div>
          </div>
        ))
      ) : (
        <div className="field-empty">手札なし</div>
      )}
    </div>
  ) : null;

  // Top player: hand (if visible) above, field closest to center.
  // Bottom player: field closest to center, hand below.
  return (
    <div className={`player-panel ${position} ${isCurrent ? 'current' : ''}`}>
      {position === 'top' ? (
        <>
          {statsBar}
          {handRow}
          {fieldRow}
        </>
      ) : (
        <>
          {fieldRow}
          {handRow}
          {statsBar}
        </>
      )}
    </div>
  );
}
