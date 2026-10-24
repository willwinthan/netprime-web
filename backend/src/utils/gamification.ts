import { D1Database } from "@cloudflare/workers-types";
import { createNotification } from "../handlers/notifications";

export interface GamificationResult {
  expAwarded: number;
  leveledUp: boolean;
  newLevel: number;
  newTitle: string;
  streakCount: number;
  streakBonus: number;
}

export function getTitleForLevel(level: number): string {
  if (level >= 10) return "อัศวินเทค Netprime";
  if (level >= 7) return "ผู้เชี่ยวชาญ Edge";
  if (level >= 4) return "นักสำรวจคลาวด์";
  return "ผู้ฝึกหัดโค้ด";
}

/**
 * Awards EXP to a user, checking for level-up thresholds and updating study streaks.
 */
export async function awardExp(
  db: D1Database,
  userId: string,
  amount: number
): Promise<GamificationResult> {
  // 1. Fetch current profile or create if it doesn't exist
  let profile = await db
    .prepare("SELECT * FROM user_gamification WHERE user_id = ?")
    .bind(userId)
    .first<{ user_id: string; exp: number; level: number; title: string; last_learn_date: string | null; streak_count: number }>();

  if (!profile) {
    await db
      .prepare(
        "INSERT INTO user_gamification (user_id, exp, level, title, streak_count) VALUES (?, 0, 1, 'ผู้ฝึกหัดโค้ด', 0)"
      )
      .bind(userId)
      .run();
    profile = { user_id: userId, exp: 0, level: 1, title: "ผู้ฝึกหัดโค้ด", last_learn_date: null, streak_count: 0 };
  }

  // Calculate Streak
  const todayStr = new Date().toISOString().slice(0, 10);
  let newStreak = profile.streak_count || 0;
  let streakBonus = 0;

  if (!profile.last_learn_date) {
    newStreak = 1;
  } else {
    const lastDateStr = profile.last_learn_date;
    if (lastDateStr !== todayStr) {
      const lastDate = new Date(lastDateStr + "T00:00:00");
      const today = new Date(todayStr + "T00:00:00");
      const diffTime = Math.abs(today.getTime() - lastDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        newStreak += 1;
        streakBonus = 50; // Award +50 EXP for maintaining the streak!
        amount += streakBonus;
        // Trigger notification for daily streak
        await createNotification(
          db, 
          userId, 
          `เรียนต่อเนื่องต่อไป! 🔥`, 
          `คุณเรียนต่อเนื่องครบ ${newStreak} วันแล้ว! รักษาสถิติไว้เพื่อรับ EXP โบนัส`
        );
      } else if (diffDays > 1) {
        newStreak = 1; // Reset streak
      }
    }
  }

  const oldLevel = profile.level;
  let newExp = profile.exp + amount;
  let newLevel = oldLevel;

  // Level threshold = (level - 1) * 500
  newLevel = Math.floor(newExp / 500) + 1;
  if (newLevel < 1) newLevel = 1;

  const leveledUp = newLevel > oldLevel;
  const newTitle = getTitleForLevel(newLevel);

  await db
    .prepare(
      "UPDATE user_gamification SET exp = ?, level = ?, title = ?, last_learn_date = ?, streak_count = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"
    )
    .bind(newExp, newLevel, newTitle, todayStr, newStreak, userId)
    .run();

  // Create notifications
  if (leveledUp) {
    await createNotification(
      db,
      userId,
      "เลเวลอัป! 🎉",
      `ยินดีด้วย! คุณขึ้นเลเวล ${newLevel} และได้รับตำแหน่ง "${newTitle}"`
    );
  }

  return {
    expAwarded: amount,
    leveledUp,
    newLevel,
    newTitle,
    streakCount: newStreak,
    streakBonus
  };
}

/**
 * Unlocks an achievement badge for a user and awards the associated EXP.
 */
export async function unlockAchievement(
  db: D1Database,
  userId: string,
  achievementId: string
): Promise<{ success: boolean; unlocked: boolean; achievementName?: string }> {
  // Check if already unlocked
  const existing = await db
    .prepare("SELECT user_id FROM user_achievements WHERE user_id = ? AND achievement_id = ?")
    .bind(userId, achievementId)
    .first();

  if (existing) {
    return { success: false, unlocked: false };
  }

  // Get achievement details
  const ach = await db
    .prepare("SELECT name, exp_reward FROM achievements WHERE id = ?")
    .bind(achievementId)
    .first<{ name: string; exp_reward: number }>();

  if (!ach) {
    return { success: false, unlocked: false };
  }

  // Insert unlock mapping
  await db
    .prepare("INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)")
    .bind(userId, achievementId)
    .run();

  // Award EXP
  await awardExp(db, userId, ach.exp_reward);

  // Send Notification
  await createNotification(
    db,
    userId,
    "ปลดล็อกความสำเร็จ! 🏆",
    `คุณปลดล็อกเหรียญตรา "${ach.name}" และได้รับ +${ach.exp_reward} EXP!`
  );

  return {
    success: true,
    unlocked: true,
    achievementName: ach.name,
  };
}
