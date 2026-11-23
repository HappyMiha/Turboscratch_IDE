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

/** Calls listener(state) whenever the account state changes; returns an unsubscribe function. */
const subscribeAccount = listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
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

// "Save changes" may only update the posted project that is actually open:
// any other project load (File > Load/New, a collaboration room...) forgets it.
let expectingCommunityLoad = false;
let attachedVm = null;
const attachVM = vm => {
    if (!vm || attachedVm === vm) return;
    attachedVm = vm;
    vm.runtime.on('PROJECT_LOADED', () => {
        if (expectingCommunityLoad) {
            expectingCommunityLoad = false;
        } else if (state.openProject) {
            setAccountState({openProject: null});
        }
    });
};
const markCommunityLoad = (expecting = true) => {
    expectingCommunityLoad = expecting;
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
    attachVM,
    markCommunityLoad,
    getAccountState,
    setAccountState,
    useAccount,
    signedIn,
    signOut,
    restoreSession,
    subscribeAccount
};
