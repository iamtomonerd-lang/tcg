import type { Game, Rng } from '../core/game.js';
import type { Agent } from './agent.js';

/** Baseline agent: pick a uniformly random legal action. */
export class RandomAgent<S, A> implements Agent<S, A> {
  readonly name = 'Random';

  chooseAction(game: Game<S, A>, state: S, rng: Rng): A {
    const actions = game.legalActions(state);
    return rng.pick(actions);
  }
}
