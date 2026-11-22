/* eslint-disable react/jsx-no-bind, react/prop-types, no-alert, valid-jsdoc */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useCallback, useEffect, useState} from 'react';
import Modal from '../../containers/modal.jsx';
import {api, getApiBase} from '../../lib/tsc-community/api';
import {useAccount, signedIn, signOut, setAccountState} from '../../lib/tsc-community/store';
import styles from './community-modal.css';

const timeAgo = ms => {
    const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} d ago`;
    return new Date(ms).toLocaleDateString();
};

/** Loads data with a function; returns {data, error, loading, reload}. */
const useLoad = (load, deps) => {
    const [result, setResult] = useState({data: null, error: null, loading: true});
    const reload = useCallback(() => {
        let cancelled = false;
        setResult(r => Object.assign({}, r, {loading: true, error: null}));
        load().then(
            data => !cancelled && setResult({data, error: null, loading: false}),
            error => !cancelled && setResult({data: null, error: error.message, loading: false})
        );
        return () => {
            cancelled = true;
        };
    }, deps);
    useEffect(reload, [reload]);
    return Object.assign({reload}, result);
};

/** Runs an action, showing its error; returns a function to call. */
const useAction = () => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const run = async (fn, onDone) => {
        setBusy(true);
        setError(null);
        try {
            const result = await fn();
            if (onDone) onDone(result);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    return {busy, error, run, setError};
};

const Avatar = ({name}) => {
    // Same name, same colour, on every computer
    let hash = 0;
    for (const ch of String(name)) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
    const colors = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf', '#f06595'];
    return (
        <span
            className={styles.avatar}
            style={{background: colors[hash % colors.length]}}
        >
            {String(name).charAt(0)
                .toUpperCase()}
        </span>
    );
};

const ErrorBox = ({error}) => (error ? <div className={styles.error}>{error}</div> : null);

const Loading = () => <div className={styles.empty}>{'Loading…'}</div>;

const ProjectCard = ({project, children, onAuthor}) => (
    <li className={styles.card}>
        <div className={styles.cardMain}>
            <div className={styles.cardTitle}>{project.title}</div>
            <div className={styles.cardMeta}>
                {'by '}
                {onAuthor ? (
                    <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => onAuthor(project.author)}
                    >
                        {project.author}
                    </button>
                ) : project.author}
                {` · ${timeAgo(project.updatedAt)}`}
                {project.addedBy && project.addedBy !== project.author ? ` · added by ${project.addedBy}` : ''}
            </div>
            {project.description && <div className={styles.cardDescription}>{project.description}</div>}
        </div>
        <div className={styles.cardActions}>{children}</div>
    </li>
);

// ---- pages ------------------------------------------------------------------

const SignIn = ({startMode, onModeChange}) => {
    const [mode, setMode] = useState(startMode || 'signin');
    const [nickname, setNickname] = useState('');
    const [password, setPassword] = useState('');
    const [password2, setPassword2] = useState('');
    const {busy, error, run, setError} = useAction();
    const creating = mode === 'signup';

    const submit = e => {
        e.preventDefault();
        if (creating && password !== password2) {
            setError('The two passwords are different');
            return;
        }
        run(
            () => (creating ? api.signup(nickname.trim(), password) : api.login(nickname.trim(), password)),
            result => signedIn(result.token, result.user)
        );
    };

    return (
        <form
            className={styles.form}
            onSubmit={submit}
        >
            <h2 className={styles.heading}>{creating ? 'Create your TurboScratch account' : 'Sign in'}</h2>
            <p className={styles.muted}>
                {'With an account you can post projects, add friends and make studios.'}
            </p>
            <ErrorBox error={error} />
            <label className={styles.field}>
                <span className={styles.label}>{'Nickname'}</span>
                <input
                    className={styles.input}
                    value={nickname}
                    maxLength={20}
                    autoComplete="username"
                    autoFocus
                    placeholder="3-20 letters, numbers, - or _"
                    onChange={e => setNickname(e.target.value.replace(/\s/g, ''))}
                />
            </label>
            <label className={styles.field}>
                <span className={styles.label}>{'Password'}</span>
                <input
                    className={styles.input}
                    type="password"
                    value={password}
                    autoComplete={creating ? 'new-password' : 'current-password'}
                    placeholder={creating ? 'At least 6 characters' : ''}
                    onChange={e => setPassword(e.target.value)}
                />
            </label>
            {creating && (
                <label className={styles.field}>
                    <span className={styles.label}>{'Password again'}</span>
                    <input
                        className={styles.input}
                        type="password"
                        value={password2}
                        autoComplete="new-password"
                        onChange={e => setPassword2(e.target.value)}
                    />
                </label>
            )}
            {creating && (
                <p className={styles.hint}>
                    {'Pick a nickname that isn\'t your real name, and a password you don\'t use anywhere else. '}
                    {'Your password is stored scrambled, so nobody can read it.'}
                </p>
            )}
            <div className={styles.row}>
                <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={busy || !nickname || !password}
                >
                    {busy ? 'One moment…' : (creating ? 'Create account' : 'Sign in')}
                </button>
                <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => {
                        const next = creating ? 'signin' : 'signup';
                        setMode(next);
                        setError(null);
                        if (onModeChange) onModeChange(next);
                    }}
                >
                    {creating ? 'I already have an account' : 'Create an account'}
                </button>
            </div>
        </form>
    );
};

const Explore = ({onOpen, onAuthor}) => {
    const [extra, setExtra] = useState([]);
    const [more, setMore] = useState(true);
    const first = useLoad(() => api.projects(0), []);
    const projects = first.data ? first.data.projects.concat(extra) : [];
    const loadMore = () => api.projects(projects.length).then(({projects: next}) => {
        setExtra(extra.concat(next));
        if (next.length === 0) setMore(false);
    });
    return (
        <div>
            <h2 className={styles.heading}>{'Explore'}</h2>
            <ErrorBox error={first.error} />
            {first.loading && !first.data && <Loading />}
            {first.data && projects.length === 0 && (
                <div className={styles.empty}>{'Nobody has posted a project yet. Be the first!'}</div>
            )}
            <ul className={styles.list}>
                {projects.map(project => (
                    <ProjectCard
                        key={project.id}
                        project={project}
                        onAuthor={onAuthor}
                    >
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => onOpen(project)}
                        >
                            {'Open'}
                        </button>
                    </ProjectCard>
                ))}
            </ul>
            {first.data && projects.length >= 40 && more && (
                <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={loadMore}
                >
                    {'Load more'}
                </button>
            )}
        </div>
    );
};

const MyProjects = ({me, onOpen}) => {
    const mine = useLoad(() => api.user(me.nickname), [me.nickname]);
    const {error, run} = useAction();
    const remove = project => {
        if (!window.confirm(`Delete "${project.title}" from TurboScratch? This can't be undone.`)) return;
        run(() => api.deleteProject(project.id), mine.reload);
    };
    return (
        <div>
            <h2 className={styles.heading}>{'My projects'}</h2>
            <ErrorBox error={mine.error || error} />
            {mine.loading && !mine.data && <Loading />}
            {mine.data && mine.data.projects.length === 0 && (
                <div className={styles.empty}>
                    {'You haven\'t posted anything yet. Use "Post" to share this project.'}
                </div>
            )}
            <ul className={styles.list}>
                {(mine.data ? mine.data.projects : []).map(project => (
                    <ProjectCard
                        key={project.id}
                        project={project}
                    >
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => onOpen(project)}
                        >
                            {'Open'}
                        </button>
                        <button
                            type="button"
                            className={styles.dangerButton}
                            onClick={() => remove(project)}
                        >
                            {'Delete'}
                        </button>
                    </ProjectCard>
                ))}
            </ul>
        </div>
    );
};

