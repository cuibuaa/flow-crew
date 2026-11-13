/** Admission declaration. Neither event contents nor filesystem metadata select authority. */
export const LIFECYCLE_AUTHORITY = 'event-log-v1' as const;

export function hasLifecycleAuthority(record: { lifecycleAuthority?: unknown }): boolean {
  if (!Object.hasOwn(record, 'lifecycleAuthority') || record.lifecycleAuthority === undefined) return false;
  if (record.lifecycleAuthority === LIFECYCLE_AUTHORITY) return true;
  throw new Error('Unsupported run lifecycle authority declaration');
}
