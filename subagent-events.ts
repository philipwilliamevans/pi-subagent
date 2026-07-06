import type {
  BackgroundEscalation,
  BackgroundJob,
  BackgroundJobStatus,
} from "./types.js";

export type SubagentLifecycleEventName =
  | "pi-subagent:started"
  | "pi-subagent:escalated"
  | "pi-subagent:continued"
  | "pi-subagent:completed"
  | "pi-subagent:failed"
  | "pi-subagent:cancelled";

interface PiEventEmitter {
  events?: {
    emit?: (name: string, payload: Record<string, unknown>) => void;
  };
}

interface SubagentEventExtra {
  callIndex?: number;
  agent?: string;
  escalation?: BackgroundEscalation;
  answer?: string;
  status?: BackgroundJobStatus;
}

function getEscalationPayload(
  escalation: BackgroundEscalation | undefined,
  answer: string | undefined,
): Record<string, unknown> {
  if (!escalation) return {};
  return {
    escalationId: escalation.id,
    question: escalation.question,
    kind: escalation.kind,
    ...(answer !== undefined ? { answer } : {}),
  };
}

export function buildSubagentLifecyclePayload(
  job: BackgroundJob,
  extra: SubagentEventExtra = {},
): Record<string, unknown> {
  const callIndex = extra.callIndex ?? extra.escalation?.callIndex;
  const agent = extra.agent ?? (callIndex !== undefined ? job.calls[callIndex]?.agent : undefined);

  return {
    version: 1,
    source: "pi-subagent",
    jobId: job.id,
    ...(callIndex !== undefined ? { callIndex } : {}),
    ...(agent !== undefined ? { agent } : {}),
    status: extra.status ?? job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.worktreeMode !== undefined ? { worktreeMode: job.worktreeMode } : {}),
    ...(job.worktreeMetadata !== undefined ? { worktreeMetadata: job.worktreeMetadata } : {}),
    ...getEscalationPayload(extra.escalation, extra.answer),
  };
}

export function emitSubagentLifecycleEvent(
  pi: PiEventEmitter,
  name: SubagentLifecycleEventName,
  job: BackgroundJob,
  extra: SubagentEventExtra = {},
): void {
  const emit = pi.events?.emit;
  if (typeof emit !== "function") return;

  try {
    emit.call(pi.events, name, buildSubagentLifecyclePayload(job, extra));
  } catch {
    // Lifecycle events are telemetry hooks; listeners must not affect execution.
  }
}
