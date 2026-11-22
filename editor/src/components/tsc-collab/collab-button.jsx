import classNames from 'classnames';
import PropTypes from 'prop-types';
import React from 'react';
import {useCollabState} from '../../lib/tsc-collab/store';
import {Avatar} from './collab-modal.jsx';
import collabIcon from './collab-icon.svg';
import styles from './collab-button.css';

const MAX_AVATARS = 4;

const CollabButton = ({className, labelClassName, onClick}) => {
    const state = useCollabState();
    const live = state.status === 'connected' || state.status === 'reconnecting';
    const busy = state.status === 'connecting' || state.status === 'syncing';
    const everyone = live ? [state.me].concat(state.peers) : [];
    const shown = everyone.slice(0, MAX_AVATARS);
    const extra = everyone.length - shown.length;

    return (
        <div
            className={classNames(className, styles.collabButton, {
                [styles.live]: live,
                [styles.reconnecting]: state.status === 'reconnecting'
            })}
            title={live ?
                `Room ${state.room} - click to see who's here and chat` :
                'Collaborate with friends in real time'}
            onClick={onClick}
        >
            {live ? (
                <span className={styles.avatars}>
                    {shown.map(person => (
                        <Avatar
                            key={person.id}
                            name={person.name}
                            color={person.color}
                            small
                        />
                    ))}
                    {extra > 0 && <span className={styles.more}>{`+${extra}`}</span>}
                </span>
            ) : (
                <img
                    src={collabIcon}
                    draggable={false}
                    width={20}
                    height={20}
                    className={busy ? styles.pulse : null}
                />
            )}
            <span className={labelClassName}>
                {live ? 'Live' : 'Collaborate'}
            </span>
            {state.unreadChat > 0 && (
                <span className={styles.badge}>{state.unreadChat > 9 ? '9+' : state.unreadChat}</span>
            )}
            {state.toasts.length > 0 && (
                <div className={styles.toasts}>
                    {state.toasts.map(toast => (
                        <div
                            key={toast.key}
                            className={styles.toast}
                            style={toast.color ? {borderLeftColor: toast.color} : null}
                        >
                            {toast.text}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

CollabButton.propTypes = {
    className: PropTypes.string,
    labelClassName: PropTypes.string,
    onClick: PropTypes.func.isRequired
};

export default CollabButton;
