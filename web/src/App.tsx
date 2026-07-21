import { useState } from 'react';
import GameBoard from './components/GameBoard';
import GameSetup from './components/GameSetup';
import HomeScreen from './components/HomeScreen';
import DeckBuilder from './components/DeckBuilder';
import AITraining from './components/AITraining';
import RankMatch from './components/RankMatch';
import Achievements from './components/Achievements';
import './App.css';

interface GameSession {
  sessionId: string;
  state: any;
  p1Rating?: number;
}

type AppScreen = 'home' | 'setup' | 'deck-build' | 'ai-training' | 'rank-match' | 'achievements' | 'game';

export default function App() {
  const [screen, setScreen] = useState<AppScreen>('home');
  const [session, setSession] = useState<GameSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const handleSelectMode = (mode: 'free-battle' | 'deck-build' | 'ai-training' | 'rank-match' | 'achievements') => {
    if (mode === 'free-battle') {
      setScreen('setup');
    } else if (mode === 'deck-build') {
      setScreen('deck-build');
    } else if (mode === 'ai-training') {
      setScreen('ai-training');
    } else if (mode === 'rank-match') {
      setScreen('rank-match');
    } else if (mode === 'achievements') {
      setScreen('achievements');
    }
  };

  const handleStartGame = async (p0Type: string, p1Type: string, p0Iters: number, p1Iters: number, p0DeckId?: string, p1DeckId?: string, p0Rating?: number) => {
    try {
      // ✅ ゲーム開始時のパラメータをログ出力（デバッグ用）
      console.log('🎮 ゲーム開始リクエスト送信:');
      console.log(`  p0Type=${p0Type}, p1Type=${p1Type}`);
      console.log(`  p0DeckId="${p0DeckId}", p1DeckId="${p1DeckId}"`);

      const response = await fetch('/api/game/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p0Type, p1Type, p0Iters, p1Iters, p0DeckId, p1DeckId, p0Rating }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      setStartError(null);
      setSession({
        sessionId: data.sessionId,
        state: data.state,
        p1Rating: data.p1Rating,
      });
      console.log(`✅ ゲーム開始成功: sessionId=${data.sessionId}`);
      setScreen('game');
    } catch (error) {
      console.error('Failed to start game:', error);
      setStartError(
        'ゲームを開始できませんでした。APIサーバーに接続できません。「npm start」または start.bat / start.sh でアプリを起動してください（npm run web:dev 単体ではAPIサーバーが起動しません）。'
      );
    }
  };

  const handleEndGame = () => {
    setSession(null);
    setScreen('home');
  };

  const handleBackToHome = () => {
    setScreen('home');
  };

  return (
    <div className={`app ${screen === 'game' ? 'in-game' : ''}`}>
      {screen === 'home' && <HomeScreen onSelectMode={handleSelectMode} />}

      {screen === 'setup' && (
        <>
          {!session && (
            <header className="header">
              <h1>🎮 Battle Spirits AI</h1>
              <p>ユニバーサルTCG対戦AI</p>
            </header>
          )}
          <main className="main">
            {startError && <div className="error-banner">⚠️ {startError}</div>}
            <GameSetup onStartGame={handleStartGame} onBack={handleBackToHome} />
          </main>
        </>
      )}

      {screen === 'deck-build' && (
        <DeckBuilder onBack={handleBackToHome} />
      )}

      {screen === 'ai-training' && (
        <AITraining onBack={handleBackToHome} />
      )}

      {screen === 'rank-match' && (
        <RankMatch onBack={handleBackToHome} onStartGame={handleStartGame} />
      )}

      {screen === 'achievements' && (
        <Achievements onBack={handleBackToHome} />
      )}

      {screen === 'game' && (
        <main className="main-game">
          <GameBoard sessionId={session!.sessionId} p1Rating={session!.p1Rating} onEndGame={handleEndGame} />
        </main>
      )}
    </div>
  );
}
