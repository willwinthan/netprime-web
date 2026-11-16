/**
 * NetPrime Virtual Lab engine: the one place that talks to the simulator (./vendor/engine.js, owned by NetPrime).
 *
 * The browser runs a lab live (createSession) while the learner types; the Worker grades a learner's work by
 * replaying their keystrokes from the lab's initial state (grade). Both use this same code, so a transcript
 * gives the same device state in both places. The server never trusts a state or a result sent by a client.
 *
 * Plain erasable TypeScript, no DOM or Node types: it is compiled by the backend (WebWorker lib), the frontend
 * (DOM lib) and run directly by Node's type stripping in tests.
 */
import {
  assess, createEnv, createRuntime, deriveState, inputRuntime, LAB_001, LabController, PROFILES, validateLab
} from "./vendor/engine.js";
import type { EngineDerived, EngineDeviceKind, EngineLab, EngineSpecError } from "./vendor/engine.js";

/** Identifies the simulator build. Stored with every graded attempt; change it whenever vendor/engine.js changes. */
export const ENGINE_VERSION = "netprime-0.2.0";

export type Lab = EngineLab;
export type SpecError = EngineSpecError;
export type DerivedState = EngineDerived;
export type DeviceKind = EngineDeviceKind;
export { LabController };

/** Lab specs larger than this are refused before validation. */
export const MAX_SPEC_BYTES = 256 * 1024;

/**
 * What a learner typed: [deviceId, keystrokes] in the order it happened across all devices
 * (the devices share one lab state, so the order matters). Consecutive chunks for one device are merged.
 */
export type TranscriptChunk = [string, string];
export const TRANSCRIPT_LIMITS = { maxChars: 128 * 1024, maxChunks: 20_000 };

export interface ObjectiveResult { id: string; title: string; passed: boolean; reasons: string[] }
export interface GradeResult { passed: boolean; passedCount: number; total: number; results: ObjectiveResult[] }

/** The sample lab from the original Virtual Lab (LAB-001 Basic IPv4 Connectivity), as plain JSON. */
export function sampleSpec(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(LAB_001)) as Record<string, unknown>;
}

/** Checks a lab spec (JSON value) and returns the normalized lab, or every problem with its JSON path. */
export function validateSpec(spec: unknown): { ok: true; lab: Lab } | { ok: false; errors: SpecError[] } {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec))
    return { ok: false, errors: [{ path: "$", message: "lab definition must be an object" }] };
  try {
    const result = validateLab(spec, PROFILES);
    return result.ok ? { ok: true, lab: result.lab } : { ok: false, errors: result.errors };
  } catch (error) {
    return { ok: false, errors: [{ path: "$", message: error instanceof Error ? error.message : "invalid lab definition" }] };
  }
}

/** Adds keystrokes to a transcript, merging with the previous chunk when it is for the same device. */
export function appendChunk(transcript: TranscriptChunk[], deviceId: string, data: string): void {
  if (!data) return;
  const last = transcript[transcript.length - 1];
  if (last && last[0] === deviceId) last[1] += data;
  else transcript.push([deviceId, data]);
}

/** Validates a transcript received from a client against the lab's devices and the size limits. */
export function parseTranscript(value: unknown, lab: Lab): { ok: true; transcript: TranscriptChunk[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "transcript must be an array" };
  if (value.length > TRANSCRIPT_LIMITS.maxChunks) return { ok: false, error: "transcript is too long" };
  const devices = new Set(lab.initialState.deviceOrder);
  const transcript: TranscriptChunk[] = [];
  let chars = 0;
  for (const chunk of value) {
    if (!Array.isArray(chunk) || chunk.length !== 2 || typeof chunk[0] !== "string" || typeof chunk[1] !== "string")
      return { ok: false, error: "each transcript entry must be [deviceId, text]" };
    if (!devices.has(chunk[0])) return { ok: false, error: `unknown device ${chunk[0]}` };
    chars += chunk[1].length;
    if (chars > TRANSCRIPT_LIMITS.maxChars) return { ok: false, error: "transcript is too long" };
    appendChunk(transcript, chunk[0], chunk[1]);
  }
  return { ok: true, transcript };
}

function envFor(lab: Lab, clock?: () => Date) {
  const profile = PROFILES[lab.profileId];
  if (!profile) throw new Error(`unknown device profile ${lab.profileId}`);
  return createEnv(profile, clock);
}

/**
 * Replays a transcript from the lab's initial state and checks every objective. Deterministic: the clock only
 * changes timestamps in console messages, and terminal size only changes line wrapping, never the lab state.
 */
export function grade(lab: Lab, transcript: TranscriptChunk[]): GradeResult {
  const env = envFor(lab, () => new Date(0));
  let runtime = createRuntime(lab.initialState);
  for (const [deviceId, data] of transcript) runtime = inputRuntime(runtime, deviceId, data, env).rt;
  const a = assess(runtime.lab, lab.objectives);
  return {
    passed: a.total > 0 && a.passedCount === a.total,
    passedCount: a.passedCount,
    total: a.total,
    results: a.results.map(r => ({ id: r.id, title: r.title, passed: r.passed, reasons: r.reasons }))
  };
}

/** A live lab for the browser: feed keystrokes with input(), read console output through attachSink(). */
export function createSession(lab: Lab, size?: { cols?: number; rows?: number }): LabController {
  return new LabController(lab, envFor(lab), size);
}

/** 168561665 -> "10.12.12.1" (the engine keeps IPv4 addresses as 32-bit integers). */
export function ipv4ToString(address: number): string {
  return [24, 16, 8, 0].map(shift => (address >>> shift) & 255).join(".");
}

/** 24 -> "255.255.255.0" */
export function prefixToMask(prefixLength: number): string {
  return ipv4ToString(prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0);
}

/** Device state for drawing the topology (interface status and addresses, link up/down). */
export function derive(lab: Lab, controller?: LabController): DerivedState {
  return controller ? controller.getSnapshot().derived : deriveState(lab.initialState);
}
