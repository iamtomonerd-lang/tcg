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

interface SavedDeck {
  id: string;
  name: string;
  cards: DeckCard[];
  createdAt: string;
  updatedAt: string;
}

interface DeckBuilderProps {
  onBack?: () => void;
  onSaveDeck?: (deck: DeckCard[]) => void;
}

const LOCAL_DECKS_KEY = 'bs-saved-decks';

export default function DeckBuilder({ onBack }: DeckBuilderProps) {
  const [cards, setCards] = useState<CardData[]>([]);
  const [deck, setDeck] = useState<Map<string, number>>(new Map());
  const [deckName, setDeckName] = useState('');
  const [editingDeckId, setEditingDeckId] = useState<string | null>(null);
  const [savedDecks, setSavedDecks] = useState<SavedDeck[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'spirit' | 'nexus' | 'magic'>('all');

  useEffect(() => {
    const fetchCards = async () => {
      try {
        const response = await fetch('/api/cards');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // データを配列に変換（オブジェクトの場合）
        const cardsArray = Array.isArray(data) ? data : Object.values(data);

        if (cardsArray.length === 0) {
          setError('カード情報がありません');
        } else {
          setCards(cardsArray as CardData[]);
        }
        setLoading(false);
      } catch (err) {
        console.error('Failed to load cards:', err);
        setError(`カード一覧を読み込めませんでした: ${err instanceof Error ? err.message : '不明なエラー'}`);
        setLoading(false);
      }
    };
    fetchCards();
    fetchSavedDecks();
  }, []);

  const fetchSavedDecks = async () => {
    try {
      const response = await fetch('/api/decks');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setSavedDecks(data.decks || []);
      // サーバー保存に成功しているのでローカルにも同期
      localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify(data.decks || []));
    } catch {
      // サーバーが使えない場合はlocalStorageから復元
      try {
        const local = localStorage.getItem(LOCAL_DECKS_KEY);
        if (local) setSavedDecks(JSON.parse(local));
      } catch {
        // ignore
      }
    }
  };

  const showMessage = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(null), 3000);
  };

  const addCardToDeck = (cardId: string) => {
    const currentCount = deck.get(cardId) || 0;
    if (currentCount >= 3) {
      showMessage('同じカードは3枚までです');
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

  const handleSaveDeck = async () => {
    const total = getTotalCards();
    if (total !== 40) {
      showMessage(`デッキは40枚ちょうどである必要があります。現在: ${total}枚`);
      return;
    }
    if (!deckName.trim()) {
      showMessage('デッキ名を入力してください');
      return;
    }

    const payload = {
      id: editingDeckId ?? undefined,
      name: deckName.trim(),
      cards: getDeckArray(),
    };

    try {
      const response = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        showMessage(data.error || '保存に失敗しました');
        return;
      }
      setEditingDeckId(data.deck.id);
      await fetchSavedDecks();
      showMessage(`✅ デッキ「${data.deck.name}」を保存しました`);
    } catch {
      // サーバーが使えない場合はlocalStorageに保存
      const now = new Date().toISOString();
      const deckId = editingDeckId ?? `deck_${Date.now().toString(36)}`;
      const existing = savedDecks.find((d) => d.id === deckId);
      const newDeckObj: SavedDeck = {
        id: deckId,
        name: deckName.trim(),
        cards: getDeckArray(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const updated = [newDeckObj, ...savedDecks.filter((d) => d.id !== deckId)];
      setSavedDecks(updated);
      setEditingDeckId(deckId);
      localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify(updated));
      showMessage(`✅ デッキ「${newDeckObj.name}」を保存しました（ローカル保存）`);
    }
  };

  const handleLoadDeck = (saved: SavedDeck) => {
    const newDeck = new Map<string, number>();
    for (const c of saved.cards) {
      newDeck.set(c.cardId, c.count);
    }
    setDeck(newDeck);
    setDeckName(saved.name);
    setEditingDeckId(saved.id);
    showMessage(`デッキ「${saved.name}」を読み込みました`);
  };

  const handleDeleteDeck = async (deckId: string) => {
    const target = savedDecks.find((d) => d.id === deckId);
    if (!target) return;
    if (!confirm(`デッキ「${target.name}」を削除しますか？`)) return;

    try {
      await fetch(`/api/decks/${deckId}`, { method: 'DELETE' });
    } catch {
      // ignore - localStorageからは必ず消す
    }
    const updated = savedDecks.filter((d) => d.id !== deckId);
    setSavedDecks(updated);
    localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify(updated));
    // ✅ 修正：削除されたデッキがGameSetupで選択されていた場合、クリア
    try {
      const selectedDeckId = localStorage.getItem('selectedP0DeckId');
      if (selectedDeckId === deckId) {
        localStorage.removeItem('selectedP0DeckId');
      }
    } catch {
      // ignore
    }
    if (editingDeckId === deckId) {
      setEditingDeckId(null);
    }
    showMessage(`デッキ「${target.name}」を削除しました`);
  };

  const handleNewDeck = () => {
    setDeck(new Map());
    setDeckName('');
    setEditingDeckId(null);
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
        <div className="header-row">
          {onBack && (
            <button className="header-back-button" onClick={onBack}>
              ← 戻る
            </button>
          )}
          <div>
            <h2>デッキ構築</h2>
            <p>カードを選んでデッキを作成してください（40枚ちょうど、同名3枚まで）</p>
          </div>
        </div>
      </div>

      {message && <div className="deck-message">{message}</div>}

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
                {card.imagePath && (
                  <div className="card-image-container">
                    <img src={card.imagePath} alt={card.name} className="card-image" />
                  </div>
                )}
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

          <div className="deck-name-row">
            <input
              type="text"
              className="deck-name-input"
              placeholder="デッキ名を入力"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              maxLength={30}
            />
            <button className="new-deck-button" onClick={handleNewDeck} title="新規デッキ">
              新規
            </button>
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

          {/* 保存済みデッキ */}
          <div className="saved-decks-section">
            <h4>保存済みデッキ ({savedDecks.length})</h4>
            {savedDecks.length === 0 ? (
              <p className="no-saved-decks">保存済みデッキはありません</p>
            ) : (
              <div className="saved-decks-list">
                {savedDecks.map((saved) => (
                  <div
                    key={saved.id}
                    className={`saved-deck-item ${editingDeckId === saved.id ? 'editing' : ''}`}
                  >
                    <button className="saved-deck-load" onClick={() => handleLoadDeck(saved)}>
                      {saved.name}
                    </button>
                    <button
                      className="saved-deck-delete"
                      onClick={() => handleDeleteDeck(saved.id)}
                      title="削除"
                    >
                      🗑
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="deck-footer">
            <button
              className="save-button"
              onClick={handleSaveDeck}
              disabled={totalCards !== 40 || !deckName.trim()}
            >
              {totalCards !== 40
                ? `あと ${40 - totalCards} 枚必要`
                : !deckName.trim()
                  ? 'デッキ名を入力してください'
                  : editingDeckId
                    ? 'デッキを上書き保存'
                    : 'デッキを保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
