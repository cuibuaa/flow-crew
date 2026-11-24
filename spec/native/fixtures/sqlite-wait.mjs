import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
const execute = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (!sql.includes('busy_timeout=') || !sql.includes('sqlite_master')) return execute.call(this, sql);
  writeFileSync(process.env.FC_WAIT_OBSERVATION, 'entered');
  const result = execute.call(this, sql);
  writeFileSync(process.env.FC_WAIT_OBSERVATION + '.returned', 'returned');
  return result;
};
