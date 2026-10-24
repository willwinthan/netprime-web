import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";

export const notificationsRouter = new Hono<Env>();

// Get notifications for user
notificationsRouter.get("/notifications", rbac(), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  try {
    const notifications = await db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
      .bind(user.id)
      .all<any>();

    return c.json(notifications.results);
  } catch (error: any) {
    console.error("Fetch notifications failed:", error);
    return c.json({ error: "โหลดการแจ้งเตือนไม่สำเร็จ", message: error.message }, 500);
  }
});

// Mark all notifications as read
notificationsRouter.post("/notifications/read-all", rbac(), async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  try {
    await db
      .prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ?")
      .bind(user.id)
      .run();

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Mark notifications read failed:", error);
    return c.json({ error: "อัปเดตการแจ้งเตือนไม่สำเร็จ", message: error.message }, 500);
  }
});

// Helper utility function to create a notification
export async function createNotification(
  db: any,
  userId: string,
  title: string,
  content: string
): Promise<boolean> {
  try {
    const id = "ntf_" + Math.random().toString(36).substring(2, 15);
    await db
      .prepare("INSERT INTO notifications (id, user_id, title, content, is_read) VALUES (?, ?, ?, ?, 0)")
      .bind(id, userId, title, content)
      .run();
    return true;
  } catch (error) {
    console.error("Failed to create notification:", error);
    return false;
  }
}
