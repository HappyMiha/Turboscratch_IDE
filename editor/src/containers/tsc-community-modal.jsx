import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';
import CommunityModalComponent from '../components/tsc-community/community-modal.jsx';
import {closeCommunityModal} from '../reducers/modals';
import {setProjectTitle} from '../reducers/project-title';

const TSCCommunityModal = props => (
    <CommunityModalComponent
        vm={props.vm}
        projectTitle={props.projectTitle}
        onClose={props.onClose}
        onSetProjectTitle={props.onSetProjectTitle}
    />
);

TSCCommunityModal.propTypes = {
    onClose: PropTypes.func.isRequired,
    onSetProjectTitle: PropTypes.func.isRequired,
    projectTitle: PropTypes.string,
    vm: PropTypes.object.isRequired
};

const mapStateToProps = state => ({
    projectTitle: state.scratchGui.projectTitle,
    vm: state.scratchGui.vm
});

const mapDispatchToProps = dispatch => ({
    onClose: () => dispatch(closeCommunityModal()),
    onSetProjectTitle: title => dispatch(setProjectTitle(title))
});

export default connect(
    mapStateToProps,
    mapDispatchToProps
)(TSCCommunityModal);
