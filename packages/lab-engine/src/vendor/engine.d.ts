// Types for the NetPrime lab engine (engine.js). Only the symbols ../index.ts uses; everything else stays internal.

export interface EngineObjective {
  id: string;
  checkId: string;
  title: string;
  description: string;
  hints: string[];
  params: unknown;
}

export interface EngineInterfaceInventory { id: string; type: string; number: number }
export type EngineDeviceKind = "router" | "switch" | "pc" | "server";
export interface EngineStaticRoute { network: number; prefixLength: number; nextHop: number }
export interface EngineDevice {
  id: string;
  kind: EngineDeviceKind;
  inventory: EngineInterfaceInventory[];
  config: {
    hostname: string;
    interfaces: Record<string, { adminUp: boolean; ipv4: { address: number; prefixLength: number } | null }>;
    /** PCs and servers only. */
    gateway?: number | null;
    /** Routers only. */
    routes?: EngineStaticRoute[];
  };
}
export interface EngineEndpoint { deviceId: string; interfaceId: string }
export interface EngineLink { id: string; kind: string; a: EngineEndpoint; b: EngineEndpoint }
export interface EngineLabState { deviceOrder: string[]; devices: Record<string, EngineDevice>; links: EngineLink[] }

export interface EngineLab {
  id: string;
  version: string;
  title: string;
  profileId: string;
  instructions: {
    summary: string;
    scopeNote?: string;
    /** Addresses are 32-bit integers after validation (see ipv4ToString). */
    addressingPlan?: { deviceId: string; interfaceId: string; address: number; prefixLength: number; gateway?: number }[];
  };
  layout: Record<string, { x: number; y: number }>;
  initialState: EngineLabState;
  objectives: EngineObjective[];
}

export interface EngineSpecError { path: string; message: string }

export interface EngineAssessment {
  results: { id: string; title: string; passed: boolean; reasons: string[] }[];
  passedCount: number;
  total: number;
}

export interface EngineDerivedInterface {
  adminUp: boolean;
  status: string;
  protocol: string;
  ipv4: { address: number; prefixLength: number } | null;
}
export interface EngineDerived {
  interfaces: Record<string, Record<string, EngineDerivedInterface>>;
  links: Record<string, { id: string; operUp: boolean }>;
}

export interface EngineRuntime { lab: EngineLabState; sessions: Record<string, { mode: string }> }
export interface EngineEnv { readonly __engineEnv: unique symbol }
export interface EngineProfile { id: string; label: string }

export interface EngineExecuted { deviceId: string; line: string; via: string; outcome: string; commandId?: string }

export function validateLab(spec: unknown, profiles: Record<string, EngineProfile>):
  { ok: true; lab: EngineLab } | { ok: false; errors: EngineSpecError[] };
export function createEnv(profile: EngineProfile, clock?: () => Date): EngineEnv;
export function createRuntime(initialState: EngineLabState, size?: { cols?: number; rows?: number }): EngineRuntime;
export function inputRuntime(runtime: EngineRuntime, deviceId: string, data: string, env: EngineEnv):
  { rt: EngineRuntime; out: Record<string, string>; executed: EngineExecuted[] };
export function assess(state: EngineLabState, objectives: EngineObjective[]): EngineAssessment;
export function deriveState(state: EngineLabState): EngineDerived;

export class LabController {
  constructor(lab: EngineLab, env: EngineEnv, size?: { cols?: number; rows?: number });
  readonly deviceIds: string[];
  getSnapshot(): { runtime: EngineRuntime; derived: EngineDerived; assessment: EngineAssessment };
  subscribe(listener: () => void): () => void;
  onExecution(listener: (executed: EngineExecuted[]) => void): () => void;
  attachSink(deviceId: string, sink: (text: string) => void): () => void;
  input(deviceId: string, data: string): void;
  resize(deviceId: string, cols: number, rows: number): void;
  reset(): void;
}

export const PROFILES: Record<string, EngineProfile>;
export const LAB_001: unknown;
