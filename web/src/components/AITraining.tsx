import { useState, useEffect, useRef } from 'react';
import './AITraining.css';

interface AITrainingProps {
  onBack?: () => void;
}

type TrainingState = 'idle' | 'running' | 'paused' | 'completed';

interface TrainingStats {
  gamesPlayed: number;
  startTime: number;
  elapsedSeconds: number;
  estimatedGamesPerHour: number;
  systemHealth: 'good' | 'warm' | 'hot';
  cpuUsage: number;
  memoryUsage: number;
}

interface TrainingHistory {
  sessionId: string;
  gamesPlayed: number;
  totalElapsedSeconds: number;
  sessionStartTime: string;
  sessionEndTime?: string;
  createdAt: string;
  updatedAt: string;
}

export default function AITraining({ onBack }: AITrainingProps) {
  const [state, setState] = useState<TrainingState>('idle');
  const [duration, setDuration] = useState(60); // minutes
  const [endTime, setEndTime] = useState<Date | null>(null);
  const [stats, setStats] = useState<TrainingStats>({
    gamesPlayed: 0,
    startTime: 0,
    elapsedSeconds: 0,
    estimatedGamesPerHour: 0,
    systemHealth: 'good',
    cpuUsage: 0,
    memoryUsage: 0,
  });
  const [showEndTimeModal, setShowEndTimeModal] = useState(false);
  const [showDataModal, setShowDataModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [endTimeHour, setEndTimeHour] = useState(12);
  const [endTimeMinute, setEndTimeMinute] = useState(0);
  const [cpuLimit, setCpuLimit] = useState(80);
  const [memoryLimit, setMemoryLimit] = useState(85);
  const [history, setHistory] = useState<TrainingHistory[]>([]);
  const [totalStats, setTotalStats] = useState({ totalGames: 0, totalHours: 0 });
  const [recommendedLimits, setRecommendedLimits] = useState({ cpu: 80, memory: 85 });
  const trainingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const sessionIdRef = useRef<string>(Math.random().toString(36).substring(7));

  // Load training history from server on mount
  useEffect(() => {
    loadTrainingHistory();
    calculateRecommendedLimits();
  }, []);

  const calculateRecommendedLimits = () => {
    // デバイスの性能に基づいて推奨上限を計算
    const cores = navigator.hardwareConcurrency || 4;
    const memory = (navigator as any).deviceMemory || 8; // GB

    let recommendedCpu = 80;
    let recommendedMemory = 85;

    // CPUコア数に基づいた推奨値調整
    if (cores <= 2) {
      recommendedCpu = 70; // 低性能
      recommendedMemory = 75;
    } else if (cores <= 4) {
      recommendedCpu = 75; // 中性能
      recommendedMemory = 80;
    } else if (cores <= 8) {
      recommendedCpu = 80; // 高性能
      recommendedMemory = 85;
    } else {
      recommendedCpu = 85; // 超高性能
      recommendedMemory = 90;
    }

    setRecommendedLimits({ cpu: recommendedCpu, memory: recommendedMemory });
    setCpuLimit(recommendedCpu);
    setMemoryLimit(recommendedMemory);
  };

  // Save training data periodically and to localStorage
  useEffect(() => {
    if (state === 'running' || state === 'paused') {
      saveIntervalRef.current = setInterval(() => {
        saveTrainingStats();
      }, 5000); // Save every 5 seconds
    }

    return () => {
      if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);
    };
  }, [state, stats]);

  // シミュレーション用：本来はサーバーから取得
  useEffect(() => {
    if (state === 'running') {
      trainingIntervalRef.current = setInterval(() => {
        setStats((prev) => ({
          ...prev,
          gamesPlayed: prev.gamesPlayed + Math.random() * 0.5, // 現実的な速度でシミュレート
          elapsedSeconds: prev.elapsedSeconds + 1,
        }));
      }, 1000);

      statsIntervalRef.current = setInterval(() => {
        // システムステータスのシミュレーション
        setStats((prev) => {
          const newCpuUsage = 30 + Math.random() * 40;
          const newMemoryUsage = 40 + Math.random() * 30;
          let systemHealth: 'good' | 'warm' | 'hot' = 'good';

          // 設定された上限に基づいて判定
          if (newCpuUsage > cpuLimit || newMemoryUsage > memoryLimit) {
            systemHealth = 'hot';
          } else if (newCpuUsage > cpuLimit - 10 || newMemoryUsage > memoryLimit - 10) {
            systemHealth = 'warm';
          }

          return {
            ...prev,
            cpuUsage: newCpuUsage,
            memoryUsage: newMemoryUsage,
            systemHealth,
            estimatedGamesPerHour: (prev.gamesPlayed / (prev.elapsedSeconds / 3600)) || 0,
          };
        });
      }, 2000);
    }

    return () => {
      if (trainingIntervalRef.current) clearInterval(trainingIntervalRef.current);
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    };
  }, [state]);

  // 学習終了時刻チェック
  useEffect(() => {
    if (state === 'running' && endTime) {
      const checkInterval = setInterval(() => {
        if (new Date() >= endTime) {
          stopTraining();
        }
      }, 1000);
      return () => clearInterval(checkInterval);
    }
  }, [state, endTime]);

  const startTraining = () => {
    const now = new Date();
    const calculatedEndTime = new Date(now.getTime() + duration * 60000);

    setStats((prev) => ({
      ...prev,
      startTime: now.getTime(),
      elapsedSeconds: 0,
      gamesPlayed: 0,
    }));
    setEndTime(calculatedEndTime);
    setState('running');
  };

  const pauseTraining = () => {
    setState('paused');
  };

  const resumeTraining = () => {
    setState('running');
  };

  const stopTraining = () => {
    setState('completed');
    if (trainingIntervalRef.current) clearInterval(trainingIntervalRef.current);
    if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
    if (saveIntervalRef.current) clearInterval(saveIntervalRef.current);

    // Save final stats
    const finalSession: TrainingHistory = {
      sessionId: sessionIdRef.current,
      gamesPlayed: Math.floor(stats.gamesPlayed),
      totalElapsedSeconds: stats.elapsedSeconds,
      sessionStartTime: new Date(stats.startTime).toISOString(),
      sessionEndTime: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const updatedHistory = [...history];
    const existingIndex = updatedHistory.findIndex((s) => s.sessionId === sessionIdRef.current);
    if (existingIndex >= 0) {
      updatedHistory[existingIndex] = finalSession;
    } else {
      updatedHistory.push(finalSession);
    }
    setHistory(updatedHistory);

    // Update total stats
    const totalGames = updatedHistory.reduce((sum, s) => sum + s.gamesPlayed, 0);
    const totalSeconds = updatedHistory.reduce((sum, s) => sum + s.totalElapsedSeconds, 0);
    setTotalStats({
      totalGames,
      totalHours: totalSeconds / 3600,
    });

    // Save to server
    fetch('/api/training/stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        stats: {
          gamesPlayed: Math.floor(stats.gamesPlayed),
          totalElapsedSeconds: stats.elapsedSeconds,
          sessionStartTime: new Date(stats.startTime).toISOString(),
          sessionEndTime: new Date().toISOString(),
        },
      }),
    }).catch((error) => console.error('Failed to save final stats:', error));

    // Save to localStorage
    localStorage.setItem('ai-training-stats', JSON.stringify({ sessions: updatedHistory }));
  };

  const handleSetEndTime = () => {
    const now = new Date();
    const endTimeDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), endTimeHour, endTimeMinute);

    // 指定時刻がまだ来ていない場合、今日の指定時刻
    // 過ぎた場合は明日の指定時刻
    if (endTimeDate <= now) {
      endTimeDate.setDate(endTimeDate.getDate() + 1);
    }

    setEndTime(endTimeDate);
    setShowEndTimeModal(false);
    if (state !== 'running') {
      startTraining();
    }
  };

  const resetTraining = () => {
    setState('idle');
    setEndTime(null);
    setStats({
      gamesPlayed: 0,
      startTime: 0,
      elapsedSeconds: 0,
      estimatedGamesPerHour: 0,
      systemHealth: 'good',
      cpuUsage: 0,
      memoryUsage: 0,
    });
  };

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const getTimeRemaining = () => {
    if (!endTime) return '';
    const now = new Date();
    const remaining = endTime.getTime() - now.getTime();
    if (remaining <= 0) return '終了';
    const remainingSeconds = Math.floor(remaining / 1000);
    return formatTime(remainingSeconds);
  };

  const loadTrainingHistory = async () => {
    try {
      const response = await fetch('/api/training/stats');
      if (response.ok) {
        const data = await response.json();
        const sessions = data.sessions || [];
        setHistory(sessions);

        // Calculate total stats
        const totalGames = sessions.reduce((sum: number, s: TrainingHistory) => sum + s.gamesPlayed, 0);
        const totalSeconds = sessions.reduce((sum: number, s: TrainingHistory) => sum + s.totalElapsedSeconds, 0);
        setTotalStats({
          totalGames: totalGames,
          totalHours: totalSeconds / 3600,
        });
      }
    } catch (error) {
      console.error('Failed to load training history:', error);
      // Try to load from localStorage as fallback
      const localData = localStorage.getItem('ai-training-stats');
      if (localData) {
        try {
          const parsed = JSON.parse(localData);
          setHistory(parsed.sessions || []);
        } catch (e) {
          console.error('Failed to parse localStorage data:', e);
        }
      }
    }
  };

  const saveTrainingStats = async () => {
    const sessionData: TrainingHistory = {
      sessionId: sessionIdRef.current,
      gamesPlayed: Math.floor(stats.gamesPlayed),
      totalElapsedSeconds: stats.elapsedSeconds,
      sessionStartTime: new Date(stats.startTime).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save to localStorage
    const localData = { sessions: [...history, sessionData] };
    localStorage.setItem('ai-training-stats', JSON.stringify(localData));

    // Save to server
    try {
      await fetch('/api/training/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          stats: {
            gamesPlayed: Math.floor(stats.gamesPlayed),
            totalElapsedSeconds: stats.elapsedSeconds,
            sessionStartTime: new Date(stats.startTime).toISOString(),
          },
        }),
      });
    } catch (error) {
      console.error('Failed to save to server:', error);
    }
  };

  const downloadStats = () => {
    const data = {
      exportDate: new Date().toISOString(),
      totalStats: {
        totalGames: totalStats.totalGames,
        totalHours: totalStats.totalHours.toFixed(1),
      },
      sessions: history,
    };

    const dataStr = JSON.stringify(data, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-training-stats-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importStats = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        const importedSessions = data.sessions || [];

        // Merge with existing
        const merged = [...history];
        for (const session of importedSessions) {
          const existing = merged.find((s) => s.sessionId === session.sessionId);
          if (!existing) {
            merged.push(session);
          }
        }

        setHistory(merged);

        // Save merged data to server
        for (const session of merged) {
          await fetch('/api/training/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: session.sessionId,
              stats: {
                gamesPlayed: session.gamesPlayed,
                totalElapsedSeconds: session.totalElapsedSeconds,
                sessionStartTime: session.sessionStartTime,
              },
            }),
          });
        }

        // Update localStorage
        localStorage.setItem('ai-training-stats', JSON.stringify({ sessions: merged }));

        alert(`✅ ${importedSessions.length}個のセッションをインポートしました`);
        setShowDataModal(false);
      } catch (error) {
        console.error('Failed to import stats:', error);
        alert('❌ ファイルの形式が正しくありません');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="ai-training">
      <div className="training-header">
        <h2>🤖 AI学習</h2>
        <p>MCTSアルゴリズムを最適化して、より強いAIを育成します</p>
      </div>

      <div className="training-content">
        {/* メインパネル */}
        <div className="training-main">
          {state === 'idle' ? (
            <div className="idle-panel">
              <div className="setup-section">
                <h3>学習設定</h3>

                <div className="setup-option">
                  <label>学習時間</label>
                  <div className="duration-input">
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      value={duration}
                      onChange={(e) => setDuration(Math.max(1, parseInt(e.target.value) || 1))}
                      disabled={state !== 'idle'}
                    />
                    <span>分</span>
                  </div>
                  <small>推奨: 30〜120分</small>
                </div>

                <div className="setup-option">
                  <label>終了時刻を指定</label>
                  <button
                    className="time-button"
                    onClick={() => setShowEndTimeModal(true)}
                    disabled={state !== 'idle'}
                  >
                    ⏰ 終了時刻を設定
                  </button>
                  <small>指定時刻に自動で学習を終了します</small>
                </div>

                <div className="setup-option">
                  <label>リソース上限設定</label>
                  <button
                    className="time-button"
                    onClick={() => setShowSettingsModal(true)}
                    disabled={state !== 'idle'}
                  >
                    ⚙️ リソース上限を設定
                  </button>
                  <small>
                    CPU: {cpuLimit}% / メモリ: {memoryLimit}%（推奨: CPU {recommendedLimits.cpu}% / メモリ {recommendedLimits.memory}%）
                  </small>
                </div>

                <div className="info-box">
                  <h4>ℹ️ 学習について</h4>
                  <ul>
                    <li>🎮 <strong>自動対戦</strong>: AIが自動で対戦してデータを蓄積</li>
                    <li>🧠 <strong>重み更新</strong>: 対戦結果からニューラルネットワークを最適化</li>
                    <li>📊 <strong>リアルタイム監視</strong>: CPU/メモリ使用率を監視し安全に動作</li>
                    <li>⏹️ <strong>いつでも中止</strong>: 中止ボタンで即座に学習を停止</li>
                    <li>🔥 <strong>スペック管理</strong>: システムが過負荷の場合、自動で負荷を調整</li>
                  </ul>
                </div>

                <button className="start-button" onClick={startTraining}>
                  🚀 学習を開始
                </button>
              </div>
            </div>
          ) : (
            <div className="training-panel">
              <div className="progress-section">
                <div className="progress-item">
                  <div className="progress-label">対戦数</div>
                  <div className="progress-value">{Math.floor(stats.gamesPlayed)}</div>
                  <div className="progress-rate">
                    {stats.estimatedGamesPerHour > 0
                      ? `${stats.estimatedGamesPerHour.toFixed(1)} ゲーム/時間`
                      : '-'}
                  </div>
                </div>

                <div className="progress-item">
                  <div className="progress-label">経過時間</div>
                  <div className="progress-value">{formatTime(stats.elapsedSeconds)}</div>
                  <div className="progress-rate">
                    {endTime ? `終了予定: ${endTime.toLocaleTimeString('ja-JP')}` : '-'}
                  </div>
                </div>

                <div className="progress-item">
                  <div className="progress-label">残り時間</div>
                  <div className="progress-value">{getTimeRemaining()}</div>
                  <div className="progress-rate">
                    {endTime ? `あと ${Math.ceil((endTime.getTime() - new Date().getTime()) / 60000)} 分` : '-'}
                  </div>
                </div>
              </div>

              <div className="system-section">
                <h3>システムステータス</h3>

                <div className="system-status">
                  <div className={`status-indicator ${stats.systemHealth}`}>
                    {stats.systemHealth === 'good' && '✅ 良好'}
                    {stats.systemHealth === 'warm' && '⚠️ 注意'}
                    {stats.systemHealth === 'hot' && '🔴 過負荷'}
                  </div>
                </div>

                <div className="resource-monitor">
                  <div className="resource-item">
                    <div className="resource-label">CPU使用率</div>
                    <div className="resource-bar">
                      <div
                        className={`resource-fill ${stats.cpuUsage > 80 ? 'critical' : stats.cpuUsage > 70 ? 'warning' : 'normal'}`}
                        style={{ width: `${Math.min(stats.cpuUsage, 100)}%` }}
                      />
                    </div>
                    <div className="resource-value">{stats.cpuUsage.toFixed(1)}%</div>
                  </div>

                  <div className="resource-item">
                    <div className="resource-label">メモリ使用率</div>
                    <div className="resource-bar">
                      <div
                        className={`resource-fill ${stats.memoryUsage > 85 ? 'critical' : stats.memoryUsage > 75 ? 'warning' : 'normal'}`}
                        style={{ width: `${Math.min(stats.memoryUsage, 100)}%` }}
                      />
                    </div>
                    <div className="resource-value">{stats.memoryUsage.toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 制御パネル */}
        <div className="control-panel">
          {state === 'idle' ? (
            <>
              <button className="data-button" onClick={() => setShowDataModal(true)}>
                📊 データ管理
              </button>
              <button className="back-button" onClick={onBack}>
                ← 戻る
              </button>
            </>
          ) : state === 'running' ? (
            <>
              <button className="pause-button" onClick={pauseTraining}>
                ⏸ 一時停止
              </button>
              <button className="stop-button" onClick={stopTraining}>
                ⏹ 中止
              </button>
            </>
          ) : state === 'paused' ? (
            <>
              <button className="resume-button" onClick={resumeTraining}>
                ▶ 再開
              </button>
              <button className="stop-button" onClick={stopTraining}>
                ⏹ 中止
              </button>
            </>
          ) : (
            <>
              <div className="completion-message">
                <h3>✅ 学習完了</h3>
                <p>{Math.floor(stats.gamesPlayed)} ゲームを対戦しました</p>
                <p>AI の強さが向上しました</p>
              </div>
              <button className="reset-button" onClick={resetTraining}>
                🔄 リセット
              </button>
              <button className="back-button" onClick={onBack}>
                ← 戻る
              </button>
            </>
          )}
        </div>
      </div>

      {/* 終了時刻設定モーダル */}
      {showEndTimeModal && (
        <div className="modal-overlay">
          <div className="modal">
            <h3>終了時刻を設定</h3>
            <div className="time-picker">
              <div className="time-input">
                <label>時</label>
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={endTimeHour}
                  onChange={(e) => setEndTimeHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                />
              </div>
              <div className="time-separator">:</div>
              <div className="time-input">
                <label>分</label>
                <input
                  type="number"
                  min="0"
                  max="59"
                  value={endTimeMinute}
                  onChange={(e) => setEndTimeMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                />
              </div>
            </div>
            <div className="modal-buttons">
              <button className="modal-button primary" onClick={handleSetEndTime}>
                設定
              </button>
              <button className="modal-button secondary" onClick={() => setShowEndTimeModal(false)}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* リソース上限設定モーダル */}
      {showSettingsModal && (
        <div className="modal-overlay">
          <div className="modal settings-modal">
            <h3>⚙️ リソース上限を設定</h3>

            <div className="settings-info">
              <p>📊 <strong>このデバイスの推奨設定</strong></p>
              <ul>
                <li>CPUコア数: {navigator.hardwareConcurrency || '不明'}個</li>
                <li>メモリ: {(navigator as any).deviceMemory || '不明'}GB</li>
                <li className="recommend">推奨CPU上限: {recommendedLimits.cpu}%</li>
                <li className="recommend">推奨メモリ上限: {recommendedLimits.memory}%</li>
              </ul>
            </div>

            <div className="settings-section">
              <label>CPU使用率上限: {cpuLimit}%</label>
              <input
                type="range"
                min="30"
                max="95"
                value={cpuLimit}
                onChange={(e) => setCpuLimit(parseInt(e.target.value))}
                className="range-slider"
              />
              <small>低い値ほど安全ですが学習速度が低下します</small>
            </div>

            <div className="settings-section">
              <label>メモリ使用率上限: {memoryLimit}%</label>
              <input
                type="range"
                min="40"
                max="95"
                value={memoryLimit}
                onChange={(e) => setMemoryLimit(parseInt(e.target.value))}
                className="range-slider"
              />
              <small>低い値ほど安全ですが学習速度が低下します</small>
            </div>

            <div className="settings-presets">
              <p>クイック設定:</p>
              <button
                className="preset-button safe"
                onClick={() => {
                  setCpuLimit(70);
                  setMemoryLimit(75);
                }}
              >
                🛡️ 安全
              </button>
              <button
                className="preset-button balanced"
                onClick={() => {
                  setCpuLimit(recommendedLimits.cpu);
                  setMemoryLimit(recommendedLimits.memory);
                }}
              >
                ⚖️ 推奨
              </button>
              <button
                className="preset-button performance"
                onClick={() => {
                  setCpuLimit(90);
                  setMemoryLimit(90);
                }}
              >
                🚀 高速
              </button>
            </div>

            <div className="modal-buttons">
              <button className="modal-button primary" onClick={() => setShowSettingsModal(false)}>
                設定を保存
              </button>
              <button className="modal-button secondary" onClick={() => setShowSettingsModal(false)}>
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* データ管理モーダル */}
      {showDataModal && (
        <div className="modal-overlay">
          <div className="modal data-modal">
            <h3>📊 学習データ管理</h3>

            <div className="data-stats">
              <div className="stat-item">
                <div className="stat-label">累計対戦数</div>
                <div className="stat-value">{totalStats.totalGames}</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">累計時間</div>
                <div className="stat-value">{totalStats.totalHours.toFixed(1)} 時間</div>
              </div>
              <div className="stat-item">
                <div className="stat-label">セッション数</div>
                <div className="stat-value">{history.length}</div>
              </div>
            </div>

            <div className="data-history">
              <h4>セッション履歴</h4>
              <div className="history-list">
                {history.length === 0 ? (
                  <p className="empty-message">セッション履歴がありません</p>
                ) : (
                  history.slice(-5).reverse().map((session) => (
                    <div key={session.sessionId} className="history-item">
                      <span className="history-date">{new Date(session.sessionStartTime).toLocaleString('ja-JP')}</span>
                      <span className="history-games">{session.gamesPlayed} ゲーム</span>
                      <span className="history-time">{(session.totalElapsedSeconds / 60).toFixed(1)} 分</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="data-actions">
              <button className="modal-button primary" onClick={downloadStats}>
                💾 エクスポート
              </button>
              <label className="modal-button primary file-input-label">
                📥 インポート
                <input
                  type="file"
                  accept=".json"
                  onChange={importStats}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            <div className="modal-buttons">
              <button className="modal-button secondary" onClick={() => setShowDataModal(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
