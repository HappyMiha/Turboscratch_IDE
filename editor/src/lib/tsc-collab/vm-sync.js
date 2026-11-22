/* eslint-disable valid-jsdoc */
/**
 * Bridges the Scratch VM and the collaboration session.
 *
 *  - Captures LOCAL edits as small JSON "ops":
 *      * block edits: the Blockly events the VM applies to the editing target
 *      * everything else: calls to VM methods (rename sprite, add costume, ...)
 *  - Applies REMOTE ops to the project, and to the visible block workspace
 *    when they affect the sprite you're looking at.
 *
 * Sprites are matched between computers by name (target IDs are random per
 * computer). Blocks, variables and comments keep their IDs.
 *
 * Copyright (C) 2026 TurboScratch IDE contributors. GPL-3.0.
 */

import log from '../log';
import {arrayBufferToBase64, base64ToArrayBuffer} from '../tw-base64-utils';
import LazyScratchBlocks from '../tw-lazy-scratch-blocks';
import AddonHooks from '../../addons/hooks';
import {saveFullProject, exportFullSprite, readSettingsFromProject, applySettings} from './full-sb3';
import {pushToast} from './store';

/** Workspace events that change the project (UI-only events are ignored). */
const BLOCK_EVENT_TYPES = new Set([
    'create', 'delete', 'move', 'change',
    'var_create', 'var_rename', 'var_delete',
    'comment_create', 'comment_change', 'comment_move', 'comment_delete'
]);

/**
 * VM methods replayed as-is on other computers.
 *   targetArgs: argument positions holding a target ID (sent as a sprite name)
 *   editing:    uses vm.editingTarget implicitly (we send which sprite that was)
 */
const CALL_METHODS = {
    renameSprite: {targetArgs: [0]},
    deleteSprite: {targetArgs: [0]},
    renameCostume: {editing: true},
    deleteCostume: {editing: true},
    duplicateCostume: {editing: true},
    reorderCostume: {targetArgs: [0]},
    updateSvg: {editing: true},
    updateBitmap: {editing: true},
    shareCostumeToTarget: {editing: true, targetArgs: [1]},
    addCostume: {targetArgs: [2]},
    addBackdrop: {},
    renameSound: {editing: true},
    deleteSound: {editing: true},
    duplicateSound: {editing: true},
    reorderSound: {targetArgs: [0]},
    updateSoundBuffer: {editing: true},
    shareSoundToTarget: {editing: true, targetArgs: [1]},
    addSound: {targetArgs: [1]},
    postSpriteInfo: {editing: true},
    setVariableValue: {targetArgs: [0]},
    setFramerate: {},
    setInterpolation: {},
    setRuntimeOptions: {},
    setCompilerOptions: {},
    setStageSize: {}
};

const FONT_METHODS = ['addSystemFont', 'addCustomFont', 'deleteFont'];

const SPRITE_INFO_INTERVAL = 60;

/** JSON with sorted object keys, so equal data always gives equal text. */
const stableStringify = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
};

const sha256Hex = async text => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
};

// ---- value encoding ----------------------------------------------------------

const isAsset = value => value && typeof value === 'object' && value.assetType &&
    typeof value.assetType.name === 'string' && typeof value.assetId === 'string' &&
    value.data && typeof value.dataFormat === 'string';

const bytesToBase64 = view => arrayBufferToBase64(
    view instanceof ArrayBuffer ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
);

const encodeValue = value => {
    if (value === null || typeof value !== 'object') {
        return typeof value === 'function' ? null : value;
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return {__bytes: bytesToBase64(value)};
    }
    if (typeof ImageData !== 'undefined' && value instanceof ImageData) {
        return {
            __imageData: {
                width: value.width,
                height: value.height,
                data: bytesToBase64(value.data)
            }
        };
    }
    if (typeof Element !== 'undefined' && value instanceof Element) {
        // The VM only ever reads `.outerHTML` from these, so send exactly that.
        return {__dom: value.outerHTML};
    }
    if (typeof AudioBuffer !== 'undefined' && value instanceof AudioBuffer) {
        // Rebuilt from the WAV bytes on the other side
        return {__audioBuffer: true};
    }
    if (isAsset(value)) {
        return {
            __asset: {
                type: value.assetType.name,
                dataFormat: value.dataFormat,
                assetId: value.assetId,
                data: bytesToBase64(value.data)
            }
        };
    }
    if (Array.isArray(value)) return value.map(encodeValue);
    const out = {};
    for (const key of Object.keys(value)) {
        const encoded = encodeValue(value[key]);
        if (typeof encoded !== 'undefined') out[key] = encoded;
    }
    return out;
};

/** Fields of a costume/sound object worth sending (no skins, players, ...). */
const ASSET_OBJECT_FIELDS = [
    'name', 'assetId', 'dataFormat', 'md5', 'md5ext', 'bitmapResolution',
    'rotationCenterX', 'rotationCenterY', 'rate', 'sampleCount', 'format', 'asset'
];

const encodeAssetObject = object => {
    const picked = {};
    for (const key of ASSET_OBJECT_FIELDS) {
        if (typeof object[key] !== 'undefined') picked[key] = object[key];
    }
    return encodeValue(picked);
};

// ---- the bridge ----------------------------------------------------------------

