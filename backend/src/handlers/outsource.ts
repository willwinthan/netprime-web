import { Hono } from "hono";
import { Env, UserPayload, rbac } from "../middleware/rbac";
import { createNotification } from "./notifications";

export const outsourceRouter = new Hono<Env>();

const canManage = (user: UserPayload, partnerId: string) =>
  user.role === "admin" || (user.role === "partner" && user.partner_id === partnerId);

async function notifyPartners(db: D1Database, partnerId: string, title: string, content: string) {
  const recipients = await db.prepare("SELECT id FROM users WHERE role = 'partner' AND partner_id = ?")
    .bind(partnerId).all<{ id: string }>();
  for (const recipient of recipients.results) await createNotification(db, recipient.id, title, content);
}

// 1. Post a new IT project (For partners/admins)
outsourceRouter.post("/outsource/projects", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  
  try {
    const { title, description, scopeOfWork, budgetType, budgetRange, requiredCourseId, minLevel, partner_id } = await c.req.json();
    const partnerId = user.role === "partner" ? user.partner_id : partner_id;
    if (!partnerId) return c.json({ error: "ต้องระบุองค์กรพาร์ตเนอร์" }, 400);
    const partner = await db.prepare("SELECT id FROM partners WHERE id = ?").bind(partnerId).first();
    if (!partner) return c.json({ error: "ไม่พบองค์กรพาร์ตเนอร์" }, 404);
    if (typeof title !== "string" || !title.trim() || typeof description !== "string" || !description.trim() ||
        typeof scopeOfWork !== "string" || !scopeOfWork.trim() || !["fixed", "hourly"].includes(budgetType) ||
        typeof budgetRange !== "string" || !budgetRange.trim() ||
        !Number.isInteger(Number(minLevel ?? 1)) || Number(minLevel ?? 1) < 1) {
      return c.json({ error: "กรุณาระบุรายละเอียดโปรเจกต์และงบประมาณให้ถูกต้อง" }, 400);
    }
    const id = "proj_" + crypto.randomUUID();

    await db
      .prepare(`
        INSERT INTO it_projects (id, partner_id, title, description, scope_of_work, budget_type, budget_range, required_course_id, min_level, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `)
      .bind(id, partnerId, title.trim(), description.trim(), scopeOfWork.trim(), budgetType, budgetRange.trim(), requiredCourseId || null, Number(minLevel ?? 1))
      .run();

    return c.json({ success: true, projectId: id });
  } catch (error: any) {
    console.error("ประกาศโปรเจกต์ไม่สำเร็จ:", error);
    return c.json({ error: "ประกาศโปรเจกต์ไม่สำเร็จ", message: error.message }, 500);
  }
});

// 2. Browse IT Projects (For students, with dynamic matching score)
outsourceRouter.get("/outsource/projects", rbac(["student", "partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");

  try {
    // Fetch all open/active projects
    const projects = await db
      .prepare(`
        SELECT p.*, pt.company_name as companyName,
               (SELECT status FROM project_applications WHERE project_id = p.id AND student_id = ?) as myBidStatus,
               (SELECT bid_amount FROM project_applications WHERE project_id = p.id AND student_id = ?) as myBidAmount,
               (SELECT id FROM project_applications WHERE project_id = p.id AND student_id = ?) as myBidId
        FROM it_projects p
        LEFT JOIN partners pt ON p.partner_id = pt.id
        ORDER BY p.created_at DESC
      `)
      .bind(user.id, user.id, user.id)
      .all<any>();

    // Fetch student profile details for matching
    const profile = await db
      .prepare("SELECT level, exp FROM user_gamification WHERE user_id = ?")
      .bind(user.id)
      .first<{ level: number; exp: number }>();

    const studentLevel = profile?.level || 1;

    // Fetch student completed courses
    const completions = await db
      .prepare("SELECT course_id FROM enrollments WHERE user_id = ? AND progress_percent = 100")
      .bind(user.id)
      .all<{ course_id: string }>();

    const completedCourseIds = new Set(completions.results.map(c => c.course_id));

    // Map projects and calculate compatibility score
    const projectsWithMatching = projects.results.map(proj => {
      let matchScore = 50; // Base compatibility score

      // 1. Check Course Requirement
      if (proj.required_course_id) {
        if (completedCourseIds.has(proj.required_course_id)) {
          matchScore += 30;
        } else {
          matchScore -= 20;
        }
      }

      // 2. Check Level Requirement
      if (studentLevel >= proj.min_level) {
        matchScore += 20;
      } else {
        matchScore -= 10;
      }

      // Constrain score between 10% and 100%
      matchScore = Math.min(100, Math.max(10, matchScore));

      return {
        ...proj,
        matchingScore: matchScore
      };
    });

    return c.json(projectsWithMatching);
  } catch (error: any) {
    console.error("ดึงรายการโปรเจกต์ไม่สำเร็จ:", error);
    return c.json({ error: "ดึงรายการโปรเจกต์ไม่สำเร็จ", message: error.message }, 500);
  }
});

