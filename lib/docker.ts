import Docker from 'dockerode';
import Bluebird from 'bluebird';
import _ from 'lodash';

const getDockerConnectOpts = function (hostObj: Docker.DockerOptions) {
	if (!_.isEmpty(hostObj)) {
		return Promise.resolve(hostObj);
	}
	return Promise.resolve({
		socketPath: '/var/run/docker.sock',
		Promise: Bluebird as any as PromiseConstructor,
	});
};

export function getDocker(hostObj: Docker.DockerOptions) {
	return getDockerConnectOpts(hostObj).then((opts) => new Docker(opts));
}
