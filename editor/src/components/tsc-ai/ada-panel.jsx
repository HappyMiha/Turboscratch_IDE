/* eslint-disable react/jsx-no-bind */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {
    checkStatus, getDraft, newChat, sendMessage, setAdaState, setDraft, stopAnswering, useAda
} from '../../lib/tsc-ai/agent';
import {clearConsole, getEntries, subscribe} from '../../lib/tsc-ai/console';
import {useAccount, setAccountState} from '../../lib/tsc-community/store';
import {getApiBase} from '../../lib/tsc-community/api';
import SimpleMarkdown from './simple-markdown.jsx';
import adaAvatar from './ada-avatar.svg';
import styles from './ada-panel.css';

const SUGGESTIONS = [
    'Why doesn\'t my project work?',
    'Explain what my scripts do',
    'What happened in the debugger console?',
    'Give me an idea to make my game better'
];

const ASK_ABOUT_CONSOLE = 'Look at the debugger console and tell me what is happening in my project.';

// Keeps a list scrolled to the bottom, unless the person scrolled up to read.
const useStickToBottom = deps => {
    const ref = useRef(null);
    const atBottom = useRef(true);
    const onScroll = () => {
        const el = ref.current;
        if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, deps);
    // Call before adding something the person must see (like their own message).
    const stick = () => {
        atBottom.current = true;
    };
    return [ref, onScroll, stick];
};

const useConsoleEntries = () => {
    const [entries, setEntries] = useState(getEntries());
    useEffect(() => {
        setEntries(getEntries());
        return subscribe(setEntries);
    }, []);
    return entries;
};

// ---- chat ---------------------------------------------------------------------------

const Message = ({item, name}) => {
    if (item.kind === 'user') {
        return <div className={classNames(styles.bubble, styles.userBubble)}>{item.text}</div>;
    }
    if (item.kind === 'ada') {
        return (
            <div className={styles.adaRow}>
                <img
                    className={styles.avatar}
                    src={adaAvatar}
                    alt={name}
                    draggable={false}
                />
                <div className={classNames(styles.bubble, styles.adaBubble)}>
                    <SimpleMarkdown text={item.text} />
                </div>
            </div>
        );
    }
    if (item.kind === 'tool') {
        return <div className={styles.toolChip}>{item.text}</div>;
    }
    return (
        <div className={classNames(styles.note, {[styles.errorNote]: item.kind === 'error'})}>
            {item.text}
        </div>
    );
};

// Only messages that changed are drawn again while Ada is writing.
const MemoMessage = React.memo(Message);

Message.propTypes = {
    item: PropTypes.shape({
        kind: PropTypes.string,
        text: PropTypes.string
    }).isRequired,
    name: PropTypes.string
};

const ChatInput = ({busy, onSend, onStop, name}) => {
    // The draft is kept outside the panel, so it survives closing it.
    const [text, setTextState] = useState(getDraft());
    const setText = value => {
        setDraft(value);
        setTextState(value);
    };
    const send = () => {
        if (!text.trim() || busy) return;
        onSend(text);
        setText('');
    };
    return (
        <div className={styles.inputRow}>
            <textarea
                className={styles.textInput}
                value={text}
                rows={2}
                maxLength={4000}
                placeholder={`Ask ${name} about your project…`}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                    // Enter that picks a word in a Japanese/Chinese/Korean
                    // keyboard isn't "send".
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                    }
                }}
            />
            {busy ? (
                <button
                    className={classNames(styles.sendButton, styles.stopButton)}
                    onClick={onStop}
                >
                    {'Stop'}
                </button>
            ) : (
                <button
                    className={styles.sendButton}
                    disabled={!text.trim()}
                    onClick={send}
                >
                    {'Send'}
                </button>
            )}
        </div>
    );
};

ChatInput.propTypes = {
    busy: PropTypes.bool,
    name: PropTypes.string,
    onSend: PropTypes.func.isRequired,
    onStop: PropTypes.func.isRequired
};

const Notice = ({children, action, onAction}) => (
    <div className={styles.notice}>
        <img
            className={styles.bigAvatar}
            src={adaAvatar}
            alt=""
            draggable={false}
        />
        <div>{children}</div>
        {action && (
            <button
                className={styles.primaryButton}
                onClick={onAction}
            >
                {action}
            </button>
        )}
    </div>
);