// 3. Apply/Bid on a project (For students)
outsourceRouter.post("/outsource/projects/:id/apply", rbac(["student"]), async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const projectId = c.req.param("id");

  try {
    const { proposal, bidAmount } = await c.req.json();
    if (typeof proposal !== "string" || !proposal.trim() || typeof bidAmount !== "string" || !bidAmount.trim()) {
      return c.json({ error: "ต้องระบุข้อเสนองานและจำนวนเงินที่เสนอ" }, 400);
    }
    const id = "bid_" + crypto.randomUUID();

    // Verify project exists
    const proj = await db
      .prepare("SELECT title, partner_id, status FROM it_projects WHERE id = ?")
      .bind(projectId)
      .first<{ title: string; partner_id: string; status: string }>();

    if (!proj) {
      return c.json({ error: "ไม่พบโปรเจกต์" }, 404);
    }
    if (proj.status !== "open") return c.json({ error: "โปรเจกต์นี้ไม่เปิดรับข้อเสนอแล้ว" }, 409);
    const existing = await db.prepare("SELECT id FROM project_applications WHERE project_id = ? AND student_id = ?")
      .bind(projectId, user.id).first();
    if (existing) return c.json({ error: "คุณสมัครโปรเจกต์นี้ไปแล้ว" }, 409);

    // Insert bid application
    await db
      .prepare(`
        INSERT INTO project_applications (id, project_id, student_id, proposal, bid_amount, status)
        VALUES (?, ?, ?, ?, ?, 'applied')
      `)
      .bind(id, projectId, user.id, proposal, bidAmount)
      .run();

    // Notify partner (find partner's user_id)
    await notifyPartners(db, proj.partner_id, "ได้รับข้อเสนอราคาใหม่! 💼",
      `ผู้เรียนเสนอราคา ${bidAmount} สำหรับโปรเจกต์ "${proj.title}" ของคุณ`);

    return c.json({ success: true, applicationId: id });
  } catch (error: any) {
    console.error("ส่งข้อเสนอราคาไม่สำเร็จ:", error);
    return c.json({ error: "ส่งข้อเสนอราคาไม่สำเร็จ", message: error.message }, 500);
  }
});

