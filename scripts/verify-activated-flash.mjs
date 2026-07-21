// 起動：フラッシュ全カード検証 (HTTP実機フロー / human vs human で両側を操作)
// 対象: spirit_graipher, spirit_hibutsu_akurai, nexus_wind_fang_rock
// シナリオを短い独立セッションに分割してデッキ切れ前に完走させる:
//   S1: グライファー(+風牙岩) 発動→コスト→BP→ターン1回→ブロック解決→ブースト解除
//   S2: 防御側（相手のアタック）では候補に出ない
//   S3: take_damage 経路のブースト解除 + 次ターンのターン1回リセット/ネクサス疲労復帰
//   S4: 飛剛アクライ + 非アタックスピリット非表示
const BASE = 'http://localhost:3000';
const results = [];
const seen = new Set();
const record = (name, pass, detail = '') => {
  if (seen.has(name)) return; // リトライで重複記録しない（最初の成功/失敗を採用）
  seen.add(name);
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
};
const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json();
};
const getSnapshot = async (sid) => {
  const { state, isTerminal, currentPlayer } = await get(`/api/game/${sid}/state`);
  const { actions } = await get(`/api/game/${sid}/actions`);
  return { state, isTerminal, currentPlayer, actions };
};
const act = (sid, index) => post(`/api/game/${sid}/action`, { actionIndex: index });
const newSession = async () => (await post('/api/game/new', { p0Type: 'human', p1Type: 'human' })).sessionId;
const spiritsOf = (state, p) => state.players[p].spirits ?? [];
const findSpirit = (state, p, id) => spiritsOf(state, p).findIndex((s) => s.id === id);
const graipherActs = (actions) => actions.filter((a) => a.action?.type === 'activate_flash' && a.action.sourceType === 'spirit' && a.description.includes('グライファー（'));
const akuraiActs = (actions) => actions.filter((a) => a.action?.type === 'activate_flash' && a.action.sourceType === 'spirit' && a.description.includes('アクライ（'));
const nexusActs = (actions) => actions.filter((a) => a.action?.type === 'activate_flash' && a.action.sourceType === 'nexus');
const allActivate = (actions) => actions.filter((a) => a.action?.type === 'activate_flash');
const skipIdx = (actions) => actions.find((a) => a.action?.type === 'skip_flash');
const passLike = (actions) => actions.find((a) => a.action?.type === 'pass' || a.description.includes('フェーズ終了') || a.description.includes('ターン終了'));

// セットアップ (ダイス/先手/マリガン) を処理したら true
const handleSetup = async (sid, actions, currentPlayer) => {
  const find = (pred) => actions.find(pred);
  const order = find((a) => a.description.includes('先手'));
  if (order) {
    const pick = currentPlayer === 0 ? order : find((a) => a.description.includes('後手')) ?? order;
    await act(sid, pick.index); return true;
  }
  const keep = find((a) => a.description.includes('維持'));
  if (keep) { await act(sid, keep.index); return true; }
  return false;
};

