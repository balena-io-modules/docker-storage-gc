import Docker from 'dockerode';
import _ from 'lodash';

const getDockerConnectOpts = function (hostObj: Docker.DockerOptions) {
	if (!_.isEmpty(hostObj)) {
		return hostObj;
	}
	return {
		socketPath: '/var/run/docker.sock',
	};
};

export function getDocker(hostObj: Docker.DockerOptions) {
	const opts = getDockerConnectOpts(hostObj);
	return new Docker(opts);
}
