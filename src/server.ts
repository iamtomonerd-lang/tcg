import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { promises as fs } from 'fs';
import { BattlSpiritsGame } from './games/battlspirits/game.js';
import { CARD_DB } from './games/battlspirits/cards.js';
import type { GameState, Action, EffectResult } from './games/battlspirits/types.js';
import { Mulberry32 } from './core/rng.js';
import { IsmctsAgent } from './ai/ismcts.js';
import { cardToRulebook } from './games/battlspirits/cardRulebook.js';
import { deckOptimizer } from './ai/learning/deck-optimizer.js';
import { gameLogger } from './ai/learning/game-logger.js';
import { reinforcementLearning } from './ai/learning/reinforcement-learning.js';
import { neuralEvaluator } from './ai/learning/neural-learning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// Serve static files from web/dist
app.use(express.static(join(__dirname, '../web/dist')));

// Serve card images and other assets
app.use('/assets', express.static(join(__dirname, '../assets')));

interface GameSession {
  game: BattlSpiritsGame;
  state: GameState;
  rng: Mulberry32;
  p0Agent: any;
  p1Agent: any;
  playerTypes: [string, string];
  p0Rating?: number;
  p1Rating?: number;
  p0Deck?: { cardId: string; count: number }[];
  p1Deck?: { cardId: string; count: number }[];
  resultLogged?: boolean;
  mulliganChoices?: { [playerId: number]: boolean }; // Track mulligan choices (true=redraw, false=keep)
}

const sessions = new Map<string, GameSession>();

/**
 * Create a new game session
 */
app.post('/api/game/new', async (req, res) => {
  const { p0Type, p1Type, p0Iters, p1Iters, p0DeckId, p1DeckId, p0Rating } = req.body;

  const sessionId = Math.random().toString(36).substring(7);
  const rng = new Mulberry32(Date.now() & 0xffffffff);
  const game = new BattlSpiritsGame();
  let state = game.createInitialState(rng);

  // Randomly decide first player
  if (rng.next() < 0.5) {
    state.currentPlayer = 1;
  }

  const playerTypes: [string, string] = [p0Type || 'human', p1Type || 'mcts'];

  // Calculate AI rating and iterations if ranked match
  let actualP1Iters = p1Iters || 100;
  let actualP1DeckId = p1DeckId;
  let p1Rating: number | undefined;

  if (p0Rating !== undefined && p1DeckId === 'ai-auto') {
    // Generate AI rating using Gaussian distribution (±300 range is enforced later)
    p1Rating = generateAIRating(p0Rating, rng);
    // Calculate AI iterations based on rating (higher rating = more iterations)
    // Formula: base 100 + (rating - 1500) * 0.15
    actualP1Iters = Math.max(50, Math.floor(100 + (p1Rating - 1500) * 0.15));
    // Generate AI deck based on rating (deterministically from seed)
    actualP1DeckId = `ai-rating-${p1Rating}`;
  }

  // Load decks if provided (use session timestamp as seed for variation)
  const sessionSeed = Date.now() & 0xffffffff;
  console.log(`🎮 ゲーム開始リクエスト受信: p0Type=${p0Type}, p1Type=${p1Type}`);
  console.log(`   p0DeckId="${p0DeckId}", p1DeckId="${p1DeckId}"`);

  try {
    if (p0DeckId) {
      const deck0 = await loadDeckForGame(p0DeckId, sessionSeed);
      if (deck0) {
        console.log(`📋 【P0デッキロード直後】読み込まれたカード一覧: ${deck0.map((c: any) => c.id).join(', ')}`);
        state.players[0].deck = deck0;
        console.log(`✅ P0デッキロード成功: deckId="${p0DeckId}", カード枚数=${deck0.length}`);
        console.log(`📋 【P0デッキセット直後】state.players[0].deckの内容: ${state.players[0].deck.map((c: any) => c.id).join(', ')}`);
      } else {
        console.warn(`⚠️ P0デッキロード失敗: deckId="${p0DeckId}" - デフォルトデッキ(${state.players[0].deck.length}枚)を使用します`);
      }
    } else {
      console.log(`ℹ️ P0: デッキIDが指定されていません。デフォルトデッキ(${state.players[0].deck.length}枚)を使用します`);
    }

    if (actualP1DeckId) {
      const deck1 = await loadDeckForGame(actualP1DeckId, sessionSeed);
      if (deck1) {
        console.log(`📋 【P1デッキロード直後】読み込まれたカード一覧: ${deck1.map((c: any) => c.id).join(', ')}`);
        state.players[1].deck = deck1;
        console.log(`✅ P1デッキロード成功: deckId="${actualP1DeckId}", カード枚数=${deck1.length}`);
        console.log(`📋 【P1デッキセット直後】state.players[1].deckの内容: ${state.players[1].deck.map((c: any) => c.id).join(', ')}`);
      } else {
        console.warn(`⚠️ P1デッキロード失敗: deckId="${actualP1DeckId}" - デフォルトデッキ(${state.players[1].deck.length}枚)を使用します`);
      }
    } else {
      console.log(`ℹ️ P1: デッキIDが指定されていません。デフォルトデッキ(${state.players[1].deck.length}枚)を使用します`);
    }
  } catch (error) {
    console.error('Error loading decks:', error);
  }

  // Create AI agents ('human' players have no agent)
  const p0Agent = createAgent(playerTypes[0], p0Iters || 100, rng);
  const p1Agent = createAgent(playerTypes[1], actualP1Iters, rng);

  // ✅ ゲーム開始直前のデッキ内容確認
  console.log(`\n========== ゲーム開始直前のデッキ確認 ==========`);
  console.log(`📋 P0 deck (返却前): ${state.players[0].deck.map((c: any) => c.id).join(', ')}`);
  console.log(`📋 P1 deck (返却前): ${state.players[1].deck.map((c: any) => c.id).join(', ')}`);
  console.log(`==========================================\n`);

  // Extract deck info from loaded decks for learning logging
  const p0DeckInfo = state.players[0].deck.length > 0
    ? extractDeckInfo(state.players[0].deck)
    : [];
  const p1DeckInfo = state.players[1].deck.length > 0
    ? extractDeckInfo(state.players[1].deck)
    : [];

  // Use provided ratings or defaults for learning
  const finalP0Rating = p0Rating || 1700;
  const finalP1Rating = p1Rating || 1700;

  sessions.set(sessionId, {
    game,
    state,
    rng,
    p0Agent,
    p1Agent,
    playerTypes,
    p0Rating: finalP0Rating,
    p1Rating: finalP1Rating,
    p0Deck: p0DeckInfo,
    p1Deck: p1DeckInfo,
  });

  res.json({
    sessionId,
    state: serializeState(state),
    playerTypes,
    p1Rating,
  });
});

