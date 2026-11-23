/* eslint-disable valid-jsdoc */
/**
 * Turns a sprite's blocks into compact text that Ada can read, one block per
 * line, with blocks inside C-blocks indented. For example:
 *
 *   event_whenflagclicked
 *     control_forever
 *       motion_movesteps STEPS: (10)
 *       control_if CONDITION: <sensing_touchingobject TOUCHINGOBJECTMENU: [_edge_]>
 *         motion_turnright DEGREES: (15)
 */

import {clipText} from './text-utils';

const MAX_DEPTH = 60;
const INDENT = '  ';

const NUMBER_SHADOWS = new Set([
    'math_number', 'math_positive_number', 'math_whole_number', 'math_integer', 'math_angle'
]);
const BOOLEAN_OPCODES = new Set([
    'operator_and', 'operator_or', 'operator_not', 'operator_gt', 'operator_lt', 'operator_equals',
    'operator_contains', 'sensing_touchingobject', 'sensing_touchingcolor', 'sensing_coloristouchingcolor',
    'sensing_keypressed', 'sensing_mousedown', 'data_listcontainsitem', 'argument_reporter_boolean'
]);

const quote = value => JSON.stringify(String(value));

const parseJson = (text, fallback) => {
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) ? value : fallback;
    } catch (e) {
        return fallback;
    }
};

const createWriter = (target, runtime) => {
    const blocks = target.blocks;
    const all = blocks._blocks;
    const comments = target.comments || {};

    const procedureArgumentNames = proccode => {
        try {
            const info = blocks.getProcedureParamNamesAndIds(proccode);
            if (info) {
                const names = {};
                info[1].forEach((id, i) => {
                    names[id] = info[0][i];
                });
                return names;
            }
        } catch (e) {
            // fall through
        }
        return {};
    };

    // eslint-disable-next-line prefer-const
    let describeBlock;

    const describeInput = (input, depth) => {
        if (!input) return '()';
        const block = all[input.block];
        if (!block) {
            return '(empty)';
        }
        return describeBlock(block, depth);
    };

    const fieldText = field => {
        if (!field) return '';
        return `[${field.value}]`;
    };

    /** The text for a reporter, a boolean, or a menu/number/text slot. */
    describeBlock = (block, depth) => {
        if (depth > MAX_DEPTH) return '(…)';
        const fieldNames = Object.keys(block.fields || {});
        const inputNames = Object.keys(block.inputs || {});

        if (block.shadow && inputNames.length === 0 && fieldNames.length === 1) {
            const value = block.fields[fieldNames[0]].value;
            if (NUMBER_SHADOWS.has(block.opcode)) return `(${value})`;
            if (block.opcode === 'colour_picker') return `(color ${value})`;
            return `[${value}]`;
        }
        if (block.opcode === 'data_variable') return `(variable ${quote(block.fields.VARIABLE.value)})`;
        if (block.opcode === 'data_listcontents') return `(list ${quote(block.fields.LIST.value)})`;
        if (block.opcode === 'argument_reporter_string_number') return `(argument ${quote(block.fields.VALUE.value)})`;
        if (block.opcode === 'argument_reporter_boolean') return `<argument ${quote(block.fields.VALUE.value)}>`;

        // eslint-disable-next-line no-use-before-define
        const inner = describeLine(block, depth + 1);
        return BOOLEAN_OPCODES.has(block.opcode) ? `<${inner}>` : `(${inner})`;
    };

    /** One block's line, without its blocks inside or below. */
    const describeLine = (block, depth) => {
        const parts = [];
        const mutation = block.mutation || {};

        if (block.opcode === 'procedures_definition') {
            const prototype = all[block.inputs.custom_block && block.inputs.custom_block.block];
            const protoMutation = (prototype && prototype.mutation) || {};
            const names = parseJson(protoMutation.argumentnames, []);
            let text = `define ${quote(protoMutation.proccode || '?')}`;
            if (names.length) text += ` arguments: ${names.map(quote).join(', ')}`;
            if (String(protoMutation.warp) === 'true') text += ' (run without screen refresh)';
            return text;
        }
        if (block.opcode === 'procedures_call') {
            const ids = parseJson(mutation.argumentids, []);
            const names = procedureArgumentNames(mutation.proccode);
            parts.push(`call ${quote(mutation.proccode || '?')}`);
            for (const id of ids) {
                parts.push(`${names[id] || id}: ${describeInput(block.inputs[id], depth)}`);
            }
            return parts.join(' ');
        }

        parts.push(block.opcode);
        for (const name of Object.keys(block.fields || {})) {
            parts.push(`${name}: ${fieldText(block.fields[name])}`);
        }
        for (const name of Object.keys(block.inputs || {})) {
            if (name.startsWith('SUBSTACK')) continue;
            parts.push(`${name}: ${describeInput(block.inputs[name], depth)}`);
        }
        return parts.join(' ');
    };

    const commentFor = block => {
        if (!block.comment || !comments[block.comment]) return '';
        return `  // comment: ${quote(clipText(comments[block.comment].text, 300))}`;
    };

    const writeStack = (firstId, indent, lines, depth, seen) => {
        let id = firstId;
        while (id && all[id] && !seen.has(id)) {
            if (depth > MAX_DEPTH) {
                lines.push(`${indent}…`);
                return;
            }
            seen.add(id);
            const block = all[id];
            lines.push(`${indent}${describeLine(block, depth)}${commentFor(block)}`);
            const isIfElse = block.opcode === 'control_if_else';
            const substacks = isIfElse ? ['SUBSTACK', 'SUBSTACK2'] :
                Object.keys(block.inputs || {}).filter(name => name.startsWith('SUBSTACK'))
                    .sort();
            substacks.forEach((name, i) => {
                if (i > 0) lines.push(`${indent}${isIfElse ? 'else' : `(branch ${i + 1})`}`);
                const input = block.inputs[name];
                if (input && input.block) writeStack(input.block, indent + INDENT, lines, depth + 1, seen);
            });
            id = block.next;
        }
    };

    const isHat = opcode => opcode === 'procedures_definition' ||
        (runtime && typeof runtime.getIsHat === 'function' && runtime.getIsHat(opcode));

    return {all, comments, writeStack, isHat};
};