// ---------- S1: グライファー+風牙岩 フルライフサイクル (ブロック解決) ----------
async function s1_lifecycle() {
  const sid = await newSession();
  let stage = 0, bpBase = 0, handBefore = null, discardId = null, blockDone = false, nexusUsed = false;
  for (let step = 0; step < 700; step++) {
    const { state, isTerminal, currentPlayer, actions } = await getSnapshot(sid);
    if (isTerminal) return { ok: false, reason: `terminal stage=${stage}` };
    if (await handleSetup(sid, actions, currentPlayer)) continue;
    const find = (pred) => actions.find(pred);
    const gIdx = findSpirit(state, 0, 'spirit_graipher');
    const hasNexus = (state.players[0].nexuses ?? []).some((n) => n.id === 'nexus_wind_fang_rock');
    const shaccoIdx = findSpirit(state, 1, 'spirit_moon_shacco');

    if (state.pendingFlash) {
      if (currentPlayer === 1) { await act(sid, skipIdx(actions).index); continue; }
      if (stage === 1) {
        const g = graipherActs(actions); const n = nexusActs(actions);
        record('1. legalActions: グライファー【起動：フラッシュ】が攻撃側ウィンドウに表示', g.length > 0, `${g.length}件`);
        if (hasNexus) {
          record('1. legalActions: 最奥：風牙岩【起動：フラッシュ】が攻撃側ウィンドウに表示', n.length > 0, `${n.length}件`);
          if (n.length) record('2. 条件判定: ネクサスの対象がアタック中の風牙スピリットに限定', n.every((a) => a.action.targetSpiritIndex === gIdx && a.description.includes('グライファーをBP+2000')), n[0].description);
        }
        if (!g.length) return { ok: false, reason: 'graipher activation not offered' };
        bpBase = spiritsOf(state, 0)[gIdx].bp;
        handBefore = state.players[0].handCards.map((c) => c.id);
        discardId = state.players[0].handCards[g[0].action.discardCardIndex].id;
        await act(sid, g[0].index); stage = 2; continue;
      }
      if (stage === 2) {
        const handNow = state.players[0].handCards.map((c) => c.id);
        record('3. コスト処理: 指定した手札1枚が破棄される', handNow.length === handBefore.length - 1 && handNow.filter((x) => x === discardId).length === handBefore.filter((x) => x === discardId).length - 1, `破棄=${discardId}, ${handBefore.length}→${handNow.length}枚`);
        record('4. 状態変更: グライファー BP+3000 が bp に反映', spiritsOf(state, 0)[gIdx].bp === bpBase + 3000, `${bpBase}→${spiritsOf(state, 0)[gIdx].bp}`);
        record('5. ターン1回: 同ターン中の再発動が候補から消える', graipherActs(actions).length === 0);
        const n = nexusActs(actions);
        if (n.length) { nexusUsed = true; await act(sid, n[0].index); stage = 3; continue; }
        await act(sid, skipIdx(actions).index); stage = 4; continue;
      }
      if (stage === 3) {
        const nx = state.players[0].nexuses.find((x) => x.id === 'nexus_wind_fang_rock');
        record('3. コスト処理: ネクサスが疲労する (exhausted=true)', nx?.exhausted === true);
        record('4. 状態変更: 風牙岩 BP+2000 が重ねて反映 (+3000+2000)', spiritsOf(state, 0)[gIdx].bp === bpBase + 5000, `${bpBase}→${spiritsOf(state, 0)[gIdx].bp}`);
        record('2. 条件判定: 疲労中ネクサスは再発動候補に出ない', nexusActs(actions).length === 0);
        await act(sid, skipIdx(actions).index); stage = 4; continue;
      }
      if (stage === 4 && blockDone) {
        record('5. ターン1回: ブロック成立後ウィンドウでも再発動不可', graipherActs(actions).length === 0);
        if (nexusUsed) record('2. 条件判定: ブロック後ウィンドウでも疲労中ネクサスは出ない', nexusActs(actions).length === 0);
      }
      await act(sid, skipIdx(actions).index); continue;
    }

    if (currentPlayer === 1 && find((a) => a.action?.type === 'block' || a.action?.type === 'take_damage')) {
      const block = find((a) => a.action?.type === 'block');
      if (stage === 4 && !blockDone && block) { blockDone = true; await act(sid, block.index); continue; }
      const td = find((a) => a.action?.type === 'take_damage'); if (td) { await act(sid, td.index); continue; }
    }
    if (currentPlayer === 0 && find((a) => a.action?.type === 'take_damage')) {
      await act(sid, find((a) => a.action?.type === 'take_damage').index); continue;
    }

    if (stage === 4 && blockDone && !state.pendingFlash && !state.pendingAttack) {
      record('6. バトル終了(ブロック解決): BP差で防御側スピリット破壊', findSpirit(state, 1, 'spirit_moon_shacco') === -1);
      const g2 = findSpirit(state, 0, 'spirit_graipher');
      record('6. バトル終了(ブロック解決): 一時ブースト解除で素のBPに戻る', g2 >= 0 && spiritsOf(state, 0)[g2].bp === bpBase, `${bpBase + (nexusUsed ? 5000 : 3000)}→${g2 >= 0 ? spiritsOf(state, 0)[g2].bp : 'N/A'} (期待 ${bpBase})`);
      return { ok: true };
    }

    if (currentPlayer === 0) {
      if ((state.phase === 'main' || state.phase === 'main2') && gIdx === -1) {
        const s = find((a) => a.action?.type === 'summon' && state.players[0].handCards[a.action.handIndex]?.id === 'spirit_graipher');
        if (s) { await act(sid, s.index); continue; }
      }
      if ((state.phase === 'main' || state.phase === 'main2') && !hasNexus) {
        const p = find((a) => a.action?.type === 'place_nexus' && state.players[0].handCards[a.action.handIndex]?.id === 'nexus_wind_fang_rock');
        if (p) { await act(sid, p.index); continue; }
      }
      if (state.phase === 'attack' && stage === 0 && gIdx >= 0 && shaccoIdx >= 0 && spiritsOf(state, 1)[shaccoIdx].canAttack) {
        const atk = find((a) => a.action?.type === 'attack' && a.description.includes('グライファー'));
        if (atk) { stage = 1; await act(sid, atk.index); continue; }
      }
    } else if ((state.phase === 'main' || state.phase === 'main2') && shaccoIdx === -1) {
      const s = find((a) => a.action?.type === 'summon' && state.players[1].handCards[a.action.handIndex]?.id === 'spirit_moon_shacco');
      if (s) { await act(sid, s.index); continue; }
    }
    const p = passLike(actions); if (p) { await act(sid, p.index); continue; }
    await act(sid, actions[0].index);
  }
  return { ok: false, reason: 'step limit' };
}