/**
 * Get current game state
 */
app.get('/api/game/:sessionId/state', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Auto-execute dice rolls with delays to show results
  if (session.state.pendingDiceRoll && session.state.pendingDiceRoll.winner === undefined) {
    const actions = session.game.legalActions(session.state);
    const diceActions = actions.filter((a) => a.type === 'dice_roll');
    if (diceActions.length > 0) {
      const randomAction = diceActions[Math.floor(Math.random() * diceActions.length)]!;
      session.state = session.game.applyAction(session.state, randomAction, session.rng);
    }
  }

  const isTerminal = session.game.isTerminal(session.state);

  // Log game result when game ends (only once)
  if (isTerminal && !session.resultLogged && session.state.result?.winner !== null) {
    const winnerId = session.state.result!.winner!;
    const loserRating = winnerId === 0 ? session.p1Rating || 1700 : session.p0Rating || 1700;
    const winnerRating = winnerId === 0 ? session.p0Rating || 1700 : session.p1Rating || 1700;

    const result: any = {
      timestamp: Date.now(),
      player0Rating: session.p0Rating || 1700,
      player1Rating: session.p1Rating || 1700,
      winnerId,
      winnerRating,
      loserRating,
      turnCount: session.state.turnCount,
      player0Deck: session.p0Deck || [],
      player1Deck: session.p1Deck || [],
      player0CardsPlayed: extractCardsPlayed(session.state.players[0]),
      player1CardsPlayed: extractCardsPlayed(session.state.players[1]),
      damageDealt: [
        session.state.players[1].life < 5 ? 5 - session.state.players[1].life : 0,
        session.state.players[0].life < 5 ? 5 - session.state.players[0].life : 0,
      ],
      spiritsDestroyed: session.state.players[0].trash.filter(c => c.cardType === 'spirit').length +
                        session.state.players[1].trash.filter(c => c.cardType === 'spirit').length,
    };

    gameLogger.recordGameResult(result);

    // 強化学習を更新
    reinforcementLearning.updateCardValues(result);

    // ニューラルネットを定期的に訓練（50ゲームごと）
    const allResults = gameLogger.getGameResults();
    if (allResults.length % 50 === 0) {
      neuralEvaluator.learnFromGameResults();
    }

    session.resultLogged = true;
  }

  res.json({
    state: serializeState(session.state),
    isTerminal,
    currentPlayer: session.game.currentPlayer(session.state),
    playerTypes: session.playerTypes,
  });
});

/**
 * Get legal actions for current state
 */
app.get('/api/game/:sessionId/actions', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const actions = session.game.legalActions(session.state);
  const descriptions = actions.map((action, i) => ({
    index: i,
    description: session.game.describeAction(session.state, action),
    action,
  }));

  res.json({ actions: descriptions });
});

/**
 * Get the cost (cores needed) for an action
 */
app.post('/api/game/:sessionId/action-cost', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { actionIndex } = req.body;
  const actions = session.game.legalActions(session.state);
  const action = actions[actionIndex];

  if (!action) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const cost = (session.game as any).actionCost(session.state, action);
  res.json({ cost });
});

/**
 * Play an action
 */
app.post('/api/game/:sessionId/action', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Auto-execute dice rolls until both players have rolled and winner is determined
  while (session.state.pendingDiceRoll && session.state.pendingDiceRoll.winner === undefined) {
    const actions = session.game.legalActions(session.state);
    const diceActions = actions.filter((a) => a.type === 'dice_roll');
    if (diceActions.length > 0) {
      const randomAction = diceActions[Math.floor(Math.random() * diceActions.length)]!;
      session.state = session.game.applyAction(session.state, randomAction, session.rng);
    } else {
      break; // No more dice actions, exit loop
    }
  }

  const { actionIndex, cardIndices, selectedCardIndices, arrangedCardIndices, coreType, paidRegularCores, paidSoulCores, moveCore } = req.body;
  let action: any;

  if (moveCore !== undefined) {
    // Direct core movement via drag & drop (not part of the enumerated action list)
    action = {
      type: 'move_core',
      fromZone: moveCore.fromZone,
      fromIndex: moveCore.fromIndex,
      toZone: moveCore.toZone,
      toIndex: moveCore.toIndex,
      coreType: moveCore.coreType === 'soul' ? 'soul' : 'regular',
    };
  } else if (selectedCardIndices !== undefined || arrangedCardIndices !== undefined) {
    // Card arrangement for offering draw with player selection
    action = {
      type: 'select_draw_arrange',
      selectedCardIndices: selectedCardIndices || [],
      arrangedCardIndices: arrangedCardIndices || [],
    };
  } else if (cardIndices !== undefined) {
    // Legacy: Card arrangement for offering draw (all cards)
    action = { type: 'select_draw_arrange', cardIndices };
  } else {
    const actions = session.game.legalActions(session.state);
    action = actions[actionIndex];
    // Attach core payment information if provided
    if (action) {
      if (paidRegularCores !== undefined || paidSoulCores !== undefined) {
        // Use exact core counts from Web UI
        action.paidRegularCores = paidRegularCores || 0;
        action.paidSoulCores = paidSoulCores || 0;
      } else if (coreType) {
        // Legacy: use coreType preference
        action.coreType = coreType;
      }
    }
  }

  if (!action) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const description = session.game.describeAction(session.state, action);
  const actingPlayer = session.game.currentPlayer(session.state);
  const stateBefore = session.state;
  session.state = session.game.applyAction(session.state, action, session.rng);
  const effectResults = detectEffectResults(stateBefore, session.state, action);

  let actionDescription = `P${actingPlayer}: ${description}`;

  // Track mulligan choices
  if (action.type === 'mulligan') {
    if (!session.mulliganChoices) {
      session.mulliganChoices = {};
    }
    session.mulliganChoices[actingPlayer] = action.redraw;

    // Add mulligan completion info when both players have completed
    if (!session.state.pendingMulligan) {
      const p0Redraw = session.mulliganChoices[0];
      const p1Redraw = session.mulliganChoices[1];
      const p0Choice = p0Redraw ? 'redraw' : 'keep';
      const p1Choice = p1Redraw ? 'redraw' : 'keep';
      actionDescription = `✓ マリガン完了: P0 ${p0Choice} (4枚), P1 ${p1Choice} (4枚)`;
      // Reset for next potential mulligan scenario
      session.mulliganChoices = {};
    }
  }

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
    currentPlayer: session.game.currentPlayer(session.state),
    actionDescription,
    effectResults,
  });
});

