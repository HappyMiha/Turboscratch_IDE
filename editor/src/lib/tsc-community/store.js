/* eslint-disable valid-jsdoc */
/**
 * Signed-in account state, shared by the menu bar and the Community dialog.
 */
import {useEffect, useState} from 'react';
import {api, getToken, setToken} from './api';

let state = {
    /** @type {null|{nickname: string, createdAt: number}} */
    user: null,
    checking: false,
    /** Which page the Community dialog opens on. */
    view: 'explore',
    /** The posted project currently open in the editor, if it's yours: {id, title, description} */
    openProject: null
};
const listeners = new Set();

const getAccountState = () => state;

const setAccountState = patch => {
    state = Object.assign({}, state, patch);
    for (const listener of listeners) listener(state);
};

const useAccount = () => {
    const [current, setCurrent] = useState(state);
    useEffect(() => {
        listeners.add(setCurrent);
        return () => listeners.delete(setCurrent);
    }, []);
    return current;
};

const signedIn = (token, user) => {
    setToken(token);
    setAccountState({user});
};

const signOut = async () => {
    try {
        if (getToken()) await api.logout();
    } catch (e) {
        // signing out locally is what matters
    }
    setToken(null);
    setAccountState({user: null, openProject: null});
};

let checked = false;
/** On startup, check that a saved sign-in is still valid. */
const restoreSession = async () => {
    if (checked || !getToken()) return;
    checked = true;
    setAccountState({checking: true});
    try {
        const {user} = await api.me();
        setAccountState({user, checking: false});
    } catch (e) {
        if (e.status === 401) setToken(null);
        setAccountState({checking: false});
    }
};

export {
    getAccountState,
    setAccountState,
    useAccount,
    signedIn,
    signOut,
    restoreSession
};
