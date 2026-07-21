import { useState, useEffect } from 'react';
import './Achievements.css';

interface CardAchievement {
  cardId: string;
  cardName: string;
  maxRating: number;
  maxWinStreak: number;
  timesUsed: number;
}

interface AchievementsProps {
  onBack?: () => void;
}

export default function Achievements({ onBack }: AchievementsProps) {
  const [achievements, setAchievements] = useState<CardAchievement[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'rating' | 'streak'>('rating');

  useEffect(() => {
    const fetchAchievements = async () => {
      try {
        const response = await fetch('/api/achievements/stats');
        if (response.ok) {
          const data = await response.json();
          setAchievements(data.achievements || []);
        }
      } catch (err) {
        // サーバー未接続時はエラーではなく空状態を表示
        console.error('Failed to load achievements:', err);
      }
      setLoading(false);
    };
    fetchAchievements();
  }, []);

  const sortedAchievements = [...achievements].sort((a, b) => {
    if (sortBy === 'rating') {
      return b.maxRating - a.maxRating;
    } else {
      return b.maxWinStreak - a.maxWinStreak;
    }
  });

  if (loading) {
    return <div className="achievements loading">読み込み中...</div>;
  }

  return (
    <div className="achievements">
      <div className="achievements-header">
        <div className="header-row">
          {onBack && (
            <button className="header-back-button" onClick={onBack}>
              ← 戻る
            </button>
          )}
          <div>
            <h2>⭐ 実績</h2>
            <p>カードごとの最高成績を確認できます</p>
          </div>
        </div>
      </div>

      <div className="achievements-content">
        <div className="sort-controls">
          <button
            className={`sort-btn ${sortBy === 'rating' ? 'active' : ''}`}
            onClick={() => setSortBy('rating')}
          >
            📈 最高レート順
          </button>
          <button
            className={`sort-btn ${sortBy === 'streak' ? 'active' : ''}`}
            onClick={() => setSortBy('streak')}
          >
            🔥 連勝数順
          </button>
        </div>

        {sortedAchievements.length === 0 ? (
          <div className="empty-achievements">
            <p>実績はまだありません</p>
            <p className="hint">ランクマッチで対戦すると、カードごとの最高レートと最大連勝数がここに記録されます</p>
          </div>
        ) : (
          <div className="achievements-list">
            {sortedAchievements.map((achievement, index) => (
              <div key={achievement.cardId} className="achievement-card">
                <div className="rank-badge">{index + 1}</div>

                <div className="card-info">
                  <div className="card-name">{achievement.cardName}</div>
                  <div className="usage-count">
                    使用回数: {achievement.timesUsed}回
                  </div>
                </div>

                <div className="achievements-stats">
                  <div className="stat-box rating">
                    <div className="stat-icon">📈</div>
                    <div className="stat-label">最高レート</div>
                    <div className="stat-value">{achievement.maxRating}</div>
                  </div>

                  <div className="stat-box streak">
                    <div className="stat-icon">🔥</div>
                    <div className="stat-label">最大連勝</div>
                    <div className="stat-value">{achievement.maxWinStreak}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