class VMSync {
    /**
     * @param {VirtualMachine} vm the editor's VM
     * @param {function(object)} onOp called with each local op, in order
     */
    constructor (vm, onOp) {
        this.vm = vm;
        this.runtime = vm.runtime;
        this.onOp = onOp;

        this.capturing = false;
        /** >0 while applying other people's ops or loading the room's project */
        this.applyDepth = 0;
        /** >0 while inside a wrapped VM method (so nested calls aren't sent twice) */
        this.callDepth = 0;
        /** >0 while someone else's async edit (sprite upload, project load...) finishes */
        this.remoteAsync = 0;

        this.outgoing = Promise.resolve();
        this.pendingOutgoing = 0;

        this.pendingSpriteInfo = null;
        this.spriteInfoTimer = null;
        this.lastSpriteInfoSent = 0;

        this.workspaceRefreshTimer = null;
        this.restorers = [];

        /** Blockly events fired by a workspace redraw are not edits (see install). */
        this.redrawingWorkspace = false;
        /** Sprites already sent (or received) so overlapping uploads aren't sent twice. */
        this.knownSpriteIds = new Set();
        /** >0 while our own project load / sprite upload runs (its inner steps aren't edits). */
        this.localLoads = 0;
        /** Called when an edit from someone else can't be applied and we must leave. */
        this.onFatal = () => {};
    }

    // ---- setup ----------------------------------------------------------

    install () {
        if (this.installed) return;
        this.installed = true;
        const sync = this;
        const vm = this.vm;

        // 1. Block edits. Every workspace event the VM applies goes through
        //    Blocks.prototype.blocklyListen, so we listen there.
        const BlocksProto = Object.getPrototypeOf(this.runtime.flyoutBlocks);
        const originalListen = BlocksProto.blocklyListen;
        BlocksProto.blocklyListen = function (e) {
            const op = sync.captureBlockEvent(this, e);
            const result = originalListen.call(this, e);
            if (op) sync.queueOp(() => op);
            return result;
        };
        this.restorers.push(() => {
            BlocksProto.blocklyListen = originalListen;
        });

        // 2. VM methods replayed on other computers.
        for (const method of Object.keys(CALL_METHODS)) {
            this.wrap(vm, method, (original, args) => this.captureCall(method, original, args));
        }

        // 3. Things that need special handling.
        this.wrap(vm, 'addSprite', (original, args) => this.captureNewSprites(() => original(...args)));
        this.wrap(vm, 'duplicateSprite', (original, args) => this.captureNewSprites(() => original(...args)));
        this.wrap(vm, 'shareBlocksToTarget', (original, args) => this.captureSharedBlocks(original, args));
        this.wrap(vm, 'reorderTarget', (original, args) => this.captureReorderTarget(original, args));
        this.wrap(vm, 'loadProject', (original, args) => this.captureProjectLoad(original, args));
        this.wrap(vm.extensionManager, 'loadExtensionURL', (original, args) => this.captureExtension(original, args));
        this.wrap(vm, 'storeProjectOptions', original => this.captureProjectOptions(original));
        const fontManager = this.runtime.fontManager;
        if (fontManager) {
            for (const method of FONT_METHODS) {
                this.wrap(fontManager, method, (original, args) => this.captureFont(method, original, args));
            }
        }
        if (vm.renderer && typeof vm.renderer.setUseHighQualityRender === 'function') {
            this.wrap(vm.renderer, 'setUseHighQualityRender', (original, args) => {
                const result = original(...args);
                this.queueOp(() => ({kind: 'hqPen', enabled: !!args[0]}));
                return result;
            });
        }

        // 4. When the GUI redraws the workspace (switching sprites, refreshes),
        //    Blockly replays delete/create events for every script one tick
        //    later. They describe the redraw, not edits, so don't send them.
        //    Two timeouts: Blockly's own flush timer was scheduled during the
        //    redraw, so ours runs after it.
        const onWorkspaceUpdate = () => {
            this.redrawingWorkspace = true;
            clearTimeout(this.redrawTimer);
            this.redrawTimer = setTimeout(() => {
                this.redrawTimer = setTimeout(() => {
                    this.redrawingWorkspace = false;
                }, 0);
            }, 0);
        };
        vm.on('workspaceUpdate', onWorkspaceUpdate);
        this.restorers.push(() => vm.removeListener('workspaceUpdate', onWorkspaceUpdate));
    }

    uninstall () {
        for (const restore of this.restorers.reverse()) restore();
        this.restorers = [];
        this.installed = false;
    }

    /**
     * Replace obj[name] with a wrapper. The handler decides whether to capture;
     * when we must not capture, the original runs untouched.
     */
    wrap (obj, name, handler) {
        if (typeof obj[name] !== 'function') {
            log.warn(`[collab] cannot wrap missing method ${name}`);
            return;
        }
        const ownOriginal = Object.prototype.hasOwnProperty.call(obj, name) ? obj[name] : null;
        // If the method lives on the prototype, look it up on every call so
        // addons that patch the prototype later (e.g. sprite folders) still run.
        const getOriginal = () => ownOriginal || Object.getPrototypeOf(obj)[name];
        const sync = this;
        const bound = (...args) => getOriginal().apply(obj, args);
        obj[name] = function (...args) {
            if (!sync.shouldCapture()) {
                return getOriginal().apply(this, args);
            }
            if (name !== 'postSpriteInfo') sync.flushSpriteInfo();
            sync.callDepth++;
            try {
                return handler(bound, args);
            } finally {
                sync.callDepth--;
            }
        };
        this.restorers.push(() => {
            if (ownOriginal) {
                obj[name] = ownOriginal;
            } else {
                delete obj[name];
            }
        });
    }

    setCapturing (capturing) {
        this.capturing = capturing;
        if (!capturing) {
            clearTimeout(this.spriteInfoTimer);
            this.spriteInfoTimer = null;
            this.pendingSpriteInfo = null;
        }
    }

    shouldCapture () {
        return this.capturing && this.applyDepth === 0 && this.callDepth === 0;
    }

