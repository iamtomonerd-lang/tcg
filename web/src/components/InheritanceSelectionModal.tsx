import { useState, useEffect } from 'react';

interface InheritanceCandidate {
  id: string;
  name: string;
  imagePath?: string;
  cardType?: string;
  symbolColors: string[];
}

interface InheritanceSelectionModalProps {
  pendingInheritanceSelection: {
    cardName: string;
    maxInheritanceCount: number;
    inheritanceCandidates: InheritanceCandidate[];
  };
  onConfirm: (inheritanceCount: number, selectedCardIds: string[]) => void;
  isBusy: boolean;
}

type Phase = 'count' | 'cards' | 'details';

export default function InheritanceSelectionModal({
  pendingInheritanceSelection,
  onConfirm,
  isBusy,
}: InheritanceSelectionModalProps) {
  const [phase, setPhase] = useState<Phase>('count');
  const [selectedCount, setSelectedCount] = useState(0);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [expandedCard, setExpandedCard] = useState<InheritanceCandidate | null>(null);

  const { cardName, maxInheritanceCount, inheritanceCandidates } = pendingInheritanceSelection;
  const candidates = inheritanceCandidates || [];

  // Phase ①: 枚数選択フェーズ
  const renderCountPhase = () => (
    <div className="inheritance-count-selection">
      <h3>【継召】{cardName}を召喚</h3>
      <p className="inheritance-prompt">
        使用するEXカード枚数を選択してください
      </p>

      <div className="count-buttons">
        {Array.from({ length: maxInheritanceCount }, (_, i) => i + 1).map((count) => (
          <button
            key={count}
            className={`count-button ${selectedCount === count ? 'selected' : ''}`}
            onClick={() => {
              setSelectedCount(count);
              setSelectedCardIds(new Set()); // Reset card selection
              setPhase('cards');
            }}
          >
            {count}枚
          </button>
        ))}
      </div>

      {candidates.length === 0 && (
        <div className="inheritance-candidates-empty">
          <p>対応色のEXシンボルカードがトラッシュにありません</p>
        </div>
      )}
    </div>
  );

  // Phase ②: カード選択フェーズ
  const renderCardsPhase = () => {
    const selected = selectedCardIds.size;
    const canConfirm = selected === selectedCount;

    return (
      <div className="inheritance-card-selection">
        <h3>【継召】{cardName}を召喚</h3>
        <p className="inheritance-prompt">
          対応色のEXカードを{selectedCount}枚選択してください
        </p>

        {candidates.length === 0 ? (
          <div className="inheritance-candidates-empty">
            <p>対応色のEXシンボルカードがトラッシュにありません</p>
          </div>
        ) : (
          <div className="inheritance-candidates-grid">
            {candidates.map((candidate) => {
              const isSelected = selectedCardIds.has(candidate.id);
              const isDisabled = !isSelected && selectedCardIds.size >= selectedCount;

              return (
                <div
                  key={candidate.id}
                  className={`inheritance-card ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                  onClick={() => {
                    if (isDisabled && !isSelected) return;
                    const newSelection = new Set(selectedCardIds);
                    if (isSelected) {
                      newSelection.delete(candidate.id);
                    } else {
                      newSelection.add(candidate.id);
                    }
                    setSelectedCardIds(newSelection);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setExpandedCard(candidate);
                    setPhase('details');
                  }}
                >
                  {isSelected && <div className="selection-indicator">✓</div>}

                  {candidate.imagePath ? (
                    <img src={candidate.imagePath} alt={candidate.name} className="card-image" />
                  ) : (
                    <div className="card-image-placeholder">{candidate.name}</div>
                  )}

                  <div className="card-name">{candidate.name}</div>
                  <div className="card-symbols">
                    {candidate.symbolColors?.map((sym) => (
                      <span key={sym} className="symbol-badge">
                        {sym}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="inheritance-selection-info">
          <span className={`selection-count ${canConfirm ? 'complete' : 'incomplete'}`}>
            選択: {selected} / {selectedCount}枚
          </span>
        </div>

        <div className="inheritance-control-buttons">
          <button
            className="back-button"
            onClick={() => {
              setPhase('count');
              setSelectedCount(0);
              setSelectedCardIds(new Set());
            }}
          >
            戻る
          </button>
          <button
            className="confirm-button"
            onClick={() => {
              onConfirm(selectedCount, Array.from(selectedCardIds));
            }}
            disabled={!canConfirm || isBusy}
          >
            決定
          </button>
        </div>
      </div>
    );
  };

  // Phase ③: カード詳細表示フェーズ
  const renderDetailsPhase = () => {
    if (!expandedCard) return null;

    return (
      <div
        className="card-details-overlay"
        onClick={() => setPhase('cards')}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="card-details-modal" onClick={(e) => e.stopPropagation()}>
          <button
            className="close-button"
            onClick={() => setPhase('cards')}
          >
            ✕
          </button>

          {expandedCard.imagePath ? (
            <img src={expandedCard.imagePath} alt={expandedCard.name} className="card-image-large" />
          ) : (
            <div className="card-image-placeholder-large">{expandedCard.name}</div>
          )}

          <div className="card-details-info">
            <h4>{expandedCard.name}</h4>
            <div className="card-symbols-large">
              {expandedCard.symbolColors?.map((sym) => (
                <span key={sym} className="symbol-badge-large">
                  {sym}
                </span>
              ))}
            </div>
          </div>

          <p className="details-hint">クリックで戻る / ESCキーで閉じる</p>
        </div>
      </div>
    );
  };

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase === 'details') {
        setPhase('cards');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [phase]);

  // Reset state when pendingInheritanceSelection changes
  useEffect(() => {
    setPhase('count');
    setSelectedCount(0);
    setSelectedCardIds(new Set());
    setExpandedCard(null);
  }, [pendingInheritanceSelection]);

  return (
    <div className="inheritance-modal-overlay">
      <div className="inheritance-modal-content">
        {phase === 'count' && renderCountPhase()}
        {phase === 'cards' && renderCardsPhase()}
        {phase === 'details' && renderDetailsPhase()}
      </div>
    </div>
  );
}
