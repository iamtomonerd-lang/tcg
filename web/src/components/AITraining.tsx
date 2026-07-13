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
  const [endTimeHour, setEndTimeHour] = useState(12);
  const [endTimeMinute, setEndTimeMinute] = useState(0);
  const trainingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);

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
          if (newCpuUsage > 80 || newMemoryUsage > 85) {
            systemHealth = 'hot';
          } else if (newCpuUsage > 70 || newMemoryUsage > 75) {
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
            <button className="back-button" onClick={onBack}>
              ← 戻る
            </button>
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
    </div>
  );
}
