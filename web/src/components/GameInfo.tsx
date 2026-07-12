import '../styles/GameInfo.css';

interface GameInfoProps {
  turnCount: number;
  currentPlayer: number;
  isTerminal: boolean;
  result: any;
  gameHistory: string[];
}

export default function GameInfo({
  turnCount,
  currentPlayer,
  isTerminal,
  result,
  gameHistory,
}: GameInfoProps) {
  return (
    <div className="game-info">
      <div className="info-header">
        <h3>ゲーム情報</h3>
      </div>

      <div className="info-content">
        <div className="info-stat">
          <span className="label">ターン数</span>
          <span className="value">{turnCount}</span>
        </div>

        <div className="info-stat">
          <span className="label">現在のプレイヤー</span>
          <span className="value">P{currentPlayer}</span>
        </div>

        {isTerminal && result && (
          <div className="result-info">
            {result.winner === null ? (
              <div className="draw">ドロー</div>
            ) : (
              <div className="winner">P{result.winner}の勝利</div>
            )}
          </div>
        )}
      </div>

      <div className="game-history">
        <h4>行動履歴</h4>
        <div className="history-list">
          {gameHistory.length > 0 ? (
            gameHistory.map((action, i) => (
              <div key={i} className="history-item">
                <span className="turn-number">{i + 1}.</span>
                <span className="action">{action}</span>
              </div>
            ))
          ) : (
            <div className="empty">まだ行動がありません</div>
          )}
        </div>
      </div>
    </div>
  );
}
