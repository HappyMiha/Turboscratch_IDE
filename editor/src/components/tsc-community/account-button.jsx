/* eslint-disable react/jsx-no-bind, valid-jsdoc */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useEffect} from 'react';
import {useAccount, setAccountState, restoreSession, attachVM} from '../../lib/tsc-community/store';
import {getApiBase} from '../../lib/tsc-community/api';
import styles from './account-button.css';

/** "Post" and "Sign in" / your nickname, on the right of the menu bar. */
const AccountButtons = ({itemClassName, onOpenCommunity, vm}) => {
    const account = useAccount();
    useEffect(() => {
        restoreSession();
        attachVM(vm);
    }, [vm]);
    if (!getApiBase()) return null;

    const open = view => {
        setAccountState({view});
        onOpenCommunity();
    };
    const me = account.user;

    return (
        <React.Fragment>
            <div
                className={classNames(itemClassName, styles.postButton)}
                title="Post this project so everyone can see it"
                onClick={() => open('post')}
            >
                {'Post'}
            </div>
            <div
                className={classNames(itemClassName, styles.accountButton)}
                title={me ? 'Your projects, friends and studios' : 'Sign in or create an account'}
                onClick={() => open(me ? 'explore' : 'signin')}
            >
                {me ? (
                    <React.Fragment>
                        <span className={styles.avatar}>
                            {me.nickname.charAt(0).toUpperCase()}
                        </span>
                        <span className={styles.name}>{me.nickname}</span>
                    </React.Fragment>
                ) : (
                    <span className={styles.label}>{account.checking ? '…' : 'Sign in'}</span>
                )}
            </div>
        </React.Fragment>
    );
};

AccountButtons.propTypes = {
    itemClassName: PropTypes.string,
    onOpenCommunity: PropTypes.func.isRequired,
    vm: PropTypes.object
};

export default AccountButtons;
