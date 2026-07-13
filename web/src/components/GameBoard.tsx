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
  const [dragData, setDragData] = useState<any>(null);
  const [dragOverCard, setDragOverCard] = useState<string | null>(null);
  const [selectedCoreType, setSelectedCoreType] = useState<'regular' | 'soul' | null>(null);
  const [arrangedCardIndices, setArrangedCardIndices] = useState<number[]>([]);
  const [selectedHandIndices, setSelectedHandIndices] = useState<Set<number>>(new Set());
  const [pendingCoreCost, setPendingCoreCost] = useState<{
    actionIndex: number;
    requiredCores: number;
    paidRegular: number;
    paidSoul: number;
    cardName: string;
  } | null>(null);
  const [selectedCardImage, setSelectedCardImage] = useState<{ imagePath: string; name: string } | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const isHumanTurn = !isTerminal && playerTypes[currentPlayer] === 'human';

  // Helper: check if a card can be afforded
  const canAffordCard = (card: any): boolean => {
    if (!state) return false;
    const me = state.players[currentPlayer];
    let totalCores = me.cores + me.soulCores;
    // Include cores on spirits
    for (const spirit of me.spirits) {
      totalCores += spirit.coreCount + spirit.soulCoreCount;
    }

    if (card.cardType === 'spirit') {
      // Spirit requires cost + Lv1 cost
      return totalCores >= card.cost + (card.lv1?.cost || 0);
    } else if (card.cardType === 'nexus') {
      return totalCores >= card.cost;
    } else if (card.cardType === 'magic') {
      return totalCores >= card.cost;
    }
    return true;
  };

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
    const initGame = async () => {
      await fetchGameState();
    };
    initGame();
  }, [fetchGameState]);

  // Human turn: load the list of legal actions
  useEffect(() => {
    if (isHumanTurn && state) {
      fetchLegalActions();
    } else {
      setLegalActions([]);
    }
  }, [isHumanTurn, state]);

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

  // Reset arranged cards and selected hand cards when pending draw changes
  useEffect(() => {
    if (state?.pendingDraw) {
      setArrangedCardIndices([...state.pendingDraw.toRearrangeIndices]);
      setSelectedHandIndices(new Set());
    }
  }, [state?.pendingDraw]);

  // Reset pending core cost when game state changes
  useEffect(() => {
    setPendingCoreCost(null);
  }, [state]);

  // Close card image modal on Esc key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedCardImage(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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

  const executeAction = async (actionIndex: number, options?: { cardIndices?: number[]; selectedCardIndices?: number[]; arrangedCardIndices?: number[]; coreType?: 'regular' | 'soul' }) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const body: any = { actionIndex };
      if (options?.cardIndices !== undefined) {
        body.cardIndices = options.cardIndices;
      }
      if (options?.selectedCardIndices !== undefined) {
        body.selectedCardIndices = options.selectedCardIndices;
      }
      if (options?.arrangedCardIndices !== undefined) {
        body.arrangedCardIndices = options.arrangedCardIndices;
      }
      if (options?.coreType !== undefined) {
        body.coreType = options.coreType;
      }
      const response = await fetch(`/api/game/${sessionId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  const handleDragStart = (data: any) => {
    setDragData(data);
    if (data.type === 'hand-card') {
      setDragOverCard(`hand-${data.handIndex}`);
    } else if (data.type === 'core') {
      // Core drag: select the core type for payment
      setSelectedCoreType(data.coreType);
      // For visual feedback during core drag
      setDragOverCard('core-drag');
    }
  };

  const handleDragEnd = () => {
    setDragData(null);
    setDragOverCard(null);
    setSelectedCoreType(null);
  };

  const handleDrop = (dropData: any) => {
    if (!dragData || !isHumanTurn || isBusy) return;

    // If we're waiting for core payment, handle core drop
    if (pendingCoreCost && dragData.type === 'core') {
      const coreAmount = 1; // Each core is 1
      const coreType = dragData.coreType as 'regular' | 'soul';
      const newPaidRegular = coreType === 'regular' ? pendingCoreCost.paidRegular + coreAmount : pendingCoreCost.paidRegular;
      const newPaidSoul = coreType === 'soul' ? pendingCoreCost.paidSoul + coreAmount : pendingCoreCost.paidSoul;
      const totalPaid = newPaidRegular + newPaidSoul;

      if (totalPaid <= pendingCoreCost.requiredCores) {
        setPendingCoreCost({
          ...pendingCoreCost,
          paidRegular: newPaidRegular,
          paidSoul: newPaidSoul,
        });

        // If we've paid enough cores, execute the action
        if (totalPaid >= pendingCoreCost.requiredCores) {
          const actionIndex = pendingCoreCost.actionIndex;
          setPendingCoreCost(null);
          setDragData(null);
          setDragOverCard(null);
          setSelectedCoreType(null);

          // Determine which core type to report (prefer regular if both paid)
          const selectedType = newPaidRegular >= newPaidSoul ? 'regular' : 'soul';
          // Execute the action with the core type
          setTimeout(() => {
            executeAction(actionIndex, { coreType: selectedType });
          }, 50);
        }
      } else {
        setError(`必要なコアは${pendingCoreCost.requiredCores}個です。すでに${totalPaid}個支払っています。`);
      }

      setDragData(null);
      setSelectedCoreType(null);
      return;
    }

    setDragData(null);
    setDragOverCard(null);

    // Find matching action based on drag data
    let matchingAction: LegalAction | undefined;
    let coreType: 'regular' | 'soul' | undefined = selectedCoreType ?? undefined;

    if (dragData.type === 'hand-card' && dragData.card) {
      // Search for an action involving this card
      const cardName = dragData.card.name;
      matchingAction = legalActions.find((action) =>
        action.description.includes(cardName)
      );

      // If found, check the cost and potentially enter core payment waiting mode
      if (matchingAction) {
        const checkCost = async () => {
          try {
            const response = await fetch(`/api/game/${sessionId}/action-cost`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ actionIndex: matchingAction.index }),
            });
            const data = await response.json();
            const cost = data.cost ?? 0;

            if (cost > 0) {
              // Enter core payment waiting mode
              setPendingCoreCost({
                actionIndex: matchingAction.index,
                requiredCores: cost,
                paidRegular: 0,
                paidSoul: 0,
                cardName: dragData.card.name,
              });
              setError(`「${dragData.card.name}」のコスト${cost}個を支払ってください。通常コア（緑）またはソウルコア（紫）をドラッグします。`);
            } else {
              // No cost, execute immediately
              executeAction(matchingAction.index, { coreType });
            }
          } catch (err) {
            console.error('Failed to get action cost:', err);
            executeAction(matchingAction.index, { coreType });
          }
        };
        checkCost();
        return;
      }
    } else if (dragData.type === 'spirit') {
      // For spirit drags (core placement), find add_core action for THIS spirit
      const spiritName = dragData.spirit?.def?.name || dragData.spirit?.name;
      matchingAction = legalActions.find((action) =>
        spiritName && action.description.includes(spiritName) && action.description.includes('コア')
      );
    } else if (dragData.type === 'core') {
      // Core dragged onto hand card: use magic with specified core type
      if (dropData.handIndex !== undefined) {
        const card = state?.players[currentPlayer]?.handCards?.[dropData.handIndex];
        const cardName = card?.name;
        matchingAction = legalActions.find((action) =>
          cardName && action.description.includes(cardName)
        );
      } else if (dropData.spiritIndex !== undefined) {
        // Core dragged onto spirit: find add_core action for THIS specific spirit
        const targetSpirit = state?.players[currentPlayer]?.spirits[dropData.spiritIndex];
        const spiritName = targetSpirit?.name;
        matchingAction = legalActions.find((action) =>
          spiritName && action.description.includes(spiritName) && action.description.includes('コア')
        );
      }
    }

    if (matchingAction) {
      executeAction(matchingAction.index, { coreType });
    } else if (!pendingCoreCost) {
      setError(`ドラッグ操作は無効です。アクションボタンから実行してください。`);
    }
    setSelectedCoreType(null);
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

  const getPhaseLabel = (phase: string) => {
    const labels: { [key: string]: string } = {
      'start': 'スタートフェーズ',
      'core': 'コアリカバリーフェーズ',
      'draw': 'ドローフェーズ',
      'refresh': 'リフレッシュフェーズ',
      'main': 'メインフェーズ',
      'attack': 'アタックフェーズ',
      'main2': 'メイン2フェーズ',
      'end': 'エンドフェーズ',
    };
    return labels[phase] || 'フェーズ';
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
          isHumanTurn={isHumanTurn}
          legalActions={legalActions}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          dragOverCard={dragOverCard}
          onCardRightClick={(imagePath, name) => setSelectedCardImage({ imagePath: imagePath || '', name })}
          canAffordCard={canAffordCard}
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
            <span className="center-phase">{getPhaseLabel(state.phase)}</span>
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
          isHumanTurn={isHumanTurn}
          legalActions={legalActions}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          dragOverCard={dragOverCard}
          onCardRightClick={(imagePath, name) => setSelectedCardImage({ imagePath: imagePath || '', name })}
          canAffordCard={canAffordCard}
        />
      </div>

      {/* ===== Side panel (right) ===== */}
      <aside className="side-panel">
        <div className="side-header">
          <strong>Battle Spirits</strong>
          <button className="reset-button" onClick={onEndGame}>🔄 リセット</button>
        </div>

        {error && <div className="error-banner side-error">⚠️ {error}</div>}

        {pendingCoreCost && (
          <div style={{
            padding: '1rem',
            backgroundColor: '#f0e8f8',
            borderRadius: '8px',
            marginBottom: '1rem',
            border: '2px solid #9f7aea',
          }}>
            <div style={{ fontWeight: 700, marginBottom: '0.6rem', textAlign: 'center', fontSize: '1rem' }}>
              💎 コア支払い: 「{pendingCoreCost.cardName}」
            </div>
            <div style={{ fontSize: '0.95rem', marginBottom: '0.8rem', textAlign: 'center', fontWeight: 600 }}>
              必要: {pendingCoreCost.requiredCores}個
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '0.8rem',
              marginBottom: '0.8rem',
            }}>
              <div style={{
                padding: '0.6rem',
                backgroundColor: 'rgba(30, 126, 77, 0.15)',
                borderRadius: '6px',
                textAlign: 'center',
                border: '2px solid #3eb876',
              }}>
                <div style={{ fontSize: '0.8rem', color: '#1e7e4d', marginBottom: '0.3rem', fontWeight: 600 }}>通常コア</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#1e7e4d' }}>{pendingCoreCost.paidRegular}</div>
              </div>
              <div style={{
                padding: '0.6rem',
                backgroundColor: 'rgba(107, 70, 193, 0.15)',
                borderRadius: '6px',
                textAlign: 'center',
                border: '2px solid #9f7aea',
              }}>
                <div style={{ fontSize: '0.8rem', color: '#6b46c1', marginBottom: '0.3rem', fontWeight: 600 }}>ソウルコア</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#6b46c1' }}>{pendingCoreCost.paidSoul}</div>
              </div>
            </div>
            <div style={{
              fontSize: '0.9rem',
              marginBottom: '0.6rem',
              textAlign: 'center',
              padding: '0.6rem',
              backgroundColor: '#fff5f7',
              borderRadius: '4px',
              fontWeight: 500,
            }}>
              残り {Math.max(0, pendingCoreCost.requiredCores - pendingCoreCost.paidRegular - pendingCoreCost.paidSoul)}個
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.8rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <button
                  onClick={() => {
                    const totalPaid = pendingCoreCost.paidRegular + pendingCoreCost.paidSoul;
                    if (totalPaid < pendingCoreCost.requiredCores) {
                      const newPaid = pendingCoreCost.paidRegular + 1;
                      const newTotal = newPaid + pendingCoreCost.paidSoul;
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        paidRegular: newPaid,
                      });
                      if (newTotal >= pendingCoreCost.requiredCores) {
                        const actionIndex = pendingCoreCost.actionIndex;
                        setTimeout(() => {
                          executeAction(actionIndex, { coreType: 'regular' });
                          setPendingCoreCost(null);
                        }, 50);
                      }
                    }
                  }}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: '#1e7e4d',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                  }}
                >
                  🟢 通常 +1
                </button>
                {pendingCoreCost.paidRegular > 0 && (
                  <button
                    onClick={() => {
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        paidRegular: Math.max(0, pendingCoreCost.paidRegular - 1),
                      });
                    }}
                    style={{
                      padding: '0.4rem',
                      backgroundColor: '#8b5555',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                    }}
                  >
                    -1
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <button
                  onClick={() => {
                    const totalPaid = pendingCoreCost.paidRegular + pendingCoreCost.paidSoul;
                    if (totalPaid < pendingCoreCost.requiredCores) {
                      const newPaid = pendingCoreCost.paidSoul + 1;
                      const newTotal = pendingCoreCost.paidRegular + newPaid;
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        paidSoul: newPaid,
                      });
                      if (newTotal >= pendingCoreCost.requiredCores) {
                        const actionIndex = pendingCoreCost.actionIndex;
                        setTimeout(() => {
                          executeAction(actionIndex, { coreType: 'soul' });
                          setPendingCoreCost(null);
                        }, 50);
                      }
                    }
                  }}
                  style={{
                    padding: '0.5rem',
                    backgroundColor: '#6b46c1',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 700,
                    fontSize: '0.85rem',
                  }}
                >
                  🟣 ソウル +1
                </button>
                {pendingCoreCost.paidSoul > 0 && (
                  <button
                    onClick={() => {
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        paidSoul: Math.max(0, pendingCoreCost.paidSoul - 1),
                      });
                    }}
                    style={{
                      padding: '0.4rem',
                      backgroundColor: '#8b5555',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                    }}
                  >
                    -1
                  </button>
                )}
              </div>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#666', textAlign: 'center', padding: '0.6rem', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
              ドラッグまたはボタンで支払い（キャンセルは「リセット」ボタン）
            </div>
          </div>
        )}

        <div className="side-actions">
          {state.pendingDraw ? (
            <>
              <div className="side-actions-title">📖 カード配置</div>
              <div className="draw-cards">
                {state.pendingDraw.toHandIndices.length > 0 && (
                  <div className="draw-section">
                    <div className="draw-section-title">手札に追加（クリックで選択）</div>
                    {state.pendingDraw.toHandIndices.map((idx) => {
                      const card = state.pendingDraw.openedCards[idx];
                      const isSelected = selectedHandIndices.has(idx);
                      const canSelect = isSelected || selectedHandIndices.size < 2;
                      return (
                        <button
                          key={`hand-${idx}`}
                          className={`draw-card-selectable ${isSelected ? 'selected' : ''}`}
                          onClick={() => {
                            if (!canSelect) return;
                            const newSelected = new Set(selectedHandIndices);
                            if (isSelected) {
                              newSelected.delete(idx);
                            } else {
                              newSelected.add(idx);
                            }
                            setSelectedHandIndices(newSelected);
                          }}
                          disabled={!canSelect}
                        >
                          <div className="draw-card-name">{card.name}</div>
                          <div className="draw-card-cost">コスト{card.cost}</div>
                          <div className="draw-card-checkmark">{isSelected ? '✓' : ''}</div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {state.pendingDraw.toRearrangeIndices.length > 0 && (
                  <div className="draw-section">
                    <div className="draw-section-title">山札下に戻す（順序変更可能）</div>
                    {arrangedCardIndices.map((cardIdx, order) => {
                      const card = state.pendingDraw.openedCards[cardIdx];
                      const isFirst = order === 0;
                      const isLast = order === arrangedCardIndices.length - 1;
                      return (
                        <div key={`arrange-${cardIdx}`} className="draw-card-with-controls">
                          <div className="draw-card-display">
                            <div className="draw-card-name">{card.name}</div>
                            <div className="draw-card-cost">コスト{card.cost}</div>
                          </div>
                          <div className="draw-card-controls">
                            <button
                              className="draw-move-btn"
                              onClick={() => {
                                if (!isFirst) {
                                  const newArr = [...arrangedCardIndices];
                                  [newArr[order - 1], newArr[order]] = [newArr[order], newArr[order - 1]];
                                  setArrangedCardIndices(newArr);
                                }
                              }}
                              disabled={isFirst}
                            >
                              ↑
                            </button>
                            <button
                              className="draw-move-btn"
                              onClick={() => {
                                if (!isLast) {
                                  const newArr = [...arrangedCardIndices];
                                  [newArr[order], newArr[order + 1]] = [newArr[order + 1], newArr[order]];
                                  setArrangedCardIndices(newArr);
                                }
                              }}
                              disabled={isLast}
                            >
                              ↓
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                className="action-button"
                onClick={() => {
                  if (isHumanTurn) {
                    const selectedIndices = Array.from(selectedHandIndices);
                    executeAction(0, { selectedCardIndices: selectedIndices, arrangedCardIndices });
                  }
                }}
                disabled={isBusy}
              >
                確定
              </button>
            </>
          ) : isHumanTurn ? (
            <>
              <div className="side-actions-title">
                🎯 あなたの番です
                {state.pendingAttack && <span className="hint attack">防御するか選択</span>}
                {state.pendingFlash && <span className="hint flash">フラッシュ使用可</span>}
              </div>
              {!state.pendingAttack && !state.pendingFlash && (
                <div style={{ fontSize: '0.8rem', color: '#666', padding: '0.5rem 0.8rem', backgroundColor: '#f0f0f0', borderRadius: '4px', marginBottom: '0.8rem', lineHeight: '1.4' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>プレイ手順:</div>
                  <div>1️⃣ カードを場にドラッグ</div>
                  <div>2️⃣ コアを支払う</div>
                  <div>3️⃣ コアをスピリットに乗せる</div>
                </div>
              )}
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

      {/* ===== Card image modal ===== */}
      {selectedCardImage && (
        <div
          className="card-image-modal"
          onClick={() => setSelectedCardImage(null)}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="card-image-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-image-modal-title">{selectedCardImage.name}</div>
            {selectedCardImage.imagePath ? (
              <img
                src={`/${selectedCardImage.imagePath}`}
                alt={selectedCardImage.name}
                className="card-image-modal-img"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div className="card-image-modal-empty">画像がありません</div>
            )}
            <div className="card-image-modal-hint">クリックまたは Esc で閉じる</div>
          </div>
        </div>
      )}

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
