export interface CheckContext {
  taskDir: string;
  projectDir: string;
  briefPath?: string;
}

export interface CheckResult {
  pass: boolean;
  details: string;
  evidence?: object;
}

export interface RealityCheck {
  run(params: object, context: CheckContext): Promise<CheckResult>;
}

export interface CheckDecl {
  name: string;
  type: string;
  params: object;
}

export interface RealityGateCheckReport {
  name: string;
  type: string;
  pass: boolean;
  details: string;
  evidence?: object;
}

export interface RealityGateReport {
  pass: boolean;
  checkedAt: string;
  checksRun: number;
  results: RealityGateCheckReport[];
}
