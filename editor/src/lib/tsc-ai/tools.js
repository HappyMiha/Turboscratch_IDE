/* eslint-disable valid-jsdoc */
/**
 * Ada's tools. They run here in the editor, look at the open project and the
 * debugger console, and return text for Ada. The server lists the same tool
 * names and descriptions (collab-server/ai/helper.js).
 *
 * Tool inputs stream from the model as they're written, so every input is
 * checked here before a tool runs.
 */

import {formatEntries, getEntries, checkVariablesNow, stopAllByAda} from './console';
import {scriptsToText, countScripts} from './script-text';
import {clipText, wellFormed} from './text-utils';

const MAX_RESULT = 38000;
const MAX_LIST_ITEMS = 50;
const MAX_VALUE = 200;

class InvalidInput extends Error {}

const clip = (value, max = MAX_VALUE) => clipText(value, max);

/** The name of a target's current costume (a broken project may have none). */
const costumeName = target => {
    const costume = target.getCostumes()[target.currentCostume];
    return costume ? costume.name : null;
};

const nameOf = target => (target.isStage ? 'Stage' : target.sprite.name);

const originals = vm => vm.runtime.targets.filter(target => target.isOriginal);
const sprites = vm => originals(vm).filter(target => !target.isStage);

// "_stage_" always means the Stage (Scratch doesn't let sprites use that
// name), even in a project where someone named a sprite "Stage".
const STAGE_ALIAS = '_stage_';

const findTarget = (vm, name) => {
    const all = sprites(vm);
    if (name === STAGE_ALIAS) return vm.runtime.getTargetForStage();
    const exact = all.find(target => target.sprite.name === name);
    if (exact) return exact;
    if (name.toLowerCase() === 'stage') return vm.runtime.getTargetForStage();
    const lower = name.toLowerCase();
    const loose = all.filter(target => target.sprite.name.toLowerCase() === lower);
    if (loose.length === 1) return loose[0];
    throw new InvalidInput(`There is no sprite called ${JSON.stringify(name)}. The sprites are: ` +
        `${all.map(target => JSON.stringify(target.sprite.name)).join(', ') || '(none)'}, and the Stage.`);
};

// ---- checking inputs ----------------------------------------------------------

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

const checkInput = (name, input) => {
    if (!isObject(input)) throw new InvalidInput('The tool input must be a JSON object.');
    const spriteName = required => {
        if (typeof input.sprite === 'undefined' && !required) return null;
        if (typeof input.sprite !== 'string' || !input.sprite.trim() || input.sprite.length > 200) {
            throw new InvalidInput('"sprite" must be the name of a sprite, or "Stage" (or "_stage_").');
        }
        return input.sprite;
    };
    switch (name) {
    case 'get_project_overview':
    case 'stop_project':
        return {};
    case 'get_scripts': {
        const sprite = spriteName(true);
        if (typeof input.script === 'undefined') return {sprite, script: null};
        if (!Number.isInteger(input.script) || input.script < 1 || input.script > 100000) {
            throw new InvalidInput('"script" must be a script number like 1, 2 or 3.');
        }
        return {sprite, script: input.script};
    }
    case 'get_sprite_state':
        return {sprite: spriteName(true)};
    case 'get_variables':
        return {sprite: spriteName(false)};
    case 'read_console': {
        if (typeof input.limit === 'undefined') return {limit: 60};
        if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) {
            throw new InvalidInput('"limit" must be a whole number from 1 to 200.');
        }
        return {limit: input.limit};
    }
    case 'run_project': {
        if (typeof input.seconds !== 'number' || !isFinite(input.seconds) || input.seconds < 1 || input.seconds > 10) {
            throw new InvalidInput('"seconds" must be a number from 1 to 10.');
        }
        return {seconds: input.seconds};
    }
    default:
        throw new InvalidInput(`There is no tool called ${JSON.stringify(name)}.`);
    }
};

// ---- describing the project ---------------------------------------------------

const variablesOf = (target, type) => Object.keys(target.variables)
    .map(id => target.variables[id])
    .filter(variable => variable.type === type);

const describeVariables = target => {
    const result = {};
    const variables = variablesOf(target, '');
    if (variables.length) {
        result.variables = {};
        for (const variable of variables) {
            result.variables[variable.name] = typeof variable.value === 'string' ?
                clip(variable.value) :
                variable.value;
        }
    }
    const lists = variablesOf(target, 'list');
    if (lists.length) {
        result.lists = {};
        for (const list of lists) {
            const items = list.value.slice(0, MAX_LIST_ITEMS).map(item => clip(item, 100));
            result.lists[list.name] = list.value.length > MAX_LIST_ITEMS ?
                {length: list.value.length, first50Items: items} :
                items;
        }
    }
    return result;
};

