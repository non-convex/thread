import { Cron } from "croner";
import type { ScheduleSpec } from "./model.js";

const MAX_DATE_MS = 8_640_000_000_000_000;
const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function validTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_DATE_MS) {
    throw new Error(`${label} must be a valid millisecond timestamp`);
  }
}

/** Check the written calendar date as well as the resulting instant (Date.parse rolls over invalid days). */
function normalizeAt(value: string): string {
  const match = AT_PATTERN.exec(value);
  if (!match) throw new Error("at must be an ISO date-time with an explicit Z or ±HH:MM offset");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);
  const milliseconds = Number((fraction ?? "").padEnd(3, "0").slice(0, 3));
  const offsetHours = Number(offsetHourText ?? 0);
  const offsetMinutes = Number(offsetMinuteText ?? 0);
  if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
    throw new Error("at has an invalid clock time or UTC offset");
  }
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, milliseconds);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) {
    throw new Error("at has an invalid calendar date");
  }
  const direction = zone === "Z" ? 0 : sign === "+" ? 1 : -1;
  const instant = local.getTime() - direction * (offsetHours * 60 + offsetMinutes) * 60_000;
  validTimestamp(instant, "at");
  const iso = new Date(instant).toISOString();
  if (!AT_PATTERN.test(iso)) throw new Error("at is outside the supported four-digit ISO calendar years");
  return iso;
}

function checkFields(spec: ScheduleSpec, fields: readonly string[]): void {
  if (Object.keys(spec).some((field) => !fields.includes(field))) {
    throw new Error(`Unexpected field for ${spec.kind} schedule`);
  }
}

/** Validate untrusted schedule data at the boundary and return its canonical representation. */
export function normalizeSchedule(spec: ScheduleSpec): ScheduleSpec {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("schedule must be an object");
  switch (spec.kind) {
    case "at":
      checkFields(spec, ["kind", "at"]);
      if (typeof spec.at !== "string") throw new Error("at must be a string");
      return { kind: "at", at: normalizeAt(spec.at) };
    case "every": {
      checkFields(spec, ["kind", "minutes"]);
      if (typeof spec.minutes !== "number" || spec.minutes < 1 || !Number.isSafeInteger(spec.minutes * 60_000)) {
        throw new Error("every.minutes must be at least 1 with a safe, integral millisecond interval");
      }
      return { kind: "every", minutes: spec.minutes };
    }
    case "cron": {
      checkFields(spec, ["kind", "expression", "timezone"]);
      if (typeof spec.expression !== "string" || typeof spec.timezone !== "string") {
        throw new Error("cron requires an expression and an IANA timezone");
      }
      const expression = spec.expression.trim().replace(/\s+/g, " ");
      const timezone = spec.timezone.trim();
      if (expression.split(" ").length !== 5) throw new Error("cron expression must have exactly five fields");
      if (!timezone) throw new Error("cron timezone must be a valid IANA timezone");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        throw new Error(`Invalid IANA timezone: ${timezone}`);
      }
      // Croner checks field ranges and unsupported cron syntax, not just the field count.
      new Cron(expression, { timezone, mode: "5-part" });
      return { kind: "cron", expression, timezone };
    }
    default:
      throw new Error("Unknown schedule kind");
  }
}

/** The next occurrence strictly after `after`, or null for a finished one-off schedule. */
export function nextScheduleTime(spec: ScheduleSpec, after: number, anchorAt: number): number | null {
  validTimestamp(after, "after");
  const normalized = normalizeSchedule(spec);
  switch (normalized.kind) {
    case "at": {
      const at = Date.parse(normalized.at);
      return at > after ? at : null;
    }
    case "every": {
      validTimestamp(anchorAt, "anchorAt");
      const period = normalized.minutes * 60_000;
      const next = after < anchorAt ? anchorAt : anchorAt + (Math.floor((after - anchorAt) / period) + 1) * period;
      return next <= MAX_DATE_MS && Number.isSafeInteger(next) ? next : null;
    }
    case "cron": {
      const cron = new Cron(normalized.expression, { timezone: normalized.timezone, mode: "5-part" });
      let next = cron.nextRun(new Date(after));
      // Never deliver an occurrence equal to `after`, regardless of Croner boundary behavior.
      if (next && next.getTime() <= after && after < MAX_DATE_MS) next = cron.nextRun(new Date(after + 1));
      return next && next.getTime() > after ? next.getTime() : null;
    }
  }
}
