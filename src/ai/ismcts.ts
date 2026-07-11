import type { Game, Rng } from '../core/game.js';
import type { Agent } from './agent.js';

/**
 * Information Set Monte Carlo Tree Search (single-observer ISMCTS),
 * after Cowling, Powley & Whitehouse (2012).
 *
 * Plain MCTS assumes it can see the whole state, which is false for card games
 * with hidden hands and shuffled decks. ISMCTS handles this by re-sampling the
 * hidden information (`game.determinize`) at the start of every iteration: the
 * search tree is shared across iterations and indexed by *action sequences*
 * (information sets), while each iteration explores one concrete world.
 *
 * Because different determinizations make different actions legal, a node only
 * ever considers the children that are legal in the current sampled world, and
 * uses each child's "availability" count (how often it was selectable) as the
 * exploration denominator instead of the parent's visit count.
 */

export interface IsmctsOptions {
  /** Search iterations per move. More = stronger and slower. */
  iterations?: number;
  /** UCB1 exploration constant. sqrt(2) is the textbook default. */
  explorationC?: number;
  /** Safety cap on rollout length, in actions, to avoid pathological loops. */
  maxRolloutDepth?: number;
}

class Node<A> {
  visits = 0;
  totalReward = 0;
  /** How many times this node was available to be selected. */
  availability = 0;
  readonly children = new Map<string, Node<A>>();
  /** The action objects behind each child key (kept for return + expansion). */
  readonly childActions = new Map<string, A>();

  constructor(
    /** Player who *chose* the action leading into this node. Rewards for this
     *  node are always measured from this player's perspective. */
    readonly mover: number,
  ) {}
}

export class IsmctsAgent<S, A> implements Agent<S, A> {
  readonly name: string;
  private readonly iterations: number;
  private readonly c: number;
  private readonly maxRolloutDepth: number;

  constructor(opts: IsmctsOptions = {}) {
    this.iterations = opts.iterations ?? 1000;
    this.c = opts.explorationC ?? Math.SQRT2;
    this.maxRolloutDepth = opts.maxRolloutDepth ?? 1000;
    this.name = `ISMCTS(${this.iterations})`;
  }

  chooseAction(game: Game<S, A>, rootState: S, rng: Rng): A {
    const rootPlayer = game.currentPlayer(rootState);
    const root = new Node<A>(-1);

    for (let i = 0; i < this.iterations; i++) {
      // 1. Determinize: sample a concrete world consistent with what the
      //    player to move can actually see.
      let state = game.determinize(rootState, rootPlayer, rng);
      const path: Node<A>[] = [root];
      let node = root;

      // 2. Selection + expansion.
      while (!game.isTerminal(state)) {
        const legal = game.legalActions(state);
        const legalKeys = legal.map((a) => game.actionKey(a));

        // Untried actions in this determinization?
        const untried: number[] = [];
        for (let k = 0; k < legal.length; k++) {
          if (!node.children.has(legalKeys[k]!)) untried.push(k);
        }

        if (untried.length > 0) {
          // Expand one new child.
          const idx = untried[rng.int(untried.length)]!;
          const action = legal[idx]!;
          const key = legalKeys[idx]!;
          const mover = game.currentPlayer(state);
          state = game.applyAction(state, action, rng);
          const child = new Node<A>(mover);
          node.children.set(key, child);
          node.childActions.set(key, action);
          path.push(child);
          node = child;
          break; // move on to simulation
        }

        // Otherwise all legal actions are in the tree: UCB-select among them.
        const selectedKey = this.selectUcb(node, legalKeys);
        const action = node.childActions.get(selectedKey)!;
        state = game.applyAction(state, action, rng);
        node = node.children.get(selectedKey)!;
        path.push(node);
      }

      // 3. Simulation (random rollout to a terminal state).
      let depth = 0;
      while (!game.isTerminal(state) && depth < this.maxRolloutDepth) {
        const legal = game.legalActions(state);
        state = game.applyAction(state, rng.pick(legal), rng);
        depth++;
      }

      // 4. Backpropagation. Each node's reward is from its mover's viewpoint.
      for (const n of path) {
        if (n === root) continue;
        n.visits++;
        n.totalReward += game.reward(state, n.mover);
      }
    }

    // Pick the most-visited action that is legal in the *real* root state
    // (robust child). Fall back to a random legal action if the tree is empty.
    const legal = game.legalActions(rootState);
    let best: A | undefined;
    let bestVisits = -1;
    for (const action of legal) {
      const key = game.actionKey(action);
      const child = root.children.get(key);
      const visits = child ? child.visits : 0;
      if (visits > bestVisits) {
        bestVisits = visits;
        best = action;
      }
    }
    return best ?? rng.pick(legal);
  }

  /** UCB1 selection restricted to the actions legal in the current world. */
  private selectUcb(node: Node<A>, legalKeys: string[]): string {
    let bestKey = legalKeys[0]!;
    let bestValue = -Infinity;
    for (const key of legalKeys) {
      const child = node.children.get(key)!;
      child.availability++;
      const exploit = child.totalReward / child.visits;
      const explore = this.c * Math.sqrt(Math.log(child.availability) / child.visits);
      const value = exploit + explore;
      if (value > bestValue) {
        bestValue = value;
        bestKey = key;
      }
    }
    return bestKey;
  }
}
