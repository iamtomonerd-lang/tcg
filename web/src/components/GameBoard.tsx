import { useState, useEffect } from 'react';
import PlayerPanel from './PlayerPanel';
import GameInfo from './GameInfo';
import '../styles/GameBoard.css';

interface GameBoardProps {
  sessionId: string;
  onEndGame: () => void;
}

export default function GameBoard({ sessionId, onEndGame }: GameBoardProps) {
  const [state, setState] = useState<any>(null);
  const [isTerminal, setIsTerminal] = useState(false);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [autoPlay, setAutoPlay] = useState(true);
  const [gameHistory, setGameHistory] = useState<string[]>([]);
  const [gameMode, setGameMode] = useState<'ai-vs-ai' | 'human-vs-ai' | 'human-vs-human'>('ai-vs-ai');

  useEffect(() => {
    fetchGameState();
  }, [sessionId]);

  useEffect(() => {
    if (autoPlay && !isTerminal && state) {
      // Don't autoplay if current player is human in human vs ai mode
      const isCurrentPlayerHuman = gameMode === 'human-vs-ai' && currentPlayer === 0;
      if (!isCurrentPlayerHuman) {
        const timer = setTimeout(() => {
          playAITurn();
        }, 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [autoPlay, isTerminal, state, gameMode, currentPlayer]);

  const fetchGameState = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`/api/game/${sessionId}/state`);
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer);
    } catch (error) {
      console.error('Failed to fetch game state:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const playAITurn = async () => {
    try {
      const response = await fetch(`/api/game/${sessionId}/ai-turn`, {
        method: 'POST',
      });
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.state.currentPlayer);

      if (data.actionDescription) {
        setGameHistory((prev) => [...prev, data.actionDescription]);
      }
    } catch (error) {
      console.error('Failed to play AI turn:', error);
    }
  };

  const handleResetGame = () => {
    onEndGame();
  };

  if (isLoading || !state) {
    return <div className="loading">ゲーム読み込み中...</div>;
  }

  const p0 = state.players[0];
  const p1 = state.players[1];

  return (
    <div className="game-board">
      <div className="game-header">
        <h2>Battle Spirits - ゲーム進行中</h2>
        <div className="game-controls">
          <button
            className={`auto-play-button ${autoPlay ? 'active' : ''}`}
            onClick={() => setAutoPlay(!autoPlay)}
          >
            {autoPlay ? '⏸ 一時停止' : '▶️ 再生'}
          </button>
          <button className="reset-button" onClick={handleResetGame}>
            🔄 リセット
          </button>
        </div>
      </div>

      <div className="board-container">
        {/* Player 1 (bottom) */}
        <PlayerPanel
          playerNumber={1}
          player={p1}
          isCurrent={currentPlayer === 1}
          isOpponent={false}
          sessionId={sessionId}
          onActionExecuted={fetchGameState}
        />

        {/* Game info center */}
        <GameInfo
          turnCount={state.turnCount}
          currentPlayer={currentPlayer}
          isTerminal={isTerminal}
          result={state.result}
          gameHistory={gameHistory}
        />

        {/* Player 0 (top) */}
        <PlayerPanel
          playerNumber={0}
          player={p0}
          isCurrent={currentPlayer === 0}
          isOpponent={true}
          sessionId={sessionId}
          onActionExecuted={fetchGameState}
        />
      </div>

      {isTerminal && (
        <div className="game-over">
          <div className="game-over-content">
            <h3>ゲーム終了</h3>
            {state.result?.winner === null ? (
              <p>ドロー</p>
            ) : (
              <p>プレイヤー{state.result?.winner}の勝利！</p>
            )}
            <button onClick={handleResetGame}>新しいゲームを開始</button>
          </div>
        </div>
      )}
    </div>
  );
}
