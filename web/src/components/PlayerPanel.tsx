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
  playerRating?: number;
  onDragStart?: (data: any) => void;
  onDragEnd?: () => void;
  onDrop?: (data: any) => void;
  dragOverCard?: string | null;
  onCardRightClick?: (imagePath: string | undefined, name: string) => void;
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

/**
 * Core tray rendered BELOW a field card (outside the draggable card element),
 * so dragging a core never conflicts with dragging the card itself.
 * The tray is also a drop target for placing cores onto this card.
 */
function CoreTray({
  zone,
  index,
  coreCount,
  soulCoreCount,
  canDrag,
  onDragStart,
  onDragEnd,
  onDrop,
  targetPlayerNumber,
}: {
  zone: 'spirit' | 'nexus';
  index: number;
  coreCount: number;
  soulCoreCount: number;
  canDrag: boolean;
  onDragStart?: (data: any) => void;
  onDragEnd?: () => void;
  onDrop?: (data: any) => void;
  targetPlayerNumber: number;
}) {
  const startDrag = (e: React.DragEvent, coreType: 'regular' | 'soul') => {
    e.stopPropagation();
    if (canDrag && onDragStart) {
      const dragPayload = {
        type: 'core',
        coreType,
        source: { zone, index },
      };
      onDragStart(dragPayload);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload));
    }
  };

  return (
    <div
      className={`core-tray ${canDrag ? 'interactive' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onDrop) {
          onDrop({
            targetPlayerNumber,
            targetZone: zone,
            ...(zone === 'spirit' ? { spiritIndex: index } : { nexusIndex: index }),
          });
        }
      }}
      title="コア置き場 — コアをここにドロップして配置、ドラッグで移動"
    >
      {Array.from({ length: coreCount }).map((_, i) => (
        <div
          key={`fc-${i}`}
          className={`field-core regular ${canDrag ? 'draggable' : ''}`}
          draggable={canDrag}
          onDragStart={(e) => startDrag(e, 'regular')}
          onDragEnd={onDragEnd}
          title="通常コア - ドラッグで移動・支払い"
        />
      ))}
      {Array.from({ length: soulCoreCount }).map((_, i) => (
        <div
          key={`fs-${i}`}
          className={`field-core soul ${canDrag ? 'draggable' : ''}`}
          draggable={canDrag}
          onDragStart={(e) => startDrag(e, 'soul')}
          onDragEnd={onDragEnd}
          title="ソウルコア - ドラッグで移動・支払い"
        />
      ))}
      {coreCount <= 0 && soulCoreCount <= 0 && <span className="core-tray-empty">コアなし</span>}
    </div>
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
  legalActions: _legalActions,
  playerRating,
  onDragStart,
  onDragEnd,
  onDrop,
  dragOverCard,
  onCardRightClick,
}: PlayerPanelProps) {
  // Cores can be manipulated only on the human player's own panel during their turn
  const canMoveCores = isHumanTurn && isCurrent;

  const statsBar = (
    <div className="player-stats-section">
      <div className="player-bar">
        <span className={`pname ${isCurrent ? 'active' : ''}`}>
          P{playerNumber} <span className="ptype">{typeLabel}</span>
          {playerRating !== undefined && <span className="rating-badge">📊 {playerRating}</span>}
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
        trashCores={player.trashCores}
        trashSoulCores={player.trashSoulCores}
        isHumanTurn={canMoveCores}
        playerNumber={playerNumber}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDrop={onDrop}
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
          onDrop({ targetPlayerNumber: playerNumber });
        }
      }}
    >
      {player.nexuses.map((nexus: any, i: number) => (
        <div key={`n${i}`} className="fcard-wrap">
          <div
            className={`fcard nexus ${dragOverCard === `nexus-${i}` ? 'drag-over' : ''}`}
            title={`${nexus.name}（ネクサス Lv${nexus.level}｜コア${(nexus.coreCount ?? 0) + (nexus.soulCoreCount ?? 0)}）`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onDrop && isHumanTurn) {
                onDrop({ targetPlayerNumber: playerNumber, nexusIndex: i, targetZone: 'nexus' });
              }
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
          <CoreTray
            zone="nexus"
            index={i}
            coreCount={nexus.coreCount ?? 0}
            soulCoreCount={nexus.soulCoreCount ?? 0}
            canDrag={canMoveCores}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDrop={isHumanTurn ? onDrop : undefined}
            targetPlayerNumber={playerNumber}
          />
        </div>
      ))}
      {player.spirits.map((spirit: any, i: number) => (
        <div key={`s${i}`} className="fcard-wrap">
          <div
            className={`fcard spirit ${spirit.canAttack ? '' : 'tapped'} ${dragOverCard === `spirit-${i}` ? 'drag-over' : ''}`}
            title={`${spirit.name}｜Lv${spirit.level}｜BP${spirit.bp}｜コア${spirit.coreCount + (spirit.soulCoreCount ?? 0)}${spirit.canAttack ? '' : '｜疲労'}`}
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
              e.stopPropagation();
              if (onDrop && isHumanTurn) {
                onDrop({ targetPlayerNumber: playerNumber, spiritIndex: i, targetZone: 'spirit' });
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
            </div>
            <div className="fcard-name">{spirit.name}</div>
            {!spirit.canAttack && <div className="tap-overlay">疲労</div>}
          </div>
          <CoreTray
            zone="spirit"
            index={i}
            coreCount={spirit.coreCount ?? 0}
            soulCoreCount={spirit.soulCoreCount ?? 0}
            canDrag={canMoveCores}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDrop={isHumanTurn ? onDrop : undefined}
            targetPlayerNumber={playerNumber}
          />
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
          <div
            key={i}
            className={`fcard hand ${dragOverCard === `hand-${i}` ? 'drag-over' : ''}`}
            title={`${card.name}（コスト${card.cost}）`}
            draggable={isHumanTurn}
            onDragStart={(e) => {
              if (isHumanTurn && onDragStart) {
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
