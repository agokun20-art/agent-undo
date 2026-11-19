import { projectHook } from './adapter.js';

export default projectHook({
  name: 'cursor',
  docs: 'https://cursor.com/docs/agent/hooks',
  file: '.cursor/hooks.json',
  event: 'beforeSubmitPrompt',
  timeout: 10,
  layout: 'cursor',
});
