export interface CheckContext {
  taskDir: string;
  projectDir: string;
  briefPath?: string;
  /** Runtime input capability, supplied only by runAllChecks. */
  declaredReads?: import('../artifact-declarations.js').ArtifactRead[];
  /** Runtime authority rebuilt by the parent, never read from check params. */
  commandBoundary?: Omit<import('../write-boundary.js').EngineCommandBoundaryInput, 'authority'> & { authority: 'project-command' };
}

export interface CheckResult {
  pass: boolean;
  details: string;
  /**
   * A handler may identify an execution-environment defect that makes its
   * evidence unavailable rather than false. Only an explicit true is advisory.
   */
  advisory?: boolean;
  evidence?: object;
}

export interface RealityCheck {
  run(params: object, context: CheckContext): Promise<CheckResult>;
}

interface ValidCheckDecl {
  /** Mandatory for newly submitted checks; optional only to describe archived records. */
  reads?: import('../artifact-declarations.js').ArtifactRead[];
  kind?: 'check';
  name: string;
  type: string;
  params: object;
  /**
   * Advisory checks preserve evidence and operator visibility but do not block
   * a truthful terminal verdict. Omitted/false always means a hard check.
   */
  advisory?: boolean;
}

interface InvalidCheckDecl {
  kind: 'invalid';
  name: string;
  type: '__invalid-reality-check-declaration__';
  diagnostic: string;
}

export type CheckDecl = ValidCheckDecl | InvalidCheckDecl;

/** Durable process outcome recorded alongside complete exec-script streams. */
export interface RealityGateExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface RealityGateCheckReport {
  name: string;
  type: string;
  pass: boolean;
  details: string;
  advisory?: boolean;
  evidence?: object;
}

export interface RealityGateReport {
  pass: boolean;
  checkedAt: string;
  checksRun: number;
  results: RealityGateCheckReport[];
}
