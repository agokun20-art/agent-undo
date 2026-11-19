import { projectHook } from './adapter.js';
export default projectHook({
    name: 'gemini',
    docs: 'https://geminicli.com/docs/hooks/',
    file: '.gemini/settings.json',
    event: 'BeforeAgent',
    timeout: 10_000,
    layout: 'grouped',
});
