import './HomeScreen.css';

interface HomeScreenProps {
  onSelectMode: (mode: 'free-battle' | 'deck-build' | 'ai-training') => void;
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
          className="menu-button free-battle"
          onClick={() => onSelectMode('free-battle')}
        >
          <div className="button-icon">⚔️</div>
          <div className="button-title">フリー対戦</div>
          <div className="button-desc">AIと対戦します</div>
        </button>

        <button
          className="menu-button deck-build"
          onClick={() => onSelectMode('deck-build')}
        >
          <div className="button-icon">🃏</div>
          <div className="button-title">デッキ構築</div>
          <div className="button-desc">デッキをカスタマイズします</div>
        </button>

        <button
          className="menu-button ai-training"
          onClick={() => onSelectMode('ai-training')}
        >
          <div className="button-icon">🤖</div>
          <div className="button-title">AI学習</div>
          <div className="button-desc">AIを強化します</div>
        </button>
      </div>

      <footer className="home-footer">
        <p>v1.0.0 - 赫焔ノ風牙 スターターデッキ</p>
      </footer>
    </div>
  );
}
