# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

```bash
npm run typecheck          # TypeScript check (must pass before commits)
npm run test              # Run all tests (~5 seconds)
npm run test:watch        # Watch mode for iterative testing
npm run play -- --help    # CLI demo of MiniTCG (see ./README.md for examples)
npm run web:dev           # Launch dev server (web UI) on localhost:5173
npm run web               # Production build + run server
npm start                 # Launcher for choosing between play/web modes
```

No build step needed; TSC is run on demand via `tsx`.

## Artifact Update Convention

**When implementing new card effects or game mechanics**, update the card effects HTML artifact at:
https://claude.ai/code/artifact/20793465-cae5-43ad-be0b-1d0aacea097a

This keeps the documentation in sync with the codebase. The artifact should always reflect:
- Implementation status (✅ = fully implemented, ⚠️ = partial, ❌ = not implemented)
- Card mechanics and trigger types
- System feature completeness (e.g., "真界放 skill: 5/5 complete")

## Architecture: Game-Agnostic Engine + Battle Spirits

### Core Layers

This is a **two-layer architecture**:

1. **Game-Agnostic Core** (`src/core/`, `src/ai/`)
   - `Game<S, A>` interface: the contract every game must satisfy
   - `Rng`: reproducible pseudo-random source
   - `Match<S, A>`: generic self-play harness for any two agents
   - `ISMCTS`: Information Set Monte Carlo Tree Search (handles imperfect information)
   - Agents: `RandomAgent`, `ISMCTS`, etc.
   - The AI knows nothing about cards, mana, spirits, or any game rules.

2. **Battle Spirits Implementation** (`src/games/battlspirits/`)
   - **Types** (`types.ts`): `GameState`, `PlayerState`, `Spirit`, `CardEffect`, `CardDef`
   - **Cards** (`cards.ts`): Card database (JSON-like) — 16 starter deck cards fully defined
   - **Effects** (`effects.ts`): Effect engine — processes `CardEffect` from card metadata
   - **Game** (`game.ts`): Implements `Game<GameState, Action>` interface
   - **Web UI** (`web/src/`): React components for gameplay, deck building, rating system

### Battle Spirits: Data-Driven Effects

All card effects are **100% data-driven** via the `CardEffect` interface:

```typescript
interface CardEffect {
  trigger: 'summon' | 'attack' | 'destroy' | 'immediate' | ...  // When it fires
  action: 'damage' | 'draw' | 'destroy_creature' | ...           // What it does
  value?: number;           // Damage amount, draw count, etc.
  target?: 'opponent_hero' | 'opponent_creature';
  condition?: { ... };      // Requirements (hand size, symbols, nexus, etc.)
  skill?: '真界放' | '継召' | 'ソウルマジック：赤';  // Skill keyword
  // ... 15 more optional fields for targeting, multi-target, level restrictions
}
```

**Key insight**: To add a new card or modify an effect, edit only `cards.ts`. The effect engine (`effects.ts`) and game logic (`game.ts`) remain generic. This is why the codebase scales without explosion.

### Game Flow

Battle Spirits follows a strict **phase sequence per turn**:
```
Start → Core → Draw → Refresh → Main → Attack → Main2 → End → [next player]
```

Only `Main`, `Attack`, and `Main2` allow player actions. The others auto-transition.

### Spirit Leveling

Spirits have two levels (Lv1, Lv2) with separate stats:
- Lv1: cost/BP always present
- Lv2: requires enough cores (regular or soul) to level up

**Special case**: 真界放 skill allows leveling with soul cores only (implemented in `effects.ts:updateSpiritLevel`).

### Key State Mutations

The game uses **immutable state** across the AI boundary:
- `applyAction(state, action)` must return a new `GameState`, never mutate the input.
- Helper functions like `cloneState`, `clonePlayerState` ensure deep clones.
- State cloning preserves: `damageThisTurn`, `trashCores`, `spirit.bpBoost`, etc.

**Staleness gotcha**: When effects chain (e.g., destroy triggers another effect), spirit references can become stale if you hold onto a pointer across a state clone. Always re-fetch via index: `state.players[p].spirits[idx]`.

## Battle Spirits Rules Details

### Resource System

- **Life**: 20 starting HP
- **Cores**: Regular cores (リザーブ/reserve) + Soul cores (ソウルコア)
- **Trash**: Destroyed cards go here; cores sent to trash at refresh return to reserve
- **Nexus damage**: Each symbol dealt counts as 1 core gained (Battle Spirits unique mechanic)

### Imperfect Information

Hands and deck order are hidden from the opponent:
- `determinize(state, observer)` samples a plausible hidden state the observer *cannot* distinguish from the true state
- Used by ISMCTS to reason about moves despite hidden info

### Flash Timing (Interrupts)

Opponent can react with flash magic during certain events:
- `PendingFlash` state tracks the interrupt window
- Players alternate flashes until one passes
- Stashed attack prevents losing the attack state through multiple flashes

### Inheritance (Reduction Cost)

- Cards with `inheritance: true` can use EX symbol cards from trash to reduce cost
- When inheritance is actually used (cost *would* be higher without it), the EX card is removed from trash
- Detected by comparing cost with and without the inheritance flag

### Soul Magic Red (ソウルマジック：赤)

- Requires red symbol in field + soul core payment
- フレイムハリケーン: BP 7000 threshold, but 10000 if player took damage this turn
- Damage tracking: `player.damageThisTurn` incremented when opponent deals damage, reset at turn start

## Implementing New Cards

1. **Add to `cards.ts`**: Define `CardDef` with `effects` array
2. **Test in `game.ts`**: Ensure new effect actions/triggers are handled in `applyEffect` and `triggerEffects`
3. **Update artifact**: Reflect new implementation status
4. **Run tests**: `npm run test` must pass
5. **TypeScript check**: `npm run typecheck` must pass

Common effect actions: `damage`, `draw`, `heal`, `boost_bp`, `destroy_creature`, `search_deck`, `trash_to_hand`, `place_core`, `discard_hand`, `destroy_nexus`.

## Web UI and Server

- **`server.ts`**: Express backend. Handles `/play` (new game), `/action` (apply action), deck loading
- **`web/src/App.tsx`**: React root; routes between HomeScreen → GameSetup → GameBoard
- **`GameBoard.tsx`**: Main gameplay UI; drag-drop cards, core payment, target selection
- **Deck generation**: Rating-based AI uses synergy degradation; normal difficulty also mapped to ratings (Easy→1400, Medium→1650, Hard→1800)

## Testing

- `test/battlspirits.test.ts`: 6 unit tests for game logic
- `test/minitcg.test.ts`: 9 tests for MiniTCG + ISMCTS sanity check

All tests must pass. No coverage gaps for implemented features.

## Git Workflow

- Branch: `claude/universal-tcg-battle-ai-g3vlf1` (feature branch for Phase 1 implementation)
- **PR #1**: Main tracking PR for Battle Spirits Phase 1
- Commits: One per logical change; include what was fixed/added in the message
- No CI configured yet; manual testing suffices (tests + typecheck)

## Notes for Future Work

- **ライフが減った condition**: Already implemented for Soul Magic red (2026-07-14)
- **Adaptive deck construction**: Unified for normal + rated matches (2026-07-14)
- **Phase 2 (not started)**: Browser multiplayer, replay system, more card sets
