import { Hono } from "hono";
import { Env, rbac } from "../middleware/rbac";

export const aiRouter = new Hono<Env>();

aiRouter.post("/ai/chat", rbac(["student"]), async (c) => {
  try {
    const { message, history, courseTitle, lessonTitle } = await c.req.json();
    const ai = c.env.AI;

    if (!ai) {
      // Return a simulated mock response for local testing if AI binding is unavailable
      return c.json({ 
        reply: `**[โหมดจำลองในเครื่อง]** ได้รับข้อความของคุณแล้ว: "${message}" เชื่อมต่อ Cloudflare Workers AI เพื่อรับคำตอบจริงแบบ edge-native ได้เลย! เคล็ดลับสำหรับบทเรียน **"${lessonTitle || "บทนำ"}"** ในคอร์ส **"${courseTitle || "คอร์ส"}"**: ตรวจสอบ environment bindings ใน Hono ผ่าน \`c.env\` เสมอ` 
      });
    }

    const systemPrompt = `You are Antigravity AI Tutor, an interactive teaching assistant for Netprime LMS. You are helping a student in the course "${courseTitle || 'General Studies'}", specifically on the lesson "${lessonTitle || 'Introduction'}".
ALWAYS answer in Thai (ภาษาไทย) in a polite, concise, and natural tone, regardless of the language the student uses. Keep technical terms, product names, commands, and code in English.
Answer technical questions precisely, supportively, and using rich Markdown styling.
Explain coding concepts clearly. If the student asks for code, provide clean, commented JavaScript or TypeScript code examples (code comments may be in Thai).`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(history || []).map((msg: any) => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.text
      })),
      { role: "user", content: message }
    ];

    const response = await ai.run("@cf/meta/llama-3-8b-instruct", {
      messages
    });

    const reply = response?.response || response?.text || "ขออภัย ไม่สามารถสร้างคำตอบได้ กรุณาลองใหม่อีกครั้ง";

    return c.json({ reply });
  } catch (error: any) {
    console.error("AI Chat failed:", error);
    return c.json({ 
      reply: `**[โหมดสำรองในเครื่อง]** เชื่อมต่อโหนด AI ไม่สำเร็จ โปรดตรวจสอบว่า wrangler ทำงานอยู่พร้อม AI bindings ในเครื่อง` 
    });
  }
});
