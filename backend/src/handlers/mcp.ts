import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../middleware/rbac";
import { API_KEY_RE, isApiScope, type ApiScope } from "../middleware/apikey";
import { TOOLS, isWriteTool, type ParamSpec, type Tool } from "../utils/agentTools";
import { ASSERTION_HEADER, signAssertion, type McpMode } from "../utils/agentAssertion";
import { dispatchInternal } from "../utils/dispatch";
import { sha256Hex } from "../utils/secretbox";
import { escapeHtml } from "../utils/email";

/**
 * MCP server for external AI agents (phases 2–3 of docs/AGENT-PLATFORM.md), at POST /mcp.
 *
 * Two ways in, both bound to one agent key:
 *   - Authorization: Bearer npk_… (the raw agent key) — headless agents such as Hermes on DGX Spark
 *   - OAuth 2.1 (Workers OAuth Provider) — MCP clients like Claude add the server by URL; the person
 *     connecting pastes the agent key once on /oauth/authorize, and the client gets a token for it
 *
 * Built with the Agents SDK's stateless createMcpHandler: a fresh McpServer per request with only
 * the tools this key's scopes and MCP access (read / write) allow. Every tool call goes through the
 * same /api/v1 route as the REST API, in-process with a signed agent assertion, so pause, IP, time
 * window, quotas, the activity log and the approval queue all apply unchanged.
 */

type Bindings = Env["Bindings"];
interface KeyInfo { id: string; name: string; scopes: ApiScope[]; mcp_access: "off" | "read" | "write" }

