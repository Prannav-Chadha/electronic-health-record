import { makeStatusHandler } from './_lib.js';
import { getNeonDb } from './_db.js';

export default makeStatusHandler(getNeonDb());
