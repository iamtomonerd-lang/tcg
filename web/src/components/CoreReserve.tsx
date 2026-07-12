import '../styles/CoreReserve.css';

interface CoreReserveProps {
  cores: number;
  soulCores: number;
  isHumanTurn: boolean;
  playerNumber: number;
  onDragStart?: (data: any) => void;
  onDragEnd?: () => void;
}

export default function CoreReserve({
  cores,
  soulCores,
  isHumanTurn,
  playerNumber,
  onDragStart,
  onDragEnd,
}: CoreReserveProps) {
  const handleCoreDragStart = (coreType: 'regular' | 'soul') => {
    if (isHumanTurn && onDragStart) {
      const dragPayload = {
        type: 'core',
        coreType,
        playerNumber,
      };
      onDragStart(dragPayload);
      // Visual feedback would go here
    }
  };

  return (
    <div className="core-reserve">
      <div className="core-group regular-cores">
        <div className="core-label">コア</div>
        <div className="core-display">
          {Array.from({ length: cores }).map((_, i) => (
            <div
              key={`c-${i}`}
              className={`core regular ${isHumanTurn ? 'draggable' : ''}`}
              draggable={isHumanTurn}
              onDragStart={() => handleCoreDragStart('regular')}
              onDragEnd={onDragEnd}
              title="通常コア - ドラッグしてスピリットに配置"
            />
          ))}
          <span className="core-count">{cores}</span>
        </div>
      </div>

      {soulCores > 0 && (
        <div className="core-group soul-cores">
          <div className="core-label">ソウル</div>
          <div className="core-display">
            {Array.from({ length: soulCores }).map((_, i) => (
              <div
                key={`s-${i}`}
                className={`core soul ${isHumanTurn ? 'draggable' : ''}`}
                draggable={isHumanTurn}
                onDragStart={() => handleCoreDragStart('soul')}
                onDragEnd={onDragEnd}
                title="ソウルコア - ドラッグしてスピリットに配置"
              />
            ))}
            <span className="core-count">{soulCores}</span>
          </div>
        </div>
      )}
    </div>
  );
}
