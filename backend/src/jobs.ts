import type { Env } from "./middleware/rbac";
import { sendSessionReminders } from "./handlers/site";
import { purgeExpiredTokens } from "./utils/tokens";
import { processBroadcastQueue } from "./handlers/communication";
import { runWebhookRetries } from "./handlers/platform";
import { syncAffiliateConversions } from "./handlers/marketing";
import { runCommerceJobs } from "./handlers/commerce";

export interface DailyJobResult {
  reminders: { sent: number; registration_ids: string[] };
  tokens_purged: boolean;
}

/** The daily work itself; also run on demand by POST /api/admin/site/jobs/run. Safe to repeat. */
export async function runDailyJobs(env: Env["Bindings"]): Promise<DailyJobResult> {
  const result: DailyJobResult = { reminders: { sent: 0, registration_ids: [] }, tokens_purged: false };
  // Each job is isolated so one failure does not skip the others.
  try { result.reminders = await sendSessionReminders(env); } catch (error) { console.error("Session reminders failed:", error); }
  try { await purgeExpiredTokens(env.DB); result.tokens_purged = true; } catch (error) { console.error("Token purge failed:", error); }
  try { await processBroadcastQueue(env, { maxBatches: 20 }); } catch (error) { console.error("Broadcast queue failed:", error); }
  try { await syncAffiliateConversions(env.DB); } catch (error) { console.error("Affiliate conversion sync failed:", error); }
  try { await runWebhookRetries(env); } catch (error) { console.error("Webhook retries failed:", error); }
  try { await runCommerceJobs(env); } catch (error) { console.error("Commerce jobs failed:", error); }
  return result;
}

/** Scheduled work (wrangler.jsonc "triggers.crons"); each job must be safe to run more than once a day. */
export async function runScheduledJobs(env: Env["Bindings"], ctx: ExecutionContext): Promise<void> {
  void ctx;
  await runDailyJobs(env);
}
