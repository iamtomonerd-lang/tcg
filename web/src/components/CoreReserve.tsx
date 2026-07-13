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
  onDrop?: (data: any) => void;
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
  onDrop,
}: CoreReserveProps) {

  const handleCoreDragStart = (e: React.DragEvent, coreType: 'regular' | 'soul') => {
    if (isHumanTurn && onDragStart) {
      const dragPayload = {
        type: 'core',
        coreType,
        playerNumber,
        source: { zone: 'reserve' },
      };
      onDragStart(dragPayload);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify(dragPayload));
    }
  };

  return (
    <div
      className="core-reserve"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onDrop && isHumanTurn) {
          onDrop({ targetZone: 'reserve', targetPlayerNumber: playerNumber });
        }
      }}
      title="ここにコアをドロップするとリザーブに戻ります"
    >
      <div className="core-group regular-cores">
        <div className="core-label">コア</div>
        <div className="core-display">
          {Array.from({ length: cores }).map((_, i) => (
            <div
              key={`c-${i}`}
              className={`core regular ${isHumanTurn ? 'draggable' : ''}`}
              draggable={isHumanTurn}
              onDragStart={(e) => handleCoreDragStart(e, 'regular')}
              onDragEnd={onDragEnd}
              title="通常コア（緑）- ドラッグしてコスト支払い・スピリット/ネクサスに配置"
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
                onDragStart={(e) => handleCoreDragStart(e, 'soul')}
                onDragEnd={onDragEnd}
                title="ソウルコア（紫）- ドラッグしてコスト支払い・スピリット/ネクサスに配置"
              />
            ))}
            <span className="core-count">{soulCores}</span>
          </div>
        </div>
      )}

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
        {trashCores === 0 && trashSoulCores === 0 && (
          <div className="core-group trash-empty">
            <span className="core-count">0</span>
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
    </div>
  );
}