    hasPendingOutgoing () {
        return this.pendingOutgoing > 0 || !!this.pendingSpriteInfo;
    }

    /**
     * Ops are sent strictly in the order the edits happened, even when an op
     * needs async work first (like exporting a new sprite).
     * @param {function(): (object|Promise<object>)} produce makes the op
     */
    queueOp (produce) {
        this.pendingOutgoing++;
        this.outgoing = this.outgoing
            .then(produce)
            .then(op => {
                if (op && this.capturing) this.onOp(op);
            })
            .catch(e => log.error('[collab] could not send an edit', e))
            .then(() => {
                this.pendingOutgoing--;
            });
    }

    // ---- target references ------------------------------------------------

    ref (target) {
        if (!target) return null;
        if (target.isStage) return {stage: true};
        return {name: target.getName()};
    }

    refById (id) {
        return this.ref(this.runtime.getTargetById(id));
    }

    resolve (ref) {
        if (!ref) return null;
        if (ref.stage) return this.runtime.getTargetForStage();
        return this.runtime.getSpriteTargetByName(ref.name) || null;
    }

    // ---- capturing local edits ----------------------------------------------

    captureBlockEvent (blocks, e) {
        if (!this.shouldCapture() || !e || !BLOCK_EVENT_TYPES.has(e.type)) return null;
        if (this.redrawingWorkspace) return null;
        const target = this.vm.editingTarget;
        if (!target || blocks !== target.blocks) return null;
        if (!this.changesProject(target, e)) return null;
        let blockly = null;
        try {
            blockly = typeof e.toJson === 'function' ? e.toJson() : null;
        } catch (err) {
            blockly = null;
        }
        return {
            kind: 'blocks',
            target: this.ref(target),
            // Blockly keeps `type` on the event's prototype, so copy it explicitly.
            event: encodeValue(Object.assign({}, e, {type: e.type})),
            blockly
        };
    }

    /**
     * Loading a sprite into the workspace replays create/move events for
     * blocks the VM already has. Those don't change anything, so skip them.
     */
    changesProject (target, e) {
        const blocks = target.blocks._blocks;
        const stage = this.runtime.getTargetForStage();
        switch (e.type) {
        case 'create':
            return !Object.prototype.hasOwnProperty.call(blocks, e.blockId);
        case 'delete':
            return Object.prototype.hasOwnProperty.call(blocks, e.blockId) && !blocks[e.blockId].shadow;
        case 'move': {
            const block = blocks[e.blockId];
            if (!block) return false;
            const newParent = e.newParentId || null;
            if ((block.parent || null) !== newParent) return true;
            if (newParent) {
                const parent = blocks[newParent];
                if (!parent) return true;
                if (e.newInputName) {
                    const input = parent.inputs[e.newInputName];
                    return !input || input.block !== block.id;
                }
                return parent.next !== block.id;
            }
            const coordinate = e.newCoordinate;
            if (!coordinate) return false;
            return Math.round(block.x) !== Math.round(coordinate.x) ||
                Math.round(block.y) !== Math.round(coordinate.y);
        }
        case 'change': {
            const block = blocks[e.blockId];
            if (!block) return false;
            if (e.element === 'field' && block.fields[e.name]) {
                return block.fields[e.name].value !== e.newValue;
            }
            return true;
        }
        case 'var_create':
            return !target.lookupVariableById(e.varId) && !stage.lookupVariableById(e.varId);
        case 'comment_create':
            return !Object.prototype.hasOwnProperty.call(target.comments, e.commentId);
        case 'comment_change':
        case 'comment_move':
        case 'comment_delete':
            return Object.prototype.hasOwnProperty.call(target.comments, e.commentId);
        default:
            return true;
        }
    }

    captureCall (method, original, args) {
        const spec = CALL_METHODS[method];
        const editingTarget = method === 'postSpriteInfo' ?
            (this.vm._dragTarget || this.vm.editingTarget) :
            this.vm.editingTarget;

        if (method === 'renameSprite') {
            // The VM renames every sprite to its own name when installing
            // sprites; those do nothing and shouldn't be sent.
            const target = this.runtime.getTargetById(args[0]);
            if (!target || target.getName() === args[1]) return original(...args);
        }
        if (method === 'postSpriteInfo') {
            if (!editingTarget || (editingTarget.isOriginal === false)) return original(...args);
            const result = original(...args);
            const data = Object.assign({}, args[0]);
            if (this.vm._dragTarget) {
                // Dragging on the stage hides the sprite on your screen only.
                delete data.visible;
            }
            if (Object.keys(data).length > 0) this.queueSpriteInfo(editingTarget, data);
            return result;
        }
        if (method === 'setCompilerOptions') {
            // The warp timer is switched on/off per person (editor vs player).
            const options = Object.assign({}, args[0]);
            delete options.warpTimer;
            const result = original(...args);
            if (Object.keys(options).length > 0) {
                this.queueOp(() => ({kind: 'call', method, target: null, args: [encodeValue(options)]}));
            }
            return result;
        }
        if (method === 'addCostume' || method === 'addBackdrop' || method === 'addSound') {
            return this.captureAddAsset(method, original, args, editingTarget);
        }

        // Encode arguments BEFORE calling: the VM mutates some of them.
        const encodedArgs = args.map((arg, index) => {
            if (spec.targetArgs && spec.targetArgs.indexOf(index) !== -1) {
                return {__target: this.refById(arg)};
            }
            return encodeValue(arg);
        });
        const op = {
            kind: 'call',
            method,
            target: spec.editing ? this.ref(editingTarget) : null,
            args: encodedArgs
        };

        // Remember what's being deleted so "restore" can be shared too.
        let deleted = null;
        if (method === 'deleteCostume' && editingTarget) {
            deleted = {kind: 'costume', target: editingTarget, item: editingTarget.getCostumes()[args[0]]};
        } else if (method === 'deleteSound' && editingTarget) {
            deleted = {kind: 'sound', target: editingTarget, item: editingTarget.getSounds()[args[0]]};
        }

        const result = original(...args);

        if (method === 'deleteSprite' && this.runtime.getTargetById(args[0])) {
            // An addon asked "are you sure?" and the answer was no.
            return result;
        }

        if (result && typeof result.then === 'function') {
            // Send once the VM has finished, so failed edits aren't shared.
            this.queueOp(() => result.then(() => op, () => null));
        } else {
            this.queueOp(() => op);
        }

        if (deleted && typeof result === 'function') {
            return this.wrapRestore(result, deleted);
        }
        return result;
    }