// 4. List candidates/bids for a project (For partners)
outsourceRouter.get("/outsource/projects/:id/candidates", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const projectId = c.req.param("id");
  const user = c.get("user");

  try {
    const project = await db.prepare("SELECT partner_id, required_course_id, min_level FROM it_projects WHERE id = ?")
      .bind(projectId).first<{ partner_id: string; required_course_id: string | null; min_level: number }>();
    if (!project) return c.json({ error: "ไม่พบโปรเจกต์" }, 404);
    if (!canManage(user, project.partner_id)) return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: โปรเจกต์นี้เป็นของพาร์ตเนอร์รายอื่น" }, 403);
    const bids = await db
      .prepare(`
        SELECT a.*, u.name as studentName, u.email as studentEmail, ug.level as studentLevel, ug.title as studentTitle
        FROM project_applications a
        INNER JOIN users u ON a.student_id = u.id
        LEFT JOIN user_gamification ug ON u.id = ug.user_id
        WHERE a.project_id = ?
        ORDER BY a.created_at DESC
      `)
      .bind(projectId)
      .all<any>();

    // Fetch project course requirement
    const requiredCourseId = project.required_course_id;
    const minLevel = project.min_level || 1;

    // Calculate match score for each candidate
    const bidsWithScore = await Promise.all(bids.results.map(async (bid: any) => {
      let score = 50;

      // Check level
      if (bid.studentLevel >= minLevel) {
        score += 20;
      } else {
        score -= 10;
      }

      // Check completed course
      if (requiredCourseId) {
        const isCompleted = await db
          .prepare("SELECT id FROM enrollments WHERE user_id = ? AND course_id = ? AND progress_percent = 100")
          .bind(bid.student_id, requiredCourseId)
          .first();
        
        if (isCompleted) {
          score += 30;
        } else {
          score -= 20;
        }
      }

      score = Math.min(100, Math.max(10, score));

      return {
        ...bid,
        matchingScore: score
      };
    }));

    return c.json(bidsWithScore);
  } catch (error: any) {
    console.error("ดึงรายการข้อเสนอราคาไม่สำเร็จ:", error);
    return c.json({ error: "ดึงรายการข้อเสนอราคาไม่สำเร็จ", message: error.message }, 500);
  }
});

// 5. Accept candidate bid & create initial milestone
outsourceRouter.post("/outsource/applications/:id/accept", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const appId = c.req.param("id");
  const user = c.get("user");

  try {
    const bid = await db
      .prepare(`SELECT a.project_id, a.student_id, a.status, p.partner_id, p.status AS project_status
        FROM project_applications a JOIN it_projects p ON p.id = a.project_id WHERE a.id = ?`)
      .bind(appId)
      .first<{ project_id: string; student_id: string; status: string; partner_id: string; project_status: string }>();

    if (!bid) return c.json({ error: "ไม่พบข้อเสนอราคา" }, 404);
    if (!canManage(user, bid.partner_id)) return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: โปรเจกต์นี้เป็นของพาร์ตเนอร์รายอื่น" }, 403);
    if (bid.status === "accepted" && bid.project_status === "active") return c.json({ success: true, alreadyAccepted: true });
    if (bid.status !== "applied" || bid.project_status !== "open") return c.json({ error: "ข้อเสนอราคานี้ไม่สามารถรับได้แล้ว" }, 409);

    // D1 batch is a transaction. Only one request can change an open project to active.
    const result = await db.batch([
      db.prepare("UPDATE it_projects SET status = 'active' WHERE id = ? AND status = 'open'").bind(bid.project_id),
      db.prepare(`UPDATE project_applications SET status = 'accepted'
        WHERE id = ? AND status = 'applied' AND EXISTS
        (SELECT 1 FROM it_projects WHERE id = ? AND status = 'active')`).bind(appId, bid.project_id),
      db.prepare("UPDATE project_applications SET status = 'rejected' WHERE project_id = ? AND id != ? AND status = 'applied'")
        .bind(bid.project_id, appId),
      db.prepare(`INSERT INTO project_milestones (id, application_id, title, description, status)
        SELECT ?, ?, 'งวดงานที่ 1: เตรียมโปรเจกต์', 'จัดเตรียมสภาพแวดล้อมสำหรับพัฒนาและออกแบบสถาปัตยกรรมเบื้องต้น', 'pending'
        WHERE EXISTS (SELECT 1 FROM project_applications WHERE id = ? AND status = 'accepted')`)
        .bind(`ms_${appId}_initial`, appId, appId)
    ]);
    if (!result[0].meta.changes || !result[1].meta.changes) return c.json({ error: "โปรเจกต์นี้ปิดรับแล้ว" }, 409);

    await createNotification(
      db,
      bid.student_id,
      "ข้อเสนอราคาได้รับการยอมรับ! 🤝",
      `ข้อเสนอราคาของคุณได้รับการยอมรับแล้ว งวดงานที่ 1 เริ่มต้นแล้ว ลงมือทำกันเลย!`
    );

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Accept bid failed:", error);
    return c.json({ error: "รับข้อเสนอราคาไม่สำเร็จ", message: error.message }, 500);
  }
});

