/** Calendar times use an explicit timezone; interval schedules stay anchored to creation. */
export type ScheduleSpec =
  | { kind: "at"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "cron"; expression: string; timezone: string };

export interface CreateScheduleInput {
  name: string;
  prompt: string;
  /** Background and instructions for the first wakeup. Defaults to prompt. */
  initialPrompt?: string;
  schedule: ScheduleSpec;
  /** Omit to create one new, empty Session. All occurrences keep that same Session. */
  sessionId?: string;
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
  setScheduleEnabled(id: string, enabled: boolean, options?: { signal?: AbortSignal }): Promise<ScheduledTask>;
  deleteSchedule(id: string, options?: { signal?: AbortSignal }): Promise<void>;
}
