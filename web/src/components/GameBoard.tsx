import { useState, useEffect, useCallback } from 'react';
import PlayerPanel from './PlayerPanel';
import GameInfo from './GameInfo';
import '../styles/GameBoard.css';

interface GameBoardProps {
  sessionId: string;
  onEndGame: () => void;
}

interface LegalAction {
  index: number;
  description: string;
}

export default function GameBoard({ sessionId, onEndGame }: GameBoardProps) {
  const [state, setState] = useState<any>(null);
  const [isTerminal, setIsTerminal] = useState(false);
  const [currentPlayer, setCurrentPlayer] = useState(0);
  const [playerTypes, setPlayerTypes] = useState<string[]>(['human', 'mcts']);
  const [legalActions, setLegalActions] = useState<LegalAction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [gameHistory, setGameHistory] = useState<string[]>([]);

  const isHumanTurn = !isTerminal && playerTypes[currentPlayer] === 'human';

  const fetchGameState = useCallback(async () => {
    try {
      const response = await fetch(`/api/game/${sessionId}/state`);
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer);
      if (data.playerTypes) setPlayerTypes(data.playerTypes);
    } catch (error) {
      console.error('Failed to fetch game state:', error);
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const fetchLegalActions = useCallback(async () => {
    try {
      const response = await fetch(`/api/game/${sessionId}/actions`);
      const data = await response.json();
      setLegalActions(data.actions ?? []);
    } catch (error) {
      console.error('Failed to fetch actions:', error);
    }
  }, [sessionId]);

  // Initial load
  useEffect(() => {
    fetchGameState();
  }, [fetchGameState]);

  // Human turn: load the list of legal actions
  useEffect(() => {
    if (isHumanTurn && state) {
      fetchLegalActions();
    } else {
      setLegalActions([]);
    }
  }, [isHumanTurn, state, fetchLegalActions]);

  // AI turn: play automatically
  useEffect(() => {
    if (!isTerminal && state && !isHumanTurn && !isBusy) {
      const timer = setTimeout(() => {
        playAITurn();
      }, 600);
      return () => clearTimeout(timer);
    }
  }, [isTerminal, state, isHumanTurn, isBusy, currentPlayer]);

  const playAITurn = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/game/${sessionId}/ai-turn`, {
        method: 'POST',
      });
      if (!response.ok) return;
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer ?? data.state.currentPlayer);
      if (data.actionDescription) {
        setGameHistory((prev) => [...prev, data.actionDescription]);
      }
    } catch (error) {
      console.error('Failed to play AI turn:', error);
    } finally {
      setIsBusy(false);
    }
  };

  const executeAction = async (actionIndex: number) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/game/${sessionId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionIndex }),
      });
      if (!response.ok) {
        console.error('Action failed');
        return;
      }
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer ?? data.state.currentPlayer);
      if (data.actionDescription) {
        setGameHistory((prev) => [...prev, data.actionDescription]);
      }
    } catch (error) {
      console.error('Failed to execute action:', error);
    } finally {
      setIsBusy(false);
    }
  };

  if (isLoading || !state) {
    return <div className="loading">ゲーム読み込み中...</div>;
  }

  const p0 = state.players[0];
  const p1 = state.players[1];
  const anyHuman = playerTypes.includes('human');

  // Show a player's hand if they are human, or in AI-vs-AI spectator mode
  const showHand = (n: number) => playerTypes[n] === 'human' || !anyHuman;

  const playerLabel = (n: number) => {
    const t = playerTypes[n];
    return t === 'human' ? '人間' : t === 'mcts' ? 'MCTS AI' : 'ランダムAI';
  };

  return (
    <div className="game-board">
      <div className="game-header">
        <h2>Battle Spirits</h2>
        <div className="game-controls">
          <button className="reset-button" onClick={onEndGame}>
            🔄 リセット
          </button>
        </div>
      </div>

      {/* Action panel for the human player's turn */}
      {isHumanTurn && (
        <div className="action-panel main-action-panel">
          <h5>
            🎯 あなたのターンです（プレイヤー{currentPlayer}）
            {state.pendingAttack && (
              <span className="context-hint">
                — 相手の「{state.pendingAttack.attackerName}」がアタック中！（ダメージ {state.pendingAttack.damage}）
              </span>
            )}
            {state.pendingFlash && <span className="context-hint">— フラッシュタイミング</span>}
          </h5>
          <div className="action-buttons">
            {legalActions.map((action) => (
              <button
                key={action.index}
                className="action-button"
                onClick={() => executeAction(action.index)}
                disabled={isBusy}
              >
                {action.description}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isHumanTurn && !isTerminal && (
        <div className="action-panel main-action-panel thinking">
          🤖 {playerLabel(currentPlayer)}（プレイヤー{currentPlayer}）が考え中...
        </div>
      )}

      <div className="board-container">
        {/* Player 1 */}
        <PlayerPanel
          playerNumber={1}
          player={p1}
          isCurrent={currentPlayer === 1}
          showHand={showHand(1)}
          typeLabel={playerLabel(1)}
        />

        {/* Game info center */}
        <GameInfo
          turnCount={state.turnCount}
          currentPlayer={currentPlayer}
          isTerminal={isTerminal}
          result={state.result}
          gameHistory={gameHistory}
        />

        {/* Player 0 */}
        <PlayerPanel
          playerNumber={0}
          player={p0}
          isCurrent={currentPlayer === 0}
          showHand={showHand(0)}
          typeLabel={playerLabel(0)}
        />
      </div>

      {isTerminal && (
        <div className="game-over">
          <div className="game-over-content">
            <h3>ゲーム終了</h3>
            {state.result?.winner === null ? (
              <p>ドロー</p>
            ) : (
              <p>プレイヤー{state.result?.winner}（{playerLabel(state.result?.winner)}）の勝利！</p>
            )}
            <button onClick={onEndGame}>新しいゲームを開始</button>
          </div>
        </div>
      )}
    </div>
  );
}
