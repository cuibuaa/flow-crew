import { z } from 'zod';

/** The stage owns categorization. Never infer authority from descriptive prose. */
export const ApprovalCategorySchema = z.enum([
  'provider_calls', 'downloads', 'spend', 'credentials', 'other_repositories',
  'user_data_deletion', 'shared_devices', 'external_git_history',
]);
export type ApprovalCategory = z.infer<typeof ApprovalCategorySchema>;
const HostSchema = z.string().max(253).regex(
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  'use one exact lowercase hostname without scheme, port, path or wildcard',
);
export const BriefAuthorizationsSchema = z.strictObject({
  provider_calls: z.literal(true).optional(),
  downloads: z.strictObject({ hosts: z.array(HostSchema).min(1) }).optional(),
  spend: z.strictObject({ usd: z.number().finite().nonnegative() }).optional(),
});
export type BriefAuthorizations = z.infer<typeof BriefAuthorizationsSchema>;

/** Unknown categories and malformed bounds remain human decisions, including
 * legacy requests without these fields. Forbidden categories have no declaration. */
export const ApprovalEffectSchema = z.discriminatedUnion('category', [
  z.strictObject({ category: z.literal('provider_calls') }),
  z.strictObject({ category: z.literal('downloads'), host: HostSchema }),
  z.strictObject({ category: z.literal('spend'), amountUsd: z.number().finite().nonnegative() }),
  z.strictObject({ category: ApprovalCategorySchema.exclude(['provider_calls', 'downloads', 'spend']) }),
]);

export interface ApprovalEffectFields {
  category?: string;
  amountUsd?: number;
  host?: string;
}

export function declaredAuthorization(declaration: unknown, request: ApprovalEffectFields): string | undefined {
  const declared = BriefAuthorizationsSchema.safeParse(declaration);
  const effect = ApprovalEffectSchema.safeParse(Object.fromEntries(
    Object.entries({ category: request.category, amountUsd: request.amountUsd, host: request.host })
      .filter(([, value]) => value !== undefined),
  ));
  if (!declared.success || !effect.success) return undefined;
  const value = effect.data;
  if (value.category === 'provider_calls' && declared.data.provider_calls) return 'authorizations.provider_calls';
  if (value.category === 'downloads' && declared.data.downloads?.hosts.includes(value.host)) return 'authorizations.downloads';
  if (value.category === 'spend' && declared.data.spend && value.amountUsd <= declared.data.spend.usd) return 'authorizations.spend';
  return undefined;
}
