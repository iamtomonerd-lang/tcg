# Universal TCG AI

A **game-agnostic engine and AI that can play any turn-based card game (TCG).**

The core idea: the AI knows nothing about any particular game. It only sees a
small abstract interface — states, legal actions, apply-action, terminal
reward, and a way to *guess hidden cards*. Implement that interface for a game
and the same AI plays it. A sample game, **MiniTCG**, ships as a working
demo you can watch the AI play from the command line.

```
┌─────────────┐        Game<S,A> interface        ┌──────────────────┐
│  AI agents  │  ──────────────────────────────▶  │  any TCG's rules │
│ (ISMCTS,    │   currentPlayer / legalActions /   │  (MiniTCG here)  │
│  Random)    │   applyAction / reward /           │                  │
│             │   determinize (hidden info)        │                  │
└─────────────┘                                    └──────────────────┘
```

## Quick start

```bash
npm install
npm test                                   # rules + AI sanity checks
npm run play -- --p0 mcts --p1 random --games 20   # watch the AI win
npm run play -- --p0 mcts --p1 mcts --iters 2000 --verbose --games 1
```

`--help` lists every flag.

## Why it works for *any* TCG

TCGs have **hidden information** (you can't see the opponent's hand or the
order of either deck), so a plain tree search that assumes perfect information
is wrong. This project uses **ISMCTS** (Information Set Monte Carlo Tree
Search): on every search iteration it calls `game.determinize(...)` to sample
one plausible arrangement of the hidden cards, then searches that concrete
world. The tree is shared across iterations and indexed by action sequences,
so the search reasons about *information sets* rather than exact states.

That means the only game-specific thing the AI needs is:

- what the legal moves are,
- what a move does,
- who won,
- and how to shuffle the cards it isn't allowed to see.

Everything else — the search, the self-play harness, the CLI — is generic.

## Layout

| Path | What it is |
| --- | --- |
| `src/core/game.ts` | The `Game<S, A>` interface every game implements |
| `src/core/rng.ts` | Seedable, reproducible RNG |
| `src/core/match.ts` | Generic self-play harness |
| `src/ai/ismcts.ts` | The main AI (Information Set MCTS) |
| `src/ai/randomAgent.ts` | Random baseline |
| `src/games/minitcg/` | Sample game: cards (data), rules engine, renderer |
| `src/cli.ts` | Command-line demo |
| `test/` | Rules + AI tests |

## Adding your own TCG

Implement `Game<YourState, YourAction>` (see `src/games/minitcg/game.ts` as a
worked example), point the CLI at it, and every agent can already play it. The
one part worth care is `determinize`: return a copy of the state where each
zone hidden from the observer is re-randomized, and everything the observer can
see is left untouched.

## Status

First milestone: **core engine + one sample TCG + AI self-play (CLI)**. The
ISMCTS agent wins ~100% against the random baseline on MiniTCG. Natural next
steps: a stronger rollout policy, a rules DSL so games are pure data, and a
browser UI for human-vs-AI play.
