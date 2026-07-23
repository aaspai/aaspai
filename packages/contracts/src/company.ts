import { z } from "zod";
import { identifierSchema, isoTimestampSchema, nonNegativeIntegerSchema } from "./primitives";

export const companyHealthStatusSchema = z.enum(["healthy", "at_risk", "critical"]);
export type CompanyHealthStatus = z.infer<typeof companyHealthStatusSchema>;

export const companyHealthSignalSchema = z
  .object({
    code: z.enum(["blocked_work", "failed_attempts", "pending_governance", "overdue_work"]),
    severity: z.enum(["info", "warning", "critical"]),
    title: z.string().trim().min(1).max(256),
    detail: z.string().trim().min(1).max(1_024),
    count: nonNegativeIntegerSchema,
  })
  .strict();
export type CompanyHealthSignal = z.infer<typeof companyHealthSignalSchema>;

export const companyGoalHealthSchema = z
  .object({
    id: identifierSchema,
    title: z.string().trim().min(1).max(512),
    status: z.string().trim().min(1).max(64),
    projectCount: nonNegativeIntegerSchema,
    totalWork: nonNegativeIntegerSchema,
    completedWork: nonNegativeIntegerSchema,
    blockedWork: nonNegativeIntegerSchema,
    failedWork: nonNegativeIntegerSchema,
    completionPercent: z.number().int().min(0).max(100),
  })
  .strict();
export type CompanyGoalHealth = z.infer<typeof companyGoalHealthSchema>;

export const companyProjectHealthSchema = z
  .object({
    id: identifierSchema,
    goalId: identifierSchema,
    title: z.string().trim().min(1).max(512),
    status: z.string().trim().min(1).max(64),
    totalWork: nonNegativeIntegerSchema,
    completedWork: nonNegativeIntegerSchema,
    activeWork: nonNegativeIntegerSchema,
    blockedWork: nonNegativeIntegerSchema,
    failedWork: nonNegativeIntegerSchema,
    completionPercent: z.number().int().min(0).max(100),
  })
  .strict();
export type CompanyProjectHealth = z.infer<typeof companyProjectHealthSchema>;

export const companyHealthSchema = z
  .object({
    organizationId: identifierSchema,
    generatedAt: isoTimestampSchema,
    status: companyHealthStatusSchema,
    score: z.number().int().min(0).max(100),
    totalGoals: nonNegativeIntegerSchema,
    totalProjects: nonNegativeIntegerSchema,
    totalWork: nonNegativeIntegerSchema,
    completedWork: nonNegativeIntegerSchema,
    activeWork: nonNegativeIntegerSchema,
    blockedWork: nonNegativeIntegerSchema,
    failedWork: nonNegativeIntegerSchema,
    totalAttempts: nonNegativeIntegerSchema,
    runningAttempts: nonNegativeIntegerSchema,
    failedAttempts: nonNegativeIntegerSchema,
    reliabilityPercent: z.number().int().min(0).max(100),
    completionPercent: z.number().int().min(0).max(100),
    pendingApprovals: nonNegativeIntegerSchema,
    pendingVerifications: nonNegativeIntegerSchema,
    overdueWork: nonNegativeIntegerSchema,
    actualCostUsd: z.number().nonnegative(),
    reservedCostUsd: z.number().nonnegative(),
    actualTokens: nonNegativeIntegerSchema,
    reservedTokens: nonNegativeIntegerSchema,
    signals: z.array(companyHealthSignalSchema).max(32),
    goals: z.array(companyGoalHealthSchema).max(1_000),
    projects: z.array(companyProjectHealthSchema).max(1_000),
  })
  .strict();
export type CompanyHealth = z.infer<typeof companyHealthSchema>;