    /**
     * New costumes/sounds are sent after the VM loaded them: by then the
     * object carries its asset bytes, even if they came from this browser's
     * backpack or a fresh upload that other people can't download.
     */
    captureAddAsset (method, original, args, editingTarget) {
        const targetIndex = method === 'addSound' ? 1 : 2;
        const objectIndex = method === 'addSound' ? 0 : 1;
        let targetRef = null;
        if (method === 'addBackdrop') {
            targetRef = null;
        } else if (args[targetIndex]) {
            targetRef = this.refById(args[targetIndex]);
        } else {
            targetRef = this.ref(editingTarget);
        }
        const item = args[objectIndex];
        const result = original(...args);
        this.queueOp(() => Promise.resolve(result).then(() => {
            const opArgs = args.slice();
            opArgs[objectIndex] = encodeAssetObject(item);
            if (method === 'addCostume') {
                // The asset we send was already upgraded by the "version 2"
                // (library costume) fixes; doing them twice changes the image.
                opArgs[3] = null;
            }
            if (method !== 'addBackdrop') opArgs[targetIndex] = {__target: targetRef};
            return {
                kind: 'call',
                method,
                target: null,
                args: opArgs.map((arg, index) => (
                    index === objectIndex || index === targetIndex ? arg : encodeValue(arg)
                ))
            };
        }, () => null));
        return result;
    }

    /** Deleted costumes/sounds can be restored from the Edit menu. */
    wrapRestore (restore, deleted) {
        const encodedItem = encodeAssetObject(deleted.item);
        const targetRef = this.ref(deleted.target);
        return (...args) => {
            const live = this.shouldCapture();
            const result = restore(...args);
            if (live && result && typeof result.then === 'function') {
                const op = deleted.kind === 'costume' ? {
                    kind: 'call',
                    method: 'addCostume',
                    target: null,
                    args: [
                        `${deleted.item.assetId}.${deleted.item.dataFormat}`,
                        encodedItem,
                        {__target: targetRef}
                    ]
                } : {
                    kind: 'call',
                    method: 'addSound',
                    target: null,
                    args: [encodedItem, {__target: targetRef}]
                };
                this.queueOp(() => result.then(() => op, () => null));
            }
            return result;
        };
    }

    /** Dragging a sprite fires dozens of updates a second; send at most ~16/s. */
    queueSpriteInfo (target, data) {
        const ref = this.ref(target);
        if (this.pendingSpriteInfo && this.pendingSpriteInfo.ref.name !== ref.name) {
            this.flushSpriteInfo();
        }
        const merged = this.pendingSpriteInfo ? Object.assign({}, this.pendingSpriteInfo.data, data) : data;
        this.pendingSpriteInfo = {ref, data: encodeValue(merged)};
        const wait = SPRITE_INFO_INTERVAL - (Date.now() - this.lastSpriteInfoSent);
        if (wait <= 0) {
            this.flushSpriteInfo();
        } else if (!this.spriteInfoTimer) {
            this.spriteInfoTimer = setTimeout(() => this.flushSpriteInfo(), wait);
        }
    }

    flushSpriteInfo () {
        clearTimeout(this.spriteInfoTimer);
        this.spriteInfoTimer = null;
        const pending = this.pendingSpriteInfo;
        if (!pending) return;
        this.pendingSpriteInfo = null;
        this.lastSpriteInfoSent = Date.now();
        this.queueOp(() => ({kind: 'spriteInfo', target: pending.ref, data: pending.data}));
    }

    /** New sprites are sent as a complete .sprite3 file. */
    captureNewSprites (run) {
        const before = new Set(this.runtime.targets.map(t => t.id));
        this.localLoads++;
        const result = run();
        const done = () => {
            this.localLoads--;
        };
        Promise.resolve(result).then(done, done);
        this.queueOp(async () => {
            try {
                await result;
            } catch (e) {
                return null;
            }
            // Sprites that appeared since the call, minus any another upload
            // (or someone else) already accounts for.
            const added = this.runtime.targets.filter(t => (
                !before.has(t.id) && t.isOriginal && !t.isStage && !this.knownSpriteIds.has(t.id)
            ));
            added.forEach(t => this.knownSpriteIds.add(t.id));
            // Two adds at the same moment can both pick the same free name.
            // Everyone else would rename the second copy on arrival, so do it
            // here first: sprites are matched between computers by name.
            for (const target of added) {
                const clash = this.runtime.targets.some(other => (
                    other !== target && other.isOriginal && !other.isStage && other.getName() === target.getName()
                ));
                if (clash) this.quiet(() => this.vm.renameSprite(target.id, target.getName()));
            }
            const sprites = [];
            for (const target of added) {
                const data = await exportFullSprite(this.vm, target.id);
                sprites.push(arrayBufferToBase64(data));
            }
            return sprites.length ? {kind: 'addSprites', sprites} : null;
        });
        return result;
    }