const isRunning = vm => vm.runtime.threads.some(thread => !thread.updateMonitor && !thread.stackClick);

const projectOverview = vm => {
    const runtime = vm.runtime;
    const stage = runtime.getTargetForStage();
    const editing = vm.editingTarget;
    let extensions = [];
    try {
        extensions = Array.from(vm.extensionManager._loadedExtensions.keys());
    } catch (e) {
        // not important
    }
    const overview = {
        selectedInEditor: editing ? nameOf(editing) : null,
        running: isRunning(vm),
        turboMode: !!runtime.turboMode,
        framerate: runtime.frameLoop ? runtime.frameLoop.framerate : 30,
        stage: Object.assign({
            backdrops: stage.getCostumes().map(c => c.name),
            currentBackdrop: costumeName(stage),
            sounds: stage.getSounds().map(s => s.name)
        }, countScripts(stage)),
        sprites: sprites(vm)
            .sort((a, b) => a.getLayerOrder() - b.getLayerOrder())
            .map(target => Object.assign({
                name: target.sprite.name,
                costumes: target.getCostumes().slice(0, 40)
                    .map(c => c.name),
                currentCostume: costumeName(target),
                sounds: target.getSounds().slice(0, 40)
                    .map(s => s.name),
                visible: target.visible,
                clones: target.sprite.clones.length - 1,
                localVariables: variablesOf(target, '').map(v => v.name),
                localLists: variablesOf(target, 'list').map(v => v.name)
            }, countScripts(target))),
        globalVariables: variablesOf(stage, '').map(v => v.name),
        globalLists: variablesOf(stage, 'list').map(v => v.name),
        broadcasts: variablesOf(stage, 'broadcast_msg').map(v => v.name),
        extensions
    };
    if (sprites(vm).some(target => target.sprite.name.toLowerCase() === 'stage')) {
        overview.note = 'A sprite is named "Stage". Use "_stage_" to mean the real Stage.';
    }
    return overview;
};

const variablesReport = (vm, spriteName) => {
    const stage = vm.runtime.getTargetForStage();
    const result = {global: describeVariables(stage)};
    const targets = spriteName ? [findTarget(vm, spriteName)] : sprites(vm);
    const local = {};
    for (const target of targets) {
        if (target.isStage) continue;
        const described = describeVariables(target);
        if (Object.keys(described).length) local[target.sprite.name] = described;
    }
    if (Object.keys(local).length) result.spriteLocal = local;
    return result;
};

const spriteState = (vm, target) => {
    const costumes = target.getCostumes();
    const effects = {};
    for (const effect of Object.keys(target.effects || {})) {
        if (target.effects[effect] !== 0) effects[effect] = target.effects[effect];
    }
    const looksState = target.getCustomState ? target.getCustomState('Scratch.looks') : null;
    const bubble = looksState && looksState.text ? {[looksState.type]: clip(looksState.text)} : null;
    if (target.isStage) {
        return {
            name: 'Stage',
            backdrop: {name: costumeName(target), number: target.currentCostume + 1},
            graphicEffects: effects,
            volume: target.volume
        };
    }
    return {
        name: target.sprite.name,
        x: Math.round(target.x * 100) / 100,
        y: Math.round(target.y * 100) / 100,
        direction: target.direction,
        size: Math.round(target.size * 100) / 100,
        costume: {name: costumeName(target), number: target.currentCostume + 1, of: costumes.length},
        visible: target.visible,
        layer: target.getLayerOrder(),
        rotationStyle: target.rotationStyle,
        draggable: target.draggable,
        graphicEffects: effects,
        volume: target.volume,
        sayingOrThinking: bubble,
        clones: target.sprite.clones.length - 1,
        selectedInEditor: vm.editingTarget === target
    };
};

// ---- running ------------------------------------------------------------------

const wait = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
        reject(new DOMException('Stopped', 'AbortError'));
        return;
    }
    let timer = null;
    const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Stopped', 'AbortError'));
    };
    timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, {once: true});
});

