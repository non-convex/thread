/** Follow-up times after immediate initialization; intervals stay anchored to creation. */
export type ScheduleSpec =
  | { kind: "at"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "cron"; expression: string; timezone: string };

export interface CreateScheduleInput {
  name: string;
  /** Brief wakeup cue; the Session retains the task's background and ongoing instructions. */
  prompt: string;
  /** Full task setup, queued at creation and run once the runtime is idle. Defaults to prompt. */
  initialPrompt?: string;
  schedule: ScheduleSpec;
  /** Omit to create one independent Session for initialization and all follow-ups. */
  sessionId?: string;
}

/** Update future wakeups without changing identity or enabled state. Supply at least one field. */
export interface UpdateScheduleInput {
  /** Brief wakeup cue; initial instructions and already-prepared messages remain unchanged. */
  prompt?: string;
  /** Recompute the next follow-up after the update; every stays anchored to task creation. */
  schedule?: ScheduleSpec;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  initialPrompt: string;
  schedule: ScheduleSpec;
  sessionId: string;
  createdAt: number;
  enabled: boolean;
  /** Initially createdAt, then the next occurrence of the follow-up time rule. */
  nextRunAt: number | null;
  lastTurnId?: string;
  /** An admission error pauses the schedule; turn failures live in the normal turn history. */
  lastError?: string;
}

/** Durable origin of an otherwise ordinary user turn. */
export interface ScheduledWakeup {
  scheduleId: string;
  scheduledAt: number;
  phase: "initial" | "followup";
}

export interface ScheduleSummary extends ScheduledTask {
  lastRun?: {
    turnId: string;
    status: "running" | "completed" | "interrupted" | "failed";
    startedAt: number;
    finishedAt?: number;
    error?: string;
  };
}

export interface ScheduleHost {
  createSchedule(input: CreateScheduleInput, options?: { signal?: AbortSignal }): Promise<ScheduledTask>;
  listSchedules(): ScheduleSummary[];
  updateSchedule(id: string, input: UpdateScheduleInput, options?: { signal?: AbortSignal }): Promise<ScheduledTask>;
  setScheduleEnabled(id: string, enabled: boolean, options?: { signal?: AbortSignal }): Promise<ScheduledTask>;
  deleteSchedule(id: string, options?: { signal?: AbortSignal }): Promise<void>;
}
