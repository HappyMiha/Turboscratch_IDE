/* eslint-disable react/jsx-no-bind */
import PropTypes from 'prop-types';
import React, {useEffect, useRef, useState} from 'react';
import Modal from '../../containers/modal.jsx';
import {useCollabState} from '../../lib/tsc-collab/store';
import {
    defaultServerUrl,
    loadSavedName,
    loadSavedServer,
    makeRoomCode,
    makeInviteLink,
    isLocalHostname
} from '../../lib/tsc-collab/settings';
import styles from './collab-modal.css';

const Avatar = ({name, color, small}) => (
    <span
        className={small ? styles.avatarSmall : styles.avatar}
        style={{background: color}}
        title={name}
    >
        {(name || '?').trim()
            .charAt(0)
            .toUpperCase()}
    </span>
);
Avatar.propTypes = {
    color: PropTypes.string,
    name: PropTypes.string,
    small: PropTypes.bool
};

const JoinForm = ({initialRoom, initialServer, error, projectReady, onJoin}) => {
    const [name, setName] = useState(loadSavedName());
    const [room, setRoom] = useState(initialRoom || makeRoomCode());
    const [server, setServer] = useState(initialServer || loadSavedServer() || defaultServerUrl());
    const [showAdvanced, setShowAdvanced] = useState(!!initialServer || !server);

    const roomValid = /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(room.trim());
    const canJoin = projectReady && roomValid && name.trim().length > 0 && /^wss?:\/\//.test(server.trim());

    const handleSubmit = e => {
        e.preventDefault();
        if (canJoin) {
            onJoin({
                name: name.trim(),
                room: room.trim().toLowerCase(),
                serverUrl: server.trim()
            });
        }
    };

    return (
        <form
            className={styles.form}
            onSubmit={handleSubmit}
        >
            <p className={styles.intro}>
                {'Build one project together, live. Everyone in the same room sees each other\'s '}
                {'block, sprite, costume and sound changes as they happen.'}
            </p>
            {error && <div className={styles.error}>{error}</div>}
            <label className={styles.field}>
                <span className={styles.label}>{'Your name'}</span>
                <input
                    className={styles.input}
                    maxLength={24}
                    value={name}
                    placeholder="e.g. Alex"
                    autoFocus={!name}
                    onChange={e => setName(e.target.value)}
                />
            </label>
            <label className={styles.field}>
                <span className={styles.label}>{'Room code'}</span>
                <div className={styles.row}>
                    <input
                        className={styles.input}
                        maxLength={40}
                        value={room}
                        spellCheck={false}
                        onChange={e => setRoom(e.target.value.replace(/\s/g, '-'))}
                    />
                    <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => setRoom(makeRoomCode())}
                    >
                        {'New code'}
                    </button>
                </div>
                {!roomValid && (
                    <span className={styles.hint}>{'Use letters, numbers, - and _ (max 40).'}</span>
                )}
            </label>
            <div className={styles.notice}>
                <strong>{'New room?'}</strong>
                {' Your current project becomes the shared project. '}
                <strong>{'Existing room?'}</strong>
                {' Your editor switches to the room\'s project, so save your work first.'}
            </div>
            <button
                type="button"
                className={styles.linkButton}
                onClick={() => setShowAdvanced(!showAdvanced)}
            >
                {showAdvanced ? '▾ Server' : '▸ Server'}
            </button>
            {showAdvanced && (
                <label className={styles.field}>
                    <span className={styles.label}>{'Collaboration server'}</span>
                    <input
                        className={styles.input}
                        value={server}
                        placeholder="wss://your-collab-server.example.com"
                        spellCheck={false}
                        onChange={e => setServer(e.target.value)}
                    />
                    <span className={styles.hint}>
                        {'Start it with "npm start" in the collab-server folder. '}
                        {'Everyone in a room must use the same server.'}
                    </span>
                    {location.protocol === 'https:' && /^ws:/.test(server.trim()) &&
                        !/^ws:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server.trim()) && (
                        <span className={styles.hint}>
                            {'This page uses https, so browsers only allow secure wss:// servers ' +
                                '(or ws://localhost for testing on your own computer).'}
                        </span>
                    )}
                </label>
            )}
            <div className={styles.footer}>
                <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={!canJoin}
                >
                    {projectReady ? 'Join room' : 'Loading editor…'}
                </button>
            </div>
        </form>
    );
};
JoinForm.propTypes = {
    error: PropTypes.string,
    projectReady: PropTypes.bool,
    initialRoom: PropTypes.string,
    initialServer: PropTypes.string,
    onJoin: PropTypes.func.isRequired
};

