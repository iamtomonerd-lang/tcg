import './HomeScreen.css';

interface HomeScreenProps {
  onSelectMode: (mode: 'free-battle' | 'deck-build' | 'ai-training' | 'rank-match' | 'achievements') => void;
}

export default function HomeScreen({ onSelectMode }: HomeScreenProps) {
  return (
    <div className="home-screen">
      <header className="home-header">
        <h1>🎮 Battle Spirits</h1>
        <p>ユニバーサルTCG対戦システム</p>
      </header>

      <div className="menu-container">
        <button
          className="menu-button menu-free-battle"
          onClick={() => onSelectMode('free-battle')}
        >
          <div className="button-icon">⚔️</div>
          <div className="button-title">フリー対戦</div>
          <div className="button-desc">AIと対戦します</div>
        </button>

        <button
          className="menu-button menu-deck-build"
          onClick={() => onSelectMode('deck-build')}
        >
          <div className="button-icon">🃏</div>
          <div className="button-title">デッキ構築</div>
          <div className="button-desc">デッキをカスタマイズします</div>
        </button>

        <button
          className="menu-button menu-ai-training"
          onClick={() => onSelectMode('ai-training')}
        >
          <div className="button-icon">🤖</div>
          <div className="button-title">AI学習</div>
          <div className="button-desc">AIを強化します</div>
        </button>

        <button
          className="menu-button menu-rank-match"
          onClick={() => onSelectMode('rank-match')}
        >
          <div className="button-icon">🏆</div>
          <div className="button-title">ランクマッチ</div>
          <div className="button-desc">レート対戦</div>
        </button>

        <button
          className="menu-button menu-achievements"
          onClick={() => onSelectMode('achievements')}
        >
          <div className="button-icon">⭐</div>
          <div className="button-title">実績</div>
          <div className="button-desc">カード成績確認</div>
        </button>
      </div>

      <footer className="home-footer">
        <p>v1.0.0 - 赫焔ノ風牙 スターターデッキ</p>
      </footer>
    </div>
  );
}
