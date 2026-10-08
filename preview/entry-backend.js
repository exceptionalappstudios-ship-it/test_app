import * as backend from './backend.js';

window.__preview = { ...backend, changed() {} };
