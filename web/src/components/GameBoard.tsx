import { useState, useEffect, useCallback, useRef } from 'react';
import PlayerPanel from './PlayerPanel';
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
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const isHumanTurn = !isTerminal && playerTypes[currentPlayer] === 'human';

  const fetchGameState = useCallback(async () => {
    try {
      const response = await fetch(`/api/game/${sessionId}/state`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer);
      if (data.playerTypes) setPlayerTypes(data.playerTypes);
      setError(null);
    } catch (error) {
      console.error('Failed to fetch game state:', error);
      setError('ゲーム状態の取得に失敗しました。サーバー（npm start）が起動しているか確認してください。');
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

  // Keep the history scrolled to the latest entry
  useEffect(() => {
    if (historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [gameHistory]);

  const playAITurn = async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/game/${sessionId}/ai-turn`, {
        method: 'POST',
      });
      if (!response.ok) {
        // Turn may have passed to a human between renders; resync state
        await fetchGameState();
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
        setError('アクションの実行に失敗しました。もう一度お試しください。');
        await fetchGameState();
        return;
      }
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer ?? data.state.currentPlayer);
      setError(null);
      if (data.actionDescription) {
        setGameHistory((prev) => [...prev, data.actionDescription]);
      }
    } catch (error) {
      console.error('Failed to execute action:', error);
      setError('サーバーとの通信に失敗しました。サーバー（npm start）が起動しているか確認してください。');
    } finally {
      setIsBusy(false);
    }
  };

  if (isLoading || !state) {
    return <div className="loading">ゲーム読み込み中...</div>;
  }

  const anyHuman = playerTypes.includes('human');

  // Human player sits at the bottom; in AI-vs-AI, P0 sits at the bottom
  const bottomPlayer = playerTypes[1] === 'human' && playerTypes[0] !== 'human' ? 1 : 0;
  const topPlayer = 1 - bottomPlayer;

  // Show a player's hand if they are human, or in AI-vs-AI spectator mode
  const showHand = (n: number) => playerTypes[n] === 'human' || !anyHuman;

  const playerLabel = (n: number) => {
    const t = playerTypes[n];
    return t === 'human' ? '人間' : t === 'mcts' ? 'MCTS AI' : 'ランダムAI';
  };

  return (
    <div className="game-screen">
      {/* ===== Battle area (left) ===== */}
      <div className="battle-area">
        <PlayerPanel
          playerNumber={topPlayer}
          player={state.players[topPlayer]}
          isCurrent={currentPlayer === topPlayer}
          showHand={showHand(topPlayer)}
          typeLabel={playerLabel(topPlayer)}
          position="top"
        />

        <div className="center-bar">
          <span className="turn-chip">ターン {state.turnCount + 1}</span>
          {state.pendingAttack ? (
            <span className="center-alert attack">
              ⚔️ 「{state.pendingAttack.attackerName}」がアタック中！（ライフダメージ {state.pendingAttack.damage}）
            </span>
          ) : state.pendingFlash ? (
            <span className="center-alert flash">⚡ フラッシュタイミング</span>
          ) : (
            <span className="center-phase">メインステップ</span>
          )}
          <span className="turn-owner">
            {isTerminal ? 'ゲーム終了' : `P${currentPlayer}（${playerLabel(currentPlayer)}）の番`}
          </span>
        </div>

        <PlayerPanel
          playerNumber={bottomPlayer}
          player={state.players[bottomPlayer]}
          isCurrent={currentPlayer === bottomPlayer}
          showHand={showHand(bottomPlayer)}
          typeLabel={playerLabel(bottomPlayer)}
          position="bottom"
        />
      </div>

      {/* ===== Side panel (right) ===== */}
      <aside className="side-panel">
        <div className="side-header">
          <strong>Battle Spirits</strong>
          <button className="reset-button" onClick={onEndGame}>🔄 リセット</button>
        </div>

        {error && <div className="error-banner side-error">⚠️ {error}</div>}

        <div className="side-actions">
          {isHumanTurn ? (
            <>
              <div className="side-actions-title">
                🎯 あなたの番です
                {state.pendingAttack && <span className="hint attack">防御するか選択</span>}
                {state.pendingFlash && <span className="hint flash">フラッシュ使用可</span>}
              </div>
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
            </>
          ) : !isTerminal ? (
            <div className="thinking">🤖 {playerLabel(currentPlayer)} 考え中...</div>
          ) : (
            <div className="thinking">ゲーム終了</div>
          )}
        </div>

        <div className="side-history">
          <div className="side-history-title">行動履歴</div>
          <div className="history-list" ref={historyRef}>
            {gameHistory.length > 0 ? (
              gameHistory.map((action, i) => (
                <div key={i} className="history-item">
                  <span className="turn-number">{i + 1}.</span> {action}
                </div>
              ))
            ) : (
              <div className="history-empty">まだ行動がありません</div>
            )}
          </div>
        </div>
      </aside>

      {/* ===== Game over overlay ===== */}
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
