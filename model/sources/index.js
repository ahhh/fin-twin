/**
 * The source-type manifest.
 *
 * Importing this module registers every built-in source type. The registry mechanics live
 * in `registry.js` — they have to, because ES module imports are hoisted and a manifest
 * sharing a file with the registry would call `registerSourceType` before that file's own
 * declarations had initialised.
 *
 * Static imports on purpose: `import()` would break on a GitHub Pages project subpath and
 * would need a build step to resolve.
 *
 * ADDING A SOURCE TYPE: write `sources/<type>.js`, add one line below. Nothing else in the
 * engine or the UI needs to change.
 */

import './salary.js';
import './expense.js';
import './contract.js';
import './transfer.js';
import './loan.js';
import './asset.js';
import './royalty.js';
import './fixed-contract.js';
import './windfall.js';
import './investment-income.js';

export {
  RegistryError,
  complexityOf,
  fieldSpecFor,
  getPath,
  getSourceType,
  hasSourceType,
  listSourceTypeNames,
  listSourceTypes,
  registerSourceType,
  resetRegistryForTests,
  setPath,
  sourceTypesByFamily,
} from './registry.js';