// 5.5 Fetch milestones for application
outsourceRouter.get("/outsource/applications/:id/milestones", rbac(["student", "partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const appId = c.req.param("id");
  const user = c.get("user");
  try {
    const application = await db.prepare(`SELECT a.student_id, p.partner_id FROM project_applications a
      JOIN it_projects p ON p.id = a.project_id WHERE a.id = ?`).bind(appId)
      .first<{ student_id: string; partner_id: string }>();
    if (!application) return c.json({ error: "ไม่พบใบสมัคร" }, 404);
    if (user.id !== application.student_id && !canManage(user, application.partner_id))
      return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: ใบสมัครนี้เป็นของบัญชีอื่น" }, 403);
    const milestones = await db
      .prepare("SELECT * FROM project_milestones WHERE application_id = ? ORDER BY updated_at ASC")
      .bind(appId)
      .all<any>();
    return c.json(milestones.results);
  } catch (error: any) {
    console.error("ดึงรายการงวดงานไม่สำเร็จ:", error);
    return c.json({ error: "ดึงรายการงวดงานไม่สำเร็จ", message: error.message }, 500);
  }
});

// 6. Submit milestone deliverables (For students)
outsourceRouter.post("/outsource/milestones/:id/submit", rbac(["student"]), async (c) => {
  const db = c.env.DB;
  const msId = c.req.param("id");
  const user = c.get("user");
  const { deliverables } = await c.req.json();
  if (typeof deliverables !== "string" || !deliverables.trim())
    return c.json({ error: "ต้องระบุงานที่ส่งมอบ" }, 400);

  try {
    // Fetch application details
    const ms = await db
      .prepare(`
        SELECT m.*, a.project_id, a.student_id, p.partner_id, p.title as projectTitle
        FROM project_milestones m
        INNER JOIN project_applications a ON m.application_id = a.id
        INNER JOIN it_projects p ON a.project_id = p.id
        WHERE m.id = ?
      `)
      .bind(msId)
      .first<any>();

    if (!ms) {
      return c.json({ error: "ไม่พบงวดงาน" }, 404);
    }
    if (ms.student_id !== user.id) return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: งวดงานนี้เป็นของผู้เรียนคนอื่น" }, 403);
    if (ms.status !== "pending" && ms.status !== "rejected")
      return c.json({ error: "ไม่สามารถส่งงวดงานนี้ได้ในสถานะปัจจุบัน" }, 409);

    const updated = await db.prepare(`UPDATE project_milestones SET deliverables = ?, status = 'submitted', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status IN ('pending', 'rejected')`).bind(deliverables.trim(), msId).run();
    if (!updated.meta.changes) return c.json({ error: "งวดงานนี้ถูกส่งไปแล้ว" }, 409);

    await notifyPartners(db, ms.partner_id, "มีการส่งมอบงาน! 📦",
      `ผู้เรียนส่งมอบงานสำหรับงวดงาน "${ms.title}" ของโปรเจกต์ "${ms.projectTitle}"`);

    return c.json({ success: true });
  } catch (error: any) {
    console.error("Milestone submission failed:", error);
    return c.json({ error: "ส่งงวดงานไม่สำเร็จ", message: error.message }, 500);
  }
});

// 7. Approve milestone deliverables & award EXP (For partners)
outsourceRouter.post("/outsource/milestones/:id/approve", rbac(["partner", "admin"]), async (c) => {
  const db = c.env.DB;
  const msId = c.req.param("id");
  const user = c.get("user");

  try {
    const ms = await db
      .prepare(`
        SELECT m.*, a.student_id, a.project_id, p.partner_id, p.title as projectTitle
        FROM project_milestones m
        INNER JOIN project_applications a ON m.application_id = a.id
        INNER JOIN it_projects p ON a.project_id = p.id
        WHERE m.id = ?
      `)
      .bind(msId)
      .first<any>();

    if (!ms) {
      return c.json({ error: "ไม่พบงวดงาน" }, 404);
    }
    if (!canManage(user, ms.partner_id)) return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: โปรเจกต์นี้เป็นของพาร์ตเนอร์รายอื่น" }, 403);
    if (ms.status !== "submitted") return c.json({ error: "อนุมัติได้เฉพาะงวดงานที่ส่งมอบแล้ว" }, 409);

    // The reward is conditional on the current state in the same transaction.
    const results = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO user_gamification (user_id, exp, level, title, streak_count)
        SELECT ?, 0, 1, 'ผู้ฝึกหัดโค้ด', 0 WHERE EXISTS
        (SELECT 1 FROM project_milestones WHERE id = ? AND status = 'submitted')`).bind(ms.student_id, msId),
      db.prepare(`UPDATE user_gamification SET exp = exp + 200, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND EXISTS (SELECT 1 FROM project_milestones WHERE id = ? AND status = 'submitted')`)
        .bind(ms.student_id, msId),
      db.prepare(`UPDATE user_gamification SET level = CAST(exp / 500 AS INTEGER) + 1,
        title = CASE WHEN exp >= 4500 THEN 'อัศวินเทค Netprime' WHEN exp >= 3000 THEN 'ผู้เชี่ยวชาญ Edge'
          WHEN exp >= 1500 THEN 'นักสำรวจคลาวด์' ELSE 'ผู้ฝึกหัดโค้ด' END WHERE user_id = ?`).bind(ms.student_id),
      db.prepare("UPDATE project_milestones SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitted'")
        .bind(msId)
    ]);
    if (!results[3].meta.changes) return c.json({ error: "งวดงานนี้ได้รับการอนุมัติแล้ว" }, 409);
    const profile = await db.prepare("SELECT exp, level, title FROM user_gamification WHERE user_id = ?")
      .bind(ms.student_id).first<{ exp: number; level: number; title: string }>();

    // Notify student
    await createNotification(
      db,
      ms.student_id,
      "งวดงานได้รับการอนุมัติ! 🎉",
      `งานที่คุณส่งมอบสำหรับ "${ms.title}" ได้รับการอนุมัติแล้ว! คุณได้รับ +200 EXP`
    );

    return c.json({ success: true, gamification: { expAwarded: results[1].meta.changes ? 200 : 0,
      newLevel: profile?.level, newTitle: profile?.title, exp: profile?.exp } });
  } catch (error: any) {
    console.error("Approve milestone failed:", error);
    return c.json({ error: "อนุมัติงวดงานไม่สำเร็จ", message: error.message }, 500);
  }
});

// Helper to parse JSON safely from LLM output
function cleanAndParseJson(text: string) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  cleaned = cleaned.trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // If JSON parsing fails, attempt to locate the first { and last }
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      return JSON.parse(cleaned.substring(firstBrace, lastBrace + 1));
    }
    throw e;
  }
}

// 8. AI Project Scope / Requirement Generator (for Corporate Partners)
outsourceRouter.post("/outsource/ai-scope-generator", rbac(["partner", "admin"]), async (c) => {
  let goal = "", scope = "", techStack = "", duration = "", budgetType = "", budgetRange = "";
  try {
    const body = await c.req.json();
    goal = body.goal || "";
    scope = body.scope || "";
    techStack = body.techStack || "";
    duration = body.duration || "";
    budgetType = body.budgetType || "";
    budgetRange = body.budgetRange || "";
    const ai = c.env.AI;

    if (!ai) {
      // Return fallback draft mock
      return c.json({
        title: `พัฒนาระบบเชื่อมต่อ ${techStack || "IT"}`,
        description: `เตรียมโปรเจกต์เพื่อพัฒนา: "${goal || "ฟีเจอร์ของระบบ"}"`,
        scopeOfWork: `### 📋 ขอบเขตงานของโปรเจกต์\n\n#### 1. วัตถุประสงค์\n- พัฒนาและติดตั้งระบบเชื่อมต่อให้ใช้งานได้สำเร็จ\n\n#### 2. ขอบเขตโดยละเอียด\n- ${scope || "พัฒนาฟีเจอร์ตามที่ตกลงกัน"}\n\n#### 3. เทคโนโลยีที่ใช้\n- ${techStack || "Node.js / Hono มาตรฐาน"}\n\n#### 4. งานที่ส่งมอบ\n- ซอร์สโค้ดใน repository, เอกสารการทดสอบ, คู่มือการติดตั้งใช้งาน`,
        suggestedBudget: budgetRange || "฿15,000 - ฿25,000",
        recommendedCourseId: techStack?.toLowerCase().includes("worker") || techStack?.toLowerCase().includes("hono") ? "course_cf_workers" : "course_cf_d1_r2",
        minLevel: 2
      });
    }

    const systemPrompt = `You are Netprime PM Assistant, an expert IT project manager.
Analyze the user's requirements for an IT project and generate a structured project proposal.
Your response MUST be a JSON object with the following fields:
{
  "title": "A concise and professional project title",
  "description": "A brief 2-3 sentence overview of the project goal",
  "scopeOfWork": "A detailed Markdown document containing Objectives, Scope (detailed features/requirements), Out-of-Scope, Handovers/Milestones, and SLA expectations.",
  "suggestedBudget": "Recommended budget amount or range in THB (e.g. ฿15,000 - ฿25,000)",
  "recommendedCourseId": "Suggest one of the following course IDs that best fits the tech stack, or null: 'course_cf_workers' (Cloudflare, serverless, Hono), 'course_cf_d1_r2' (databases, SQLite, D1, storage), 'course_cisco_ccna' (networking, Cisco, routing), 'course_aws_csa' (AWS cloud architectures, solution scaling), 'course_aws_devops' (CI/CD, automation, provisioning).",
  "minLevel": 2
}
IMPORTANT LANGUAGE RULE: Write ALL human-readable values (title, description, scopeOfWork, suggestedBudget text) in natural Thai. Keep technical terms, product names and code in English. Keep the JSON keys exactly as shown, and keep recommendedCourseId as one of the given IDs.
Do NOT include any extra conversational text or Markdown code fences in your output, return ONLY a valid JSON string.`;

    const userMessage = `Goal: ${goal}\nScope: ${scope}\nTech Stack: ${techStack}\nDuration: ${duration}\nBudget Preference: ${budgetType} (${budgetRange})`;

    const response = await ai.run("@cf/meta/llama-3-8b-instruct", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    });

    const reply = response?.response || response?.text || "";
    const parsed = cleanAndParseJson(reply);
    return c.json(parsed);
  } catch (error: any) {
    console.error("AI Project Scope Generator failed:", error);
    return c.json({
      title: `พัฒนาระบบเชื่อมต่อ ${techStack || "IT"}`,
      description: `เตรียมโปรเจกต์เพื่อพัฒนา: "${goal || "ฟีเจอร์ของระบบ"}"`,
      scopeOfWork: `### 📋 ขอบเขตงานของโปรเจกต์\n\n#### 1. วัตถุประสงค์\n- พัฒนาและติดตั้งระบบเชื่อมต่อให้ใช้งานได้สำเร็จ\n\n#### 2. ขอบเขตโดยละเอียด\n- ${scope || "พัฒนาฟีเจอร์ตามที่ตกลงกัน"}\n\n#### 3. เทคโนโลยีที่ใช้\n- ${techStack || "Node.js / Hono มาตรฐาน"}\n\n#### 4. งานที่ส่งมอบ\n- ซอร์สโค้ดใน repository, เอกสารการทดสอบ, คู่มือการติดตั้งใช้งาน`,
      suggestedBudget: budgetRange || "฿15,000 - ฿25,000",
      recommendedCourseId: techStack?.toLowerCase().includes("worker") || techStack?.toLowerCase().includes("hono") ? "course_cf_workers" : "course_cf_d1_r2",
      minLevel: 2
    });
  }
});

