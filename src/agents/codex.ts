import { projectHook } from './adapter.js';

export default projectHook({
  name: 'codex',
  docs: 'https://developers.openai.com/codex/hooks',
  file: '.codex/hooks.json',
  event: 'UserPromptSubmit',
  timeout: 10,
  layout: 'grouped',
});