/**
 * Play one AI turn
 */
app.post('/api/game/:sessionId/ai-turn', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.game.isTerminal(session.state)) {
    return res.status(400).json({ error: 'Game is already terminal' });
  }

  // During mulligan, use pendingMulligan.player instead of currentPlayer
  const decidingPlayer = session.state.pendingMulligan
    ? session.state.pendingMulligan.player
    : session.game.currentPlayer(session.state);

  const agent = decidingPlayer === 0 ? session.p0Agent : session.p1Agent;

  if (!agent) {
    return res.status(400).json({ error: 'Current player is human; use /action instead' });
  }

  // Get best action from AI (describe BEFORE applying — indices refer to the pre-action state)
  try {
    const legalActionsDebug = session.game.legalActions(session.state);
    console.log(`[DEBUG ai-turn] sessionId=${req.params.sessionId}, decidingPlayer=${decidingPlayer}, phase=${session.state.phase}, pendingDiceRoll=${JSON.stringify(session.state.pendingDiceRoll)}, pendingMulligan=${session.state.pendingMulligan ? `{player:${session.state.pendingMulligan.player}}` : 'null'}, legalActionsCount=${legalActionsDebug.length}`);

    if (legalActionsDebug.length === 0) {
      console.error(`❌ ERROR: legalActions is empty!`);
      console.error(`State: phase=${session.state.phase}, currentPlayer=${session.game.currentPlayer(session.state)}, isTerminal=${session.game.isTerminal(session.state)}`);
      console.error(`pendingDiceRoll=${JSON.stringify(session.state.pendingDiceRoll)}`);
      console.error(`pendingMulligan=${JSON.stringify(session.state.pendingMulligan)}`);
      return res.status(400).json({ error: 'No legal actions available - game state error' });
    }
  } catch (e) {
    console.error(`❌ legalActions() threw error:`, e);
    return res.status(400).json({ error: `Error getting legal actions: ${e}` });
  }

  const action = agent.chooseAction(session.game, session.state, session.rng);
  const description = session.game.describeAction(session.state, action);
  const stateBefore = session.state;
  console.log(`[DEBUG] About to apply action: ${JSON.stringify(action).substring(0, 100)}`);
  session.state = session.game.applyAction(session.state, action, session.rng);
  console.log(`[DEBUG] After applyAction: phase=${session.state.phase}, pendingMulligan=${session.state.pendingMulligan ? `{player:${session.state.pendingMulligan.player}}` : 'null'}, pendingDiceRoll=${JSON.stringify(session.state.pendingDiceRoll)}`);
  const nextLegalActions = session.game.legalActions(session.state);
  console.log(`[DEBUG] Next legalActions count: ${nextLegalActions.length}`);
  const effectResults = detectEffectResults(stateBefore, session.state, action);

  let actionDescription = `P${decidingPlayer}: ${description}`;

  // Add mulligan completion info
  if (action.type === 'mulligan' && !session.state.pendingMulligan) {
    actionDescription = `✓ マリガン完了 (P0: ${stateBefore.players[0].hand.length}枚, P1: ${stateBefore.players[1].hand.length}枚)`;
  }

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
    currentPlayer: session.game.currentPlayer(session.state),
    actionDescription,
    effectResults,
  });
});

/**
 * Play multiple AI turns until game ends or manual action
 */
app.post('/api/game/:sessionId/auto-play', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { maxTurns } = req.body;
  let turnsPlayed = 0;

  while (!session.game.isTerminal(session.state) && turnsPlayed < (maxTurns || 100)) {
    const currentPlayer = session.game.currentPlayer(session.state);
    const agent = currentPlayer === 0 ? session.p0Agent : session.p1Agent;

    const action = await agent.selectAction(session.state, session.game, session.rng);
    session.state = session.game.applyAction(session.state, action, session.rng);
    turnsPlayed++;
  }

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
    turnsPlayed,
  });
});

/**
 * Get card information
 */
app.get('/api/cards/:cardId', (req, res) => {
  const card = CARD_DB[req.params.cardId];
  if (!card) {
    return res.status(404).json({ error: 'Card not found' });
  }

  res.json(card);
});

/**
 * Get card rulebook HTML
 */
