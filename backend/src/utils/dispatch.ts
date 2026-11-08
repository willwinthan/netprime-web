import type { Env } from "../middleware/rbac";

/**
 * In-process requests to this Worker's own routes. Approved agent actions run through the same
 * staff endpoint a person would use (same validation, emails, receipts and audit), signed with the
 * approver's own token, so the approver's permissions decide what can run. index.ts registers the
 * Hono app here at start-up; handlers cannot import index.ts without a cycle.
 */
type Dispatcher = (request: Request, env: Env["Bindings"], ctx?: ExecutionContext) => Response | Promise<Response>;

let dispatcher: Dispatcher | null = null;

export function setInternalDispatcher(fn: Dispatcher) {
  dispatcher = fn;
}

export interface InternalResponse { status: number; data: any }

export async function dispatchInternal(env: Env["Bindings"], ctx: ExecutionContext | undefined, authorization: string,
  method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<InternalResponse> {
  if (!dispatcher) throw new Error("Internal dispatcher is not registered");
  const request = new Request(`https://internal.invalid/api${path}`, {
    method,
    headers: { ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const response = await dispatcher(request, env, ctx);
  const text = await response.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  return { status: response.status, data };
}
