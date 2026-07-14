import { useState, useEffect } from 'react';
import '../styles/GameSetup.css';

interface SavedDeck {
  id: string;
  name: string;
  cards: any[];
  createdAt: string;
  updatedAt: string;
}

interface AIDeck {
  id: string;
  name: string;
}

interface GameSetupProps {
  onStartGame: (p0Type: string, p1Type: string, p0Iters: number, p1Iters: number, p0DeckId?: string, p1DeckId?: string) => void;
  onBack?: () => void;
}

export default function GameSetup({ onStartGame, onBack }: GameSetupProps) {
  const [p0Type, setP0Type] = useState('human');
  const [p1Type, setP1Type] = useState('mcts');
  const [p0Iters, setP0Iters] = useState(100);
  const [p1Iters, setP1Iters] = useState(100);
  const [savedDecks, setSavedDecks] = useState<SavedDeck[]>([]);
  const [aiDecks] = useState<AIDeck[]>([
    { id: 'ai-easy', name: '🟢 イージー' },
    { id: 'ai-medium', name: '🟡 ノーマル' },
    { id: 'ai-hard', name: '🔴 ハード' },
  ]);
  const [p0DeckId, setP0DeckId] = useState<string>('');
  const [p1DeckId, setP1DeckId] = useState<string>('ai-medium');

  useEffect(() => {
    loadDecks();
  }, []);

  const loadDecks = async () => {
    try {
      const response = await fetch('/api/decks');
      if (response.ok) {
        const data = await response.json();
        setSavedDecks(data.decks || []);
        if (data.decks && data.decks.length > 0) {
          setP0DeckId(data.decks[0].id);
        }
      }
    } catch (error) {
      console.error('Failed to load decks:', error);
    }
  };

  const handleStart = () => {
    if (p0Type === 'human' && !p0DeckId) {
      alert('⚠️ プレイヤー0（先手）のデッキを選択してください');
      return;
    }
    onStartGame(p0Type, p1Type, p0Iters, p1Iters, p0DeckId || undefined, p1DeckId);
  };

  return (
    <div className="game-setup">
      <div className="setup-container">
        <h2>ゲーム設定</h2>

        <div className="player-config">
          <div className="player-settings">
            <h3>プレイヤー0（先手）</h3>
            <div className="setting-group">
              <label>プレイヤータイプ：</label>
              <select value={p0Type} onChange={(e) => setP0Type(e.target.value)}>
                <option value="human">人間（手動操作）</option>
                <option value="mcts">MCTS AI</option>
                <option value="random">ランダム</option>
              </select>
            </div>
            {p0Type !== 'mcts' && p0Type !== 'random' && (
              <div className="setting-group">
                <label>デッキを選択：</label>
                <select value={p0DeckId} onChange={(e) => setP0DeckId(e.target.value)}>
                  <option value="">-- デッキを選択してください --</option>
                  {savedDecks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} ({deck.cards.length}/40枚)
                    </option>
                  ))}
                </select>
              </div>
            )}
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
              <label>プレイヤータイプ：</label>
              <select value={p1Type} onChange={(e) => setP1Type(e.target.value)}>
                <option value="human">人間（手動操作）</option>
                <option value="mcts">MCTS AI</option>
                <option value="random">ランダム</option>
              </select>
            </div>
            {(p1Type === 'mcts' || p1Type === 'random') && (
              <div className="setting-group">
                <label>AIの難易度：</label>
                <select value={p1DeckId} onChange={(e) => setP1DeckId(e.target.value)}>
                  {aiDecks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {p1Type !== 'mcts' && p1Type !== 'random' && (
              <div className="setting-group">
                <label>デッキを選択：</label>
                <select value={p1DeckId} onChange={(e) => setP1DeckId(e.target.value)}>
                  <option value="">-- デッキを選択してください --</option>
                  {savedDecks.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} ({deck.cards.length}/40枚)
                    </option>
                  ))}
                </select>
              </div>
            )}
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

        <div className="button-group">
          <button className="start-button" onClick={handleStart}>
            ゲーム開始
          </button>
          {onBack && (
            <button className="back-button" onClick={onBack}>
              ← 戻る
            </button>
          )}
        </div>

        <div className="info-box">
          <h4>ℹ️ 説明</h4>
          <ul>
            <li><strong>人間</strong>: 画面のアクションボタンで手動操作します</li>
            <li><strong>MCTS AI</strong>: モンテカルロ木探索を使用した強いAI</li>
            <li><strong>ランダム</strong>: ランダムに行動を選択するAI</li>
            <li><strong>探索反復数</strong>: 高いほど強くなりますが、時間がかかります</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
