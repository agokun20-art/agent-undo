# Contributing

```sh
npm ci
npm run typecheck
npm test
```

The CLI uses Node's standard library and calls Git directly. Tests use Node's
test runner and isolated repositories. Run `npm run compile` and commit any
resulting `dist/` changes with the TypeScript sources. The precompiled CLI
lets npm install directly from Git without running a build during installation.

To add an agent:

1. Find its documented synchronous, pre-turn hook event and config format.
2. Add a module in `src/agents/` that implements the `Agent` interface. If its
   config uses an existing JSON layout, use the `projectHook` factory.
3. Register the module in `src/agents/index.ts`. Have the hook run
   `undoturn checkpoint --hook <agent>` and add any agent-specific response
   handling its documented protocol requires.
4. Test install, merge, repeat install, and uninstall in
   `test/agents.test.mjs`. Add the setup and official docs link to the README.

Don't overwrite unrelated settings or require a working agent account in CI.
