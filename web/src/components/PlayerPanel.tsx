import { useState } from 'react';
import '../styles/PlayerPanel.css';

interface PlayerPanelProps {
  playerNumber: number;
  player: any;
  isCurrent: boolean;
  isOpponent: boolean;
  sessionId?: string;
  onActionExecuted?: () => void;
}

function CardImage({ imagePath, name }: { imagePath?: string; name: string }) {
  if (!imagePath) return null;
  return (
    <img
      className="card-image"
      src={`/${imagePath}`}
      alt={name}
      loading="lazy"
      onError={(e) => {
        // Hide the image if the file is missing; text info below still shows
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  );
}

export default function PlayerPanel({ playerNumber, player, isCurrent, isOpponent, sessionId, onActionExecuted }: PlayerPanelProps) {
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [availableActions, setAvailableActions] = useState<any[]>([]);
  const [isLoadingActions, setIsLoadingActions] = useState(false);
  return (
    <div className={`player-panel ${isOpponent ? 'opponent' : 'self'} ${isCurrent ? 'current' : ''}`}>
      <div className="player-info">
        <div className="player-name">
          <span>プレイヤー {playerNumber}</span>
          {isCurrent && <span className="current-indicator">⭐ ターン中</span>}
        </div>

        <div className="player-stats">
          <div className="stat">
            <span className="label">ライフ</span>
            <span className={`value ${player.life <= 5 ? 'low-life' : ''}`}>{player.life}</span>
          </div>
          <div className="stat">
            <span className="label">コア</span>
            <span className="value">{player.cores}</span>
          </div>
          <div className="stat">
            <span className="label">手札</span>
            <span className="value">{player.handSize}</span>
          </div>
          <div className="stat">
            <span className="label">デッキ</span>
            <span className="value">{player.deck.count}</span>
          </div>
        </div>
      </div>

      {/* Spirits */}
      <div className="field-section">
        <h4>スピリット ({player.spirits.length})</h4>
        <div className="spirits-container">
          {player.spirits.length > 0 ? (
            player.spirits.map((spirit: any, i: number) => (
              <div key={i} className={`spirit-card ${spirit.canAttack ? 'ready' : 'fatigued'}`}>
                <CardImage imagePath={spirit.imagePath} name={spirit.name} />
                <div className="spirit-name">{spirit.name}</div>
                <div className="spirit-stats">
                  <span className="level">Lv{spirit.level}</span>
                  <span className="bp">BP {spirit.bp}</span>
                </div>
                {!spirit.canAttack && <div className="fatigue-badge">疲労</div>}
              </div>
            ))
          ) : (
            <div className="empty">スピリットなし</div>
          )}
        </div>
      </div>

      {/* Nexuses */}
      <div className="field-section">
        <h4>ネクサス ({player.nexuses.length})</h4>
        <div className="nexuses-container">
          {player.nexuses.length > 0 ? (
            player.nexuses.map((nexus: any, i: number) => (
              <div key={i} className="nexus-card">
                <CardImage imagePath={nexus.imagePath} name={nexus.name} />
                <div className="nexus-name">{nexus.name}</div>
                <div className="nexus-level">Lv{nexus.level}</div>
              </div>
            ))
          ) : (
            <div className="empty">ネクサスなし</div>
          )}
        </div>
      </div>

      {/* Hand (hidden if opponent) */}
      {!isOpponent && (
        <div className="field-section">
          <h4>手札 ({player.handSize})</h4>
          <div className="hand-container">
            {player.handCards.length > 0 ? (
              player.handCards.map((card: any, i: number) => (
                <div
                  key={i}
                  className={`hand-card ${selectedCardIndex === i ? 'selected' : ''} ${isCurrent && !isOpponent ? 'clickable' : ''}`}
                  onClick={() => isCurrent && !isOpponent && handleCardClick(i)}
                >
                  <CardImage imagePath={card.imagePath} name={card.name} />
                  <div className="card-name">{card.name}</div>
                  <div className="card-cost">コスト {card.cost}</div>
                </div>
              ))
            ) : (
              <div className="empty">手札なし</div>
            )}
          </div>

          {selectedCardIndex !== null && availableActions.length > 0 && (
            <div className="action-panel">
              <h5>可能なアクション</h5>
              <div className="action-buttons">
                {availableActions.map((action, idx) => (
                  <button
                    key={idx}
                    className="action-button"
                    onClick={() => executeAction(action.index)}
                    disabled={isLoadingActions}
                  >
                    {action.description}
                  </button>
                ))}
              </div>
              <button
                className="action-button cancel"
                onClick={() => {
                  setSelectedCardIndex(null);
                  setAvailableActions([]);
                }}
              >
                キャンセル
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  async function handleCardClick(cardIndex: number) {
    if (!sessionId) return;
    setSelectedCardIndex(cardIndex);
    setIsLoadingActions(true);

    try {
      const response = await fetch(`/api/game/${sessionId}/actions`);
      const data = await response.json();

      // Filter actions related to this hand card (summoning, magic, nexus placement)
      // This is a simplified filter; ideally the backend would support filtering
      const filtered = data.actions.filter((action: any, idx: number) => {
        const desc = action.description.toLowerCase();
        // Check if this action involves the selected card
        return desc.includes('summon') || desc.includes('place') || desc.includes('use') || desc.includes('flash');
      });

      setAvailableActions(filtered.length > 0 ? filtered : data.actions);
    } catch (error) {
      console.error('Failed to fetch actions:', error);
    } finally {
      setIsLoadingActions(false);
    }
  }

  async function executeAction(actionIndex: number) {
    if (!sessionId) return;
    setIsLoadingActions(true);

    try {
      const response = await fetch(`/api/game/${sessionId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionIndex }),
      });

      if (response.ok) {
        setSelectedCardIndex(null);
        setAvailableActions([]);
        onActionExecuted?.();
      } else {
        console.error('Action failed');
      }
    } catch (error) {
      console.error('Failed to execute action:', error);
    } finally {
      setIsLoadingActions(false);
    }
  }
}
