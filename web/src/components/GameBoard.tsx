import { useState, useEffect, useCallback, useRef } from 'react';
import PlayerPanel from './PlayerPanel';
import InheritanceSelectionModal from './InheritanceSelectionModal';
import '../styles/GameBoard.css';

interface GameBoardProps {
  sessionId: string;
  p1Rating?: number;
  onEndGame: () => void;
}

interface LegalAction {
  index: number;
  description: string;
  action?: any; // raw action object from server (type, handIndex, targetSpiritIndex, coreType, ...)
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
    soulOnly?: boolean; // Soul Magic soul-core payment: only soul cores accepted
    chosenCoreType?: 'regular' | 'soul'; // User's choice of payment method (via button)
  } | null>(null);
  // When a dragged card has multiple distinct plays (different targets / payment
  // modes), the player must choose one — never auto-pick the first
  const [pendingActionChoice, setPendingActionChoice] = useState<{ card: any; options: LegalAction[] } | null>(null);
  const [selectedCardImage, setSelectedCardImage] = useState<{ imagePath: string; name: string } | null>(null);
  const [trashViewPlayer, setTrashViewPlayer] = useState<number | null>(null);
  const [excludedViewPlayer, setExcludedViewPlayer] = useState<number | null>(null);
  const [bottomDeckViewPlayer, setBottomDeckViewPlayer] = useState<number | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const isHumanTurn = !isTerminal && (
    // Order choice phase: only winner can choose
    (state?.pendingDiceRoll && state.pendingDiceRoll.winner !== undefined && playerTypes[state.pendingDiceRoll.winner] === 'human')
    ||
    // Mulligan phase
    (state?.pendingMulligan && playerTypes[state.pendingMulligan.player] === 'human')
    ||
    // Inheritance selection phase
    (state?.pendingInheritanceSelection && playerTypes[state.pendingInheritanceSelection.player] === 'human')
    ||
    // Draw/Arrange phase (after attack search_deck)
    (state?.pendingDraw && playerTypes[currentPlayer] === 'human')
    ||
    // Regular turn phase
    (!state?.pendingDiceRoll && !state?.pendingMulligan && !state?.pendingInheritanceSelection && !state?.pendingDraw && playerTypes[currentPlayer] === 'human')
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
      const actions = data.actions ?? [];
      setLegalActions(actions);

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

  // Remove selected cards from arrangement list
  useEffect(() => {
    if (state?.pendingDraw) {
      const filtered = arrangedCardIndices.filter(idx => !selectedHandIndices.has(idx));
      setArrangedCardIndices(filtered);
    }
  }, [selectedHandIndices, state?.pendingDraw]);

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

  const executeAction = async (actionIndex: number, options?: { cardIndices?: number[]; selectedCardIndices?: number[]; arrangedCardIndices?: number[]; coreType?: 'regular' | 'soul'; paidRegularCores?: number; paidSoulCores?: number; useInheritance?: boolean; inheritanceCount?: number; selectedCardIds?: string[]; selectedInheritanceIds?: string[] }) => {
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
      if (options?.inheritanceCount !== undefined) {
        body.inheritanceCount = options.inheritanceCount;
      }
      if (options?.selectedCardIds !== undefined) {
        body.selectedCardIds = options.selectedCardIds;
      }
      if (options?.selectedInheritanceIds !== undefined) {
        body.selectedInheritanceIds = options.selectedInheritanceIds;
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

  // Start executing a card-play action: fetch its cost, then either open the
  // core payment panel or execute immediately
  const beginCardAction = (actionEntry: LegalAction, card: any) => {
    const soulOnly = actionEntry.action?.coreType === 'soul';
    // 継召 (inheritance) is decided upfront by which action variant was chosen
    // (legalActions offers separate 継召あり/なし actions). The payment panel must
    // NOT re-toggle it, or the paid cores and the server's recomputed cost diverge.
    const useInheritance = actionEntry.action?.useInheritance !== false && !!card.inheritance;
    const checkCost = async () => {
      try {
        const response = await fetch(`/api/game/${sessionId}/action-cost`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ actionIndex: actionEntry.index }),
        });
        const data = await response.json();
        const cost = data.cost ?? 0;

        if (cost > 0) {
          // Enter core payment waiting mode
          setPendingCoreCost({
            actionIndex: actionEntry.index,
            requiredCores: cost,
            paidRegular: 0,
            paidSoul: 0,
            cardName: card.name,
            useInheritance, // fixed by the chosen action variant, not user-toggled here
            hasInheritance: card.inheritance ?? false,
            soulOnly,
          });
          setError(
            soulOnly
              ? `【ソウルコア払い】「${card.name}」はソウルコア（🟣）1個で発動します。ソウルコアをドラッグしてください。`
              : `【支払うコア】「${card.name}」のコスト${cost}個を支払ってください。通常コア（🟢）またはソウルコア（🟣）をドラッグまたはボタンで選択します。`
          );
        } else {
          // No cost, execute immediately
          executeAction(actionEntry.index, { coreType: soulOnly ? 'soul' : undefined });
        }
      } catch (err) {
        console.error('Failed to get action cost:', err);
        executeAction(actionEntry.index, { coreType: soulOnly ? 'soul' : undefined });
      }
    };
    checkCost();
  };

  const handleDrop = async (dropData: any) => {
    if (!dragData || !isHumanTurn || isBusy) return;

    // If we're waiting for core payment, handle core drop
    if (pendingCoreCost && dragData.type === 'core') {
      // Soul Magic soul-core payment accepts ONLY soul cores
      if (pendingCoreCost.soulOnly && dragData.coreType !== 'soul') {
        setError('この支払いはソウルコア（🟣）のみ有効です。');
        setDragData(null);
        setSelectedCoreType(null);
        return;
      }
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
          // Use chosenCoreType if user selected via button, otherwise infer from what was paid
          const decidedCoreType = pendingCoreCost.chosenCoreType || (pendingCoreCost.soulOnly ? 'soul' : (newPaidSoul > 0 ? 'soul' : 'regular'));
          console.log('[DRAG_DROP_PAYMENT] コアドラッグ完了', { decidedCoreType, newPaidRegular, newPaidSoul, chosenCoreType: pendingCoreCost.chosenCoreType });
          setPendingCoreCost(null);
          setDragData(null);
          setDragOverCard(null);
          setSelectedCoreType(null);

          // Execute the action with exact core type counts
          setTimeout(() => {
            executeAction(actionIndex, {
              coreType: decidedCoreType,
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
      // Collect every playable action for THIS hand card (matched by hand index)
      const cardName = dragData.card.name;
      const cardActionTypes = ['summon', 'use_magic', 'place_nexus', 'flash'];
      let candidates = legalActions.filter(
        (a) => a.action && cardActionTypes.includes(a.action.type) && a.action.handIndex === dragData.handIndex
      );
      // Fallback: match by description if the server didn't include action objects
      if (candidates.length === 0) {
        const byName = legalActions.find((a) => a.description.includes(cardName));
        if (byName) candidates = [byName];
      }

      if (candidates.length === 0) {
        setError('ドラッグ操作は無効です。アクションボタンから実行してください。');
        setSelectedCoreType(null);
        return;
      }

      // Group by player-visible choice (target / value / payment mode / 継召).
      // 継召あり/なし are genuinely different plays (different cost, EX cards spent),
      // so they must be offered as separate choices — not silently collapsed.
      const choiceKey = (a: LegalAction) =>
        `${a.action?.targetSpiritIndex ?? ''}|${a.action?.targetNexusIndex ?? ''}|${a.action?.effectValue ?? ''}|${a.action?.coreType ?? ''}|${a.action?.useInheritance ?? ''}`;
      const distinctKeys = new Set(candidates.map(choiceKey));

      if (distinctKeys.size > 1) {
        // Multiple targets / payment modes: the player must choose — never auto-pick
        setPendingActionChoice({ card: dragData.card, options: candidates });
        setSelectedCoreType(null);
        return;
      }

      beginCardAction(candidates[0], dragData.card);
      setSelectedCoreType(null);
      return;
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
      // If cost > 0 and coreType not yet selected, ask player to choose
      const actionCost = matchingAction.action?.paymentPlan?.finalCost || 0;
      const playerSoulCores = state?.players?.[currentPlayer]?.soulCores || 0;
      const playerHasSpiritSoulCores = state?.players?.[currentPlayer]?.spirits?.some((s: any) => s.soulCoreCount > 0);
      const canPaySoulCore = playerSoulCores > 0 || playerHasSpiritSoulCores;

      if (actionCost > 0 && canPaySoulCore && coreType === undefined) {
        // Show dialog to choose payment method
        setPendingActionChoice({
          card: dragData.card,
          options: [
            {
              ...matchingAction,
              index: matchingAction.index,
              description: `${matchingAction.description} (通常コア支払い)`,
              action: { ...matchingAction.action, coreType: 'regular' }
            },
            {
              ...matchingAction,
              index: matchingAction.index,
              description: `${matchingAction.description} (ソウルコア支払い)`,
              action: { ...matchingAction.action, coreType: 'soul' }
            }
          ]
        });
        setSelectedCoreType(null);
        return;
      }

      executeAction(matchingAction.index, { coreType: coreType || 'regular' });
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
          onExecuteAction={executeAction}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          dragOverCard={dragOverCard}
          onCardRightClick={(cardId, imagePath, name) => handleShowCardRulebook(cardId, imagePath, name)}
          onViewTrash={() => setTrashViewPlayer(topPlayer)}
          onViewBottomDeck={() => setBottomDeckViewPlayer(topPlayer)}
          attackingSpiritPlayer={state.pendingAttack?.attackerPlayer ?? state.pendingFlash?.stashedAttack?.attackerPlayer}
          attackingSpiritIndex={state.pendingAttack?.attackerSpiritIndex ?? state.pendingFlash?.stashedAttack?.attackerSpiritIndex}
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
          ) : state.pendingFlash?.stashedAttack ? (
            <span className="center-alert attack">
              ⚔️ 「{state.pendingFlash.stashedAttack.attackerName}」がアタック中！（ライフダメージ {state.pendingFlash.stashedAttack.damage}）
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
          onExecuteAction={executeAction}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          dragOverCard={dragOverCard}
          onCardRightClick={(cardId, imagePath, name) => handleShowCardRulebook(cardId, imagePath, name)}
          onViewTrash={() => setTrashViewPlayer(bottomPlayer)}
          onViewBottomDeck={() => setBottomDeckViewPlayer(bottomPlayer)}
          attackingSpiritPlayer={state.pendingAttack?.attackerPlayer ?? state.pendingFlash?.stashedAttack?.attackerPlayer}
          attackingSpiritIndex={state.pendingAttack?.attackerSpiritIndex ?? state.pendingFlash?.stashedAttack?.attackerSpiritIndex}
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
            {pendingCoreCost.hasInheritance && pendingCoreCost.useInheritance && (
              <div style={{
                marginBottom: '0.8rem',
                padding: '0.6rem 0.8rem',
                backgroundColor: 'rgba(245, 158, 11, 0.1)',
                borderRadius: '6px',
                border: '2px solid #f59e0b',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: '#d97706',
                textAlign: 'center',
              }}>
                ⭐ 継召あり — トラッシュのEXシンボルカードを除外してコスト軽減済み
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.8rem' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <button
                  onClick={() => {
                    console.log('[BUTTON_CLICK] 通常コアボタンクリック', { paidRegular: pendingCoreCost.paidRegular, required: pendingCoreCost.requiredCores });
                    const totalPaid = pendingCoreCost.paidRegular + pendingCoreCost.paidSoul;
                    if (totalPaid < pendingCoreCost.requiredCores) {
                      // Check if player has enough regular cores
                      const availableRegularCores = state?.players?.[currentPlayer]?.cores || 0;
                      const newPaid = pendingCoreCost.paidRegular + 1;

                      if (newPaid > availableRegularCores) {
                        setError(`通常コアが不足しています。利用可能: ${availableRegularCores}個、必要: ${newPaid}個`);
                        return;
                      }

                      const newTotal = newPaid + pendingCoreCost.paidSoul;
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        paidRegular: newPaid,
                        chosenCoreType: 'regular', // 支払い方法を記録
                      });
                      if (newTotal >= pendingCoreCost.requiredCores) {
                        const actionIndex = pendingCoreCost.actionIndex;
                        console.log('[BUTTON_EXECUTE] 通常コア支払い完了、coreType: regular を送信');
                        setTimeout(() => {
                          executeAction(actionIndex, {
                            coreType: 'regular',
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
                    console.log('[BUTTON_CLICK] ソウルコアボタンクリック', { paidSoul: pendingCoreCost.paidSoul, required: pendingCoreCost.requiredCores });
                    const totalPaid = pendingCoreCost.paidRegular + pendingCoreCost.paidSoul;
                    if (totalPaid < pendingCoreCost.requiredCores) {
                      // Check if player has enough soul cores
                      const availableSoulCores = (state?.players?.[currentPlayer]?.soulCores || 0) +
                        (state?.players?.[currentPlayer]?.spirits?.reduce((sum: number, s: any) => sum + (s.soulCoreCount || 0), 0) || 0);
                      const newPaid = pendingCoreCost.paidSoul + 1;

                      if (newPaid > availableSoulCores) {
                        setError(`ソウルコアが不足しています。利用可能: ${availableSoulCores}個、必要: ${newPaid}個`);
                        return;
                      }

                      const newTotal = pendingCoreCost.paidRegular + newPaid;
                      setPendingCoreCost({
                        ...pendingCoreCost,
                        paidSoul: newPaid,
                        chosenCoreType: 'soul', // 支払い方法を記録
                      });
                      if (newTotal >= pendingCoreCost.requiredCores) {
                        const actionIndex = pendingCoreCost.actionIndex;
                        console.log('[BUTTON_EXECUTE] ソウルコア支払い完了、coreType: soul を送信', { paidSoul: newPaid, paidRegular: pendingCoreCost.paidRegular });
                        setTimeout(() => {
                          executeAction(actionIndex, {
                            coreType: 'soul',
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.6rem' }}>
              <button
                className="action-button"
                onClick={() => {
                  const addCoreAction = legalActions.find(a => a.action?.type === 'add_core' && a.action?.spiritIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.coreType === 'regular');
                  if (addCoreAction) {
                    executeAction(addCoreAction.index);
                  }
                }}
                disabled={isBusy || !legalActions.some(a => a.action?.type === 'add_core' && a.action?.spiritIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.coreType === 'regular')}
                style={{ backgroundColor: '#1e7e4d', borderColor: '#0d5c3a' }}
              >
                ➕🟢 通常
              </button>
              <button
                className="action-button"
                onClick={() => {
                  const addCoreAction = legalActions.find(a => a.action?.type === 'add_core' && a.action?.spiritIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.coreType === 'soul');
                  if (addCoreAction) {
                    executeAction(addCoreAction.index);
                  }
                }}
                disabled={isBusy || !legalActions.some(a => a.action?.type === 'add_core' && a.action?.spiritIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.coreType === 'soul')}
                style={{ backgroundColor: '#7c4ba8', borderColor: '#543982' }}
              >
                ➕🟣 ソウル
              </button>
              <button
                className="action-button"
                onClick={() => {
                  const moveAction = legalActions.find(a => a.action?.type === 'move_core' && a.action?.fromZone === 'spirit' && a.action?.fromIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.toZone === 'reserve' && a.action?.coreType === 'regular');
                  if (moveAction) {
                    executeAction(moveAction.index);
                  }
                }}
                disabled={isBusy || !legalActions.some(a => a.action?.type === 'move_core' && a.action?.fromZone === 'spirit' && a.action?.fromIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.toZone === 'reserve' && a.action?.coreType === 'regular')}
                style={{ backgroundColor: '#8b6914', borderColor: '#5f4a0a' }}
              >
                ➖🟢 リザーブ
              </button>
              <button
                className="action-button"
                onClick={() => {
                  const moveAction = legalActions.find(a => a.action?.type === 'move_core' && a.action?.fromZone === 'spirit' && a.action?.fromIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.toZone === 'reserve' && a.action?.coreType === 'soul');
                  if (moveAction) {
                    executeAction(moveAction.index);
                  }
                }}
                disabled={isBusy || !legalActions.some(a => a.action?.type === 'move_core' && a.action?.fromZone === 'spirit' && a.action?.fromIndex === state.pendingSpiritDepletion.spiritIndex && a.action?.toZone === 'reserve' && a.action?.coreType === 'soul')}
                style={{ backgroundColor: '#6b4c8a', borderColor: '#4a3363' }}
              >
                ➖🟣 リザーブ
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.6rem' }}>
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
              「{state.pendingEffectAction?.sourceCard?.name || '?'}」の効果のための対象を選択してください：
              <br />
              <strong>{state.pendingEffectAction?.effect?.description || '（説明なし）'}</strong>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: '0.6rem',
              marginBottom: '0.8rem'
            }}>
              {/* Determine target player based on effect.target field */}
              {(() => {
                try {
                  const effect = state.pendingEffectAction?.effect;
                  if (!effect) {
                    console.error('[ERROR_RENDER] pendingEffectAction.effect is undefined:', state.pendingEffectAction);
                    return <div style={{color: 'red'}}>エラー: 効果情報がありません</div>;
                  }

                  const targetIsOpponent = effect.target === 'opponent_creature';
                  const targetPlayerIndex = targetIsOpponent ? 1 - state.currentPlayer : state.currentPlayer;
                  const targetPlayer = state.players?.[targetPlayerIndex];

                  // DEBUG logging
                  console.log('[DEBUG] Effect target selection:', {
                    effectAction: effect?.action,
                    effectTarget: effect?.target,
                    targetIsOpponent,
                    currentPlayer: state.currentPlayer,
                    targetPlayerIndex,
                    validTargets: state.pendingEffectAction?.validTargets,
                    spiritIndices: state.pendingEffectAction?.validTargets?.spiritIndices,
                    spiritIndicesHasNegativeOne: state.pendingEffectAction?.validTargets?.spiritIndices?.includes(-1),
                    targetPlayer: targetPlayer ? 'present' : 'undefined',
                    trash: targetPlayer?.trash,
                    trashCards: targetPlayer?.trash?.cards,
                    trashCardCount: targetPlayer?.trash?.cards?.length,
                  });
                  console.log('[DEBUG] Trash condition check:', {
                    'effect?.action === "trash_to_hand"': effect?.action === 'trash_to_hand',
                    'validTargets.spiritIndices': state.pendingEffectAction?.validTargets?.spiritIndices,
                    'includes(-1)': state.pendingEffectAction?.validTargets?.spiritIndices?.includes(-1),
                    'SHOULD_RENDER_TRASH': effect?.action === 'trash_to_hand' && state.pendingEffectAction?.validTargets?.spiritIndices?.includes(-1),
                  });

                return (
                  <>
                    {/* Trash card selection for trash_to_hand effects */}
                    {effect?.action === 'trash_to_hand' && state.pendingEffectAction?.validTargets?.spiritIndices?.includes(-1) && (
                      <>
                        <div style={{
                          gridColumn: '1 / -1',
                          fontSize: '0.9rem',
                          fontWeight: 600,
                          color: '#555',
                          marginBottom: '0.5rem'
                        }}>
                          トラッシュから選択：
                        </div>
                        {state.players[state.currentPlayer]?.trash?.cards?.map((trashCard, trashIdx) => {
                          // Filter cards based on effect conditions
                          if (!effect) {
                            console.log('[TRASH_MAP] Early return: no effect');
                            return null;
                          }
                          const targetLineage = effect.symbol;
                          const excludeId = effect.excludeId;
                          const excludeEXSymbol = effect.condition?.excludeEXSymbol ?? false;
                          const maxCost = effect.condition?.maxCost;

                          console.log('[TRASH_MAP] Checking card:', {
                            cardName: trashCard.name,
                            cardId: trashCard.id,
                            lineage: trashCard.lineage,
                            targetLineage,
                            lineageMatch: !targetLineage || trashCard.lineage?.includes(targetLineage),
                            excludeId,
                            idMatch: !excludeId || trashCard.id !== excludeId,
                            excludeEXSymbol,
                            exSymbol: trashCard.exSymbol,
                            exSymbolMatch: !excludeEXSymbol || !trashCard.exSymbol,
                            maxCost,
                            costMatch: maxCost === undefined || trashCard.cost <= maxCost,
                            cardType: trashCard.cardType,
                          });

                          if ((!targetLineage || trashCard.lineage?.includes(targetLineage)) &&
                              (!excludeId || trashCard.id !== excludeId) &&
                              (!excludeEXSymbol || !trashCard.exSymbol) &&
                              (maxCost === undefined || trashCard.cost <= maxCost) &&
                              trashCard.cardType === 'spirit') {
                            return (
                              <button
                                key={`trash-${trashCard.id}`}
                                onClick={() => {
                                  console.log('[ACTION] Selecting trash card:', {cardId: trashCard.id, cardName: trashCard.name});
                                  const selectAction = legalActions.find(a =>
                                    a.action?.type === 'select_effect_target' &&
                                    (a.action as any)?.trashCardId === trashCard.id
                                  );
                                  console.log('[ACTION] Found selectAction:', {found: !!selectAction, actionIndex: selectAction?.index});
                                  if (selectAction) {
                                    console.log('[ACTION] Executing trash card selection');
                                    executeAction(selectAction.index);
                                  } else {
                                    console.log('[ERROR] No matching trash card selection action found');
                                    console.log('[DEBUG] Available actions:', legalActions.filter(a => a.action?.type === 'select_effect_target').map(a => ({type: a.action?.type, trashCardId: (a.action as any)?.trashCardId})));
                                  }
                                }}
                                disabled={isBusy}
                                style={{
                                  padding: '0.6rem',
                                  backgroundColor: '#8B7355',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                  fontWeight: 600,
                                  fontSize: '0.85rem',
                                }}
                              >
                                {trashCard.name || '?'}
                                <br />
                                <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>
                                  Cost{trashCard.cost}
                                </span>
                              </button>
                            );
                          }
                          return null;
                        })}
                      </>
                    )}

                    {/* Spirits */}
                    {state.pendingEffectAction?.validTargets?.spiritIndices?.map((spiritIdx) => {
                      if (spiritIdx < 0) return null;
                      const spirit = targetPlayer?.spirits?.[spiritIdx];
                      if (!spirit) return null;

                      return (
                        <button
                          key={`spirit-${spiritIdx}`}
                          onClick={() => {
                            console.log('[ACTION] Clicking target spirit:', {spiritIdx, spiritName: spirit?.name});
                            const selectAction = legalActions.find(a =>
                              a.action?.type === 'select_effect_target' &&
                              a.action?.targetSpiritIndex === spiritIdx
                            );
                            console.log('[ACTION] Found selectAction:', {found: !!selectAction, actionIndex: selectAction?.index, action: selectAction?.action});
                            if (selectAction) {
                              console.log('[ACTION] Executing action with index:', selectAction.index);
                              executeAction(selectAction.index);
                            } else {
                              console.log('[ERROR] No matching select_effect_target action found in legalActions');
                              console.log('[DEBUG] Available actions:', legalActions.map(a => ({type: a.action?.type, spiritIdx: a.action?.targetSpiritIndex})));
                            }
                          }}
                          disabled={isBusy}
                          style={{
                            padding: '0.6rem',
                            backgroundColor: targetIsOpponent ? '#1976d2' : '#388e3c',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '0.85rem',
                          }}
                        >
                          {spirit.name || '?'}
                          <br />
                          <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>
                            BP{spirit.bp || '?'}
                          </span>
                        </button>
                      );
                    })}

                    {/* Nexuses */}
                    {state.pendingEffectAction?.validTargets?.nexusIndices?.map((nexusIdx) => {
                      const nexus = targetPlayer?.nexuses?.[nexusIdx];
                      if (!nexus) return null;

                      return (
                        <button
                          key={`nexus-${nexusIdx}`}
                          onClick={() => {
                            console.log('[ACTION] Clicking target nexus:', {nexusIdx, nexusName: nexus?.name});
                            const selectAction = legalActions.find(a =>
                              a.action?.type === 'select_effect_target' &&
                              a.action?.targetNexusIndex === nexusIdx
                            );
                            console.log('[ACTION] Found selectAction:', {found: !!selectAction, actionIndex: selectAction?.index, action: selectAction?.action});
                            if (selectAction) {
                              console.log('[ACTION] Executing action with index:', selectAction.index);
                              executeAction(selectAction.index);
                            } else {
                              console.log('[ERROR] No matching select_effect_target action found in legalActions');
                              console.log('[DEBUG] Available actions:', legalActions.map(a => ({type: a.action?.type, nexusIdx: a.action?.targetNexusIndex})));
                            }
                          }}
                          disabled={isBusy}
                          style={{
                            padding: '0.6rem',
                            backgroundColor: targetIsOpponent ? '#7b1fa2' : '#f57c00',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: '0.85rem',
                          }}
                        >
                          {nexus.name || '?'}
                          <br />
                          <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>Nexus</span>
                        </button>
                      );
                    })}
                  </>
                  );
                } catch (err) {
                  console.error('[RENDER_ERROR] Effect target selection failed:', err);
                  return (
                    <div style={{color: 'red', padding: '1rem', backgroundColor: '#fee'}}>
                      エラーが発生しました: {String(err)}
                    </div>
                  );
                }
              })()}
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

                  // Stage ⓪ diagnostic: Log UI buttons being rendered
                  if (costActions.length > 0) {
                    console.log('[STAGE⓪ UI_RENDER] Cost actions (支払うコア):');
                    const uiButtons = costActions.map(a => a.description).join('\n  ・');
                    console.log('  ・' + uiButtons);
                  }
                  if (coreActions.length > 0) {
                    console.log('[STAGE⓪ UI_RENDER] Core actions (乗せるコア):');
                    const uiButtons = coreActions.map(a => a.description).join('\n  ・');
                    console.log('  ・' + uiButtons);
                  }

                  return (
                    <>
                      {costActions.length > 0 && (
                        <div style={{ marginBottom: '0.8rem' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#1e7e4d', marginBottom: '0.3rem', textTransform: 'uppercase' }}>
                            💚 支払うコア（カード召喚用）
                          </div>
                          {costActions.map((action) => {
                            // Stage ⓪-B diagnostic: Log button creation
                            console.log('[BUTTON_CREATE]', {
                              index: action.index,
                              label: action.description,
                              type: (action as any).type,
                              paymentType: (action as any).paymentPlan?.paymentType,
                              inheritanceCount: (action as any).paymentPlan?.inheritanceCount,
                            });
                            return (
                              <button
                                key={action.index}
                                className="action-button"
                                onClick={() => {
                                  // Stage ⓪-B diagnostic: Log button click
                                  console.log('[BUTTON_CLICK]', {
                                    index: action.index,
                                    label: action.description,
                                    type: (action as any).type,
                                    paymentType: (action as any).paymentPlan?.paymentType,
                                    inheritanceCount: (action as any).paymentPlan?.inheritanceCount,
                                  });
                                  executeAction(action.index);
                                }}
                                disabled={isBusy}
                                style={{ marginBottom: '0.3rem', backgroundColor: '#1e7e4d', borderColor: '#0d5c3a' }}
                              >
                                {action.description}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {coreActions.length > 0 && (
                        <div>
                          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#6b46c1', marginBottom: '0.3rem', textTransform: 'uppercase' }}>
                            💜 乗せるコア（スピリット配置用）
                          </div>
                          {coreActions.map((action) => {
                            // Stage ⓪-B diagnostic: Log button creation
                            console.log('[BUTTON_CREATE]', {
                              index: action.index,
                              label: action.description,
                              type: (action as any).type,
                              paymentType: (action as any).paymentPlan?.paymentType,
                              inheritanceCount: (action as any).paymentPlan?.inheritanceCount,
                            });
                            return (
                              <button
                                key={action.index}
                                className="action-button"
                                onClick={() => {
                                  // Stage ⓪-B diagnostic: Log button click
                                  console.log('[BUTTON_CLICK]', {
                                    index: action.index,
                                    label: action.description,
                                    type: (action as any).type,
                                    paymentType: (action as any).paymentPlan?.paymentType,
                                    inheritanceCount: (action as any).paymentPlan?.inheritanceCount,
                                  });
                                  executeAction(action.index);
                                }}
                                disabled={isBusy}
                                style={{ marginBottom: '0.3rem', backgroundColor: '#6b46c1', borderColor: '#553399' }}
                              >
                                {action.description}
                              </button>
                            );
                          })}
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
                <div
                  key={`${c.id}-${i}`}
                  className="mulligan-card"
                  onClick={() => c.imagePath && setSelectedCardImage({ imagePath: c.imagePath, name: c.name })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    c.imagePath && setSelectedCardImage({ imagePath: c.imagePath, name: c.name });
                  }}
                  style={{ cursor: 'pointer' }}
                >
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

      {/* ===== Inheritance selection modal ===== */}
      {!isTerminal && state.pendingInheritanceSelection && isHumanTurn && (
        <InheritanceSelectionModal
          pendingInheritanceSelection={state.pendingInheritanceSelection}
          onConfirm={(inheritanceCount, selectedCardIds) => {
            const actionIdx = legalActions.findIndex(a => a.action?.type === 'select_inheritance');
            if (actionIdx >= 0) {
              executeAction(actionIdx, {
                inheritanceCount,
                selectedCardIds,
              });
            }
          }}
          isBusy={isBusy}
        />
      )}

      {/* ===== Offering draw overlay ===== */}
      {!isTerminal && state.pendingDraw && isHumanTurn && (() => {
        return (
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
                        onContextMenu={(e) => {
                          e.preventDefault();
                          card.imagePath && setSelectedCardImage({ imagePath: card.imagePath, name: card.name });
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
        );
      })()}

      {/* ===== Card play choice dialog (multiple targets / payment modes) ===== */}
      {pendingActionChoice && (
        <div className="game-over" onClick={() => setPendingActionChoice(null)}>
          <div className="game-over-content" onClick={(e) => e.stopPropagation()}>
            <h3>🎯 「{pendingActionChoice.card.name}」の使い方を選択</h3>
            <div style={{ fontSize: '0.9rem', color: '#555', marginBottom: '0.8rem' }}>
              対象や支払い方法が複数あります。実行する内容を選んでください。
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
              {pendingActionChoice.options.map((opt) => (
                <button
                  key={opt.index}
                  onClick={() => {
                    const card = pendingActionChoice.card;
                    setPendingActionChoice(null);
                    beginCardAction(opt, card);
                  }}
                  disabled={isBusy}
                  style={{
                    padding: '0.7rem 1rem',
                    fontSize: '0.95rem',
                    cursor: 'pointer',
                    backgroundColor: '#1976d2',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    fontWeight: 600,
                    textAlign: 'left',
                  }}
                >
                  {opt.description}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPendingActionChoice(null)}
              style={{ padding: '0.5rem 1.2rem', cursor: 'pointer', borderRadius: '6px' }}
            >
              キャンセル
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

      {/* ===== Excluded cards viewing modal ===== */}
      {excludedViewPlayer !== null && state && (
        <div className="card-image-modal" onClick={() => setExcludedViewPlayer(null)}>
          <div className="card-image-modal-content trash-modal" onClick={(e) => e.stopPropagation()}>
            <div className="card-image-modal-title">
              P{excludedViewPlayer} の除外カード（{state.players[excludedViewPlayer].excludedCards.count}枚）
            </div>
            <div className="trash-modal-body">
              {state.players[excludedViewPlayer].excludedCards.cards && state.players[excludedViewPlayer].excludedCards.cards.length > 0 ? (
                <div className="trash-grid">
                  {state.players[excludedViewPlayer].excludedCards.cards.map((card: any, idx: number) => (
                    <div
                      key={`excluded-${idx}`}
                      className="trash-card"
                      title={`${card.name}\nコスト${card.cost}\n継承により除外\nクリックで拡大表示`}
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
                <div className="trash-empty">除外カードがありません</div>
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
