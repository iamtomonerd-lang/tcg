import type { Game, Rng } from '../core/game.js';

/**
 * An agent picks one action for the current player of a state. Every agent is
 * game-agnostic: it is handed the `Game` interface and works for any game.
 */
export interface Agent<S, A> {
  readonly name: string;
  chooseAction(game: Game<S, A>, state: S, rng: Rng): A;
}