const runProject = async (vm, seconds, signal) => {
    const lastId = getEntries().length ? getEntries()[getEntries().length - 1].id : 0;
    vm.greenFlag();
    // What the sprites look like is read before stopping: stopping deletes
    // the clones and clears graphic effects.
    const spriteLines = [];
    let variables = null;
    try {
        await wait(seconds * 1000, signal);
        checkVariablesNow();
        for (const target of sprites(vm)) {
            const state = spriteState(vm, target);
            spriteLines.push(`${state.name}: x ${state.x}, y ${state.y}, direction ${state.direction}, ` +
                `costume ${JSON.stringify(state.costume.name)}, ${state.visible ? 'shown' : 'hidden'}` +
                `${state.clones ? `, ${state.clones} clones` : ''}`);
        }
        variables = variablesReport(vm, null);
    } finally {
        stopAllByAda(vm);
    }
    const during = getEntries().filter(entry => entry.id > lastId);
    const shown = during.slice(-150);
    const lines = [`Clicked the green flag, watched for ${seconds} seconds, then stopped the project.`, ''];
    lines.push(during.length ?
        `Debugger console during the run${during.length > shown.length ? ' (newest 150 entries)' : ''}:` :
        'The debugger console recorded nothing during the run.');
    if (shown.length) lines.push(formatEntries(shown));
    lines.push('', 'Sprites just before it was stopped:');
    lines.push(...spriteLines);
    lines.push('', `Variables just before it was stopped: ${JSON.stringify(variables)}`);
    return lines.join('\n');
};

// ---- the tools ------------------------------------------------------------------

const execute = (vm, name, input, signal) => {
    switch (name) {
    case 'get_project_overview':
        return JSON.stringify(projectOverview(vm));
    case 'get_scripts': {
        const target = findTarget(vm, input.sprite);
        return `Scripts of ${nameOf(target)}:\n\n${scriptsToText(target, vm.runtime, {scriptNumber: input.script})}`;
    }
    case 'get_variables':
        return JSON.stringify(variablesReport(vm, input.sprite));
    case 'get_sprite_state':
        return JSON.stringify(spriteState(vm, findTarget(vm, input.sprite)));
    case 'read_console': {
        const entries = getEntries().slice(-input.limit);
        if (!entries.length) return 'The debugger console is empty.';
        return `Newest ${entries.length} debugger console entries (oldest first):\n${formatEntries(entries)}`;
    }
    case 'run_project':
        return runProject(vm, input.seconds, signal);
    case 'stop_project':
        stopAllByAda(vm);
        return 'Stopped the project.';
    }
    throw new InvalidInput(`There is no tool called ${JSON.stringify(name)}.`);
};

/**
 * Runs one of Ada's tools. Returns {content, isError}; never throws, except
 * when the person stops Ada (an AbortError).
 */
const runTool = async (vm, name, rawInput, signal) => {
    let input;
    try {
        input = checkInput(name, rawInput);
    } catch (e) {
        return {
            content: `INVALID_JSON: the input for ${name} wasn't valid: ${e.message} ` +
                'Call the tool again with valid input.',
            isError: true
        };
    }
    try {
        const content = await execute(vm, name, input, signal);
        const clipped = content.length > MAX_RESULT ? `${clipText(content, MAX_RESULT)}\n(cut off, too long)` : content;
        return {content: wellFormed(clipped), isError: false};
    } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (e instanceof InvalidInput) return {content: wellFormed(e.message), isError: true};
        return {content: wellFormed(`The tool failed: ${e && e.message ? e.message : e}`), isError: true};
    }
};

/** What the chat shows while Ada uses a tool. */
const describeToolUse = (name, input) => {
    const sprite = input && typeof input.sprite === 'string' ? clip(input.sprite, 40) : null;
    switch (name) {
    case 'get_project_overview': return 'Looked at the project';
    case 'get_scripts': return `Read the scripts of ${sprite || 'a sprite'}`;
    case 'get_variables': return sprite ? `Checked the variables of ${sprite}` : 'Checked the variables';
    case 'get_sprite_state': return `Checked where ${sprite || 'a sprite'} is and how it looks`;
    case 'read_console': return 'Read the debugger console';
    case 'run_project': {
        const seconds = input && typeof input.seconds === 'number' ? input.seconds : '';
        return `Ran the project for ${seconds} seconds`;
    }
    case 'stop_project': return 'Stopped the project';
    }
    return `Used ${clip(name, 40)}`;
};

export {
    describeToolUse,
    runTool
};
