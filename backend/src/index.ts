import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRouter } from "./handlers/auth";
import { coursesRouter } from "./handlers/courses";
import { businessRouter } from "./handlers/business";
import { studentRouter } from "./handlers/student";
import { adminRouter } from "./handlers/admin";
import { instructorRouter } from "./handlers/instructor";
import { internshipRouter } from "./handlers/internship";
import { gamificationRouter } from "./handlers/gamification";
import { aiRouter } from "./handlers/ai";
import { notificationsRouter } from "./handlers/notifications";
import { outsourceRouter } from "./handlers/outsource";
import { publicSiteRouter, adminSiteRouter } from "./handlers/site";
import { accountsRouter } from "./handlers/accounts";
import { privacyRouter } from "./handlers/privacy";
import { Env } from "./middleware/rbac";
import { allowedOrigins } from "./utils/origins";
import { runScheduledJobs } from "./jobs";
import { configureEmailSender } from "./utils/email";

const app = new Hono<Env>();

app.use("*", async (c, next) => {
  configureEmailSender(c.env.EMAIL_FROM);
  await next();
});

// Enable CORS for frontend integration
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => allowedOrigins(c.env.FRONTEND_ORIGINS).includes(origin) ? origin : undefined,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: false,
  })
);

// Register base health-check route
app.get("/", (c) => {
  return c.text("Netprime Internal LMS Edge API Node is operational.");
});

// Register sub-routers under /api
app.route("/api/auth", authRouter);
app.route("/api/public", publicSiteRouter);
app.route("/api/admin/site", adminSiteRouter);
app.route("/api/admin", accountsRouter);
app.route("/api", coursesRouter);
app.route("/api", businessRouter);
app.route("/api", studentRouter);
app.route("/api", adminRouter);
app.route("/api", instructorRouter);
app.route("/api", internshipRouter);
app.route("/api", gamificationRouter);
app.route("/api", aiRouter);
app.route("/api", notificationsRouter);
app.route("/api", outsourceRouter);
app.route("/api", privacyRouter);

// Global Error Handler
app.onError((err, c) => {
  console.error("Unhandle exception caught inside Worker:", err);
  if (err instanceof SyntaxError) return c.json({ error: "รูปแบบ JSON ไม่ถูกต้อง" }, 400);
  return c.json({ error: "เกิดข้อผิดพลาดภายในระบบ" }, 500);
});

// Global 404 Handler
app.notFound((c) => {
  return c.json({ error: "ไม่พบเส้นทางที่ร้องขอ" }, 404);
});

export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: Env["Bindings"], ctx: ExecutionContext) => {
    configureEmailSender(env.EMAIL_FROM);
    ctx.waitUntil(runScheduledJobs(env, ctx));
  }
};
export { app };