// ---------- S2: 防御側では候補に出ない ----------
async function s2_defender() {
  const sid = await newSession();
  let p1Attacked = false;
  for (let step = 0; step < 700; step++) {
    const { state, isTerminal, currentPlayer, actions } = await getSnapshot(sid);
    if (isTerminal) return { ok: false, reason: 'terminal' };
    if (await handleSetup(sid, actions, currentPlayer)) continue;
    const find = (pred) => actions.find(pred);
    const gIdx = findSpirit(state, 0, 'spirit_graipher');

    if (state.pendingFlash) {
      if (currentPlayer === 0 && p1Attacked) {
        const af = allActivate(actions);
        record('2. 条件判定: 防御側（相手のアタック）では起動：フラッシュが候補に出ない', af.length === 0, af.length ? af.map((a) => a.description).join('; ') : `グライファー在場でも非表示`);
        return { ok: true };
      }
      await act(sid, skipIdx(actions).index); continue;
    }
    if (find((a) => a.action?.type === 'take_damage')) { await act(sid, find((a) => a.action?.type === 'take_damage').index); continue; }

    if (currentPlayer === 0) {
      if ((state.phase === 'main' || state.phase === 'main2') && gIdx === -1) {
        const s = find((a) => a.action?.type === 'summon' && state.players[0].handCards[a.action.handIndex]?.id === 'spirit_graipher');
        if (s) { await act(sid, s.index); continue; }
      }
    } else {
      if ((state.phase === 'main' || state.phase === 'main2') && spiritsOf(state, 1).length === 0) {
        const s = find((a) => a.action?.type === 'summon');
        if (s) { await act(sid, s.index); continue; }
      }
      if (state.phase === 'attack' && !p1Attacked && gIdx >= 0 && spiritsOf(state, 1).length > 0) {
        const atk = find((a) => a.action?.type === 'attack');
        if (atk) { p1Attacked = true; await act(sid, atk.index); continue; }
      }
    }
    const p = passLike(actions); if (p) { await act(sid, p.index); continue; }
    await act(sid, actions[0].index);
  }
  return { ok: false, reason: 'step limit' };
}

