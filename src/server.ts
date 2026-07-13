import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

/**
 * Get training statistics
 */
app.get('/api/training/stats', async (req, res) => {
  try {
    const statsPath = join(__dirname, '../data/training-stats.json');
    const data = await fs.readFile(statsPath, 'utf-8');
    const stats = JSON.parse(data);
    res.json(stats);
  } catch (error) {
    // File doesn't exist or is invalid; return empty stats
    res.json({ sessions: [] });
  }
});

/**
 * Save training statistics
 */
app.post('/api/training/stats', async (req, res) => {
  try {
    const statsPath = join(__dirname, '../data/training-stats.json');

    // Ensure data directory exists
    const dataDir = dirname(statsPath);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
      // Directory might already exist
    }

    // Get existing stats or create new
    let allStats: any = { sessions: [] };
    try {
      const existing = await fs.readFile(statsPath, 'utf-8');
      allStats = JSON.parse(existing);
    } catch (err) {
      // File doesn't exist, use empty stats
    }

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

    // Write back to file
    await fs.writeFile(statsPath, JSON.stringify(allStats, null, 2), 'utf-8');
    res.json({ success: true, stats: allStats });
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
