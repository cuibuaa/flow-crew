import type { CheckContext, RealityCheck } from '../types.js';
import { readJsonFile, result, valuesAtPath } from './_utils.js';

interface Params {
  file?: string;
  field_path?: string;
  min_stddev?: number;
}

export default class VarianceFloorCheck implements RealityCheck {
  static meta = { description: 'Require the stddev of numeric values at a JSON path to meet a floor (rejects degenerate/constant output).', params: 'file: string, field_path: string, min_stddev: number' };
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.file !== 'string') return result(false, '`params.file` must be provided; name the JSON input file and rerun the check.');
    if (typeof params.field_path !== 'string') return result(false, '`params.field_path` must be provided; name the numeric field and rerun the check.');
    if (typeof params.min_stddev !== 'number') return result(false, '`params.min_stddev` must be a number; set the contracted floor and rerun the check.');
    const values = valuesAtPath(readJsonFile(params.file, context), params.field_path).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const subject = `${JSON.stringify(params.file.slice(0, 160))} at ${JSON.stringify(params.field_path.slice(0, 160))}`;
    if (values.length < 2) return result(false, `${subject}: need at least 2 numeric values, found ${values.length}. Add valid observations or fix the file/field path, then rerun the check.`, { values });
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    const stddev = Math.sqrt(variance);
    return result(
      stddev >= params.min_stddev,
      stddev >= params.min_stddev
        ? `${subject}: stddev ${stddev.toFixed(6)} >= floor ${params.min_stddev}`
        : `${subject}: stddev ${stddev.toFixed(6)} < floor ${params.min_stddev}. Fix degenerate values so they vary honestly, or lower the floor only if the contract requires a different threshold.`,
      { values, stddev },
    );
  }
}
