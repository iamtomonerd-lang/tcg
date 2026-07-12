import '../styles/PlayerPanel.css';

interface PlayerPanelProps {
  playerNumber: number;
  player: any;
  isCurrent: boolean;
  isOpponent: boolean;
}

export default function PlayerPanel({ playerNumber, player, isCurrent, isOpponent }: PlayerPanelProps) {
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
                <div key={i} className="hand-card">
                  <div className="card-name">{card.name}</div>
                  <div className="card-cost">コスト {card.cost}</div>
                </div>
              ))
            ) : (
              <div className="empty">手札なし</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
