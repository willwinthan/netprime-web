import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";

export const gamificationRouter = new Hono<Env>();

// Get gamification profile (level, EXP, achievements) for logged in student
gamificationRouter.get("/gamification/profile", rbac(["student", "partner", "admin"]), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  try {
    // 1. Fetch user profile or insert default if not exists
    let profile = await db
      .prepare("SELECT * FROM user_gamification WHERE user_id = ?")
      .bind(user.id)
      .first<{ user_id: string; exp: number; level: number; title: string }>();

    if (!profile) {
      await db
        .prepare(
          "INSERT INTO user_gamification (user_id, exp, level, title) VALUES (?, 0, 1, 'ผู้ฝึกหัดโค้ด')"
        )
        .bind(user.id)
        .run();
      profile = { user_id: user.id, exp: 0, level: 1, title: "ผู้ฝึกหัดโค้ด" };
    }

    // 2. Fetch all achievements
    const allAchievements = await db
      .prepare("SELECT * FROM achievements ORDER BY exp_reward ASC")
      .all<any>();

    // 3. Fetch unlocked achievements
    const unlockedList = await db
      .prepare("SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?")
      .bind(user.id)
      .all<{ achievement_id: string; unlocked_at: string }>();

    const unlockedMap = new Map(unlockedList.results.map((item) => [item.achievement_id, item.unlocked_at]));

    const achievementsData = allAchievements.results.map((ach: any) => ({
      id: ach.id,
      name: ach.name,
      description: ach.description,
      badgeIcon: ach.badge_icon,
      expReward: ach.exp_reward,
      unlocked: unlockedMap.has(ach.id),
      unlockedAt: unlockedMap.get(ach.id) || null,
    }));

    return c.json({
      exp: profile.exp,
      level: profile.level,
      title: profile.title,
      achievements: achievementsData,
    });
  } catch (error: any) {
    console.error("Fetch gamification profile failed:", error);
    return c.json({ error: "โหลดข้อมูลเกมมิฟิเคชันไม่สำเร็จ", message: error.message }, 500);
  }
});

// Get global students leaderboard
gamificationRouter.get("/gamification/leaderboard", rbac(["student", "partner", "admin"]), async (c) => {
  const db = c.env.DB;

  try {
    const leaderboard = await db
      .prepare(
        `SELECT ug.level, ug.exp, ug.title, u.name, u.email
         FROM user_gamification ug
         INNER JOIN users u ON ug.user_id = u.id
         WHERE u.role = 'student' AND u.staff_role IS NULL
         ORDER BY ug.exp DESC, ug.level DESC
         LIMIT 10`
      )
      .all();

    return c.json(leaderboard.results);
  } catch (error: any) {
    console.error("Fetch leaderboard failed:", error);
    return c.json({ error: "โหลดอันดับผู้เรียนไม่สำเร็จ", message: error.message }, 500);
  }
});
