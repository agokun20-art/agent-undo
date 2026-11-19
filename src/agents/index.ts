import type { Agent } from './adapter.js';
import claude from './claude.js';
import codex from './codex.js';
import cursor from './cursor.js';
import gemini from './gemini.js';

export const agents: Readonly<Record<string, Agent>> = Object.fromEntries(
  [claude, codex, cursor, gemini].map((agent) => [agent.name, agent]),
);