/** Keeps whole lines of a script that fit in maxChars, and says how many were left out. */
const cutLines = (lines, maxChars, number) => {
    const kept = [];
    let length = 0;
    for (const line of lines) {
        if (length + line.length + 1 > maxChars) break;
        kept.push(line);
        length += line.length + 1;
    }
    const left = lines.length - kept.length;
    kept.push(`${INDENT}… ${left} more line(s) of this script not shown` +
        `${number ? `; call get_scripts with script: ${number} to read it on its own` : ' (it is very long)'}.`);
    return kept.join('\n');
};

/**
 * Every script of a target as text, at most maxChars long. Scripts that don't
 * fit are listed by number, so Ada can read them one at a time by passing
 * scriptNumber.
 */
const scriptsToText = (target, runtime, {maxChars = 36000, scriptNumber = null} = {}) => {
    const {all, comments, writeStack, isHat} = createWriter(target, runtime);
    const tops = target.blocks.getScripts()
        .map(id => all[id])
        .filter(block => block && !block.shadow)
        .sort((a, b) => ((a.y || 0) - (b.y || 0)) || ((a.x || 0) - (b.x || 0)));

    if (tops.length === 0) return 'This sprite has no scripts.';

    const scriptLines = (top, number) => {
        const lines = [];
        const note = isHat(top.opcode) ? '' : ' (not under a hat block, so it only runs when clicked)';
        lines.push(`Script ${number} of ${tops.length}${note}:`);
        writeStack(top.id, INDENT, lines, 0, new Set());
        return lines;
    };

    if (scriptNumber !== null) {
        if (scriptNumber > tops.length) {
            return `There is no script ${scriptNumber}; this sprite has ${tops.length} script(s).`;
        }
        const lines = scriptLines(tops[scriptNumber - 1], scriptNumber);
        const text = lines.join('\n');
        return text.length <= maxChars ? text : cutLines(lines, maxChars, null);
    }

    const out = [];
    const skipped = [];
    let length = 0;
    tops.forEach((top, i) => {
        const number = i + 1;
        const lines = scriptLines(top, number);
        const text = lines.join('\n');
        const room = maxChars - length;
        if (text.length <= room) {
            out.push(text);
            length += text.length + 2;
        } else if (room > 3000 && out.length === 0) {
            // A huge first script: show its beginning rather than nothing.
            const cut = cutLines(lines, room - 200, number);
            out.push(cut);
            length += cut.length + 2;
        } else {
            skipped.push(`script ${number} (starts with ${lines[1] ? lines[1].trim()
                .slice(0, 80) : '?'}, ${lines.length - 1} lines)`);
        }
    });
    if (skipped.length) {
        const list = skipped.slice(0, 40).join('; ');
        out.push(`Not shown because the sprite is very big: ${list}` +
            `${skipped.length > 40 ? ` and ${skipped.length - 40} more` : ''}. ` +
            'Call get_scripts with script: <number> to read one of them.');
    }

    const loose = Object.keys(comments)
        .map(id => comments[id])
        .filter(comment => !comment.blockId && comment.text);
    if (loose.length) {
        out.push(`Workspace comments:\n${loose.slice(0, 30).map(c => `${INDENT}// ${quote(clipText(c.text, 300))}`)
            .join('\n')}`);
    }
    return out.join('\n\n');
};

/** How many scripts and blocks a target has. */
const countScripts = target => {
    const all = target.blocks._blocks;
    const scripts = target.blocks.getScripts().filter(id => all[id] && !all[id].shadow).length;
    const blocks = Object.keys(all).filter(id => !all[id].shadow).length;
    return {scripts, blocks};
};

export {
    scriptsToText,
    countScripts
};