    /**
     * Blocks dropped onto another sprite (or from the backpack) get new random
     * IDs, so we send the blocks and variables that actually got created.
     */
    captureSharedBlocks (original, args) {
        const target = this.runtime.getTargetById(args[1]);
        const stage = this.runtime.getTargetForStage();
        if (!target) return original(...args);
        const blocksBefore = new Set(Object.keys(target.blocks._blocks));
        const varsBefore = new Set(Object.keys(target.variables).concat(Object.keys(stage.variables)));
        const targetRef = this.ref(target);
        const result = original(...args);
        this.queueOp(async () => {
            try {
                await result;
            } catch (e) {
                return null;
            }
            const blocks = {};
            for (const id of Object.keys(target.blocks._blocks)) {
                if (!blocksBefore.has(id)) blocks[id] = target.blocks._blocks[id];
            }
            const variables = [];
            const collectVars = (owner, isStage) => {
                for (const id of Object.keys(owner.variables)) {
                    if (!varsBefore.has(id)) {
                        const v = owner.variables[id];
                        variables.push({
                            stage: isStage,
                            id,
                            name: v.name,
                            type: v.type,
                            value: v.value,
                            isCloud: !!v.isCloud
                        });
                    }
                }
            };
            collectVars(target, target.isStage);
            if (!target.isStage) collectVars(stage, true);
            const extensions = Array.from(new Set(Object.keys(blocks)
                .map(id => blocks[id].opcode.split('_')[0])
                .filter(id => this.vm.extensionManager.isBuiltinExtension(id))));
            return {
                kind: 'insertBlocks',
                extensions,
                target: targetRef,
                blocks: JSON.parse(JSON.stringify(blocks)),
                variables: encodeValue(variables)
            };
        });
        return result;
    }

    /** Sprite list reordering: send names, because indices include clones. */
    captureReorderTarget (original, args) {
        const moved = this.runtime.targets[args[0]];
        const result = original(...args);
        if (result && moved && moved.isOriginal) {
            const originals = this.runtime.targets.filter(t => t.isOriginal);
            const position = originals.indexOf(moved);
            const after = position > 0 ? this.ref(originals[position - 1]) : null;
            this.queueOp(() => ({kind: 'reorderSprite', target: this.ref(moved), after}));
        }
        return result;
    }

    /** Loading a whole project (File > Load, File > New, restore point). */
    captureProjectLoad (original, args) {
        this.localLoads++;
        const result = original(...args);
        const done = () => {
            this.localLoads--;
        };
        Promise.resolve(result).then(done, done);
        this.queueOp(async () => {
            try {
                await result;
            } catch (e) {
                return null;
            }
            const data = await saveFullProject(this.vm);
            return {kind: 'project', sb3: arrayBufferToBase64(data)};
        });
        return result;
    }

    /**
     * "Store settings in project" writes a comment on the stage with a random
     * ID and text that depends on this person's own settings. Send the
     * resulting comment itself so everyone ends up with the same one.
     */
    captureProjectOptions (original) {
        const result = original();
        const comment = this.runtime.findProjectOptionsComment();
        if (comment) {
            const stage = this.runtime.getTargetForStage();
            const id = Object.keys(stage.comments).find(key => stage.comments[key] === comment);
            if (id) {
                this.queueOp(() => ({
                    kind: 'configComment',
                    id,
                    comment: {
                        text: comment.text,
                        x: comment.x,
                        y: comment.y,
                        width: comment.width,
                        height: comment.height,
                        minimized: comment.minimized
                    }
                }));
            }
        }
        return result;
    }

    /** Custom fonts (Fonts dialog). Project/sprite loads add fonts themselves. */
    captureFont (method, original, args) {
        if (this.localLoads > 0 || this.remoteAsync > 0) return original(...args);
        const encodedArgs = args.map(encodeValue);
        const result = original(...args);
        this.queueOp(() => ({kind: 'font', method, args: encodedArgs}));
        return result;
    }

    captureExtension (original, args) {
        const url = args[0];
        const alreadyLoaded = typeof url === 'string' && (
            this.vm.extensionManager.isExtensionLoaded(url) ||
            (typeof this.vm.extensionManager.isExtensionURLLoaded === 'function' &&
                this.vm.extensionManager.isExtensionURLLoaded(url))
        );
        const result = original(...args);
        if (!alreadyLoaded && typeof url === 'string' && this.remoteAsync === 0 && this.localLoads === 0) {
            this.queueOp(() => Promise.resolve(result).then(() => ({kind: 'extension', url}), () => null));
        }
        return result;
    }

    // ---- applying other people's ops ---------------------------------------

    decodeValue (value) {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(v => this.decodeValue(v));
        if (value.__bytes) return new Uint8Array(base64ToArrayBuffer(value.__bytes));
        if (value.__imageData) {
            const {width, height, data} = value.__imageData;
            return new ImageData(new Uint8ClampedArray(base64ToArrayBuffer(data)), width, height);
        }
        if (typeof value.__dom === 'string') {
            // Re-parsing as XML can fail on characters allowed in block text,
            // and the VM only needs the markup string.
            return {outerHTML: value.__dom};
        }
        if (value.__audioBuffer) return null;
        if (value.__asset) {
            const storage = this.runtime.storage;
            const {type, dataFormat, assetId, data} = value.__asset;
            return storage.createAsset(
                storage.AssetType[type],
                dataFormat,
                new Uint8Array(base64ToArrayBuffer(data)),
                assetId,
                false
            );
        }
        if (Object.prototype.hasOwnProperty.call(value, '__target')) {
            const target = this.resolve(value.__target);
            if (!target) throw new Error('target-missing');
            return target.id;
        }
        const out = {};
        for (const key of Object.keys(value)) out[key] = this.decodeValue(value[key]);
        return out;
    }

