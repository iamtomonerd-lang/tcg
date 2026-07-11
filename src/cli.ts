/**
 * CLI entry point: pit agents against each other on MiniTCG.
 *
 * Usage:
 *   npm run play -- [options]
 *
 * Options:
 *   --p0 <agent>       Agent for player 0: random | mcts   (default: mcts)
 *   --p1 <agent>       Agent for player 1: random | mcts   (default: random)
 *   --iters <n>        ISMCTS iterations per move          (default: 1000)
 *   --games <n>        Number of games to play             (default: 20)
 *   --seed <n>         Base RNG seed                        (default: 1)
 *   --verbose          Print a full move-by-move trace of the first game
 *
 * Examples:
 *   npm run play -- --p0 mcts --p1 random --games 50
 *   npm run play -- --p0 mcts --p1 mcts --iters 2000 --verbose --games 1
 */
import { Mulberry32 } from './core/rng.js';
import { playMatch } from './core/match.js';
import type { Agent } from './ai/agent.js';
import { RandomAgent } from './ai/randomAgent.js';
import { IsmctsAgent } from './ai/ismcts.js';
import { MiniTcg } from './games/minitcg/game.js';
import { renderState } from './games/minitcg/render.js';
import type { MiniAction, MiniState } from './games/minitcg/state.js';

interface Args {
  p0: string;
  p1: string;
  iters: number;
  games: number;
  seed: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { p0: 'mcts', p1: 'random', iters: 1000, games: 20, seed: 1, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--p0': args.p0 = argv[++i]!; break;
      case '--p1': args.p1 = argv[++i]!; break;
      case '--iters': args.iters = Number(argv[++i]); break;
      case '--games': args.games = Number(argv[++i]); break;
      case '--seed': args.seed = Number(argv[++i]); break;
      case '--verbose': args.verbose = true; break;
      case '--help': case '-h': printHelpAndExit(); break;
      default: console.error(`Unknown option: ${a}`); printHelpAndExit(1);
    }
  }
  return args;
}

function printHelpAndExit(code = 0): never {
  console.log(`Universal TCG AI — MiniTCG demo

Usage: npm run play -- [options]
  --p0 <random|mcts>   agent for player 0   (default: mcts)
  --p1 <random|mcts>   agent for player 1   (default: random)
  --iters <n>          ISMCTS iterations    (default: 1000)
  --games <n>          games to play        (default: 20)
  --seed <n>           base RNG seed        (default: 1)
  --verbose            trace the first game move-by-move`);
  process.exit(code);
}

function makeAgent(kind: string, iters: number): Agent<MiniState, MiniAction> {
  switch (kind) {
    case 'random': return new RandomAgent<MiniState, MiniAction>();
    case 'mcts': return new IsmctsAgent<MiniState, MiniAction>({ iterations: iters });
    default:
      console.error(`Unknown agent: ${kind} (use "random" or "mcts")`);
      return process.exit(1);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const game = new MiniTcg();
  const agents = [makeAgent(args.p0, args.iters), makeAgent(args.p1, args.iters)];

  console.log(`MiniTCG  |  P0=${agents[0]!.name}  vs  P1=${agents[1]!.name}  |  ${args.games} game(s)\n`);

  const wins = [0, 0];
  let draws = 0;

  for (let g = 0; g < args.games; g++) {
    // Fresh, independent RNG stream per game (reproducible from the base seed).
    const rng = new Mulberry32(args.seed + g * 7919);
    const initial = game.createInitialState(rng);
    const verbose = args.verbose && g === 0;

    if (verbose) {
      console.log('=== Game 1 trace ===');
      console.log(renderState(initial));
    }

    const result = playMatch(game, initial, agents, rng, {
      verbose,
      render: (s) => renderState(s as MiniState),
    });

    if (result.winner === null) draws++;
    else wins[result.winner]!++;

    if (!verbose) {
      const label = result.winner === null ? 'draw' : `P${result.winner} wins`;
      process.stdout.write(`game ${String(g + 1).padStart(3)}: ${label} (${result.actionCount} actions)\n`);
    }
  }

  const total = args.games;
  console.log('\n=== Results ===');
  console.log(`P0 (${agents[0]!.name}): ${wins[0]} wins  (${((100 * wins[0]!) / total).toFixed(1)}%)`);
  console.log(`P1 (${agents[1]!.name}): ${wins[1]} wins  (${((100 * wins[1]!) / total).toFixed(1)}%)`);
  console.log(`Draws: ${draws}`);
}

main();
