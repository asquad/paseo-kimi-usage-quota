import type { UsageInput } from "../shared/input.js";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  type UsageAccount,
  windowFromUsedPct,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const ApiNumberSchema = z.coerce.number().finite();
const ApiOptionalStringSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.string().optional(),
);

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

const KimiUsageFieldsSchema = z.object({
  limit: ApiOptionalStringSchema,
  used: ApiOptionalStringSchema,
  remaining: ApiOptionalStringSchema,
  resetTime: ApiOptionalStringSchema,
  resetAt: ApiOptionalStringSchema,
  reset_time: ApiOptionalStringSchema,
  reset_at: ApiOptionalStringSchema,
  name: ApiOptionalStringSchema,
  title: ApiOptionalStringSchema,
  scope: ApiOptionalStringSchema,
  duration: z.unknown().optional(),
  timeUnit: ApiOptionalStringSchema,
});

const KimiRatioFieldsSchema = z.object({
  used_ratio: ApiNumberSchema.nullish(),
  usedRatio: ApiNumberSchema.nullish(),
  resetTime: ApiOptionalStringSchema,
  resetAt: ApiOptionalStringSchema,
  reset_time: ApiOptionalStringSchema,
  reset_at: ApiOptionalStringSchema,
});

const KimiUsageLimitSchema = z
  .object({
    window: z.unknown().optional(),
    detail: z.unknown().optional(),
  })
  .passthrough();

const KimiUsageResponseSchema = z.object({
  usage: z.unknown().nullish(),
  limits: z.unknown().nullish(),
  usages: z.record(z.string(), z.unknown()).nullish(),
});

type KimiUsageFields = z.infer<typeof KimiUsageFieldsSchema>;
type KimiRatioFields = z.infer<typeof KimiRatioFieldsSchema>;
type KimiUsageLimit = z.infer<typeof KimiUsageLimitSchema>;

