/** Registra o resolver de `.ts`. Use com `node --import ./tests/lib/ts.mjs <teste>`. */
import { register } from 'node:module';

register('./resolver-ts.mjs', import.meta.url);
