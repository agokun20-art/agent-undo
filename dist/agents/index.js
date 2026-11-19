import claude from './claude.js';
import codex from './codex.js';
import cursor from './cursor.js';
import gemini from './gemini.js';
export const agents = Object.fromEntries([claude, codex, cursor, gemini].map((agent) => [agent.name, agent]));
