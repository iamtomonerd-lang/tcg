import { useState, useEffect } from 'react';
import './RankMatch.css';

interface SavedDeck {
  id: string;
  name: string;
  cards: { cardId: string; count: number }[];
  createdAt: string;
  updatedAt: string;
}

interface DeckRating {
  deckId: string;
  deckName: string;
  rating: number;
  wins: number;
  losses: number;
}

interface RankMatchProps {
  onBack?: () => void;
}

const LOCAL_DECKS_KEY = 'bs-saved-decks';

export default function RankMatch({ onBack }: RankMatchProps) {
  const [decks, setDecks] = useState<DeckRating[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      // 保存済みデッキを取得（サーバー → localStorage の順でフォールバック）
      let savedDecks: SavedDeck[] = [];
      try {
        const response = await fetch('/api/decks');
        if (response.ok) {
          const data = await response.json();
          savedDecks = data.decks || [];
        }
      } catch {
        // サーバー未起動時はlocalStorageから
      }
      if (savedDecks.length === 0) {
        try {
          const local = localStorage.getItem(LOCAL_DECKS_KEY);
          if (local) savedDecks = JSON.parse(local);
        } catch {
          // ignore
        }
      }

      // ランク統計を取得してマージ（レートが無いデッキは初期値1500）
      let rankStats: { [key: string]: DeckRating } = {};
      try {
        const response = await fetch('/api/rank/stats');
        if (response.ok) {
          const data = await response.json();
          for (const d of data.decks || []) {
            rankStats[d.deckId] = d;
          }
        }
      } catch {
        // ignore
      }

      const merged: DeckRating[] = savedDecks.map((deck) => ({
        deckId: deck.id,
        deckName: deck.name,
        rating: rankStats[deck.id]?.rating ?? 1500,
        wins: rankStats[deck.id]?.wins ?? 0,
        losses: rankStats[deck.id]?.losses ?? 0,
      }));

      setDecks(merged);
      setLoading(false);
    };
    fetchData();
  }, []);

  if (loading) {
    return <div className="rank-match loading">読み込み中...</div>;
  }

  const selected = decks.find((d) => d.deckId === selectedDeck);

  return (
    <div className="rank-match">
      <div className="rank-match-header">
        <div className="header-row">
          {onBack && (
            <button className="header-back-button" onClick={onBack}>
              ← 戻る
            </button>
          )}
          <div>
            <h2>🏆 ランクマッチ</h2>
            <p>レート対戦であなたのスキルを試してみてください</p>
          </div>
        </div>
      </div>

      <div className="rank-match-content">
        <div className="deck-selection">
          <h3>デッキを選択</h3>
          {decks.length === 0 ? (
            <div className="no-decks">
              <p>保存済みデッキがまだありません</p>
              <p className="hint">「デッキ構築」でデッキを作成・保存するとここに表示されます</p>
            </div>
          ) : (
            <div className="deck-list">
              {decks.map((deck) => (
                <button
                  key={deck.deckId}
                  className={`deck-card ${selectedDeck === deck.deckId ? 'selected' : ''}`}
                  onClick={() => setSelectedDeck(deck.deckId)}
                >
                  <div className="deck-name">{deck.deckName}</div>
                  <div className="deck-stats">
                    <div className="stat">
                      <span className="label">レート</span>
                      <span className="value">{deck.rating}</span>
                    </div>
                    <div className="stat">
                      <span className="label">勝敗</span>
                      <span className="value">{deck.wins}勝 {deck.losses}敗</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="match-info">
          <h3>マッチ情報</h3>
          {selected ? (
            <div className="match-details">
              <div className="info-box">
                <h4>あなたのデッキ</h4>
                <p className="deck-name">{selected.deckName}</p>
                <p className="deck-rating">現在のレート: {selected.rating}</p>
              </div>

              <div className="info-box">
                <h4>対戦相手</h4>
                <p className="info">AIが対戦相手になります</p>
                <p className="info">相手のレートはあなたのレートに応じて決定されます（±300の範囲）</p>
              </div>

              <button
                className="start-button"
                onClick={() => {
                  // 対戦開始処理はここに実装
                  alert('対戦開始機能は準備中です');
                }}
              >
                対戦開始
              </button>
            </div>
          ) : (
            <div className="no-selection">
              <p>対戦するデッキを左から選択してください</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
