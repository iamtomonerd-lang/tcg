import '../styles/PlayerPanel.css';
import CoreReserve from './CoreReserve';

interface PlayerPanelProps {
  playerNumber: number;
  player: any;
  isCurrent: boolean;
  showHand: boolean;
  typeLabel: string;
  position: 'top' | 'bottom';
  isHumanTurn: boolean;
  legalActions: Array<{ index: number; description: string }>;
  onDragStart?: (data: any) => void;
  onDragEnd?: () => void;
  onDrop?: (data: any) => void;
  dragOverCard?: string | null;
  onCardRightClick?: (imagePath: string | undefined, name: string) => void;
  canAffordCard: (card: any) => boolean;
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

export default function PlayerPanel({
  playerNumber,
  player,
  isCurrent,
  showHand,
  typeLabel,
  position,
  isHumanTurn,
  legalActions,
  onDragStart,
  onDragEnd,
  onDrop,
  dragOverCard,
  onCardRightClick,
  canAffordCard,
}: PlayerPanelProps) {
  const statsBar = (
    <div className="player-stats-section">
      <div className="player-bar">
        <span className={`pname ${isCurrent ? 'active' : ''}`}>
          P{playerNumber} <span className="ptype">{typeLabel}</span>
          {isCurrent && <span className="turn-badge">▶ ターン中</span>}
        </span>
        <span className={`pstat life ${player.life <= 5 ? 'low' : ''}`} title="ライフ">❤️ {player.life}</span>
        <span className="pstat" title="手札">🃏 {player.handSize}</span>
        <span className="pstat" title="デッキ残り">📚 {player.deck.count}</span>
        <span className="pstat" title="トラッシュ">🗑️ {player.trash.count}</span>
      </div>
      <CoreReserve
        cores={player.cores}
        soulCores={player.soulCores}
        isHumanTurn={isHumanTurn}
        playerNumber={playerNumber}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
    </div>
  );

  const fieldRow = (
    <div
      className="field-row"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (onDrop && isHumanTurn) {
          try {
            const data = JSON.parse(e.dataTransfer.getData('text/plain'));
            onDrop({ ...data, targetPlayerNumber: playerNumber });
          } catch (e) {
            // Invalid drop data
          }
        }
      }}
    >
      {player.nexuses.map((nexus: any, i: number) => (
        <div
          key={`n${i}`}
          className={`fcard nexus ${dragOverCard === `nexus-${i}` ? 'drag-over' : ''}`}
          title={`${nexus.name}（ネクサス Lv${nexus.level}）`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onCardRightClick?.(nexus.imagePath, nexus.name);
          }}
        >
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
          className={`fcard spirit ${spirit.canAttack ? '' : 'tapped'} ${dragOverCard === `spirit-${i}` ? 'drag-over' : ''}`}
          title={`${spirit.name}｜Lv${spirit.level}｜BP${spirit.bp}｜コア${spirit.coreCount}${spirit.canAttack ? '' : '｜疲労'}`}
          draggable={isHumanTurn}
          onDragStart={(e) => {
            if (isHumanTurn && onDragStart) {
              const dragPayload = { type: 'spirit', spiritIndex: i, spirit };
              onDragStart(dragPayload);
              e.dataTransfer!.effectAllowed = 'move';
              e.dataTransfer!.setData('text/plain', JSON.stringify(dragPayload));
            }
          }}
          onDragEnd={onDragEnd}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (onDrop && isHumanTurn) {
              try {
                const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                onDrop({ ...data, targetPlayerNumber: playerNumber, spiritIndex: i });
              } catch (e) {
                // Invalid drop data
              }
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onCardRightClick?.(spirit.imagePath, spirit.name);
          }}
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
        player.handCards.map((card: any, i: number) => {
          const canAfford = canAffordCard(card);
          return (
          <div
            key={i}
            className={`fcard hand ${dragOverCard === `hand-${i}` ? 'drag-over' : ''} ${!canAfford ? 'unaffordable' : ''}`}
            title={`${card.name}（コスト${card.cost}）`}
            draggable={isHumanTurn && canAfford}
            onDragStart={(e) => {
              if (isHumanTurn && canAfford && onDragStart) {
                const dragPayload = { type: 'hand-card', handIndex: i, card };
                onDragStart(dragPayload);
                e.dataTransfer!.effectAllowed = 'move';
                e.dataTransfer!.setData('text/plain', JSON.stringify(dragPayload));
              }
            }}
            onDragEnd={onDragEnd}
            onContextMenu={(e) => {
              e.preventDefault();
              onCardRightClick?.(card.imagePath, card.name);
            }}
          >
            <CardImage imagePath={card.imagePath} name={card.name} />
            <span className="cost-badge">{card.cost}</span>
            <div className="fcard-name">{card.name}</div>
          </div>
        );
        })
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