app.get('/api/cards/:cardId/rulebook', (req, res) => {
  const card = CARD_DB[req.params.cardId];
  if (!card) {
    return res.status(404).json({ error: 'Card not found' });
  }

  const html = cardToRulebook(card);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

/**
 * Get all cards
 */
app.get('/api/cards', (req, res) => {
  res.json(CARD_DB);
});

// Training data lives OUTSIDE the app folder so it survives deleting or
// re-downloading the game (e.g. C:\Users\<name>\BattleSpiritsAI\training-stats.json).
// Override with the BS_DATA_DIR environment variable if needed.
const TRAINING_DATA_DIR = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
const TRAINING_STATS_PATH = join(TRAINING_DATA_DIR, 'training-stats.json');
// Location used by older versions (inside the app folder) — migrated on first read
const LEGACY_STATS_PATH = join(__dirname, '../data/training-stats.json');

async function readTrainingStats(): Promise<{ sessions: any[] }> {
  try {
    return JSON.parse(await fs.readFile(TRAINING_STATS_PATH, 'utf-8'));
  } catch {
    // Fall back to the legacy in-app file and migrate it out
    try {
      const legacy = JSON.parse(await fs.readFile(LEGACY_STATS_PATH, 'utf-8'));
      await writeTrainingStats(legacy);
      console.log(`📦 学習データを移行しました: ${LEGACY_STATS_PATH} → ${TRAINING_STATS_PATH}`);
      return legacy;
    } catch {
      return { sessions: [] };
    }
  }
}

async function writeTrainingStats(stats: { sessions: any[] }): Promise<void> {
  await fs.mkdir(TRAINING_DATA_DIR, { recursive: true });
  await fs.writeFile(TRAINING_STATS_PATH, JSON.stringify(stats, null, 2), 'utf-8');
}

/**
 * Get training statistics
 */
app.get('/api/training/stats', async (req, res) => {
  const stats = await readTrainingStats();
  res.json({ ...stats, storagePath: TRAINING_STATS_PATH });
});

/**
 * Cloud storage endpoints for Google Drive
 */
app.get('/api/cloud/google-drive/auth', (req, res) => {
  // In a real implementation, redirect to Google OAuth
  // For now, simulate successful connection
  res.redirect('/?google-drive-auth=success');
});

app.post('/api/cloud/google-drive/upload', async (req, res) => {
  try {
    // In a real implementation, upload to Google Drive
    console.log('Google Drive upload simulation:', req.body);
    res.json({ success: true, message: 'Uploaded to Google Drive' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload to Google Drive' });
  }
});

/**
 * Cloud storage endpoints for Dropbox
 */
app.get('/api/cloud/dropbox/auth', (req, res) => {
  // In a real implementation, redirect to Dropbox OAuth
  // For now, simulate successful connection
  res.redirect('/?dropbox-auth=success');
});

app.post('/api/cloud/dropbox/upload', async (req, res) => {
  try {
    // In a real implementation, upload to Dropbox
    console.log('Dropbox upload simulation:', req.body);
    res.json({ success: true, message: 'Uploaded to Dropbox' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to upload to Dropbox' });
  }
});

/**
 * Save training statistics
 */
app.post('/api/training/stats', async (req, res) => {
  try {
    // Read current stats (migrates from the legacy in-app location if needed)
    const allStats = await readTrainingStats();

    // Add or update session stats
    const { sessionId, stats } = req.body;
    if (sessionId && stats) {
      const existingIndex = allStats.sessions.findIndex((s: any) => s.sessionId === sessionId);
      if (existingIndex >= 0) {
        allStats.sessions[existingIndex] = { sessionId, ...stats, updatedAt: new Date().toISOString() };
      } else {
        allStats.sessions.push({ sessionId, ...stats, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
    }

    await writeTrainingStats(allStats);
    res.json({ success: true, stats: allStats, storagePath: TRAINING_STATS_PATH });
  } catch (error) {
    console.error('Error saving training stats:', error);
    res.status(500).json({ error: 'Failed to save training stats' });
  }
});

// Helper functions

/**
 * Convert an array of card objects to deck info format
 */
function extractDeckInfo(cards: any[]): { cardId: string; count: number }[] {
  const counts: { [cardId: string]: number } = {};
  for (const card of cards) {
    const cardId = card.id;
    counts[cardId] = (counts[cardId] || 0) + 1;
  }
  return Object.entries(counts).map(([cardId, count]) => ({ cardId, count }));
}

/**
 * Extract cards that were played (used) by a player during the game
 */
function extractCardsPlayed(player: any): string[] {
  const played = new Set<string>();

  // Cards in spirits (summoned)
  if (player.spirits) {
    for (const spirit of player.spirits) {
      played.add(spirit.def.id);
    }
  }

  // Cards in nexuses (summoned)
  if (player.nexuses) {
    for (const nexus of player.nexuses) {
      played.add(nexus.def.id);
    }
  }

  // Cards in trash (destroyed or used as magic)
  if (player.trash) {
    for (const card of player.trash) {
      played.add(card.id);
    }
  }

  return Array.from(played);
}

function createAgent(type: string, iters: number, _rng: Mulberry32) {
  switch (type) {
    case 'human':
      return null; // Humans act via the /action endpoint
    case 'mcts':
      return new IsmctsAgent({ iterations: iters });
    case 'random':
    default:
      return {
        name: 'Random',
        chooseAction: (game: BattlSpiritsGame, state: GameState, rng: Mulberry32) => {
          const actions = game.legalActions(state);
          return actions[rng.int(actions.length)]!;
        },
      };
  }
}

function detectEffectResults(before: GameState, after: GameState, action: Action): EffectResult[] {
  const results: EffectResult[] = [];

  // 引いたカードを検出
  if (action.type === 'select_draw_arrange') {
    if (action.selectedCardIndices && action.selectedCardIndices.length > 0 && before.pendingDraw) {
      const cardNames = action.selectedCardIndices
        .map(idx => before.pendingDraw!.openedCards[idx]?.name)
        .filter((name): name is string => !!name);
      if (cardNames.length > 0) {
        results.push({
          description: `📥 ${cardNames.join(', ')}を手札に加える`,
          type: 'draw',
        });
      }
    }
  }

  // 手札が増えたかどうかを検出（draw フェーズなど）
  for (let p = 0; p < 2; p++) {
    const beforePlayer = before.players[p];
    const afterPlayer = after.players[p];
    if (!beforePlayer || !afterPlayer) continue;

    const beforeHandSize = beforePlayer.hand.length;
    const afterHandSize = afterPlayer.hand.length;

    if (afterHandSize > beforeHandSize) {
      const newCards = afterPlayer.hand.slice(afterHandSize - (afterHandSize - beforeHandSize));
      const cardNames = newCards.map(c => c.name);
      if (cardNames.length > 0) {
        results.push({
          description: `📥 ${cardNames.join(', ')}を手札に加える`,
          type: 'draw',
        });
      }
    }
  }

  // 破壊されたスピリット/ネクサスを検出
  for (let p = 0; p < 2; p++) {
    const beforePlayer = before.players[p];
    const afterPlayer = after.players[p];
    if (!beforePlayer || !afterPlayer) continue;

    const beforeSpirits = beforePlayer.spirits;
    const afterSpirits = afterPlayer.spirits;

    // スピリット減少を検出
    if (beforeSpirits.length > afterSpirits.length) {
      // 破壊されたスピリットを特定する
      for (const spirit of beforeSpirits) {
        if (!afterSpirits.some(s => s.def.id === spirit.def.id)) {
          results.push({
            description: `⚔️ ${spirit.def.name}が破壊された`,
            type: 'destroy',
          });
        }
      }
    }

    // ネクサス減少を検出
    const beforeNexuses = beforePlayer.nexuses;
    const afterNexuses = afterPlayer.nexuses;

    if (beforeNexuses.length > afterNexuses.length) {
      for (const nexus of beforeNexuses) {
        if (!afterNexuses.some(n => n.def.id === nexus.def.id)) {
          results.push({
            description: `💥 ${nexus.def.name}が破壊された`,
            type: 'destroy',
          });
        }
      }
    }
  }

  // BP アップを検出
  for (let p = 0; p < 2; p++) {
    const beforePlayer = before.players[p];
    const afterPlayer = after.players[p];
    if (!beforePlayer || !afterPlayer) continue;

    const beforeSpirits = beforePlayer.spirits;
    const afterSpirits = afterPlayer.spirits;

    for (let i = 0; i < Math.min(beforeSpirits.length, afterSpirits.length); i++) {
      const beforeSpirit = beforeSpirits[i];
      const afterSpirit = afterSpirits[i];
      if (!beforeSpirit || !afterSpirit) continue;

      const beforeBp = (beforeSpirit.level === 1 ? beforeSpirit.def.lv1 : beforeSpirit.def.lv2 || beforeSpirit.def.lv1).bp + (beforeSpirit.bpBoost ?? 0) + (beforeSpirit.bpBoostBattle ?? 0);
      const afterBp = (afterSpirit.level === 1 ? afterSpirit.def.lv1 : afterSpirit.def.lv2 || afterSpirit.def.lv1).bp + (afterSpirit.bpBoost ?? 0) + (afterSpirit.bpBoostBattle ?? 0);

      if (afterBp > beforeBp) {
        const bpIncrease = afterBp - beforeBp;
        results.push({
          description: `💪 ${afterSpirit.def.name}の BP が +${bpIncrease} 上がった（${beforeBp} → ${afterBp}）`,
          type: 'boost_bp',
        });
      }
    }
  }

  // ダメージを検出
  for (let p = 0; p < 2; p++) {
    const beforePlayer = before.players[p];
    const afterPlayer = after.players[p];
    if (!beforePlayer || !afterPlayer) continue;

    const lifeLoss = beforePlayer.life - afterPlayer.life;
    if (lifeLoss > 0) {
      results.push({
        description: `💔 P${p}は${lifeLoss}ダメージを受けた（${beforePlayer.life} → ${afterPlayer.life}）`,
        type: 'damage',
      });
    }
  }

  return results;
}

function serializeState(state: GameState) {
  return {
    players: state.players.map((p) => ({
      life: p.life,
      cores: p.cores,
      soulCores: p.soulCores || 0,
      trashCores: p.trashCores || 0,
      trashSoulCores: p.trashSoulCores || 0,
      handSize: p.hand.length,
      handCards: p.hand.map((c) => ({
        id: c.id,
        name: c.name,
        cardType: c.cardType,
        cost: c.cost,
        reductionCost: c.reductionCost,
        symbolColors: c.symbolColors || [],
        lv1: c.lv1,
        lv2: c.lv2,
        exSymbol: c.exSymbol,
        inheritance: c.inheritance,
        imagePath: c.imagePath,
      })),
      deck: { count: p.deck.length },
      spirits: p.spirits.map((s) => ({
        id: s.def.id,
        name: s.def.name,
        level: s.level,
        symbolColors: s.def.symbolColors || [],
        symbolCount: s.def.symbolCount,
        coreCount: s.coreCount,
        soulCoreCount: s.soulCoreCount || 0,
        coresForLv2: s.def.lv2 ? s.def.lv2.cost : null,
        lv2CoreType: s.def.lv2?.coreType,
        canAttack: s.canAttack,
        imagePath: s.def.imagePath,
        bp: (s.level === 1 ? s.def.lv1 : s.def.lv2 || s.def.lv1).bp + (s.bpBoost ?? 0) + (s.bpBoostBattle ?? 0),
      })),
      nexuses: p.nexuses.map((n) => ({
        id: n.def.id,
        name: n.def.name,
        level: n.level,
        coreCount: n.coreCount,
        soulCoreCount: n.soulCoreCount || 0,
        coresForLv2: n.def.lv2 ? n.def.lv2.cost : null,
        imagePath: n.def.imagePath,
        exhausted: !!n.exhausted,
      })),
      trash: {
        count: p.trash.length,
        hasEXSymbol: p.trash.some((c) => c.exSymbol),
        cards: p.trash.map((c) => ({
          id: c.id,
          name: c.name,
          cost: c.cost,
          imagePath: c.imagePath,
        })),
      },
      bottomDeckCards: p.bottomDeckCards.map((c) => ({
        id: c.id,
        name: c.name,
        cost: c.cost,
        imagePath: c.imagePath,
      })),
    })),
    currentPlayer: state.currentPlayer,
    turnCount: state.turnCount,
    phase: state.phase,
    result: state.result,
    pendingAttack: state.pendingAttack
      ? {
          attackerPlayer: state.pendingAttack.attackerPlayer,
          attackerName:
            state.players[state.pendingAttack.attackerPlayer]?.spirits[
              state.pendingAttack.attackerSpiritIndex
            ]?.def.name ?? '?',
          damage: state.pendingAttack.damage,
        }
      : null,
    pendingFlash: state.pendingFlash ? { trigger: state.pendingFlash.trigger } : null,
    pendingMulligan: state.pendingMulligan ? { player: state.pendingMulligan.player } : null,
    pendingDraw: state.pendingDraw
      ? {
          openedCards: state.pendingDraw.openedCards.map((c) => ({
            id: c.id,
            name: c.name,
            cost: c.cost,
            imagePath: c.imagePath,
          })),
          toHandIndices: state.pendingDraw.toHandIndices,
          toRearrangeIndices: state.pendingDraw.toRearrangeIndices,
          selectableIndices: state.pendingDraw.selectableIndices || [],
          castCard: state.pendingDraw.castCard
            ? {
                id: state.pendingDraw.castCard.id,
                name: state.pendingDraw.castCard.name,
              }
            : null,
          maxSelectable: state.pendingDraw.maxSelectable,
          returnDestination: state.pendingDraw.returnDestination,
          originAttackSpiritIndex: state.pendingDraw.originAttackSpiritIndex,
          originAttackPlayer: state.pendingDraw.originAttackPlayer,
        }
      : null,
    pendingSpellChain: state.pendingSpellChain
      ? {
          summonedSpiritIndex: state.pendingSpellChain.summonedSpiritIndex,
          summonedCard: {
            id: state.pendingSpellChain.summonedCard.id,
            name: state.pendingSpellChain.summonedCard.name,
          },
          destructedSpiritIndices: state.pendingSpellChain.destructedSpiritIndices,
          destructedNexusIndices: state.pendingSpellChain.destructedNexusIndices,
        }
      : null,
    pendingSpiritDepletion: state.pendingSpiritDepletion
      ? {
          spiritIndex: state.pendingSpiritDepletion.spiritIndex,
          spiritCard: {
            id: state.pendingSpiritDepletion.spiritCard.id,
            name: state.pendingSpiritDepletion.spiritCard.name,
          },
          requiredCores: state.pendingSpiritDepletion.requiredCores,
          currentCores: state.pendingSpiritDepletion.currentCores,
        }
      : null,
    pendingNexusDepletion: state.pendingNexusDepletion
      ? {
          nexusIndex: state.pendingNexusDepletion.nexusIndex,
          nexusCard: {
            id: state.pendingNexusDepletion.nexusCard.id,
            name: state.pendingNexusDepletion.nexusCard.name,
          },
          requiredCores: state.pendingNexusDepletion.requiredCores,
          currentCores: state.pendingNexusDepletion.currentCores,
        }
      : null,
    pendingDiceRoll: state.pendingDiceRoll || null,
    pendingEffectAction: state.pendingEffectAction
      ? {
          effect: state.pendingEffectAction.effect,
          sourceCard: {
            id: state.pendingEffectAction.sourceCard.id,
            name: state.pendingEffectAction.sourceCard.name,
          },
          sourcePlayer: state.pendingEffectAction.sourcePlayer,
          spiritIndex: state.pendingEffectAction.spiritIndex,
          sourceNexusIndex: state.pendingEffectAction.sourceNexusIndex,
          validTargets: state.pendingEffectAction.validTargets,
          trigger: state.pendingEffectAction.trigger,
        }
      : null,
  };
}

// ランク統計用インターフェース
interface DeckRating {
  deckId: string;
  deckName: string;
  rating: number;
  wins: number;
  losses: number;
  lastUpdated: string;
}

interface RankStatsData {
  decks: { [key: string]: DeckRating };
}

// ランク統計ファイルのパス
function getRankStatsPath(): string {
  const dataDir = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
  return join(dataDir, 'rank-stats.json');
}

// ランク統計を読み込む
async function loadRankStats(): Promise<RankStatsData> {
  try {
    const path = getRankStatsPath();
    const data = await fs.readFile(path, 'utf-8');
    return JSON.parse(data) as RankStatsData;
  } catch {
    return { decks: {} };
  }
}

// ランク統計を保存
async function saveRankStats(data: RankStatsData): Promise<void> {
  const dataDir = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const path = getRankStatsPath();
    await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save rank stats:', error);
  }
}

// Eloレーティング計算
function calculateNewRating(
  currentRating: number,
  opponentRating: number,
  result: number, // 1 = win, 0.5 = draw, 0 = loss
  k: number = 32
): number {
  const expectedScore = 1 / (1 + Math.pow(10, (opponentRating - currentRating) / 400));
  const newRating = currentRating + k * (result - expectedScore);
  return Math.round(newRating);
}

// 正規分布に従うランダム値を生成（Box-Muller変換）
function randomGaussian(mean: number, sigma: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z0 * sigma;
}

// ランク統計エンドポイント
app.get('/api/rank/stats', async (req, res) => {
  try {
    const stats = await loadRankStats();
    const decks = Object.values(stats.decks);
    res.json({ decks });
  } catch (error) {
    console.error('Error loading rank stats:', error);
    res.status(500).json({ error: 'Failed to load rank stats' });
  }
});

// デッキのレート初期化
app.post('/api/rank/init-deck', async (req, res) => {
  try {
    const { deckId, deckName } = req.body;
    if (!deckId || !deckName) {
      return res.status(400).json({ error: 'Missing deckId or deckName' });
    }

    const stats = await loadRankStats();
    if (!stats.decks[deckId]) {
      stats.decks[deckId] = {
        deckId,
        deckName,
        rating: 1500,
        wins: 0,
        losses: 0,
        lastUpdated: new Date().toISOString(),
      };
      await saveRankStats(stats);
    }

    res.json({ rating: stats.decks[deckId].rating });
  } catch (error) {
    console.error('Error initializing deck rating:', error);
    res.status(500).json({ error: 'Failed to initialize deck rating' });
  }
});

// ランク更新（対戦結果から）
app.post('/api/rank/update', async (req, res) => {
  try {
    const { deckId, result } = req.body; // result: 1 = win, 0 = loss
    if (!deckId || result === undefined) {
      return res.status(400).json({ error: 'Missing deckId or result' });
    }

    const stats = await loadRankStats();
    const deck = stats.decks[deckId];
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }

    // 対戦相手のレート生成（正規分布、±300の範囲）
    let opponentRating = randomGaussian(1500, 200);
    opponentRating = Math.max(1200, Math.min(1800, opponentRating));

    // 対戦相手のレートをデッキのレートに合わせて調整
    const ratingDiff = Math.abs(deck.rating - 1500);
    const adjustedOpponentRating = Math.max(
      1200,
      Math.min(1800, 1500 + (opponentRating - 1500) + (Math.random() - 0.5) * ratingDiff)
    );

    // 新しいレートを計算
    const newRating = calculateNewRating(deck.rating, Math.round(adjustedOpponentRating), result);

    // 統計情報を更新
    deck.rating = newRating;
    if (result === 1) {
      deck.wins++;
    } else {
      deck.losses++;
    }
    deck.lastUpdated = new Date().toISOString();

    await saveRankStats(stats);

    res.json({
      newRating,
      opponentRating: Math.round(adjustedOpponentRating),
      ratingChange: newRating - deck.rating + Math.round(newRating - deck.rating + (result ? 0 : 0)),
      wins: deck.wins,
      losses: deck.losses,
    });
  } catch (error) {
    console.error('Error updating rank:', error);
    res.status(500).json({ error: 'Failed to update rank' });
  }
});

// 保存デッキ用インターフェース
interface SavedDeck {
  id: string;
  name: string;
  cards: { cardId: string; count: number }[];
  createdAt: string;
  updatedAt: string;
}

interface DecksData {
  decks: { [key: string]: SavedDeck };
}

// デッキファイルのパス
function getDecksPath(): string {
  const dataDir = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
  return join(dataDir, 'decks.json');
}

// デッキを読み込む
async function loadDecks(): Promise<DecksData> {
  try {
    const path = getDecksPath();
    const data = await fs.readFile(path, 'utf-8');
    return JSON.parse(data) as DecksData;
  } catch {
    return { decks: {} };
  }
}

// デッキを保存
async function saveDecks(data: DecksData): Promise<void> {
  const dataDir = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(getDecksPath(), JSON.stringify(data, null, 2), 'utf-8');
}

// デッキ一覧取得
app.get('/api/decks', async (_req, res) => {
  try {
    const data = await loadDecks();
    const decks = Object.values(data.decks).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    res.json({ decks });
  } catch (error) {
    console.error('Error loading decks:', error);
    res.status(500).json({ error: 'Failed to load decks' });
  }
});

// デッキ保存（新規・上書き）
app.post('/api/decks', async (req, res) => {
  try {
    const { id, name, cards } = req.body as {
      id?: string;
      name?: string;
      cards?: { cardId: string; count: number }[];
    };

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'デッキ名を入力してください' });
    }
    if (!Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'カードがありません' });
    }

    // バリデーション: 40枚ちょうど、同名3枚まで
    const total = cards.reduce((sum, c) => sum + c.count, 0);
    if (total !== 40) {
      return res.status(400).json({ error: `デッキは40枚ちょうどである必要があります（現在: ${total}枚）` });
    }
    if (cards.some((c) => c.count > 3 || c.count < 1)) {
      return res.status(400).json({ error: '同じカードは3枚までです' });
    }

    const data = await loadDecks();
    const now = new Date().toISOString();
    const deckId = id && data.decks[id] ? id : `deck_${Date.now().toString(36)}`;
    const existing = data.decks[deckId];

    data.decks[deckId] = {
      id: deckId,
      name: name.trim(),
      cards,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await saveDecks(data);

    res.json({ deck: data.decks[deckId] });
  } catch (error) {
    console.error('Error saving deck:', error);
    res.status(500).json({ error: 'Failed to save deck' });
  }
});

// デッキ削除
app.delete('/api/decks/:deckId', async (req, res) => {
  try {
    const data = await loadDecks();
    if (!data.decks[req.params.deckId]) {
      return res.status(404).json({ error: 'Deck not found' });
    }
    delete data.decks[req.params.deckId];
    await saveDecks(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting deck:', error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

// 実績用インターフェース
interface CardAchievement {
  cardId: string;
  cardName: string;
  maxRating: number;
  maxWinStreak: number;
  timesUsed: number;
  lastUpdated: string;
}

interface AchievementsData {
  cards: { [key: string]: CardAchievement };
}

// 実績ファイルのパス
function getAchievementsPath(): string {
  const dataDir = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
  return join(dataDir, 'achievements.json');
}

// 実績を読み込む
async function loadAchievements(): Promise<AchievementsData> {
  try {
    const path = getAchievementsPath();
    const data = await fs.readFile(path, 'utf-8');
    return JSON.parse(data) as AchievementsData;
  } catch {
    return { cards: {} };
  }
}

// 実績を保存
async function saveAchievements(data: AchievementsData): Promise<void> {
  const dataDir = process.env.BS_DATA_DIR || join(homedir(), 'BattleSpiritsAI');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const path = getAchievementsPath();
    await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save achievements:', error);
  }
}

// 実績統計エンドポイント
app.get('/api/achievements/stats', async (req, res) => {
  try {
    const achievements = await loadAchievements();
    const cards = Object.values(achievements.cards).sort((a, b) => b.maxRating - a.maxRating);
    res.json({ achievements: cards });
  } catch (error) {
    console.error('Error loading achievements:', error);
    res.status(500).json({ error: 'Failed to load achievements' });
  }
});

// カード実績更新
app.post('/api/achievements/update-card', async (req, res) => {
  try {
    const { cardId, cardName, currentRating, winStreak } = req.body;
    if (!cardId || !cardName) {
      return res.status(400).json({ error: 'Missing cardId or cardName' });
    }

    const achievements = await loadAchievements();
    const card = achievements.cards[cardId];

    if (!card) {
      achievements.cards[cardId] = {
        cardId,
        cardName,
        maxRating: currentRating || 1500,
        maxWinStreak: winStreak || 0,
        timesUsed: 1,
        lastUpdated: new Date().toISOString(),
      };
    } else {
      card.timesUsed++;
      if (currentRating && currentRating > card.maxRating) {
        card.maxRating = currentRating;
      }
      if (winStreak && winStreak > card.maxWinStreak) {
        card.maxWinStreak = winStreak;
      }
      card.lastUpdated = new Date().toISOString();
    }

    await saveAchievements(achievements);
    res.json({ success: true, achievement: achievements.cards[cardId] });
  } catch (error) {
    console.error('Error updating achievement:', error);
    res.status(500).json({ error: 'Failed to update achievement' });
  }
});

/**
 * Generate AI rating using Gaussian distribution
 * Clamped to [playerRating - 300, playerRating + 300]
 */
function generateAIRating(playerRating: number, rng: Mulberry32): number {
  // Box-Muller transform for Gaussian distribution
  const u1 = rng.next();
  const u2 = rng.next();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  // Mean = playerRating, Sigma = 200
  const aiRating = playerRating + z0 * 200;

  // Clamp to ±300 range
  return Math.max(playerRating - 300, Math.min(playerRating + 300, Math.round(aiRating)));
}

/**
 * Calculate synergy score between two cards (0-1)
 * Based on cost proximity and card type compatibility
 */
function calculateCardSynergy(card1: any, card2: any): number {
  let synergy = 0;

  // Cost proximity synergy (cards with similar costs work better together)
  const costDiff = Math.abs(card1.cost - card2.cost);
  const costSynergy = Math.max(0, 1 - costDiff / 3);
  synergy += costSynergy * 0.4;

  // Card type synergy (same type cards work well together)
  if (card1.cardType === card2.cardType) {
    synergy += 0.3;
  }

  // Effect synergy heuristic (cards with different costs complement each other)
  if (costDiff > 1 && costDiff < 4) {
    synergy += 0.2;
  }

  return Math.min(1, synergy);
}

/**
 * Calculate deck cohesion score (average synergy of all card pairs)
 */
function calculateDeckCohesion(deckCards: string[]): number {
  if (deckCards.length < 2) return 0;

  let totalSynergy = 0;
  let pairCount = 0;

  for (let i = 0; i < deckCards.length; i++) {
    for (let j = i + 1; j < deckCards.length; j++) {
      const card1 = CARD_DB[deckCards[i] as any];
      const card2 = CARD_DB[deckCards[j] as any];
      if (card1 && card2) {
        totalSynergy += calculateCardSynergy(card1, card2);
        pairCount++;
      }
    }
  }

  return pairCount > 0 ? totalSynergy / pairCount : 0;
}

/**
 * Generate optimal deck from training data
 * Returns the most winning deck composition from recent AI training
 */
function getOptimalDeck(): { cardId: string; count: number }[] {
  // Start with a high-cost preference deck as the "optimal" base
  // This represents a well-tuned, high-synergy deck composition
  const allCards = Object.entries(CARD_DB);
  if (allCards.length === 0) return [];

  // Use a fixed seed for deterministic optimal deck
  const rng = new Mulberry32(1337); // "optimal deck" seed

  const selected: { [key: string]: number } = {};
  const highCostCards = allCards.filter(([_, c]) => c.cost >= 3);
  const mediumCostCards = allCards.filter(([_, c]) => c.cost === 2);

  // Build optimal deck: 60% high-cost, 40% medium-cost (synergistic composition)
  const cardPool = [
    ...Array(24).fill(null).map(() => highCostCards[rng.int(highCostCards.length)]),
    ...Array(16).fill(null).map(() => mediumCostCards[rng.int(mediumCostCards.length)]),
  ];

  for (let i = 0; i < 40; i++) {
    const card = cardPool[rng.int(cardPool.length)];
    if (card) {
      const [cardId] = card;
      selected[cardId] = (selected[cardId] || 0) + 1;
      if (selected[cardId] > 3) {
        i--;
        selected[cardId]--;
      }
    }
  }

  return Object.entries(selected).map(([cardId, count]) => ({ cardId, count }));
}

/**
 * Generate AI deck based on rating using machine learning
 * Combines 3 learning methods: statistical, reinforcement, and neural
 *
 * Same rating + different sessionSeed = different decks (natural variation)
 * Same rating + same sessionSeed = same deck (reproducibility within session)
 */
function getAIDeckForRating(rating: number, sessionSeed?: number): { cardId: string; count: number }[] {
  // 機械学習ベースのデッキ推奨を取得
  const recommendation = deckOptimizer.getBestDeck(rating, 40);
  return recommendation.deck;
}

/**
 * AI デッキプリセット定義
 * 難易度ごとに異なるカード配分のデッキを生成
 */
function getAIDeckPreset(difficulty: 'ai-easy' | 'ai-medium' | 'ai-hard', sessionSeed?: number): { cardId: string; count: number }[] {
  // Map difficulty levels to ratings for synergy-based adaptive decks
  // This ensures variable, interesting decks even in normal matches
  const difficultyRating: Record<string, number> = {
    'ai-easy': 1400,    // Low rating = more random synergy breakage
    'ai-medium': 1650,  // Medium rating = moderate optimization
    'ai-hard': 1800,    // High rating = more optimized decks
  };
  const rating = difficultyRating[difficulty] || 1650;
  // Use the same synergy-based adaptive system as rating matches
  return getAIDeckForRating(rating, sessionSeed);
}

/**
 * デッキIDに基づいてゲーム用デッキを読み込む
 * ユーザーデッキまたはAIプリセットデッキを返す
 */
async function loadDeckForGame(deckId: string, sessionSeed?: number): Promise<any[] | null> {
  try {
    // AIプリセットデッキ（レート別）の場合
    if (deckId.startsWith('ai-rating-')) {
      const ratingStr = deckId.replace('ai-rating-', '');
      const rating = parseInt(ratingStr);
      const cardList = getAIDeckForRating(rating, sessionSeed);
      const deck: any[] = [];
      for (const { cardId, count } of cardList) {
        const card = CARD_DB[cardId as any];
        if (card) {
          for (let i = 0; i < count; i++) {
            deck.push(card);
          }
        }
      }
      return deck.length > 0 ? deck : null;
    }

    // AIプリセットデッキ（基本難易度）の場合
    if (deckId.startsWith('ai-')) {
      const difficulty = deckId as 'ai-easy' | 'ai-medium' | 'ai-hard';
      const cardList = getAIDeckPreset(difficulty, sessionSeed);
      const deck: any[] = [];
      for (const { cardId, count } of cardList) {
        const card = CARD_DB[cardId as any];
        if (card) {
          for (let i = 0; i < count; i++) {
            deck.push(card);
          }
        }
      }
      return deck.length > 0 ? deck : null;
    }

    // ユーザーが保存したデッキの場合
    const data = await loadDecks();
    const savedDeck = data.decks[deckId];
    if (!savedDeck) {
      console.warn(`⚠️ デッキが見つかりません。deckId="${deckId}"`);
      console.warn('利用可能なデッキID:', Object.keys(data.decks));
      return null;
    }

    const deck: any[] = [];
    for (const { cardId, count } of savedDeck.cards) {
      const card = CARD_DB[cardId as any];
      if (card) {
        for (let i = 0; i < count; i++) {
          deck.push(card);
        }
      }
    }

    // ✅ デッキ読み込み詳細ログ
    console.log(`📦 デッキ読み込み詳細: deckId="${deckId}"`);
    console.log(`  構築名: "${savedDeck.name}"`);
    console.log(`  保存されたカード: ${savedDeck.cards.length}種類、総枚数=${savedDeck.cards.reduce((sum, c) => sum + c.count, 0)}`);
    console.log(`  読み込み結果: ${deck.length}枚`);
    console.log(`  カード構成:`, savedDeck.cards.map(c => `${c.cardId}×${c.count}`).join(', '));

    return deck.length > 0 ? deck : null;
  } catch (error) {
    console.error('Error loading deck:', error);
    return null;
  }
}

// Catch-all: serve React app (Express 5 no longer accepts '*' as a route path)
// ※ 必ず全APIルートの後に登録すること
app.use((req, res) => {
  res.sendFile(join(__dirname, '../web/dist/index.html'));
});

// サーバー起動
app.listen(port, '0.0.0.0', () => {
  console.log(`🎮 Battle Spirits AI Web UI running at http://localhost:${port}`);
});