Notice.propTypes = {
    action: PropTypes.string,
    children: PropTypes.node,
    onAction: PropTypes.func
};

const ChatView = ({ada, vm, onOpenSignIn}) => {
    const account = useAccount();
    const name = (ada.status && ada.status.name) || 'Ada';
    const [listRef, onScroll, stick] = useStickToBottom([ada.items, ada.activity]);

    if (!getApiBase()) {
        return (
            <Notice>
                {`${name} lives on a TurboScratch server, and this editor isn't connected to one yet. ` +
                    'On your own computer, start TurboScratch with start-turboscratch.command. ' +
                    'The Console tab works without a server.'}
            </Notice>
        );
    }
    if (!account.user) {
        return (
            <Notice
                action="Sign in"
                onAction={onOpenSignIn}
            >
                {`Sign in to chat with ${name}. She can read your scripts, watch the debugger console ` +
                    'and help you fix your project.'}
            </Notice>
        );
    }
    if (!ada.status) return <Notice>{'Checking…'}</Notice>;
    if (ada.status.error) {
        return (
            <Notice
                action="Try again"
                onAction={checkStatus}
            >
                {ada.status.error}
            </Notice>
        );
    }
    if (!ada.status.available) {
        return (
            <Notice>
                {`${name} isn't set up on this server yet. The person who runs the server needs to add an ` +
                    'AI key (see the TurboScratch README). The Console tab still works.'}
            </Notice>
        );
    }

    const send = text => {
        stick();
        sendMessage(vm, text);
    };
    return (
        <React.Fragment>
            <div
                className={styles.chatList}
                ref={listRef}
                onScroll={onScroll}
            >
                {ada.items.length === 0 && (
                    <div className={styles.welcome}>
                        <img
                            className={styles.bigAvatar}
                            src={adaAvatar}
                            alt=""
                            draggable={false}
                        />
                        <div className={styles.welcomeTitle}>{`Hi ${account.user.nickname}! I'm ${name}.`}</div>
                        <div className={styles.welcomeText}>
                            {'I can read your scripts, run your project and watch the debugger console to ' +
                                'help you find bugs. What are you working on?'}
                        </div>
                        <div className={styles.suggestions}>
                            {SUGGESTIONS.map(suggestion => (
                                <button
                                    key={suggestion}
                                    className={styles.suggestion}
                                    onClick={() => send(suggestion)}
                                >
                                    {suggestion}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {ada.items.map(item => (
                    <MemoMessage
                        key={item.id}
                        item={item}
                        name={name}
                    />
                ))}
                {ada.busy && (
                    <div className={styles.activity}>
                        <span className={styles.dots}><span /><span /><span /></span>
                        {ada.activity}
                    </div>
                )}
            </div>
            <ChatInput
                busy={ada.busy}
                name={name}
                onSend={send}
                onStop={stopAnswering}
            />
            <div className={styles.footnote}>
                {`${name} is an AI and can make mistakes. Don't share personal information.`}
            </div>
        </React.Fragment>
    );
};

ChatView.propTypes = {
    ada: PropTypes.object.isRequired,
    onOpenSignIn: PropTypes.func.isRequired,
    vm: PropTypes.object
};

// ---- console ------------------------------------------------------------------------

const KIND_LABELS = {
    project: 'project',
    flag: 'flag',
    stop: 'stop',
    say: 'say',
    think: 'think',
    broadcast: 'broadcast',
    variable: 'variable',
    list: 'list',
    clone: 'clone',
    log: 'log',
    warn: 'warn',
    error: 'error',
    breakpoint: 'pause'
};

const formatTime = time => {
    const date = new Date(time);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const ConsoleView = ({canAsk, onAsk}) => {
    const entries = useConsoleEntries();
    const [listRef, onScroll] = useStickToBottom([entries]);
    return (
        <React.Fragment>
            <div className={styles.consoleToolbar}>
                <span className={styles.consoleCount}>
                    {entries.length === 1 ? '1 entry' : `${entries.length} entries`}
                </span>
                {canAsk && (
                    <button
                        className={styles.smallButton}
                        onClick={onAsk}
                        disabled={entries.length === 0}
                    >
                        {'Ask about this'}
                    </button>
                )}
                <button
                    className={styles.smallButton}
                    onClick={clearConsole}
                    disabled={entries.length === 0}
                >
                    {'Clear'}
                </button>
            </div>
            <div
                className={styles.consoleList}
                ref={listRef}
                onScroll={onScroll}
            >
                {entries.length === 0 ? (
                    <div className={styles.consoleEmpty}>
                        {'Nothing here yet. Click the green flag: what sprites say and think, broadcasts, ' +
                            'variable changes, clones and problems show up here. Turn on the Debugger addon to ' +
                            'use its log, warn, error and breakpoint blocks too.'}
                    </div>
                ) : entries.map(entry => (
                    <div
                        key={entry.id}
                        className={classNames(styles.consoleRow, styles[`kind-${entry.kind}`])}
                    >
                        <span className={styles.consoleTime}>{formatTime(entry.time)}</span>
                        <span className={styles.consoleKind}>{KIND_LABELS[entry.kind] || entry.kind}</span>
                        <span className={styles.consoleText}>
                            {entry.sprite && <span className={styles.consoleSprite}>{entry.sprite}</span>}
                            {entry.text}
                            {entry.count > 1 && <span className={styles.consoleRepeat}>{`×${entry.count}`}</span>}
                        </span>
                    </div>
                ))}
            </div>
        </React.Fragment>
    );
};

ConsoleView.propTypes = {
    canAsk: PropTypes.bool,
    onAsk: PropTypes.func.isRequired
};

// ---- the panel ---------------------------------------------------------------------

const AdaPanel = ({vm, onOpenCommunity}) => {
    const ada = useAda();
    const account = useAccount();
    const [position, setPosition] = useState(null);
    const panelRef = useRef(null);
    const name = (ada.status && ada.status.name) || 'Ada';

    useEffect(() => {
        if (account.user && getApiBase()) checkStatus();
    }, [account.user]);

    // Drag the panel by its header.
    const startDrag = e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        const panel = panelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        const move = event => {
            const x = Math.min(Math.max(event.clientX - offsetX, 0), window.innerWidth - rect.width);
            const y = Math.min(Math.max(event.clientY - offsetY, 0), window.innerHeight - 48);
            setPosition({x, y});
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
        e.preventDefault();
    };

    const openSignIn = () => {
        setAccountState({view: 'signin'});
        onOpenCommunity();
    };
    const canAsk = !!(account.user && ada.status && ada.status.available && !ada.busy);
    const askAboutConsole = () => {
        setAdaState({tab: 'chat'});
        sendMessage(vm, ASK_ABOUT_CONSOLE);
    };

    return (
        <div
            className={styles.panel}
            ref={panelRef}
            style={position ? {left: position.x, top: position.y, right: 'auto', bottom: 'auto'} : null}
            role="dialog"
            aria-label={`${name}, your coding helper`}
        >
            <div
                className={styles.header}
                onMouseDown={startDrag}
            >
                <img
                    className={styles.headerAvatar}
                    src={adaAvatar}
                    alt=""
                    draggable={false}
                />
                <div className={styles.headerTitle}>
                    <div className={styles.name}>{name}</div>
                    <div className={styles.subtitle}>{'Coding helper'}</div>
                </div>
                <div className={styles.tabs}>
                    {['chat', 'console'].map(tab => (
                        <button
                            key={tab}
                            className={classNames(styles.tab, {[styles.activeTab]: ada.tab === tab})}
                            onClick={() => setAdaState({tab})}
                        >
                            {tab === 'chat' ? 'Chat' : 'Console'}
                        </button>
                    ))}
                </div>
                {ada.tab === 'chat' && ada.items.length > 0 && (
                    <button
                        className={styles.headerButton}
                        title="Start a new chat"
                        disabled={ada.busy}
                        onClick={newChat}
                    >
                        {'New'}
                    </button>
                )}
                <button
                    className={styles.closeButton}
                    title="Close"
                    aria-label="Close"
                    onClick={() => setAdaState({open: false})}
                >
                    {'×'}
                </button>
            </div>
            <div className={styles.body}>
                {ada.tab === 'chat' ? (
                    <ChatView
                        ada={ada}
                        vm={vm}
                        onOpenSignIn={openSignIn}
                    />
                ) : (
                    <ConsoleView
                        canAsk={canAsk}
                        onAsk={askAboutConsole}
                    />
                )}
            </div>
        </div>
    );
};

AdaPanel.propTypes = {
    onOpenCommunity: PropTypes.func.isRequired,
    vm: PropTypes.object
};

export default AdaPanel;