// ---------- S3: take_damage 経路の解除 + 次ターンリセット ----------
async function s3_reset() {
  const sid = await newSession();
  let stage = 0, bpBase = 0, nexusUsed = false; // 0:未攻撃 1:第1攻撃window 2:発動済(解決待ち) 3:解決確認済(再攻撃待ち) 4:第2攻撃window
  for (let step = 0; step < 700; step++) {
    const { state, isTerminal, currentPlayer, actions } = await getSnapshot(sid);
    if (isTerminal) return { ok: false, reason: `terminal stage=${stage}` };
    if (await handleSetup(sid, actions, currentPlayer)) continue;
    const find = (pred) => actions.find(pred);
    const gIdx = findSpirit(state, 0, 'spirit_graipher');
    const hasNexus = (state.players[0].nexuses ?? []).some((n) => n.id === 'nexus_wind_fang_rock');

    if (state.pendingFlash) {
      if (currentPlayer === 1) { await act(sid, skipIdx(actions).index); continue; }
      if (stage === 1) {
        const g = graipherActs(actions);
        if (!g.length) return { ok: false, reason: 'activation not offered (attack 1)' };
        bpBase = spiritsOf(state, 0)[gIdx].bp;
        await act(sid, g[0].index); stage = 1.5; continue;
      }
      if (stage === 1.5) {
        const n = nexusActs(actions);
        if (n.length) { nexusUsed = true; await act(sid, n[0].index); stage = 2; continue; }
        await act(sid, skipIdx(actions).index); stage = 2; continue;
      }
      if (stage === 4) {
        record('5. ターン1回: 次のターンには発動が復活する', graipherActs(actions).length > 0);
        if (nexusUsed) record('5. リフレッシュ: 疲労したネクサスが次ターン復帰し再発動可能', nexusActs(actions).length > 0);
        return { ok: true };
      }
      await act(sid, skipIdx(actions).index); continue;
    }
    if (currentPlayer === 1 && find((a) => a.action?.type === 'take_damage')) {
      await act(sid, find((a) => a.action?.type === 'take_damage').index); continue;
    }

    if (stage === 2 && currentPlayer === 0 && !state.pendingFlash && !state.pendingAttack && gIdx >= 0) {
      const expect = bpBase;
      const bpNow = spiritsOf(state, 0)[gIdx].bp;
      record('6. バトル終了(take_damage経路): ライフで受けても一時ブースト解除', bpNow === expect, `発動後${bpBase + 3000 + (nexusUsed ? 2000 : 0)}→${bpNow} (期待 ${expect})`);
      stage = 3;
    }

    if (currentPlayer === 0) {
      if ((state.phase === 'main' || state.phase === 'main2') && gIdx === -1) {
        const s = find((a) => a.action?.type === 'summon' && state.players[0].handCards[a.action.handIndex]?.id === 'spirit_graipher');
        if (s) { await act(sid, s.index); continue; }
      }
      if ((state.phase === 'main' || state.phase === 'main2') && !hasNexus) {
        const p = find((a) => a.action?.type === 'place_nexus' && state.players[0].handCards[a.action.handIndex]?.id === 'nexus_wind_fang_rock');
        if (p) { await act(sid, p.index); continue; }
      }
      if (state.phase === 'attack' && gIdx >= 0 && (stage === 0 || stage === 3) && (state.players[0].handCards?.length ?? 0) > 0) {
        const atk = find((a) => a.action?.type === 'attack' && a.description.includes('グライファー'));
        if (atk) { stage = stage === 0 ? 1 : 4; await act(sid, atk.index); continue; }
      }
    }
    const p = passLike(actions); if (p) { await act(sid, p.index); continue; }
    await act(sid, actions[0].index);
  }
  return { ok: false, reason: `step limit stage=${stage}` };
}