const Post = ({vm, projectTitle, openProject, onPosted}) => {
    const [title, setTitle] = useState(
        (openProject && openProject.title) || (projectTitle && projectTitle !== 'Project' ? projectTitle : '')
    );
    const [description, setDescription] = useState((openProject && openProject.description) || '');
    const [done, setDone] = useState(null);
    const {busy, error, run} = useAction();

    const send = asNew => run(async () => {
        const sb3 = await vm.saveProjectSb3('arraybuffer');
        const result = (openProject && !asNew) ?
            await api.updateProject(openProject.id, title.trim(), description, sb3) :
            await api.postProject(title.trim(), description, sb3);
        return result.project;
    }, project => {
        setAccountState({openProject: {id: project.id, title: project.title, description: project.description}});
        setDone(openProject && !asNew ?
            'Saved! Everyone now sees your latest version.' :
            'Posted! Find it in Explore.');
        onPosted(project);
    });

    return (
        <div className={styles.form}>
            <h2 className={styles.heading}>{'Post this project'}</h2>
            <p className={styles.muted}>{'Posted projects can be seen and opened by everyone on this server.'}</p>
            <ErrorBox error={error} />
            {done && <div className={styles.success}>{done}</div>}
            <label className={styles.field}>
                <span className={styles.label}>{'Title'}</span>
                <input
                    className={styles.input}
                    value={title}
                    maxLength={100}
                    placeholder="My awesome game"
                    onChange={e => setTitle(e.target.value)}
                />
            </label>
            <label className={styles.field}>
                <span className={styles.label}>{'Description (optional)'}</span>
                <textarea
                    className={classNames(styles.input, styles.textarea)}
                    value={description}
                    maxLength={2000}
                    placeholder="How do you play? What did you make?"
                    onChange={e => setDescription(e.target.value)}
                />
            </label>
            <div className={styles.row}>
                {openProject ? (
                    <React.Fragment>
                        <button
                            type="button"
                            className={styles.primaryButton}
                            disabled={busy || !title.trim()}
                            onClick={() => send(false)}
                        >
                            {busy ? 'Uploading…' : `Save changes to "${openProject.title}"`}
                        </button>
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            disabled={busy || !title.trim()}
                            onClick={() => send(true)}
                        >
                            {'Post as a new project'}
                        </button>
                    </React.Fragment>
                ) : (
                    <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={busy || !title.trim()}
                        onClick={() => send(true)}
                    >
                        {busy ? 'Uploading…' : 'Post'}
                    </button>
                )}
            </div>
        </div>
    );
};

