import type { Game, Rng } from './game.js';
import type { Agent } from '../ai/agent.js';

export interface MatchOptions {
  /** Print each action and the resulting state. */
  verbose?: boolean;
  /** Hard cap on total actions, as a safety net against infinite games. */
  maxActions?: number;
  /** Optional renderer for verbose mode. */
  render?: (state: unknown) => string;
}

export interface MatchResult<S> {
  winner: number | null;
  finalState: S;
  actionCount: number;
}

/**
 * Play a single game to completion. Game-agnostic: it wires a `Game` to one
 * `Agent` per player and steps until terminal.
 */
export function playMatch<S, A>(
  game: Game<S, A>,
  initialState: S,
  agents: Agent<S, A>[],
  rng: Rng,
  opts: MatchOptions = {},
): MatchResult<S> {
  let state = initialState;
  let actionCount = 0;
  const maxActions = opts.maxActions ?? 100_000;

  while (!game.isTerminal(state) && actionCount < maxActions) {
    const player = game.currentPlayer(state);
    const agent = agents[player]!;
    const action = agent.chooseAction(game, state, rng);

    if (opts.verbose) {
      console.log(`\n[P${player} · ${agent.name}] ${game.describeAction(state, action)}`);
    }

    state = game.applyAction(state, action, rng);
    actionCount++;

    if (opts.verbose && opts.render) {
      console.log(opts.render(state));
    }
  }

  const winner = game.isTerminal(state)
    ? (game.reward(state, 0) === 1 ? 0 : game.reward(state, 1) === 1 ? 1 : null)
    : null;

  return { winner, finalState: state, actionCount };
}
