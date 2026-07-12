import { useState } from 'react';
import GameBoard from './components/GameBoard';
import GameSetup from './components/GameSetup';
import './App.css';

interface GameSession {
  sessionId: string;
  state: any;
}

export default function App() {
  const [session, setSession] = useState<GameSession | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const handleStartGame = async (p0Type: string, p1Type: string, p0Iters: number, p1Iters: number) => {
    try {
      const response = await fetch('/api/game/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p0Type, p1Type, p0Iters, p1Iters }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      setStartError(null);
      setSession({
        sessionId: data.sessionId,
        state: data.state,
      });
    } catch (error) {
      console.error('Failed to start game:', error);
      setStartError(
        'ゲームを開始できませんでした。APIサーバーに接続できません。「npm start」または start.bat / start.sh でアプリを起動してください（npm run web:dev 単体ではAPIサーバーが起動しません）。'
      );
    }
  };

  const handleEndGame = () => {
    setSession(null);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🎮 Battle Spirits AI</h1>
        <p>ユニバーサルTCG対戦AI</p>
      </header>

      <main className="main">
        {startError && <div className="error-banner">⚠️ {startError}</div>}
        {!session ? (
          <GameSetup onStartGame={handleStartGame} />
        ) : (
          <GameBoard sessionId={session.sessionId} onEndGame={handleEndGame} />
        )}
      </main>
    </div>
  );
}
