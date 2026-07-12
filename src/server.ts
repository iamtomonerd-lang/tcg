import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

interface GameSession {
  game: BattlSpiritsGame;
  state: GameState;
  rng: Mulberry32;
  p0Agent: any;
  p1Agent: any;
}

const sessions = new Map<string, GameSession>();

/**
 * Create a new game session
 */
app.post('/api/game/new', (req, res) => {
  const { p0Type, p1Type, p0Iters, p1Iters } = req.body;

  const sessionId = Math.random().toString(36).substring(7);
  const rng = new Mulberry32(42);
  const game = new BattlSpiritsGame();
  const state = game.createInitialState(rng);

  // Create AI agents
  const p0Agent = createAgent(p0Type, p0Iters || 100, rng);
  const p1Agent = createAgent(p1Type, p1Iters || 100, rng);

  sessions.set(sessionId, {
    game,
    state,
    rng,
    p0Agent,
    p1Agent,
  });

  res.json({
    sessionId,
    state: serializeState(state),
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
 * Play an action
 */
app.post('/api/game/:sessionId/action', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { actionIndex } = req.body;
  const actions = session.game.legalActions(session.state);
  const action = actions[actionIndex];

  if (!action) {
    return res.status(400).json({ error: 'Invalid action index' });
  }

  session.state = session.game.applyAction(session.state, action, session.rng);

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
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

  // Get best action from AI
  const action = await agent.selectAction(session.state, session.game, session.rng);
  session.state = session.game.applyAction(session.state, action, session.rng);

  res.json({
    state: serializeState(session.state),
    isTerminal: session.game.isTerminal(session.state),
    actionDescription: session.game.describeAction(session.state, action),
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
    case 'mcts':
      return new IsmctsAgent({ iterations: iters });
    case 'random':
    default:
      return {
        selectAction: async (state: GameState, game: BattlSpiritsGame, rng: Mulberry32) => {
          const actions = game.legalActions(state);
          return actions[rng.int(actions.length)];
        },
      };
  }
}

function serializeState(state: GameState) {
  return {
    players: state.players.map((p) => ({
      life: p.life,
      cores: p.cores,
      handSize: p.hand.length,
      handCards: p.hand.map((c) => ({
        id: c.id,
        name: c.name,
        cost: c.cost,
        imagePath: c.imagePath,
      })),
      deck: { count: p.deck.length },
      spirits: p.spirits.map((s) => ({
        id: s.def.id,
        name: s.def.name,
        level: s.level,
        coreCount: s.coreCount,
        canAttack: s.canAttack,
        imagePath: s.def.imagePath,
        bp: (s.level === 1 ? s.def.lv1 : s.def.lv2 || s.def.lv1).bp + (s.bpBoost ?? 0),
      })),
      nexuses: p.nexuses.map((n) => ({
        id: n.def.id,
        name: n.def.name,
        level: n.level,
        imagePath: n.def.imagePath,
      })),
      trash: { count: p.trash.length },
    })),
    currentPlayer: state.currentPlayer,
    turnCount: state.turnCount,
    result: state.result,
  };
}
