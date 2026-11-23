/* eslint-disable react/jsx-no-bind, valid-jsdoc */
import classNames from 'classnames';
import PropTypes from 'prop-types';
import React, {useEffect} from 'react';
import ReactDOM from 'react-dom';
import {setAdaState, useAda} from '../../lib/tsc-ai/agent';
import {attachConsole} from '../../lib/tsc-ai/console';
import AdaPanel from './ada-panel.jsx';
import adaIcon from './ada-icon.svg';
import styles from './ada-button.css';

/**
 * The "Ada" menu bar button. It opens Ada's panel (the AI helper chat and
 * the debugger console). The console starts recording as soon as the editor
 * opens, so it has something to show even before the panel is opened.
 */
const AdaButton = ({className, isFullScreen, labelClassName, vm, onOpenCommunity}) => {
    const ada = useAda();
    useEffect(() => {
        attachConsole(vm);
    }, [vm]);

    return (
        <React.Fragment>
            <div
                className={classNames(className, styles.adaButton, {[styles.open]: ada.open})}
                title="Ada, your AI coding helper, and the debugger console"
                onClick={() => setAdaState({open: !ada.open})}
            >
                <img
                    src={adaIcon}
                    draggable={false}
                    width={20}
                    height={20}
                    className={ada.busy ? styles.pulse : null}
                />
                <span className={labelClassName}>{'Ada'}</span>
            </div>
            {/* Hidden (not closed) while the stage is full screen. */}
            {ada.open && !isFullScreen && ReactDOM.createPortal(
                <AdaPanel
                    vm={vm}
                    onOpenCommunity={onOpenCommunity}
                />,
                document.body
            )}
        </React.Fragment>
    );
};

AdaButton.propTypes = {
    className: PropTypes.string,
    isFullScreen: PropTypes.bool,
    labelClassName: PropTypes.string,
    onOpenCommunity: PropTypes.func.isRequired,
    vm: PropTypes.object
};

export default AdaButton;
