/** One scheduler logger shared by extracted units and the facade. */
import { createLogger } from '../../logging.js';

export const log = createLogger({ name: 'scheduler' });