    /** Run fn without capturing anything it does (it's someone else's edit). */
    quiet (fn) {
        this.applyDepth++;
        try {
            return fn();
        } finally {
            this.applyDepth--;
        }
    }

    /**
     * Like quiet() for VM calls that return a promise: only the synchronous
     * part is hidden from capture, so edits you make meanwhile are still sent.
     * VM-internal follow-up calls are filtered elsewhere (no-op renames,
     * extensions that are already loading).
     */
    async quietAsync (fn) {
        this.remoteAsync++;
        try {
            return await this.quiet(fn);
        } finally {
            this.remoteAsync--;
        }
    }

    async applyRemote (op, fromName) {
        this.currentPeerName = fromName || 'Someone';
        try {
            switch (op.kind) {
            case 'blocks':
                this.quiet(() => this.applyBlocks(op));
                break;
            case 'call':
                await this.applyCall(op);
                break;
            case 'spriteInfo': {
                const target = this.resolve(op.target);
                if (target) {
                    this.quiet(() => {
                        target.postSpriteInfo(this.decodeValue(op.data));
                        this.runtime.emitProjectChanged();
                        if (target === this.vm.editingTarget) this.vm.emitTargetsUpdate(false);
                    });
                }
                break;
            }
            case 'addSprites':
                try {
                    await this.applyAddSprites(op);
                } catch (e) {
                    log.error('[collab] could not add a shared sprite', e);
                    this.onFatal(`Couldn't add the sprite ${this.currentPeerName} shared ` +
                        '(maybe an extension was blocked). You left the room; join again to retry.');
                }
                break;
            case 'insertBlocks':
                this.quiet(() => this.applyInsertBlocks(op));
                break;
            case 'project':
                try {
                    await this.loadProjectQuietly(base64ToArrayBuffer(op.sb3));
                } catch (e) {
                    log.error('[collab] could not load a shared project', e);
                    // Carrying on with a half-loaded project could overwrite the room.
                    this.onFatal(`Couldn't load the project ${this.currentPeerName} shared ` +
                        '(maybe an extension was blocked). You left the room; join again to retry.');
                }
                break;
            case 'extension':
                await this.applyExtension(op.url);
                break;
            case 'reorderSprite':
                this.quiet(() => this.applyReorderSprite(op));
                break;
            case 'configComment':
                this.quiet(() => this.applyConfigComment(op));
                break;
            case 'font': {
                const fontManager = this.runtime.fontManager;
                const args = op.args.map(arg => this.decodeValue(arg));
                if (fontManager && FONT_METHODS.indexOf(op.method) !== -1) {
                    this.quiet(() => Object.getPrototypeOf(fontManager)[op.method].apply(fontManager, args));
                }
                break;
            }
            case 'hqPen':
                if (this.vm.renderer) {
                    this.quiet(() => this.vm.renderer.setUseHighQualityRender(op.enabled));
                }
                break;
            default:
                log.warn('[collab] unknown op', op.kind);
            }
        } catch (e) {
            if (e && e.message === 'target-missing') {
                log.warn('[collab] skipped an edit for a sprite that no longer exists', op);
            } else {
                log.error('[collab] could not apply an edit', op, e);
            }
        }
    }

    /**
     * Run fn as if `target` were the sprite being edited, without telling the
     * GUI (so your own view doesn't jump to another sprite).
     */
    withEditingTarget (target, fn, runtimeOnly) {
        const vm = this.vm;
        const runtime = this.runtime;
        const previousVm = vm.editingTarget;
        const previousRuntime = runtime._editingTarget;
        const emitTargetsUpdate = vm.emitTargetsUpdate;
        const emitWorkspaceUpdate = vm.emitWorkspaceUpdate;
        let wantTargetsUpdate = false;
        let wantWorkspaceUpdate = false;
        if (!runtimeOnly) vm.editingTarget = target;
        runtime._editingTarget = target;
        vm.emitTargetsUpdate = () => {
            wantTargetsUpdate = true;
        };
        vm.emitWorkspaceUpdate = () => {
            wantWorkspaceUpdate = true;
        };
        try {
            return fn();
        } finally {
            vm.editingTarget = previousVm;
            runtime._editingTarget = previousRuntime;
            vm.emitTargetsUpdate = emitTargetsUpdate;
            vm.emitWorkspaceUpdate = emitWorkspaceUpdate;
            if (wantTargetsUpdate) vm.emitTargetsUpdate();
            if (wantWorkspaceUpdate && target === vm.editingTarget) this.refreshWorkspaceSoon();
        }
    }

    applyBlocks (op) {
        const target = this.resolve(op.target);
        if (!target) return;
        const event = this.decodeValue(op.event);
        const stage = this.runtime.getTargetForStage();
        const isVarEvent = event.type.indexOf('var_') === 0;
        const wasGlobalVar = isVarEvent && !!stage.variables[event.varId];

        // Variable and comment events act on "the sprite being edited", so
        // point the runtime at the right sprite while the VM applies it.
        this.withEditingTarget(target, () => target.blocks.blocklyListen(event), true);
        if (isVarEvent && typeof this.runtime.resetAllCaches === 'function') {
            // var_* only clears the editing sprite's compiled scripts
            this.runtime.resetAllCaches();
        }

        // Update the blocks you can see, if this edit is on screen.
        const editing = this.vm.editingTarget;
        const isGlobalVar = isVarEvent && (wasGlobalVar || !!stage.variables[event.varId]);
        if (editing && (editing === target || isGlobalVar)) {
            const redraw = (
                // Blockly's JSON for comment events drops text/position.
                event.type.indexOf('comment_') === 0 ||
                // Replaying these in Blockly can pop up "are you sure?" dialogs or throw.
                event.type === 'var_rename' || event.type === 'var_delete' ||
                // Custom block edits make Blockly invent new IDs for argument blocks.
                (event.type === 'change' && event.element === 'mutation')
            );
            if (redraw) {
                this.refreshWorkspaceSoon();
            } else {
                this.applyToWorkspace(op.blockly);
            }
        }
    }