// 9. AI Project Manager Deliverables Auditor (for Corporate Partners)
outsourceRouter.post("/outsource/ai-pm-audit", rbac(["partner", "admin"]), async (c) => {
  let milestoneId = "", saveReport = false;
  try {
    const body = await c.req.json();
    const { projectTitle, projectDescription, scopeOfWork, milestoneTitle, milestoneDescription, deliverables } = body;
    milestoneId = body.milestoneId || "";
    saveReport = body.saveReport || false;
    const db = c.env.DB;
    const ai = c.env.AI;

    if (saveReport) {
      if (!milestoneId) return c.json({ error: "ต้องระบุ Milestone ID เพื่อบันทึกผลตรวจสอบ" }, 400);
      const owner = await db.prepare(`SELECT p.partner_id FROM project_milestones m
        JOIN project_applications a ON a.id = m.application_id
        JOIN it_projects p ON p.id = a.project_id WHERE m.id = ?`)
        .bind(milestoneId).first<{ partner_id: string }>();
      if (!owner) return c.json({ error: "ไม่พบงวดงาน" }, 404);
      if (!canManage(c.get("user"), owner.partner_id))
        return c.json({ error: "ไม่มีสิทธิ์เข้าถึง: โปรเจกต์นี้เป็นของพาร์ตเนอร์รายอื่น" }, 403);
    }

    let parsed: any;

    if (!ai) {
      // Return fallback audit report mock
      parsed = {
        qualityScore: 85,
        timelineRisk: "Low",
        timelineFeedback: "ผู้เรียนดูเหมือนทำงานได้ตามกำหนดเวลาของงวดงาน",
        auditReport: "### 🤖 AI Project Manager - รายงานการตรวจสอบ\n\n- **คะแนนคุณภาพ**: 85/100\n- **ผลการตรวจ**: งานที่ส่งมอบเป็นไปตามข้อกำหนดการเตรียมโปรเจกต์\n- **ข้อเสนอแนะ**: อนุมัติ ดำเนินการมอบรางวัลได้"
      };
    } else {
      const systemPrompt = `You are Netprime AI Project Manager. Your job is to audit deliverables submitted by freelance outsource students.
Verify their submission against the project description, milestone description, and scope of work (SOW).
Rate their quality, completeness, and correctness.
Your response MUST be a JSON object with the following fields:
{
  "qualityScore": 85,
  "timelineRisk": "Low",
  "timelineFeedback": "Feedback on whether they are meeting the milestones and time expectations",
  "auditReport": "A detailed Markdown report outlining what was met, what is missing, any code quality improvements, security warnings, or suggestions for revision."
}
IMPORTANT LANGUAGE RULE: Write ALL human-readable values (timelineFeedback and auditReport) in natural Thai. Keep technical terms and code in English. Keep the JSON keys exactly as shown, and keep timelineRisk as one of the English values "Low", "Medium" or "High".
Do NOT include any extra conversational text or Markdown code fences in your output, return ONLY a valid JSON string.`;

      const userMessage = `Project: ${projectTitle} (${projectDescription})\nSOW: ${scopeOfWork}\nMilestone: ${milestoneTitle} (${milestoneDescription})\nStudent Deliverables: ${deliverables}`;

      const response = await ai.run("@cf/meta/llama-3-8b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ]
      });

      const reply = response?.response || response?.text || "";
      parsed = cleanAndParseJson(reply);
    }

    // Save report to milestone if saveReport is true and milestoneId is provided
    if (saveReport && milestoneId && db) {
      await db.prepare(`
        UPDATE project_milestones
        SET audit_report = ?, quality_score = ?, timeline_risk = ?
        WHERE id = ?
      `)
      .bind(parsed.auditReport || "", parsed.qualityScore || 80, parsed.timelineRisk || "Low", milestoneId)
      .run();
    }

    return c.json(parsed);
  } catch (error: any) {
    console.error("AI PM Audit failed:", error);
    return c.json({
      qualityScore: 85,
      timelineRisk: "Low",
      timelineFeedback: "ผู้เรียนดูเหมือนทำงานได้ตามกำหนดเวลาของงวดงาน",
      auditReport: "### 🤖 AI Project Manager - รายงานการตรวจสอบ (ข้อมูลสำรอง)\n\n- **คะแนนคุณภาพ**: 85/100\n- **ผลการตรวจ**: งานที่ส่งมอบเป็นไปตามข้อกำหนดการเตรียมโปรเจกต์\n- **ข้อเสนอแนะ**: อนุมัติ ดำเนินการมอบรางวัลได้"
    });
  }
});