function parseUsageFields(value: unknown): KimiUsageFields | null {
  const parsed = KimiUsageFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseRatioFields(value: unknown): KimiRatioFields | null {
  const parsed = KimiRatioFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function usedPctFromFields(fields: KimiUsageFields): number | null {
  const limit = fields.limit === undefined ? null : Number(fields.limit);
  const used = fields.used === undefined ? null : Number(fields.used);
  const remaining = fields.remaining === undefined ? null : Number(fields.remaining);

  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;

  let usedValue: number | null = null;
  if (used !== null && Number.isFinite(used)) {
    usedValue = used;
  } else if (remaining !== null && Number.isFinite(remaining)) {
    usedValue = limit - remaining;
  }

  return usedValue === null ? null : Math.max(0, Math.min(100, (usedValue / limit) * 100));
}

function resetTimeFromFields(fields: KimiUsageFields): string | null {
  return fields.resetTime ?? fields.resetAt ?? fields.reset_time ?? fields.reset_at ?? null;
}

function explicitUsageLabel(...fields: Array<KimiUsageFields | null>): string | null {
  for (const field of fields) {
    if (!field) continue;
    const label = field.name ?? field.title ?? field.scope;
    if (label?.trim()) return label.trim();
  }
  return null;
}

function durationFrom(value: unknown): number | null {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function durationLabel(duration: number | null, timeUnit: string | undefined): string | null {
  if (duration === null || !timeUnit) return null;

  const normalizedUnit = timeUnit.replace(/^TIME_UNIT_/i, "").toUpperCase();
  if (normalizedUnit === "MINUTE") {
    if (duration % 60 === 0) return `${duration / 60}-hour limit`;
    return `${duration}-minute limit`;
  }
  if (normalizedUnit === "HOUR") return `${duration}-hour limit`;
  if (normalizedUnit === "DAY") return `${duration}-day limit`;
  if (normalizedUnit === "WEEK") return `${duration}-week limit`;
  if (normalizedUnit === "SECOND") return `${duration}-second limit`;
  return null;
}

function idPart(value: string | number): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hasUsageData(fields: KimiUsageFields | null): fields is KimiUsageFields {
  return (
    fields !== null &&
    (fields.limit !== undefined || fields.used !== undefined || fields.remaining !== undefined)
  );
}

function limitFields(limit: KimiUsageLimit): {
  fields: KimiUsageFields | null;
  metadata: KimiUsageFields | null;
} {
  const metadata = parseUsageFields(limit);
  const detail = parseUsageFields(limit.detail);
  return {
    fields: hasUsageData(detail) ? detail : metadata,
    metadata,
  };
}

function windowMetadata(limit: KimiUsageLimit): KimiUsageFields | null {
  return parseUsageFields(limit.window);
}

function limitIdentity(input: {
  metadata: KimiUsageFields | null;
  fields: KimiUsageFields;
  window: KimiUsageFields | null;
  index: number;
}): { id: string; label: string } {
  const label = explicitUsageLabel(input.metadata, input.fields);
  const duration = durationFrom(
    input.window?.duration ?? input.metadata?.duration ?? input.fields.duration,
  );
  const timeUnit = input.window?.timeUnit ?? input.metadata?.timeUnit ?? input.fields.timeUnit;
  const generatedLabel = duration === null ? null : durationLabel(duration, timeUnit);

  if (duration !== null && timeUnit) {
    return {
      id: `coding_limit_${idPart(duration)}_${idPart(timeUnit)}`,
      label: label ?? generatedLabel ?? `Limit ${input.index + 1}`,
    };
  }

  if (label) {
    return { id: `coding_limit_${idPart(label)}`, label };
  }

  return {
    id: `coding_limit_${input.index + 1}`,
    label: generatedLabel ?? `Limit ${input.index + 1}`,
  };
}

function windowFromFields(input: {
  id: string;
  label: string;
  fields: KimiUsageFields;
}): UsageWindow {
  const usedPct = usedPctFromFields(input.fields);
  return windowFromUsedPct({
    id: input.id,
    label: input.label,
    utilizationPct: usedPct,
    resetsAt: resetTimeFromFields(input.fields),
    tone: toneFromUsedPct(usedPct),
  });
}

function uniqueWindowId(baseId: string, seenIds: Set<string>): string {
  let id = baseId;
  let suffix = 2;
  while (seenIds.has(id)) {
    id = `${baseId}_${suffix}`;
    suffix += 1;
  }
  seenIds.add(id);
  return id;
}

const ratioWindowLabels: Record<string, { label: string; shortLabel: string }> = {
  limit_5h: { label: "5-hour limit", shortLabel: "5h" },
  limit_7d: { label: "Weekly limit", shortLabel: "Week" },
  limit_month_total: { label: "Monthly total", shortLabel: "Month" },
  limit_month_code: { label: "Monthly Code usage", shortLabel: "Code" },
};

function ratioWindow(key: string, value: unknown): UsageWindow | null {
  const fields = parseRatioFields(value);
  const ratio = fields?.used_ratio ?? fields?.usedRatio;
  if (!fields || ratio == null) return null;

  const usedPct = Math.max(0, Math.min(100, ratio * 100));
  const labels = ratioWindowLabels[key] ?? { label: key, shortLabel: key };
  return windowFromUsedPct({
    id: key,
    label: labels.label,
    shortLabel: labels.shortLabel,
    summary: key === "limit_5h" || key === "limit_7d",
    utilizationPct: usedPct,
    resetsAt: resetTimeFromFields(fields),
    tone: toneFromUsedPct(usedPct),
  });
}

function legacyRatioKey(window: KimiUsageFields | null): string | null {
  const duration = durationFrom(window?.duration);
  const timeUnit = window?.timeUnit?.replace(/^TIME_UNIT_/i, "").toUpperCase();
  if (duration === null || !timeUnit) return null;

  const minutes =
    timeUnit === "MINUTE"
      ? duration
      : timeUnit === "HOUR"
        ? duration * 60
        : timeUnit === "DAY"
          ? duration * 1_440
          : timeUnit === "WEEK"
            ? duration * 10_080
            : null;
  if (minutes === 300) return "limit_5h";
  if (minutes === 10_080) return "limit_7d";
  return null;
}

function kimiUsageWindowsFromPayload(payload: unknown): UsageWindow[] {
  const response = KimiUsageResponseSchema.parse(payload);
  const windows: UsageWindow[] = [];
  const seenWindowIds = new Set<string>();
  const legacyRatioKeys = new Set<string>();
  const usage = parseUsageFields(response.usage);

  if (hasUsageData(usage)) {
    legacyRatioKeys.add("limit_7d");
    windows.push(
      windowFromFields({
        id: uniqueWindowId("coding_usage", seenWindowIds),
        // Top-level usage reports no period unless it supplies duration metadata.
        label:
          explicitUsageLabel(usage) ??
          durationLabel(durationFrom(usage.duration), usage.timeUnit) ??
          "Usage limit",
        fields: usage,
      }),
    );
  }

  const limits = Array.isArray(response.limits) ? response.limits : [];
  for (const [index, rawLimit] of limits.entries()) {
    const parsedLimit = KimiUsageLimitSchema.safeParse(rawLimit);
    if (!parsedLimit.success) {
      continue;
    }

    const limit = parsedLimit.data;
    const { fields, metadata } = limitFields(limit);
    if (!hasUsageData(fields)) {
      continue;
    }

    const window = windowMetadata(limit);
    const identity = limitIdentity({ metadata, fields, window, index });
    const ratioKey = legacyRatioKey(window) ?? legacyRatioKey(metadata);
    if (ratioKey) legacyRatioKeys.add(ratioKey);
    windows.push(
      windowFromFields({
        id: uniqueWindowId(identity.id, seenWindowIds),
        label: identity.label,
        fields,
      }),
    );
  }

  for (const [key, value] of Object.entries(response.usages ?? {})) {
    // Legacy absolute counters are preferable where both forms describe one window.
    if (legacyRatioKeys.has(key)) continue;
    const window = ratioWindow(key, value);
    if (window) windows.push(window);
  }

  return windows;
}

const KimiAuthSchema = z
  .object({
    access_token: z.string().nullish(),
    refresh_token: z.string().nullish(),
    expires_at: ApiNumberSchema.nullish(),
    expires_in: ApiNumberSchema.nullish(),
    scope: z.string().nullish(),
    token_type: z.string().nullish(),
  })
  .passthrough();

type KimiAuth = z.infer<typeof KimiAuthSchema>;
type KimiCredentials = KimiAuth & { access_token: string };

function usageUrl(): string {
  const configuredBase = process.env.KIMI_CODE_BASE_URL?.trim().replace(/\/+$/, "");
  if (!configuredBase) return KIMI_USAGE_URL;
  return configuredBase.endsWith("/usages") ? configuredBase : `${configuredBase}/usages`;
}

export async function fetchUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  async function callUsageApi(token: string): Promise<Response> {
    return fetchApi(usageUrl(), {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  }

  const credentials = await readCredentials(input);
  if (!credentials) throw new Error("Kimi login store no longer exists");
  if (credentials.expires_at != null && credentials.expires_at * 1000 <= Date.now())
    return unavailable({
      kind: "expired",
      expiresAt: new Date(credentials.expires_at * 1000).toISOString(),
      refreshedBy: "kimi",
    });

  const res = await callUsageApi(credentials.access_token);

  if (res.status === 401 || res.status === 403)
    return unavailable({ kind: "rejected", status: res.status, refreshedBy: "kimi" });
  if (!res.ok) throw new Error(`Kimi usage API returned ${res.status}`);

  const windows = kimiUsageWindowsFromPayload(await res.json());
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "Kimi returned no quota windows for this account." });
  }

  return {
    status: "available",
    planLabel: undefined,
    windows,
    balances: [],
    details: [],
  };
}

async function readCredentials(input: UsageInput): Promise<KimiCredentials | undefined> {
  if (input.store === "env") {
    const token = process.env[input.locator];
    return token ? { access_token: token } : undefined;
  }
  try {
    const credentials = KimiAuthSchema.parse(JSON.parse(await fs.readFile(input.locator, "utf8")));
    return credentials.access_token
      ? { ...credentials, access_token: credentials.access_token }
      : undefined;
  } catch {
    return undefined;
  }
}
async function credentialFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() && /^kimi-code(?:-env-[a-z0-9]+)?\.json$/i.test(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => join(directory, entry.name));
  } catch {
    return [];
  }
}

export async function discover(): Promise<UsageAccount[]> {
  const candidates: UsageInput[] = ["KIMI_TOKEN", "KIMI_API_KEY"].map((locator) => ({
    store: "env",
    locator,
  }));
  const directories = [
    join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "credentials"),
    join(homedir(), ".kimi", "credentials"),
  ];
  for (const directory of directories) {
    candidates.push(
      ...(await credentialFiles(directory)).map((locator) => ({
        store: "file" as const,
        locator,
      })),
    );
  }

  const accounts: UsageAccount[] = [];
  for (const input of candidates) {
    if (await readCredentials(input)) {
      accounts.push({ key: hashAccountKey(input.locator), harness: "Kimi Code", input });
    }
  }
  return accounts;
}