// ---------- S4: 飛剛アクライ ----------
async function s4_akurai() {
  const sid = await newSession();
  let attacked = false, activated = false, bpBase = 0;
  for (let step = 0; step < 700; step++) {
    const { state, isTerminal, currentPlayer, actions } = await getSnapshot(sid);
    if (isTerminal) return { ok: false, reason: `terminal attacked=${attacked}` };
    if (await handleSetup(sid, actions, currentPlayer)) continue;
    const find = (pred) => actions.find(pred);
    const aIdx = findSpirit(state, 0, 'spirit_hibutsu_akurai');
    const gIdx = findSpirit(state, 0, 'spirit_graipher');

    if (state.pendingFlash) {
      if (currentPlayer === 1) { await act(sid, skipIdx(actions).index); continue; }
      if (attacked && !activated) {
        const ak = akuraiActs(actions);
        record('1. legalActions: 飛剛アクライ【起動：フラッシュ】が自身のアタック時に表示', ak.length > 0, `${ak.length}件`);
        if (gIdx >= 0) record('2. 条件判定: アタックしていない別スピリット(グライファー)の発動は出ない', graipherActs(actions).length === 0, '『アタック中』は当該スピリット限定');
        if (!ak.length) return { ok: false, reason: 'akurai activation not offered' };
        bpBase = spiritsOf(state, 0)[aIdx].bp;
        const handLen = state.players[0].handCards.length;
        await act(sid, ak[0].index); activated = true;
        const after = await get(`/api/game/${sid}/state`);
        const sp = after.state.players[0].spirits[aIdx];
        record('3/4. アクライ: 手札破棄コスト + BP+3000 反映', sp.bp === bpBase + 3000 && after.state.players[0].handCards.length === handLen - 1, `${bpBase}→${sp.bp}, 手札${handLen}→${after.state.players[0].handCards.length}`);
        return { ok: true };
      }
      await act(sid, skipIdx(actions).index); continue;
    }
    if (currentPlayer === 1 && find((a) => a.action?.type === 'take_damage')) {
      await act(sid, find((a) => a.action?.type === 'take_damage').index); continue;
    }

    if (currentPlayer === 0) {
      if (state.phase === 'main' || state.phase === 'main2') {
        if (aIdx === -1) {
          const s = find((a) => a.action?.type === 'summon' && state.players[0].handCards[a.action.handIndex]?.id === 'spirit_hibutsu_akurai');
          if (s) { await act(sid, s.index); continue; }
        }
        if (aIdx >= 0 && gIdx === -1) {
          const s = find((a) => a.action?.type === 'summon' && state.players[0].handCards[a.action.handIndex]?.id === 'spirit_graipher');
          if (s) { await act(sid, s.index); continue; }
        }
      }
      if (state.phase === 'attack' && aIdx >= 0 && !attacked && (state.players[0].handCards?.length ?? 0) > 0) {
        const atk = find((a) => a.action?.type === 'attack' && a.description.includes('アクライ'));
        if (atk) { attacked = true; await act(sid, atk.index); continue; }
      }
    }
    const p = passLike(actions); if (p) { await act(sid, p.index); continue; }
    await act(sid, actions[0].index);
  }
  return { ok: false, reason: 'step limit' };
}

const retry = async (label, fn, tries) => {
  for (let i = 1; i <= tries; i++) {
    const r = await fn();
    if (r.ok) { console.log(`[${label}] 完走 (${i}回目)`); return true; }
    console.log(`  [${label}] リトライ ${i}/${tries}: ${r.reason}`);
  }
  return false;
};

console.log('server health:', JSON.stringify(await get('/api/health')));
const okS1 = await retry('S1 ライフサイクル', s1_lifecycle, 8);
const okS2 = await retry('S2 防御側条件', s2_defender, 8);
const okS3 = await retry('S3 リセット/解除', s3_reset, 8);
const okS4 = await retry('S4 アクライ', s4_akurai, 8);

console.log('\n========== 結果サマリ ==========');
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length}項目中 ${results.length - failed} 成功 / ${failed} 失敗; シナリオ: S1=${okS1} S2=${okS2} S3=${okS3} S4=${okS4}`);
process.exit(failed === 0 && okS1 && okS2 && okS3 && okS4 ? 0 : 1);
