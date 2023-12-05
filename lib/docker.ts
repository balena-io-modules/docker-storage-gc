import Docker from 'dockerode';
import Bluebird from 'bluebird';
import _ from 'lodash';

const getDockerConnectOpts = function (hostObj: Docker.DockerOptions) {
	if (!_.isEmpty(hostObj)) {
		return hostObj;
	}
	return {
		socketPath: '/var/run/docker.sock',
		Promise: Bluebird as any as PromiseConstructor,
	};
};

export function getDocker(hostObj: Docker.DockerOptions) {
	const opts = getDockerConnectOpts(hostObj);
	return new Docker(opts);
}
