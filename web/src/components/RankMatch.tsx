import { useState, useEffect } from 'react';
import './RankMatch.css';

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

export default function RankMatch({ onBack }: RankMatchProps) {
  const [decks, setDecks] = useState<DeckRating[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDecks = async () => {
      try {
        const response = await fetch('/api/rank/stats');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setDecks(data.decks || []);
        setLoading(false);
      } catch (err) {
        console.error('Failed to load rank stats:', err);
        setError(`ランク情報を読み込めませんでした: ${err instanceof Error ? err.message : '不明なエラー'}`);
        setLoading(false);
      }
    };
    fetchDecks();
  }, []);

  if (loading) {
    return <div className="rank-match loading">読み込み中...</div>;
  }

  if (error) {
    return <div className="rank-match error">{error}</div>;
  }

  return (
    <div className="rank-match">
      <div className="rank-match-header">
        <h2>ランクマッチ</h2>
        <p>レート対戦であなたのスキルを試してみてください</p>
      </div>

      <div className="rank-match-content">
        <div className="deck-selection">
          <h3>デッキを選択</h3>
          {decks.length === 0 ? (
            <div className="no-decks">
              <p>ランクマッチ対応デッキがまだありません</p>
              <p className="hint">デッキ構築でデッキを作成してください</p>
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
          {selectedDeck ? (
            <>
              {decks.find((d) => d.deckId === selectedDeck) && (
                <div className="match-details">
                  <div className="info-box">
                    <h4>あなたのデッキ</h4>
                    <p className="deck-name">
                      {decks.find((d) => d.deckId === selectedDeck)?.deckName}
                    </p>
                    <p className="deck-rating">
                      現在のレート: {decks.find((d) => d.deckId === selectedDeck)?.rating}
                    </p>
                  </div>

                  <div className="info-box">
                    <h4>対戦相手</h4>
                    <p className="info">AIが対戦相手になります</p>
                    <p className="info">相手のレートはあなたのレートに応じて決定されます（±300の範囲）</p>
                  </div>

                  <button className="start-button" onClick={() => {
                    // 対戦開始処理はここに実装
                    alert('対戦開始機能は準備中です');
                  }}>
                    対戦開始
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="no-selection">
              <p>対戦するデッキを左から選択してください</p>
            </div>
          )}
        </div>
      </div>

      {onBack && (
        <button className="back-button" onClick={onBack}>
          ← 戻る
        </button>
      )}
    </div>
  );
}