async function loadKey(db: D1Database, where: "id" | "key_hash", value: string): Promise<KeyInfo | null> {
  const row = await db.prepare(`SELECT id, name, kind, scopes, mcp_access FROM api_keys
    WHERE ${where} = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).bind(value, new Date().toISOString())
    .first<{ id: string; name: string; kind: string; scopes: string; mcp_access: KeyInfo["mcp_access"] }>();
  if (!row || row.kind !== "agent") return null;
  let scopes: ApiScope[] = [];
  try { scopes = (JSON.parse(row.scopes) as unknown[]).filter(isApiScope); } catch { scopes = []; }
  return { id: row.id, name: row.name, scopes, mcp_access: row.mcp_access };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

// ---------- Tool schemas ----------

function zodFor(spec: ParamSpec): z.ZodType {
  let field: z.ZodType;
  if (spec.type === "number") field = z.number().min(0);
  else if (spec.type === "boolean") field = z.boolean();
  else if (spec.enum) field = z.enum(spec.enum as [string, ...string[]]);
  else field = spec.max ? z.string().max(spec.max) : z.string();
  field = field.describe(spec.description);
  return spec.required ? field : field.optional();
}

const shape = (params: Record<string, ParamSpec>) => Object.fromEntries(Object.entries(params).map(([k, p]) => [k, zodFor(p)]));

const ACTION_OPTIONS: Record<string, ParamSpec> = {
  dry_run: { type: "boolean", description: "true = ตรวจและดูตัวอย่างผลเท่านั้น ไม่บันทึก" },
  idempotency_key: { type: "string", max: 100, description: "คีย์กันทำซ้ำ (A-Z a-z 0-9 _ . : -) ส่งซ้ำได้ผลเดิม แนะนำให้ส่งทุกครั้ง" },
  reason: { type: "string", max: 1000, description: "เหตุผล ให้ผู้อนุมัติอ่าน" },
  expires_in_hours: { type: "number", description: "รออนุมัติได้นานกี่ชั่วโมง 1–168 (ค่าเริ่มต้น 72)" }
};

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

function asResult(status: number, data: unknown): ToolResult {
  const text = JSON.stringify(data, null, 2);
  const ok = status >= 200 && status < 300;
  return { content: [{ type: "text", text: ok ? text : `HTTP ${status}\n${text}` }], ...(ok ? {} : { isError: true }) };
}

const INSTRUCTIONS = `เซิร์ฟเวอร์ MCP ของ NetPrime LMS (ข้อความในระบบเป็นภาษาไทย)
- เครื่องมืออ่านข้อมูล (list_*, get_*) ใช้ได้ทันที เริ่มจาก get_daily_ops_summary เพื่อดูงานของวันนี้
- เครื่องมือระดับ "ร่าง" ทำทันทีแต่เปลี่ยนเฉพาะบันทึกภายใน
- เครื่องมือระดับ "ลงมือ" (ส่งอีเมล/LINE ยืนยันการชำระเงิน เผยแพร่ ให้สิทธิ์เรียน) จะเข้าคิวให้เจ้าหน้าที่อนุมัติ ผลลัพธ์คือ status=pending ใช้ get_action หรือ get_events (action.updated) ดูผลภายหลัง
- ใช้ dry_run=true เพื่อตรวจก่อน และส่ง idempotency_key ทุกครั้งเพื่อให้ลองใหม่ได้ปลอดภัย`;

/** Builds the per-request MCP server for one agent key. */
function buildServer(env: Bindings, ctx: ExecutionContext, key: KeyInfo, ip: string, origin: string): McpServer {
  const server = new McpServer({ name: "netprime-lms", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const mode: McpMode = key.mcp_access === "write" ? "write" : "read";
  const scopes = new Set<string>(key.scopes);
  const call = async (method: string, path: string, body?: unknown): Promise<ToolResult> => {
    const assertion = await signAssertion(env.JWT_SECRET, key.id, mode, ip);
    const res = await dispatchInternal(env, ctx, "", method, `/v1${path}`, body, { [ASSERTION_HEADER]: assertion, "X-NetPrime-Public-Origin": origin });
    return asResult(res.status, res.data);
  };
  const query = (args: Record<string, unknown>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const text = qs.toString();
    return text ? `?${text}` : "";
  };
  const register = (name: string, config: { title: string; description: string; params: Record<string, ParamSpec>; readOnly: boolean; destructive?: boolean },
    handler: (args: Record<string, unknown>) => Promise<ToolResult>) => {
    server.registerTool(name, {
      title: config.title, description: config.description, inputSchema: z.object(shape(config.params)).strict(),
      annotations: { readOnlyHint: config.readOnly, destructiveHint: !!config.destructive, openWorldHint: false }
    } as any, (async (args: Record<string, unknown>) => handler(args ?? {})) as any);
  };

  register("whoami", { title: "ข้อมูลของ agent key นี้", description: "scope โควตา ช่วงเวลาที่ทำงานได้ และจำนวนงานที่รออนุมัติ", params: {}, readOnly: true }, () => call("GET", "/me"));
  register("list_my_actions", {
    title: "งานที่ agent นี้ส่ง", description: "รายการงานร่าง/ลงมือที่ส่งไปแล้วพร้อมสถานะ", readOnly: true,
    params: { status: { type: "string", enum: ["pending", "executing", "executed", "failed", "rejected", "cancelled", "expired"], description: "สถานะ" },
      limit: { type: "number", description: "1–200" }, cursor: { type: "string", max: 200, description: "next_cursor" } }
  }, args => call("GET", `/actions${query(args)}`));
  register("get_action", { title: "สถานะงานหนึ่งรายการ", description: "ดูผลการอนุมัติ ผลลัพธ์ หรือข้อผิดพลาด", readOnly: true,
    params: { action_id: { type: "string", required: true, max: 100, description: "id งาน (act_…)" } } },
  args => call("GET", `/actions/${encodeURIComponent(String(args.action_id))}`));

  for (const tool of TOOLS as Tool[]) {
    if (!scopes.has(tool.scope)) continue;
    if (!isWriteTool(tool)) {
      register(tool.name, { title: tool.label, description: tool.description, params: tool.params, readOnly: true }, args => call("GET", `${tool.endpoint.path}${query(args)}`));
      continue;
    }
    if (mode !== "write") continue;
    const params = { ...tool.params, ...ACTION_OPTIONS };
    const note = tool.tier === "act" ? " [ระดับลงมือ: เข้าคิวรอเจ้าหน้าที่อนุมัติ]" : " [ระดับร่าง: ทำทันที เปลี่ยนเฉพาะข้อมูลภายใน]";
    register(tool.name, { title: tool.label, description: tool.description + note, params, readOnly: false, destructive: tool.tier === "act" }, args => {
      const input: Record<string, unknown> = {};
      for (const k of Object.keys(tool.params)) if (args[k] !== undefined) input[k] = args[k];
      const body: Record<string, unknown> = { tool: tool.name, input };
      for (const k of Object.keys(ACTION_OPTIONS)) if (args[k] !== undefined) body[k] = args[k];
      return call("POST", "/actions", body);
    });
  }
  if (mode === "write" && TOOLS.some(t => isWriteTool(t) && scopes.has(t.scope))) {
    register("cancel_action", { title: "ถอนงานที่ยังรออนุมัติ", description: "ยกเลิกคำขอที่ยังไม่มีคนตัดสินใจ", readOnly: false,
      params: { action_id: { type: "string", required: true, max: 100, description: "id งาน (act_…)" } } },
    args => call("POST", `/actions/${encodeURIComponent(String(args.action_id))}/cancel`));
  }
  return server;
}

async function serveMcp(request: Request, env: Bindings, ctx: ExecutionContext, key: KeyInfo): Promise<Response> {
  if (key.mcp_access === "off") return json(403, { error: "key นี้ไม่ได้เปิดใช้ผ่าน MCP", code: "mcp_not_allowed" });
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const handler = createMcpHandler(() => buildServer(env, ctx, key, ip, new URL(request.url).origin), {
    route: "/mcp", corsOptions: false, authContext: { props: { apiKeyId: key.id } },
    allowedHostnames: [new URL(request.url).hostname]
  });
  return handler(request, env, ctx);
}

// ---------- OAuth ----------

const SCOPES = ["agent"];

/** CSP source for an OAuth redirect URI: its origin for http(s), its scheme for app links (claude:). */
export function redirectSource(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) ? url.protocol : "";
  } catch { return ""; }
}

/** GET shows the consent form; POST checks the pasted agent key and completes the grant. */
async function authorizePage(request: Request, env: Bindings & { OAUTH_PROVIDER: any }): Promise<Response> {
  const url = new URL(request.url);
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer" };
  // Browsers apply form-action to the redirect after the POST too, so the client's redirect target
  // (claude.ai, or a desktop app's custom scheme) must be allowed or the grant never arrives.
  let formAction = "'self'";
  const csp = () => `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`;
  const page = (body: string, status = 200) => new Response(`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>เชื่อมต่อ AI agent กับ NetPrime LMS</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1e293b}
.box{border:1px solid #e2e8f0;border-radius:12px;padding:20px}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-family:monospace}
button{margin-top:14px;background:#c2541a;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}.muted{color:#64748b;font-size:13px}.err{color:#b91c1c}</style></head>
<body><div class="box">${body}</div></body></html>`, { status, headers: { ...headers, "Content-Security-Policy": csp() } });

  let authRequest;
  const source = request.method === "POST" ? await request.formData() : null;
  const oauthQuery = request.method === "POST" ? String(source?.get("oauth_query") ?? "") : url.search.slice(1);
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(`${url.origin}${url.pathname}?${oauthQuery}`));
  } catch (error) {
    return page(`<h2>คำขอเชื่อมต่อไม่ถูกต้อง</h2><p class="muted">${escapeHtml(error instanceof Error ? error.message : "")}</p>`, 400);
  }
  formAction = `'self' ${redirectSource(authRequest.redirectUri)}`.trim();
  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  const clientName = escapeHtml(client?.clientName || authRequest.clientId);
  const redirectHost = (() => { try { return escapeHtml(new URL(authRequest.redirectUri).host); } catch { return ""; } })();
  const form = (error = "") => page(`<h2>เชื่อมต่อ AI agent</h2>
<p><strong>${clientName}</strong> ขอเชื่อมต่อกับ NetPrime LMS ผ่าน MCP${redirectHost ? ` <span class="muted">(ส่งกลับไปที่ ${redirectHost})</span>` : ""}</p>
<p class="muted">วาง agent key (npk_…) ที่ผู้ดูแลระบบสร้างให้ในหน้า ตั้งค่าระบบ → API keys การเชื่อมต่อนี้จะได้สิทธิ์เท่ากับ key นั้น งานที่ส่งอีเมล ยืนยันเงิน หรือเผยแพร่ ยังต้องรอเจ้าหน้าที่อนุมัติ</p>
${error ? `<p class="err">${error}</p>` : ""}
<form method="post"><input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">
<label>Agent key<br><input name="agent_key" type="password" autocomplete="off" required placeholder="npk_…"></label>
<button type="submit">อนุญาตการเชื่อมต่อ</button></form>`, error ? 400 : 200);

  if (request.method !== "POST") return form();
  const raw = String(source?.get("agent_key") ?? "").trim();
  if (!API_KEY_RE.test(raw)) return form("รูปแบบ agent key ไม่ถูกต้อง");
  const key = await loadKey(env.DB, "key_hash", await sha256Hex(raw));
  if (!key) return form("ไม่พบ agent key นี้ หรือถูกเพิกถอน/หมดอายุแล้ว (ต้องเป็น key ชนิด agent)");
  if (key.mcp_access === "off") return form("key นี้ยังไม่ได้เปิดใช้ผ่าน MCP ให้ผู้ดูแลระบบเปิดในหน้า API keys");
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest, userId: key.id, metadata: { key_name: key.name, client: client?.clientName ?? null },
    scope: SCOPES, props: { apiKeyId: key.id }
  });
  return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
}

/** One provider per API origin (staging, production, local tests); the MCP URL is its resource id. */
const providers = new Map<string, OAuthProvider<any>>();

function oauthProvider(origin: string, fallback: ExportedHandler<any>): OAuthProvider<any> {
  const cached = providers.get(origin);
  if (cached) return cached;
  const provider = new OAuthProvider<any>({
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "NetPrime LMS (MCP)" },
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request: Request, env: Bindings, ctx: ExecutionContext & { props?: { apiKeyId?: string } }) {
        const keyId = ctx.props?.apiKeyId;
        const key = keyId ? await loadKey(env.DB, "id", keyId) : null;
        if (!key) return json(401, { error: "agent key ของการเชื่อมต่อนี้ถูกเพิกถอนหรือหมดอายุแล้ว", code: "unauthorized" });
        return serveMcp(request, env, ctx, key);
      }
    } as any,
    defaultHandler: {
      async fetch(request: Request, env: any, ctx: ExecutionContext) {
        if (new URL(request.url).pathname === "/oauth/authorize") return authorizePage(request, env);
        return fallback.fetch!(request as any, env, ctx);
      }
    } as any,
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: SCOPES,
    accessTokenTTL: 3600
  });
  providers.set(origin, provider);
  return provider;
}

/** Paths the MCP gateway owns; everything else goes straight to the Hono app. */
export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/oauth/") || pathname.startsWith("/.well-known/oauth-");
}

/**
 * Entry for MCP and OAuth paths. A raw agent key is checked here; anything else is the OAuth
 * provider's business. OAuth state lives in the SESSIONS KV namespace under the provider's own
 * prefixes (client:, grant:, token:), so no extra binding is needed.
 */
export async function mcpFetch(request: Request, env: Bindings, ctx: ExecutionContext, fallback: ExportedHandler<any>): Promise<Response> {
  const url = new URL(request.url);
  const auth = request.headers.get("Authorization") || "";
  if (url.pathname === "/mcp" && auth.startsWith("Bearer npk_")) {
    const raw = auth.slice(7).trim();
    const key = API_KEY_RE.test(raw) ? await loadKey(env.DB, "key_hash", await sha256Hex(raw)) : null;
    if (!key) return json(401, { error: "agent key ไม่ถูกต้อง ถูกเพิกถอน หรือหมดอายุ (ต้องเป็น key ชนิด agent)", code: "unauthorized" });
    return serveMcp(request, env, ctx, key);
  }
  return oauthProvider(url.origin, fallback).fetch(request, { ...env, OAUTH_KV: env.SESSIONS }, ctx);
}