    applyToWorkspace (json) {
        if (!json || !LazyScratchBlocks.isLoaded()) return;
        const workspace = AddonHooks.blocklyWorkspace;
        if (!workspace) return;
        const ScratchBlocks = LazyScratchBlocks.get();
        if (workspace.isDragging && workspace.isDragging()) {
            // Don't yank blocks out from under someone mid-drag; redraw after.
            this.refreshWorkspaceSoon();
            return;
        }
        if (json.type === 'create' && workspace.getBlockById(json.blockId)) {
            // Replaying a create for a block that's already there would make a copy.
            return;
        }
        const recordUndo = ScratchBlocks.Events.recordUndo;
        ScratchBlocks.Events.disable();
        // Not part of your undo history; also stops Blockly inventing IDs.
        ScratchBlocks.Events.recordUndo = false;
        try {
            const event = ScratchBlocks.Events.fromJson(json, workspace);
            event.run(true);
        } catch (e) {
            log.warn('[collab] redrawing workspace after an edit could not be shown directly', e);
            this.refreshWorkspaceSoon();
        } finally {
            ScratchBlocks.Events.recordUndo = recordUndo;
            ScratchBlocks.Events.enable();
        }
    }

    /** Fallback: redraw the whole workspace from the VM (waits for drags to end). */
    refreshWorkspaceSoon () {
        if (this.workspaceRefreshTimer) return;
        const attempt = () => {
            const workspace = AddonHooks.blocklyWorkspace;
            if (workspace && workspace.isDragging && workspace.isDragging()) {
                this.workspaceRefreshTimer = setTimeout(attempt, 200);
                return;
            }
            this.workspaceRefreshTimer = null;
            if (this.vm.editingTarget) this.vm.emitWorkspaceUpdate();
        };
        this.workspaceRefreshTimer = setTimeout(attempt, 50);
    }

    async applyCall (op) {
        const vm = this.vm;
        const contextTarget = op.target ? this.resolve(op.target) : null;
        if (op.target && !contextTarget) throw new Error('target-missing');
        const args = op.args.map(arg => this.decodeValue(arg));

        switch (op.method) {
        case 'duplicateCostume': {
            // The VM's version uses the editing target after an await, so do
            // the same thing explicitly: copy, append, then move into place.
            const index = args[0];
            const original = contextTarget.getCostumes()[index];
            if (!original) return;
            const clone = Object.assign({}, original);
            await this.quietAsync(() => vm.addCostume(`${clone.assetId}.${clone.dataFormat}`, clone, contextTarget.id));
            this.quiet(() => {
                contextTarget.reorderCostume(contextTarget.getCostumes().length - 1, index + 1);
                vm.emitTargetsUpdate();
            });
            return;
        }
        case 'duplicateSound': {
            const index = args[0];
            const original = contextTarget.getSounds()[index];
            if (!original) return;
            const clone = Object.assign({}, original);
            await this.quietAsync(() => vm.addSound(clone, contextTarget.id));
            this.quiet(() => {
                contextTarget.reorderSound(contextTarget.getSounds().length - 1, index + 1);
                vm.emitTargetsUpdate();
            });
            return;
        }
        case 'updateSoundBuffer': {
            const [index, , encoding] = args;
            const audioEngine = this.runtime.audioEngine;
            if (!encoding || !audioEngine) return;
            const audioBuffer = await audioEngine.audioContext.decodeAudioData(encoding.slice().buffer);
            const sound = contextTarget.getSounds()[index];
            if (sound && contextTarget === vm.editingTarget) {
                pushToast(`${this.currentPeerName} edited sound "${sound.name}". ` +
                    'Click another sound and back to hear it.', null);
            }
            this.quiet(() => this.withEditingTarget(contextTarget, () => (
                vm.updateSoundBuffer(index, audioBuffer, encoding)
            )));
            return;
        }
        }

        if (contextTarget && contextTarget === vm.editingTarget &&
            ['updateSvg', 'updateBitmap'].indexOf(op.method) !== -1) {
            const costume = contextTarget.getCostumes()[args[0]];
            if (costume) {
                pushToast(`${this.currentPeerName} edited costume "${costume.name}". ` +
                    'Click another costume and back to see it.', null);
            }
        }

        // Use the VM's own method, not an addon's wrapper that might ask
        // questions (like "really delete this sprite?") about someone else's edit.
        const fn = Object.getPrototypeOf(vm)[op.method];
        if (typeof fn !== 'function') return;
        const run = () => fn.apply(vm, args);
        await this.quietAsync(() => (contextTarget ? this.withEditingTarget(contextTarget, run) : run()));
        if (['addCostume', 'addSound', 'addBackdrop', 'shareCostumeToTarget', 'shareSoundToTarget',
            'reorderCostume', 'reorderSound'].indexOf(op.method) !== -1) {
            vm.emitTargetsUpdate();
        }
    }

    async applyExtension (url) {
        const manager = this.vm.extensionManager;
        if (manager.isExtensionLoaded(url) || manager.isExtensionURLLoaded(url)) return;
        if (!manager.isBuiltinExtension(url)) {
            // Someone else added a custom extension: ask before running its code.
            const allowed = await this.vm.securityManager.canLoadExtensionFromProject(url);
            if (!allowed) return;
        }
        await this.quietAsync(() => manager.loadExtensionURL(url));
    }

