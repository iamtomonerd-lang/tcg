import { useState, useEffect } from 'react';
import './DeckBuilder.css';

interface CardData {
  id: string;
  name: string;
  cardType: 'spirit' | 'nexus' | 'magic';
  cost: number;
  lineage?: string[];
  imagePath?: string;
  lv1: { cost: number; bp: number };
  lv2?: { cost: number; bp: number };
}

interface DeckCard {
  cardId: string;
  count: number;
}

interface DeckBuilderProps {
  onBack?: () => void;
  onSaveDeck?: (deck: DeckCard[]) => void;
}

export default function DeckBuilder({ onBack, onSaveDeck }: DeckBuilderProps) {
  const [cards, setCards] = useState<CardData[]>([]);
  const [deck, setDeck] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'spirit' | 'nexus' | 'magic'>('all');

  useEffect(() => {
    const fetchCards = async () => {
      try {
        const response = await fetch('/api/cards');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        setCards(data);
        setLoading(false);
      } catch (err) {
        console.error('Failed to load cards:', err);
        setError('カード一覧を読み込めませんでした');
        setLoading(false);
      }
    };
    fetchCards();
  }, []);

  const addCardToDeck = (cardId: string) => {
    const currentCount = deck.get(cardId) || 0;
    if (currentCount >= 3) {
      alert('同じカードは3枚までです');
      return;
    }
    const newDeck = new Map(deck);
    newDeck.set(cardId, currentCount + 1);
    setDeck(newDeck);
  };

  const removeCardFromDeck = (cardId: string) => {
    const currentCount = deck.get(cardId) || 0;
    if (currentCount <= 0) return;
    const newDeck = new Map(deck);
    if (currentCount === 1) {
      newDeck.delete(cardId);
    } else {
      newDeck.set(cardId, currentCount - 1);
    }
    setDeck(newDeck);
  };

  const getTotalCards = () => {
    return Array.from(deck.values()).reduce((sum, count) => sum + count, 0);
  };

  const getDeckArray = (): DeckCard[] => {
    return Array.from(deck.entries()).map(([cardId, count]) => ({
      cardId,
      count,
    }));
  };

  const handleSaveDeck = () => {
    const total = getTotalCards();
    if (total !== 40) {
      alert(`デッキは40枚ちょうどである必要があります。現在: ${total}枚`);
      return;
    }
    if (onSaveDeck) {
      onSaveDeck(getDeckArray());
    }
  };

  const filteredCards = cards.filter(
    (card) => selectedCategory === 'all' || card.cardType === selectedCategory
  );

  const totalCards = getTotalCards();

  if (loading) {
    return <div className="deck-builder loading">読み込み中...</div>;
  }

  if (error) {
    return <div className="deck-builder error">{error}</div>;
  }

  return (
    <div className="deck-builder">
      <div className="deck-builder-header">
        <h2>デッキ構築</h2>
        <p>カードを選んでデッキを作成してください（40枚ちょうど、同名3枚まで）</p>
      </div>

      <div className="deck-builder-content">
        {/* 左側: カード一覧 */}
        <div className="cards-panel">
          <div className="category-tabs">
            <button
              className={`tab ${selectedCategory === 'all' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('all')}
            >
              全カード ({cards.length})
            </button>
            <button
              className={`tab ${selectedCategory === 'spirit' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('spirit')}
            >
              スピリット ({cards.filter((c) => c.cardType === 'spirit').length})
            </button>
            <button
              className={`tab ${selectedCategory === 'nexus' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('nexus')}
            >
              ネクサス ({cards.filter((c) => c.cardType === 'nexus').length})
            </button>
            <button
              className={`tab ${selectedCategory === 'magic' ? 'active' : ''}`}
              onClick={() => setSelectedCategory('magic')}
            >
              マジック ({cards.filter((c) => c.cardType === 'magic').length})
            </button>
          </div>

          <div className="cards-list">
            {filteredCards.map((card) => (
              <div key={card.id} className="card-item">
                <div className="card-info">
                  <div className="card-name">{card.name}</div>
                  <div className="card-details">
                    {card.cardType === 'spirit' && (
                      <>
                        <span className="card-type spirit">スピリット</span>
                        <span className="card-cost">コスト {card.cost}</span>
                        <span className="card-bp">BP {card.lv1.bp}</span>
                      </>
                    )}
                    {card.cardType === 'nexus' && (
                      <>
                        <span className="card-type nexus">ネクサス</span>
                        <span className="card-cost">コスト {card.cost}</span>
                      </>
                    )}
                    {card.cardType === 'magic' && (
                      <>
                        <span className="card-type magic">マジック</span>
                        <span className="card-cost">コスト {card.cost}</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  className="add-button"
                  onClick={() => addCardToDeck(card.id)}
                  disabled={(deck.get(card.id) || 0) >= 3}
                >
                  +
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 右側: デッキリスト */}
        <div className="deck-panel">
          <div className="deck-header">
            <h3>デッキリスト</h3>
            <div className="deck-count">
              <span className={`count ${totalCards === 40 ? 'valid' : 'invalid'}`}>
                {totalCards} / 40
              </span>
            </div>
          </div>

          <div className="deck-list">
            {deck.size === 0 ? (
              <div className="empty-deck">
                <p>左側のカードを選んでデッキに追加してください</p>
              </div>
            ) : (
              Array.from(deck.entries()).map(([cardId, count]) => {
                const card = cards.find((c) => c.id === cardId);
                if (!card) return null;
                return (
                  <div key={cardId} className="deck-card-item">
                    <div className="deck-card-info">
                      <div className="deck-card-name">{card.name}</div>
                      <div className="deck-card-type">
                        {card.cardType === 'spirit' && 'スピリット'}
                        {card.cardType === 'nexus' && 'ネクサス'}
                        {card.cardType === 'magic' && 'マジック'}
                      </div>
                    </div>
                    <div className="deck-card-controls">
                      <button
                        className="minus-button"
                        onClick={() => removeCardFromDeck(cardId)}
                      >
                        −
                      </button>
                      <span className="count">{count}</span>
                      <button
                        className="plus-button"
                        onClick={() => addCardToDeck(cardId)}
                        disabled={count >= 3}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="deck-footer">
            <button
              className="save-button"
              onClick={handleSaveDeck}
              disabled={totalCards !== 40}
            >
              {totalCards === 40 ? 'デッキを開始' : `あと ${40 - totalCards} 枚必要`}
            </button>
            {onBack && (
              <button className="back-button" onClick={onBack}>
                ← 戻る
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
