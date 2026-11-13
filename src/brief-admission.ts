/** Frozen record codec: no scheduler, stage, or store dependencies. */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { BRIEF_DECLARATION_VERSION, BriefDeclarationsSchema, type BriefDeclarations } from './brief-declarations.js';
export type BriefAdmissionAcknowledgement =
  | { kind: 'not_required' }
  | {
      kind: 'explicit';
      source: 'cli_current_input_flag' | 'cli_digest_flag' | 'dashboard_receipt';
      at: string;
    };

export interface FrozenBriefContract {
  schemaVersion: typeof BRIEF_DECLARATION_VERSION;
  declaration: BriefDeclarations;
  contractHash: string;
  /** Exact admitted UTF-8 bytes, independent of the convenience sidecar. */
  brief: string;
}

export interface BriefAdmissionRecord {
  version: 1;
  digest: string;
  acknowledgement: BriefAdmissionAcknowledgement;
  contract?: FrozenBriefContract;
}

export interface BriefAdmissionVerification {
  digest: string;
  status: 'valid' | 'missing' | 'digest_mismatch' | 'contract_hash_missing' | 'contract_hash_mismatch';
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Object order has no meaning; array order and exact strings do. */
export const canonicalDeclaration = canonicalJson;
export function declarationHash(declaration: BriefDeclarations): string {
  return sha256(canonicalDeclaration({ schemaVersion: BRIEF_DECLARATION_VERSION, declaration }));
}
export class ContractRefusal extends Error {
  constructor(readonly code: 'contract_hash_missing' | 'contract_hash_mismatch') {
    super(`CONTRACT_REFUSED: ${code}`); this.name = 'ContractRefusal';
  }
}
/** Active consumers use this boundary. Historical display needs no migration. */
export function admittedContract(record: BriefAdmissionRecord | undefined): FrozenBriefContract {
  if (!record?.contract?.contractHash) throw new ContractRefusal('contract_hash_missing');
  const contract = record.contract;
  const parsed = BriefDeclarationsSchema.safeParse(contract.declaration);
  if (record.version !== 1 || contract.schemaVersion !== BRIEF_DECLARATION_VERSION || !parsed.success
    || canonicalDeclaration(parsed.data) !== canonicalDeclaration(contract.declaration)
    || declarationHash(contract.declaration) !== contract.contractHash
    || typeof contract.brief !== 'string' || sha256(contract.brief) !== record.digest) {
    throw new ContractRefusal('contract_hash_mismatch');
  }
  return contract;
}

export function verifyBriefAdmission(
  brief: string,
  record: BriefAdmissionRecord | undefined,
): BriefAdmissionVerification {
  const digest = sha256(brief);
  if (!record || record.version !== 1) return { digest, status: 'missing' };
  try { admittedContract(record); }
  catch (error) { if (error instanceof ContractRefusal) return { digest, status: error.code }; throw error; }
  const status = record.digest === digest ? 'valid' : 'digest_mismatch';
  return { digest, status };
}
