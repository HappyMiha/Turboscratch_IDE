/* eslint-disable react/jsx-no-bind */
import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';
import CollabModalComponent from '../components/tsc-collab/collab-modal.jsx';
import {closeCollabModal} from '../reducers/modals';
import {getIsShowingProject} from '../reducers/project-state';
import {getCollabSession} from '../lib/tsc-collab/session';
import {readInviteFromUrl} from '../lib/tsc-collab/settings';

const session = getCollabSession();

const TSCCollabModal = props => {
    const invite = readInviteFromUrl();
    return (
        <CollabModalComponent
            initialRoom={invite ? invite.room : null}
            initialServer={invite ? invite.serverUrl : null}
            projectReady={props.projectReady}
            onClose={props.onClose}
            onJoin={params => session.join(params)}
            onLeave={() => {
                session.leave();
                props.onClose();
            }}
            onResync={() => session.resync()}
            onSendChat={text => session.sendChat(text)}
            onChatRead={() => session.markChatRead()}
        />
    );
};

TSCCollabModal.propTypes = {
    onClose: PropTypes.func.isRequired,
    projectReady: PropTypes.bool
};

const mapStateToProps = state => ({
    // Joining before the editor finished loading its first project would let
    // that project overwrite the room's project.
    projectReady: getIsShowingProject(state.scratchGui.projectState.loadingState)
});

const mapDispatchToProps = dispatch => ({
    onClose: () => dispatch(closeCollabModal())
});

export default connect(
    mapStateToProps,
    mapDispatchToProps
)(TSCCollabModal);
