import { useState, useEffect, useCallback, useRef } from 'react';
import PlayerPanel from './PlayerPanel';
import '../styles/GameBoard.css';

interface GameBoardProps {
  sessionId: string;
  p1Rating?: number;
  onEndGame: () => void;
}

interface LegalAction {
  index: number;
  description: string;
}

export default function GameBoard({ sessionId, p1Rating, onEndGame }: GameBoardProps) {
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
    useInheritance?: boolean;
    hasInheritance?: boolean;
  } | null>(null);
  const [selectedCardImage, setSelectedCardImage] = useState<{ imagePath: string; name: string } | null>(null);
  const [trashViewPlayer, setTrashViewPlayer] = useState<number | null>(null);
  const [bottomDeckViewPlayer, setBottomDeckViewPlayer] = useState<number | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const isHumanTurn = !isTerminal && (
    // Order choice phase: only winner can choose
    (state?.pendingDiceRoll && state.pendingDiceRoll.winner !== undefined && playerTypes[state.pendingDiceRoll.winner] === 'human')
    ||
    // Mulligan phase
    (state?.pendingMulligan && playerTypes[state.pendingMulligan.player] === 'human')
    ||
    // Regular turn phase
    (!state?.pendingDiceRoll && !state?.pendingMulligan && playerTypes[currentPlayer] === 'human')
  );

  const fetchGameState = useCallback(async () => {
    try {
      const response = await fetch(`/api/game/${sessionId}/state`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.state.pendingDiceRoll) {
        console.log(`[Client] Received dice roll state: p0Roll=${data.state.pendingDiceRoll.p0Roll}, p1Roll=${data.state.pendingDiceRoll.p1Roll}, winner=${data.state.pendingDiceRoll.winner}`);
      }
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

  // Initialize game history with first player info and track turn starts
  useEffect(() => {
    if (state && gameHistory.length === 0) {
      const p0Name = playerTypes[0] === 'human' ? 'あなた' : 'AI';
      const p1Name = playerTypes[1] === 'human' ? 'あなた' : 'AI';
      const firstPlayerIdx = state.pendingMulligan?.firstPlayer ?? state.currentPlayer;
      const firstPlayerName = firstPlayerIdx === 0 ? p0Name : p1Name;
      const secondPlayerName = firstPlayerIdx === 0 ? p1Name : p0Name;
      setGameHistory([
        `🎮 【ゲーム開始】`,
        `先手（Player${firstPlayerIdx}）: ${firstPlayerName}`,
        `後手（Player${1 - firstPlayerIdx}）: ${secondPlayerName}`,
        '---',
      ]);
    }
  }, [state?.turnCount, gameHistory.length]);

  // Track turn starts
  const prevTurnCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (state && state.turnCount !== prevTurnCountRef.current && state.turnCount > 0 && !state.pendingMulligan) {
      const playerIdx = state.currentPlayer;
      const playerName = playerTypes[playerIdx] === 'human' ? 'あなた' : 'AI';
      const turnInfo = `\n📍 【ターン${state.turnCount}】 Player${playerIdx}（${playerName}）のターン`;
      setGameHistory((prev) => [...prev, turnInfo]);
      prevTurnCountRef.current = state.turnCount;
    }
  }, [state?.turnCount, state?.currentPlayer, playerTypes, state?.pendingMulligan]);

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

  // Debug logging for dice roll state
  useEffect(() => {
    if (state?.pendingDiceRoll) {
      console.log(`[GameBoard Render] DiceRoll State: p0Roll=${state.pendingDiceRoll.p0Roll}, p1Roll=${state.pendingDiceRoll.p1Roll}, winner=${state.pendingDiceRoll.winner}`);
    } else if (!isTerminal && state?.pendingMulligan) {
      console.log(`[GameBoard Render] Mulligan phase - no pendingDiceRoll`);
    } else if (!isTerminal && !state?.pendingDiceRoll && !state?.pendingMulligan) {
      console.log(`[GameBoard Render] Regular game phase`);
    }
  }, [state?.pendingDiceRoll, state?.pendingMulligan, isTerminal]);

  // Poll during dice roll phase to show results
  useEffect(() => {
    if (!state || isBusy || isTerminal) return;
    if (!state.pendingDiceRoll || state.pendingDiceRoll.winner !== undefined) {
      return;
    }

    // Poll every 200ms during dice roll phase to see results
    const timer = setTimeout(() => {
      fetchGameState();
    }, 200);

    return () => clearTimeout(timer);
  }, [state?.pendingDiceRoll?.p0Roll, state?.pendingDiceRoll?.p1Roll, state?.pendingDiceRoll?.winner, isBusy, isTerminal, sessionId, fetchGameState]);

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
        const historyEntries = [data.actionDescription];
        if (data.effectResults && Array.isArray(data.effectResults)) {
          historyEntries.push(...data.effectResults.map((r: any) => `  ${r.description}`));
        }
        setGameHistory((prev) => [...prev, ...historyEntries]);
      }
    } catch (error) {
      console.error('Failed to play AI turn:', error);
    } finally {
      setIsBusy(false);
    }
  };

  const executeAction = async (actionIndex: number, options?: { cardIndices?: number[]; selectedCardIndices?: number[]; arrangedCardIndices?: number[]; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean }) => {
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
      if (options?.paidRegularCores !== undefined) {
        body.paidRegularCores = options.paidRegularCores;
      }
      if (options?.paidSoulCores !== undefined) {
        body.paidSoulCores = options.paidSoulCores;
      }
      if (options?.useInheritance !== undefined) {
        body.useInheritance = options.useInheritance;
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
        const historyEntries = [data.actionDescription];
        if (data.effectResults && Array.isArray(data.effectResults)) {
          historyEntries.push(...data.effectResults.map((r: any) => `  ${r.description}`));
        }
        setGameHistory((prev) => [...prev, ...historyEntries]);
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

  // Move a core freely between reserve / spirit / nexus (drag & drop)
  const executeMoveCore = async (moveCore: {
    fromZone: 'reserve' | 'spirit' | 'nexus';
    fromIndex?: number;
    toZone: 'reserve' | 'spirit' | 'nexus';
    toIndex?: number;
    coreType: 'regular' | 'soul';
  }) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      const response = await fetch(`/api/game/${sessionId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moveCore }),
      });
      if (!response.ok) {
        setError('コアの移動に失敗しました。');
        await fetchGameState();
        return;
      }
      const data = await response.json();
      setState(data.state);
      setIsTerminal(data.isTerminal);
      setCurrentPlayer(data.currentPlayer ?? data.state.currentPlayer);
      setError(null);
    } catch (error) {
      console.error('Failed to move core:', error);
      setError('サーバーとの通信に失敗しました。');
    } finally {
      setIsBusy(false);
    }
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

          // Execute the action with exact core type counts
          setTimeout(() => {
            executeAction(actionIndex, {
              paidRegularCores: newPaidRegular,
              paidSoulCores: newPaidSoul,
              useInheritance: pendingCoreCost.useInheritance,
            });
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
                useInheritance: dragData.card.inheritance ?? false, // Default to using inheritance if available
                hasInheritance: dragData.card.inheritance ?? false,
              });
              setError(`【支払うコア】「${dragData.card.name}」のコスト${cost}個を支払ってください。通常コア（🟢）またはソウルコア（🟣）をドラッグまたはボタンで選択します。`);
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
      // Free core movement via drag & drop (reserve ⇄ spirit ⇄ nexus)
      const source = dragData.source ?? { zone: 'reserve' };
      const dragCoreType = dragData.coreType as 'regular' | 'soul';

      // Only own field targets are valid destinations
      if (dropData.targetPlayerNumber !== undefined && dropData.targetPlayerNumber !== currentPlayer) {
        setError('相手の場にはコアを置けません。');
        setSelectedCoreType(null);
        return;
      }

      let toZone: 'reserve' | 'spirit' | 'nexus' | null = null;
      let toIndex: number | undefined;
      if (dropData.targetZone === 'reserve') {
        toZone = 'reserve';
      } else if (dropData.targetZone === 'spirit' && dropData.spiritIndex !== undefined) {
        toZone = 'spirit';
        toIndex = dropData.spiritIndex;
      } else if (dropData.targetZone === 'nexus' && dropData.nexusIndex !== undefined) {
        toZone = 'nexus';
        toIndex = dropData.nexusIndex;
      }

      if (toZone) {
        // Ignore no-op drops (same place)
        const samePlace =
          source.zone === toZone && (toZone === 'reserve' || source.index === toIndex);
        if (!samePlace) {
          executeMoveCore({
            fromZone: source.zone,
            fromIndex: source.index,
            toZone,
            toIndex,
            coreType: dragCoreType,
          });
        }
      }
      setSelectedCoreType(null);
      return;
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

  const handleSurrender = () => {
    if (confirm('ゲームに投了します。よろしいですか？')) {
      onEndGame();
    }
  };

  const handleBugReport = () => {
    if (!confirm('現在の場面をバグ報告として保存してホームに戻ります。よろしいですか？')) {
      return;
    }

    // 現在の場面をテキスト化
    const bugReport = {
      timestamp: new Date().toISOString(),
      sessionId,
      gameState: {
        turnCount: state.turnCount,
        phase: state.phase,
        currentPlayer,
        p0Life: state.players[0].life,
        p1Life: state.players[1].life,
        p0Hand: state.players[0].handSize,
        p1Hand: state.players[1].handSize,
        p0Cores: state.players[0].cores,
        p1Cores: state.players[1].cores,
        p0SoulCores: state.players[0].soulCores,
        p1SoulCores: state.players[1].soulCores,
        p0DeckCount: state.players[0].deck.count,
        p1DeckCount: state.players[1].deck.count,
        p0TrashCount: state.players[0].trash.count,
        p1TrashCount: state.players[1].trash.count,
        p0Spirits: state.players[0].field.map((s: any) => ({
          name: s.name,
          level: s.level,
          bp: s.bp,
          cores: s.coreCount,
          soulCores: s.soulCoreCount,
        })),
        p1Spirits: state.players[1].field.map((s: any) => ({
          name: s.name,
          level: s.level,
          bp: s.bp,
          cores: s.coreCount,
          soulCores: s.soulCoreCount,
        })),
        p0Nexuses: state.players[0].nexuses?.length || 0,
        p1Nexuses: state.players[1].nexuses?.length || 0,
      },
      gameHistory: gameHistory.slice(-20), // 最後の20アクション
      playerTypes,
      isTerminal,
      p1Rating,
    };

    // ブラウザのローカルストレージに保存
    try {
      const reports = JSON.parse(localStorage.getItem('bug-reports') || '[]');
      reports.push(bugReport);
      // 最新100件まで保持
      if (reports.length > 100) {
        reports.shift();
      }
      localStorage.setItem('bug-reports', JSON.stringify(reports));

      // コンソールにもログ出力（デバッグ用）
      console.log('🐛 Bug Report Saved:', bugReport);

      // ホームに戻る
      onEndGame();
    } catch (err) {
      console.error('Failed to save bug report:', err);
      alert('バグ報告の保存に失敗しました。');
    }
  };

  const handleShowCardRulebook = (cardId: string, imagePath: string | undefined, name: string) => {
    // Show card image modal
    if (imagePath) {
      setSelectedCardImage({ imagePath, name });
    }
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
          playerRating={topPlayer === 1 ? p1Rating : undefined}
          position="top"
          isHumanTurn={isHumanTurn}
          legalActions={legalActions}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          dragOverCard={dragOverCard}
          onCardRightClick={(cardId, imagePath, name) => handleShowCardRulebook(cardId, imagePath, name)}
          onViewTrash={() => setTrashViewPlayer(topPlayer)}
          onViewBottomDeck={() => setBottomDeckViewPlayer(topPlayer)}
          attackingSpiritPlayer={state.pendingAttack?.attackerPlayer}
          attackingSpiritIndex={state.pendingAttack?.attackerSpiritIndex}
        />

        <div className="center-bar">
          <span className="turn-chip">ターン {state.turnCount + 1}</span>
          {state.pendingSpellChain ? (
            <span className="center-alert spell-chain">
              ⚠️ 効果チェーン確認: 「{state.pendingSpellChain.summonedCard.name}」の効果で消滅対象あり
            </span>
          ) : state.pendingAttack ? (
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
          onCardRightClick={(cardId, imagePath, name) => handleShowCardRulebook(cardId, imagePath, name)}
          onViewTrash={() => setTrashViewPlayer(bottomPlayer)}
          onViewBottomDeck={() => setBottomDeckViewPlayer(bottomPlayer)}
          attackingSpiritPlayer={state.pendingAttack?.attackerPlayer}
          attackingSpiritIndex={state.pendingAttack?.attackerSpiritIndex}
        />
      </div>

      {/* ===== Side panel (right) ===== */}
      <aside className="side-panel">
        <div className="side-header">
          <strong>Battle Spirits</strong>
          <div className="header-buttons">
            <button className="surrender-button" onClick={handleSurrender} title="ゲームに投了します">🏳️ 投了</button>
            <button className="reset-button" onClick={onEndGame}>🔄 リセット</button>
          </div>
        </div>

        <div className="bug-report-bar">
          <button className="bug-report-button" onClick={handleBugReport} title="現在の場面をバグ報告として保存します">
            🐛 バグ報告
          </button>
          <span className="bug-report-hint">問題が発生した場合はここをクリック</span>
        </div>

        {error && <div className="error-banner side-error">⚠️ {error}</div>}

        {pendingCoreCost && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleDrop({ paymentZone: true });
            }}
            style={{
              padding: '1rem',
              backgroundColor: '#f0e8f8',
              borderRadius: '8px',
              marginBottom: '1rem',
              border: '2px solid #9f7aea',
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: '0.4rem', textAlign: 'center', fontSize: '1rem' }}>
              💎 支払うコア: 「{pendingCoreCost.cardName}」
            </div>
            <div style={{ fontSize: '0.95rem', marginBottom: '0.8rem', textAlign: 'center', fontWeight: 600 }}>
              必要: {pendingCoreCost.requiredCores}個
            </div>
            <div style={{
              padding: '1.2rem 0.8rem',
              marginBottom: '0.8rem',
              border: '3px dashed #9f7aea',
              borderRadius: '8px',
              textAlign: 'center',
              fontWeight: 600,
              fontSize: '0.9rem',
              color: '#6b46c1',
              backgroundColor: 'rgba(159, 122, 234, 0.08)',
            }}>
              🟢🟣 ここにコアをドロップして支払い
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
            {pendingCoreCost.hasInheritance && (
              <div style={{
                marginBottom: '0.8rem',
                padding: '0.8rem',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                borderRadius: '6px',
                border: '2px solid #f59e0b',
              }}>
                <div style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  marginBottom: '0.4rem',
                  color: '#d97706',
                }}>
                  ⭐ 継承を使用
                </div>
                <button
                  onClick={() => {
                    if (pendingCoreCost) {
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        useInheritance: !pendingCoreCost.useInheritance,
                      });
                    }
                  }}
                  style={{
                    width: '100%',
                    padding: '0.6rem',
                    backgroundColor: pendingCoreCost.useInheritance ? '#fbbf24' : '#f3f4f6',
                    color: pendingCoreCost.useInheritance ? '#78350f' : '#6b7280',
                    border: '2px solid #f59e0b',
                    borderRadius: '4px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = pendingCoreCost.useInheritance ? '#f97316' : '#e5e7eb';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = pendingCoreCost.useInheritance ? '#fbbf24' : '#f3f4f6';
                  }}
                >
                  {pendingCoreCost.useInheritance ? '✓ 継承を使用' : '継承を使用しない'}
                </button>
              </div>
            )}
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
                          executeAction(actionIndex, {
                            paidRegularCores: newPaid,
                            paidSoulCores: pendingCoreCost.paidSoul,
                            useInheritance: pendingCoreCost.useInheritance,
                          });
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
                          executeAction(actionIndex, {
                            paidRegularCores: pendingCoreCost.paidRegular,
                            paidSoulCores: newPaid,
                            useInheritance: pendingCoreCost.useInheritance,
                          });
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
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.6rem',
              padding: '0.6rem',
              backgroundColor: '#fff5f7',
              borderRadius: '4px',
              fontSize: '0.85rem',
              fontWeight: 500,
              marginBottom: '0.8rem',
            }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={pendingCoreCost.useInheritance ?? false}
                  onChange={(e) => {
                    setPendingCoreCost({
                      ...pendingCoreCost,
                      useInheritance: e.target.checked,
                    });
                  }}
                  style={{ cursor: 'pointer' }}
                />
                <span>継承を使用する</span>
              </label>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#666', textAlign: 'center', padding: '0.6rem', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
              ドラッグまたはボタンで支払い（キャンセルは「リセット」ボタン）
            </div>
          </div>
        )}

        {/* Spell Chain Confirmation Dialog */}
        {state.pendingSpellChain && isHumanTurn && (
          <div style={{
            backgroundColor: '#fff9e6',
            border: '2px solid #ff6b6b',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1rem',
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#d92525', marginBottom: '0.5rem' }}>
              ⚠️ 効果チェーン確認
            </div>
            <div style={{ fontSize: '0.95rem', color: '#333', marginBottom: '1rem', lineHeight: '1.6' }}>
              「{state.pendingSpellChain.summonedCard.name}」の召喚効果により、以下が消滅します：
              <br />
              <strong>
                {[
                  ...state.pendingSpellChain.destructedSpiritIndices.map(i => state.players[1 - state.currentPlayer].spirits[i]?.def.name),
                  ...state.pendingSpellChain.destructedNexusIndices.map(i => state.players[1 - state.currentPlayer].nexuses[i]?.def.name),
                ].filter(Boolean).join('、')}
              </strong>
              <br />
              <span style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.5rem', display: 'block' }}>
                💡 コアを置くと消滅がキャンセルされます
              </span>
            </div>
            <button
              className="action-button"
              onClick={() => executeAction(legalActions.findIndex(a => a.action?.type === 'confirm_spell_chain' && a.action?.proceed === true))}
              style={{ width: '100%', backgroundColor: '#d92525', borderColor: '#a01f1f' }}
            >
              消滅を実行
            </button>
          </div>
        )}

        {/* Spirit Depletion Confirmation Dialog */}
        {state.pendingSpiritDepletion && isHumanTurn && (
          <div style={{
            backgroundColor: '#fff9e6',
            border: '2px solid #ff6b6b',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1rem',
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#d92525', marginBottom: '0.5rem' }}>
              ⚠️ スピリット消滅確認
            </div>
            <div style={{ fontSize: '0.95rem', color: '#333', marginBottom: '1rem', lineHeight: '1.6' }}>
              「{state.pendingSpiritDepletion.spiritCard.name}」は維持コアが不足しています：
              <br />
              <strong>
                必要: {state.pendingSpiritDepletion.requiredCores}個 / 現在: {state.pendingSpiritDepletion.currentCores}個
              </strong>
              <br />
              <span style={{ fontSize: '0.85rem', color: '#666', marginTop: '0.5rem', display: 'block' }}>
                💡 コアを追加して消滅をキャンセルするか、消滅させるかを選択してください
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
              <button
                className="action-button"
                onClick={() => {
                  const addCoreAction = legalActions.find(a => a.action?.type === 'add_core' && a.action?.spiritIndex === state.pendingSpiritDepletion.spiritIndex);
                  if (addCoreAction) {
                    executeAction(addCoreAction.index);
                  }
                }}
                disabled={isBusy || !legalActions.some(a => a.action?.type === 'add_core' && a.action?.spiritIndex === state.pendingSpiritDepletion.spiritIndex)}
                style={{ backgroundColor: '#1e7e4d', borderColor: '#0d5c3a' }}
              >
                🟢 コアを追加
              </button>
              <button
                className="action-button"
                onClick={() => {
                  const confirmAction = legalActions.find(a => a.action?.type === 'confirm_spirit_depletion' && a.action?.proceed === true);
                  if (confirmAction) {
                    executeAction(confirmAction.index);
                  }
                }}
                disabled={isBusy}
                style={{ backgroundColor: '#d92525', borderColor: '#a01f1f' }}
              >
                消滅させる
              </button>
            </div>
          </div>
        )}

        {/* Effect Target Selection Dialog */}
        {state.pendingEffectAction && isHumanTurn && (
          <div style={{
            backgroundColor: '#e6f3ff',
            border: '2px solid #1976d2',
            borderRadius: '8px',
            padding: '1rem',
            marginBottom: '1rem',
          }}>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#1565c0', marginBottom: '0.5rem' }}>
              🎯 対象を選択
            </div>
            <div style={{ fontSize: '0.95rem', color: '#333', marginBottom: '1rem', lineHeight: '1.6' }}>
              「{state.pendingEffectAction.sourceCard.name}」の効果のための対象を選択してください：
              <br />
              <strong>{state.pendingEffectAction.effect.description}</strong>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: '0.6rem',
              marginBottom: '0.8rem'
            }}>
              {/* Opponent spirits */}
              {state.pendingEffectAction.validTargets.spiritIndices.map((spiritIdx) => {
                if (spiritIdx < 0) return null; // Skip special markers
                const opponent = state.players[1 - state.currentPlayer];
                const spirit = opponent?.spirits[spiritIdx];
                if (!spirit) return null;

                return (
                  <button
                    key={`spirit-${spiritIdx}`}
                    onClick={() => {
                      const selectAction = legalActions.find(a =>
                        a.action?.type === 'select_effect_target' &&
                        a.action?.targetSpiritIndex === spiritIdx
                      );
                      if (selectAction) {
                        executeAction(selectAction.index);
                      }
                    }}
                    disabled={isBusy}
                    style={{
                      padding: '0.6rem',
                      backgroundColor: '#1976d2',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                    }}
                  >
                    {spirit.def.name}
                    <br />
                    <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>
                      BP{spirit.level === 1 ? spirit.def.lv1.bp : spirit.def.lv2?.bp || spirit.def.lv1.bp}
                    </span>
                  </button>
                );
              })}

              {/* Opponent nexuses */}
              {state.pendingEffectAction.validTargets.nexusIndices.map((nexusIdx) => {
                const opponent = state.players[1 - state.currentPlayer];
                const nexus = opponent?.nexuses[nexusIdx];
                if (!nexus) return null;

                return (
                  <button
                    key={`nexus-${nexusIdx}`}
                    onClick={() => {
                      const selectAction = legalActions.find(a =>
                        a.action?.type === 'select_effect_target' &&
                        a.action?.targetNexusIndex === nexusIdx
                      );
                      if (selectAction) {
                        executeAction(selectAction.index);
                      }
                    }}
                    disabled={isBusy}
                    style={{
                      padding: '0.6rem',
                      backgroundColor: '#7b1fa2',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                    }}
                  >
                    {nexus.def.name}
                    <br />
                    <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>Nexus</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="side-actions">
          {/* Mulligan selection (opening hand confirmation) */}
          {state.pendingDiceRoll && state.pendingDiceRoll.winner === undefined ? (
            <>
              <div className="side-actions-title">
                🎲 サイコロを振っています...
              </div>
              {state.pendingDiceRoll.p0Roll !== undefined && state.pendingDiceRoll.p1Roll !== undefined ? (
                <div style={{ fontSize: '1.1rem', color: '#333', marginBottom: '1rem', padding: '1rem', backgroundColor: '#fff3cd', borderRadius: '8px', lineHeight: '2', fontWeight: 600, textAlign: 'center' }}>
                  <div style={{ color: '#e74c3c', fontSize: '1.3rem' }}>
                    👤 P0: <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{state.pendingDiceRoll.p0Roll}</span>
                  </div>
                  <div style={{ color: '#3498db', fontSize: '1.3rem' }}>
                    🤖 P1: <span style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>{state.pendingDiceRoll.p1Roll}</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: '0.9rem', color: '#333', marginBottom: '0.8rem', padding: '0.6rem', backgroundColor: '#f0f0f0', borderRadius: '4px', lineHeight: '1.5' }}>
                  両プレイヤーのサイコロが自動で振られています。
                  <br />
                  大きい数が勝ちます。
                </div>
              )}
            </>
          ) : legalActions.some(a => a.description.includes('維持') || a.description.includes('引き直す')) ? (
            <>
              <div className="side-actions-title">
                🎲 初手確認
              </div>
              <div style={{ fontSize: '0.9rem', color: '#333', marginBottom: '0.8rem', padding: '0.6rem', backgroundColor: '#f0f0f0', borderRadius: '4px', lineHeight: '1.5' }}>
                手札を確認しました。
                <br />
                このまま維持するか、シャッフルして引き直すか選択してください。
              </div>
              <div className="action-buttons">
                {legalActions.map((action) => (
                  <button
                    key={action.index}
                    className="action-button"
                    onClick={() => executeAction(action.index)}
                    disabled={isBusy}
                    style={{ marginBottom: '0.3rem', backgroundColor: '#ff6b6b', borderColor: '#d92525' }}
                  >
                    {action.description}
                  </button>
                ))}
              </div>
            </>
          ) : legalActions.some(a => a.description.includes('先手')) ? (
            <>
              <div className="side-actions-title">
                🎲 先手後手を選択
              </div>
              <div className="action-buttons">
                {legalActions.map((action) => (
                  <button
                    key={action.index}
                    className="action-button"
                    onClick={() => executeAction(action.index)}
                    disabled={isBusy}
                    style={{ marginBottom: '0.3rem', backgroundColor: '#ff6b6b', borderColor: '#d92525' }}
                  >
                    {action.description}
                  </button>
                ))}
              </div>
            </>
          ) : !state.pendingDraw && !state.pendingSpellChain && isHumanTurn ? (
            <>
              <div className="side-actions-title">
                🎯 あなたの番です
                {state.pendingSpellChain && <span className="hint spell-chain">効果チェーン確認</span>}
                {state.pendingAttack && <span className="hint attack">防御するか選択</span>}
                {state.pendingFlash && <span className="hint flash">フラッシュ使用可</span>}
              </div>
              {!state.pendingAttack && !state.pendingFlash && !state.pendingSpellChain && (
                <div style={{ fontSize: '0.8rem', color: '#666', padding: '0.5rem 0.8rem', backgroundColor: '#f0f0f0', borderRadius: '4px', marginBottom: '0.8rem', lineHeight: '1.4' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>プレイ手順:</div>
                  <div style={{ color: '#1e7e4d', fontWeight: 500 }}>1️⃣ カードをドラッグ → 2️⃣ コアをドラッグして支払い</div>
                  <div style={{ color: '#6b46c1', fontWeight: 500 }}>3️⃣ コアはドラッグで自由に移動（リザーブ⇄スピリット⇄ネクサス）</div>
                </div>
              )}
              <div className="action-buttons">
                {(() => {
                  // Separate actions: cost payment (from card play) vs core placement (add_core)
                  const costActions = legalActions.filter(a => !a.description.includes('コア配置') && !a.description.includes('コアを追加'));
                  const coreActions = legalActions.filter(a => a.description.includes('コア配置') || a.description.includes('コアを追加'));

                  return (
                    <>
                      {costActions.length > 0 && (
                        <div style={{ marginBottom: '0.8rem' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#1e7e4d', marginBottom: '0.3rem', textTransform: 'uppercase' }}>
                            💚 支払うコア（カード召喚用）
                          </div>
                          {costActions.map((action) => (
                            <button
                              key={action.index}
                              className="action-button"
                              onClick={() => executeAction(action.index)}
                              disabled={isBusy}
                              style={{ marginBottom: '0.3rem', backgroundColor: '#1e7e4d', borderColor: '#0d5c3a' }}
                            >
                              {action.description}
                            </button>
                          ))}
                        </div>
                      )}
                      {coreActions.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6b46c1', marginBottom: '0.3rem', textTransform: 'uppercase' }}>
                            💜 乗せるコア（スピリット配置用）
                          </div>
                          {coreActions.map((action) => (
                            <button
                              key={action.index}
                              className="action-button"
                              onClick={() => executeAction(action.index)}
                              disabled={isBusy}
                              style={{ marginBottom: '0.3rem', backgroundColor: '#6b46c1', borderColor: '#553399' }}
                            >
                              {action.description}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
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

      {/* ===== Dice roll overlay ===== */}
      {(() => {
        const shouldShow = !isTerminal && state.pendingDiceRoll && !state.pendingMulligan;
        if (shouldShow) {
          console.log(`[GameBoard Overlay] Rendering dice overlay with p0Roll=${state.pendingDiceRoll.p0Roll}, p1Roll=${state.pendingDiceRoll.p1Roll}, winner=${state.pendingDiceRoll.winner}`);
        }
        return shouldShow;
      })() && (
        <div className="game-over">
          <div className="game-over-content dice-roll-content" style={{
            padding: '3rem 2rem',
            textAlign: 'center',
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
          }}>
            {state.pendingDiceRoll.winner === undefined || state.pendingDiceRoll.winner === null ? (
              <>
                <h2 style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🎲 サイコロを振っています...</h2>
                <p style={{ fontSize: '1.1rem', color: '#666', marginBottom: '2rem' }}>両プレイヤーのサイコロが自動で振られています</p>
                <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem', marginTop: '2rem' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>🎲</div>
                    <div style={{ fontSize: '1rem', color: '#666' }}>Player 0</div>
                    {state.pendingDiceRoll.p0Roll && <div style={{ fontSize: '1.5rem', fontWeight: 'bold', marginTop: '0.5rem' }}>{state.pendingDiceRoll.p0Roll}</div>}
                  </div>
                  <div style={{ fontSize: '2rem', color: '#999', display: 'flex', alignItems: 'center' }}>VS</div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '3rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>🎲</div>
                    <div style={{ fontSize: '1rem', color: '#666' }}>Player 1</div>
                    {state.pendingDiceRoll.p1Roll && <div style={{ fontSize: '1.5rem', fontWeight: 'bold', marginTop: '0.5rem' }}>{state.pendingDiceRoll.p1Roll}</div>}
                  </div>
                </div>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🎲 サイコロ結果</h2>
                <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem', marginTop: '1.5rem', marginBottom: '2rem' }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>Player 0</div>
                    <div style={{ fontSize: '3rem', fontWeight: 'bold', color: state.pendingDiceRoll.winner === 0 ? '#4CAF50' : '#999' }}>
                      {state.pendingDiceRoll.p0Roll}
                    </div>
                  </div>
                  <div style={{ fontSize: '2rem', color: '#999', display: 'flex', alignItems: 'center' }}>VS</div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '2rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>Player 1</div>
                    <div style={{ fontSize: '3rem', fontWeight: 'bold', color: state.pendingDiceRoll.winner === 1 ? '#4CAF50' : '#999' }}>
                      {state.pendingDiceRoll.p1Roll}
                    </div>
                  </div>
                </div>
                <p style={{ fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '2rem', color: '#333' }}>
                  🏆 先手はPlayer {state.pendingDiceRoll.winner}です
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  {legalActions.map((a) => (
                    <button
                      key={a.index}
                      onClick={() => executeAction(a.index)}
                      disabled={isBusy}
                      style={{
                        padding: '1rem',
                        fontSize: '1.1rem',
                        fontWeight: 'bold',
                        backgroundColor: '#2196F3',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: isBusy ? 'default' : 'pointer',
                        opacity: isBusy ? 0.6 : 1,
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        if (!isBusy) (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#1976D2';
                      }}
                      onMouseLeave={(e) => {
                        if (!isBusy) (e.currentTarget as HTMLButtonElement).style.backgroundColor = '#2196F3';
                      }}
                    >
                      {a.description}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ===== Opening hand mulligan overlay ===== */}
      {!isTerminal && state.pendingMulligan && playerTypes[state.pendingMulligan.player] === 'human' && (
        <div className="game-over">
          <div className="game-over-content mulligan-content">
            <h3>🎴 初手を確認してください</h3>
            <div className="mulligan-info">
              <div style={{ fontSize: '0.95rem', color: '#666', marginBottom: '1rem', textAlign: 'center' }}>
                先手: {state.pendingMulligan.firstPlayer === 0 ? 'Player 0' : 'Player 1'} ｜ 後手: {state.pendingMulligan.firstPlayer === 0 ? 'Player 1' : 'Player 0'}
              </div>
            </div>
            <div className="mulligan-hand">
              {state.players[state.pendingMulligan.player].handCards.map((c: any, i: number) => (
                <div key={`${c.id}-${i}`} className="mulligan-card" onClick={() => c.imagePath && setSelectedCardImage({ imagePath: c.imagePath, name: c.name })} style={{ cursor: 'pointer' }}>
                  {c.imagePath ? <img src={c.imagePath} alt={c.name} /> : null}
                  <span>{c.name}</span>
                </div>
              ))}
            </div>
            <div className="mulligan-buttons">
              {legalActions.map((a) => (
                <button key={a.index} onClick={() => executeAction(a.index)} disabled={isBusy}>
                  {a.description}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== Offering draw overlay ===== */}
      {!isTerminal && state.pendingDraw && isHumanTurn && (
        <div className="game-over">
          <div className="game-over-content offering-draw-content">
            <h3>{state.pendingDraw.castCard?.name || 'オファーリングドロー'} - カードを選択</h3>

            {state.pendingDraw.toHandIndices.length > 0 && (
              <div className="offering-section">
                <div className="offering-section-title">
                  手札に追加するカード（最大{state.pendingDraw.maxSelectable ?? 2}枚選択）
                  {state.pendingDraw.selectableIndices && state.pendingDraw.selectableIndices.length < state.pendingDraw.toHandIndices.length && (
                    <span className="offering-filter-hint">※ 系統「風牙」のみ</span>
                  )}
                </div>
                <div className="offering-hand">
                  {state.pendingDraw.toHandIndices.map((idx) => {
                    const card = state.pendingDraw.openedCards[idx];
                    const isSelectable = !state.pendingDraw.selectableIndices || state.pendingDraw.selectableIndices.includes(idx);
                    const isSelected = selectedHandIndices.has(idx);
                    const maxSelectable = state.pendingDraw.maxSelectable ?? 2;
                    const canSelect = isSelectable && (isSelected || selectedHandIndices.size < maxSelectable);
                    return (
                      <div
                        key={`hand-${idx}`}
                        className={`offering-card ${isSelected ? 'selected' : ''} ${!canSelect ? 'disabled' : ''}`}
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
                        style={{ cursor: canSelect ? 'pointer' : 'not-allowed' }}
                        title={isSelectable ? card.name : `${card.name}\n（系統「風牙」ではありません）`}
                      >
                        {card.imagePath ? (
                          <img
                            src={card.imagePath}
                            alt={card.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedCardImage({ imagePath: card.imagePath, name: card.name });
                            }}
                            style={{ cursor: 'pointer' }}
                          />
                        ) : null}
                        <span className="offering-card-name">{card.name}</span>
                        <span className="offering-card-cost">コスト{card.cost}</span>
                        {card.lineage?.includes('風牙') && (
                          <span className="offering-card-lineage">風牙</span>
                        )}
                        {isSelected && <span className="offering-checkmark">✓</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {state.pendingDraw.toRearrangeIndices.length > 0 && state.pendingDraw.returnDestination !== 'trash' && (
              <div className="offering-section">
                <div className="offering-section-title">山札下に戻すカード（↑↓で順序変更）</div>
                <div className="offering-arrange">
                  {arrangedCardIndices.map((cardIdx, order) => {
                    const card = state.pendingDraw.openedCards[cardIdx];
                    const isFirst = order === 0;
                    const isLast = order === arrangedCardIndices.length - 1;
                    return (
                      <div key={`arrange-${cardIdx}`} className="offering-arrange-row">
                        <div className="offering-arrange-card">
                          {card.imagePath ? <img src={card.imagePath} alt={card.name} /> : null}
                          <div className="offering-arrange-info">
                            <div className="offering-card-name">{card.name}</div>
                            <div className="offering-card-cost">コスト{card.cost}</div>
                          </div>
                        </div>
                        <div className="offering-arrange-controls">
                          <button
                            className="offering-move-btn"
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
                            className="offering-move-btn"
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
              </div>
            )}

            <button
              className="offering-confirm-btn"
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
          </div>
        </div>
      )}

      {/* ===== Trash viewing modal ===== */}
      {trashViewPlayer !== null && state && (
        <div className="card-image-modal" onClick={() => setTrashViewPlayer(null)}>
          <div className="card-image-modal-content trash-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-image-modal-title">
              P{trashViewPlayer} のトラッシュ（{state.players[trashViewPlayer].trash.count}枚）
            </div>
            <div className="trash-modal-body">
              {state.players[trashViewPlayer].trash.cards && state.players[trashViewPlayer].trash.cards.length > 0 ? (
                <div className="trash-grid">
                  {state.players[trashViewPlayer].trash.cards.map((card: any, idx: number) => (
                    <div
                      key={`trash-${idx}`}
                      className="trash-card"
                      title={`${card.name}\nコスト${card.cost}\nクリックで拡大表示`}
                      onClick={() => card.imagePath && setSelectedCardImage({ imagePath: card.imagePath, name: card.name })}
                      style={{ cursor: card.imagePath ? 'pointer' : 'default' }}
                    >
                      {card.imagePath ? (
                        <img src={`/${card.imagePath}`} alt={card.name} />
                      ) : null}
                      <div className="trash-card-info">
                        <div className="trash-card-name">{card.name}</div>
                        <div className="trash-card-cost">コスト{card.cost}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="trash-empty">トラッシュにカードがありません</div>
              )}
            </div>
            <div className="card-image-modal-hint">クリックまたは Esc で閉じる</div>
          </div>
        </div>
      )}

      {/* ===== Bottom deck viewing modal ===== */}
      {bottomDeckViewPlayer !== null && state && (
        <div className="card-image-modal" onClick={() => setBottomDeckViewPlayer(null)}>
          <div className="card-image-modal-content trash-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-image-modal-title">
              P{bottomDeckViewPlayer} の山札下（{state.players[bottomDeckViewPlayer].bottomDeckCards.length}枚）
            </div>
            <div className="trash-modal-body">
              {state.players[bottomDeckViewPlayer].bottomDeckCards && state.players[bottomDeckViewPlayer].bottomDeckCards.length > 0 ? (
                <div className="trash-grid">
                  {state.players[bottomDeckViewPlayer].bottomDeckCards.map((card: any, idx: number) => (
                    <div
                      key={`bottom-deck-${idx}`}
                      className="trash-card"
                      title={`${card.name}\nコスト${card.cost}\n順序: ${idx + 1}番目\nクリックで拡大表示`}
                      onClick={() => card.imagePath && setSelectedCardImage({ imagePath: card.imagePath, name: card.name })}
                      style={{ cursor: card.imagePath ? 'pointer' : 'default' }}
                    >
                      {card.imagePath ? (
                        <img src={`/${card.imagePath}`} alt={card.name} />
                      ) : null}
                      <div className="trash-card-info">
                        <div className="trash-card-name">{card.name}</div>
                        <div className="trash-card-cost">#${idx + 1}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="trash-empty">山札下にカードがありません</div>
              )}
            </div>
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