const Friends = ({onProfile}) => {
    const friends = useLoad(() => api.friends(), []);
    const [nickname, setNickname] = useState('');
    const [notice, setNotice] = useState(null);
    const {busy, error, run} = useAction();
    const data = friends.data || {friends: [], incoming: [], outgoing: []};

    const add = e => {
        e.preventDefault();
        run(() => api.addFriend(nickname.trim()), result => {
            setNotice(result.status === 'friends' ?
                `You and ${nickname.trim()} are now friends!` :
                `Friend request sent to ${nickname.trim()}.`);
            setNickname('');
            friends.reload();
        });
    };

    return (
        <div>
            <h2 className={styles.heading}>{'Friends'}</h2>
            <form
                className={styles.row}
                onSubmit={add}
            >
                <input
                    className={styles.input}
                    value={nickname}
                    maxLength={20}
                    placeholder="Friend's nickname"
                    onChange={e => setNickname(e.target.value.replace(/\s/g, ''))}
                />
                <button
                    type="submit"
                    className={styles.primaryButton}
                    disabled={busy || nickname.trim().length < 3}
                >
                    {'Add friend'}
                </button>
            </form>
            <ErrorBox error={friends.error || error} />
            {notice && <div className={styles.success}>{notice}</div>}

            {data.incoming.length > 0 && (
                <React.Fragment>
                    <div className={styles.label}>{'Friend requests'}</div>
                    <ul className={styles.list}>
                        {data.incoming.map(r => (
                            <li
                                key={r.id}
                                className={styles.person}
                            >
                                <Avatar name={r.nickname} />
                                <span className={styles.personName}>{r.nickname}</span>
                                <span className={styles.spacer} />
                                <button
                                    type="button"
                                    className={styles.primaryButton}
                                    onClick={() => run(() => api.acceptFriend(r.id), friends.reload)}
                                >
                                    {'Accept'}
                                </button>
                                <button
                                    type="button"
                                    className={styles.secondaryButton}
                                    onClick={() => run(() => api.declineFriend(r.id), friends.reload)}
                                >
                                    {'Decline'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </React.Fragment>
            )}

            <div className={styles.label}>{`Your friends (${data.friends.length})`}</div>
            {friends.loading && !friends.data && <Loading />}
            {friends.data && data.friends.length === 0 && (
                <div className={styles.empty}>{'No friends yet. Add someone by their nickname!'}</div>
            )}
            <ul className={styles.list}>
                {data.friends.map(f => (
                    <li
                        key={f.nickname}
                        className={styles.person}
                    >
                        <Avatar name={f.nickname} />
                        <button
                            type="button"
                            className={classNames(styles.linkButton, styles.personName)}
                            onClick={() => onProfile(f.nickname)}
                        >
                            {f.nickname}
                        </button>
                        <span className={styles.spacer} />
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => {
                                if (window.confirm(`Remove ${f.nickname} from your friends?`)) {
                                    run(() => api.removeFriend(f.nickname), friends.reload);
                                }
                            }}
                        >
                            {'Remove'}
                        </button>
                    </li>
                ))}
            </ul>

            {data.outgoing.length > 0 && (
                <React.Fragment>
                    <div className={styles.label}>{'Waiting for an answer'}</div>
                    <ul className={styles.list}>
                        {data.outgoing.map(r => (
                            <li
                                key={r.id}
                                className={styles.person}
                            >
                                <Avatar name={r.nickname} />
                                <span className={styles.personName}>{r.nickname}</span>
                                <span className={styles.spacer} />
                                <button
                                    type="button"
                                    className={styles.secondaryButton}
                                    onClick={() => run(() => api.declineFriend(r.id), friends.reload)}
                                >
                                    {'Cancel'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </React.Fragment>
            )}
        </div>
    );
};

const Studios = ({onOpenStudio}) => {
    const studios = useLoad(() => api.studios(), []);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const {busy, error, run} = useAction();
    const data = studios.data || {studios: [], invites: []};

    const create = e => {
        e.preventDefault();
        run(() => api.createStudio(title.trim(), description), result => onOpenStudio(result.studio.id));
    };

    return (
        <div>
            <h2 className={styles.heading}>{'Studios'}</h2>
            <p className={styles.muted}>
                {'A studio is a shared collection of projects. Invite people to add theirs!'}
            </p>
            <ErrorBox error={studios.error || error} />

            {data.invites.length > 0 && (
                <React.Fragment>
                    <div className={styles.label}>{'Invitations'}</div>
                    <ul className={styles.list}>
                        {data.invites.map(invite => (
                            <li
                                key={invite.id}
                                className={styles.person}
                            >
                                <span className={styles.personName}>
                                    {`${invite.from} invited you to "${invite.studio.title}"`}
                                </span>
                                <span className={styles.spacer} />
                                <button
                                    type="button"
                                    className={styles.primaryButton}
                                    onClick={() => run(
                                        () => api.acceptStudioInvite(invite.id),
                                        () => onOpenStudio(invite.studio.id)
                                    )}
                                >
                                    {'Join'}
                                </button>
                                <button
                                    type="button"
                                    className={styles.secondaryButton}
                                    onClick={() => run(() => api.declineStudioInvite(invite.id), studios.reload)}
                                >
                                    {'No thanks'}
                                </button>
                            </li>
                        ))}
                    </ul>
                </React.Fragment>
            )}

            <div className={styles.label}>{'Your studios'}</div>
            {studios.loading && !studios.data && <Loading />}
            {studios.data && data.studios.length === 0 && (
                <div className={styles.empty}>{'You\'re not in any studios yet. Make one below!'}</div>
            )}
            <ul className={styles.list}>
                {data.studios.map(studio => (
                    <li
                        key={studio.id}
                        className={styles.person}
                    >
                        <span className={styles.studioIcon}>{'🗂'}</span>
                        <button
                            type="button"
                            className={classNames(styles.linkButton, styles.personName)}
                            onClick={() => onOpenStudio(studio.id)}
                        >
                            {studio.title}
                        </button>
                        <span className={styles.muted}>
                            {studio.role === 'owner' ? 'owner' : `by ${studio.owner}`}
                        </span>
                    </li>
                ))}
            </ul>

            <form
                className={styles.form}
                onSubmit={create}
            >
                <div className={styles.label}>{'Make a new studio'}</div>
                <input
                    className={styles.input}
                    value={title}
                    maxLength={60}
                    placeholder="Studio name"
                    onChange={e => setTitle(e.target.value)}
                />
                <input
                    className={styles.input}
                    value={description}
                    maxLength={2000}
                    placeholder="What is it about? (optional)"
                    onChange={e => setDescription(e.target.value)}
                />
                <div className={styles.row}>
                    <button
                        type="submit"
                        className={styles.primaryButton}
                        disabled={busy || !title.trim()}
                    >
                        {'Create studio'}
                    </button>
                </div>
            </form>
        </div>
    );
};

const Studio = ({id, me, onOpen, onBack, onProfile}) => {
    const studio = useLoad(() => api.studio(id), [id]);
    const friends = useLoad(() => api.friends(), []);
    const mine = useLoad(() => api.user(me.nickname), [me.nickname]);
    const [invitee, setInvitee] = useState('');
    const [pick, setPick] = useState('');
    const [notice, setNotice] = useState(null);
    const {busy, error, run} = useAction();

    if (!studio.data) {
        return (
            <div>
                <button
                    type="button"
                    className={styles.linkButton}
                    onClick={onBack}
                >
                    {'← Studios'}
                </button>
                <ErrorBox error={studio.error} />
                {studio.loading && <Loading />}
            </div>
        );
    }
    const {studio: info, members, projects} = studio.data;
    const isOwner = info.owner === me.nickname;
    const isMember = members.some(m => m.nickname === me.nickname);
    const friendNames = friends.data ? friends.data.friends.map(f => f.nickname) : [];
    const myProjects = mine.data ? mine.data.projects.filter(p => !projects.some(q => q.id === p.id)) : [];

    return (
        <div>
            <button
                type="button"
                className={styles.linkButton}
                onClick={onBack}
            >
                {'← Studios'}
            </button>
            <h2 className={styles.heading}>{info.title}</h2>
            <p className={styles.muted}>{`Made by ${info.owner}${info.description ? ` · ${info.description}` : ''}`}</p>
            <ErrorBox error={error} />
            {notice && <div className={styles.success}>{notice}</div>}

            <div className={styles.label}>{`Projects (${projects.length})`}</div>
            {projects.length === 0 && <div className={styles.empty}>{'No projects here yet.'}</div>}
            <ul className={styles.list}>
                {projects.map(project => (
                    <ProjectCard
                        key={project.id}
                        project={project}
                        onAuthor={onProfile}
                    >
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => onOpen(project)}
                        >
                            {'Open'}
                        </button>
                        {(isOwner || project.addedBy === me.nickname) && (
                            <button
                                type="button"
                                className={styles.secondaryButton}
                                onClick={() => run(() => api.removeFromStudio(info.id, project.id), studio.reload)}
                            >
                                {'Remove'}
                            </button>
                        )}
                    </ProjectCard>
                ))}
            </ul>
            {isMember && (
                <div className={styles.row}>
                    <select
                        className={styles.input}
                        value={pick}
                        onChange={e => setPick(e.target.value)}
                    >
                        <option value="">
                            {(() => {
                                if (myProjects.length) return 'Add one of my projects…';
                                if (mine.data && mine.data.projects.length) return 'All your projects are already here';
                                return 'Post a project first to add it here';
                            })()}
                        </option>
                        {myProjects.map(p => (
                            <option
                                key={p.id}
                                value={p.id}
                            >
                                {p.title}
                            </option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={busy || !pick}
                        onClick={() => run(() => api.addToStudio(info.id, Number(pick)), () => {
                            setPick('');
                            studio.reload();
                        })}
                    >
                        {'Add'}
                    </button>
                </div>
            )}

            <div className={styles.label}>{`Members (${members.length})`}</div>
            <ul className={styles.list}>
                {members.map(m => (
                    <li
                        key={m.nickname}
                        className={styles.person}
                    >
                        <Avatar name={m.nickname} />
                        <button
                            type="button"
                            className={classNames(styles.linkButton, styles.personName)}
                            onClick={() => onProfile(m.nickname)}
                        >
                            {m.nickname}
                        </button>
                        {m.role === 'owner' && <span className={styles.tag}>{'owner'}</span>}
                        <span className={styles.spacer} />
                        {isOwner && m.role !== 'owner' && (
                            <button
                                type="button"
                                className={styles.secondaryButton}
                                onClick={() => run(() => api.removeStudioMember(info.id, m.nickname), studio.reload)}
                            >
                                {'Remove'}
                            </button>
                        )}
                    </li>
                ))}
            </ul>

            {isOwner && (
                <form
                    className={styles.row}
                    onSubmit={e => {
                        e.preventDefault();
                        run(() => api.inviteToStudio(info.id, invitee.trim()), () => {
                            setNotice(`Invited ${invitee.trim()}! They'll see it under Studios.`);
                            setInvitee('');
                        });
                    }}
                >
                    <input
                        className={styles.input}
                        value={invitee}
                        list="tsc-friend-names"
                        maxLength={20}
                        placeholder="Invite someone by nickname"
                        onChange={e => setInvitee(e.target.value.replace(/\s/g, ''))}
                    />
                    <datalist id="tsc-friend-names">
                        {friendNames.map(name => (
                            <option
                                key={name}
                                value={name}
                            />
                        ))}
                    </datalist>
                    <button
                        type="submit"
                        className={styles.primaryButton}
                        disabled={busy || invitee.trim().length < 3}
                    >
                        {'Invite'}
                    </button>
                </form>
            )}

            <div className={styles.footer}>
                {isMember && !isOwner && (
                    <button
                        type="button"
                        className={styles.secondaryButton}
                        onClick={() => {
                            if (window.confirm(`Leave "${info.title}"?`)) {
                                run(() => api.removeStudioMember(info.id, me.nickname), onBack);
                            }
                        }}
                    >
                        {'Leave studio'}
                    </button>
                )}
                {isOwner && (
                    <button
                        type="button"
                        className={styles.dangerButton}
                        onClick={() => {
                            if (window.confirm(`Delete the studio "${info.title}"? The projects stay posted.`)) {
                                run(() => api.deleteStudio(info.id), onBack);
                            }
                        }}
                    >
                        {'Delete studio'}
                    </button>
                )}
            </div>
        </div>
    );
};

const Profile = ({nickname, me, onOpen, onBack}) => {
    const profile = useLoad(() => api.user(nickname), [nickname]);
    const [notice, setNotice] = useState(null);
    const {error, run} = useAction();
    return (
        <div>
            <button
                type="button"
                className={styles.linkButton}
                onClick={onBack}
            >
                {'← Back'}
            </button>
            <div className={styles.profileHeader}>
                <Avatar name={nickname} />
                <h2 className={styles.heading}>{nickname}</h2>
                <span className={styles.spacer} />
                {me && me.nickname.toLowerCase() !== nickname.toLowerCase() && (
                    <button
                        type="button"
                        className={styles.primaryButton}
                        onClick={() => run(() => api.addFriend(nickname), result => setNotice(
                            result.status === 'friends' ? 'You\'re friends!' : 'Friend request sent!'
                        ))}
                    >
                        {'Add friend'}
                    </button>
                )}
            </div>
            <ErrorBox error={profile.error || error} />
            {notice && <div className={styles.success}>{notice}</div>}
            {profile.data && (
                <p className={styles.muted}>
                    {`Joined ${new Date(profile.data.user.createdAt).toLocaleDateString()} · ` +
                        `${profile.data.friendCount} friends`}
                </p>
            )}
            <ul className={styles.list}>
                {(profile.data ? profile.data.projects : []).map(project => (
                    <ProjectCard
                        key={project.id}
                        project={project}
                    >
                        <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => onOpen(project)}
                        >
                            {'Open'}
                        </button>
                    </ProjectCard>
                ))}
            </ul>
            {profile.data && profile.data.projects.length === 0 && (
                <div className={styles.empty}>{'No posted projects yet.'}</div>
            )}
        </div>
    );
};

// ---- the dialog ---------------------------------------------------------------

const NAV = [
    {id: 'explore', label: 'Explore'},
    {id: 'mine', label: 'My projects', account: true},
    {id: 'post', label: 'Post', account: true},
    {id: 'friends', label: 'Friends', account: true},
    {id: 'studios', label: 'Studios', account: true}
];

const CommunityModal = ({vm, projectTitle, onClose, onSetProjectTitle}) => {
    const account = useAccount();
    const [view, setView] = useState(account.view || 'explore');
    const [studioId, setStudioId] = useState(null);
    const [profile, setProfile] = useState(null);
    const [openError, setOpenError] = useState(null);
    const [opening, setOpening] = useState(false);
    const me = account.user;
    const serverReady = !!getApiBase();

    const openProject = async project => {
        if (!window.confirm(`Open "${project.title}"? Your current project will be replaced, ` +
            'so save it first if you want to keep it.')) return;
        setOpening(true);
        setOpenError(null);
        try {
            const data = await api.projectFile(project.id);
            vm.stopAll();
            await vm.loadProject(data);
            onSetProjectTitle(project.title);
            setAccountState({
                openProject: me && project.author === me.nickname ?
                    {id: project.id, title: project.title, description: project.description} :
                    null
            });
            onClose();
        } catch (e) {
            setOpenError(`Couldn't open that project: ${e.message || e}`);
        } finally {
            setOpening(false);
        }
    };

    const go = next => {
        setView(next);
        setProfile(null);
        setStudioId(null);
    };
    const showProfile = nickname => {
        setProfile(nickname);
    };

    const needsAccount = !me && (NAV.find(n => n.id === view) || {}).account;
    let body;
    if (!serverReady) {
        body = (
            <div className={styles.empty}>
                {'This editor isn\'t connected to a TurboScratch server, so accounts aren\'t available here yet. '}
                {'Set a server under Collaborate → Server.'}
            </div>
        );
    } else if (view === 'signin' || view === 'signup' || needsAccount) {
        body = (
            <SignIn
                key={view}
                startMode={view === 'signup' ? 'signup' : 'signin'}
                onModeChange={needsAccount ? null : go}
            />
        );
    } else if (profile) {
        body = (
            <Profile
                nickname={profile}
                me={me}
                onOpen={openProject}
                onBack={() => setProfile(null)}
            />
        );
    } else if (view === 'studios' && studioId) {
        body = (
            <Studio
                id={studioId}
                me={me}
                onOpen={openProject}
                onProfile={showProfile}
                onBack={() => setStudioId(null)}
            />
        );
    } else if (view === 'studios') {
        body = <Studios onOpenStudio={setStudioId} />;
    } else if (view === 'friends') {
        body = <Friends onProfile={showProfile} />;
    } else if (view === 'post') {
        body = (
            <Post
                vm={vm}
                projectTitle={projectTitle}
                openProject={account.openProject}
                onPosted={project => onSetProjectTitle(project.title)}
            />
        );
    } else if (view === 'mine') {
        body = (
            <MyProjects
                me={me}
                onOpen={openProject}
            />
        );
    } else {
        body = (
            <Explore
                onOpen={openProject}
                onAuthor={showProfile}
            />
        );
    }

    // After signing in from the sign-in page, go to Explore.
    useEffect(() => {
        if (me && (view === 'signin' || view === 'signup')) go('explore');
    }, [me]);

    return (
        <Modal
            className={styles.modalContent}
            contentLabel="TurboScratch Community"
            id="tscCommunityModal"
            onRequestClose={onClose}
        >
            <div className={styles.layout}>
                <nav className={styles.nav}>
                    {NAV.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            className={classNames(styles.navItem, {[styles.navActive]: view === item.id})}
                            onClick={() => go(item.id)}
                        >
                            {item.label}
                        </button>
                    ))}
                    <div className={styles.navSpacer} />
                    {me ? (
                        <div className={styles.account}>
                            <div className={styles.accountName}>
                                <Avatar name={me.nickname} />
                                <span>{me.nickname}</span>
                            </div>
                            <button
                                type="button"
                                className={styles.linkButton}
                                onClick={() => {
                                    signOut();
                                    go('explore');
                                }}
                            >
                                {'Sign out'}
                            </button>
                        </div>
                    ) : (
                        <div className={styles.account}>
                            <button
                                type="button"
                                className={classNames(styles.navItem, {[styles.navActive]: view === 'signin'})}
                                onClick={() => go('signin')}
                            >
                                {'Sign in'}
                            </button>
                            <button
                                type="button"
                                className={classNames(styles.navItem, {[styles.navActive]: view === 'signup'})}
                                onClick={() => go('signup')}
                            >
                                {'Create account'}
                            </button>
                        </div>
                    )}
                </nav>
                <div className={styles.body}>
                    {opening && <div className={styles.success}>{'Opening project…'}</div>}
                    <ErrorBox error={openError} />
                    {body}
                </div>
            </div>
        </Modal>
    );
};

CommunityModal.propTypes = {
    onClose: PropTypes.func.isRequired,
    onSetProjectTitle: PropTypes.func.isRequired,
    projectTitle: PropTypes.string,
    vm: PropTypes.object.isRequired
};

export default CommunityModal;
