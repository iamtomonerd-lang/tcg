/**
 * Core, game-agnostic abstraction.
 *
 * The AI never knows what game it is playing. It only sees a `Game<S, A>`:
 * a state type `S`, an action type `A`, and the handful of pure functions
 * below. Implement this interface for any turn-based game (TCG, board game,
 * ...) and every agent in `src/ai` can play it.
 *
 * Imperfect information (hidden hands / shuffled decks) is handled through
 * `determinize`: given a state and the point of view of one player, it returns
 * a concrete "guess" of the hidden information that is consistent with what
 * that player can see. Determinization is what lets a plain tree search cope
 * with cards it cannot see (see `src/ai/ismcts.ts`).
 */

/** A pseudo-random source so that games and search are reproducible. */
export interface Rng {
  /** float in [0, 1). */
  next(): number;
  /** integer in [0, n). */
  int(n: number): number;
  /** In-place Fisher-Yates shuffle. Returns the same array for chaining. */
  shuffle<T>(arr: T[]): T[];
  /** Uniformly pick one element. Throws on empty input. */
  pick<T>(arr: readonly T[]): T;
}

export interface Game<S, A> {
  /** Number of players. Players are identified by index 0..playerCount-1. */
  readonly playerCount: number;

  /** The player whose turn it is to choose an action in `state`. */
  currentPlayer(state: S): number;

  /**
   * All actions the current player may legally take in `state`.
   * Must be empty iff `isTerminal(state)` is true.
   */
  legalActions(state: S): A[];

  /**
   * Apply `action` and return the resulting state. Implementations should
   * treat `state` as immutable and return a fresh value; the search relies on
   * being able to keep old states around.
   */
  applyAction(state: S, action: A, rng: Rng): S;

  /** True when the game is over and no further actions are possible. */
  isTerminal(state: S): boolean;

  /**
   * Reward for `player` in a terminal `state`, in [0, 1]:
   * 1 = win, 0 = loss, 0.5 = draw. Only meaningful when terminal.
   */
  reward(state: S, player: number): number;

  /**
   * Return a copy of `state` in which every zone hidden from `observer`
   * (other players' hands, face-down decks, ...) is re-randomized into a
   * plausible arrangement, while everything `observer` can see is preserved.
   *
   * For perfect-information games this can just return a clone.
   */
  determinize(state: S, observer: number, rng: Rng): S;

  /** Stable string key for an action, used to index the search tree. */
  actionKey(action: A): string;

  /** Human-readable one-line description of an action (for logs/CLI). */
  describeAction(state: S, action: A): string;
}
