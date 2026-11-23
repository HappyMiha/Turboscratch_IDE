/* eslint-disable valid-jsdoc */
/**
 * Ada's chat: the conversation loop and the state the panel shows.
 *
 * Each step sends the conversation to the TurboScratch server, which asks the
 * Claude API for Ada's next turn and streams it back. When Ada asks to use
 * tools, they run here in the editor and the results go back in the next
 * step, until Ada has finished answering.
 */
import {useEffect, useState} from 'react';
import {api, setToken} from '../tsc-community/api';
import {getAccountState, setAccountState, subscribeAccount} from '../tsc-community/store';
import {describeToolUse, runTool} from './tools';

const MAX_STEPS = 12;
const MAX_INPUT = 4000;

let state = {
    open: false,
    tab: 'chat',
    /** null while unknown, then {available, name} or {error} */
    status: null,
    /** What the chat shows: {id, kind: 'user'|'ada'|'tool'|'note'|'error', text} */
    items: [],
    busy: false,
    /** What Ada is doing right now, e.g. "Thinking…" */
    activity: ''
};
const listeners = new Set();

const getAdaState = () => state;

const setAdaState = patch => {
    state = Object.assign({}, state, patch);
    for (const listener of listeners) listener(state);
};

const useAda = () => {
    const [current, setCurrent] = useState(state);
    useEffect(() => {
        listeners.add(setCurrent);
        setCurrent(state);
        return () => listeners.delete(setCurrent);
    }, []);
    return current;
};

let nextItemId = 1;
const addItem = (kind, text) => {
    const item = {id: nextItemId++, kind, text};
    setAdaState({items: state.items.concat([item])});
    return item.id;
};
const updateItem = (id, text) => {
    setAdaState({items: state.items.map(item => (item.id === id ? Object.assign({}, item, {text}) : item))});
};
const removeItem = id => {
    setAdaState({items: state.items.filter(item => item.id !== id)});
};

// The unsent text in the chat box, kept when the panel closes or tabs change.
let draft = '';
const getDraft = () => draft;
const setDraft = text => {
    draft = text;
};

// ---- status ---------------------------------------------------------------------

let statusPromise = null;
const checkStatus = () => {
    if (statusPromise || (state.status && !state.status.error)) return statusPromise;
    statusPromise = api.aiStatus()
        .then(status => setAdaState({status}))
        .catch(e => setAdaState({status: {error: e.message}}))
        .then(() => {
            statusPromise = null;
        });
    return statusPromise;
};

const adaName = () => (state.status && state.status.name) || 'Ada';

// ---- the conversation ----------------------------------------------------------------

/**
 * The conversation as the Claude API sees it. Ada's turns are kept exactly as
 * they came back. "New chat" and changing accounts replace the whole object,
 * so an answer that is still finishing can't write into the new chat.
 */
let conversation = {messages: []};
let controller = null;

/** Chat helpers that do nothing once their conversation was replaced. */
const chatView = convo => {
    const live = () => convo === conversation;
    return {
        live,
        add: (kind, text) => (live() ? addItem(kind, text) : null),
        update: (id, text) => {
            if (live() && id !== null) updateItem(id, text);
        },
        remove: id => {
            if (live() && id !== null) removeItem(id);
        },
        set: patch => {
            if (live()) setAdaState(patch);
        }
    };
};

const addUserText = (convo, text) => {
    const messages = convo.messages;
    const last = messages[messages.length - 1];
    if (last && last.role === 'user') {
        // The previous question never got a full answer (it was stopped or
        // failed); add this one to it so the conversation stays valid. This
        // makes a new object, so a saved copy of the list stays as it was.
        const content = typeof last.content === 'string' ? [{type: 'text', text: last.content}] : last.content;
        messages[messages.length - 1] = {role: 'user', content: content.concat([{type: 'text', text}])};
    } else {
        messages.push({role: 'user', content: text});
    }
};

/** One step: stream Ada's next turn into the chat, return the finished turn. */
const streamStep = async (convo, view, signal) => {
    let textItem = null;
    let text = '';
    let finished = null;
    view.set({activity: 'Thinking…'});
    await api.aiChat(convo.messages, line => {
        if (line.type === 'text') {
            text += line.text;
            if (textItem === null) {
                textItem = view.add('ada', text);
                view.set({activity: 'Writing…'});
            } else {
                view.update(textItem, text);
            }
        } else if (line.type === 'tool') {
            view.set({activity: 'Getting ready to look at your project…'});
        } else if (line.type === 'reset') {
            // The server is retrying this turn; forget the partial answer.
            view.remove(textItem);
            textItem = null;
            text = '';
        } else if (line.type === 'done') {
            finished = line;
        } else if (line.type === 'error') {
            const error = new Error(line.message);
            error.fromServer = true;
            throw error;
        }
    }, signal);
    if (!finished) throw new Error(`${adaName()} stopped answering. Try again.`);
    return Object.assign({textItem}, finished);
};

/**
 * After a mid-answer fallback (another model took over), the first model's
 * thinking and tool calls before the last fallback block are dropped: they
 * must not run or be sent back. The server does this too; this is a backup.
 */
