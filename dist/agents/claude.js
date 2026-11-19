import { projectHook } from './adapter.js';
export default projectHook({
    name: 'claude',
    docs: 'https://code.claude.com/docs/en/hooks',
    file: '.claude/settings.json',
    event: 'UserPromptSubmit',
    timeout: 10,
    layout: 'grouped',
});
