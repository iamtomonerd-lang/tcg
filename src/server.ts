import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { promises as fs } from 'fs';
import { BattlSpiritsGame } from './games/battlspirits/game.js';
import { CARD_DB } from './games/battlspirits/cards.js';
import type { GameState, Action } from './games/battlspirits/types.js';
import { Mulberry32 } from './core/rng.js';
import { IsmctsAgent } from './ai/ismcts.js';

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
}

const sessions = new Map<string, GameSession>();

/**
 * Create a new game session
 */
app.post('/api/game/new', (req, res) => {
  const { p0Type, p1Type, p0Iters, p1Iters } = req.body;

  const sessionId = Math.random().toString(36).substring(7);
  const rng = new Mulberry32(Date.now() & 0xffffffff);
  const game = new BattlSpiritsGame();
  const state = game.createInitialState(rng);

  const playerTypes: [string, string] = [p0Type || 'human', p1Type || 'mcts'];

  // Create AI agents ('human' players have no agent)
  const p0Agent = createAgent(playerTypes[0], p0Iters || 100, rng);
  const p1Agent = createAgent(playerTypes[1], p1Iters || 100, rng);

  sessions.set(sessionId, {
    game,
    state,
    rng,
    p0Agent,
    p1Agent,
    playerTypes,
  });

  res.json({
    sessionId,
    state: serializeState(state),
    playerTypes,
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

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
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
  session.state = session.game.applyAction(session.state, action, session.rng);

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
    currentPlayer: session.game.currentPlayer(session.state),
    actionDescription: `P${actingPlayer}: ${description}`,
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

  const currentPlayer = session.game.currentPlayer(session.state);
  const agent = currentPlayer === 0 ? session.p0Agent : session.p1Agent;

  if (!agent) {
    return res.status(400).json({ error: 'Current player is human; use /action instead' });
  }

  // Get best action from AI (describe BEFORE applying — indices refer to the pre-action state)
  const action = agent.chooseAction(session.game, session.state, session.rng);
  const description = session.game.describeAction(session.state, action);
  session.state = session.game.applyAction(session.state, action, session.rng);

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
    currentPlayer: session.game.currentPlayer(session.state),
    actionDescription: `P${currentPlayer}: ${description}`,
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

// Catch-all: serve React app (Express 5 no longer accepts '*' as a route path)
app.use((req, res) => {
  res.sendFile(join(__dirname, '../web/dist/index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🎮 Battle Spirits AI Web UI running at http://localhost:${port}`);
});

// Helper functions

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
        bp: (s.level === 1 ? s.def.lv1 : s.def.lv2 || s.def.lv1).bp + (s.bpBoost ?? 0),
      })),
      nexuses: p.nexuses.map((n) => ({
        id: n.def.id,
        name: n.def.name,
        level: n.level,
        coreCount: n.coreCount,
        soulCoreCount: n.soulCoreCount || 0,
        coresForLv2: n.def.lv2 ? n.def.lv2.cost : null,
        imagePath: n.def.imagePath,
      })),
      trash: {
        count: p.trash.length,
        hasEXSymbol: p.trash.some((c) => c.exSymbol),
      },
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

// サーバー起動
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