const cleanFallbackTurn = content => {
    let boundary = -1;
    content.forEach((block, i) => {
        if (block.type === 'fallback') boundary = i;
    });
    if (boundary < 0) return content;
    return content.filter((block, i) => i >= boundary || block.type === 'text');
};

const stopped = () => {
    const error = new Error('Stopped');
    error.name = 'AbortError';
    return error;
};

/**
 * Runs one question to its end. `before` is the conversation as it was before
 * the question, so a refused question can be taken back completely.
 */
const runConversation = async (vm, convo, view, before, signal) => {
    for (let steps = 0; steps < MAX_STEPS; steps++) {
        const {message, stopReason, textItem} = await streamStep(convo, view, signal);
        const content = cleanFallbackTurn(Array.isArray(message.content) ? message.content : []);
        const toolUses = content.filter(block => block.type === 'tool_use');

        if (stopReason === 'refusal') {
            // Take back the whole question (and anything Ada looked at for
            // it), so it isn't sent again with the next one.
            // eslint-disable-next-line require-atomic-updates
            convo.messages = before;
            view.remove(textItem);
            view.add('note', `${adaName()} can't help with that. Try asking about your project.`);
            return;
        }
        if (stopReason === 'max_tokens' && toolUses.length) {
            // A tool input that was cut off can look valid; never run it.
            view.add('error', `${adaName()}'s answer got too long. Try asking a smaller question.`);
            return;
        }
        if (stopReason !== 'tool_use' && toolUses.length) {
            // Tool calls must get answers in the next message, so a finished
            // turn that still has tool calls isn't kept.
            view.add('error', `${adaName()} got confused. Try asking again.`);
            return;
        }
        if (content.length) convo.messages.push({role: 'assistant', content});
        if (stopReason === 'max_tokens') {
            view.add('note', `${adaName()}'s answer was cut off because it got too long.`);
            return;
        }
        if (!toolUses.length) return;

        const results = [];
        for (const use of toolUses) {
            if (signal.aborted) {
                results.push({
                    type: 'tool_result', tool_use_id: use.id, content: 'Stopped by the person.', is_error: true
                });
                continue;
            }
            const label = describeToolUse(use.name, use.input);
            view.set({activity: `${label}…`});
            const itemId = view.add('tool', use.name === 'run_project' ? `${label} (running…)` : label);
            let result;
            try {
                result = await runTool(vm, use.name, use.input, signal);
            } catch (e) {
                // Stopped while a tool was running.
                result = {content: 'Stopped by the person.', isError: true};
            }
            view.update(itemId, label);
            const block = {type: 'tool_result', tool_use_id: use.id, content: result.content};
            if (result.isError) block.is_error = true;
            results.push(block);
        }
        // All results go back together, in one message.
        convo.messages.push({role: 'user', content: results});
        if (signal.aborted) throw stopped();
    }
    view.add('note', `${adaName()} looked at a lot of things. Say "continue" if she isn't finished.`);
};

const sendMessage = async (vm, rawText) => {
    const text = rawText.trim().slice(0, MAX_INPUT);
    if (!text || state.busy || !vm) return;
    const convo = conversation;
    const view = chatView(convo);
    const before = convo.messages.slice();
    addUserText(convo, text);
    addItem('user', text);
    const ownController = new AbortController();
    controller = ownController;
    setAdaState({busy: true, activity: 'Thinking…'});
    try {
        await runConversation(vm, convo, view, before, ownController.signal);
    } catch (e) {
        if (e && e.name === 'AbortError') {
            view.add('note', 'Stopped.');
        } else if (e && e.status === 401) {
            setToken(null);
            setAccountState({user: null});
            view.add('error', 'You were signed out. Sign in again to keep chatting.');
        } else if (e && (e.status === 400 || e.status === 413)) {
            // The server couldn't take this chat (usually: it got too long).
            convo.messages = before;
            view.add('error', `${e.message} Click "New" to start a new chat.`);
        } else {
            view.add('error', (e && e.message) || 'Something went wrong.');
        }
    } finally {
        if (controller === ownController) controller = null;
        view.set({busy: false, activity: ''});
    }
};

const stopAnswering = () => {
    if (controller) controller.abort();
};

/** Forgets the chat (and stops an answer that is still being written). */
const resetChat = () => {
    if (controller) controller.abort();
    controller = null;
    conversation = {messages: []};
    setAdaState({items: [], busy: false, activity: ''});
};

const newChat = () => {
    if (state.busy) return;
    resetChat();
};

// A chat belongs to the account that had it: signing out or switching
// accounts starts over, so the next person can't see or continue it.
let chatOwner = getAccountState().user ? getAccountState().user.nickname : null;
subscribeAccount(account => {
    const nickname = account.user ? account.user.nickname : null;
    if (nickname === chatOwner) return;
    chatOwner = nickname;
    resetChat();
});

export {
    checkStatus,
    getAdaState,
    getDraft,
    newChat,
    sendMessage,
    setAdaState,
    setDraft,
    stopAnswering,
    useAda
};
