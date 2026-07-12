import { useState } from 'react';
import '../styles/GameSetup.css';

interface GameSetupProps {
  onStartGame: (p0Type: string, p1Type: string, p0Iters: number, p1Iters: number) => void;
}

export default function GameSetup({ onStartGame }: GameSetupProps) {
  const [p0Type, setP0Type] = useState('mcts');
  const [p1Type, setP1Type] = useState('random');
  const [p0Iters, setP0Iters] = useState(100);
  const [p1Iters, setP1Iters] = useState(100);

  const handleStart = () => {
    onStartGame(p0Type, p1Type, p0Iters, p1Iters);
  };

  return (
    <div className="game-setup">
      <div className="setup-container">
        <h2>ゲーム設定</h2>

        <div className="player-config">
          <div className="player-settings">
            <h3>プレイヤー0（先手）</h3>
            <div className="setting-group">
              <label>AI タイプ：</label>
              <select value={p0Type} onChange={(e) => setP0Type(e.target.value)}>
                <option value="mcts">MCTS AI</option>
                <option value="random">ランダム</option>
              </select>
            </div>
            {p0Type === 'mcts' && (
              <div className="setting-group">
                <label>探索反復数：</label>
                <input
                  type="number"
                  min="10"
                  max="5000"
                  value={p0Iters}
                  onChange={(e) => setP0Iters(parseInt(e.target.value))}
                />
              </div>
            )}
          </div>

          <div className="vs-divider">VS</div>

          <div className="player-settings">
            <h3>プレイヤー1（後手）</h3>
            <div className="setting-group">
              <label>AI タイプ：</label>
              <select value={p1Type} onChange={(e) => setP1Type(e.target.value)}>
                <option value="mcts">MCTS AI</option>
                <option value="random">ランダム</option>
              </select>
            </div>
            {p1Type === 'mcts' && (
              <div className="setting-group">
                <label>探索反復数：</label>
                <input
                  type="number"
                  min="10"
                  max="5000"
                  value={p1Iters}
                  onChange={(e) => setP1Iters(parseInt(e.target.value))}
                />
              </div>
            )}
          </div>
        </div>

        <button className="start-button" onClick={handleStart}>
          ゲーム開始
        </button>

        <div className="info-box">
          <h4>ℹ️ 説明</h4>
          <ul>
            <li><strong>MCTS AI</strong>: モンテカルロ木探索を使用した強いAI</li>
            <li><strong>ランダム</strong>: ランダムに行動を選択するAI</li>
            <li><strong>探索反復数</strong>: 高いほど強くなりますが、時間がかかります</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