const Chat = ({chat, onSend}) => {
    const [text, setText] = useState('');
    const listRef = useRef(null);
    useEffect(() => {
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }, [chat.length]);
    const handleSubmit = e => {
        e.preventDefault();
        if (text.trim()) {
            onSend(text.trim());
            setText('');
        }
    };
    return (
        <div className={styles.chat}>
            <div
                className={styles.chatList}
                ref={listRef}
            >
                {chat.length === 0 && (
                    <div className={styles.chatEmpty}>{'No messages yet. Say hi!'}</div>
                )}
                {chat.map(message => (
                    message.system ? (
                        <div
                            key={message.key}
                            className={styles.chatSystem}
                        >
                            {message.text}
                        </div>
                    ) : (
                        <div
                            key={message.key}
                            className={styles.chatMessage}
                        >
                            <span
                                className={styles.chatName}
                                style={{color: message.color}}
                            >
                                {message.mine ? 'You' : message.name}
                            </span>
                            <span className={styles.chatText}>{message.text}</span>
                        </div>
                    )
                ))}
            </div>
            <form
                className={styles.row}
                onSubmit={handleSubmit}
            >
                <input
                    className={styles.input}
                    value={text}
                    maxLength={500}
                    placeholder="Message your team…"
                    onChange={e => setText(e.target.value)}
                />
                <button
                    type="submit"
                    className={styles.secondaryButton}
                    disabled={!text.trim()}
                >
                    {'Send'}
                </button>
            </form>
        </div>
    );
};
Chat.propTypes = {
    chat: PropTypes.arrayOf(PropTypes.object).isRequired,
    onSend: PropTypes.func.isRequired
};

const RoomView = ({state, onLeave, onResync, onSendChat}) => {
    const [copied, setCopied] = useState(false);
    const invite = makeInviteLink(state.room, state.serverUrl);
    const handleCopy = () => {
        const done = () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        };
        if (navigator.clipboard) {
            // eslint-disable-next-line no-alert
            navigator.clipboard.writeText(invite).then(done, () => window.prompt('Copy this link:', invite));
        } else {
            // eslint-disable-next-line no-alert
            window.prompt('Copy this link:', invite);
        }
    };
    const everyone = [Object.assign({mine: true}, state.me)].concat(state.peers);
    return (
        <div className={styles.room}>
            {state.status === 'reconnecting' && (
                <div className={styles.error}>{'Connection lost. Reconnecting…'}</div>
            )}
            <div className={styles.roomHeader}>
                <div>
                    <div className={styles.label}>{'Room'}</div>
                    <div className={styles.roomCode}>{state.room}</div>
                </div>
                <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={handleCopy}
                >
                    {copied ? 'Copied!' : 'Copy invite link'}
                </button>
            </div>
            {isLocalHostname(location.hostname) && (
                <p className={styles.hint}>
                    {'Tip: friends on other computers can\'t open "localhost". Open this editor with your '}
                    {'computer\'s network address (like http://192.168.1.20:8601) before copying the link.'}
                </p>
            )}
            <div className={styles.label}>{`People here (${everyone.length})`}</div>
            <ul className={styles.people}>
                {everyone.map(person => (
                    <li
                        key={person.id || 'me'}
                        className={styles.person}
                    >
                        <Avatar
                            name={person.name}
                            color={person.color}
                        />
                        <span className={styles.personName}>
                            {person.name}
                            {person.mine && <span className={styles.youTag}>{'you'}</span>}
                        </span>
                        <span className={styles.personWhere}>
                            {person.presence && person.presence.target ?
                                `editing ${person.presence.target}` :
                                ''}
                        </span>
                    </li>
                ))}
            </ul>
            <div className={styles.label}>{'Chat'}</div>
            <Chat
                chat={state.chat}
                onSend={onSendChat}
            />
            <div className={styles.footer}>
                <button
                    type="button"
                    className={styles.secondaryButton}
                    title="Reload the shared project from the room if something looks out of sync"
                    onClick={onResync}
                >
                    {'Resync project'}
                </button>
                <button
                    type="button"
                    className={styles.dangerButton}
                    onClick={onLeave}
                >
                    {'Leave room'}
                </button>
            </div>
        </div>
    );
};
RoomView.propTypes = {
    onLeave: PropTypes.func.isRequired,
    onResync: PropTypes.func.isRequired,
    onSendChat: PropTypes.func.isRequired,
    state: PropTypes.object.isRequired
};

const CollabModal = props => {
    const state = useCollabState();
    useEffect(() => {
        props.onChatRead();
    }, [state.chat.length]);

    let body;
    if (state.status === 'connecting' || state.status === 'syncing') {
        body = (
            <div className={styles.progress}>
                <div className={styles.spinner} />
                {state.status === 'connecting' ? 'Connecting to the server…' : 'Loading the room\'s project…'}
            </div>
        );
    } else if (state.status === 'connected' || state.status === 'reconnecting') {
        body = (
            <RoomView
                state={state}
                onLeave={props.onLeave}
                onResync={props.onResync}
                onSendChat={props.onSendChat}
            />
        );
    } else {
        body = (
            <JoinForm
                error={state.error}
                initialRoom={props.initialRoom}
                initialServer={props.initialServer}
                projectReady={props.projectReady !== false}
                onJoin={props.onJoin}
            />
        );
    }

    return (
        <Modal
            className={styles.modalContent}
            contentLabel="Collaborate"
            id="tscCollabModal"
            onRequestClose={props.onClose}
        >
            <div className={styles.body}>
                {body}
            </div>
        </Modal>
    );
};

CollabModal.propTypes = {
    initialRoom: PropTypes.string,
    initialServer: PropTypes.string,
    onChatRead: PropTypes.func.isRequired,
    onClose: PropTypes.func.isRequired,
    onJoin: PropTypes.func.isRequired,
    onLeave: PropTypes.func.isRequired,
    onResync: PropTypes.func.isRequired,
    onSendChat: PropTypes.func.isRequired,
    projectReady: PropTypes.bool
};

export {Avatar};
export default CollabModal;
