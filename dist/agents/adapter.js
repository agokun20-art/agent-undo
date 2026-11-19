import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function readConfig(file) {
    try {
        const stat = lstatSync(file);
        if (!stat.isFile())
            throw new Error(`Not a regular hook configuration file: ${file}`);
        const config = JSON.parse(readFileSync(file, 'utf8'));
        if (!isObject(config))
            throw new Error('Expected a JSON object');
        return { config, mode: stat.mode & 0o777 };
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { config: {} };
        throw new Error(`Cannot read ${file}: ${error.message}`);
    }
}
function writeConfig(file, config, mode = 0o600) {
    const parent = dirname(file);
    mkdirSync(parent, { recursive: true });
    const dir = mkdtempSync(join(parent, '.undoturn-'));
    const temp = join(dir, 'config.json');
    try {
        writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode });
        renameSync(temp, file);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export function projectHook(spec) {
    const command = `undoturn checkpoint --hook ${spec.name}`;
    const grouped = spec.layout === 'grouped';
    const match = (hook) => isObject(hook) && hook.command === command &&
        (grouped ? hook.type === 'command' : hook.type === undefined || hook.type === 'command');
    function rowsAt(config, file) {
        const hooks = config.hooks === undefined ? {} : config.hooks;
        if (!isObject(hooks))
            throw new Error(`Expected a hooks object in ${file}`);
        const rows = hooks[spec.event] === undefined ? [] : hooks[spec.event];
        if (!Array.isArray(rows))
            throw new Error(`Expected a hooks.${spec.event} array in ${file}`);
        return { hooks, rows };
    }
    function installed(rows) {
        return rows.some((row) => grouped
            ? isObject(row) && Array.isArray(row.hooks) && row.hooks.some(match)
            : match(row));
    }
    return {
        name: spec.name,
        docs: spec.docs,
        detect(root) {
            const file = join(root, spec.file);
            return installed(rowsAt(readConfig(file).config, file).rows);
        },
        install(root) {
            const file = join(root, spec.file);
            const { config, mode } = readConfig(file);
            const { hooks, rows } = rowsAt(config, file);
            if (installed(rows))
                return `Hook already installed in ${spec.file}.`;
            const hook = { command, timeout: spec.timeout };
            const row = grouped ? { hooks: [{ type: 'command', ...hook }] } : hook;
            if (!grouped && config.version === undefined)
                config.version = 1;
            config.hooks = { ...hooks, [spec.event]: [...rows, row] };
            writeConfig(file, config, mode);
            return `Installed ${spec.name} ${spec.event} hook in ${spec.file}.`;
        },
        uninstall(root) {
            const file = join(root, spec.file);
            const { config, mode } = readConfig(file);
            const { hooks, rows } = rowsAt(config, file);
            if (!installed(rows))
                return `No undoturn hook in ${spec.file}.`;
            const remaining = grouped ? rows.flatMap((row) => {
                if (!isObject(row) || !Array.isArray(row.hooks) || !row.hooks.some(match))
                    return [row];
                const nested = row.hooks.filter((hook) => !match(hook));
                return nested.length ? [{ ...row, hooks: nested }] : [];
            }) : rows.filter((row) => !match(row));
            if (remaining.length)
                hooks[spec.event] = remaining;
            else
                delete hooks[spec.event];
            config.hooks = hooks;
            writeConfig(file, config, mode);
            return `Removed undoturn hook from ${spec.file}.`;
        },
    };
}
