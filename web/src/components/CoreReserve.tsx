import '../styles/CoreReserve.css';

interface CoreReserveProps {
  cores: number;
  soulCores: number;
  trashCores?: number;
  trashSoulCores?: number;
  isHumanTurn: boolean;
  playerNumber: number;
  onDragStart?: (data: any) => void;
  onDragEnd?: () => void;
}

export default function CoreReserve({
  cores,
  soulCores,
  trashCores = 0,
  trashSoulCores = 0,
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

      {(trashCores > 0 || trashSoulCores > 0) && (
        <div className="core-trash-section">
          <div className="trash-label">🗑️ トラッシュ</div>
          {trashCores > 0 && (
            <div className="core-group trash-cores">
              <div className="core-display">
                {Array.from({ length: Math.min(trashCores, 5) }).map((_, i) => (
                  <div
                    key={`t-${i}`}
                    className="core trash"
                    title="トラッシュのコア"
                  />
                ))}
                {trashCores > 5 && <span className="core-count">+{trashCores - 5}</span>}
              </div>
              <span className="core-count">{trashCores}</span>
            </div>
          )}
          {trashSoulCores > 0 && (
            <div className="core-group trash-soul-cores">
              <div className="core-display">
                {Array.from({ length: Math.min(trashSoulCores, 5) }).map((_, i) => (
                  <div
                    key={`ts-${i}`}
                    className="core trash-soul"
                    title="トラッシュのソウルコア"
                  />
                ))}
                {trashSoulCores > 5 && <span className="core-count">+{trashSoulCores - 5}</span>}
              </div>
              <span className="core-count">{trashSoulCores}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
