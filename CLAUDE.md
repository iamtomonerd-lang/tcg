# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

```bash
npm run typecheck          # TypeScript check (must pass before commits)
npm run test              # Run all tests (~5 seconds)
npm run test:watch        # Watch mode for iterative testing
npm run play -- --help    # CLI demo of MiniTCG (see ./README.md for examples)
npm run web:dev           # Launch dev server (web UI) on localhost:5173
npm run web:server        # API server (tsx watch: auto-restarts on engine changes; run alongside web:dev)
npm run web               # Production build + run server
npm start                 # Launcher for choosing between play/web modes
```

No build step needed; TSC is run on demand via `tsx`.

## API Server Freshness Protocol (MANDATORY after game-logic changes)

Vite (`web:dev`) hot-reloads ONLY the frontend. The API server process serves
whatever engine code it loaded at boot — a stale process silently produces
"works in tests but not in browser" symptoms. After changing game logic
(`game.ts`, `effects.ts`, `cards.ts`, `types.ts`, `server.ts`), ALWAYS include
these steps in any investigation or verification:

1. **Check the running server is fresh**: `curl -s localhost:3000/api/health`
   → `startedAt` must be later than your last edit; note the `pid`.
2. **Restart if stale**: prefer `npm run web:server` (tsx watch, auto-restarts
   on engine changes) over plain `tsx src/server.ts`.
3. **Confirm the PID**: the pid from `/api/health` must match the process you
   just started.
4. **Hunt orphan processes**: `pgrep -fl "src/server.ts"` (careful: the pattern
   matches your own shell — check PIDs, don't blind-`pkill`). Multiple servers
   fighting over port 3000 mask each other.

For significant logic changes, "fixed in code" is NOT verified. Confirm over
real HTTP that a fresh session serves the new behavior (e.g. `/api/game/new` →
drive to the relevant state → assert `/api/game/:id/actions` contains the new
action). Restarting wipes in-memory sessions, so always start a NEW game after
a restart — an old browser tab's session is gone.

## UI State-Sync Rules (MANDATORY when adding card effects or game states)

A state that exists only server-side is invisible to players. Every
player-relevant state must survive the FULL data path:

```
GameState (types.ts)
  → cloneState (game.ts — a field missing here silently vanishes in AI search)
  → serializeState() (src/server.ts)
  → API response
  → React component reads the field (web/src/components/)
  → className / CSS visual change
```

Past real bugs, one per layer: `nexus.exhausted` was serialized but no
component read it (invisible exhaustion); `pendingAttack.attackerSpiritIndex`
is read by GameBoard but was never serialized (attacker highlight dead);
`stashedAttack` inside pendingFlash is not serialized, so the attack banner
vanishes during flash windows even though a battle is in progress.

### カード効果追加時チェック

- [ ] **内部状態**: `applyAction`/`effects.ts` が状態を正しく変更するか。
      新フィールドは `cloneState`/`clonePlayerState` にも追加したか
- [ ] **API送信**: `serializeState()` が送るか。逆に、相手の非公開情報
      （手札内容など）を送りすぎていないかも確認
- [ ] **UI参照**: `grep -r "<fieldName>" web/src` が 0 件なら未実装。
      表示パターンはスピリット疲労 (`spirit-fatigued`) / ネクサス疲労
      (`nexus-exhausted`) を踏襲する
- [ ] **視覚変化**: プレイヤーが見て分かるか（回転・ハイライト・バッジ等）。
      `npm run web:build` が通り、dist にクラス/CSS が含まれるか
- [ ] **解除時**: 効果終了（バトル終了・ターン終了・リフレッシュ）で
      表示も内部状態と同時に戻るか
- [ ] **pending 系**: 新しい pending を追加したら serializeState と UI の
      両方に対応を追加。既存 pending を stash する場合（例: フラッシュ中の
      pendingAttack）、stash 中も表示が継続するかを確認
- [ ] **実機検証**: HTTP フロー（`scripts/verify-activated-flash.mjs` が
      雛形）で該当フィールドのシリアライズ値を assert する。
      「コード上は修正済み」は未検証（API Server Freshness Protocol 参照）

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

### 5-12 "Use" (使用)

"Use" means to activate a hand card's effect. This is distinct from "summon/place" which puts the card on the field.

**Definition**:
- "Use" applies to ANY hand card with an effect, not just magic cards
- Includes: Magic cards, and future support for Artifact/Spirit/Nexus with hand effects
- "Place/Summon" (配置/召喚): Card goes to field → summon effect triggers
- "Use" (使用): Card stays in hand → hand effect triggers → card to trash

**Use Flow**:
1. Player selects hand card with `handIndex`
2. Check usability: Card has a usable effect for current phase/timing
3. Pay cost: Regular cores, soul cores, or special conditions
4. Resolve effect: `triggerEffects(..., 'immediate', card, ...)`
5. Card disposal: Trash the used card

**Current Implementation Status**:
- ✅ Magic cards: Fully supported via `use_magic` (main phase) and `flash` (flash timing)
- ⚠️ Unified naming: Action type still named `use_magic` (should be generalized to `use_card` in future)
- ❌ Non-magic hand effects: Not yet implemented (awaiting refactoring)

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
