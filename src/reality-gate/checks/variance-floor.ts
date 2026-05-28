import type { CheckContext, RealityCheck } from '../types.js';
import { readJsonFile, result, valuesAtPath } from './_utils.js';

interface Params {
  file?: string;
  field_path?: string;
  min_stddev?: number;
}

export default class VarianceFloorCheck implements RealityCheck {
  async run(raw: object, context: CheckContext) {
    const params = raw as Params;
    if (typeof params.file !== 'string') return result(false, 'file must be provided');
    if (typeof params.field_path !== 'string') return result(false, 'field_path must be provided');
    if (typeof params.min_stddev !== 'number') return result(false, 'min_stddev must be a number');
    const values = valuesAtPath(readJsonFile(params.file, context), params.field_path).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (values.length < 2) return result(false, `need at least 2 numeric values, found ${values.length}`, { values });
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    const stddev = Math.sqrt(variance);
    return result(stddev >= params.min_stddev, `stddev ${stddev.toFixed(6)} ${stddev >= params.min_stddev ? '>=' : '<'} floor ${params.min_stddev}`, { values, stddev });
  }
}