    applyReorderSprite (op) {
        const moved = this.resolve(op.target);
        if (!moved) return;
        const targets = this.runtime.targets;
        const from = targets.indexOf(moved);
        const without = targets.filter(t => t !== moved);
        let to = 0;
        if (op.after) {
            const after = this.resolve(op.after);
            if (!after) return;
            to = without.indexOf(after) + 1;
        } else {
            // Right after the stage
            to = without.findIndex(t => t.isStage) + 1;
        }
        this.vm.reorderTarget(from, to);
    }

    applyConfigComment (op) {
        const stage = this.runtime.getTargetForStage();
        const existing = this.runtime.findProjectOptionsComment();
        if (existing) {
            const oldId = Object.keys(stage.comments).find(key => stage.comments[key] === existing);
            if (oldId && oldId !== op.id) delete stage.comments[oldId];
        }
        const c = op.comment;
        if (stage.comments[op.id]) {
            Object.assign(stage.comments[op.id], c);
        } else {
            stage.createComment(op.id, null, c.text, c.x, c.y, c.width, c.height, c.minimized);
        }
        this.runtime.emitProjectChanged();
        if (this.vm.editingTarget === stage) this.refreshWorkspaceSoon();
    }

    async applyAddSprites (op) {
        for (const base64 of op.sprites) {
            const previous = this.vm.editingTarget;
            const before = new Set(this.runtime.targets.map(t => t.id));
            await this.quietAsync(() => this.vm.addSprite(base64ToArrayBuffer(base64)));
            this.runtime.targets.forEach(t => {
                if (!before.has(t.id)) this.knownSpriteIds.add(t.id);
            });
            // Adding a sprite selects it; put your view back where it was.
            const current = this.vm.editingTarget;
            if (previous && current && !before.has(current.id) && this.runtime.getTargetById(previous.id)) {
                this.vm.setEditingTarget(previous.id);
            }
        }
    }

    applyInsertBlocks (op) {
        const target = this.resolve(op.target);
        if (!target) return;
        for (const id of op.extensions || []) {
            const manager = this.vm.extensionManager;
            if (manager.isBuiltinExtension(id) && !manager.isExtensionLoaded(id)) {
                manager.loadExtensionIdSync(id);
            }
        }
        const stage = this.runtime.getTargetForStage();
        for (const v of this.decodeValue(op.variables)) {
            const owner = v.stage ? stage : target;
            if (!owner.lookupVariableById(v.id)) {
                owner.createVariable(v.id, v.name, v.type, v.isCloud);
                owner.variables[v.id].value = v.value;
            }
        }
        for (const id of Object.keys(op.blocks)) {
            if (!target.blocks.getBlock(id)) {
                target.blocks.createBlock(op.blocks[id]);
            }
        }
        target.blocks.resetCache();
        this.runtime.emitProjectChanged();
        if (target === this.vm.editingTarget) this.refreshWorkspaceSoon();
    }

    // ---- whole project ------------------------------------------------------

    async loadProjectQuietly (buffer) {
        this.vm.stopAll();
        const settings = await readSettingsFromProject(buffer);
        await this.quietAsync(() => this.vm.loadProject(buffer));
        this.quiet(() => applySettings(this.vm, settings));
    }

    loadSnapshot (buffer) {
        return this.loadProjectQuietly(buffer);
    }

    /**
     * Text describing everything that collaboration keeps in sync (and
     * nothing that legitimately differs per person, like where running
     * sprites happen to be or variable values). Synchronous.
     */
    fingerprintText () {
        const describeBlock = block => [
            block.id, block.opcode, block.parent, block.next, !!block.topLevel, !!block.shadow,
            Object.keys(block.inputs).sort()
                .map(name => [name, block.inputs[name].block, block.inputs[name].shadow]),
            Object.keys(block.fields).sort()
                .map(name => [name, String(block.fields[name].value), block.fields[name].id || null]),
            block.mutation ? stableStringify(block.mutation) : null
        ];
        const targets = this.runtime.targets.filter(t => t.isOriginal).map(t => [
            t.isStage ? '__stage__' : t.getName(),
            // Bitmap costumes are re-encoded by each browser, so only compare their names.
            t.getCostumes().map(c => [c.name, c.dataFormat, c.dataFormat === 'svg' ? c.assetId : null]),
            t.getSounds().map(s => [s.name, s.assetId]),
            Object.keys(t.variables).sort()
                .filter(id => t.variables[id].type !== 'broadcast_msg')
                .map(id => [id, t.variables[id].name, t.variables[id].type]),
            Object.keys(t.comments).sort()
                .map(id => [id, t.comments[id].blockId || null, t.comments[id].text]),
            Object.keys(t.blocks._blocks).sort()
                .map(id => describeBlock(t.blocks._blocks[id]))
        ]);
        return JSON.stringify(targets);
    }

    fingerprint () {
        return sha256Hex(this.fingerprintText());
    }

    /**
     * @param {function(): number} getSeq read at the exact moment the project
     *     is serialized, so the snapshot and its sequence number match
     * @returns {Promise<{seq: number, data: ArrayBuffer, hash: string}>} snapshot
     */
    async saveSnapshot (getSeq) {
        this.flushSpriteInfo();
        // The project is read synchronously here; only zipping/hashing is async.
        const seq = getSeq();
        const text = this.fingerprintText();
        const dataPromise = saveFullProject(this.vm);
        const [data, hash] = await Promise.all([dataPromise, sha256Hex(text)]);
        return {seq, data, hash};
    }
}

export default VMSync;
